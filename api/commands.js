// api/commands.js  (v5 — Hemat Kuota Firestore + Anti-Timeout + Fix HTTP 401)
// Optimasi kuota Read (Spark limit 50.000 Read/hari):
//  1. Hapus read ganda resolveAccountId() pada GET: langsung query accounts/{login}/commands (hemat 50% Read).
//  2. Throttle minimum polling di server (COMMANDS_MIN_POLL_SEC, default 15 dtk): polling berlebih dari EA
//     langsung dijawab 200 kosong tanpa menyentuh Firestore (hemat 66–80% Read). Bypass otomatis jika baru ada POST.
//  3. Circuit breaker & timeout 8 dtk: saat kuota Firestore habis, balas 503 cepat agar MT5 tidak hang (HTTP 1003).

const admin = require('firebase-admin');
const crypto = require('crypto');

const TOKEN = String(process.env.EA_WEBHOOK_SECRET || '').trim();
const PIN = String(process.env.DASHBOARD_PIN || '').trim();
const COMMAND_TTL_SEC = Number(process.env.COMMAND_TTL_SEC || 90);
const MIN_POLL_MS = Number(process.env.COMMANDS_MIN_POLL_SEC || 15) * 1000;
const CMD_TIMEOUT_MS = Number(process.env.COMMANDS_TIMEOUT_MS || 8000);
const CMD_BREAKER_MS = Number(process.env.COMMANDS_BREAKER_MS || 120000);

if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
}
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const ALLOWED_ACTIONS = [
  'close_all', 'close_buy', 'close_sell', 'close_profit', 'close_nearest', 'close_ticket',
  'ea_on', 'ea_off', 'sync_on', 'sync_off', 'open_order',
];
const WALLET_NETWORKS = ['usdt-trc20', 'usdt-erc20', 'usdt-bep20', 'btc'];

const lastPollAt = new Map();
const pendingHintAt = new Map();
let breakerUntil = 0;

const safeEq = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};

function verifyEaToken(req, bodyToken) {
  if (!TOKEN) return { ok: false, reason: 'missing_env_EA_WEBHOOK_SECRET' };

  const candidates = [];
  const push = (v) => {
    const s = String(v ?? '').trim();
    if (s) candidates.push(s);
  };

  if (bodyToken !== undefined) push(bodyToken);

  const q = req.query || {};
  push(q.token);
  push(q.secret);
  if (typeof q.token === 'string' && q.token.includes(' ')) push(q.token.replace(/ /g, '+'));

  const rawUrl = String(req.url || '');
  const mRaw = rawUrl.match(/[?&](?:token|secret)=([^#]*?)(?:&login=|$)/i);
  if (mRaw && mRaw[1]) {
    push(mRaw[1]);
    try { push(decodeURIComponent(mRaw[1])); } catch (e) {}
  }

  const h = req.headers || {};
  push(h['x-ea-token']);
  push(h['x-webhook-token']);
  push(h['x-token']);
  const auth = String(h.authorization || '');
  if (/^bearer\s+/i.test(auth)) push(auth.replace(/^bearer\s+/i, ''));

  if (!candidates.length) return { ok: false, reason: 'empty_token' };
  for (const c of candidates) {
    if (safeEq(c, TOKEN)) return { ok: true, reason: 'ok' };
  }
  return { ok: false, reason: 'token_mismatch' };
}

function parsePrice(raw, label) {
  const t = String(raw ?? '').trim().replace(',', '.');
  if (t === '') return 0;
  const v = Number(t);
  if (!Number.isFinite(v) || v < 0) throw new Error(`${label} tidak valid`);
  return v;
}

function buildParams(action, params) {
  const p = Array.isArray(params) ? params.map((x) => String(x ?? '').trim()) : [];
  if (action === 'open_order') {
    const dir = (p[0] || '').toLowerCase();
    const lot = Number((p[1] || '').replace(',', '.'));
    if (dir !== 'buy' && dir !== 'sell') throw new Error("arah harus 'buy' atau 'sell'");
    if (!(lot > 0 && lot <= 100)) throw new Error('lot tidak valid (0 - 100)');
    const sl = parsePrice(p[2], 'Stop Loss');
    const tp = parsePrice(p[3], 'Take Profit');
    return [dir, String(lot), String(sl), String(tp)];
  }
  if (action === 'close_ticket') {
    if (!/^\d{1,20}$/.test(p[0] || '')) throw new Error('ticket tidak valid');
    return [p[0]];
  }
  return [];
}

function cleanWallets(list) {
  if (!Array.isArray(list) || list.length > 12) throw new Error('daftar wallet tidak valid');
  return list.map((w) => {
    const network = String(w.network || '');
    const address = String(w.address || '').trim();
    const label = String(w.label || '').trim().slice(0, 60);
    if (!WALLET_NETWORKS.includes(network)) throw new Error('network wallet tidak dikenal');
    if (!label || address.length < 10 || address.length > 120 || /\s/.test(address)) throw new Error('label/alamat wallet tidak valid');
    return { id: String(w.id || 'w_' + Date.now()), label, network, address, apiKey: w.apiKey ? String(w.apiKey).trim().slice(0, 80) : null };
  });
}

function withTimeout(promise, ms) {
  let tm;
  const timeout = new Promise((_, rej) => {
    tm = setTimeout(() => rej(Object.assign(new Error('firestore_timeout'), { code: 'TIMEOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(tm));
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-EA-Token, X-Webhook-Token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const now = Date.now();
  if (now < breakerUntil) {
    const wait = Math.ceil((breakerUntil - now) / 1000);
    res.setHeader('Retry-After', String(wait));
    if (req.method === 'GET') return res.status(503).send('');
    return res.status(503).json({ ok: false, error: 'firestore_unavailable', retryAfterSec: wait });
  }

  try {
    // ============ GET: EA mengambil perintah pending (maks 1 Read per 15 dtk) ============
    if (req.method === 'GET') {
      const authRes = verifyEaToken(req);
      if (!authRes.ok) {
        res.setHeader('X-Auth-Reason', authRes.reason);
        return res.status(401).send(authRes.reason);
      }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');

      const accountId = String((req.query && (req.query.login || req.query.accountId)) || '').trim();
      if (!accountId) return res.status(200).send('');

      // Hemat Read: jika baru dicek < MIN_POLL_MS dan belum ada POST baru di instance ini, balas kosong (0 Read)
      const prevPoll = lastPollAt.get(accountId) || 0;
      const hintAt = pendingHintAt.get(accountId) || 0;
      if (MIN_POLL_MS > 0 && hintAt <= prevPoll && (now - prevPoll) < MIN_POLL_MS) {
        res.setHeader('X-Commands-Throttle', '1');
        return res.status(200).send('');
      }
      lastPollAt.set(accountId, now);

      // Langsung query subkoleksi commands (1 Read, bukan 2 Read!)
      const snap = await withTimeout(
        db.collection('accounts').doc(accountId).collection('commands')
          .where('status', '==', 'pending').limit(20).get(),
        CMD_TIMEOUT_MS
      );
      if (snap.empty) return res.status(200).send('');

      const rows = snap.docs
        .map((d) => ({ ref: d.ref, id: d.id, c: d.data() }))
        .map((r) => ({ ...r, t: r.c.createdAt?.toMillis ? r.c.createdAt.toMillis() : now }))
        .sort((a, b) => a.t - b.t);

      const batch = db.batch();
      const lines = [];
      for (const r of rows) {
        if (now - r.t > COMMAND_TTL_SEC * 1000) {
          batch.update(r.ref, { status: 'expired', message: `kedaluwarsa: EA tidak mengambil dalam ${COMMAND_TTL_SEC} detik`, executedAt: FieldValue.serverTimestamp() });
          continue;
        }
        if (!ALLOWED_ACTIONS.includes(r.c.action)) {
          batch.update(r.ref, { status: 'error', message: 'action tidak dikenal', executedAt: FieldValue.serverTimestamp() });
          continue;
        }
        batch.update(r.ref, { status: 'sent', sentAt: FieldValue.serverTimestamp() });
        const params = Array.isArray(r.c.params) ? r.c.params.join(';') : String(r.c.params || '');
        lines.push(`${r.id}|${r.c.action}|${params.replace(/[|\n\r]/g, ' ')}`);
      }
      await withTimeout(batch.commit(), CMD_TIMEOUT_MS);
      return res.status(200).send(lines.join('\n'));
    }

    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method not allowed' });

    const body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');

    // ============ POST (a): EA melapor hasil eksekusi ============
    if (body.commandId) {
      const authRes = verifyEaToken(req, body.token);
      if (!authRes.ok) {
        res.setHeader('X-Auth-Reason', authRes.reason);
        return res.status(401).json({ ok: false, error: authRes.reason });
      }
      const accountId = String(body.login || body.accountId || '').trim();
      if (!accountId) return res.status(200).json({ ok: true });
      await withTimeout(
        db.collection('accounts').doc(accountId).collection('commands').doc(String(body.commandId)).set(
          {
            status: body.status === 'error' ? 'error' : 'done',
            message: String(body.message || '').slice(0, 300),
            executedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        ),
        CMD_TIMEOUT_MS
      );
      return res.status(200).json({ ok: true });
    }

    // ============ POST (b): dashboard / admin ============
    const tokenOk = verifyEaToken(req, body.token).ok;
    const pinOk = PIN && safeEq(String(body.pin ?? '').trim(), PIN);
    if (!tokenOk && !pinOk) {
      return PIN
        ? res.status(401).json({ ok: false, error: 'PIN salah' })
        : res.status(500).json({ ok: false, error: 'DASHBOARD_PIN belum diset di Environment Variables Vercel' });
    }

    if (body.action === 'save_wallets') {
      const wallets = cleanWallets(body.wallets);
      await withTimeout(
        db.collection('payoutWallets').doc('config').set({ wallets, updatedAt: FieldValue.serverTimestamp() }, { merge: true }),
        CMD_TIMEOUT_MS
      );
      return res.status(200).json({ ok: true });
    }

    const { accountId, action } = body;
    if (!accountId || !action) return res.status(400).json({ ok: false, error: 'accountId dan action wajib diisi' });
    if (!ALLOWED_ACTIONS.includes(action)) return res.status(400).json({ ok: false, error: `action tidak dikenal: ${action}` });

    let params;
    try { params = buildParams(action, body.params); }
    catch (e) { return res.status(400).json({ ok: false, error: e.message }); }

    const accIdStr = String(accountId).trim();
    const accRef = db.collection('accounts').doc(accIdStr);
    const accSnap = await withTimeout(accRef.get(), CMD_TIMEOUT_MS);
    if (!accSnap.exists) return res.status(404).json({ ok: false, error: 'akun tidak ditemukan' });

    if (action === 'open_order') {
      const acc = accSnap.data() || {};
      const maxFlOn = acc.maxFloatingLossEnabled === true && Number(acc.maxFloatingLossPct || 0) > 0;
      if (maxFlOn && !(Number(params[2]) > 0)) {
        return res.status(400).json({ ok: false, error: 'Max Floating Loss aktif di EA: Stop Loss wajib diisi' });
      }
    }

    const ref = await withTimeout(
      accRef.collection('commands').add({
        action, params, status: 'pending', source: pinOk ? 'dashboard' : 'api', createdAt: FieldValue.serverTimestamp(),
      }),
      CMD_TIMEOUT_MS
    );
    pendingHintAt.set(accIdStr, Date.now());
    return res.status(200).json({ ok: true, commandId: ref.id });
  } catch (e) {
    console.error(e);
    if (e && (e.code === 8 || e.code === 'TIMEOUT' || /RESOURCE_EXHAUSTED|quota/i.test(String(e)))) {
      breakerUntil = Date.now() + CMD_BREAKER_MS;
      return req.method === 'GET'
        ? res.status(503).send('')
        : res.status(503).json({ ok: false, error: 'firestore_unavailable', retryAfterSec: Math.ceil(CMD_BREAKER_MS / 1000) });
    }
    return res.status(500).json({ ok: false, error: String(e) });
  }
};
