// api/commands.js  (v2)
// Antrian perintah Dashboard -> EA MT5.  accounts/{id}/commands/{commandId}
//   { action, params[], status: pending | sent | done | error | expired, message, createdAt, sentAt, executedAt }
//
// ALUR
//   Dashboard --POST {pin, accountId, action, params}--> endpoint ini --> Firestore (pending)
//   EA --GET ?token&login (tiap ~5 dtk)--> baris "id|action|p1;p2"  (status jadi "sent")
//   EA --POST {token, login, commandId, status, message}--> status akhir (done/error)
//
// YANG DIPERBAIKI
//  1. GET tidak lagi memakai where()+orderBy() -> TIDAK butuh composite index Firestore
//     (penyebab utama tab Control "tidak berfungsi": query error -> HTTP 500 -> EA backoff).
//  2. Daftar action disamakan dengan EA: ea_on, ea_off, sync_on, sync_off (dulu auto_on/auto_off).
//  3. Perintah yang tidak diambil EA dalam COMMAND_TTL_SEC (default 90 dtk) otomatis "expired"
//     -> tidak ada lagi "Close All" lama yang tiba-tiba tereksekusi saat EA nyala kembali.
//  4. At-most-once: begitu dikirim ke EA statusnya "sent", tidak terkirim dua kali.
//  5. Dashboard membuat perintah lewat endpoint ini dengan PIN (DASHBOARD_PIN), bukan menulis
//     langsung ke Firestore -> member dashboard tidak bisa menutup posisimu.
//  6. Validasi parameter open_order / close_ticket. Pesan error jelas utk dashboard.
//  7. Aksi admin "save_wallets" (kelola wallet payout) juga lewat PIN.
//
// ENV VERCEL: FIREBASE_SERVICE_ACCOUNT, EA_WEBHOOK_SECRET, DASHBOARD_PIN (WAJIB, buat sendiri),
//             COMMAND_TTL_SEC (opsional)

const admin = require('firebase-admin');
const crypto = require('crypto');

const TOKEN = process.env.EA_WEBHOOK_SECRET;
const PIN = process.env.DASHBOARD_PIN;
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

async function resolveAccountId(login) {
  if (!login) return null;
  const direct = await db.collection('accounts').doc(String(login)).get();
  if (direct.exists) return direct.id;
  const q = await db.collection('accounts').where('login', '==', String(login)).limit(1).get();
  return q.empty ? null : q.docs[0].id;
}

function buildParams(action, params) {
  const p = Array.isArray(params) ? params.map((x) => String(x ?? '').trim()) : [];
  if (action === 'open_order') {
    const dir = (p[0] || '').toLowerCase();
    const lot = Number(p[1]);
    if (dir !== 'buy' && dir !== 'sell') throw new Error("arah harus 'buy' atau 'sell'");
    if (!(lot > 0 && lot <= 100)) throw new Error('lot tidak valid (0 - 100)');
    return [dir, String(lot)];
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ============ GET: EA mengambil perintah pending ============
    if (req.method === 'GET') {
      const { token, login } = req.query;
      if (!TOKEN || !safeEq(token, TOKEN)) return res.status(401).send('');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');

      const accountId = await resolveAccountId(login);
      if (!accountId) return res.status(200).send('');

      // hanya filter 1 field -> pakai index otomatis Firestore, urutkan di memori
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
      if (!TOKEN || !safeEq(body.token, TOKEN)) return res.status(401).json({ ok: false, error: 'invalid token' });
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
    const tokenOk = TOKEN && safeEq(body.token, TOKEN);
    const pinOk = PIN && safeEq(body.pin, PIN);
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
    if (!(await accRef.get()).exists) return res.status(404).json({ ok: false, error: 'akun tidak ditemukan' });

    const ref = await accRef.collection('commands').add({
      action, params, status: 'pending', source: pinOk ? 'dashboard' : 'api', createdAt: FieldValue.serverTimestamp(),
    });
    return res.status(200).json({ ok: true, commandId: ref.id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
};
