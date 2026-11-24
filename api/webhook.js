// api/webhook.js (v4 — OHLC Khusus Trade Masuk & Tutup + Hemat Kuota Firestore)
//
// ATURAN REKAM OHLC (MARKET_BARS_MODE, default: 'trade_only'):
//  - 'trade_only' (default): koleksi accounts/{id}/marketBars HANYA ditulis saat:
//      (a) ada posisi baru masuk (newlyOpened), atau
//      (b) ada trade baru selesai ditutup (newTrades).
//      Di luar momen itu: 0 Read & 0 Write ke marketBars!
//      Catatan: field `bars` di dokumen akun tetap diperbarui (0 extra write) agar
//      Quantum DOM & panel breakout M15/M30/H1/H4 tetap berjalan realtime.
//  - 'all' : rekam seperti mode standar (dengan deduplikasi).
//  - 'off' : matikan penulisan ke koleksi marketBars sepenuhnya.
//
// ENV VERCEL OPSIONAL:
//  MARKET_BARS_MODE=trade_only  (trade_only | all | off)
//  MARKET_BARS_POST_EXIT_MIN=0  (opsional: mis. 30 jika ingin rekam candle 30 mnt pasca-close)
//  MAX_MARKET_BARS_PER_SYNC=180
//  PERIODIC_MIN_SEC=90
//  IDLE_MIN_SEC=300
//  EQUITY_INTERVAL_MIN=15
//  CALENDAR_INTERVAL_HOURS=6

const admin = require('firebase-admin');
const crypto = require('crypto');

const SHARED_TOKEN = String(process.env.EA_WEBHOOK_SECRET || '').trim();
const PARTNERS_KEY = String(process.env.PARTNERS_ADMIN_KEY || '').trim();
const PARTNER_IDS = ['broker1','broker2','broker3','broker4','broker5','prop1','prop2','prop3','prop4','prop5'];

function keyOk(k) {
  if (!PARTNERS_KEY || typeof k !== 'string') return false;
  const a = Buffer.from(k.trim()), b = Buffer.from(PARTNERS_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function cleanHttpUrl(u, max) {
  u = String(u || '').trim();
  if (!u) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
  try {
    const x = new URL(u);
    return (x.protocol === 'https:' || x.protocol === 'http:') && x.href.length <= max ? x.href : '';
  } catch (e) { return ''; }
}
function cleanPartners(input) {
  const src = input && Array.isArray(input.slots) ? input.slots : [];
  const slots = PARTNER_IDS.map((id) => {
    const o = src.find((x) => x && x.id === id) || {};
    const logo = String(o.logo || '').trim();
    return {
      id,
      group: id.startsWith('broker') ? 'broker' : 'prop',
      name: String(o.name || '').trim().slice(0, 40),
      url: cleanHttpUrl(o.url, 600),
      tagline: String(o.tagline || '').trim().slice(0, 90),
      code: String(o.code || '').trim().slice(0, 24),
      logo: /^https:\/\//i.test(logo) && logo.length <= 500 ? logo : '',
    };
  });
  return { note: String((input && input.note) || '').trim().slice(0, 400), slots };
}

const EQUITY_POINT_INTERVAL_MS = Number(process.env.EQUITY_INTERVAL_MIN || 15) * 60 * 1000;
const CALENDAR_WRITE_INTERVAL_MS = Number(process.env.CALENDAR_INTERVAL_HOURS || 6) * 3600 * 1000;
const IDLE_MIN_MS = Number(process.env.IDLE_MIN_SEC || 300) * 1000;
const BATCH_CHUNK = 400;
const HISTORY_V = 3;

const MARKET_BARS_MODE = (() => {
  if (String(process.env.ENABLE_MARKET_BARS_WRITE || '').toLowerCase() === 'false') return 'off';
  const m = String(process.env.MARKET_BARS_MODE || 'trade_only').trim().toLowerCase();
  return ['trade_only', 'all', 'off'].includes(m) ? m : 'trade_only';
})();
const MARKET_BARS_POST_EXIT_MS = Math.max(0, Number(process.env.MARKET_BARS_POST_EXIT_MIN || 0)) * 60 * 1000;
const MAX_MARKET_BARS_PER_SYNC = Number(process.env.MAX_MARKET_BARS_PER_SYNC || 180);
const BAR_SEEN = new Set();

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const TG_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;
const SIG_MIN_SCORE = Number(process.env.SIGNAL_TG_MIN_SCORE || 60);
const SIG_TG_TFS = String(process.env.SIGNAL_TG_TFS || 'M5,M15,M30,H1')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.error('FIREBASE_SERVICE_ACCOUNT env var belum diset.');
  } else {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(raw)),
    });
  }
}

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

// ---------------------------------------------------------------- util

const num = (v, d = 0) =>
  Number.isFinite(Number(v)) && v !== null && v !== ''
    ? Number(v)
    : d;

const fmt = (n, d = 2) =>
  Number(n ?? 0).toLocaleString('en-US', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });

const utcDateStr = (sec) =>
  new Date(sec * 1000).toISOString().slice(0, 10);

const mdEsc = (s) =>
  String(s ?? '').replace(/([_*`\[])/g, '\\$1');

const shortHash = (obj) =>
  crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 16);

const normSym = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const symMatch = (a, b) => {
  a = normSym(a); b = normSym(b);
  if (!a || !b) return true;
  return a === b || (Math.min(a.length, b.length) >= 6 && (a.startsWith(b) || b.startsWith(a)));
};

function cleanObj(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) {
    if (typeof v === 'number') {
      if (Number.isFinite(v)) out[k] = v;
    } else if (typeof v === 'string' || typeof v === 'boolean') {
      out[k] = v;
    }
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
  let j = await tgCall('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  });
  if (j && !j.ok && /parse entities/i.test(j.description || '')) {
    j = await tgCall('sendMessage', {
      chat_id: chatId,
      text: text.replace(/[*_`\\]/g, ''),
      disable_web_page_preview: true,
    });
  }
  if (!j || !j.ok) {
    console.error('telegram sendMessage failed', j);
    return null;
  }
  return j;
}

async function editTelegram(chatId, messageId, text) {
  if (!TG_TOKEN || !chatId || !messageId) return false;
  let j = await tgCall('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  });
  if (j && !j.ok && /parse entities/i.test(j.description || '')) {
    j = await tgCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: text.replace(/[*_`\\]/g, ''),
      disable_web_page_preview: true,
    });
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

const TRADE_NUM_KEYS = [
  'volume', 'openPrice', 'closePrice', 'openTime', 'closeTime', 'durationSec',
  'profit', 'swap', 'commission', 'netProfit', 'sl', 'tp',
  'avgClosePrice', 'initialSl', 'initialTp', 'initialRiskMoney',
  'rMultiple', 'rNet', 'mae', 'mfe', 'maePct',
];

function normalizeTrade(t) {
  const rec = cleanObj(t);
  TRADE_NUM_KEYS.forEach((k) => { rec[k] = num(t[k]); });
  rec.ticket = String(t.ticket);
  rec.symbol = String(t.symbol || '');
  rec.type = String(t.type || '');
  rec.day = typeof t.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.day)
    ? t.day
    : utcDateStr(rec.closeTime);
  return rec;
}

function sameTrade(old, rec) {
  if (!old || old.day !== rec.day) return false;
  return [
    'netProfit', 'volume', 'closeTime', 'openTime', 'swap', 'commission', 'profit', 'sl', 'tp',
    'avgClosePrice', 'initialSl', 'initialTp', 'initialRiskMoney', 'rMultiple', 'rNet', 'mae', 'mfe', 'maePct',
  ].every((k) => old[k] !== undefined && Math.abs(Number(old[k]) - Number(rec[k])) < 1e-6)
    && String(old.exitReason || '') === String(rec.exitReason || '');
}

// ---------------------------------------------------------------- sinyal

function flagText(code) {
  const [k, pts, x1, x2, , x4] = String(code).split('|');
  switch (k) {
    case 'STO_ZONE': return 'Stoch di zona ekstrem';
    case 'STO_EXIT': return `Stoch baru keluar zona (${x1} bar)`;
    case 'AO_SHIFT': return `AO berganti warna (${+x1 + 1} bar lalu)`;
    case 'AO_LIVE':  return 'AO mulai berganti (bar berjalan)';
    case 'STO_X':    return `Stoch K cross D (${+x1 + 1} bar lalu)`;
    case 'DIV':      return `${x4 === '0' ? 'Potensi ' : ''}${x1 === '0' ? 'divergence' : 'hidden divergence'} ${x2 === '0' ? 'AO' : 'Stoch'}`;
    case 'OTE':      return 'Harga di zona OTE fibo';
    case 'HTF':      return String(pts).startsWith('-') ? 'Melawan trend TF besar' : 'Searah trend TF besar';
    case 'SWEEP':    return `Liquidity sweep ${x1}`;
    case 'CNDL':     return 'Candle konfirmasi';
    case 'LVL':      return `Dekat level ${x1}`;
    case 'LVLB':     return `Terhalang level ${x1}`;
    case 'REG_CT':   return 'Melawan tren kuat (ADX)';
    case 'REG_TR':   return 'Searah tren kuat (ADX)';
    case 'REG_RNG':  return 'Pasar ranging';
    case 'VOL_LOW':  return 'Volatilitas rendah';
    case 'VOL_HIGH': return 'Volatilitas sangat tinggi';
    case 'SPR':      return 'Spread lebar';
    case 'KZ':       return `Kill zone ${x1}`;
    case 'SEPI':     return 'Di luar sesi utama';
    case 'NEWS':     return 'Jendela news';
    case 'MTF_AL':   return `Searah TF ${x1}`;
    case 'MTF_CF':   return `Konflik TF ${x1}`;
    default:         return k;
  }
}

const flagList = (f) => String(f || '').split(',').filter(Boolean).map(flagText);

// ---------------------------------------------------------------- handler

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    let wantPartners = false, calAcc = '';
    try {
      const sp = new URL(req.url, 'http://x').searchParams;
      wantPartners = sp.get('partners') === '1';
      if (sp.get('calendar') === '1') calAcc = String(sp.get('acc') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    } catch (e) {}

    if (calAcc) {
      try {
        const snap = await db.collection('accounts').doc(calAcc).collection('meta').doc('calendar').get();
        res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300');
        if (!snap.exists) return res.status(200).json({ ok: true, events: [], updatedAt: null });
        const d = snap.data() || {};
        return res.status(200).json({ ok: true, events: d.events || [], updatedAt: d.updatedAt && d.updatedAt.toMillis ? d.updatedAt.toMillis() : null, source: d.source || 'mt5' });
      } catch (e) {
        return res.status(500).json({ ok: false, error: 'calendar read failed' });
      }
    }
    if (wantPartners) {
      try {
        const snap = await db.collection('config').doc('partners').get();
        res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=240');
        return res.status(200).json({ ok: true, partners: snap.exists ? snap.data() : null });
      } catch (e) {
        return res.status(500).json({ ok: false, error: 'partners read failed' });
      }
    }
    return res.status(200).json({ ok: true, service: 'faridfx-webhook', v: 4, marketBarsMode: MARKET_BARS_MODE, time: new Date().toISOString() });
  }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });

  try {
    const body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');

    if (body.action === 'partners:auth' || body.action === 'partners:save') {
      if (!PARTNERS_KEY) return res.status(503).json({ ok: false, error: 'PARTNERS_ADMIN_KEY belum diisi di Vercel' });
      if (!keyOk(body.key)) return res.status(401).json({ ok: false, error: 'kunci pemilik salah' });
      if (body.action === 'partners:auth') return res.status(200).json({ ok: true });
      const clean = cleanPartners(body);
      await db.collection('config').doc('partners').set({ ...clean, updatedAt: FieldValue.serverTimestamp() });
      return res.status(200).json({ ok: true, partners: clean });
    }

    // ===== Trading Cost & ROI Tracker (sinkron Firestore) =====
    if (typeof body.action === 'string' && body.action.startsWith('costroi:')) {
      if (!['costroi:load', 'costroi:save'].includes(body.action)) {
        return res.status(400).json({ ok: false, error: 'unknown costroi action' });
      }
      if (!PARTNERS_KEY) return res.status(503).json({ ok: false, error: 'PARTNERS_ADMIN_KEY belum diisi di Vercel' });
      if (!keyOk(body.key)) {
        return res.status(401).json({
          ok: false,
          error: 'Kunci pemilik tidak cocok. Masukkan kembali kunci yang sama dengan PARTNERS_ADMIN_KEY di Vercel.',
        });
      }

      const trackerRef = db.collection('config').doc('costroi_tracker');
      if (body.action === 'costroi:load') {
        const snap = await trackerRef.get();
        const saved = snap.exists ? (snap.data() || {}) : {};
        const data = {
          rows: Array.isArray(saved.rows) ? saved.rows : [],
          wd: Array.isArray(saved.wd) ? saved.wd : [],
          fx: Number.isFinite(Number(saved.fx)) ? Number(saved.fx) : 16500,
          rev: Math.max(0, Math.floor(num(saved.rev))),
        };
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({ ok: true, data });
      }

      const snap = await trackerRef.get();
      const saved = snap.exists ? (snap.data() || {}) : {};
      const currentRev = Math.max(0, Math.floor(num(saved.rev)));
      const baseRev = Math.max(0, Math.floor(num(body.baseRev)));
      if (baseRev !== currentRev) {
        return res.status(409).json({
          ok: false,
          error: 'revision conflict',
          data: {
            rows: Array.isArray(saved.rows) ? saved.rows : [],
            wd: Array.isArray(saved.wd) ? saved.wd : [],
            fx: Number.isFinite(Number(saved.fx)) ? Number(saved.fx) : 16500,
            rev: currentRev,
          },
        });
      }

      const safeRecord = (item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
        const out = {};
        for (const [k, v] of Object.entries(item)) {
          if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(k)) continue;
          if (typeof v === 'string') out[k] = v.slice(0, 1000);
          else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
          else if (typeof v === 'boolean' || v === null) out[k] = v;
        }
        return out;
      };
      const rows = Array.isArray(body.rows) ? body.rows.slice(0, 2000).map(safeRecord).filter(Boolean) : [];
      const wd = Array.isArray(body.wd) ? body.wd.slice(0, 5000).map(safeRecord).filter(Boolean) : [];
      const fx = Number(body.fx);
      if (!Number.isFinite(fx) || fx < 0 || fx > 1000000000) {
        return res.status(400).json({ ok: false, error: 'nilai kurs fx tidak valid' });
      }
      const rev = currentRev + 1;
      await trackerRef.set({ rows, wd, fx, rev, updatedAt: FieldValue.serverTimestamp() });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, rev });
    }

    if (!SHARED_TOKEN || String(body.token || '').trim() !== SHARED_TOKEN) {
      return res.status(401).json({ ok: false, error: 'invalid token' });
    }

    const account = body.account || {};
    const accountId = String(account.login || '').trim();
    if (!accountId) return res.status(400).json({ ok: false, error: 'missing account.login' });

    const accountRef = db.collection('accounts').doc(accountId);
    const existingSnap = await accountRef.get();
    const existing = existingSnap.exists ? existingSnap.data() : null;
    const now = Date.now();
    const nowSec = Math.floor(now / 1000);

    // --- Kalender ekonomi MT5: tulis maks 1x per 6 jam ---
    let lastCalendarWriteAt = num(existing?.lastCalendarWriteAt);
    if (Array.isArray(body.calendar) && body.calendar.length && (now - lastCalendarWriteAt >= CALENDAR_WRITE_INTERVAL_MS || !existing)) {
      try {
        const nVal = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
        const events = body.calendar.slice(0, 200).map((x) => {
          const o = {
            id: String((x && x.id) || '').slice(0, 60),
            t: Math.floor(Number(x && x.t) || 0),
            ccy: String((x && x.ccy) || '').slice(0, 6).toUpperCase(),
            title: String((x && x.title) || '').slice(0, 120),
            imp: Math.max(0, Math.min(3, Math.floor(Number(x && x.imp) || 0))),
            u: String((x && x.u) || '').slice(0, 6),
          };
          ['a', 'f', 'p'].forEach((k) => { const v = x && x[k] !== undefined ? nVal(x[k]) : null; if (v !== null) o[k] = v; });
          return o;
        }).filter((o) => o.id && o.t > 0 && o.title);
        if (events.length) {
          await accountRef.collection('meta').doc('calendar').set({
            events, count: events.length, source: 'mt5', updatedAt: FieldValue.serverTimestamp(),
          });
          lastCalendarWriteAt = now;
        }
      } catch (calErr) {
        console.warn('calendar write failed', calErr && calErr.message);
      }
    }

    const positions = Array.isArray(body.positions) ? body.positions : [];
    const pendingOrders = Array.isArray(body.pendingOrders) ? body.pendingOrders : [];
    const exposure = Array.isArray(body.exposure) ? body.exposure : [];
    const sig = Array.isArray(body.sig) ? body.sig.slice(0, 8) : [];
    const lv = Array.isArray(body.lv) ? body.lv.slice(0, 40) : [];
    const mtf = Array.isArray(body.mtf) ? body.mtf.slice(0, 8) : [];
    const fibo = Array.isArray(body.fibo) ? body.fibo.slice(0, 12) : [];
    const stats = cleanObj(body.stats || {});
    const history = Array.isArray(body.history) ? body.history : [];

    // Deteksi posisi baru masuk sejak awal agar bisa memicu rekam OHLC trade_only
    const prevPosMap = new Map((existing?.positions || []).map((p) => [String(p.ticket), p]));
    const newlyOpened = existing
      ? positions.filter((p) => p && p.ticket != null && !prevPosMap.has(String(p.ticket)))
      : [];

    // --- OHLC realtime Quantum DOM (disimpan di field `bars` dokumen akun = 0 extra write) ---
    const realtimeBars = {};
    const realtimeTfKeys = ['M15', 'M30', 'H1', 'H4'];
    const lastRtBarTs = { ...(existing?.lastRtBarTs || {}) };
    const incomingBars = body.bars && typeof body.bars === 'object' && !Array.isArray(body.bars) ? body.bars : {};
    const primarySym = String(account.symbol || account._symbol || 'XAUUSD').trim().slice(0, 32) || 'XAUUSD';

    for (const tf of realtimeTfKeys) {
      const sourceKey = Object.keys(incomingBars).find((key) => String(key).toUpperCase() === tf);
      const sourceRows = sourceKey && Array.isArray(incomingBars[sourceKey]) ? incomingBars[sourceKey] : [];
      const normalized = sourceRows.slice(-60).map((row) => {
        let t, open, high, low, close, volume;
        if (Array.isArray(row)) { [t, open, high, low, close, volume] = row; }
        else if (row && typeof row === 'object') {
          t = row.t ?? row.time ?? row.ts;
          open = row.o ?? row.open; high = row.h ?? row.high;
          low = row.l ?? row.low; close = row.c ?? row.close;
          volume = row.v ?? row.volume ?? row.tick_volume ?? 0;
        } else return null;

        t = num(t, NaN); open = num(open, NaN); high = num(high, NaN); low = num(low, NaN); close = num(close, NaN); volume = num(volume, 0);
        if (![t, open, high, low, close].every(Number.isFinite) || t <= 0) return null;
        if (t >= 1e12) t = Math.floor(t / 1000);
        if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) return null;
        return [Math.floor(t), open, high, low, close, volume];
      }).filter(Boolean).sort((a, b) => a[0] - b[0]);

      if (normalized.length) realtimeBars[tf] = normalized;
    }

    const reason = body.reason || 'unknown';
    const serverDay = typeof account.serverDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(account.serverDay)
      ? account.serverDay
      : utcDateStr(nowSec);

    const eaStart = num(account.startingBalance);
    const startingBalance = eaStart > 0 ? eaStart : (existing?.startingBalance ?? num(account.balance));
    const eaDayStart = num(account.dayStartBalance);
    let dayStartBalance = eaDayStart > 0 ? eaDayStart : (existing?.dayStartBalance ?? num(account.balance));
    if (!(eaDayStart > 0) && existing?.serverDay !== serverDay) dayStartBalance = num(account.balance);
    const accountLabel = account.accountLabel || existing?.accountLabel || `MT5 ${accountId}`;

    // --- history idempoten & HEMAT READ (0 read jika tidak ada trade baru) ---
    const migrate = !existing || existing.historyV !== HISTORY_V;
    const lastSync = migrate ? 0 : num(existing.lastHistorySync);
    const prevHistCount = num(existing?.lastHistoryCount, -1);

    let maxIncomingClose = 0;
    for (let i = 0; i < history.length; i++) {
      const ct = num(history[i]?.closeTime);
      if (ct > maxIncomingClose) maxIncomingClose = ct;
    }

    const needHistoryCheck = migrate || (history.length > 0 && (maxIncomingClose > lastSync || history.length !== prevHistCount));
    let maxCloseTime = migrate ? 0 : lastSync;
    const affectedDays = new Set();
    const newTrades = [];

    if (needHistoryCheck) {
      const candidates = history
        .filter((t) => t && t.ticket != null && (migrate || num(t.closeTime) >= lastSync - 600))
        .slice(-500)
        .map(normalizeTrade);

      const refs = candidates.map((t) => accountRef.collection('history').doc(t.ticket));
      const snaps = refs.length ? await db.getAll(...refs) : [];
      const ops = [];

      candidates.forEach((rec, i) => {
        if (rec.closeTime > maxCloseTime) maxCloseTime = rec.closeTime;
        const old = snaps[i].exists ? snaps[i].data() : null;
        if (old && sameTrade(old, rec)) return;
        if (!old) newTrades.push(rec);
        else if (old.day) affectedDays.add(old.day);
        affectedDays.add(rec.day);
        ops.push((batch) => batch.set(refs[i], rec));
      });

      if (ops.length) await commitInChunks(ops);
    }

    // --- market OHLC bars: HANYA DIREKAM SAAT TRADE MASUK / SELESAI DITUTUP (mode trade_only) ---
    let marketBarsWritten = 0;
    let lastTradeCloseAtMs = num(existing?.lastTradeCloseAtMs);
    const closedLiveTrades = migrate ? [] : newTrades;
    if (closedLiveTrades.length) lastTradeCloseAtMs = now;

    const inPostExitWindow = MARKET_BARS_POST_EXIT_MS > 0
      && lastTradeCloseAtMs > 0
      && (now - lastTradeCloseAtMs) <= MARKET_BARS_POST_EXIT_MS;

    const hasTradeEvent = newlyOpened.length > 0 || closedLiveTrades.length > 0;
    const shouldWriteMarketBars =
      MARKET_BARS_MODE === 'all' ||
      (MARKET_BARS_MODE === 'trade_only' && (hasTradeEvent || inPostExitWindow));

    const lastBarMap = { ...(existing?.lastMarketBarTs || {}) };

    if (shouldWriteMarketBars) {
      const marketBarsRaw = [
        ...(Array.isArray(body.chartBars) ? body.chartBars : []),
        ...(Array.isArray(body.marketBars) ? body.marketBars : []),
      ];

      // Jika EA mengirim realtimeBars (M15/M30/H1/H4) saat trade masuk/tutup, ikutkan sebagai cadangan OHLC
      if (MARKET_BARS_MODE === 'all') {
        for (const tf of realtimeTfKeys) {
          const arr = realtimeBars[tf];
          if (!arr || arr.length < 2) continue;
          const lastClosed = arr[arr.length - 2];
          if (lastClosed[0] > num(lastRtBarTs[tf])) {
            lastRtBarTs[tf] = lastClosed[0];
            marketBarsRaw.push({
              symbol: primarySym, timeframe: tf,
              time: lastClosed[0], open: lastClosed[1], high: lastClosed[2], low: lastClosed[3], close: lastClosed[4], volume: lastClosed[5],
            });
          }
        }
      } else if (hasTradeEvent && !marketBarsRaw.length) {
        // Fallback: bila EA belum mengirim chartBars/marketBars saat event trade, ambil dari realtimeBars (M15 & H1)
        ['M15', 'M30', 'H1'].forEach((tf) => {
          const arr = realtimeBars[tf];
          if (!arr || !arr.length) return;
          arr.slice(-45).forEach((bar) => {
            marketBarsRaw.push({
              symbol: primarySym, timeframe: tf,
              time: bar[0], open: bar[1], high: bar[2], low: bar[3], close: bar[4], volume: bar[5],
            });
          });
        });
      }

      // Bangun jendela waktu khusus untuk trade yang baru masuk / baru ditutup
      const tradeWindows = [];
      if (MARKET_BARS_MODE === 'trade_only') {
        newlyOpened.forEach((p) => {
          const oSec = num(p.openTime ?? p.timeOpen ?? p.time, nowSec);
          const t0 = (oSec > 1e12 ? Math.floor(oSec / 1000) : oSec) || nowSec;
          tradeWindows.push({ sym: p.symbol || primarySym, from: t0 - 6 * 3600, to: nowSec + 900 });
        });
        closedLiveTrades.forEach((t) => {
          const cSec = num(t.closeTime, nowSec);
          const oSec = num(t.openTime, cSec - 3600);
          const dur = Math.max(3600, cSec - oSec);
          const prePad = Math.min(24 * 3600, Math.max(4 * 3600, Math.round(dur * 0.6)));
          tradeWindows.push({ sym: t.symbol || primarySym, from: oSec - prePad, to: cSec + 3600 });
        });
        if (!tradeWindows.length && inPostExitWindow) {
          tradeWindows.push({ sym: primarySym, from: Math.floor(lastTradeCloseAtMs / 1000) - 900, to: nowSec + 900 });
        }
      }

      const seenInBatch = new Set();
      const validBars = [];

      for (const b of marketBarsRaw.slice(-MAX_MARKET_BARS_PER_SYNC)) {
        if (!b || typeof b !== 'object') continue;
        const symbol = String(b.symbol || primarySym).trim().slice(0, 32);
        const timeframe = String(b.timeframe || b.tf || '').trim().toUpperCase().slice(0, 12);
        const time = num(b.time, num(b.ts));
        const open = num(b.open, NaN), high = num(b.high, NaN), low = num(b.low, NaN), close = num(b.close, NaN), volume = num(b.volume, 0);
        if (!symbol || !timeframe || !(time > 0) || ![open, high, low, close].every(Number.isFinite)) continue;
        if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) continue;

        const timeMs = time < 1e12 ? Math.round(time * 1000) : Math.round(time);
        const timeSec = Math.floor(timeMs / 1000);

        // Pada mode trade_only, hanya simpan candle yang relevan dengan simbol & rentang waktu trade yang masuk/tutup
        if (MARKET_BARS_MODE === 'trade_only' && tradeWindows.length) {
          const insideAny = tradeWindows.some((w) => symMatch(symbol, w.sym) && timeSec >= w.from && timeSec <= w.to);
          if (!insideAny) continue;
        }

        const safeSymbol = symbol.replace(/[^a-zA-Z0-9._-]/g, '_');
        const safeTf = timeframe.replace(/[^a-zA-Z0-9_-]/g, '_');
        const docId = `${safeSymbol}_${safeTf}_${timeSec}`;
        const memKey = `${accountId}|${docId}|${open}|${high}|${low}|${close}`;
        if (seenInBatch.has(docId) || BAR_SEEN.has(memKey)) continue;
        seenInBatch.add(docId);

        const pairKey = `${safeSymbol}_${safeTf}`;
        if (MARKET_BARS_MODE === 'all' && !closedLiveTrades.length && num(lastBarMap[pairKey]) > 0 && timeSec < num(lastBarMap[pairKey])) {
          continue;
        }

        const day = typeof b.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.day) ? b.day : utcDateStr(timeSec);
        validBars.push({
          id: docId, pairKey, timeSec, memKey,
          data: { symbol, timeframe, time: timeSec, timeMs, open, high, low, close, volume, day, updatedAt: FieldValue.serverTimestamp() },
        });
      }

      if (validBars.length) {
        const barRefs = validBars.map((bar) => accountRef.collection('marketBars').doc(bar.id));
        const barSnaps = await db.getAll(...barRefs);
        const barOps = [];

        if (BAR_SEEN.size > 4000) BAR_SEEN.clear();
        validBars.forEach((bar, i) => {
          const old = barSnaps[i].exists ? barSnaps[i].data() : null;
          if (bar.timeSec > num(lastBarMap[bar.pairKey])) lastBarMap[bar.pairKey] = bar.timeSec;
          if (old && old.open === bar.data.open && old.high === bar.data.high && old.low === bar.data.low && old.close === bar.data.close) {
            BAR_SEEN.add(bar.memKey);
            return;
          }
          BAR_SEEN.add(bar.memKey);
          barOps.push((batch) => batch.set(barRefs[i], bar.data, { merge: true }));
        });

        if (barOps.length) {
          await commitInChunks(barOps);
          marketBarsWritten = barOps.length;
        }
      }
    }

    // --- hitung ulang P/L harian (hanya jika ada trade baru/berubah) ---
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

    // --- Telegram: open / modify / close ---
    if (existing && TG_TOKEN && TG_CHANNEL_ID) {
      try {
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
          if (msgDoc.exists) {
            edited = await editTelegram(msgDoc.data().chatId, msgDoc.data().messageId, liveCardText(accountLabel, p, { statusNote: 'SL/TP diupdate' }));
          }
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
      } catch (e) {
        console.error('telegram signals', e);
      }
    }

    // --- Telegram: alert loss limit ---
    const dLimit = num(account.dailyLossLimitPct, existing?.dailyLossLimitPct ?? 5);
    const oLimit = num(account.overallLossLimitPct, existing?.overallLossLimitPct ?? 10);
    const equity = num(account.equity);
    const dailyPct = account.dailyLossPct != null
      ? num(account.dailyLossPct)
      : (dayStartBalance > 0 && dLimit > 0 ? (Math.max(0, dayStartBalance - equity) / dayStartBalance) * 100 : 0);
    const overallPct = account.overallLossPct != null
      ? num(account.overallLossPct)
      : (startingBalance > 0 ? (Math.max(0, startingBalance - equity) / startingBalance) * 100 : 0);
    const dailyTier = tierFor(dLimit > 0 ? (dailyPct / dLimit) * 100 : 0);
    const overallTier = tierFor(oLimit > 0 ? (overallPct / oLimit) * 100 : 0);
    const prevDailyTier = existing?.serverDay === serverDay ? (existing?.lastDailyAlertTier || 0) : 0;
    const prevOverallTier = existing?.lastOverallAlertTier || 0;

    if (existing && TG_ADMIN_CHAT_ID) {
      try {
        if (dailyTier > prevDailyTier) {
          await sendTelegram(TG_ADMIN_CHAT_ID,
            `⚠️ *Daily Loss Limit ${dailyTier}%* terpakai\nAkun: ${mdEsc(accountLabel)}\nLoss harian: ${fmt(dailyPct)}% dari limit ${fmt(dLimit, 1)}%` +
            (account.dailyRoomMoney != null ? `\nSisa ruang: $${fmt(account.dailyRoomMoney)}` : '')
          );
        }
        if (overallTier > prevOverallTier) {
          await sendTelegram(TG_ADMIN_CHAT_ID,
            `🚨 *Overall Loss Limit ${overallTier}%* terpakai\nAkun: ${mdEsc(accountLabel)}\nLoss total: ${fmt(overallPct)}% dari limit ${fmt(oLimit, 1)}%` +
            (account.overallRoomMoney != null ? `\nSisa ruang: $${fmt(account.overallRoomMoney)}` : '')
          );
        }
        const nowLow = num(account.margin) > 0 && account.marginLevel != null && num(account.marginLevel) < 120;
        const wasLow = existing?.marginLevel != null && num(existing.marginLevel) < 120;
        if (nowLow && !wasLow) {
          await sendTelegram(TG_ADMIN_CHAT_ID, `🚨 *Margin Level rendah*: ${fmt(account.marginLevel, 1)}%\nAkun: ${mdEsc(accountLabel)}`);
        }
      } catch (e) {
        console.error('telegram alerts', e);
      }
    }

    // --- event sinyal & outcome: HEMAT WRITE/READ dengan payload hash + diff ---
    const sigEv = (Array.isArray(body.sigEv) ? body.sigEv : []).filter((e) => e && e.id).slice(0, 60);
    const sigOut = (Array.isArray(body.sigOut) ? body.sigOut : []).filter((o) => o && o.id).slice(0, 60);
    const sigPayloadHash = (sigEv.length || sigOut.length) ? shortHash({ e: sigEv, o: sigOut }) : (existing?.lastSigPayloadHash || '');
    let sigNew = 0;

    if ((sigEv.length || sigOut.length) && sigPayloadHash !== existing?.lastSigPayloadHash) {
      try {
        const allIds = [...new Set([...sigEv.map((e) => String(e.id)), ...sigOut.map((o) => String(o.id))])];
        const allRefs = allIds.map((id) => accountRef.collection('signals').doc(id));
        const allSnaps = allRefs.length ? await db.getAll(...allRefs) : [];
        const snapMap = new Map(allIds.map((id, idx) => [id, allSnaps[idx].exists ? allSnaps[idx].data() : null]));
        const ops = [];
        const fresh = [];

        sigEv.forEach((e) => {
          const id = String(e.id);
          const old = snapMap.get(id);
          const next = { ...cleanObj(e), id, ts: num(e.ts) * 1000 };
          if (!old) {
            fresh.push(e);
            ops.push((batch) => batch.set(accountRef.collection('signals').doc(id), next, { merge: true }));
          } else if (old.stage !== next.stage || num(old.score) !== num(next.score) || num(old.sl) !== num(next.sl) || num(old.tp) !== num(next.tp)) {
            ops.push((batch) => batch.set(accountRef.collection('signals').doc(id), next, { merge: true }));
          }
        });

        sigOut.forEach((o) => {
          const id = String(o.id);
          const old = snapMap.get(id);
          const tEndMs = num(o.tEnd) * 1000;
          if (old && old.res === String(o.res) && num(old.tEnd) === tEndMs) return;
          ops.push((batch) => batch.set(accountRef.collection('signals').doc(id), {
            res: String(o.res), r: num(o.r), mfe: num(o.mfe), mae: num(o.mae), dur: num(o.dur), exit: num(o.exit), tEnd: tEndMs,
          }, { merge: true }));
        });

        if (ops.length) await commitInChunks(ops);
        sigNew = fresh.length;

        if (TG_ADMIN_CHAT_ID && existing) {
          for (const e of fresh) {
            if (e.stage !== 'trigger' || num(e.score) < SIG_MIN_SCORE || !SIG_TG_TFS.includes(String(e.tf))) continue;
            const reasons = flagList(e.f).map((x) => `• ${mdEsc(x)}`).join('\n');
            await sendTelegram(
              TG_ADMIN_CHAT_ID,
              `🎯 *SINYAL ${e.dir === 'buy' ? '🟢 BUY' : '🔴 SELL'}* — ${e.tf} (skor ${num(e.score)})\n` +
                `Akun: ${mdEsc(accountLabel)}\nEntry: \`${e.price}\`  SL: \`${e.sl}\`  TP: \`${e.tp}\` (R:R ${fmt(e.rr, 2)})\n` +
                `Sesi: ${mdEsc(e.sess || '-')} · Regime: ${mdEsc(e.reg || '-')}\n${reasons}`
            );
          }
        }
      } catch (e) {
        console.error('signals', e);
      }
    }

    // --- Idle/Weekend Skip ---
    const lastAccountWriteMs = existing?.receivedAt ? Date.parse(existing.receivedAt) : 0;
    const stateDigest = shortHash({
      bal: num(account.balance), eq: equity, bid: num(account.bid), ask: num(account.ask),
      pos: positions.map((p) => [p.ticket, p.sl, p.tp, num(p.profit).toFixed(2)]),
      pend: pendingOrders.length, eaOn: account.eaEnabled, syncOn: account.syncEnabled,
      sigHash: sigPayloadHash, calAt: lastCalendarWriteAt,
    });
    const isIdleSame = existing && reason === 'periodic' && !hasTradeEvent && !marketBarsWritten && !sigNew
      && existing.lastStateDigest === stateDigest
      && (now - lastAccountWriteMs) < IDLE_MIN_MS;

    if (isIdleSame) {
      return res.status(200).json({ ok: true, skippedIdle: true, newTrades: 0, newSignals: 0, marketBarsWritten: 0 });
    }

    // --- equity curve dengan throttle + skip bila saldo/equity sama ---
    const lastEquityPointAt = existing?.lastEquityPointAt ?? 0;
    const eqChanged = !existing || Math.abs(num(account.balance) - num(existing.balance)) >= 0.01 || Math.abs(equity - num(existing.equity)) >= 0.01;
    let equityPointWritten = false;

    if (!existing || (now - lastEquityPointAt >= EQUITY_POINT_INTERVAL_MS && eqChanged) || (now - lastEquityPointAt >= 60 * 60 * 1000)) {
      await accountRef.collection('equityCurve').add({
        ts: now, balance: num(account.balance), equity, date: serverDay,
      });
      equityPointWritten = true;
    }

    // --- dokumen akun utama ---
    const base = cleanObj(account);
    delete base.startingBalanceOverride;

    await accountRef.set({
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
      lastHistoryCount: history.length,
      lastCalendarWriteAt,
      lastSigPayloadHash: sigPayloadHash,
      lastStateDigest: stateDigest,
      lastTradeCloseAtMs,
      lastRtBarTs,
      lastMarketBarTs: lastBarMap,
      lastEquityPointAt: equityPointWritten ? now : lastEquityPointAt,
      lastDailyAlertTier: dailyTier,
      lastOverallAlertTier: overallTier,
      positions,
      pendingOrders,
      exposure,
      bars: Object.keys(realtimeBars).length ? { ...(existing?.bars || {}), ...realtimeBars } : (existing?.bars || {}),
      mtf,
      fibo,
      sig,
      lv,
      stats,
      lastReason: reason,
      dataSource: 'mt5_ea',
      webhookReceivedAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      updatedAt: FieldValue.serverTimestamp(),
      createdAt: existing?.createdAt ?? FieldValue.serverTimestamp(),
    }, { merge: false });

    return res.status(200).json({
      ok: true,
      newTrades: newTrades.length,
      newlyOpened: newlyOpened.length,
      newSignals: sigNew,
      changedDays: affectedDays.size,
      equityPointWritten,
      marketBarsWritten,
      marketBarsMode: MARKET_BARS_MODE,
      realtimeBarsReceived: Object.fromEntries(realtimeTfKeys.map((tf) => [tf, (realtimeBars[tf] || []).length])),
    });
  } catch (e) {
    console.error(e);
    await noteHandlerError(e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
}

// ===================================================================
// Pelindung timeout / kuota Firestore + throttle snapshot periodik
// ===================================================================
const HANDLER_TIMEOUT_MS = Number(process.env.WEBHOOK_TIMEOUT_MS || 15000);
const BREAKER_MS = Number(process.env.WEBHOOK_BREAKER_MS || 120000);
const PERIODIC_MIN_MS = Number(process.env.PERIODIC_MIN_SEC || 90) * 1000;
let breakerUntil = 0;
const lastWrite = new Map();
const lastTradeSig = new Map();
let lastOkAt = 0, lastFailAt = 0, lastFailMsg = '', outageAlertAt = 0, outageOpen = false;
const ALERT_GAP_MS = 30 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function notifyOutage(reason) {
  try {
    if (!TG_TOKEN || !TG_ADMIN_CHAT_ID) return;
    if (Date.now() - outageAlertAt < ALERT_GAP_MS) return;
    outageAlertAt = Date.now();
    outageOpen = true;
    await Promise.race([
      sendTelegram(
        TG_ADMIN_CHAT_ID,
        '⚠️ *Webhook FaridFX bermasalah*\n' + `${mdEsc(reason)}\n` +
          'Sinkronisasi EA ditahan sementara lalu dicoba lagi otomatis.\n' +
          'Cek: Firebase Console → Firestore → Usage (Writes harian 20.000 / Reads 50.000 di paket Spark).'
      ),
      sleep(4000),
    ]);
  } catch (e) { console.error('notifyOutage', e); }
}

async function notifyRecovery() {
  try {
    if (!outageOpen) return;
    outageOpen = false;
    if (!TG_TOKEN || !TG_ADMIN_CHAT_ID) return;
    await Promise.race([
      sendTelegram(TG_ADMIN_CHAT_ID, '✅ *Webhook FaridFX pulih* — sinkronisasi EA berjalan normal lagi.'),
      sleep(4000),
    ]);
  } catch (e) { console.error('notifyRecovery', e); }
}

async function noteHandlerError(e) {
  lastFailAt = Date.now();
  lastFailMsg = String((e && e.message) || e).slice(0, 160);
  if ((e && e.code === 8) || /RESOURCE_EXHAUSTED|quota/i.test(String(e))) {
    breakerUntil = Date.now() + BREAKER_MS;
    await notifyOutage('Firestore menolak write/read: kuota harian habis (RESOURCE_EXHAUSTED).');
  }
}

function healthRequested(req) {
  try { return new URL(req.url, 'http://x').searchParams.get('health') === '1'; } catch (e) { return false; }
}

function peekBody(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { return null; } }
  return b && typeof b === 'object' ? b : null;
}

const SIG_BYPASS_MIN_MS = Number(process.env.SIG_BYPASS_MIN_SEC || 10) * 1000;
const lastSignalSig = new Map();

function tradeSigOf(b) {
  if (!b) return '';
  const pos = Array.isArray(b.positions) ? b.positions.map((p) => String(p?.ticket || '')).sort().join(',') : '';
  const histLen = Array.isArray(b.history) ? b.history.length : 0;
  let maxClose = 0;
  if (Array.isArray(b.history)) {
    for (let i = Math.max(0, b.history.length - 10); i < b.history.length; i++) {
      const ct = Number(b.history[i]?.closeTime || 0);
      if (ct > maxClose) maxClose = ct;
    }
  }
  return `${pos}|${histLen}|${maxClose}`;
}

function signalSigOf(b) {
  if (!b) return '';
  const sigPart = Array.isArray(b.sig)
    ? b.sig.map((s) => `${s?.tf || ''}:${s?.stage || s?.state || ''}:${s?.dir || s?.side || ''}`).join(',')
    : '';
  const evPart = Array.isArray(b.sigEv)
    ? b.sigEv.slice(-10).map((e) => `${e?.id || ''}:${e?.stage || ''}`).join(',')
    : '';
  const outPart = Array.isArray(b.sigOut)
    ? b.sigOut.slice(-10).map((o) => `${o?.id || ''}:${o?.res || ''}`).join(',')
    : '';
  return `${sigPart}#${evPart}#${outPart}`;
}

function isThrottleableReason(b) {
  if (!b) return false;
  const r = String(b.reason || 'periodic').toLowerCase();
  if (/(trade|order|deal|open|close|modify|init|start|manual|command|cmd|sync_now|breach|sig|signal)/.test(r)) return false;
  return r === 'periodic' || r === 'timer' || r === 'heartbeat' || r === 'tick' || r === 'unknown';
}

module.exports = async (req, res) => {
  if (req.method === 'GET' && healthRequested(req)) {
    const n = Date.now();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: true, now: n,
      breaker: n < breakerUntil,
      breakerSecLeft: n < breakerUntil ? Math.ceil((breakerUntil - n) / 1000) : 0,
      lastOkAgoSec: lastOkAt ? Math.round((n - lastOkAt) / 1000) : null,
      lastFailAgoSec: lastFailAt ? Math.round((n - lastFailAt) / 1000) : null,
      lastFailMsg,
      marketBarsMode: MARKET_BARS_MODE,
      periodicMinSec: PERIODIC_MIN_MS / 1000,
      sigBypassMinSec: SIG_BYPASS_MIN_MS / 1000,
      timeoutMs: HANDLER_TIMEOUT_MS,
    });
  }
  if (req.method !== 'POST') return handler(req, res);

  const b = peekBody(req);
  const accKey = b && b.account ? String(b.account.login || '').trim() : '';
  const tSig = tradeSigOf(b);
  const sSig = signalSigOf(b);
  const t0 = Date.now();
  const sinceLast = t0 - (lastWrite.get(accKey) || 0);
  const tradeChanged = !!(accKey && lastTradeSig.has(accKey) && lastTradeSig.get(accKey) !== tSig);
  const sigChanged = !!(accKey && lastSignalSig.has(accKey) && lastSignalSig.get(accKey) !== sSig && sinceLast >= SIG_BYPASS_MIN_MS);

  if (t0 < breakerUntil) {
    const wait = Math.ceil((breakerUntil - t0) / 1000);
    res.setHeader('Retry-After', String(wait));
    return res.status(503).json({ ok: false, error: 'firestore_unavailable', retryAfterSec: wait });
  }

  // Bypass otomatis saat trade masuk/tutup atau sinyal M1/M3/dll berubah status
  if (!tradeChanged && !sigChanged && PERIODIC_MIN_MS > 0 && accKey && isThrottleableReason(b) && sinceLast < PERIODIC_MIN_MS) {
    lastOkAt = t0;
    return res.status(200).json({ ok: true, throttled: true, newTrades: 0, marketBarsWritten: 0 });
  }

  let timedOut = false, timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(async () => {
      timedOut = true;
      breakerUntil = Date.now() + BREAKER_MS;
      lastFailAt = Date.now();
      lastFailMsg = 'timeout >' + HANDLER_TIMEOUT_MS + 'ms';
      console.error('webhook timeout >' + HANDLER_TIMEOUT_MS + 'ms — breaker aktif ' + BREAKER_MS + 'ms');
      if (!res.headersSent) res.status(503).json({ ok: false, error: 'firestore_timeout', retryAfterSec: Math.ceil(BREAKER_MS / 1000) });
      await notifyOutage('Firestore tidak merespons >' + Math.round(HANDLER_TIMEOUT_MS / 1000) + ' dtk (kemungkinan kuota harian habis).');
      resolve();
    }, HANDLER_TIMEOUT_MS);
  });

  try {
    await Promise.race([handler(req, res), guard]);
    if (!timedOut && res.statusCode === 200) {
      breakerUntil = 0;
      lastOkAt = Date.now();
      if (accKey) {
        lastWrite.set(accKey, Date.now());
        lastTradeSig.set(accKey, tSig);
        lastSignalSig.set(accKey, sSig);
      }
      await notifyRecovery();
    }
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ ok: false, error: String(e) });
    else console.error('late error after response', e);
  } finally {
    clearTimeout(timer);
  }
};
