// api/webhook.js
// Menerima snapshot akun dari AccountMonitor_WebhookEA.mq5 (POST),
// menyimpannya ke JSONBin, lalu menyajikannya untuk dashboard (GET).
//
// Setup:
// 1. Buat bin baru di https://jsonbin.io -> catat Bin ID & Master Key
// 2. Deploy file ini sebagai /api/webhook.js di project Vercel
// 3. Set Environment Variables di Vercel:
//      JSONBIN_BIN_ID     = <bin id>
//      JSONBIN_API_KEY    = <master key>
//      EA_WEBHOOK_SECRET  = <token rahasia, harus sama dgn InpSecretToken di EA>
// 4. URL webhook yang dipakai EA: https://<project-anda>.vercel.app/api/webhook

const JSONBIN_ID   = process.env.JSONBIN_BIN_ID;
const JSONBIN_KEY  = process.env.JSONBIN_API_KEY;
const SHARED_TOKEN = process.env.EA_WEBHOOK_SECRET;

module.exports = async (req, res) => {
  // CORS supaya dashboard (browser) bisa fetch langsung dari file HTML
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // --- EA mengirim snapshot baru ---
  if (req.method === 'POST') {
    try {
      const body = req.body && typeof req.body === 'object'
        ? req.body
        : JSON.parse(req.body || '{}');

      if (!SHARED_TOKEN || body.token !== SHARED_TOKEN) {
        return res.status(401).json({ ok: false, error: 'invalid token' });
      }

      const payload = { ...body, receivedAt: new Date().toISOString() };
      delete payload.token; // jangan simpan token di data yang nanti dibaca dashboard

      const r = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_ID}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Master-Key': JSONBIN_KEY,
        },
        body: JSON.stringify(payload),
      });

      if (!r.ok) {
        const errText = await r.text();
        return res.status(502).json({ ok: false, error: 'jsonbin write failed', detail: errText });
      }

      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  }

  // --- Dashboard membaca snapshot terakhir ---
  if (req.method === 'GET') {
    try {
      const r = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_ID}/latest`, {
        headers: { 'X-Master-Key': JSONBIN_KEY },
      });
      if (!r.ok) return res.status(502).json({ ok: false, error: 'jsonbin read failed' });
      const data = await r.json();
      return res.status(200).json(data.record || {});
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  }

  return res.status(405).json({ ok: false, error: 'method not allowed' });
};
