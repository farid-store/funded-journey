// Vercel Serverless Function: POST /api/gemini
// Configure GEMINI_API_KEY in Vercel Project Settings > Environment Variables.

function normalizePart(part) {
  if (!part || typeof part !== 'object') return part;
  const out = { ...part };
  if (out.inlineData) {
    out.inline_data = {
      data: out.inlineData.data,
      mime_type: out.inlineData.mimeType || out.inlineData.mime_type || 'application/octet-stream'
    };
    delete out.inlineData;
  }
  if (out.fileData) {
    out.file_data = {
      file_uri: out.fileData.fileUri || out.fileData.file_uri,
      mime_type: out.fileData.mimeType || out.fileData.mime_type
    };
    delete out.fileData;
  }
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed. Gunakan POST.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY belum disetel di Environment Variables Vercel.' });
  }

  try {
    const body = req.body || {};
    if (!Array.isArray(body.contents) || body.contents.length === 0) {
      return res.status(400).json({ error: 'Payload contents kosong atau tidak valid.' });
    }

    // Allow only expected chat roles/parts and keep request bounded.
    const contents = body.contents.slice(-18).map(item => ({
      role: item && item.role === 'model' ? 'model' : 'user',
      parts: Array.isArray(item && item.parts) ? item.parts.slice(0, 12).map(normalizePart) : []
    })).filter(item => item.parts.length);
    if (!contents.length) return res.status(400).json({ error: 'Tidak ada part pesan yang valid.' });

    const requestedModel = String(body.model || 'gemini-2.5-flash');
    const model = /^gemini-[a-zA-Z0-9.-]+$/.test(requestedModel) ? requestedModel : 'gemini-2.5-flash';
    const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        generationConfig: { temperature: 0.35, maxOutputTokens: 1800 }
      })
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const message = data?.error?.message || `Gemini API mengembalikan HTTP ${upstream.status}`;
      return res.status(upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502).json({ error: message });
    }
    return res.status(200).json(data);
  } catch (err) {
    console.error('[api/gemini] error:', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'Terjadi kesalahan internal pada endpoint AI.' });
  }
};
