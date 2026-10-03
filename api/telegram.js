// api/telegram.js  (v2)
// Command read-only Telegram: /status /pnl /balance /positions /orders /history /risk
// /exposure /drawdown /session /accounts /ping /help
//
// YANG DIPERBAIKI
//  1. Angka daily/overall loss, profit, sesi diambil dari field EA (dailyLossPct, overallLossPct,
//     dailyRoomMoney, profitPct, sessionNow) -> sama persis dengan dashboard & dashboard EA.
//  2. "Hari ini" memakai hari SERVER (serverDay), bukan UTC.
//  3. Win rate dihitung dari history tersimpan, bukan dari stats 3 hari.
//  4. Label akun / simbol di-escape (underscore tidak lagi bikin pesan gagal terkirim) +
//     fallback kirim teks polos kalau Telegram menolak Markdown.
//  5. Posisi menampilkan SL/TP & waktu open, history menampilkan waktu close (UTC).
//
// ENV VERCEL: FIREBASE_SERVICE_ACCOUNT, TELEGRAM_BOT_TOKEN
// Webhook Telegram: https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<project>.vercel.app/api/telegram

const admin = require('firebase-admin');

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
}
const db = admin.firestore();

// ---------------------------------------------------------------- util
const mdEsc = (s) => String(s ?? '').replace(/([_*`\[])/g, '\\$1');
const fmt = (n, d = 2) => Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (n) => { const v = Number(n || 0); return (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
const pct = (n) => fmt(n, 1) + '%';
const ymd = (d) => d.toISOString().slice(0, 10);
const hhmm = (sec) => (sec ? new Date(Number(sec) * 1000).toISOString().slice(5, 16).replace('T', ' ') + ' UTC' : '-');
const todayOf = (acc) => acc.serverDay || ymd(new Date());

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

async function reply(chatId, text) {
  if (!TG_TOKEN) return;
  let j = await tgCall('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true });
  if (j && !j.ok && /parse entities/i.test(j.description || '')) {
    await tgCall('sendMessage', { chat_id: chatId, text: text.replace(/[*_`\\]/g, ''), disable_web_page_preview: true });
  }
}

async function deleteMessage(chatId, messageId) {
  if (!TG_TOKEN) return;
  const j = await tgCall('deleteMessage', { chat_id: chatId, message_id: messageId });
  if (j && !j.ok) console.error('deleteMessage gagal (bot butuh izin "Delete Messages"):', j.description);
}

// ---------------------------------------------------------------- data
async function getAccounts() {
  const snap = await db.collection('accounts').get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function resolveAccount(accounts, arg) {
  if (!accounts.length) return null;
  if (!arg) return accounts.length === 1 ? accounts[0] : null;
  const low = arg.toLowerCase();
  return accounts.find((a) => a.id === arg || (a.accountLabel || '').toLowerCase().includes(low)) || null;
}

function needAccountHint(accounts) {
  const list = accounts.map((a) => `• \`${mdEsc(a.accountLabel || a.id)}\``).join('\n');
  return `Ada beberapa akun terhubung, sebutkan nama akunnya, contoh: \`/pnl ${mdEsc(accounts[0].accountLabel || accounts[0].id)}\`\n\nAkun tersedia:\n${list}`;
}

// pemakaian limit (%) -> pakai angka EA kalau ada
function usage(acc) {
  const dLim = Number(acc.dailyLossLimitPct || 5);
  const oLim = Number(acc.overallLossLimitPct || 10);
  const equity = Number(acc.equity || 0);
  const start = Number(acc.startingBalance || acc.balance || 1);
  const dayStart = Number(acc.dayStartBalance || acc.balance || 1);
  const dPct = acc.dailyLossPct != null ? Number(acc.dailyLossPct) : (Math.max(0, dayStart - equity) / dayStart) * 100;
  const oPct = acc.overallLossPct != null ? Number(acc.overallLossPct) : (Math.max(0, start - equity) / start) * 100;
  return {
    dLim, oLim, dPct, oPct,
    dUse: dLim > 0 ? (dPct / dLim) * 100 : 0,
    oUse: oLim > 0 ? (oPct / oLim) * 100 : 0,
    dRoom: acc.dailyRoomMoney, oRoom: acc.overallRoomMoney,
  };
}

async function todayPnl(acc) {
  const doc = await db.collection('accounts').doc(acc.id).collection('dailyPnl').doc(todayOf(acc)).get();
  const realized = doc.exists ? Number(doc.data().pnl || 0) : 0;
  return { realized, total: realized + Number(acc.floatingProfit || 0) };
}

const marginTxt = (acc) => (Number(acc.margin || 0) > 0 && acc.marginLevel != null ? pct(acc.marginLevel) : '— (tidak ada posisi)');

function sessionInfo() {
  const h = new Date().getUTCHours();
  const sessions = [
    { name: 'Sydney/Tokyo', from: 0, to: 8 },
    { name: 'London', from: 8, to: 16 },
    { name: 'London/NY Overlap', from: 13, to: 16 },
    { name: 'New York', from: 13, to: 21 },
  ];
  const active = sessions.filter((s) => h >= s.from && h < s.to).map((s) => s.name);
  return active.length ? active.join(' + ') : 'Quiet hours';
}

const HELP_TEXT =
  '*FaridFX Bot — Commands*\n\n' +
  '/status `[akun]` — ringkasan cepat: equity, PnL hari ini, risk usage, margin\n' +
  '/pnl `[akun]` — profit/loss hari ini & all-time\n' +
  '/balance `[akun]` — balance, equity, margin\n' +
  '/positions `[akun]` — posisi terbuka\n' +
  '/orders `[akun]` — pending order\n' +
  '/history `[akun] [jumlah]` — transaksi terakhir (default 5)\n' +
  '/risk `[akun]` — status daily/overall loss limit & margin\n' +
  '/exposure `[akun]` — exposure per pair\n' +
  '/drawdown `[akun]` — current & max drawdown\n' +
  '/session — sesi trading aktif\n' +
  '/accounts — daftar akun terhubung\n' +
  '/ping — cek bot\n' +
  '/help — pesan ini\n\n' +
  '_`[akun]` opsional kalau hanya ada 1 akun._';

// ---------------------------------------------------------------- command
async function handleCommand(cmd, args, chatId) {
  if (cmd === '/start' || cmd === '/help') return reply(chatId, HELP_TEXT);
  if (cmd === '/ping') return reply(chatId, '🏓 Pong — bot aktif.');
  if (cmd === '/session') return reply(chatId, `🕒 Sesi aktif sekarang: *${sessionInfo()}* (UTC)`);

  const accounts = await getAccounts();

  if (cmd === '/accounts') {
    if (!accounts.length) return reply(chatId, 'Belum ada akun terhubung.');
    const now = Date.now();
    const lines = accounts.map((a) => {
      const age = a.updatedAt?.toMillis ? (now - a.updatedAt.toMillis()) / 1000 : Infinity;
      const status = age <= 45 ? '🟢 Live' : age <= 120 ? '🟡 Stale' : '🔴 Offline';
      return `*${mdEsc(a.accountLabel || a.id)}* (\`${a.id}\`)\nEquity: ${money(a.equity)} · ${status}`;
    });
    return reply(chatId, lines.join('\n\n'));
  }

  const acc = resolveAccount(accounts, args[0]);
  if (!acc) return reply(chatId, accounts.length ? needAccountHint(accounts) : 'Belum ada akun terhubung.');
  const name = mdEsc(acc.accountLabel || acc.id);

  if (cmd === '/balance') {
    return reply(chatId,
      `💰 *${name}*\n` +
      `Balance: \`${money(acc.balance)}\`\n` +
      `Equity: \`${money(acc.equity)}\`\n` +
      `Floating: \`${money(acc.floatingProfit)}\`\n` +
      `Free Margin: \`${money(acc.marginFree)}\`\n` +
      `Margin Level: \`${marginTxt(acc)}\``);
  }

  if (cmd === '/pnl') {
    const t = await todayPnl(acc);
    const allTime = Number(acc.equity || 0) - Number(acc.startingBalance || acc.balance || 0);
    const hs = await db.collection('accounts').doc(acc.id).collection('history').orderBy('closeTime', 'desc').limit(500).get();
    let w = 0;
    hs.forEach((d) => { if (Number(d.data().netProfit) > 0) w++; });
    const wr = hs.size ? (w / hs.size) * 100 : null;
    return reply(chatId,
      `📊 *${name}* — PnL\n` +
      `Hari ini: \`${money(t.total)}\` (realized ${money(t.realized)} + floating ${money(acc.floatingProfit)})\n` +
      `All-time: \`${money(allTime)}\`\n` +
      `Win rate (${hs.size} trade terakhir): \`${wr != null ? pct(wr) : '—'}\``);
  }

  if (cmd === '/positions' || cmd === '/position') {
    const p = acc.positions || [];
    if (!p.length) return reply(chatId, `*${name}* — tidak ada posisi terbuka.`);
    const lines = p.map((x) =>
      `${String(x.type).includes('buy') ? '🟢' : '🔴'} *${mdEsc(x.symbol)}* \`${fmt(x.volume, 2)}\` lot @ ${x.priceOpen}\n   SL ${x.sl || '-'} · TP ${x.tp || '-'} · P/L ${money(x.profit)} · open ${hhmm(x.openTime)}`);
    return reply(chatId, `📈 *${name}* — ${p.length} posisi terbuka\n\n${lines.join('\n')}`);
  }

  if (cmd === '/orders' || cmd === '/order') {
    const o = acc.pendingOrders || [];
    if (!o.length) return reply(chatId, `*${name}* — tidak ada pending order.`);
    const lines = o.map((x) => `${mdEsc(String(x.type).replaceAll('_', ' '))} *${mdEsc(x.symbol)}* \`${fmt(x.volume, 2)}\` lot @ ${x.price}`);
    return reply(chatId, `📋 *${name}* — ${o.length} pending order\n\n${lines.join('\n')}`);
  }

  if (cmd === '/history') {
    const n = Math.min(20, Math.max(1, parseInt(args[1], 10) || 5));
    const snap = await db.collection('accounts').doc(acc.id).collection('history').orderBy('closeTime', 'desc').limit(n).get();
    if (snap.empty) return reply(chatId, `*${name}* — belum ada history.`);
    const lines = snap.docs.map((d) => {
      const t = d.data();
      return `${Number(t.netProfit) >= 0 ? '✅' : '❌'} *${mdEsc(t.symbol)}* ${String(t.type).toUpperCase()} \`${fmt(t.volume, 2)}\` lot → ${money(t.netProfit)}\n   ${hhmm(t.openTime)} → ${hhmm(t.closeTime)}`;
    });
    return reply(chatId, `🕘 *${name}* — ${n} transaksi terakhir\n\n${lines.join('\n')}`);
  }

  if (cmd === '/risk') {
    const u = usage(acc);
    return reply(chatId,
      `🛡️ *${name}* — Risk Status\n` +
      `Daily: \`${fmt(u.dPct)}%\` dari limit ${fmt(u.dLim, 1)}% (${pct(u.dUse)} terpakai${u.dRoom != null ? `, sisa ${money(u.dRoom)}` : ''})\n` +
      `Overall: \`${fmt(u.oPct)}%\` dari limit ${fmt(u.oLim, 1)}% (${pct(u.oUse)} terpakai${u.oRoom != null ? `, sisa ${money(u.oRoom)}` : ''})\n` +
      `Margin Level: \`${marginTxt(acc)}\`` +
      (acc.lockout ? '\n🔒 *LOCKOUT aktif*' : acc.lossGuardTriggered ? '\n⚠️ Loss guard terpicu' : ''));
  }

  if (cmd === '/exposure') {
    const exp = acc.exposure || [];
    if (!exp.length) return reply(chatId, `*${name}* — tidak ada exposure aktif.`);
    const eq = Number(acc.equity || 1);
    const lines = exp.map((x) => `*${mdEsc(x.symbol)}*: \`${fmt(x.volume, 2)}\` lot (${x.count}x) · ${pct((x.notional / eq) * 100)} of equity · P/L ${money(x.profit)}`);
    return reply(chatId, `📐 *${name}* — Exposure per Pair\n\n${lines.join('\n')}`);
  }

  if (cmd === '/drawdown') {
    const snap = await db.collection('accounts').doc(acc.id).collection('dailyPnl').orderBy('date', 'asc').get();
    let cum = Number(acc.startingBalance || acc.balance || 0), peak = -Infinity, maxDD = 0, curDD = 0, days = 0;
    snap.forEach((d) => {
      cum += Number(d.data().pnl || 0);
      peak = Math.max(peak, cum);
      curDD = peak > 0 ? ((peak - cum) / peak) * 100 : 0;
      maxDD = Math.max(maxDD, curDD);
      days++;
    });
    if (!days) return reply(chatId, `*${name}* — belum cukup data harian utk drawdown.`);
    return reply(chatId, `📉 *${name}* — Drawdown\nCurrent: \`${pct(curDD)}\`\nMax: \`${pct(maxDD)}\`\nHari tercatat: \`${days}\``);
  }

  if (cmd === '/status') {
    const t = await todayPnl(acc);
    const u = usage(acc);
    return reply(chatId,
      `⚡ *${name}* — Quick Status\n` +
      `Equity: \`${money(acc.equity)}\` (${t.total >= 0 ? '+' : ''}${money(t.total)} hari ini)\n` +
      `Posisi terbuka: \`${(acc.positions || []).length}\`\n` +
      `Daily limit: \`${pct(u.dUse)}\` · Overall limit: \`${pct(u.oUse)}\`\n` +
      `Margin Level: \`${marginTxt(acc)}\`\n` +
      `EA: ${acc.eaEnabled === false ? '⏸ dipause' : '▶ aktif'}${acc.lockout ? ' · 🔒 lockout' : ''}\n` +
      `${mdEsc(acc.sessionNow || 'Sesi: ' + sessionInfo())}`);
  }

  return reply(chatId, 'Command tidak dikenal. Ketik /help untuk daftar command.');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });
  try {
    const update = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const msg = update.message || update.channel_post;
    if (!msg || !msg.text || !msg.text.startsWith('/')) return res.status(200).json({ ok: true });

    const [rawCmd, ...args] = msg.text.trim().split(/\s+/);
    const cmd = rawCmd.split('@')[0].toLowerCase();

    await handleCommand(cmd, args, msg.chat.id);

    if (['group', 'supergroup', 'channel'].includes(msg.chat.type)) {
      await deleteMessage(msg.chat.id, msg.message_id);
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ ok: true }); // selalu 200 ke Telegram supaya tidak retry
  }
};
