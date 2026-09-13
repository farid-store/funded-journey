// api/webhook.js
// FaridFX Prop-Firm Webhook
// MT5 EA -> POST -> JSONBin persistent store -> GET -> Dashboard
//
// Environment Variables:
//   JSONBIN_BIN_ID     = JSONBin Bin ID
//   JSONBIN_API_KEY    = JSONBin Master Key
//   EA_WEBHOOK_SECRET  = token yang sama dengan InpSecretToken di EA
//
// GET mengembalikan:
//   - current/latest account
//   - history trade
//   - daily P/L
//   - equity snapshots
//   - semua akun yang pernah mengirim data
//
// Data lama TIDAK ditimpa saat EA melakukan POST baru.

const JSONBIN_ID = process.env.JSONBIN_BIN_ID;
const JSONBIN_KEY = process.env.JSONBIN_API_KEY;
const SHARED_TOKEN = process.env.EA_WEBHOOK_SECRET;

// Batas penyimpanan per account
const MAX_SNAPSHOTS_PER_ACCOUNT = 10000;
const MAX_TRADES_PER_ACCOUNT = 20000;
const MAX_DAYS = 3650;


// ============================================================
// HELPER
// ============================================================

function jsonClone(value) {
  return value == null
    ? value
    : JSON.parse(JSON.stringify(value));
}


function safeNumber(value, fallback = 0) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}


// ============================================================
// ACCOUNT KEY
// ============================================================

function accountKey(payload) {

  const account =
    payload && payload.account
      ? payload.account
      : {};

  const login =
    account.login ??
    account.account ??
    payload.login ??
    "";

  const server =
    account.server ??
    payload.server ??
    "";

  const label =
    payload.accountLabel ??
    account.label ??
    "Primary MT5";


  // Login adalah identifier terbaik
  if (String(login).trim()) {

    return `login:${login}`;

  }


  return `label:${label}|server:${server}`;
}



// ============================================================
// SNAPSHOT
// ============================================================

function snapshotFromPayload(payload) {

  const account =
    payload.account || {};


  const balance =
    safeNumber(account.balance);


  const equity =
    safeNumber(account.equity);


  const floating =
    safeNumber(
      account.floating ??
      account.floatingProfit ??
      (equity - balance)
    );


  return {

    ts:
      safeNumber(
        payload.serverTime,
        Date.now()
      ),

    receivedAt:
      payload.receivedAt ||
      new Date().toISOString(),

    balance,

    equity,

    floating,

    reason:
      payload.reason ||
      "snapshot"

  };
}



// ============================================================
// NORMALIZE TRADE
// ============================================================

function normalizeTrade(t) {

  if (!t || typeof t !== "object") {

    return null;

  }


  const profit =
    safeNumber(t.profit);


  const swap =
    safeNumber(t.swap);


  const commission =
    safeNumber(t.commission);


  return {

    ...t,

    ticket:
      t.ticket ??
      t.dealTicket ??
      null,

    dealTicket:
      t.dealTicket ??
      t.ticket ??
      null,

    symbol:
      t.symbol ??
      "",

    type:
      t.type ??
      "",

    volume:
      safeNumber(t.volume),

    openPrice:
      safeNumber(t.openPrice),

    closePrice:
      safeNumber(t.closePrice),

    openTime:
      safeNumber(t.openTime),

    closeTime:
      safeNumber(t.closeTime),

    durationSec:
      safeNumber(t.durationSec),

    profit,

    swap,

    commission,

    netProfit:
      safeNumber(
        t.netProfit,
        profit +
        swap +
        commission
      ),

    magic:
      t.magic ??
      0,

    comment:
      t.comment ??
      ""

  };
}



// ============================================================
// MERGE TRADES
// ============================================================

function mergeTrades(
  oldTrades,
  newTrades
) {

  const map =
    new Map();


  // ----------------------------------------------------------
  // DATA LAMA
  // ----------------------------------------------------------

  for (
    const t of
    Array.isArray(oldTrades)
      ? oldTrades
      : []
  ) {

    const n =
      normalizeTrade(t);


    if (!n) {

      continue;

    }


    const key =
      String(
        n.ticket ??
        n.dealTicket ??
        `${n.closeTime}|${n.symbol}|${n.netProfit}`
      );


    map.set(
      key,
      n
    );

  }



  // ----------------------------------------------------------
  // DATA BARU
  // ----------------------------------------------------------

  for (
    const t of
    Array.isArray(newTrades)
      ? newTrades
      : []
  ) {

    const n =
      normalizeTrade(t);


    if (!n) {

      continue;

    }


    const key =
      String(
        n.ticket ??
        n.dealTicket ??
        `${n.closeTime}|${n.symbol}|${n.netProfit}`
      );


    map.set(
      key,
      n
    );

  }



  // ----------------------------------------------------------
  // SORT TERBARU
  // ----------------------------------------------------------

  return Array
    .from(map.values())
    .sort(
      (a, b) =>
        safeNumber(b.closeTime) -
        safeNumber(a.closeTime)
    )
    .slice(
      0,
      MAX_TRADES_PER_ACCOUNT
    );

}



// ============================================================
// MERGE EQUITY SNAPSHOTS
// ============================================================

function mergeSnapshots(
  oldSnapshots,
  newSnapshot
) {

  const arr =
    Array.isArray(oldSnapshots)
      ? [...oldSnapshots]
      : [];


  if (
    newSnapshot &&
    typeof newSnapshot === "object"
  ) {

    arr.push(
      newSnapshot
    );

  }


  const map =
    new Map();


  for (
    const snapshot of arr
  ) {

    const key =
      `${safeNumber(snapshot.ts)}|${snapshot.reason || ""}`;


    map.set(
      key,
      snapshot
    );

  }


  return Array
    .from(map.values())
    .sort(
      (a, b) =>
        safeNumber(a.ts) -
        safeNumber(b.ts)
    )
    .slice(
      -MAX_SNAPSHOTS_PER_ACCOUNT
    );

}



// ============================================================
// MERGE DAILY PNL
// ============================================================

function mergeDailyPnl(
  oldDaily,
  newDaily,
  trades
) {

  const out = {

    ...(oldDaily &&
    typeof oldDaily === "object"
      ? oldDaily
      : {})

  };


  // ----------------------------------------------------------
  // DAILY PNL DARI EA
  // ----------------------------------------------------------

  if (
    newDaily &&
    typeof newDaily === "object"
  ) {

    for (
      const [date, value]
      of Object.entries(newDaily)
    ) {

      if (
        !value ||
        typeof value !== "object"
      ) {

        continue;

      }


      out[date] = {

        ...(out[date] || {}),

        ...value,

        pnl:
          safeNumber(
            value.pnl,
            safeNumber(
              out[date]?.pnl
            )
          ),

        trades:
          safeNumber(
            value.trades,
            safeNumber(
              out[date]?.trades
            )
          ),

        wins:
          safeNumber(
            value.wins,
            safeNumber(
              out[date]?.wins
            )
          ),

        losses:
          safeNumber(
            value.losses,
            safeNumber(
              out[date]?.losses
            )
          )

      };

    }

  }



  // ----------------------------------------------------------
  // REKONSTRUKSI DARI HISTORY TRADE
  // ----------------------------------------------------------

  const tradeDays = {};


  for (
    const t of
    Array.isArray(trades)
      ? trades
      : []
  ) {

    const ts =
      safeNumber(
        t.closeTime
      );


    if (!ts) {

      continue;

    }


    // MT5 biasanya timestamp seconds
    // tetapi kita support milliseconds juga.

    const ms =
      ts > 1e12
        ? ts
        : ts * 1000;


    const d =
      new Date(ms);


    if (
      Number.isNaN(
        d.getTime()
      )
    ) {

      continue;

    }


    const date =
      d.toISOString()
       .slice(0, 10);


    if (
      !tradeDays[date]
    ) {

      tradeDays[date] = {

        pnl: 0,

        trades: 0,

        wins: 0,

        losses: 0

      };

    }


    const net =
      safeNumber(
        t.netProfit
      );


    tradeDays[date].pnl +=
      net;


    tradeDays[date].trades +=
      1;


    if (net > 0) {

      tradeDays[date].wins +=
        1;

    }


    if (net < 0) {

      tradeDays[date].losses +=
        1;

    }

  }



  // ----------------------------------------------------------
  // GABUNGKAN HASIL
  // ----------------------------------------------------------

  for (
    const [date, value]
    of Object.entries(tradeDays)
  ) {

    if (!out[date]) {

      out[date] =
        value;

    }

    else {

      out[date] = {

        ...value,

        ...out[date]

      };

    }

  }



  // ----------------------------------------------------------
  // BATASI JUMLAH HARI
  // ----------------------------------------------------------

  const keys =
    Object.keys(out)
      .sort();


  return Object.fromEntries(

    keys
      .slice(-MAX_DAYS)
      .map(
        key =>
          [key, out[key]]
      )

  );

}



// ============================================================
// SANITIZE PAYLOAD
// ============================================================

function sanitizePayload(body) {

  const payload =
    jsonClone(
      body || {}
    );


  // Jangan pernah menyimpan secret token
  delete payload.token;


  return payload;

}



// ============================================================
// READ JSONBIN
// ============================================================

async function readStore() {

  const r =
    await fetch(
      `https://api.jsonbin.io/v3/b/${JSONBIN_ID}/latest`,
      {

        headers: {

          "X-Master-Key":
            JSONBIN_KEY

        }

      }
    );


  if (!r.ok) {

    const text =
      await r.text();


    throw new Error(
      `jsonbin read failed: ${r.status} ${text}`
    );

  }


  const data =
    await r.json();


  const record =
    data &&
    data.record;


  // ----------------------------------------------------------
  // FORMAT BARU
  // ----------------------------------------------------------

  if (
    record &&
    record.accounts &&
    typeof record.accounts === "object"
  ) {

    return record;

  }



  // ----------------------------------------------------------
  // MIGRASI FORMAT LAMA
  // ----------------------------------------------------------

  if (
    record &&
    record.account
  ) {

    const key =
      accountKey(
        record
      );


    const current =
      sanitizePayload(
        record
      );


    const snap =
      snapshotFromPayload(
        current
      );


    const trades =
      Array.isArray(
        current.history
      )

        ? current.history
            .map(
              normalizeTrade
            )
            .filter(Boolean)

        : [];


    return {

      schemaVersion: 3,

      updatedAt:
        current.receivedAt ||
        new Date().toISOString(),

      accounts: {

        [key]: {

          current,

          snapshots:
            snap
              ? [snap]
              : [],

          trades,

          dailyPnl:
            current.dailyPnl ||
            {}

        }

      }

    };

  }



  // ----------------------------------------------------------
  // STORE KOSONG
  // ----------------------------------------------------------

  return {

    schemaVersion: 3,

    updatedAt: null,

    accounts: {}

  };

}



// ============================================================
// WRITE JSONBIN
// ============================================================

async function writeStore(
  store
) {

  const r =
    await fetch(
      `https://api.jsonbin.io/v3/b/${JSONBIN_ID}`,
      {

        method: "PUT",

        headers: {

          "Content-Type":
            "application/json",

          "X-Master-Key":
            JSONBIN_KEY

        },

        body:
          JSON.stringify(
            store
          )

      }
    );


  if (!r.ok) {

    const text =
      await r.text();


    throw new Error(
      `jsonbin write failed: ${r.status} ${text}`
    );

  }

}



// ============================================================
// BUILD GET RESPONSE
// ============================================================

function buildGetResponse(
  store
) {

  const accounts =
    store.accounts ||
    {};


  const entries =
    Object.entries(
      accounts
    );


  // ----------------------------------------------------------
  // BELUM ADA ACCOUNT
  // ----------------------------------------------------------

  if (
    !entries.length
  ) {

    return {

      ok: true,

      schemaVersion: 3,

      updatedAt:
        store.updatedAt ||
        null,

      accounts: {}

    };

  }



  // ----------------------------------------------------------
  // ACCOUNT PERTAMA
  // Untuk kompatibilitas dashboard single-account
  // ----------------------------------------------------------

  const [
    ,
    first
  ] =
    entries[0];


  const current =
    first.current ||
    {};



  // ----------------------------------------------------------
  // RESPONSE
  // ----------------------------------------------------------

  return {

    ok: true,

    schemaVersion: 3,

    updatedAt:
      store.updatedAt ||
      null,


    // ========================================================
    // DATABASE SEMUA ACCOUNT
    // ========================================================

    accounts,



    // ========================================================
    // FIELD COMPATIBILITY DASHBOARD LAMA
    // ========================================================

    ...current,



    // ========================================================
    // HISTORY
    // ========================================================

    history:
      first.trades ||
      current.history ||
      [],



    // ========================================================
    // DAILY PNL
    // ========================================================

    dailyPnl:
      first.dailyPnl ||
      current.dailyPnl ||
      {},



    // ========================================================
    // EQUITY CURVE
    // ========================================================

    snapshots:
      first.snapshots ||
      [],

    snapshotHistory:
      first.snapshots ||
      [],



    // ========================================================
    // CURRENT DATA
    // ========================================================

    current,

    latest:
      current,

    payload:
      current

  };

}



// ============================================================
// MAIN VERCEL HANDLER
// ============================================================

module.exports =
async function handler(
  req,
  res
) {


  // ==========================================================
  // CORS
  // ==========================================================

  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );


  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,OPTIONS"
  );


  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );


  // OPTIONS
  if (
    req.method === "OPTIONS"
  ) {

    return res
      .status(200)
      .end();

  }



  // ==========================================================
  // CHECK CONFIGURATION
  // ==========================================================

  if (
    !JSONBIN_ID ||
    !JSONBIN_KEY
  ) {

    return res
      .status(500)
      .json({

        ok: false,

        error:
          "JSONBin environment variables are not configured"

      });

  }



  // ==========================================================
  // POST
  // MT5 EA -> WEBHOOK
  // ==========================================================

  if (
    req.method === "POST"
  ) {

    try {

      // ------------------------------------------------------
      // PARSE BODY
      // ------------------------------------------------------

      const body =

        req.body &&
        typeof req.body === "object"

          ? req.body

          : JSON.parse(
              req.body ||
              "{}"
            );



      // ------------------------------------------------------
      // VALIDATE TOKEN
      // ------------------------------------------------------

      if (
        !SHARED_TOKEN ||
        body.token !==
          SHARED_TOKEN
      ) {

        return res
          .status(401)
          .json({

            ok: false,

            error:
              "invalid token"

          });

      }



      // ------------------------------------------------------
      // SANITIZE
      // ------------------------------------------------------

      const payload =
        sanitizePayload(
          body
        );


      payload.receivedAt =
        new Date().toISOString();



      // ------------------------------------------------------
      // ACCOUNT IDENTIFIER
      // ------------------------------------------------------

      const key =
        accountKey(
          payload
        );



      // ------------------------------------------------------
      // BACA DATABASE LAMA
      // ------------------------------------------------------

      const store =
        await readStore();


      if (
        !store.accounts
      ) {

        store.accounts =
          {};

      }



      // ------------------------------------------------------
      // ACCOUNT SEBELUMNYA
      // ------------------------------------------------------

      const previous =
        store.accounts[key] ||
        {

          current: {},

          snapshots: [],

          trades: [],

          dailyPnl: {}

        };



      // ------------------------------------------------------
      // BUAT SNAPSHOT BARU
      // ------------------------------------------------------

      const newSnapshot =
        snapshotFromPayload(
          payload
        );



      // ------------------------------------------------------
      // MERGE HISTORY
      // ------------------------------------------------------

      const mergedTrades =
        mergeTrades(

          previous.trades,

          payload.history

        );



      // ------------------------------------------------------
      // MERGE EQUITY SNAPSHOT
      // ------------------------------------------------------

      const mergedSnapshots =
        mergeSnapshots(

          previous.snapshots,

          newSnapshot

        );



      // ------------------------------------------------------
      // MERGE DAILY PNL
      // ------------------------------------------------------

      const mergedDaily =
        mergeDailyPnl(

          previous.dailyPnl,

          payload.dailyPnl,

          mergedTrades

        );



      // ------------------------------------------------------
      // SIMPAN CURRENT DATA
      // ------------------------------------------------------

      store.accounts[key] = {

        // Snapshot terbaru
        current:
          payload,


        // Semua equity snapshot
        snapshots:
          mergedSnapshots,


        // Semua trade
        trades:
          mergedTrades,


        // Semua daily P/L
        dailyPnl:
          mergedDaily

      };



      // ------------------------------------------------------
      // META DATABASE
      // ------------------------------------------------------

      store.schemaVersion =
        3;


      store.updatedAt =
        payload.receivedAt;



      // ------------------------------------------------------
      // WRITE
      // ------------------------------------------------------

      await writeStore(
        store
      );



      // ------------------------------------------------------
      // RESPONSE
      // ------------------------------------------------------

      return res
        .status(200)
        .json({

          ok: true,

          schemaVersion: 3,

          accountKey:
            key,

          receivedAt:
            payload.receivedAt,

          stored: {

            snapshots:
              mergedSnapshots.length,

            trades:
              mergedTrades.length,

            days:
              Object.keys(
                mergedDaily
              ).length

          }

        });

    }

    catch (e) {

      console.error(e);


      return res
        .status(500)
        .json({

          ok: false,

          error:
            String(
              e &&
              e.message
                ? e.message
                : e
            )

        });

    }

  }



  // ==========================================================
  // GET
  // DASHBOARD -> WEBHOOK
  // ==========================================================

  if (
    req.method === "GET"
  ) {

    try {

      const store =
        await readStore();


      return res
        .status(200)
        .json(
          buildGetResponse(
            store
          )
        );

    }

    catch (e) {

      console.error(e);


      return res
        .status(500)
        .json({

          ok: false,

          error:
            String(
              e &&
              e.message
                ? e.message
                : e
            )

        });

    }

  }



  // ==========================================================
  // METHOD TIDAK DIDUKUNG
  // ==========================================================

  return res
    .status(405)
    .json({

      ok: false,

      error:
        "method not allowed"

    });

};
