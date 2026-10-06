// api/webhook.js  (v2 - sinkron dengan EA v4.11)
// Menerima snapshot dari FaridFX_FiboManager_EA (POST) dan menulisnya ke Firestore.
//
// YANG DIPERBAIKI DIBANDING VERSI LAMA
//  1. SEMUA field akun dari EA sekarang disimpan (dulu hanya whitelist lama sehingga
//     eaEnabled, dailyLossPct, trend*, lockout, profitPct, sessionNow, dll hilang).
//  2. startingBalance / dayStartBalance memakai nilai dari EA (dulu: balance snapshot pertama).
//  3. History idempoten: satu dokumen per posisi, dicek dulu sebelum ditulis. dailyPnl dihitung
//     ULANG dari history per hari (dulu FieldValue.increment -> bisa dobel / meleset).
//  4. Waktu: EA kini mengirim epoch UTC + field "day" (tanggal hari server). Kalender memakai "day".
//  5. Alert Telegram memakai angka loss dari EA (sumber kebenaran), bukan hitungan ulang.
//  6. marginLevel = null kalau tidak ada posisi (MT5 mengirim 0 -> dulu memicu alert palsu).
//  7. Markdown Telegram di-escape + fallback teks polos (label akun ber-underscore tidak lagi gagal kirim).
//  8. (EA v4.13) Sinyal AO + Stoch + divergence: field "sig" disimpan, setiap sinyal BARU (watch/trigger)
//     dicatat ke accounts/{id}/signals, trigger berskor tinggi dikirim ke Telegram admin.
//     ENV opsional: SIGNAL_TG_MIN_SCORE (default 60), SIGNAL_TG_TFS (default "M5,M15,M30,H1").
//
// ENV VERCEL: FIREBASE_SERVICE_ACCOUNT, EA_WEBHOOK_SECRET,
//             TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_ID, TELEGRAM_ADMIN_CHAT_ID (3 terakhir opsional)

const admin = require('firebase-admin');

const SHARED_TOKEN = process.env.EA_WEBHOOK_SECRET;
const EQUITY_POINT_INTERVAL_MS = 5 * 60 * 1000;
const BATCH_CHUNK = 400;
const HISTORY_V = 2;

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const TG_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;
const SIG_MIN_SCORE = Number(process.env.SIGNAL_TG_MIN_SCORE || 60);
const SIG_TG_TFS = String(process.env.SIGNAL_TG_TFS || 'M5,M15,M30,H1').split(',').map((x) => x.trim()).filter(Boolean);

if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) console.error('FIREBASE_SERVICE_ACCOUNT env var belum diset.');
  else admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
}
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

// ---------------------------------------------------------------- util
const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
const fmt = (n, d = 2) => Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const utcDateStr = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
const mdEsc = (s) => String(s ?? '').replace(/([_*`\[])/g, '\\$1');

// hanya nilai primitif yang aman utk Firestore (tanpa undefined/NaN)
function cleanObj(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) {
    if (typeof v === 'number') { if (Number.isFinite(v)) out[k] = v; }
    else if (typeof v === 'string' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

async function commitInChunks(ops) {
  for (let i = 0; i < ops.length; i += BATCH_CHUNK) {
    const batch = db.batch();
    ops.slice(i, i + BATCH_CHUNK).forEach((op) => op(batch));
    await batch.commit();
  }
}

// ---------------------------------------------------------------- telegram
async function tgCall(method, payload) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await r.json();
  } catch (e) {
    console.error('telegram error', method, e);
    return null;
  }
}

async function sendTelegram(chatId, text) {
  if (!TG_TOKEN || !chatId) return null;
  let j = await tgCall('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true });
  if (j && !j.ok && /parse entities/i.test(j.description || '')) {
    j = await tgCall('sendMessage', { chat_id: chatId, text: text.replace(/[*_`\\]/g, ''), disable_web_page_preview: true });
  }
  if (!j || !j.ok) { console.error('telegram sendMessage failed', j); return null; }
  return j;
}

async function editTelegram(chatId, messageId, text) {
  if (!TG_TOKEN || !chatId || !messageId) return false;
  let j = await tgCall('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown', disable_web_page_preview: true });
  if (j && !j.ok && /parse entities/i.test(j.description || '')) {
    j = await tgCall('editMessageText', { chat_id: chatId, message_id: messageId, text: text.replace(/[*_`\\]/g, ''), disable_web_page_preview: true });
  }
  return !!(j && j.ok);
}

function liveCardText(label, p, opts = {}) {
  const dir = String(p.type).includes('buy') ? '🟢 BUY' : '🔴 SELL';
  let status;
  if (opts.closed) {
    const win = Number(opts.netProfit) >= 0;
    status = `${win ? '✅ CLOSED (Profit)' : '❌ CLOSED (Loss)'} — Net P/L: *${win ? '+' : ''}$${fmt(opts.netProfit)}*`;
  } else {
    status = '🟡 OPEN' + (opts.statusNote ? ` — _${mdEsc(opts.statusNote)}_` : '');
  }
  const closeLine = opts.closed && opts.closePrice ? `\nClose: \`${opts.closePrice}\`` : '';
  const hhmm = new Date().toISOString().slice(11, 16);
  return (
    `${dir} *${mdEsc(p.symbol)}*\n` +
    `Lot: \`${fmt(p.volume, 2)}\`  Entry: \`${p.priceOpen}\`${closeLine}\n` +
    `SL: \`${p.sl || '-'}\`  TP: \`${p.tp || '-'}\`\n` +
    `Status: ${status}\n` +
    `Akun: ${mdEsc(label)} · Ticket #${p.ticket}\n` +
    `_update: ${hhmm} UTC_`
  );
}

function signalCloseText(label, t) {
  const win = Number(t.netProfit) >= 0;
  return (
    `${win ? '✅ CLOSED (Profit)' : '❌ CLOSED (Loss)'} *${mdEsc(t.symbol)}*\n` +
    `${String(t.type).toUpperCase()} \`${fmt(t.volume, 2)}\` lot | ${t.openPrice} → ${t.closePrice}\n` +
    `Net P/L: *${win ? '+' : ''}$${fmt(t.netProfit)}*\n` +
    `Akun: ${mdEsc(label)} · Ticket #${t.ticket}`
  );
}

function signalModifyText(label, p, prev) {
  const parts = [];
  if (Number(prev.sl) !== Number(p.sl)) parts.push(`SL: \`${prev.sl || '-'}\` → \`${p.sl || '-'}\``);
  if (Number(prev.tp) !== Number(p.tp)) parts.push(`TP: \`${prev.tp || '-'}\` → \`${p.tp || '-'}\``);
  return `✏️ *MODIFIED* ${mdEsc(p.symbol)} #${p.ticket}\n${parts.join('\n')}\nAkun: ${mdEsc(label)}`;
}

const tierFor = (u) => (u >= 90 ? 90 : u >= 70 ? 70 : 0);

// ---------------------------------------------------------------- history
const TRADE_NUM_KEYS = ['volume', 'openPrice', 'closePrice', 'openTime', 'closeTime', 'durationSec', 'profit', 'swap', 'commission', 'netProfit'];

function normalizeTrade(t) {
  const rec = cleanObj(t);
  TRADE_NUM_KEYS.forEach((k) => { rec[k] = num(t[k]); });
  rec.ticket = String(t.ticket);
  rec.symbol = String(t.symbol || '');
  rec.type = String(t.type || '');
  rec.day = typeof t.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.day) ? t.day : utcDateStr(rec.closeTime);
  return rec;
}

function sameTrade(old, rec) {
  if (!old || old.day !== rec.day) return false;
  return ['netProfit', 'volume', 'closeTime', 'openTime', 'swap', 'commission', 'profit'].every(
    (k) => old[k] !== undefined && Math.abs(Number(old[k]) - Number(rec[k])) < 1e-6
  );
}

// ---------------------------------------------------------------- sinyal
function flagText(code) {
  const [k, pts, x1, x2] = String(code).split('|');
  switch (k) {
    case 'STO_ZONE': return 'Stoch di zona ekstrem';
    case 'STO_EXIT': return `Stoch baru keluar zona (${x1} bar)`;
    case 'AO_SHIFT': return `AO berganti warna (${x1} bar lalu)`;
    case 'AO_LIVE': return 'AO mulai berganti (bar berjalan)';
    case 'STO_X': return `Stoch K cross D (${x1} bar lalu)`;
    case 'DIV': return `${x1 === '0' ? 'Divergence' : 'Hidden divergence'} ${x2 === '0' ? 'AO' : 'Stoch'}`;
    case 'OTE': return 'Harga di zona OTE fibo';
    case 'HTF': return String(pts).startsWith('-') ? 'Melawan trend TF besar' : 'Searah trend TF besar';
    default: return k;
  }
}
const flagList = (f) => String(f || '').split(',').filter(Boolean).map(flagText);

// ---------------------------------------------------------------- handler
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET') return res.status(200).json({ ok: true, service: 'faridfx-webhook', v: 2, time: new Date().toISOString() });
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });

  try {
    const body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    if (!SHARED_TOKEN || body.token !== SHARED_TOKEN) return res.status(401).json({ ok: false, error: 'invalid token' });

    const account = body.account || {};
    const accountId = String(account.login || '').trim();
    if (!accountId) return res.status(400).json({ ok: false, error: 'missing account.login' });

    const positions = Array.isArray(body.positions) ? body.positions : [];
    const pendingOrders = Array.isArray(body.pendingOrders) ? body.pendingOrders : [];
    const exposure = Array.isArray(body.exposure) ? body.exposure : [];
    const sig = Array.isArray(body.sig) ? body.sig.slice(0, 8) : [];       // sinyal AO + Stoch + divergence (EA v4.13)
    const mtf = Array.isArray(body.mtf) ? body.mtf.slice(0, 8) : [];     // trend + fibo potensial per timeframe (EA v4.12)
    const fibo = Array.isArray(body.fibo) ? body.fibo.slice(0, 12) : [];  // fibo aktif (grup EA)
    const stats = cleanObj(body.stats || {});
    const history = Array.isArray(body.history) ? body.history : [];
    const reason = body.reason || 'unknown';
    const now = Date.now();

    const serverDay = typeof account.serverDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(account.serverDay)
      ? account.serverDay : utcDateStr(Math.floor(now / 1000));

    const accountRef = db.collection('accounts').doc(accountId);
    const existingSnap = await accountRef.get();
    const existing = existingSnap.exists ? existingSnap.data() : null;

    // --- baseline: percayai EA --------------------------------------------
    const eaStart = num(account.startingBalance);
    const startingBalance = eaStart > 0 ? eaStart : (existing?.startingBalance ?? num(account.balance));
    const eaDayStart = num(account.dayStartBalance);
    let dayStartBalance = eaDayStart > 0 ? eaDayStart : (existing?.dayStartBalance ?? num(account.balance));
    if (!(eaDayStart > 0) && existing?.serverDay !== serverDay) dayStartBalance = num(account.balance);

    const accountLabel = account.accountLabel || existing?.accountLabel || `MT5 ${accountId}`;

    // --- history (idempoten) -> history/{posId} + dailyPnl dihitung ulang ----
    const migrate = !existing || existing.historyV !== HISTORY_V;
    const lastSync = migrate ? 0 : num(existing.lastHistorySync);
    const candidates = history
      .filter((t) => t && t.ticket != null && (migrate || num(t.closeTime) >= lastSync - 600))
      .slice(-500)
      .map(normalizeTrade);

    let maxCloseTime = migrate ? 0 : lastSync;
    const refs = candidates.map((t) => accountRef.collection('history').doc(t.ticket));
    const snaps = refs.length ? await db.getAll(...refs) : [];

    const ops = [];
    const affectedDays = new Set();
    const newTrades = [];
    candidates.forEach((rec, i) => {
      if (rec.closeTime > maxCloseTime) maxCloseTime = rec.closeTime;
      const snap = snaps[i];
      const old = snap.exists ? snap.data() : null;
      if (old && sameTrade(old, rec)) return;
      if (!old) newTrades.push(rec);
      else if (old.day) affectedDays.add(old.day);
      affectedDays.add(rec.day);
      ops.push((batch) => batch.set(refs[i], rec));
    });
    await commitInChunks(ops);

    for (const d of affectedDays) {
      const q = await accountRef.collection('history').where('day', '==', d).get();
      let pnl = 0, trades = 0, wins = 0, losses = 0, volume = 0;
      q.forEach((x) => {
        const t = x.data();
        const n = num(t.netProfit);
        pnl += n; trades += 1; volume += num(t.volume);
        if (n > 0) wins += 1; else if (n < 0) losses += 1;
      });
      await accountRef.collection('dailyPnl').doc(d).set({
        date: d, pnl, trades, wins, losses, volume, updatedAt: FieldValue.serverTimestamp(),
      });
    }

    // --- Telegram: sinyal open / modify / close ------------------------------
    if (existing && TG_TOKEN && TG_CHANNEL_ID) {
      try {
        const prevPosMap = new Map((existing.positions || []).map((p) => [String(p.ticket), p]));
        const newlyOpened = positions.filter((p) => !prevPosMap.has(String(p.ticket)));
        const modified = positions.filter((p) => {
          const prev = prevPosMap.get(String(p.ticket));
          return prev && (Number(prev.sl) !== Number(p.sl) || Number(prev.tp) !== Number(p.tp));
        });

        for (const p of newlyOpened) {
          const sent = await sendTelegram(TG_CHANNEL_ID, liveCardText(accountLabel, p));
          if (sent?.result?.message_id) {
            await accountRef.collection('signalMessages').doc(String(p.ticket)).set({
              messageId: sent.result.message_id, chatId: TG_CHANNEL_ID, symbol: p.symbol, openedAt: now,
            });
          }
        }
        for (const p of modified) {
          const msgDoc = await accountRef.collection('signalMessages').doc(String(p.ticket)).get();
          let edited = false;
          if (msgDoc.exists) edited = await editTelegram(msgDoc.data().chatId, msgDoc.data().messageId, liveCardText(accountLabel, p, { statusNote: 'SL/TP diupdate' }));
          if (!edited) await sendTelegram(TG_CHANNEL_ID, signalModifyText(accountLabel, p, prevPosMap.get(String(p.ticket))));
        }
        if (!migrate) {
          for (const t of newTrades) {
            const msgDoc = await accountRef.collection('signalMessages').doc(String(t.ticket)).get();
            const lastKnown = prevPosMap.get(String(t.ticket)) || { symbol: t.symbol, type: t.type, volume: t.volume, sl: null, tp: null };
            const card = liveCardText(accountLabel, { ...lastKnown, priceOpen: t.openPrice, ticket: t.ticket }, { closed: true, netProfit: t.netProfit, closePrice: t.closePrice });
            let edited = false;
            if (msgDoc.exists) {
              edited = await editTelegram(msgDoc.data().chatId, msgDoc.data().messageId, card);
              await msgDoc.ref.delete().catch(() => {});
            }
            if (!edited) await sendTelegram(TG_CHANNEL_ID, signalCloseText(accountLabel, t));
          }
        }
      } catch (e) { console.error('telegram signals', e); }
    }

    // --- Telegram: alert limit (angka dari EA) -------------------------------
    const dLimit = num(account.dailyLossLimitPct, existing?.dailyLossLimitPct ?? 5);
    const oLimit = num(account.overallLossLimitPct, existing?.overallLossLimitPct ?? 10);
    const equity = num(account.equity);

    const dailyPct = account.dailyLossPct != null
      ? num(account.dailyLossPct)
      : (dayStartBalance > 0 && dLimit > 0 ? (Math.max(0, dayStartBalance - equity) / dayStartBalance) * 100 : 0);
    const overallPct = account.overallLossPct != null
      ? num(account.overallLossPct)
      : (startingBalance > 0 ? (Math.max(0, startingBalance - equity) / startingBalance) * 100 : 0);
    const dailyUsage = dLimit > 0 ? (dailyPct / dLimit) * 100 : 0;
    const overallUsage = oLimit > 0 ? (overallPct / oLimit) * 100 : 0;
    const dailyTier = tierFor(dailyUsage);
    const overallTier = tierFor(overallUsage);
    const prevDailyTier = existing?.serverDay === serverDay ? existing?.lastDailyAlertTier || 0 : 0;
    const prevOverallTier = existing?.lastOverallAlertTier || 0;

    if (existing && TG_ADMIN_CHAT_ID) {
      try {
        if (dailyTier > prevDailyTier) {
          await sendTelegram(TG_ADMIN_CHAT_ID,
            `⚠️ *Daily Loss Limit ${dailyTier}%* terpakai\nAkun: ${mdEsc(accountLabel)}\nLoss harian: ${fmt(dailyPct)}% dari limit ${fmt(dLimit, 1)}%` +
            (account.dailyRoomMoney != null ? `\nSisa ruang: $${fmt(account.dailyRoomMoney)}` : ''));
        }
        if (overallTier > prevOverallTier) {
          await sendTelegram(TG_ADMIN_CHAT_ID,
            `🚨 *Overall Loss Limit ${overallTier}%* terpakai\nAkun: ${mdEsc(accountLabel)}\nLoss total: ${fmt(overallPct)}% dari limit ${fmt(oLimit, 1)}%` +
            (account.overallRoomMoney != null ? `\nSisa ruang: $${fmt(account.overallRoomMoney)}` : ''));
        }
        // margin level 0 = tidak ada posisi -> bukan kondisi bahaya
        const nowLow = num(account.margin) > 0 && account.marginLevel != null && num(account.marginLevel) < 120;
        const wasLow = existing?.marginLevel != null && num(existing.marginLevel) < 120;
        if (nowLow && !wasLow) await sendTelegram(TG_ADMIN_CHAT_ID, `🚨 *Margin Level rendah*: ${fmt(account.marginLevel, 1)}%\nAkun: ${mdEsc(accountLabel)}`);
      } catch (e) { console.error('telegram alerts', e); }
    }

    // --- sinyal AO + Stoch + divergence: log perubahan tahap + Telegram ------------
    const sigLast = { ...(existing?.sigLast || {}) };
    const sigAt = { ...(existing?.sigAt || {}) };
    const sigEvents = [];
    for (const t of sig) {
      if (!t || !t.valid || !t.tf) continue;
      for (const dir of ['buy', 'sell']) {
        const o = t[dir] || {};
        const stage = o.stage || 'none';
        const key = `${t.tf}_${dir}`;
        const prev = sigLast[key] || 'none';
        const upgraded = stage !== prev && (stage === 'trigger' || (stage === 'watch' && prev === 'none'));
        if (existing && upgraded && now - num(sigAt[`${key}_${stage}`]) > 120000) {
          sigAt[`${key}_${stage}`] = now;
          sigEvents.push({ ts: now, tf: String(t.tf), dir, stage, score: num(o.score), price: num(t.price), flags: String(o.f || ''), barTime: num(t.barTime) });
        }
        sigLast[key] = stage;
      }
    }
    if (sigEvents.length) {
      try { await Promise.all(sigEvents.map((ev) => accountRef.collection('signals').add(ev))); } catch (e) { console.error('signals log', e); }
      if (TG_ADMIN_CHAT_ID) {
        for (const ev of sigEvents) {
          if (ev.stage !== 'trigger' || ev.score < SIG_MIN_SCORE || !SIG_TG_TFS.includes(ev.tf)) continue;
          const reasons = flagList(ev.flags).map((x) => `• ${mdEsc(x)}`).join('\n');
          await sendTelegram(TG_ADMIN_CHAT_ID,
            `🎯 *SINYAL ${ev.dir === 'buy' ? '🟢 BUY' : '🔴 SELL'}* — ${ev.tf} (skor ${ev.score})\nAkun: ${mdEsc(accountLabel)}\nHarga: \`${ev.price}\`\n${reasons}`);
        }
      }
    }

    // --- equity curve (throttle) ---------------------------------------------
    const lastEquityPointAt = existing?.lastEquityPointAt ?? 0;
    let equityPointWritten = false;
    if (now - lastEquityPointAt >= EQUITY_POINT_INTERVAL_MS || !existing) {
      await accountRef.collection('equityCurve').add({ ts: now, balance: num(account.balance), equity, date: serverDay });
      equityPointWritten = true;
    }

    // --- dokumen akun utama: SIMPAN SEMUA field dari EA -------------------------
    const base = cleanObj(account);
    delete base.startingBalanceOverride;
    await accountRef.set(
      {
        ...base,
        login: accountId,
        accountLabel,
        marginLevel: num(account.margin) > 0 && account.marginLevel != null ? num(account.marginLevel) : null,
        dailyLossLimitPct: dLimit,
        overallLossLimitPct: oLimit,
        riskPerPositionPct: num(account.riskPerPositionPct, existing?.riskPerPositionPct ?? 1),
        startingBalance,
        dayStartBalance,
        dayStartDate: serverDay,
        serverDay,
        historyV: HISTORY_V,
        lastHistorySync: maxCloseTime,
        lastEquityPointAt: equityPointWritten ? now : lastEquityPointAt,
        lastDailyAlertTier: dailyTier,
        lastOverallAlertTier: overallTier,
        positions,
        pendingOrders,
        exposure,
        mtf,
        fibo,
        sig,
        sigLast,
        sigAt,
        stats,
        lastReason: reason,
        receivedAt: new Date().toISOString(),
        updatedAt: FieldValue.serverTimestamp(),
        createdAt: existing?.createdAt ?? FieldValue.serverTimestamp(),
      },
      { merge: false }
    );

    return res.status(200).json({ ok: true, newTrades: newTrades.length, changedDays: affectedDays.size, equityPointWritten });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
};
