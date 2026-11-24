// api/commands.js  (v4)
// Antrian perintah Dashboard -> EA MT5.  accounts/{id}/commands/{commandId}
//   { action, params[], status: pending | sent | done | error | expired, message, createdAt, sentAt, executedAt }
//
// PERBAIKAN v4 (Fix HTTP 401 RemoteControl polling):
//  - Trim otomatis pada env EA_WEBHOOK_SECRET & DASHBOARD_PIN (cegah spasi/newline saat copy-paste di Vercel).
//  - Terima token dari query (?token= / ?secret=), Header (X-EA-Token / Authorization: Bearer),
//    serta pulihkan tanda '+' yang berubah jadi spasi bila EA tidak meng-URL-encode query string.
//  - Header diagnosa X-Auth-Reason (missing_env | empty_token | token_mismatch) agar debugging instan.

const admin = require('firebase-admin');
const crypto = require('crypto');

const TOKEN = String(process.env.EA_WEBHOOK_SECRET || '').trim();
const PIN = String(process.env.DASHBOARD_PIN || '').trim();
const COMMAND_TTL_SEC = Number(process.env.COMMAND_TTL_SEC || 90);

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

const safeEq = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Cek token EA secara toleran terhadap karakter '+' pada query string tanpa menurunkan keamanan.
function verifyEaToken(req, bodyToken) {
  if (!TOKEN) return { ok: false, reason: 'missing_env_EA_WEBHOOK_SECRET' };

  const candidates = [];
  const push = (v) => {
    const s = String(v ?? '').trim();
    if (s) candidates.push(s);
  };

  // 1. Dari body POST
  if (bodyToken !== undefined) push(bodyToken);

  // 2. Dari query string
  const q = req.query || {};
  push(q.token);
  push(q.secret);
  if (typeof q.token === 'string' && q.token.includes(' ')) {
    // Query parser mengubah '+' yang tidak di-encode menjadi spasi
    push(q.token.replace(/ /g, '+'));
  }

  // 3. Dari raw URL (pulihkan kasus token mengandung '+' atau '&' sebelum '&login=')
  const rawUrl = String(req.url || '');
  const mRaw = rawUrl.match(/[?&](?:token|secret)=([^#]*?)(?:&login=|$)/i);
  if (mRaw && mRaw[1]) {
    push(mRaw[1]);
    try { push(decodeURIComponent(mRaw[1])); } catch (e) {}
  }

  // 4. Dari HTTP headers
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

async function resolveAccountId(login) {
  if (!login) return null;
  const direct = await db.collection('accounts').doc(String(login)).get();
  if (direct.exists) return direct.id;
  const q = await db.collection('accounts').where('login', '==', String(login)).limit(1).get();
  return q.empty ? null : q.docs[0].id;
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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-EA-Token, X-Webhook-Token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ============ GET: EA mengambil perintah pending ============
    if (req.method === 'GET') {
      const authRes = verifyEaToken(req);
      if (!authRes.ok) {
        res.setHeader('X-Auth-Reason', authRes.reason);
        return res.status(401).send(authRes.reason);
      }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');

      const login = (req.query && (req.query.login || req.query.accountId)) || '';
      const accountId = await resolveAccountId(login);
      if (!accountId) return res.status(200).send('');

      const snap = await db.collection('accounts').doc(accountId).collection('commands')
        .where('status', '==', 'pending').limit(50).get();
      if (snap.empty) return res.status(200).send('');

      const now = Date.now();
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
      await batch.commit();
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
      const accountId = (await resolveAccountId(body.login)) || body.accountId;
      if (!accountId) return res.status(200).json({ ok: true });
      await db.collection('accounts').doc(accountId).collection('commands').doc(String(body.commandId)).set(
        {
          status: body.status === 'error' ? 'error' : 'done',
          message: String(body.message || '').slice(0, 300),
          executedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
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
      await db.collection('payoutWallets').doc('config').set({ wallets, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return res.status(200).json({ ok: true });
    }

    const { accountId, action } = body;
    if (!accountId || !action) return res.status(400).json({ ok: false, error: 'accountId dan action wajib diisi' });
    if (!ALLOWED_ACTIONS.includes(action)) return res.status(400).json({ ok: false, error: `action tidak dikenal: ${action}` });

    let params;
    try { params = buildParams(action, body.params); }
    catch (e) { return res.status(400).json({ ok: false, error: e.message }); }

    const accRef = db.collection('accounts').doc(String(accountId));
    const accSnap = await accRef.get();
    if (!accSnap.exists) return res.status(404).json({ ok: false, error: 'akun tidak ditemukan' });

    if (action === 'open_order') {
      const acc = accSnap.data() || {};
      const maxFlOn = acc.maxFloatingLossEnabled === true && Number(acc.maxFloatingLossPct || 0) > 0;
      if (maxFlOn && !(Number(params[2]) > 0)) {
        return res.status(400).json({ ok: false, error: 'Max Floating Loss aktif di EA: Stop Loss wajib diisi' });
      }
    }

    const ref = await accRef.collection('commands').add({
      action, params, status: 'pending', source: pinOk ? 'dashboard' : 'api', createdAt: FieldValue.serverTimestamp(),
    });
    return res.status(200).json({ ok: true, commandId: ref.id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
};
