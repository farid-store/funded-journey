// Proxy opsional untuk Vercel: menyembunyikan GROQ_API_KEY dari browser.
// Set environment variable GROQ_API_KEY di Vercel, lalu isi "Endpoint" di tab Setelan dengan /api/groq
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } });

  const key = process.env.GROQ_API_KEY;
  if (!key) return res.status(500).json({ error: { message: 'GROQ_API_KEY belum diset di Vercel.' } });

  try {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body
    });
    const text = await r.text();
    res.status(r.status).setHeader('Content-Type', 'application/json').send(text);
  } catch (e) {
    res.status(502).json({ error: { message: 'Proxy gagal: ' + e.message } });
  }
}
