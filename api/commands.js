// api/commands.js
// Antrian perintah SATU ARAH: Web App (dashboard-mu) -> EA MT5, plus EA
// melapor balik status eksekusinya. Disimpan di Firestore:
//   accounts/{accountId}/commands/{commandId}
//     { action, params: [...], status: 'pending'|'done'|'error',
//       message, createdAt, executedAt }
//
// KENAPA RESPON GET PLAIN TEXT (bukan JSON):
//   MQL5 tidak punya JSON parser bawaan. Supaya EA tidak perlu nulis
//   parser JSON sendiri, endpoint ini balas satu baris per command:
//     <commandId>|<action>|<param1;param2;...>
//   Kalau tidak ada command pending, balas string kosong.
//
// ACTION yang dikenali EA (FaridFX_FiboManager_EA.mq5):
//   close_all | close_buy | close_sell | close_profit | close_nearest
//   auto_on | auto_off
//   open_order   params: ["buy"|"sell", "<lot>"]   contoh: "buy;0.02"
//
// SETUP:
// 1. Env var sama dgn webhook.js: FIREBASE_SERVICE_ACCOUNT.
//    Token pakai env var yg SAMA dgn EA_WEBHOOK_SECRET (dipakai lagi
//    disini supaya tidak perlu secret baru) - EA mengirimnya sbg
//    InpWebhookSecret pd query/body request ke endpoint ini juga.
// 2. Deploy sbg /api/commands.js (project Vercel yg sama dgn webhook.js).
// 3. Di EA, isi InpCommandsURL = https://<project-anda>.vercel.app/api/commands
// 4. Dari dashboard/web app, POST ke endpoint ini dgn body:
//      { "token": "...", "accountId": "<id akun di Firestore>",
//        "action": "close_all", "params": [] }
//    utk membuat command baru yg akan diambil EA pd polling berikutnya
//    (default tiap 5 detik, lihat InpCommandPollIntervalSec di EA).

const admin = require('firebase-admin');

const TOKEN = process.env.EA_WEBHOOK_SECRET;

if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  }
}
const db = admin.firestore();

// Cari accountId Firestore dari nomor login MT5. Dicoba dua cara krn kita
// tidak tahu pasti skema doc-id yg dipakai AccountMonitor_WebhookEA-mu:
// 1) anggap doc-id == login (paling umum dipakai project ini)
// 2) kalau tidak ketemu, cari doc yg field "login"-nya cocok
async function resolveAccountId(login) {
  if (!login) return null;
  const direct = await db.collection('accounts').doc(String(login)).get();
  if (direct.exists) return direct.id;

  const q = await db.collection('accounts').where('login', '==', String(login)).limit(1).get();
  if (!q.empty) return q.docs[0].id;

  return null;
}

module.exports = async (req, res) => {
  try {
    // ================= GET: EA polling perintah pending =================
    if (req.method === 'GET') {
      const { token, login } = req.query;
      if (!TOKEN || token !== TOKEN) return res.status(401).send('');

      const accountId = await resolveAccountId(login);
      if (!accountId) return res.status(200).send('');

      const snap = await db
        .collection('accounts').doc(accountId)
        .collection('commands')
        .where('status', '==', 'pending')
        .orderBy('createdAt', 'asc')
        .limit(20)
        .get();

      const lines = snap.docs.map((d) => {
        const c = d.data();
        const params = Array.isArray(c.params) ? c.params.join(';') : (c.params || '');
        return `${d.id}|${c.action}|${params}`;
      });

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(lines.join('\n'));
    }

    // ================= POST: buat command baru ATAU EA lapor hasil =================
    if (req.method === 'POST') {
      const body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
      if (!TOKEN || body.token !== TOKEN) return res.status(401).json({ ok: false, error: 'invalid token' });

      // --- (a) EA melapor command sudah dieksekusi (ada commandId) ---
      if (body.commandId) {
        const { login, accountId: bodyAccountId, commandId, status, message } = body;
        const accountId = (await resolveAccountId(login)) || bodyAccountId;
        if (!accountId) return res.status(200).json({ ok: true }); // tidak ketemu akunnya, abaikan diam2

        await db
          .collection('accounts').doc(accountId)
          .collection('commands').doc(commandId)
          .set(
            {
              status: status || 'done',
              message: message || '',
              executedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        return res.status(200).json({ ok: true });
      }

      // --- (b) Web app membuat command baru utk EA ---
      const { accountId, action, params } = body;
      if (!accountId || !action) {
        return res.status(400).json({ ok: false, error: 'accountId dan action wajib diisi' });
      }

      const ALLOWED_ACTIONS = [
        'close_all', 'close_buy', 'close_sell', 'close_profit', 'close_nearest', 'close_ticket',
        'auto_on', 'auto_off', 'open_order',
      ];
      if (!ALLOWED_ACTIONS.includes(action)) {
        return res.status(400).json({ ok: false, error: `action tidak dikenal: ${action}` });
      }

      const ref = await db
        .collection('accounts').doc(accountId)
        .collection('commands')
        .add({
          action,
          params: Array.isArray(params) ? params : [],
          status: 'pending',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

      return res.status(200).json({ ok: true, commandId: ref.id });
    }

    return res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
};
