// api/webhook.js
// Menerima snapshot akun dari AccountMonitor_WebhookEA.mq5 (POST) dan menulisnya
// ke Firestore. Dashboard (index.html) membaca langsung dari Firestore lewat
// Firebase client SDK secara realtime — endpoint ini hanya dipakai oleh EA
// untuk MENULIS data, plus sebuah GET ringan untuk health check.
//
// SETUP (lihat SETUP.md untuk detail lengkap):
// 1. Buat project Firebase -> aktifkan Firestore (mode production).
// 2. Buat Service Account (Project Settings > Service accounts > Generate key).
// 3. Di Vercel, set Environment Variables:
//      FIREBASE_SERVICE_ACCOUNT = <isi file JSON service account, sebagai 1 baris string>
//      EA_WEBHOOK_SECRET        = <token rahasia, harus sama dgn InpSecretToken di EA>
// 4. Deploy file ini sebagai /api/webhook.js
// 5. URL webhook yang dipakai EA: https://<project-anda>.vercel.app/api/webhook

const admin = require('firebase-admin');

const SHARED_TOKEN = process.env.EA_WEBHOOK_SECRET;
const EQUITY_POINT_INTERVAL_MS = 15 * 60 * 1000; // throttle equity curve: 1 titik / 15 menit
const BATCH_CHUNK = 450; // di bawah limit 500 operasi per batch Firestore

if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.error('FIREBASE_SERVICE_ACCOUNT env var belum diset.');
  } else {
    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }
}

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

function utcDateStr(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

async function commitInChunks(ops) {
  for (let i = 0; i < ops.length; i += BATCH_CHUNK) {
    const batch = db.batch();
    ops.slice(i, i + BATCH_CHUNK).forEach((op) => op(batch));
    await batch.commit();
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, service: 'faridfx-webhook', time: new Date().toISOString() });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  try {
    const body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');

    if (!SHARED_TOKEN || body.token !== SHARED_TOKEN) {
      return res.status(401).json({ ok: false, error: 'invalid token' });
    }

    const account = body.account || {};
    const accountId = String(account.login || '').trim();
    if (!accountId) {
      return res.status(400).json({ ok: false, error: 'missing account.login' });
    }

    const positions = Array.isArray(body.positions) ? body.positions : [];
    const pendingOrders = Array.isArray(body.pendingOrders) ? body.pendingOrders : [];
    const exposure = Array.isArray(body.exposure) ? body.exposure : [];
    const stats = body.stats || {};
    const history = Array.isArray(body.history) ? body.history : [];
    const reason = body.reason || 'unknown';
    const now = Date.now();
    const todayStr = utcDateStr(Math.floor(now / 1000));

    const accountRef = db.collection('accounts').doc(accountId);
    const accountSnap = await accountRef.get();
    const existing = accountSnap.exists ? accountSnap.data() : null;

    // --- Baseline utk daily / overall loss limit --------------------------
    const startingBalance = existing?.startingBalance
      ?? (account.startingBalanceOverride > 0 ? account.startingBalanceOverride : account.balance)
      ?? account.balance;

    let dayStartBalance = existing?.dayStartBalance ?? account.balance;
    let dayStartDate = existing?.dayStartDate ?? todayStr;
    if (dayStartDate !== todayStr) {
      // Hari baru (UTC) — baseline daily loss limit direset ke balance saat ini.
      // Catatan: ini adalah aproksimasi balance "awal hari" krn kita hanya
      // menerima snapshot, bukan tick-by-tick ledger.
      dayStartBalance = account.balance;
      dayStartDate = todayStr;
    }

    // --- Backfill / incremental history -> history subcollection + dailyPnl
    const lastHistorySync = existing?.lastHistorySync ?? 0;
    const newTrades = history.filter((t) => Number(t.closeTime) > lastHistorySync);

    let maxCloseTime = lastHistorySync;
    const dailyAgg = new Map(); // date -> {pnl,trades,wins,losses,volume}

    const historyOps = newTrades.map((t) => {
      const ct = Number(t.closeTime) || 0;
      if (ct > maxCloseTime) maxCloseTime = ct;
      const dateStr = utcDateStr(ct);
      const agg = dailyAgg.get(dateStr) || { pnl: 0, trades: 0, wins: 0, losses: 0, volume: 0 };
      const net = Number(t.netProfit) || 0;
      agg.pnl += net;
      agg.trades += 1;
      agg.volume += Number(t.volume) || 0;
      if (net > 0) agg.wins += 1;
      else if (net < 0) agg.losses += 1;
      dailyAgg.set(dateStr, agg);

      return (batch) => {
        const ref = accountRef.collection('history').doc(String(t.ticket));
        batch.set(ref, t, { merge: true });
      };
    });

    const dailyPnlOps = Array.from(dailyAgg.entries()).map(([dateStr, agg]) => {
      return (batch) => {
        const ref = accountRef.collection('dailyPnl').doc(dateStr);
        batch.set(
          ref,
          {
            date: dateStr,
            pnl: FieldValue.increment(agg.pnl),
            trades: FieldValue.increment(agg.trades),
            wins: FieldValue.increment(agg.wins),
            losses: FieldValue.increment(agg.losses),
            volume: FieldValue.increment(agg.volume),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      };
    });

    await commitInChunks([...historyOps, ...dailyPnlOps]);

    // --- Equity curve (throttled) ------------------------------------------
    const lastEquityPointAt = existing?.lastEquityPointAt ?? 0;
    let equityPointWritten = false;
    if (now - lastEquityPointAt >= EQUITY_POINT_INTERVAL_MS || !existing) {
      await accountRef.collection('equityCurve').add({
        ts: now,
        balance: account.balance,
        equity: account.equity,
        date: todayStr,
      });
      equityPointWritten = true;
    }

    // --- Update dokumen akun utama (latest snapshot) ------------------------
    await accountRef.set(
      {
        login: accountId,
        name: account.name || '',
        server: account.server || '',
        company: account.company || '',
        currency: account.currency || '',
        leverage: account.leverage || 0,
        accountLabel: account.accountLabel || existing?.accountLabel || `MT5 ${accountId}`,
        balance: account.balance,
        equity: account.equity,
        margin: account.margin,
        marginFree: account.marginFree,
        marginLevel: account.marginLevel,
        credit: account.credit,
        floatingProfit: account.floatingProfit,
        dailyLossLimitPct: account.dailyLossLimitPct ?? existing?.dailyLossLimitPct ?? 5,
        overallLossLimitPct: account.overallLossLimitPct ?? existing?.overallLossLimitPct ?? 10,
        riskPerPositionPct: account.riskPerPositionPct ?? existing?.riskPerPositionPct ?? 1,
        startingBalance,
        dayStartBalance,
        dayStartDate,
        lastHistorySync: maxCloseTime,
        lastEquityPointAt: equityPointWritten ? now : lastEquityPointAt,
        positions,
        pendingOrders,
        exposure,
        stats,
        lastReason: reason,
        receivedAt: new Date().toISOString(),
        updatedAt: FieldValue.serverTimestamp(),
        createdAt: existing?.createdAt ?? FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.status(200).json({ ok: true, newTrades: newTrades.length, equityPointWritten });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
};
