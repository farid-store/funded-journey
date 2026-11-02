// Vercel serverless proxy untuk Match-Trader Trader API.
// Env wajib di Vercel: MT_TOKEN (token Trader API) dan MT_ADMIN_KEY (password panel, bebas, panjang).
// Token TIDAK pernah dikirim ke browser. Jika package.json Anda "type":"module", ganti baris module.exports jadi: export default async (req,res)=>{...}
const crypto = require('crypto');
const OK = /^\/v1\/(positions(\/[\w-]+\/close)?|account|account-summary|quotes|symbols)(\?[\w=&%.,-]*)?$/;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const key = process.env.MT_ADMIN_KEY || '', tok = process.env.MT_TOKEN || '';
  if (!key || !tok) return res.status(500).json({ title: 'MT_ADMIN_KEY / MT_TOKEN belum di-set di Vercel' });
  const a = Buffer.from(String(req.headers['x-admin-key'] || '')), b = Buffer.from(key);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ title: 'Admin key salah' });
  const p = String(req.query.p || '');
  if (!OK.test(p)) return res.status(400).json({ title: 'Path tidak diizinkan' });
  const m = req.method;
  if (m !== 'GET' && m !== 'POST') return res.status(405).json({ title: 'Method tidak diizinkan' });

  const h = { Authorization: 'Bearer ' + tok, Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; FaridFX-Panel/1.0)' };
  let body;
  if (m === 'POST') {
    h['Content-Type'] = 'application/json';
    body = JSON.stringify(req.body || {});
    if (req.headers['idempotency-key']) h['Idempotency-Key'] = req.headers['idempotency-key'];
  }
  try {
    const r = await fetch('https://trader-api.match-trader.com' + p, { method: m, headers: h, body });
    ['x-ratelimit-remaining-endpoint', 'x-ratelimit-remaining-global', 'retry-after', 'idempotent-replayed'].forEach(k => {
      const v = r.headers.get(k); if (v) res.setHeader(k, v);
    });
    res.setHeader('x-mt-proxy', '1');
    const d = r.headers.get('date'); if (d) res.setHeader('x-upstream-date', d);
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
    res.status(r.status).send(await r.text());
  } catch (e) {
    res.status(502).json({ title: 'Upstream error', detail: String(e.message) });
  }
};
