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
//      TELEGRAM_BOT_TOKEN       = <token dari @BotFather, opsional>
//      TELEGRAM_CHANNEL_ID      = <@username channel atau -100xxxxxxxxxx, opsional>
//      TELEGRAM_ADMIN_CHAT_ID   = <chat_id pribadi utk alert limit, opsional>
// 4. Deploy file ini sebagai /api/webhook.js
// 5. URL webhook yang dipakai EA: https://<project-anda>.vercel.app/api/webhook
// 6. Kalau 3 env var TELEGRAM_* di atas tidak diset, semua fitur Telegram otomatis
//    nonaktif (sendTelegram langsung return) — tidak akan error.

const admin = require('firebase-admin');

const SHARED_TOKEN = process.env.EA_WEBHOOK_SECRET;
const EQUITY_POINT_INTERVAL_MS = 15 * 60 * 1000; // throttle equity curve: 1 titik / 15 menit
const BATCH_CHUNK = 450; // di bawah limit 500 operasi per batch Firestore

// --- Telegram -------------------------------------------------------------
// TELEGRAM_CHANNEL_ID  -> broadcast publik (posisi open/close = "signal")
// TELEGRAM_ADMIN_CHAT_ID -> alert privat (daily/overall loss limit, margin)
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const TG_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;

async function sendTelegram(chatId, text) {
  if (!TG_TOKEN || !chatId) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
    });
    if (!r.ok) console.error('telegram sendMessage failed', await r.text());
  } catch (e) {
    console.error('telegram send error', e);
  }
}

function fmt(n, d = 2) {
  return Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function signalOpenText(label, p) {
  const dir = String(p.type).includes('buy') ? '🟢 BUY' : '🔴 SELL';
  return (
    `${dir} *${p.symbol}*\n` +
    `Lot: \`${fmt(p.volume, 2)}\`  Entry: \`${p.priceOpen}\`\n` +
    `SL: \`${p.sl || '-'}\`  TP: \`${p.tp || '-'}\`\n` +
    `Akun: ${label} · Ticket #${p.ticket}`
  );
}

function signalCloseText(label, t) {
  const win = Number(t.netProfit) >= 0;
  return (
    `${win ? '✅ CLOSED (Profit)' : '❌ CLOSED (Loss)'} *${t.symbol}*\n` +
    `${String(t.type).toUpperCase()} \`${fmt(t.volume, 2)}\` lot | ${t.openPrice} → ${t.closePrice}\n` +
    `Net P/L: *${win ? '+' : ''}$${fmt(t.netProfit)}*\n` +
    `Akun: ${label} · Ticket #${t.ticket}`
  );
}

function tierFor(usagePct) {
  if (usagePct >= 90) return 90;
  if (usagePct >= 70) return 70;
  return 0;
}

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

    const accountLabel = account.accountLabel || existing?.accountLabel || `MT5 ${accountId}`;

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

    // --- Telegram: forward new signals (open) & closed results ---------------
    // Hanya kirim kalau ini bukan snapshot pertama akun (hindari spam saat backfill
    // ribuan history/posisi lama pas EA pertama kali connect).
    if (existing) {
      const prevTickets = new Set((existing.positions || []).map((p) => String(p.ticket)));
      const newlyOpened = positions.filter((p) => !prevTickets.has(String(p.ticket)));
      for (const p of newlyOpened) {
        await sendTelegram(TG_CHANNEL_ID, signalOpenText(accountLabel, p));
      }
      for (const t of newTrades) {
        await sendTelegram(TG_CHANNEL_ID, signalCloseText(accountLabel, t));
      }
    }

    // --- Telegram: private alerts saat loss limit / margin kesenggol ---------
    const dailyLossLimitPct = account.dailyLossLimitPct ?? existing?.dailyLossLimitPct ?? 5;
    const overallLossLimitPct = account.overallLossLimitPct ?? existing?.overallLossLimitPct ?? 10;

    const todayDoc = await accountRef.collection('dailyPnl').doc(todayStr).get();
    const todayRealizedPnl = todayDoc.exists ? Number(todayDoc.data().pnl || 0) : 0;
    const todayTotalPnl = todayRealizedPnl + Number(account.floatingProfit || 0);
    const dailyLimitAmt = (dayStartBalance * dailyLossLimitPct) / 100;
    const dailyUsagePct = dailyLimitAmt > 0 ? (Math.max(0, -todayTotalPnl) / dailyLimitAmt) * 100 : 0;

    const overallPnl = Number(account.equity || 0) - startingBalance;
    const overallLimitAmt = (startingBalance * overallLossLimitPct) / 100;
    const overallUsagePct = overallLimitAmt > 0 ? (Math.max(0, -overallPnl) / overallLimitAmt) * 100 : 0;

    const dailyTier = tierFor(dailyUsagePct);
    const overallTier = tierFor(overallUsagePct);
    // Reset tier daily alert kalau sudah ganti hari (UTC)
    const prevDailyTier = existing?.dayStartDate === dayStartDate ? existing?.lastDailyAlertTier || 0 : 0;
    const prevOverallTier = existing?.lastOverallAlertTier || 0;

    if (dailyTier > prevDailyTier && dailyTier > 0) {
      await sendTelegram(
        TG_ADMIN_CHAT_ID,
        `⚠️ *Daily Loss Limit ${dailyTier}%* terpakai\nAkun: ${accountLabel}\nPnL hari ini: $${fmt(todayTotalPnl)} / -$${fmt(dailyLimitAmt)} limit`
      );
    }
    if (overallTier > prevOverallTier && overallTier > 0) {
      await sendTelegram(
        TG_ADMIN_CHAT_ID,
        `🚨 *Overall Loss Limit ${overallTier}%* terpakai\nAkun: ${accountLabel}\nEquity vs starting balance: $${fmt(overallPnl)} / -$${fmt(overallLimitAmt)} limit`
      );
    }

    const marginWasLow = existing?.marginLevel != null && existing.marginLevel < 120;
    const marginNowLow = account.marginLevel != null && account.marginLevel < 120;
    if (marginNowLow && !marginWasLow) {
      await sendTelegram(TG_ADMIN_CHAT_ID, `🚨 *Margin Level rendah*: ${fmt(account.marginLevel, 1)}%\nAkun: ${accountLabel}`);
    }

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
        accountLabel,
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
        lastDailyAlertTier: dailyTier,
        lastOverallAlertTier: overallTier,
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
