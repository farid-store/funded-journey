// api/telegram.js
// Menerima update dari Telegram (lewat setWebhook) dan membalas command
// read-only: /pnl /balance /positions /orders /history /risk /accounts /help
// Aman dipakai di grup komunitas — tidak ada command di sini yang bisa
// mengubah apa pun di MT5 (hanya baca dari Firestore).
//
// SETUP:
// 1. Env var yang sama dgn webhook.js: FIREBASE_SERVICE_ACCOUNT, TELEGRAM_BOT_TOKEN.
// 2. Deploy sebagai /api/telegram.js (satu project Vercel yang sama dgn webhook.js).
// 3. Daftarkan sebagai webhook Telegram (jalankan sekali di browser / curl):
//      https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<project-anda>.vercel.app/api/telegram
// 4. (Opsional) Chat @BotFather -> /setcommands -> pilih bot -> tempel:
//      pnl - Ringkasan profit/loss hari ini & all-time
//      balance - Balance, equity, margin akun
//      positions - Posisi yang sedang terbuka
//      orders - Pending order aktif
//      history - Riwayat transaksi terakhir
//      risk - Status daily/overall loss limit & margin
//      accounts - Daftar semua akun yang terhubung
//      help - Daftar command
// 5. Undang bot ke grup komunitas. PENTING: chat @BotFather -> /setprivacy -> pilih
//    bot -> Disable, supaya bot bisa membaca command di grup (default Telegram
//    menyembunyikan pesan grup dari bot kecuali privacy mode dimatikan).

const admin = require('firebase-admin');

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  }
}
const db = admin.firestore();

async function reply(chatId, text) {
  if (!TG_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
  }).catch((e) => console.error('reply failed', e));
}

const fmt = (n, d = 2) => Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (n) => { const v = Number(n || 0); return (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
const pct = (n) => fmt(n, 1) + '%';
const ymd = (d) => d.toISOString().slice(0, 10);

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
  const list = accounts.map((a) => `• \`${a.accountLabel || a.id}\``).join('\n');
  return `Ada beberapa akun terhubung, sebutkan nama akunnya, contoh: \`/pnl ${accounts[0].accountLabel || accounts[0].id}\`\n\nAkun tersedia:\n${list}`;
}

const HELP_TEXT =
  '*FaridFX Bot — Commands*\n\n' +
  '/status `[akun]` — ringkasan cepat: equity, PnL hari ini, risk usage, margin\n' +
  '/pnl `[akun]` — ringkasan profit/loss hari ini & all-time\n' +
  '/balance `[akun]` — balance, equity, margin\n' +
  '/positions `[akun]` — posisi terbuka\n' +
  '/orders `[akun]` — pending order\n' +
  '/history `[akun] [jumlah]` — riwayat transaksi terakhir (default 5)\n' +
  '/risk `[akun]` — status daily/overall loss limit & margin level\n' +
  '/exposure `[akun]` — exposure per pair dari posisi terbuka\n' +
  '/drawdown `[akun]` — current & max drawdown dari kurva balance harian\n' +
  '/session — sesi trading yang sedang aktif (UTC)\n' +
  '/accounts — daftar semua akun terhubung\n' +
  '/ping — cek bot masih hidup\n' +
  '/help — tampilkan pesan ini\n\n' +
  '_`[akun]` opsional kalau cuma ada 1 akun terhubung._';

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

async function handleCommand(cmd, args, chatId) {
  const accounts = await getAccounts();

  if (cmd === '/start' || cmd === '/help') return reply(chatId, HELP_TEXT);
  if (cmd === '/ping') return reply(chatId, '🏓 Pong — bot aktif.');
  if (cmd === '/session') return reply(chatId, `🕒 Sesi aktif sekarang: *${sessionInfo()}* (UTC)`);

  if (cmd === '/accounts') {
    if (!accounts.length) return reply(chatId, 'Belum ada akun terhubung.');
    const now = Date.now();
    const lines = accounts.map((a) => {
      const age = a.updatedAt?.toMillis ? (now - a.updatedAt.toMillis()) / 1000 : Infinity;
      const status = age <= 20 ? '🟢 Live' : age <= 90 ? '🟡 Stale' : '🔴 Offline';
      return `*${a.accountLabel || a.id}* (\`${a.id}\`)\nEquity: ${money(a.equity)} · ${status}`;
    });
    return reply(chatId, lines.join('\n\n'));
  }

  const acc = resolveAccount(accounts, args[0]);
  if (!acc) return reply(chatId, accounts.length ? needAccountHint(accounts) : 'Belum ada akun terhubung.');

  if (cmd === '/balance') {
    return reply(
      chatId,
      `💰 *${acc.accountLabel}*\n` +
        `Balance: \`${money(acc.balance)}\`\n` +
        `Equity: \`${money(acc.equity)}\`\n` +
        `Floating: \`${money(acc.floatingProfit)}\`\n` +
        `Free Margin: \`${money(acc.marginFree)}\`\n` +
        `Margin Level: \`${acc.marginLevel != null ? pct(acc.marginLevel) : '—'}\``
    );
  }

  if (cmd === '/pnl') {
    const todayStr = ymd(new Date());
    const todayDoc = await db.collection('accounts').doc(acc.id).collection('dailyPnl').doc(todayStr).get();
    const todayRealized = todayDoc.exists ? Number(todayDoc.data().pnl || 0) : 0;
    const todayTotal = todayRealized + Number(acc.floatingProfit || 0);
    const allTime = Number(acc.equity || 0) - Number(acc.startingBalance || acc.balance || 0);
    return reply(
      chatId,
      `📊 *${acc.accountLabel}* — PnL\n` +
        `Hari ini: \`${money(todayTotal)}\` (realized ${money(todayRealized)} + floating ${money(acc.floatingProfit)})\n` +
        `All-time: \`${money(allTime)}\`\n` +
        `Win rate (periode EA): \`${acc.stats?.winRate != null ? pct(acc.stats.winRate) : '—'}\``
    );
  }

  if (cmd === '/positions' || cmd === '/position') {
    const p = acc.positions || [];
    if (!p.length) return reply(chatId, `*${acc.accountLabel}* — tidak ada posisi terbuka.`);
    const lines = p.map((x) => `${String(x.type).includes('buy') ? '🟢' : '🔴'} *${x.symbol}* \`${fmt(x.volume, 2)}\` lot @ ${x.priceOpen} → P/L: ${money(x.profit)}`);
    return reply(chatId, `📈 *${acc.accountLabel}* — ${p.length} posisi terbuka\n\n${lines.join('\n')}`);
  }

  if (cmd === '/orders' || cmd === '/order') {
    const o = acc.pendingOrders || [];
    if (!o.length) return reply(chatId, `*${acc.accountLabel}* — tidak ada pending order.`);
    const lines = o.map((x) => `${String(x.type).replaceAll('_', ' ')} *${x.symbol}* \`${fmt(x.volume, 2)}\` lot @ ${x.price}`);
    return reply(chatId, `📋 *${acc.accountLabel}* — ${o.length} pending order\n\n${lines.join('\n')}`);
  }

  if (cmd === '/history') {
    const n = Math.min(20, Math.max(1, parseInt(args[1], 10) || 5));
    const snap = await db.collection('accounts').doc(acc.id).collection('history').orderBy('closeTime', 'desc').limit(n).get();
    if (snap.empty) return reply(chatId, `*${acc.accountLabel}* — belum ada history.`);
    const lines = snap.docs.map((d) => {
      const t = d.data();
      const win = Number(t.netProfit) >= 0;
      return `${win ? '✅' : '❌'} *${t.symbol}* ${String(t.type).toUpperCase()} \`${fmt(t.volume, 2)}\` lot → ${money(t.netProfit)}`;
    });
    return reply(chatId, `🕘 *${acc.accountLabel}* — ${n} transaksi terakhir\n\n${lines.join('\n')}`);
  }

  if (cmd === '/risk') {
    const todayStr = ymd(new Date());
    const todayDoc = await db.collection('accounts').doc(acc.id).collection('dailyPnl').doc(todayStr).get();
    const todayRealized = todayDoc.exists ? Number(todayDoc.data().pnl || 0) : 0;
    const todayTotal = todayRealized + Number(acc.floatingProfit || 0);
    const dayStartBal = Number(acc.dayStartBalance || acc.balance || 1);
    const dailyLimitAmt = (dayStartBal * (acc.dailyLossLimitPct || 5)) / 100;
    const dailyUsage = dailyLimitAmt > 0 ? (Math.max(0, -todayTotal) / dailyLimitAmt) * 100 : 0;
    const startBal = Number(acc.startingBalance || acc.balance || 1);
    const overallPnl = Number(acc.equity || 0) - startBal;
    const overallLimitAmt = (startBal * (acc.overallLossLimitPct || 10)) / 100;
    const overallUsage = overallLimitAmt > 0 ? (Math.max(0, -overallPnl) / overallLimitAmt) * 100 : 0;
    return reply(
      chatId,
      `🛡️ *${acc.accountLabel}* — Risk Status\n` +
        `Daily loss limit: \`${pct(dailyUsage)}\` terpakai (limit ${acc.dailyLossLimitPct || 5}%)\n` +
        `Overall loss limit: \`${pct(overallUsage)}\` terpakai (limit ${acc.overallLossLimitPct || 10}%)\n` +
        `Margin Level: \`${acc.marginLevel != null ? pct(acc.marginLevel) : '—'}\``
    );
  }

  if (cmd === '/exposure') {
    const exp = acc.exposure || [];
    if (!exp.length) return reply(chatId, `*${acc.accountLabel}* — tidak ada exposure aktif.`);
    const eq = Number(acc.equity || 1);
    const lines = exp.map((x) => `*${x.symbol}*: \`${fmt(x.volume, 2)}\` lot (${x.count}x) · ${pct((x.notional / eq) * 100)} of equity · P/L ${money(x.profit)}`);
    return reply(chatId, `📐 *${acc.accountLabel}* — Exposure per Pair\n\n${lines.join('\n')}`);
  }

  if (cmd === '/drawdown') {
    const snap = await db.collection('accounts').doc(acc.id).collection('dailyPnl').orderBy('date', 'asc').get();
    const startBal = Number(acc.startingBalance || acc.balance || 0);
    let cum = startBal, peak = -Infinity, maxDD = 0, curDD = 0, days = 0;
    snap.forEach((d) => {
      cum += Number(d.data().pnl || 0);
      peak = Math.max(peak, cum);
      curDD = peak > 0 ? ((peak - cum) / peak) * 100 : 0;
      maxDD = Math.max(maxDD, curDD);
      days++;
    });
    if (!days) return reply(chatId, `*${acc.accountLabel}* — belum cukup data harian utk drawdown.`);
    return reply(
      chatId,
      `📉 *${acc.accountLabel}* — Drawdown\n` +
        `Current: \`${pct(curDD)}\`\n` +
        `Max: \`${pct(maxDD)}\`\n` +
        `Trading days tercatat: \`${days}\``
    );
  }

  if (cmd === '/status') {
    const todayStr = ymd(new Date());
    const todayDoc = await db.collection('accounts').doc(acc.id).collection('dailyPnl').doc(todayStr).get();
    const todayRealized = todayDoc.exists ? Number(todayDoc.data().pnl || 0) : 0;
    const todayTotal = todayRealized + Number(acc.floatingProfit || 0);
    const dayStartBal = Number(acc.dayStartBalance || acc.balance || 1);
    const dailyUsage = ((dayStartBal * (acc.dailyLossLimitPct || 5)) / 100) > 0 ? (Math.max(0, -todayTotal) / ((dayStartBal * (acc.dailyLossLimitPct || 5)) / 100)) * 100 : 0;
    const startBal = Number(acc.startingBalance || acc.balance || 1);
    const overallPnl = Number(acc.equity || 0) - startBal;
    const overallUsage = ((startBal * (acc.overallLossLimitPct || 10)) / 100) > 0 ? (Math.max(0, -overallPnl) / ((startBal * (acc.overallLossLimitPct || 10)) / 100)) * 100 : 0;
    const p = acc.positions || [];
    return reply(
      chatId,
      `⚡ *${acc.accountLabel}* — Quick Status\n` +
        `Equity: \`${money(acc.equity)}\` (${todayTotal >= 0 ? '+' : ''}${money(todayTotal)} hari ini)\n` +
        `Posisi terbuka: \`${p.length}\`\n` +
        `Daily limit: \`${pct(dailyUsage)}\` · Overall limit: \`${pct(overallUsage)}\`\n` +
        `Margin Level: \`${acc.marginLevel != null ? pct(acc.marginLevel) : '—'}\`\n` +
        `Sesi: ${sessionInfo()}`
    );
  }

  return reply(chatId, `Command tidak dikenal. Ketik /help untuk daftar command.`);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });
  try {
    const update = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const msg = update.message || update.channel_post;
    if (!msg || !msg.text || !msg.text.startsWith('/')) return res.status(200).json({ ok: true });

    const [rawCmd, ...args] = msg.text.trim().split(/\s+/);
    const cmd = rawCmd.split('@')[0].toLowerCase(); // buang @BotUsername kalau ada (dipakai di grup)

    await handleCommand(cmd, args, msg.chat.id);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ ok: true }); // selalu 200 ke Telegram supaya tidak retry terus
  }
};
