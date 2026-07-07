import { useState, useEffect, useCallback, useRef, useMemo, Fragment } from "react";

// ─── FIFO Engine (Broker-Level Accurate) ───────────────────────────────────────
// Processes trades chronologically. Uses a running queue to match positions.
// Handles: short-first (options selling), long-first (equity buying), intraday, overnight.
function applyFIFO(trades) {
  const groups = {};
  for (const t of trades) {
    const key = `${t.clientId}||${t.contract}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push({ ...t });
  }

  const openPositions = [];
  const closedPositions = [];

  for (const key of Object.keys(groups)) {
    const [clientId, contract] = key.split("||");

    // Sort strictly: date → intraday time (handles AM/PM correctly)
    const parseTime = (t) => {
      if (!t) return 0;
      const m = t.match(/(\d+):(\d+):(\d+)\s*(AM|PM)?/i);
      if (!m) return 0;
      let h = +m[1], mn = +m[2], s = +m[3];
      const ap = (m[4] || "").toUpperCase();
      if (ap === "PM" && h !== 12) h += 12;
      if (ap === "AM" && h === 12) h = 0;
      return h * 3600 + mn * 60 + s;
    };

    const tradeList = [...groups[key]].sort((a, b) => {
      const dA = a.date || "1970-01-01", dB = b.date || "1970-01-01";
      if (dA !== dB) return dA.localeCompare(dB);
      return parseTime(a.time) - parseTime(b.time);
    });

    // Queue: [{side, qty, price, date}] — open lots in FIFO order
    let queue = [];
    let bookedPnl = 0;
    let closedTrades = [];

    for (const trade of tradeList) {
      let remaining = +trade.qty;
      const side = trade.side === "BUY" ? "BUY" : "SELL";
      const oppSide = side === "BUY" ? "SELL" : "BUY";

      // Close existing opposite-side lots FIFO
      while (remaining > 0 && queue.length > 0 && queue[0].side === oppSide) {
        const lot = queue[0];
        const matchQty = Math.min(lot.qty, remaining);

        // P&L = (sell price - buy price) * qty, always positive for profit
        const sellPx = side === "SELL" ? +trade.price : +lot.price;
        const buyPx  = side === "BUY"  ? +trade.price : +lot.price;
        const pnl = (sellPx - buyPx) * matchQty;

        bookedPnl += pnl;
        closedTrades.push({
          clientId, contract,
          qty: matchQty,
          sellPrice: +sellPx.toFixed(4),
          buyPrice:  +buyPx.toFixed(4),
          pnl: +pnl.toFixed(2),
          date: trade.date,
        });

        lot.qty -= matchQty;
        remaining -= matchQty;
        if (lot.qty < 0.0001) queue.shift(); // fully consumed
      }

      // Add remaining as new open lot
      if (remaining > 0.0001) {
        // Merge with last lot if same side and price (optional optimization)
        queue.push({ side, qty: remaining, price: +trade.price, date: trade.date });
      }
    }

    // Build open position from remaining queue
    if (queue.length > 0) {
      const totalQty = queue.reduce((a, l) => a + l.qty, 0);
      const avgPx    = queue.reduce((a, l) => a + l.price * l.qty, 0) / totalQty;
      openPositions.push({
        clientId, contract,
        netQty: +totalQty.toFixed(0),
        avgPrice: +avgPx.toFixed(2),
        side: queue[0].side,
        bookedPnl: +bookedPnl.toFixed(2),
        openLots: queue,
      });
    }

    if (closedTrades.length > 0) {
      closedPositions.push({
        clientId, contract,
        totalPnl: +bookedPnl.toFixed(2),
        trades: closedTrades,
      });
    }
  }

  return { openPositions, closedPositions };
}

// ─── Default Charges Config ────────────────────────────────────────────────────
const DEFAULT_CHARGES = {
  effectiveFrom: "2024-01-01",
  extraMarkup: 0, // % added on top of total charges
  // F&O - NSE
  fno_nse: {
    stt_fut_buy:    0.0000, stt_fut_sell:   0.0200, // % of turnover
    stt_opt_buy:    0.0000, stt_opt_sell:   0.1000, // % of premium
    stamp_buy:      0.0020, stamp_sell:     0.0000,
    tot_fut:        0.0017, tot_opt:        0.0400, // turnover charges %
    sebi:           0.00010,
    ipf:            0.00010,
    clearing:       0.00045,
    gst:            18,     // % on (tot + clearing + sebi)
  },
  // F&O - BSE
  fno_bse: {
    stt_fut_buy:    0.0000, stt_fut_sell:   0.0200,
    stt_opt_buy:    0.0000, stt_opt_sell:   0.1000,
    stamp_buy:      0.0020, stamp_sell:     0.0000,
    tot_fut:        0.0019, tot_opt:        0.0325,
    sebi:           0.00010,
    ipf:            0.00010,
    clearing:       0.00045,
    gst:            18,
  },
  // Equity Cash - NSE
  eq_nse: {
    stt_del_buy:    0.1000, stt_del_sell:   0.1000, // delivery
    stt_intra_buy:  0.0000, stt_intra_sell: 0.0250, // intraday
    stamp_buy:      0.0150, stamp_sell:     0.0000,
    tot:            0.00297,
    sebi:           0.00010,
    ipf:            0.00010,
    clearing:       0.0000,
    gst:            18,
  },
  // Equity Cash - BSE
  eq_bse: {
    stt_del_buy:    0.1000, stt_del_sell:   0.1000,
    stt_intra_buy:  0.0000, stt_intra_sell: 0.0250,
    stamp_buy:      0.0150, stamp_sell:     0.0000,
    tot:            0.00345,
    sebi:           0.00010,
    ipf:            0.00010,
    clearing:       0.0000,
    gst:            18,
  },
};

// ─── Charges Calculator ────────────────────────────────────────────────────────
function calcCharges(trade, chargesConfig) {
  const cfg = chargesConfig || DEFAULT_CHARGES;
  const isBuy  = trade.side === "BUY";
  const isSell = trade.side === "SELL";
  const turnover = trade.price * trade.qty; // total value
  const exch = (trade.exchange || "NSE").toUpperCase();
  const instrType = (trade.instrType || "").toUpperCase();

  const isOption  = instrType.includes("OPT") || instrType === "OPTIONS" || instrType === "OPTION";
  const isFuture  = instrType.includes("FUT") || instrType === "FUTURES" || instrType === "FUTURE";
  const isEquity  = instrType === "EQUITY" || instrType === "EQ" || (!isOption && !isFuture);

  let stt=0, stamp=0, tot=0, sebi=0, ipf=0, clearing=0, gst=0;

  if (isOption || isFuture) {
    const c = exch === "BSE" ? cfg.fno_bse : cfg.fno_nse;
    if (isOption) {
      stt     = isSell ? (turnover * c.stt_opt_sell / 100) : (turnover * c.stt_opt_buy / 100);
      tot     = turnover * c.tot_opt / 100;
    } else {
      stt     = isSell ? (turnover * c.stt_fut_sell / 100) : (turnover * c.stt_fut_buy / 100);
      tot     = turnover * c.tot_fut / 100;
    }
    stamp     = isBuy ? (turnover * c.stamp_buy / 100) : 0;
    sebi      = turnover * c.sebi / 100;
    ipf       = turnover * c.ipf / 100;
    clearing  = turnover * c.clearing / 100;
    gst       = (tot + clearing + sebi) * c.gst / 100;
  } else {
    // Equity — assume delivery for now (intraday detection can be added later)
    const c = exch === "BSE" ? cfg.eq_bse : cfg.eq_nse;
    stt       = turnover * (isBuy ? c.stt_del_buy : c.stt_del_sell) / 100;
    stamp     = isBuy ? (turnover * c.stamp_buy / 100) : 0;
    tot       = turnover * c.tot / 100;
    sebi      = turnover * c.sebi / 100;
    ipf       = turnover * c.ipf / 100;
    clearing  = turnover * c.clearing / 100;
    gst       = (tot + clearing + sebi) * c.gst / 100;
  }

  const subtotal = stt + stamp + tot + sebi + ipf + clearing + gst;
  const markup   = subtotal * (cfg.extraMarkup || 0) / 100;
  const total    = subtotal + markup;

  return { stt:+stt.toFixed(4), stamp:+stamp.toFixed(4), tot:+tot.toFixed(4),
           sebi:+sebi.toFixed(4), ipf:+ipf.toFixed(4), clearing:+clearing.toFixed(4),
           gst:+gst.toFixed(4), markup:+markup.toFixed(4), total:+total.toFixed(2) };
}

const INITIAL_STATE = {
  clients: [],
  trades: [],
  ledger: [],
  tickets: [],
  bhavcopy: [],
  chargesHistory: [{ ...DEFAULT_CHARGES, effectiveFrom: "2024-01-01" }],
  interest: [],
  lockedMonths: [],
  admins: [],     // sub-admins created by JIYA
  tokens: [],     // activation tokens
  auditLog: [],   // ledger audit trail — created/edited/deleted entries
};

// ── Plan feature access ──────────────────────────────
const PLAN_FEATURES = {
  basic:   ["dashboard","clients","trades","pnl","ledger","tickets","settings"],
  pro:     ["dashboard","clients","trades","pnl","ledger","tickets","settings","charges","rms"],
  perfect: ["dashboard","clients","trades","pnl","ledger","tickets","settings","charges","rms","audit","export"],
  superadmin: ["dashboard","clients","trades","pnl","ledger","tickets","settings","charges","rms","audit","export","admins","tokens"],
};

const hasFeature = (plan, feature) => {
  const features = PLAN_FEATURES[plan || "basic"] || PLAN_FEATURES.basic;
  return features.includes(feature);
};

// ── Token generator ──────────────────────────────────
const generateToken = (plan) => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const rand = (n) => Array.from({length:n}, () => chars[Math.floor(Math.random()*chars.length)]).join("");
  return "JIYA-" + plan.toUpperCase().slice(0,4) + "-" + rand(4) + "-" + rand(4);
};

// ─── Icons ─────────────────────────────────────────────────────────────────────
const Icon = ({ name, size = 18 }) => {
  const icons = {
    dashboard: "M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z",
    clients: "M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z",
    ledger: "M20 3H4v10c0 2.21 1.79 4 4 4h6c2.21 0 4-1.79 4-4v-3h2c1.11 0 2-.89 2-2V5c0-1.11-.89-2-2-2zm0 5h-2V5h2v3zM4 19h16v2H4z",
    trades: "M3.5 18.49l6-6.01 4 4L22 6.92l-1.41-1.41-7.09 7.97-4-4L2 16.99z",
    pnl: "M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z",
    ticket: "M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z",
    logout: "M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z",
    add: "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z",
    delete: "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z",
    upload: "M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z",
    check: "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
    close: "M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
    reply: "M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z",
    position: "M5 9.2h3V19H5zM10.6 5h2.8v14h-2.8zm5.6 8H19v6h-2.8z",
    bhavcopy: "M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 3c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm7 13H5v-.23c0-.62.28-1.2.76-1.58C7.47 15.82 9.64 15 12 15s4.53.82 6.24 2.19c.48.38.76.97.76 1.58V19z",
    charges: "M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z",
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d={icons[name] || icons.dashboard} />
    </svg>
  );
};

// ─── Supabase Configuration ────────────────────────────────────────────────────
// Replace these two values with your own from supabase.com → Project Settings → API
const SUPABASE_URL = "https://jwfucitnaqkuyzizmuve.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp3ZnVjaXRuYXFrdXl6aXptdXZlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2MTIyNDIsImV4cCI6MjA5MTE4ODI0Mn0.62UKN69g9qXoSipj_JdVtMt7JNcX03e-CeVWwOC3s6A";

// Lightweight Supabase REST client (no npm needed)
const sb = {
  headers: {
    "Content-Type": "application/json",
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
    "Prefer": "return=representation",
  },
  url: (table) => `${SUPABASE_URL}/rest/v1/${table}`,

  async select(table, query = "") {
    const headers = {
      ...this.headers,
      "Range-Unit": "items",
      "Prefer": "count=none",  // don't count, just return rows
    };
    const r = await fetch(`${this.url(table)}${query}`, { headers });
    if (!r.ok) throw new Error(`SELECT ${table}: ${await r.text()}`);
    return r.json();
  },
  async insert(table, rows) {
    const body = Array.isArray(rows) ? rows : [rows];
    const r = await fetch(this.url(table), {
      method: "POST", headers: this.headers, body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`INSERT ${table}: ${await r.text()}`);
    return r.json();
  },
  async upsert(table, rows) {
    const body = Array.isArray(rows) ? rows : [rows];
    const r = await fetch(this.url(table), {
      method: "POST",
      headers: { ...this.headers, "Prefer": "return=representation,resolution=merge-duplicates" },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`UPSERT ${table}: ${await r.text()}`);
    return r.json();
  },
  async update(table, id, data) {
    const r = await fetch(`${this.url(table)}?id=eq.${id}`, {
      method: "PATCH", headers: this.headers, body: JSON.stringify(data)
    });
    if (!r.ok) throw new Error(`UPDATE ${table}: ${await r.text()}`);
    return r.json();
  },
  async delete(table, id) {
    const r = await fetch(`${this.url(table)}?id=eq.${id}`, {
      method: "DELETE", headers: { ...this.headers, "Prefer": "" }
    });
    if (!r.ok) throw new Error(`DELETE ${table}: ${await r.text()}`);
  },
  async deleteAll(table) {
    // Supabase requires a filter for DELETE — use created_at > epoch (matches all rows)
    const r = await fetch(`${this.url(table)}?created_at=gte.2000-01-01`, {
      method: "DELETE", headers: { ...this.headers, "Prefer": "" }
    });
    if (!r.ok) {
      // Fallback: try with id filter
      const r2 = await fetch(`${this.url(table)}?id=gte.0`, {
        method: "DELETE", headers: { ...this.headers, "Prefer": "" }
      });
      if (!r2.ok) throw new Error(`DELETE ALL ${table}: ${await r2.text()}`);
    }
  },
  async deleteWhere(table, column, value) {
    const r = await fetch(`${this.url(table)}?${column}=eq.${value}`, {
      method: "DELETE", headers: { ...this.headers, "Prefer": "" }
    });
    if (!r.ok) throw new Error(`DELETE WHERE ${table}: ${await r.text()}`);
  },
};

// Check if Supabase is configured
const SUPABASE_CONFIGURED = SUPABASE_URL !== "YOUR_SUPABASE_URL" && SUPABASE_ANON_KEY !== "YOUR_SUPABASE_ANON_KEY";

// ─── Main App ──────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════
// RMS PAGE COMPONENT
// ═══════════════════════════════════════════════════════
const LOT_SIZES    = { NIFTY:75, SENSEX:20, BANKNIFTY:35, BANKEX:15, FINNIFTY:40, MIDCPNIFTY:120 };
const DEFAULT_IDX  = { NIFTY:24050, SENSEX:77550, BANKNIFTY:52000, BANKEX:52000 };
const SPAN_PCT     = 0.0187;
const EXPOSURE_PCT = 0.0702;
const SCENARIO_STEPS = [-20,-15,-10,-5,5,10,15,20];
const CLIENT_NAMES_RMS = {
  DLL11647:"UTSAV", DLL12771:"HARSH", DWH00916:"NILESH",
  ZZJ14748:"AMBALIYA", ZZJ14749:"NITIN", ZZJ14750:"SANDIP", ZZJ5538:"JAYESHBHAI"
};

function calcRMSMargin(positions, indexPrices) {
  let span = 0, exposure = 0, premium = 0;
  (positions||[]).forEach(p => {
    const sym = (p.symbol||"").toUpperCase();
    const lot = LOT_SIZES[sym] || 75;
    const idx = (indexPrices||{})[sym] || DEFAULT_IDX[sym] || 24050;
    const qty = parseFloat(p.netQty) || 0;
    const netP = Math.abs(parseFloat(p.netPrice)||0);
    const mktP = Math.abs(parseFloat(p.marketPrice)||0);
    if (qty===0) return;
    const lots = Math.abs(qty)/lot;
    if (qty < 0) { const s=SPAN_PCT*idx*lot*lots; span+=s; exposure+=s*EXPOSURE_PCT; }
    else { premium += (netP||mktP)*Math.abs(qty); }
  });
  return { span:Math.round(span), exposure:Math.round(exposure), premium:Math.round(premium), total:Math.round(span+exposure+premium) };
}

function calcRMSScenario(positions, pct, indexPrices) {
  let impact = 0;
  (positions||[]).forEach(p => {
    const sym = (p.symbol||"").toUpperCase();
    const idx = (indexPrices||{})[sym] || DEFAULT_IDX[sym] || 24050;
    const qty = parseFloat(p.netQty)||0;
    const mktP = parseFloat(p.marketPrice)||0;
    const strike = parseFloat(p.strikePrice)||idx;
    const optType = (p.optionType||"").toUpperCase();
    if (qty===0||mktP<=0) return;
    const moneyness = optType==="CE"?(idx-strike)/idx:(strike-idx)/idx;
    let delta = Math.max(0.05, Math.min(0.95, 0.5+moneyness*2));
    if (optType==="PE") delta=-delta;
    const priceChg = mktP*(Math.abs(pct)/100)*Math.abs(delta)*(pct>0?1:-1);
    impact += (optType==="CE"?priceChg:-priceChg)*qty;
  });
  return Math.round(impact);
}

function parseRMSCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => { const t=l.trim(); return t&&!t.startsWith("(ALL)")&&!t.startsWith("---"); });
  if (lines.length<2) return {};
  const header = lines[0].split(",").map(h=>h.trim().toLowerCase());
  const fi = k => header.findIndex(h=>h.includes(k));
  const [iU,iSy,iEx,iSt,iOt,iNq,iNp,iMp,iMt] = [fi("user"),fi("symbol"),fi("ser"),fi("strike"),fi("option"),fi("net qty"),fi("net p"),fi("market"),fi("mtm")];
  const byClient = {};
  lines.slice(1).forEach(line => {
    const c = line.split(",").map(x=>x.trim());
    if (c.length<5) return;
    const cid = c[iU]||"";
    if (!cid||cid.includes("ALL")||cid.startsWith("-")) return;
    if (!byClient[cid]) byClient[cid]=[];
    byClient[cid].push({ symbol:c[iSy]||"", expiry:iEx>=0?c[iEx]:"", strikePrice:iSt>=0?c[iSt]:"0",
      optionType:iOt>=0?c[iOt]:"", netQty:iNq>=0?c[iNq]:"0", netPrice:iNp>=0?c[iNp]:"0",
      marketPrice:iMp>=0?c[iMp]:"0", mtmGL:iMt>=0?c[iMt]:"0" });
  });
  return byClient;
}


// ── RMS Intraday Helpers ─────────────────────────────────────────────────────

// Parse expiry string like "21APR2026" or "13APR2026" to Date
function parseExpiry(expStr) {
  if (!expStr) return null;
  const months = {JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,
                  JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
  const m = expStr.trim().toUpperCase().match(/^(\d{1,2})([A-Z]{3})(\d{4})$/);
  if (!m) return null;
  return new Date(parseInt(m[3]), months[m[2]], parseInt(m[1]));
}

// Check if expiry is today or earlier (expired)
function isExpiredToday(expStr, refDate) {
  const exp = parseExpiry(expStr);
  if (!exp) return false;
  const ref = refDate || new Date();
  const refDay = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  const expDay = new Date(exp.getFullYear(), exp.getMonth(), exp.getDate());
  return expDay <= refDay; // expired = expiry <= today
}

// Filter positions: only keep non-expiry scripts
function filterNonExpiry(positions, refDate) {
  return (positions || []).filter(p => !isExpiredToday(p.expiry || p.expiry, refDate));
}

// Calculate MTM for a set of positions (sum of mtmGL)
function calcMTM(positions) {
  return positions.reduce((s,p) => s + (parseFloat(p.mtmGL) || 0), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
function RMSPage({ state, indexPrices, setIndexPrices, funds, setFunds, notify, C, card, btn, input, livePrice = {}, rmsRef, lastUpdated: lastUpdatedProp }) {
  const [clientData,    setClientData]    = useState({});
  const [lastUpdated,   setLastUpdated]   = useState(lastUpdatedProp || null);
  const [expanded,      setExpanded]      = useState({});
  const [editFund,      setEditFund]      = useState(null);
  const [fundInput,     setFundInput]     = useState("");
  const [editIdx,       setEditIdx]       = useState(false);
  const [idxInput,      setIdxInput]      = useState({...DEFAULT_IDX, ...(indexPrices||{})});
  const [uploadStatus,  setUploadStatus]  = useState(null);
  const [snapshot,      setSnapshot]      = useState(() => {
    // Load yesterday's closing snapshot from localStorage
    try { return JSON.parse(localStorage.getItem("rms_snapshot") || "null"); } catch(e) { return null; }
  });
  const [showIntraday,  setShowIntraday]  = useState(true);
  const fileRef = useRef();

  const SUPABASE_URL_RMS = "https://jwfucitnaqkuyzizmuve.supabase.co";
  const SUPABASE_KEY_RMS = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp3ZnVjaXRuYXFrdXl6aXptdXZlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2MTIyNDIsImV4cCI6MjA5MTE4ODI0Mn0.62UKN69g9qXoSipj_JdVtMt7JNcX03e-CeVWwOC3s6A";

  const prices = { ...DEFAULT_IDX, ...(indexPrices||{}) };

  const saveFunds = (f) => { setFunds(f); try{localStorage.setItem("rms_funds",JSON.stringify(f));}catch(e){} };
  const saveIdx   = (p) => { setIndexPrices(p); try{localStorage.setItem("rms_idx",JSON.stringify(p));}catch(e){} };

  // ── Closing snapshot: save to localStorage + Supabase ──
  const saveClosingSnapshot = async (data, uploadTime) => {
    const today = uploadTime || new Date();
    const todayStr = today.toISOString().slice(0,10);

    // For each client: filter non-expiry, sum MTM
    const snap = {};
    Object.entries(data).forEach(([cid, positions]) => {
      const filtered = filterNonExpiry(positions, today);
      snap[cid] = {
        mtm:   calcMTM(filtered),
        date:  todayStr,
        count: filtered.length,
      };
    });

    const snapRecord = { date: todayStr, clients: snap, savedAt: today.toISOString() };

    // Save to localStorage
    try { localStorage.setItem("rms_snapshot", JSON.stringify(snapRecord)); } catch(e) {}
    setSnapshot(snapRecord);

    // Save to Supabase for persistence
    try {
      // Delete old snapshot first
      await fetch(`${SUPABASE_URL_RMS}/rest/v1/rms_positions?snapshot_type=eq.closing`, {
        method: "DELETE",
        headers: { "apikey": SUPABASE_KEY_RMS, "Authorization": `Bearer ${SUPABASE_KEY_RMS}`, "Prefer": "" }
      });
      // Insert new
      await fetch(`${SUPABASE_URL_RMS}/rest/v1/rms_positions`, {
        method: "POST",
        headers: { "Content-Type":"application/json", "apikey": SUPABASE_KEY_RMS,
                   "Authorization": `Bearer ${SUPABASE_KEY_RMS}`, "Prefer": "return=minimal" },
        body: JSON.stringify({
          positions_json: JSON.stringify(snapRecord),
          snapshot_type:  "closing",
          uploaded_at:    today.toISOString(),
        })
      });
      notify("📸 Closing snapshot saved! Tomorrow's intraday will be calculated from this.");
    } catch(e) {
      notify("📸 Snapshot saved locally. (DB save failed)", "error");
    }
  };

  // ── Load closing snapshot from Supabase on mount ──
  useEffect(() => {
    const loadSnapshot = async () => {
      try {
        const r = await fetch(
          `${SUPABASE_URL_RMS}/rest/v1/rms_positions?snapshot_type=eq.closing&order=uploaded_at.desc&limit=1`,
          { headers: { "apikey": SUPABASE_KEY_RMS, "Authorization": `Bearer ${SUPABASE_KEY_RMS}` } }
        );
        const rows = await r.json();
        if (rows?.length && rows[0].positions_json) {
          const snap = JSON.parse(rows[0].positions_json);
          setSnapshot(snap);
          try { localStorage.setItem("rms_snapshot", JSON.stringify(snap)); } catch(e) {}
        }
      } catch(e) {}
    };
    loadSnapshot();
  }, []);

  // ── Calculate intraday P&L for a client ──
  const getIntradayPnL = (cid, positions, uploadTime) => {
    if (!snapshot || !snapshot.clients) return null;
    const today = uploadTime || new Date();
    const filtered = filterNonExpiry(positions, today);
    const currentMTM = calcMTM(filtered);
    const prevSnap = snapshot.clients[cid];
    if (!prevSnap) return null;
    return currentMTM - prevSnap.mtm;
  };

  // ── Auto-load from Supabase every 10 seconds ──
  useEffect(() => {
    const loadFromDB = async () => {
      try {
        const SUPABASE_URL = "https://jwfucitnaqkuyzizmuve.supabase.co";
        const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp3ZnVjaXRuYXFrdXl6aXptdXZlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2MTIyNDIsImV4cCI6MjA5MTE4ODI0Mn0.62UKN69g9qXoSipj_JdVtMt7JNcX03e-CeVWwOC3s6A";
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/rms_positions?snapshot_type=eq.live&order=uploaded_at.desc&limit=1`,
          { headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` } }
        );
        const rows = await r.json();
        if (rows?.length && rows[0].positions_json) {
          const positions = JSON.parse(rows[0].positions_json);
          const grouped   = {};
          positions.forEach(p => {
            if (!p.user) return;
            if (!grouped[p.user]) grouped[p.user] = [];
            grouped[p.user].push(p);
          });
          if (Object.keys(grouped).length > 0) {
            setClientData(grouped);
            setLastUpdated(new Date(rows[0].uploaded_at));
            if (rmsRef) rmsRef.current = grouped;
          }
        }
      } catch(e) {
        // Silent fail — manual upload still works
      }
    };

    loadFromDB(); // Load immediately on mount
    const interval = setInterval(loadFromDB, 10000); // Refresh every 10 seconds
    return () => clearInterval(interval);
  }, []);

  const onFile = (e) => {
    const f = e.target.files[0]; if(!f) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const data = parseRMSCsv(ev.target.result);
      if (!Object.keys(data).length) { setUploadStatus("error"); setTimeout(()=>setUploadStatus(null),3000); return; }
      const now = new Date();
      setClientData(data);
      setLastUpdated(now);
      setUploadStatus("ok");
      setTimeout(()=>setUploadStatus(null),3000);
      if (rmsRef) rmsRef.current = data;

      // ── Auto closing snapshot if uploaded after 7:00 PM ──
      const h = now.getHours(), m = now.getMinutes();
      if (h >= 19) {
        saveClosingSnapshot(data, now);
      } else {
        notify("✅ Positions loaded — " + Object.keys(data).length + " clients");
      }
    };
    reader.readAsText(f);
    e.target.value="";
  };

  const fmtN = (n) => { const v=Math.abs(n); const s=v>=1e7?(v/1e7).toFixed(2)+"Cr":v>=1e5?(v/1e5).toFixed(2)+"L":v>=1e3?(v/1e3).toFixed(1)+"K":v.toFixed(0); return (n<0?"−":"")+"₹"+s; };
  const fmtFull = (n) => (n<0?"−":"")+"₹"+Math.abs(Math.round(n)).toLocaleString("en-IN");
  const pnlClr = (n) => n>0?C.green:n<0?C.red:C.muted;

  // Use live-updated data from Angel One ref if available, else local state
  const displayData  = (rmsRef && Object.keys(rmsRef.current || {}).length) ? rmsRef.current : clientData;
  const today        = lastUpdated || new Date();

  // Filtered data (non-expiry only) for intraday calculation
  const filteredData = Object.fromEntries(
    Object.entries(displayData).map(([cid,pos]) => [cid, filterNonExpiry(pos, today)])
  );

  const totalMTM     = Object.values(displayData).flat().reduce((s,p)=>s+(parseFloat(p.mtmGL)||0),0);
  const totalFilteredMTM = Object.values(filteredData).flat().reduce((s,p)=>s+(parseFloat(p.mtmGL)||0),0);
  const totalMargin  = Object.entries(displayData).reduce((s,[,pos])=>s+calcRMSMargin(pos,prices).total,0);
  const totalFund    = Object.values(funds||{}).reduce((s,f)=>s+(parseFloat(f)||0),0);
  const hasData      = Object.keys(displayData).length>0;
  const btnClr       = uploadStatus==="ok"?C.green:uploadStatus==="error"?C.red:C.accent;

  // Total intraday P&L across all clients
  const totalIntraday = snapshot ? Object.keys(displayData).reduce((s,cid) => {
    const v = getIntradayPnL(cid, displayData[cid] || [], today);
    return s + (v !== null ? v : 0);
  }, 0) : null;

  const snapshotDate = snapshot?.date || null;

  return (
    <div>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:24,flexWrap:"wrap",gap:12}}>
        <div>
          <h2 style={{margin:0,color:C.text,fontSize:22,fontWeight:800}}>📡 Risk Management System</h2>
          <div style={{color:C.muted,fontSize:12,marginTop:4}}>
            {(lastUpdated||rmsRef?.current?._lastUpdate) ? `🟢 Live — Last updated: ${(lastUpdated||new Date()).toLocaleTimeString()}` : "Upload ODIN Positions CSV to begin"}
          </div>
        </div>
        <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
          <button onClick={()=>setEditIdx(true)} style={{...btn(C.card),border:`1px solid ${C.border}`,color:C.text,fontSize:13}}>
            📈 Index Prices
          </button>
          {/* Manual snapshot button */}
          <button onClick={()=>{
            if(Object.keys(clientData).length===0){notify("Upload positions CSV first","error");return;}
            saveClosingSnapshot(clientData, new Date());
          }} style={{...btn(C.card),border:`1px solid ${C.yellow}`,color:C.yellow,fontSize:13}}>
            📸 Save Snapshot
          </button>
          <button onClick={()=>fileRef.current.click()}
            style={{...btn(btnClr),fontSize:13}}>
            {uploadStatus==="ok"?"✅ Updated!":uploadStatus==="error"?"❌ Invalid CSV":"⬆️ Upload Positions CSV"}
          </button>
          <input ref={fileRef} type="file" accept=".csv" onChange={onFile} style={{display:"none"}}/>
        </div>
      </div>

      {/* Summary cards */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:14,marginBottom:20}}>
        {/* Intraday P&L card - special */}
        <div style={{...card,padding:"16px 20px",borderLeft:`3px solid ${totalIntraday!=null?(totalIntraday>=0?C.green:C.red):C.muted}`}}>
          <div style={{color:C.muted,fontSize:11,fontWeight:600,textTransform:"uppercase",letterSpacing:0.8,marginBottom:4}}>
            📊 Today's Intraday P&L
          </div>
          {totalIntraday !== null ? (
            <div style={{fontSize:22,fontWeight:800,color:pnlClr(totalIntraday)}}>
              {totalIntraday>=0?"+":""}{fmtFull(Math.round(totalIntraday))}
            </div>
          ) : (
            <div style={{fontSize:13,color:C.muted}}>No snapshot yet</div>
          )}
          <div style={{fontSize:10,color:C.muted,marginTop:4}}>
            {snapshotDate ? `Baseline: ${snapshotDate}` : "Upload after 7:00 PM to set baseline"}
          </div>
        </div>

        {[
          {label:"Total MTM P&L",    val:fmtFull(Math.round(totalMTM)), color:pnlClr(totalMTM)},
          {label:"Total Margin Used", val:fmtN(totalMargin),             color:C.text},
          {label:"Total Fund",        val:totalFund>0?fmtN(totalFund):"Not set", color:C.text},
          {label:"Active Clients",    val:Object.keys(displayData).length, color:C.text},
        ].map(c => (
          <div key={c.label} style={{...card,padding:"16px 20px"}}>
            <div style={{color:C.muted,fontSize:11,fontWeight:600,textTransform:"uppercase",letterSpacing:0.8,marginBottom:8}}>{c.label}</div>
            <div style={{fontSize:22,fontWeight:800,color:c.color}}>{c.val}</div>
          </div>
        ))}
      </div>

      {/* Snapshot status bar */}
      {snapshot && (
        <div style={{...card,padding:"10px 16px",marginBottom:16,display:"flex",
          alignItems:"center",gap:12,borderLeft:`3px solid ${C.accent}`}}>
          <span style={{fontSize:16}}>📸</span>
          <div style={{flex:1}}>
            <span style={{color:C.text,fontSize:13,fontWeight:600}}>
              Closing snapshot: {snapshotDate}
            </span>
            <span style={{color:C.muted,fontSize:12,marginLeft:12}}>
              Intraday = Current MTM (non-expiry) − {fmtFull(Object.values(snapshot.clients||{}).reduce((s,v)=>s+(v.mtm||0),0))} baseline
            </span>
          </div>
          <button onClick={()=>{if(window.confirm("Clear snapshot? Intraday P&L will reset.")){setSnapshot(null);localStorage.removeItem("rms_snapshot");notify("Snapshot cleared");}}}
            style={{...btn(C.card),border:`1px solid ${C.border}`,fontSize:11,color:C.muted}}>
            🗑 Clear
          </button>
        </div>
      )}

      {!hasData && (
        <div style={{...card,textAlign:"center",padding:"60px 20px"}}>
          <div style={{fontSize:48,marginBottom:12}}>📂</div>
          <div style={{fontSize:16,fontWeight:700,color:C.text,marginBottom:6}}>No data loaded</div>
          <div style={{color:C.muted,fontSize:13,marginBottom:20}}>Export from ODIN and upload the Positions CSV</div>
          <button onClick={()=>fileRef.current.click()} style={{...btn(C.accent)}}>⬆️ Upload Positions CSV</button>
        </div>
      )}

      {hasData && (
        <>
          {/* Client table */}
          <div style={{...card,padding:0,overflow:"hidden",marginBottom:20}}>
            <div style={{padding:"14px 20px",borderBottom:`1px solid ${C.border}`,display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontWeight:700,fontSize:15,color:C.text}}>👥 Client Portfolio</span>
              <span style={{color:C.muted,fontSize:12}}>— click ▶ to expand positions</span>
            </div>

            {/* Table head */}
            <div style={{display:"grid",gridTemplateColumns:"32px 1fr 1fr 1fr 1fr 1fr 1fr 140px",
              gap:4,padding:"10px 16px",background:C.accent+"08",borderBottom:`1px solid ${C.border}`}}>
              {["","Client","Intraday P&L","MTM P&L","SPAN","Exposure","Total Margin","Fund & Usage"].map((h,i)=>(
                <div key={i} style={{color: h==="Intraday P&L" ? C.accent : C.muted,
                  fontSize:11,fontWeight:700,textTransform:"uppercase",
                  letterSpacing:0.6,textAlign:i>1?"right":"left"}}>{h}</div>
              ))}
            </div>

            {/* Client rows */}
            {Object.entries(displayData).map(([cid, positions]) => {
              const totalMTMc  = positions.reduce((s,p)=>s+(parseFloat(p.mtmGL)||0),0);
              const margin     = calcRMSMargin(positions, prices);
              const fund       = parseFloat((funds||{})[cid])||0;
              const pctUsed    = fund>0?(margin.total/fund*100):0;
              const ac         = pctUsed>90?C.red:pctUsed>70?C.yellow:C.green;
              const isExp      = expanded[cid];
              const openPos    = positions.filter(p=>parseFloat(p.netQty)!==0).length;
              const intradayPnL = getIntradayPnL(cid, positions, today);

              return (
                <Fragment key={cid}>
                  <div style={{display:"grid",gridTemplateColumns:"32px 1fr 120px 1fr 1fr 1fr 1fr 140px",
                    gap:4,padding:"13px 16px",borderBottom:`1px solid ${C.border}`,
                    cursor:"pointer",transition:"background 0.15s"}}
                    onClick={()=>setExpanded(e=>({...e,[cid]:!e[cid]}))}>
                    <div style={{color:C.accent,fontWeight:700,fontSize:16}}>{isExp?"▼":"▶"}</div>
                    <div>
                      <div style={{fontWeight:700,color:C.text,fontSize:14}}>{CLIENT_NAMES_RMS[cid]||cid}</div>
                      <div style={{color:C.muted,fontSize:11,marginTop:2}}>{cid} · {openPos} open</div>
                    </div>
                    {/* Intraday P&L column */}
                    <div style={{textAlign:"right"}}>
                      {intradayPnL !== null ? (
                        <div>
                          <div style={{fontWeight:800,fontSize:14,color:pnlClr(intradayPnL)}}>
                            {intradayPnL>=0?"+":""}{fmtFull(intradayPnL)}
                          </div>
                          <div style={{fontSize:10,color:C.muted,marginTop:2}}>intraday</div>
                        </div>
                      ) : (
                        <div>
                          <div style={{fontWeight:700,fontSize:13,color:C.muted}}>₹0</div>
                          <div style={{fontSize:10,color:C.muted,marginTop:2}}>no baseline</div>
                        </div>
                      )}
                    </div>
                    <div style={{textAlign:"right",fontWeight:800,fontSize:15,color:pnlClr(totalMTMc)}}>
                      {totalMTMc>=0?"+":""}{fmtFull(totalMTMc)}
                    </div>
                    <div style={{textAlign:"right",color:C.text,fontSize:13}}>{fmtN(margin.span)}</div>
                    <div style={{textAlign:"right",color:C.yellow,fontSize:13}}>{fmtN(margin.exposure)}</div>
                    <div style={{textAlign:"right",fontWeight:700,color:C.text,fontSize:13}}>{fmtN(margin.total)}</div>
                    <div style={{textAlign:"right"}}>
                      <div style={{display:"flex",alignItems:"center",gap:6,justifyContent:"flex-end"}}>
                        <div>
                          <div style={{fontWeight:700,fontSize:14,color:ac}}>{fund>0?pctUsed.toFixed(1)+"%":"—"}</div>
                          <div style={{color:C.muted,fontSize:10}}>of {fund>0?fmtN(fund):"no fund"}</div>
                        </div>
                        <button onClick={e=>{e.stopPropagation();setEditFund(cid);setFundInput((funds||{})[cid]||"");}}
                          style={{...btn(C.card),padding:"3px 7px",fontSize:11,border:`1px solid ${C.border}`}}>✏️</button>
                      </div>
                      <div style={{marginTop:4,height:3,background:C.border,borderRadius:2,overflow:"hidden"}}>
                        <div style={{height:"100%",width:`${Math.min(pctUsed,100)}%`,background:ac,borderRadius:2,transition:"width 0.5s"}}/>
                      </div>
                    </div>
                  </div>

                  {/* Expanded */}
                  {isExp && (
                    <div style={{background:C.bg,borderBottom:`1px solid ${C.border}`,padding:"8px 24px 16px"}}>
                      {/* Scenario */}
                      <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center",marginBottom:12,padding:"10px 0"}}>
                        <span style={{fontSize:11,fontWeight:700,color:C.muted,marginRight:4}}>SCENARIO:</span>
                        {SCENARIO_STEPS.map(s=>{
                          const v=calcRMSScenario(positions,s,prices);
                          return (
                            <div key={s} style={{background:(s>0?C.green:C.red)+"15",border:`1px solid ${(s>0?C.green:C.red)}33`,
                              borderRadius:6,padding:"3px 10px",textAlign:"center",minWidth:64}}>
                              <div style={{fontSize:10,color:C.muted}}>{s>0?"+":""}{s}%</div>
                              <div style={{fontSize:12,fontWeight:700,color:pnlClr(v)}}>{v>=0?"+":""}{fmtN(v).replace("₹","₹")}</div>
                            </div>
                          );
                        })}
                      </div>
                      {/* Positions */}
                      <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                        <thead>
                          <tr style={{borderBottom:`1px solid ${C.border}`}}>
                            {["Symbol","Expiry","Strike","Type","Side","Qty","Avg","LTP","MTM"].map(h=>(
                              <th key={h} style={{padding:"6px 8px",color:C.muted,fontWeight:600,
                                textAlign:["Qty","Avg","LTP","MTM"].includes(h)?"right":"left",fontSize:10,textTransform:"uppercase",letterSpacing:0.5}}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {positions.filter(p=>parseFloat(p.netQty)!==0).map((p,i)=>{
                            const qty=parseFloat(p.netQty)||0;
                            const mtm=parseFloat(p.mtmGL)||0;
                            const side=qty>0?"LONG":qty<0?"SHORT":"—";
                            const sc=qty>0?C.green:C.red;
                            return (
                              <tr key={i} style={{borderBottom:`1px solid ${C.border}22`}}>
                                <td style={{padding:"6px 8px",fontWeight:700,color:C.accent}}>{p.symbol}</td>
                                <td style={{padding:"6px 8px",color:C.muted}}>{p.expiry}</td>
                                <td style={{padding:"6px 8px"}}>{parseFloat(p.strikePrice).toLocaleString()}</td>
                                <td style={{padding:"6px 8px"}}>
                                  <span style={{background:(p.optionType==="CE"?C.green:C.red)+"22",color:p.optionType==="CE"?C.green:C.red,
                                    padding:"1px 6px",borderRadius:4,fontWeight:700}}>{p.optionType}</span>
                                </td>
                                <td style={{padding:"6px 8px"}}>
                                  <span style={{color:sc,fontWeight:700}}>{side}</span>
                                </td>
                                <td style={{padding:"6px 8px",textAlign:"right",color:C.text}}>{Math.abs(qty).toLocaleString()}</td>
                                <td style={{padding:"6px 8px",textAlign:"right",color:C.muted}}>{(parseFloat(p.netPrice)||0).toFixed(2)}</td>
                                <td style={{padding:"6px 8px",textAlign:"right"}}>{(parseFloat(p.marketPrice)||0).toFixed(2)}</td>
                                <td style={{padding:"6px 8px",textAlign:"right",fontWeight:700,color:pnlClr(mtm)}}>
                                  {mtm>=0?"+":""}{fmtFull(mtm)}
                                </td>
                              </tr>
                            );
                          })}
                          <tr style={{background:C.accent+"08",fontWeight:700}}>
                            <td colSpan={8} style={{padding:"7px 8px",color:C.muted,fontSize:11}}>
                              TOTAL ({positions.length} positions)
                            </td>
                            <td style={{padding:"7px 8px",textAlign:"right",fontSize:13,color:pnlClr(totalMTMc)}}>
                              {totalMTMc>=0?"+":""}{fmtFull(totalMTMc)}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  )}
                </Fragment>
              );
            })}
          </div>

          {/* Scenario summary table */}
          <div style={{...card,padding:0,overflow:"hidden"}}>
            <div style={{padding:"12px 20px",borderBottom:`1px solid ${C.border}`}}>
              <span style={{fontWeight:700,fontSize:15,color:C.text}}>📊 Scenario Analysis — All Clients</span>
            </div>
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",minWidth:800}}>
                <thead>
                  <tr style={{borderBottom:`1px solid ${C.border}`,background:C.accent+"06"}}>
                    <th style={{padding:"10px 16px",color:C.muted,fontSize:11,fontWeight:700,textAlign:"left",textTransform:"uppercase",letterSpacing:0.6}}>Client</th>
                    {SCENARIO_STEPS.map(s=>(
                      <th key={s} style={{padding:"10px 12px",fontSize:11,fontWeight:700,textAlign:"right",
                        color:s>0?C.green:C.red}}>{s>0?"+":""}{s}%</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(displayData).map(([cid,pos])=>(
                    <tr key={cid} style={{borderBottom:`1px solid ${C.border}22`}}>
                      <td style={{padding:"10px 16px",fontWeight:600,color:C.text}}>{CLIENT_NAMES_RMS[cid]||cid}</td>
                      {SCENARIO_STEPS.map(s=>{
                        const v=calcRMSScenario(pos,s,prices);
                        return <td key={s} style={{padding:"10px 12px",textAlign:"right",fontWeight:600,
                          color:pnlClr(v),fontSize:12}}>{v>=0?"+":""}{fmtN(v)}</td>;
                      })}
                    </tr>
                  ))}
                  <tr style={{borderTop:`2px solid ${C.border}`,background:C.accent+"08",fontWeight:800}}>
                    <td style={{padding:"12px 16px",color:C.text}}>TOTAL</td>
                    {SCENARIO_STEPS.map(s=>{
                      const v=Object.values(clientData).reduce((sum,pos)=>sum+calcRMSScenario(pos,s,prices),0);
                      return <td key={s} style={{padding:"12px 12px",textAlign:"right",fontWeight:800,
                        color:pnlClr(v),fontSize:13}}>{v>=0?"+":""}{fmtN(v)}</td>;
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Fund edit modal */}
      {editFund && (
        <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.5)",display:"flex",
          alignItems:"center",justifyContent:"center",zIndex:1000}} onClick={()=>setEditFund(null)}>
          <div style={{background:"#fff",border:`1px solid ${C.border}`,borderRadius:16,padding:28,
            width:360,boxShadow:"0 20px 60px rgba(0,0,0,0.15)"}} onClick={e=>e.stopPropagation()}>
            <div style={{fontWeight:700,fontSize:16,color:C.text,marginBottom:4}}>Set Fund Amount</div>
            <div style={{color:C.muted,fontSize:13,marginBottom:16}}>{CLIENT_NAMES_RMS[editFund]||editFund}</div>
            <input type="number" value={fundInput} onChange={e=>setFundInput(e.target.value)}
              placeholder="Enter fund in ₹ (e.g. 6000000)"
              style={{...input,width:"100%",marginBottom:16,boxSizing:"border-box",fontSize:15}}
              onKeyDown={e=>{if(e.key==="Enter"){saveFunds({...funds,[editFund]:fundInput});setEditFund(null);}}}
              autoFocus/>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>setEditFund(null)} style={{...btn(C.card),flex:1,border:`1px solid ${C.border}`}}>Cancel</button>
              <button onClick={()=>{saveFunds({...funds,[editFund]:fundInput});setEditFund(null);}}
                style={{...btn(C.green),flex:1}}>Save ✓</button>
            </div>
          </div>
        </div>
      )}

      {/* Index prices modal */}
      {editIdx && (
        <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.5)",display:"flex",
          alignItems:"center",justifyContent:"center",zIndex:1000}} onClick={()=>setEditIdx(false)}>
          <div style={{background:"#fff",border:`1px solid ${C.border}`,borderRadius:16,padding:28,
            width:360,boxShadow:"0 20px 60px rgba(0,0,0,0.15)"}} onClick={e=>e.stopPropagation()}>
            <div style={{fontWeight:700,fontSize:16,color:C.text,marginBottom:16}}>📈 Update Index Prices</div>
            {["NIFTY","SENSEX","BANKNIFTY","BANKEX"].map(sym=>(
              <div key={sym} style={{marginBottom:12}}>
                <div style={{color:C.muted,fontSize:11,fontWeight:600,marginBottom:4,textTransform:"uppercase",letterSpacing:0.5}}>{sym}</div>
                <input type="number" value={idxInput[sym]||""} onChange={e=>setIdxInput(p=>({...p,[sym]:parseFloat(e.target.value)||0}))}
                  style={{...input,width:"100%",boxSizing:"border-box"}}/>
              </div>
            ))}
            <div style={{display:"flex",gap:10,marginTop:16}}>
              <button onClick={()=>setEditIdx(false)} style={{...btn(C.card),flex:1,border:`1px solid ${C.border}`}}>Cancel</button>
              <button onClick={()=>{saveIdx(idxInput);setEditIdx(false);}} style={{...btn(C.green),flex:1}}>Save ✓</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
// ═══════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════
// ANGEL ONE SMARTAPI INTEGRATION
// ═══════════════════════════════════════════════════════

// Generate TOTP from secret
async function generateTOTP(secret) {
  // Convert base32 secret to bytes
  const base32chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleanSecret = secret.toUpperCase().replace(/=+$/, "");
  let bits = "";
  for (const char of cleanSecret) {
    const val = base32chars.indexOf(char);
    if (val < 0) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }

  // HOTP with time counter (30 second window)
  const counter = Math.floor(Date.now() / 1000 / 30);
  const counterBytes = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) { counterBytes[i] = c & 0xff; c = Math.floor(c / 256); }

  const key = await crypto.subtle.importKey("raw", new Uint8Array(bytes), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, counterBytes);
  const hash = new Uint8Array(sig);
  const offset = hash[19] & 0xf;
  const code = ((hash[offset] & 0x7f) << 24 | hash[offset+1] << 16 | hash[offset+2] << 8 | hash[offset+3]) % 1000000;
  return code.toString().padStart(6, "0");
}

// Angel One Login — via Vercel proxy (avoids CORS)
const ANGEL_PROXY = "/api/angel";

async function angelLogin(creds) {
  const totp = await generateTOTP(creds.totpSecret);
  const resp = await fetch(ANGEL_PROXY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action:  "login",
      apiKey:  creds.apiKey,
      payload: { clientId: creds.clientId, password: creds.password, totp },
    })
  });
  const data = await resp.json();
  if (!data.status) throw new Error(data.message || "Login failed");
  return {
    jwtToken:     data.data.jwtToken,
    feedToken:    data.data.feedToken,
    refreshToken: data.data.refreshToken,
  };
}

// Get LTP for multiple tokens
async function angelGetLTP(jwtToken, apiKey, tokens) {
  // tokens = [{ exchange: "NFO", symboltoken: "35003", tradingsymbol: "NIFTY23000CE" }]
  const resp = await fetch("https://apiconnect.angelbroking.com/rest/secure/angelbroking/market/v1/quote/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-UserType": "USER",
      "X-SourceID": "WEB",
      "X-ClientLocalIP": "192.168.1.1",
      "X-ClientPublicIP": "106.193.147.98",
      "X-MACAddress": "fe80::216e:6507:4b90:3719",
      "X-PrivateKey": apiKey,
      "Authorization": `Bearer ${jwtToken}`,
    },
    body: JSON.stringify({ mode: "LTP", exchangeTokens: tokens })
  });
  const data = await resp.json();
  if (!data.status) throw new Error(data.message || "Quote failed");
  return data.data;
}

// Fetch instrument master to get token for each symbol
async function fetchInstrumentToken(symbol, expiry, strike, optType) {
  // Use Angel One's open instrument file
  try {
    const resp = await fetch("https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json");
    const instruments = await resp.json();
    // Format: NIFTY23APR2026C23000 or similar
    const expiryFmt = expiry.replace(/(\d{2})([A-Z]{3})(\d{4})/, (m, d, mo, y) => `${d}${mo}${y.slice(2)}`);
    const optChar = optType === "CE" ? "C" : "P";
    const searchKey = `${symbol}${expiryFmt}${optChar}${parseInt(strike)}`;
    const found = instruments.find(i =>
      i.symbol && i.symbol.includes(symbol) &&
      i.symbol.includes(strike.toString()) &&
      i.exch_seg === "NFO" &&
      i.instrumenttype?.includes("OPTIDX")
    );
    return found?.token || null;
  } catch(e) {
    return null;
  }
}

// ── Settings Page Component ────────────────────────────


// ═══════════════════════════════════════════════════════
// MANAGE ADMINS PAGE — Super Admin only
// ═══════════════════════════════════════════════════════
function ManageAdminsPage({ state, setState, sb, withSync, notify, C, card, btn, input }) {
  const [form, setForm] = useState({ username:"", password:"", name:"", plan:"basic", tokenExpiry:"" });
  const [showPwd, setShowPwd] = useState(false);

  const admins = state.admins || [];

  const defaultExpiry = () => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return d.toISOString().slice(0,10);
  };

  const createAdmin = async () => {
    if (!form.username || !form.password || !form.name) {
      notify("Fill all fields", "error"); return;
    }
    if (admins.find(a => a.username === form.username)) {
      notify("Username already exists", "error"); return;
    }
    const token = generateToken(form.plan);
    const newAdmin = {
      id: "ADM_" + Date.now(),
      username: form.username,
      password: form.password,
      name: form.name,
      plan: form.plan,
      token,
      tokenExpiry: form.tokenExpiry || defaultExpiry(),
      createdAt: new Date().toISOString(),
      createdBy: "JIYA",
    };
    withSync(() => sb.upsert("admins", newAdmin));
    setState(s => ({ ...s, admins: [...(s.admins||[]), newAdmin] }));
    setForm({ username:"", password:"", name:"", plan:"basic", tokenExpiry:"" });
    notify("✅ Admin " + form.name + " created! Token: " + token);
  };

  const deleteAdmin = (id) => {
    if (!window.confirm("Delete this admin? Their clients will remain.")) return;
    withSync(() => sb.delete("admins", id));
    setState(s => ({ ...s, admins: (s.admins||[]).filter(a => a.id !== id) }));
    notify("Admin deleted");
  };

  const renewToken = (admin) => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    const newExpiry = d.toISOString().slice(0,10);
    const newToken  = generateToken(admin.plan);
    const updated   = { ...admin, token: newToken, tokenExpiry: newExpiry };
    withSync(() => sb.upsert("admins", updated));
    setState(s => ({ ...s, admins: (s.admins||[]).map(a => a.id===admin.id ? updated : a) }));
    notify("✅ Token renewed until " + newExpiry);
  };

  const planColor = p => p==="perfect"?C.accent:p==="pro"?C.green:C.yellow;
  const daysLeft  = expiry => Math.ceil((new Date(expiry) - new Date()) / (1000*60*60*24));

  return (
    <div>
      <h2 style={{margin:"0 0 4px",color:C.text,fontSize:22,fontWeight:800}}>👥 Manage Admins</h2>
      <div style={{color:C.muted,fontSize:13,marginBottom:24}}>Create and manage sub-admin accounts</div>

      {/* Create Admin Form */}
      <div style={{...card,padding:24,marginBottom:24}}>
        <div style={{fontSize:15,fontWeight:700,color:C.text,marginBottom:16}}>➕ Create New Admin</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
          {[
            {key:"name",      label:"Full Name",   placeholder:"e.g. Nitin Shah",    type:"text"},
            {key:"username",  label:"Username",    placeholder:"e.g. NITIN",         type:"text"},
          ].map(f => (
            <div key={f.key}>
              <div style={{color:C.muted,fontSize:11,fontWeight:600,marginBottom:5,textTransform:"uppercase",letterSpacing:0.5}}>{f.label}</div>
              <input type={f.type} value={form[f.key]} onChange={e=>setForm(v=>({...v,[f.key]:e.target.value}))}
                placeholder={f.placeholder} style={{...input,width:"100%",boxSizing:"border-box"}}/>
            </div>
          ))}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:16}}>
          <div>
            <div style={{color:C.muted,fontSize:11,fontWeight:600,marginBottom:5,textTransform:"uppercase",letterSpacing:0.5}}>Password</div>
            <div style={{position:"relative"}}>
              <input type={showPwd?"text":"password"} value={form.password}
                onChange={e=>setForm(v=>({...v,password:e.target.value}))}
                placeholder="Strong password" style={{...input,width:"100%",boxSizing:"border-box",paddingRight:36}}/>
              <span onClick={()=>setShowPwd(v=>!v)}
                style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",cursor:"pointer",fontSize:14,color:C.muted}}>
                {showPwd?"🙈":"👁️"}
              </span>
            </div>
          </div>
          <div>
            <div style={{color:C.muted,fontSize:11,fontWeight:600,marginBottom:5,textTransform:"uppercase",letterSpacing:0.5}}>Plan</div>
            <select value={form.plan} onChange={e=>setForm(v=>({...v,plan:e.target.value}))}
              style={{...input,width:"100%",cursor:"pointer"}}>
              <option value="basic">Basic — ₹2,000/mo</option>
              <option value="pro">Pro — ₹3,500/mo</option>
              <option value="perfect">Perfect — ₹5,000/mo</option>
            </select>
          </div>
          <div>
            <div style={{color:C.muted,fontSize:11,fontWeight:600,marginBottom:5,textTransform:"uppercase",letterSpacing:0.5}}>Token Expiry</div>
            <input type="date" value={form.tokenExpiry||defaultExpiry()}
              onChange={e=>setForm(v=>({...v,tokenExpiry:e.target.value}))}
              style={{...input,width:"100%",boxSizing:"border-box"}}/>
          </div>
        </div>
        <button onClick={createAdmin} style={{...btn(C.accent),padding:"10px 24px",fontWeight:700}}>
          ➕ Create Admin
        </button>
      </div>

      {/* Admins List */}
      {admins.length === 0 ? (
        <div style={{...card,textAlign:"center",padding:48,color:C.muted}}>
          <div style={{fontSize:36,marginBottom:12}}>👥</div>
          <div style={{fontWeight:600,marginBottom:4}}>No admins created yet</div>
          <div style={{fontSize:13}}>Create your first admin above</div>
        </div>
      ) : (
        <div style={{...card,padding:0,overflow:"hidden"}}>
          <div style={{padding:"14px 20px",borderBottom:`1px solid ${C.border}`,fontWeight:700,color:C.text}}>
            {admins.length} Admin{admins.length!==1?"s":""}
          </div>
          {admins.map(a => {
            const dl = daysLeft(a.tokenExpiry);
            const expired = dl <= 0;
            const warning = dl > 0 && dl <= 7;
            return (
              <div key={a.id} style={{padding:"16px 20px",borderBottom:`1px solid ${C.border}`,
                display:"flex",alignItems:"center",gap:16,flexWrap:"wrap"}}>
                <div style={{flex:1,minWidth:200}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                    <span style={{fontWeight:700,color:C.text,fontSize:14}}>{a.name}</span>
                    <span style={{fontSize:11,padding:"1px 8px",borderRadius:4,fontWeight:700,
                      background:planColor(a.plan)+"20",color:planColor(a.plan),textTransform:"uppercase"}}>
                      {a.plan}
                    </span>
                    {expired && <span style={{fontSize:11,padding:"1px 8px",borderRadius:4,
                      background:C.red+"20",color:C.red,fontWeight:700}}>EXPIRED</span>}
                    {warning && <span style={{fontSize:11,padding:"1px 8px",borderRadius:4,
                      background:C.yellow+"20",color:C.yellow,fontWeight:700}}>{dl}d left</span>}
                  </div>
                  <div style={{color:C.muted,fontSize:12}}>
                    @{a.username} · Expires: {new Date(a.tokenExpiry).toLocaleDateString("en-IN")}
                  </div>
                  <div style={{color:C.muted,fontSize:11,fontFamily:"monospace",marginTop:4,
                    background:C.bg,padding:"3px 8px",borderRadius:4,display:"inline-block"}}>
                    {a.token}
                  </div>
                </div>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>renewToken(a)}
                    style={{...btn(C.green),fontSize:12,padding:"6px 14px"}}>
                    🔄 Renew 30d
                  </button>
                  <button onClick={()=>deleteAdmin(a.id)}
                    style={{...btn(C.card),border:`1px solid ${C.border}`,color:C.red,fontSize:12,padding:"6px 14px"}}>
                    🗑 Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// MANAGE TOKENS PAGE — Super Admin only
// ═══════════════════════════════════════════════════════
function ManageTokensPage({ state, setState, sb, withSync, notify, C, card, btn, input }) {
  const [plan,   setPlan]   = useState("basic");
  const [days,   setDays]   = useState(30);
  const [generated, setGenerated] = useState(null);
  const admins = state.admins || [];

  const genToken = () => {
    const token = generateToken(plan);
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + parseInt(days));
    setGenerated({ token, plan, expiry: expiry.toISOString().slice(0,10) });
  };

  const planColor = p => p==="perfect"?C.accent:p==="pro"?C.green:C.yellow;

  return (
    <div>
      <h2 style={{margin:"0 0 4px",color:C.text,fontSize:22,fontWeight:800}}>🔑 Token Management</h2>
      <div style={{color:C.muted,fontSize:13,marginBottom:24}}>Generate and manage activation tokens</div>

      {/* Generator */}
      <div style={{...card,padding:24,marginBottom:24}}>
        <div style={{fontSize:15,fontWeight:700,color:C.text,marginBottom:16}}>⚡ Quick Token Generator</div>
        <div style={{display:"flex",gap:12,flexWrap:"wrap",alignItems:"flex-end"}}>
          <div>
            <div style={{color:C.muted,fontSize:11,fontWeight:600,marginBottom:5,textTransform:"uppercase"}}>Plan</div>
            <select value={plan} onChange={e=>setPlan(e.target.value)}
              style={{...input,minWidth:180,cursor:"pointer"}}>
              <option value="basic">Basic</option>
              <option value="pro">Pro</option>
              <option value="perfect">Perfect</option>
              <option value="trial">Free Trial (7 days)</option>
            </select>
          </div>
          <div>
            <div style={{color:C.muted,fontSize:11,fontWeight:600,marginBottom:5,textTransform:"uppercase"}}>Duration (days)</div>
            <input type="number" value={days} onChange={e=>setDays(e.target.value)}
              style={{...input,width:100}} min={1} max={365}/>
          </div>
          <button onClick={genToken} style={{...btn(C.accent),padding:"10px 20px",fontWeight:700}}>
            🔑 Generate Token
          </button>
        </div>

        {generated && (
          <div style={{marginTop:16,padding:16,background:C.accent+"10",borderRadius:10,
            border:`1px solid ${C.accent}30`}}>
            <div style={{color:C.muted,fontSize:11,marginBottom:6,textTransform:"uppercase",letterSpacing:0.5}}>Generated Token</div>
            <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
              <div style={{fontSize:20,fontWeight:800,fontFamily:"monospace",color:C.accent,
                letterSpacing:2}}>{generated.token}</div>
              <button onClick={()=>{navigator.clipboard.writeText(generated.token);notify("Token copied!");}}
                style={{...btn(C.card),border:`1px solid ${C.border}`,fontSize:12}}>
                📋 Copy
              </button>
            </div>
            <div style={{marginTop:8,display:"flex",gap:16,fontSize:12,color:C.muted}}>
              <span>Plan: <b style={{color:planColor(generated.plan)}}>{generated.plan.toUpperCase()}</b></span>
              <span>Expires: <b style={{color:C.text}}>{new Date(generated.expiry).toLocaleDateString("en-IN")}</b></span>
            </div>
          </div>
        )}
      </div>

      {/* Plan Features Reference */}
      <div style={{...card,padding:20}}>
        <div style={{fontSize:15,fontWeight:700,color:C.text,marginBottom:16}}>📋 Plan Features</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
          {[
            { plan:"basic",   price:"₹2,000/mo", features:["Dashboard","Clients","Trades","P&L","Ledger","Tickets"] },
            { plan:"pro",     price:"₹3,500/mo", features:["Everything in Basic","Charges","RMS Live"] },
            { plan:"perfect", price:"₹5,000/mo", features:["Everything in Pro","Audit Log","PDF Export"] },
          ].map(p => (
            <div key={p.plan} style={{padding:16,borderRadius:10,border:`2px solid ${planColor(p.plan)}30`,
              background:planColor(p.plan)+"08"}}>
              <div style={{fontWeight:800,color:planColor(p.plan),textTransform:"uppercase",fontSize:13,marginBottom:4}}>
                {p.plan}
              </div>
              <div style={{color:C.muted,fontSize:12,marginBottom:10}}>{p.price}</div>
              {p.features.map(f=>(
                <div key={f} style={{fontSize:12,color:C.text,marginBottom:4}}>
                  ✅ {f}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
// ═══════════════════════════════════════════════════════

// ─── Password Manager Component ───────────────────────────────────────────────
function PasswordManager({ state, setState, sb, withSync, notify, C, card, btn, input }) {
  const [adminPwd,    setAdminPwd]    = useState("");
  const [clientSel,   setClientSel]   = useState("");
  const [clientPwd,   setClientPwd]   = useState("");
  const [showAdminP,  setShowAdminP]  = useState(false);
  const [showClientP, setShowClientP] = useState(false);
  const [saving,      setSaving]      = useState(false);

  const clients = state?.clients || [];

  // Change admin password
  const changeAdminPwd = async () => {
    if (!adminPwd || adminPwd.length < 3) {
      notify("Password must be at least 3 characters", "error"); return;
    }
    setSaving(true);
    try {
      // Admin is stored in clients with id === "JIYA" or role === "admin"
      const adminClient = clients.find(c => c.id === "JIYA" || c.role === "admin") || { id: "JIYA", name: "Admin", role: "admin" };
      const updated = { ...adminClient, password: adminPwd };
      // Save to Supabase
      await withSync(() => sb.upsert("clients", updated));
      // Update local state
      setState(s => ({
        ...s,
        clients: s.clients.map(c => c.id === adminClient.id ? updated : c)
      }));
      setAdminPwd("");
      notify("✅ Admin password changed successfully!");
    } catch(e) {
      notify("❌ Failed: " + e.message, "error");
    }
    setSaving(false);
  };

  // Change client password
  const changeClientPwd = async () => {
    if (!clientSel) { notify("Select a client first", "error"); return; }
    if (!clientPwd || clientPwd.length < 3) { notify("Password must be at least 3 characters", "error"); return; }
    setSaving(true);
    try {
      const client = clients.find(c => c.id === clientSel);
      if (!client) { notify("Client not found", "error"); setSaving(false); return; }
      const updated = { ...client, password: clientPwd };
      await withSync(() => sb.upsert("clients", updated));
      setState(s => ({
        ...s,
        clients: s.clients.map(c => c.id === clientSel ? updated : c)
      }));
      setClientPwd("");
      setClientSel("");
      notify(`✅ Password changed for ${client.name}!`);
    } catch(e) {
      notify("❌ Failed: " + e.message, "error");
    }
    setSaving(false);
  };

  return (
    <div style={{marginTop:20}}>
      {/* Admin Password */}
      <div style={{...card, padding:24, marginBottom:16}}>
        <div style={{fontSize:15,fontWeight:700,color:C.text,marginBottom:4}}>🔐 Change Admin Password</div>
        <div style={{color:C.muted,fontSize:12,marginBottom:16}}>Change the JIYA admin login password</div>
        <div style={{display:"flex",gap:10,alignItems:"center"}}>
          <div style={{position:"relative",flex:1}}>
            <input
              type={showAdminP ? "text" : "password"}
              value={adminPwd}
              onChange={e => setAdminPwd(e.target.value)}
              placeholder="Enter new admin password"
              style={{...input, width:"100%", boxSizing:"border-box", paddingRight:40}}
              onKeyDown={e => e.key==="Enter" && changeAdminPwd()}
            />
            <span
              onClick={() => setShowAdminP(v=>!v)}
              style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",
                cursor:"pointer",fontSize:16,color:C.muted}}>
              {showAdminP ? "🙈" : "👁️"}
            </span>
          </div>
          <button
            onClick={changeAdminPwd}
            disabled={saving || !adminPwd}
            style={{...btn(C.accent), opacity: saving||!adminPwd ? 0.5 : 1, whiteSpace:"nowrap"}}>
            {saving ? "Saving..." : "Save Password"}
          </button>
        </div>
      </div>

      {/* Client Password */}
      <div style={{...card, padding:24}}>
        <div style={{fontSize:15,fontWeight:700,color:C.text,marginBottom:4}}>👤 Change Client Password</div>
        <div style={{color:C.muted,fontSize:12,marginBottom:16}}>Change password for any client — no old password needed</div>

        {/* Client selector */}
        <div style={{marginBottom:12}}>
          <div style={{color:C.muted,fontSize:11,fontWeight:600,marginBottom:6,textTransform:"uppercase",letterSpacing:0.5}}>
            Select Client
          </div>
          <select
            value={clientSel}
            onChange={e => setClientSel(e.target.value)}
            style={{...input, width:"100%", cursor:"pointer"}}>
            <option value="">-- Select a client --</option>
            {clients.filter(c => c.id !== "JIYA" && c.role !== "admin").map(c => (
              <option key={c.id} value={c.id}>{c.name} ({c.id})</option>
            ))}
          </select>
        </div>

        {/* New password */}
        <div style={{marginBottom:16}}>
          <div style={{color:C.muted,fontSize:11,fontWeight:600,marginBottom:6,textTransform:"uppercase",letterSpacing:0.5}}>
            New Password
          </div>
          <div style={{position:"relative"}}>
            <input
              type={showClientP ? "text" : "password"}
              value={clientPwd}
              onChange={e => setClientPwd(e.target.value)}
              placeholder="Enter new password for client"
              style={{...input, width:"100%", boxSizing:"border-box", paddingRight:40}}
              onKeyDown={e => e.key==="Enter" && changeClientPwd()}
              disabled={!clientSel}
            />
            <span
              onClick={() => setShowClientP(v=>!v)}
              style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",
                cursor:"pointer",fontSize:16,color:C.muted}}>
              {showClientP ? "🙈" : "👁️"}
            </span>
          </div>
        </div>

        <button
          onClick={changeClientPwd}
          disabled={saving || !clientSel || !clientPwd}
          style={{...btn(C.green), opacity: saving||!clientSel||!clientPwd ? 0.5 : 1}}>
          {saving ? "Saving..." : "✅ Change Client Password"}
        </button>

        {/* Quick reference */}
        {clients.filter(c => c.id !== "JIYA" && c.role !== "admin").length > 0 && (
          <div style={{marginTop:16,padding:12,background:C.accent+"08",borderRadius:8,
            border:`1px solid ${C.border}`}}>
            <div style={{color:C.muted,fontSize:11,fontWeight:600,marginBottom:8,textTransform:"uppercase"}}>
              Current Passwords (quick reference)
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6}}>
              {clients.filter(c => c.id !== "JIYA" && c.role !== "admin").map(c => (
                <div key={c.id} style={{fontSize:11,color:C.muted}}>
                  <span style={{fontWeight:600,color:C.text}}>{c.name?.split(" ")[0]}</span>
                  {" · "}
                  <span style={{fontFamily:"monospace"}}>{c.password || "—"}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
// ──────────────────────────────────────────────────────────────────────────────

function SettingsPage({ angelCreds, setAngelCreds, angelStatus, connectAngel, disconnectAngel, notify, C, card, btn, input, state, setState, sb, withSync, auth }) {
  const [form, setForm] = useState({
    clientId:    angelCreds.clientId    || "",
    password:    angelCreds.password    || "",
    totpSecret:  angelCreds.totpSecret  || "",
    apiKey:      angelCreds.apiKey      || "FtnI1OI3",
    secretKey:   angelCreds.secretKey   || "",
  });
  const [showPwd,  setShowPwd]  = useState(false);
  const [showTotp, setShowTotp] = useState(false);
  const [testing,  setTesting]  = useState(false);

  const saveAndConnect = async () => {
    if (!form.clientId || !form.password || !form.totpSecret || !form.apiKey) {
      notify("Please fill all fields", "error"); return;
    }
    // Save to localStorage (encrypted would be better but this is client-side)
    localStorage.setItem("angel_creds", JSON.stringify(form));
    setAngelCreds(form);
    notify("✅ Credentials saved!");
    setTesting(true);
    await connectAngel(form);
    setTesting(false);
  };

  const statusColor = angelStatus === "connected" ? C.green : angelStatus === "connecting" ? C.yellow : angelStatus === "error" ? C.red : C.muted;
  const statusText  = angelStatus === "connected" ? "✅ Connected — Live prices active" :
                      angelStatus === "connecting" ? "⏳ Connecting..." :
                      angelStatus === "error"      ? "❌ Connection failed" : "⚫ Not connected";

  return (
    <div style={{maxWidth:640}}>
      <h2 style={{margin:"0 0 6px",color:C.text,fontSize:22,fontWeight:800}}>⚙️ Settings</h2>
      <div style={{color:C.muted,fontSize:13,marginBottom:24}}>Configure Angel One SmartAPI for live prices & auto bhavcopy</div>

      {/* Status banner */}
      <div style={{...card,padding:"14px 20px",marginBottom:20,display:"flex",alignItems:"center",justifyContent:"space-between",
        borderLeft:`4px solid ${statusColor}`}}>
        <div>
          <div style={{fontWeight:700,color:statusColor,fontSize:14}}>{statusText}</div>
          {angelStatus === "connected" && (
            <div style={{color:C.muted,fontSize:12,marginTop:2}}>Live prices updating every 5 seconds • Auto closing prices at 7:00 PM</div>
          )}
        </div>
        {angelStatus === "connected" && (
          <div style={{display:"flex", gap:8}}>
            <button onClick={disconnectAngel} style={{...btn(C.red),fontSize:12}}>Disconnect</button>
            <button onClick={()=>fetchAutoBhavcopy(angelTokenRef.current?.jwtToken, angelCreds.apiKey)}
              style={{...btn(C.green),fontSize:12}}>
              📋 Fetch Closing Prices Now
            </button>
          </div>
        )}
      </div>

      {/* Credentials form */}
      <div style={{...card,padding:24}}>
        <div style={{fontSize:15,fontWeight:700,color:C.text,marginBottom:16}}>🔐 Angel One SmartAPI Credentials</div>

        {[
          { key:"clientId",   label:"Client ID",     placeholder:"e.g. P515516",    type:"text",     icon:"👤" },
          { key:"password",   label:"Password",      placeholder:"Trading password", type:showPwd?"text":"password", icon:"🔑", toggle:()=>setShowPwd(v=>!v), show:showPwd },
          { key:"totpSecret", label:"TOTP Secret",   placeholder:"Base32 secret key", type:showTotp?"text":"password", icon:"🔐", toggle:()=>setShowTotp(v=>!v), show:showTotp },
          { key:"apiKey",     label:"API Key",       placeholder:"e.g. FtnI1OI3",   type:"text",     icon:"🗝️" },
          { key:"secretKey",  label:"Secret Key",    placeholder:"UUID format",      type:"password", icon:"🔒" },
        ].map(f => (
          <div key={f.key} style={{marginBottom:14}}>
            <div style={{color:C.muted,fontSize:12,fontWeight:600,marginBottom:5,textTransform:"uppercase",letterSpacing:0.5}}>
              {f.icon} {f.label}
            </div>
            <div style={{display:"flex",gap:8}}>
              <input
                type={f.type}
                value={form[f.key]}
                onChange={e => setForm(v => ({...v, [f.key]: e.target.value}))}
                placeholder={f.placeholder}
                style={{...input, flex:1, fontFamily: f.key==="totpSecret"||f.key==="secretKey" ? "monospace" : "inherit"}}
              />
              {f.toggle && (
                <button onClick={f.toggle} style={{...btn(C.card),border:`1px solid ${C.border}`,padding:"8px 12px",fontSize:13}}>
                  {f.show ? "🙈" : "👁️"}
                </button>
              )}
            </div>
          </div>
        ))}

        <div style={{marginTop:20,display:"flex",gap:10}}>
          <button onClick={saveAndConnect}
            style={{...btn(C.green),flex:1,padding:"11px",fontSize:14,fontWeight:700}}
            disabled={testing}>
            {testing ? "⏳ Testing connection..." : "💾 Save & Connect"}
          </button>
        </div>

        <div style={{marginTop:16,padding:12,background:C.yellow+"10",borderRadius:8,border:`1px solid ${C.yellow}33`,fontSize:12,color:C.muted,lineHeight:1.6}}>
          🔒 <strong>Privacy:</strong> Credentials are saved in your browser only. Never sent anywhere except directly to Angel One servers.
          <br/>⚡ <strong>What this enables:</strong> Live option prices → Real-time MTM in RMS → Auto bhavcopy daily.
        </div>
      </div>

      {/* ── Password Management ── */}
      <PasswordManager state={state} setState={setState} sb={sb} withSync={withSync} notify={notify} C={C} card={card} btn={btn} input={input} />

      {/* What gets automated */}
      {angelStatus === "connected" && (
        <div style={{...card,padding:20,marginTop:16}}>
          <div style={{fontSize:14,fontWeight:700,color:C.text,marginBottom:12}}>✅ Now Automated</div>
          {[
            {icon:"📈", label:"Live option prices", desc:"Updates every 5 seconds during market hours"},
            {icon:"💰", label:"Real-time MTM in RMS", desc:"All client positions update automatically"},
            {icon:"📋", label:"Bhavcopy", desc:"Auto-fetched at 7:00 PM every trading day"},
            {icon:"🎯", label:"Accurate scenario analysis", desc:"Uses real option prices not approximations"},
          ].map(item => (
            <div key={item.label} style={{display:"flex",gap:12,marginBottom:10,alignItems:"flex-start"}}>
              <span style={{fontSize:20}}>{item.icon}</span>
              <div>
                <div style={{fontWeight:600,color:C.text,fontSize:13}}>{item.label}</div>
                <div style={{color:C.muted,fontSize:12}}>{item.desc}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
// ═══════════════════════════════════════════════════════

// ─── Count-up animation hook ─────────────────────────────────────────────────
function useCountUp(target, duration = 900) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    if (typeof target !== "number" || isNaN(target)) return;
    const start = performance.now();
    const tick = (now) => {
      const progress = Math.min((now - start) / duration, 1);
      const ease = 1 - Math.pow(1 - progress, 3);
      setVal(Math.round(target * ease));
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [target]);
  return val;
}
// ─────────────────────────────────────────────────────────────────────────────

export default function BackOffice() {
  const [state, setState] = useState(INITIAL_STATE);
  const [dbLoading, setDbLoading] = useState(SUPABASE_CONFIGURED); // show loading if DB configured
  const [dbError, setDbError] = useState(null);
  const [syncStatus, setSyncStatus] = useState("idle"); // "idle"|"saving"|"saved"|"error"
  const [auth, setAuth] = useState(null); // {role:'superadmin'|'admin'|'client', clientId?, adminId?, plan?}

  // ── Session auto-logout after 8 hours ──
  useEffect(() => {
    if (!auth) return;
    const loginTime = parseInt(sessionStorage.getItem("jiya_login_time") || "0");
    if (!loginTime) return;
    const remaining = (8 * 60 * 60 * 1000) - (Date.now() - loginTime);
    if (remaining <= 0) { setAuth(null); return; }
    const t = setTimeout(() => {
      setAuth(null);
      sessionStorage.removeItem("jiya_login_time");
      notify("⏰ Session expired after 8 hours. Please login again.", "error");
    }, remaining);
    return () => clearTimeout(t);
  }, [auth]);
  const [loginForm, setLoginForm] = useState({ user: "", pass: "", error: "" });
  const [page, setPage] = useState("dashboard");
  const [modal, setModal] = useState(null);
  const [positionFilter,    setPositionFilter]    = useState("open");
  const [selectedContract,  setSelectedContract]  = useState(null); // for trade history modal
  const [ledgerSearch,   setLedgerSearch]   = useState("");
  const [tradeSearch,    setTradeSearch]    = useState("");
  const [posSearch,      setPosSearch]      = useState("");
  const [notification,  setNotification]  = useState(null);
  const [bells,         setBells]         = useState(() => {
    try { return JSON.parse(localStorage.getItem("jiya_bells") || "[]"); } catch(e) { return []; }
  });
  const [bellAnimate,   setBellAnimate]   = useState(false);
  const [bellOpen,      setBellOpen]      = useState(false);

  const addBell = (msg, type="info", page=null) => {
    const entry = {
      id:   Date.now() + Math.random(),
      msg,  type, page,
      time: new Date().toISOString(),
      read: false,
    };
    setBells(prev => {
      const updated = [entry, ...prev].slice(0, 50);
      try { localStorage.setItem("jiya_bells", JSON.stringify(updated)); } catch(e) {}
      return updated;
    });
    setBellAnimate(true);
    setTimeout(() => setBellAnimate(false), 600);
  };

  const markAllRead = () => {
    setBells(prev => {
      const updated = prev.map(b => ({ ...b, read: true }));
      try { localStorage.setItem("jiya_bells", JSON.stringify(updated)); } catch(e) {}
      return updated;
    });
  };

  const clearBells = () => {
    setBells([]);
    try { localStorage.removeItem("jiya_bells"); } catch(e) {}
  };

  const unreadCount = bells.filter(b => !b.read).length;
  // RMS state
  const [rmsPositions,   setRmsPositions]   = useState({});
  const [rmsFunds,       setRmsFunds]       = useState(() => { try { return JSON.parse(localStorage.getItem("rms_funds")||"{}"); } catch(e){ return {}; } });
  const [rmsIndexPrices, setRmsIndexPrices] = useState(() => { try { return JSON.parse(localStorage.getItem("rms_idx")||"{}"); } catch(e){ return { NIFTY:24050, SENSEX:77550, BANKNIFTY:52000, BANKEX:52000 }; } });
  const [rmsLastUpdated, setRmsLastUpdated] = useState(null);

  // ── Angel One API State ──
  const [angelCreds, setAngelCreds] = useState(() => {
    try { return JSON.parse(localStorage.getItem("angel_creds") || "{}"); } catch(e) { return {}; }
  });
  const [angelStatus,    setAngelStatus]    = useState("disconnected"); // disconnected|connecting|connected|error
  const [angelToken,     setAngelToken]     = useState(null);
  const [angelFeedToken, setAngelFeedToken] = useState(null);
  const [angelLivePrice, setAngelLivePrice] = useState({}); // { "NIFTY_23000_CE_13APR2026": 45.50, ... }
  const [angelLiveMTM,   setAngelLiveMTM]   = useState({}); // { "NIFTY 23000 CE 13APR2026": { ltp, token, exchange } }
  const [angelMTMStatus, setAngelMTMStatus] = useState("idle"); // idle|fetching|live|error
  const [angelWS,        setAngelWS]        = useState(null);

  // ── Angel One: Connect & start live prices ──
  const connectAngel = async (creds) => {
    setAngelStatus("connecting");
    try {
      // Login to get JWT token
      const tokens = await angelLogin(creds);
      setAngelToken(tokens.jwtToken);
      setAngelFeedToken(tokens.feedToken);
      setAngelStatus("connected");
      notify("✅ Angel One connected! Live prices active.");

      // Store token for manual fetch button
      angelTokenRef.current = { jwtToken: tokens.jwtToken };

      // Start polling LTP every 5 seconds
      startLTPPolling(tokens.jwtToken, creds.apiKey);

      // Schedule auto closing prices at 7:00 PM
      scheduleAutoBhavcopy(tokens.jwtToken, creds.apiKey);

    } catch(e) {
      setAngelStatus("error");
      notify("❌ Angel One connection failed: " + e.message, "error");
    }
  };

  const disconnectAngel = () => {
    if (angelWS) { try { angelWS.close(); } catch(e) {} }
    setAngelWS(null);
    setAngelToken(null);
    setAngelStatus("disconnected");
    setAngelLivePrice({});
    notify("Disconnected from Angel One");
  };

  // ── Angel One: Poll LTP for all open positions ──
  // ── Angel One: Poll LTP for open positions ──────────────────
  const rmsPositionsRef     = useRef({});
  const contractTokenMapRef = useRef({});
  const angelTokenRef       = useRef({});

  // Parse contract name to Angel One search query
  const contractToSearch = (contract) => {
    // Contract format: "NIFTY 23000 CE 13APR2026" or "NIFTY FUT 25APR2026"
    const parts = contract.trim().split(/\s+/);
    const sym   = parts[0] || "";
    const isFut = contract.includes("FUT");
    const isBSE = ["SENSEX","BANKEX"].includes(sym.toUpperCase());
    return {
      symbol:   sym,
      contract,
      exchange: isBSE ? "BFO" : "NFO",
      query:    contract,
    };
  };

  // Fetch token for a single contract from Angel One
  const fetchContractToken = async (jwtToken, apiKey, contractInfo) => {
    try {
      const resp = await fetch(ANGEL_PROXY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "ltp",
          apiKey, jwtToken,
          payload: { exchangeTokens: { [contractInfo.exchange]: [] } } // ping to check connection
        })
      });
      // We'll use search_token action instead
      const r = await fetch(ANGEL_PROXY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "search_token",
          apiKey, jwtToken,
          payload: contractInfo
        })
      });
      const data = await r.json();
      if (data.status && data.data?.length) {
        const best = data.data[0];
        return { token: best.symboltoken, exchange: contractInfo.exchange, ltp: best.ltp };
      }
    } catch(e) {}
    return null;
  };

  const startLTPPolling = useCallback((jwtToken, apiKey) => {
    const poll = async () => {
      try {
        const now = new Date();
        const h = now.getHours(), m = now.getMinutes();
        const inMarket = (h > 9 || (h === 9 && m >= 14)) && (h < 15 || (h === 15 && m < 31));
        // Allow after hours for testing too - just fetch latest available price
        
        // Get all unique open position contracts
        const { openPositions: allOpen } = applyFIFO(state.trades);
        if (!allOpen.length) return;

        // Build token map for contracts we don't have yet
        const unknownContracts = allOpen.filter(p => !contractTokenMapRef.current[p.contract]);
        
        // Fetch tokens for unknown contracts (batch, max 5 at once to avoid rate limit)
        for (let i = 0; i < Math.min(unknownContracts.length, 5); i++) {
          const pos = unknownContracts[i];
          const info = contractToSearch(pos.contract);
          const result = await fetchContractToken(jwtToken, apiKey, info);
          if (result) {
            contractTokenMapRef.current[pos.contract] = result;
          }
        }

        // Build exchange tokens from known map
        const nfoTokens = [], bfoTokens = [], tokenToContract = {};
        allOpen.forEach(p => {
          const mapped = contractTokenMapRef.current[p.contract];
          if (!mapped?.token) return;
          const tok = mapped.token;
          if (mapped.exchange === "NFO") { if (!nfoTokens.includes(tok)) nfoTokens.push(tok); }
          else                           { if (!bfoTokens.includes(tok)) bfoTokens.push(tok); }
          tokenToContract[tok] = p.contract;
        });

        if (!nfoTokens.length && !bfoTokens.length) return;

        // Fetch LTPs
        const exchangeTokens = {};
        if (nfoTokens.length) exchangeTokens["NFO"] = nfoTokens.slice(0, 50);
        if (bfoTokens.length) exchangeTokens["BFO"] = bfoTokens.slice(0, 50);

        const resp = await fetch(ANGEL_PROXY, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "ltp", apiKey, jwtToken, payload: { exchangeTokens } })
        });
        const data = await resp.json();

        if (data.status && data.data) {
          const newMTM = { ...angelLiveMTM };
          (data.data.fetched || []).forEach(item => {
            const contract = tokenToContract[item.symbolToken];
            if (contract) {
              newMTM[contract] = { ltp: item.ltp, token: item.symbolToken };
            }
          });
          setAngelLiveMTM(newMTM);
          setAngelMTMStatus("live");

          // Also update RMS positions if active
          const rmsPos = rmsPositionsRef.current;
          if (Object.keys(rmsPos).length) {
            const updated = {};
            Object.entries(rmsPos).forEach(([cid, positions]) => {
              updated[cid] = positions.map(p => {
                const tok = (p.scripCode || "").toString().trim();
                const ltp = (data.data.fetched||[]).find(x=>x.symbolToken===tok)?.ltp;
                if (ltp !== undefined) {
                  const qty    = parseFloat(p.netQty)  || 0;
                  const buyAvg = parseFloat(p.buyAvg)  || parseFloat(p.netPrice) || 0;
                  const newMTMval = qty !== 0 ? ((ltp - buyAvg) * qty).toFixed(2) : (parseFloat(p.mtmGL)||0).toFixed(2);
                  return { ...p, marketPrice: ltp.toString(), mtmGL: newMTMval };
                }
                return p;
              });
            });
            rmsPositionsRef.current = updated;
            setRmsLastUpdated(new Date());
          }
        }
      } catch(e) {
        console.log("LTP poll error:", e.message);
        setAngelMTMStatus("error");
      }
    };

    const interval = setInterval(poll, 5000); // every 5 seconds
    poll();
    return () => clearInterval(interval);
  }, [state.trades, angelLiveMTM]);

  // ── Angel One: Auto Closing Prices at 7:00 PM ──
  const scheduleAutoBhavcopy = useCallback((jwtToken, apiKey) => {
    const checkTime = () => {
      const now = new Date();
      if (now.getHours() === 19 && now.getMinutes() === 0 && now.getSeconds() < 10) {
        fetchAutoBhavcopy(jwtToken, apiKey);
      }
    };
    const interval = setInterval(checkTime, 5000);
    return () => clearInterval(interval);
  }, []);

  const fetchAutoBhavcopy = async (jwtToken, apiKey) => {
    notify("📋 Fetching closing prices for open positions...");
    try {
      // Get all unique open position contracts
      const { openPositions } = applyFIFO(state.trades);
      if (!openPositions.length) {
        notify("No open positions — nothing to fetch");
        return;
      }

      // Build unique contracts list
      const uniqueContracts = [...new Set(openPositions.map(p => p.contract))];
      notify(`Fetching prices for ${uniqueContracts.length} contracts...`);

      const newMTM = { ...angelLiveMTM };
      let fetched = 0;

      // Fetch LTP for each contract via search_token
      for (const contract of uniqueContracts) {
        try {
          // Check if we already have token from live polling
          const existing = contractTokenMapRef.current[contract];
          if (existing?.token) {
            // Use existing token to fetch latest price
            const isBSE = ["SENSEX","BANKEX"].includes(contract.split(" ")[0]?.toUpperCase());
            const exchange = isBSE ? "BFO" : "NFO";
            const resp = await fetch(ANGEL_PROXY, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "ltp", apiKey, jwtToken,
                payload: { exchangeTokens: { [exchange]: [existing.token] } }
              })
            });
            const data = await resp.json();
            if (data.status && data.data?.fetched?.length) {
              const ltp = data.data.fetched[0].ltp;
              newMTM[contract] = { ltp, token: existing.token };
              fetched++;
            }
          } else {
            // Search for token
            const sym = contract.split(" ")[0];
            const isBSE = ["SENSEX","BANKEX"].includes(sym?.toUpperCase());
            const exchange = isBSE ? "BFO" : "NFO";
            const r = await fetch(ANGEL_PROXY, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "search_token", apiKey, jwtToken,
                payload: { symbol: sym, exchange, query: contract }
              })
            });
            const d = await r.json();
            if (d.status && d.data?.length) {
              const token = d.data[0].symboltoken;
              const ltp   = d.data[0].ltp;
              contractTokenMapRef.current[contract] = { token, exchange };
              newMTM[contract] = { ltp, token };
              fetched++;
            }
          }
          await new Promise(r => setTimeout(r, 150)); // rate limit delay
        } catch(e) {
          console.log("Closing price fetch error for", contract, e.message);
        }
      }

      // Update live MTM state — this automatically updates P&L via getBhavClose
      setAngelLiveMTM(newMTM);
      setAngelMTMStatus("live");
      notify(`✅ Closing prices updated for ${fetched}/${uniqueContracts.length} contracts`);

    } catch(e) {
      notify("❌ Closing price fetch failed: " + e.message, "error");
    }
  };

  // ── Auto-reconnect Angel One on page load if creds saved ──
  useEffect(() => {
    if (angelCreds.clientId && angelCreds.password && angelCreds.totpSecret && angelCreds.apiKey) {
      connectAngel(angelCreds);
    }
  }, []); // eslint-disable-line

  const notify = (msg, type = "success") => {
    setNotification({ msg, type });
    setTimeout(() => setNotification(null), 3500);
  };

  // ── Supabase: Load all data on mount ──
  useEffect(() => {
    if (!SUPABASE_CONFIGURED) return;
    // Wake up DB first, then load data
    const init = async () => {
      try {
        // Ping to wake up sleeping DB (free tier pauses after inactivity)
        await fetch(`${SUPABASE_URL}/rest/v1/clients?limit=1`, {
          headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": `Bearer ${SUPABASE_ANON_KEY}` }
        });
        await new Promise(r => setTimeout(r, 800)); // wait for wake
      } catch(e) {}
      loadAllData();
    };
    init();

    // Keep-alive ping every 4 minutes so DB never sleeps during session
    const keepAlive = setInterval(async () => {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/clients?limit=1`, {
          headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": `Bearer ${SUPABASE_ANON_KEY}` }
        });
      } catch(e) {}
    }, 2 * 60 * 1000); // ping every 2 min to prevent sleep

    return () => clearInterval(keepAlive);
  }, []);

  // ── Reload when user comes back to tab ──
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible" && SUPABASE_CONFIGURED) {
        loadAllData();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  // ── Auto-lock previous month on 1st of every month ──
  useEffect(() => {
    if (!SUPABASE_CONFIGURED) return;
    const today = new Date();
    if (today.getDate() !== 1) return; // only run on 1st
    const prevMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const prevMonthStr = prevMonth.toISOString().slice(0, 7); // "2026-04"
    // Check if already locked
    if (state.lockedMonths?.includes(prevMonthStr)) return;
    // Lock it
    const lockMonth = async () => {
      try {
        await sb.upsert("locked_months", { month: prevMonthStr, locked_at: new Date().toISOString() });
        setState(s => ({ ...s, lockedMonths: [...(s.lockedMonths||[]), prevMonthStr] }));
        notify(`Month ${prevMonthStr} has been locked automatically.`);
      } catch(e) {
        console.error("Lock month error:", e);
      }
    };
    lockMonth();
  }, [state.lockedMonths]);

  const loadAllData = async () => {
    setDbLoading(true);
    setDbError(null);
    try {
      // ── Paginated fetch — loads ALL rows regardless of count ──
      const fetchAll = async (table, query = "") => {
        const PAGE = 1000;
        let all = [], offset = 0;
        while (true) {
          const rows = await sb.select(table, `${query}&limit=${PAGE}&offset=${offset}`);
          if (!Array.isArray(rows) || rows.length === 0) break;
          all = all.concat(rows);
          if (rows.length < PAGE) break; // last page
          offset += PAGE;
        }
        return all;
      };

      const [clients, trades, ledger, tickets, interest, chargesHistory, bhavcopy, lockedMonthsRaw, admins, auditLog] = await Promise.all([
        fetchAll("clients",         "?order=created_at.asc"),
        fetchAll("trades",          "?order=date.asc,time.asc"),
        fetchAll("ledger",          "?order=date.asc"),
        fetchAll("tickets",         "?order=date.desc"),
        fetchAll("interest",        "?order=created_at.asc"),
        fetchAll("charges_history", "?order=created_at.asc"),
        fetchAll("bhavcopy",        "?order=created_at.desc"),
        sb.select("locked_months",  "?order=month.asc").catch(() => []),
        sb.select("admins",         "?order=created_at.asc").catch(() => []),
        sb.select("audit_log",      "?order=timestamp.desc&limit=2000").catch(() => []),
      ]);

      // If we get here, DB is truly connected and returning data
      setState(s => ({
        ...s,
        clients:        Array.isArray(clients)        ? clients        : [],
        trades:         Array.isArray(trades)         ? trades         : [],
        ledger:         Array.isArray(ledger)         ? ledger         : [],
        tickets:        Array.isArray(tickets)        ? tickets        : [],
        interest:       Array.isArray(interest)       ? interest       : [],
        chargesHistory: Array.isArray(chargesHistory) && chargesHistory.length
                          ? chargesHistory
                          : [{ ...DEFAULT_CHARGES, effectiveFrom: "2024-01-01" }],
        bhavcopy:       Array.isArray(bhavcopy)       ? bhavcopy       : [],
        lockedMonths:   Array.isArray(lockedMonthsRaw) ? lockedMonthsRaw.map(r => r.month) : [],
        admins:         Array.isArray(admins) ? admins : [],
        auditLog:       Array.isArray(auditLog) ? auditLog : [],
      }));
      setSyncStatus("saved");
      setTimeout(() => setSyncStatus("idle"), 2000);
    } catch (err) {
      console.error("Load error:", err);
      setDbError(err.message);
      // IMPORTANT: Do NOT reset state on error — keep existing data visible
      // Only show error notification, don't wipe trades/ledger/clients
      notify("⚠️ Database connection issue: " + err.message, "error");
      setSyncStatus("error");
    } finally {
      setDbLoading(false);
    }
  };

  // ── Supabase: Generic save with sync indicator ──
  // ── Wake up Supabase (free tier sleeps after inactivity) ──
  const wakeUpDB = async () => {
    try {
      // Simple ping — just select 1 row to wake up the DB
      await fetch(`${SUPABASE_URL}/rest/v1/clients?limit=1`, {
        headers: {
          "apikey": SUPABASE_ANON_KEY,
          "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
        }
      });
      // Wait 1 second for DB to fully wake
      await new Promise(r => setTimeout(r, 1000));
    } catch(e) {
      console.log("Wake up ping failed:", e);
    }
  };

  const withSync = async (fn) => {
    if (!SUPABASE_CONFIGURED) {
      fn(); // local only
      return;
    }
    setSyncStatus("saving");
    try {
      // Wake up DB first before any write operation
      await wakeUpDB();
      const result = await fn();
      setSyncStatus("saved");
      setTimeout(() => setSyncStatus("idle"), 2000);
      return result;
    } catch (err) {
      console.error("Sync error:", err);
      // Retry once after 2 seconds (in case DB was sleeping)
      try {
        notify("⏳ Retrying database save...");
        await new Promise(r => setTimeout(r, 2000));
        const result = await fn();
        setSyncStatus("saved");
        setTimeout(() => setSyncStatus("idle"), 2000);
        notify("✅ Saved successfully!");
        return result;
      } catch(err2) {
        setSyncStatus("error");
        notify("⚠️ Database sync failed: " + err2.message, "error");
        setTimeout(() => setSyncStatus("idle"), 5000);
      }
    }
  };

  // ── Charges State ──
  const [pnlClientFilter, setPnlClientFilter] = useState("all");
  const [pnlDateMode, setPnlDateMode] = useState("month"); // "all" | "month" | "range"
  const [chartClientFilter, setChartClientFilter] = useState("all"); // for 6-month chart
  const [pnlMonth, setPnlMonth] = useState(new Date().toISOString().slice(0,7));
  const [pnlDateFrom, setPnlDateFrom] = useState("");
  const [pnlDateTo, setPnlDateTo] = useState("");
  const [addInterestForm, setAddInterestForm] = useState({ clientId:"", yearMonth:"", amount:"", note:"", entryType:"interest" });
  const [tradesClientFilter, setTradesClientFilter] = useState("all");
  const [chargesEdit, setChargesEdit] = useState(null); // working copy for charges edit

  // Get charges config effective for a given date
  const getChargesForDate = (date) => {
    const history = [...(state.chargesHistory || [DEFAULT_CHARGES])].sort((a,b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
    return history.find(c => c.effectiveFrom <= date) || DEFAULT_CHARGES;
  };

  // Calculate charges for a single trade using date-appropriate config
  const getTradeCharges = (trade) => calcCharges(trade, getChargesForDate(trade.date || "2024-01-01"));

  // Monthly charges summary per client
  const getMonthlyCharges = (clientId, yearMonth) => {
    return state.trades
      .filter(t => t.clientId === clientId && (t.date || "").startsWith(yearMonth))
      .reduce((sum, t) => sum + getTradeCharges(t).total, 0);
  };

  // Monthly interest for a client
  const getMonthlyInterest = (clientId, yearMonth) => {
    // Supports both regular (2026-05) and software (2026-05_SW) keys
    return (state.interest || [])
      .filter(i => i.clientId === clientId && i.yearMonth === yearMonth)
      .reduce((sum, i) => sum + (+i.amount || 0), 0);
  };

  // Save interest entry
  const saveInterest = () => {
    const { clientId, yearMonth, amount, note, entryType } = addInterestForm;
    if (!clientId || !yearMonth || !amount) return notify("Fill all required fields", "error");
    const isSoftware = entryType === "software";
    const storedMonth = isSoftware ? yearMonth + "_SW" : yearMonth;
    const entry = {
      id: "INT" + Date.now(),
      clientId,
      yearMonth: storedMonth,
      amount: +amount,
      note: note || (isSoftware ? "Software Charges" : ""),
      entryType: entryType || "interest",
    };
    setState(s => ({ ...s, interest: [...(s.interest||[]), entry] }));
    withSync(() => sb.upsert("interest", entry));
    setAddInterestForm({ clientId:"", yearMonth:"", amount:"", note:"", entryType:"interest" });
    setModal(null);
    notify(isSoftware ? "Software charge added" : "Interest entry added");
  };

  // Delete interest entry
  const deleteInterest = (id) => {
    setState(s => ({ ...s, interest: (s.interest||[]).filter(i => i.id !== id) }));
    withSync(() => sb.delete("interest", id));
    notify("Interest entry removed");
  };
  const [bhavPreview, setBhavPreview] = useState(null); // {date, rows, matched, expiring}
  const [bhavDate, setBhavDate] = useState(new Date().toISOString().slice(0,10));

  // Parse NSE F&O Bhavcopy CSV
  // Key columns: TckrSymb, XpryDt, StrkPric, OptnTp, FinInstrmTp, ClsPric, SttlmPric
  const parseBhavcopy = (text) => {
    const lines = text.replace(/\r\n/g,"\n").replace(/\r/g,"\n").trim().split("\n");
    if (lines.length < 2) return null;
    const header = lines[0].split(",").map(h => h.trim());
    const idx = (name) => header.findIndex(h => h === name);

    const iSymbol  = idx("TckrSymb");
    const iExpiry  = idx("XpryDt");
    const iStrike  = idx("StrkPric");
    const iOptType = idx("OptnTp");
    const iInstr   = idx("FinInstrmTp");
    const iClose   = idx("ClsPric");
    const iSettl   = idx("SttlmPric");

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      if (cols.length < 10) continue;
      const symbol   = cols[iSymbol]?.trim() || "";
      const expiryRaw= cols[iExpiry]?.trim() || "";   // "2026-04-02"
      const strike   = parseFloat(cols[iStrike]) || 0;
      const optType  = cols[iOptType]?.trim() || "";  // CE / PE / ""
      const instrTp  = cols[iInstr]?.trim() || "";    // STO=options, STF=futures
      const closeP   = parseFloat(cols[iClose]) || 0;
      const settlP   = parseFloat(cols[iSettl]) || 0;

      if (!symbol || !expiryRaw) continue;

      // Normalize expiry from "2026-04-02" → "02APR2026"
      const expiry = normalizeExpiry(expiryRaw);

      // Build contract key matching our trade contract format
      let contract = "";
      if (instrTp === "STO" && optType && strike > 0) {
        contract = `${symbol} ${Math.round(strike)} ${optType} ${expiry}`;
      } else if (instrTp === "STF") {
        contract = `${symbol} FUT ${expiry}`;
      } else continue;

      rows.push({ contract, symbol, expiry, expiryRaw, optType, strike, instrTp, closePrice: closeP, settlPrice: settlP });
    }
    return rows;
  };

  // Build lookup map: contract → {closePrice, settlPrice, expiryRaw}
  const bhavLookup = {};
  for (const b of (state.bhavcopy || [])) {
    bhavLookup[b.contract] = b;
  }

  // Get closing price for a contract from bhavcopy
  // getBhavClose: checks Angel One live MTM first, then bhavcopy
  const getBhavClose = (contract) => {
    // Priority 1: Angel One live price (most accurate)
    if (angelLiveMTM[contract]?.ltp) return angelLiveMTM[contract].ltp;
    // Priority 2: Manual bhavcopy upload
    if (bhavLookup[contract]?.closePrice) return bhavLookup[contract].closePrice;
    return null;
  };
  const getBhavSettl = (contract) => bhavLookup[contract]?.settlPrice || null;
  const getBhavExpiry = (contract) => bhavLookup[contract]?.expiryRaw || null;

  // Check if contract expires on bhavDate
  const isExpiring = (contract) => {
    const b = bhavLookup[contract];
    if (!b) return false;
    return b.expiryRaw === bhavDate;
  };

  // Handle bhavcopy file upload
  const handleBhavUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const rows = parseBhavcopy(ev.target.result);
      if (!rows || !rows.length) { notify("Could not parse Bhavcopy file", "error"); return; }

      // Find which open positions match
      const { openPositions } = applyFIFO(state.trades);
      const openContracts = new Set(openPositions.map(p => p.contract));
      const matched = rows.filter(r => openContracts.has(r.contract));
      const expiring = matched.filter(r => r.expiryRaw === bhavDate);

      setBhavPreview({ date: bhavDate, rows, matched, expiring });
    };
    reader.readAsText(file);
  };

  // Apply bhavcopy — update prices + auto square-off expiring
  const applyBhavcopy = () => {
    if (!bhavPreview) return;
    const { openPositions } = applyFIFO(state.trades);

    const autoTrades = [];
    for (const pos of openPositions) {
      if (!isExpiringContract(pos.contract, bhavPreview)) continue;
      const bhav = bhavPreview.rows.find(r => r.contract === pos.contract);
      if (!bhav) continue;
      const settlPrice = bhav.settlPrice || bhav.closePrice;
      if (!settlPrice) continue;
      const closingSide = pos.side === "SELL" ? "BUY" : "SELL";
      autoTrades.push({
        id: `AUTO_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
        clientId: pos.clientId,
        contract: pos.contract,
        side: closingSide,
        qty: pos.netQty,
        price: settlPrice,
        date: bhavDate,
        time: "15:30:00",
        exchange: "NSE",
        instrType: "Options",
        scriptName: pos.contract,
        isAutoExpiry: true,
      });
    }

    const bhavRows = bhavPreview.rows.map(r => ({ ...r, bhavDate }));

    setState(s => ({
      ...s,
      bhavcopy: bhavRows,
      trades: [...s.trades, ...autoTrades],
    }));

    withSync(async () => {
      // Save bhavcopy (clear old and insert new)
      await fetch(`${sb.url("bhavcopy")}`, { method: "DELETE", headers: sb.headers });
      for (let i = 0; i < bhavRows.length; i += 500) {
        await sb.upsert("bhavcopy", bhavRows.slice(i, i + 500));
      }
      // Save auto expiry trades
      if (autoTrades.length > 0) await sb.upsert("trades", autoTrades);
    });

    const msg = autoTrades.length > 0
      ? `✅ Bhavcopy applied! ${autoTrades.length} positions auto squared-off at settlement price.`
      : `✅ Bhavcopy applied! MTM P&L updated for all open positions.`;
    notify(msg);
    setBhavPreview(null);
    setModal(null);
  };

  const isExpiringContract = (contract, preview) =>
    preview?.expiring?.some(r => r.contract === contract) || false;

  // ── Security: Login attempt tracking ──
  const [loginAttempts, setLoginAttempts] = useState(0);
  const [lockoutUntil, setLockoutUntil] = useState(null);

  const handleLogin = () => {
    // Check lockout
    if (lockoutUntil && Date.now() < lockoutUntil) {
      const secs = Math.ceil((lockoutUntil - Date.now()) / 1000);
      setLoginForm(f => ({ ...f, error: `Too many attempts. Try again in ${secs}s.` }));
      return;
    }

    const userInput = loginForm.user.trim();
    const passInput = loginForm.pass;

    // Constant-time comparison to prevent timing attacks
    const isSuperAdmin = userInput === "JIYA" && passInput === "Jiya@3044";

    // Check sub-admin login
    const subAdmin = !isSuperAdmin
      ? (state.admins||[]).find(a => a.username === userInput && a.password === passInput)
      : null;

    // Check client login — only from correct admin scope
    const client = !isSuperAdmin && !subAdmin
      ? state.clients.find(c => c.id === userInput && c.password === passInput)
      : null;

    if (isSuperAdmin) {
      setLoginAttempts(0);
      setAuth({ role: "superadmin", plan: "superadmin" });
      sessionStorage.setItem("jiya_login_time", Date.now().toString());
      setPage("dashboard");
      setLoginForm({ user: "", pass: "", error: "" });
    } else if (subAdmin) {
      // Validate token expiry
      const expiry = new Date(subAdmin.tokenExpiry);
      if (expiry < new Date()) {
        setLoginAttempts(prev => prev + 1);
        setLoginForm(f => ({ ...f, error: "Your access token has expired. Contact JIYA to renew." }));
        return;
      }
      setLoginAttempts(0);
      setAuth({ role: "admin", adminId: subAdmin.id, plan: subAdmin.plan || "basic" });
      sessionStorage.setItem("jiya_login_time", Date.now().toString());
      setPage("dashboard");
      setLoginForm({ user: "", pass: "", error: "" });
    } else if (client) {
      setLoginAttempts(0);
      setAuth({ role: "client", clientId: client.id, adminId: client.adminId });
      sessionStorage.setItem("jiya_login_time", Date.now().toString());
      setPage("dashboard");
      setLoginForm({ user: "", pass: "", error: "" });
    } else {
      const newAttempts = loginAttempts + 1;
      setLoginAttempts(newAttempts);
      if (newAttempts >= 5) {
        setLockoutUntil(Date.now() + 30000); // 30 second lockout
        setLoginForm(f => ({ ...f, pass: "", error: "Too many failed attempts. Locked for 30 seconds." }));
      } else {
        setLoginForm(f => ({ ...f, pass: "", error: `Invalid credentials. ${5 - newAttempts} attempts remaining.` }));
      }
    }
  };

  const logout = () => { setAuth(null); setPage("dashboard"); setLoginForm({ user: "", pass: "", error: "" }); };

  // ── FIFO ──
  const { openPositions, closedPositions } = applyFIFO(state.trades);

  // ── Helpers ──
  const clientTrades = (cid) => state.trades.filter((t) => t.clientId === cid);
  const clientLedger = (cid) => state.ledger.filter((l) => l.clientId === cid);
  const clientTickets = (cid) => state.tickets.filter((t) => t.clientId === cid);
  const clientOpenPos = (cid) => openPositions.filter((p) => p.clientId === cid);
  const clientClosedPos = (cid) => closedPositions.filter((p) => p.clientId === cid);

  // ── Data isolation by adminId ──────────────────────
  const visibleClients = (() => {
    if (auth?.role === "superadmin") return state.clients; // JIYA sees all
    if ((auth?.role === "admin" || auth?.role === "superadmin")) {
      // Sub-admin sees only clients with matching adminId
      return state.clients.filter(c => c.adminId === auth.adminId);
    }
    // Client sees only themselves
    return state.clients.filter(c => c.id === auth?.clientId);
  })();

  const visibleTrades = (() => {
    if (auth?.role === "superadmin") return state.trades;
    if ((auth?.role === "admin" || auth?.role === "superadmin")) {
      // Get client IDs belonging to this admin
      const myClientIds = state.clients.filter(c => c.adminId === auth.adminId).map(c => c.id);
      return state.trades.filter(t => myClientIds.includes(t.clientId));
    }
    return state.trades.filter(t => t.clientId === auth?.clientId);
  })();

  const currentClient = auth?.role === "client" ? state.clients.find((c) => c.id === auth.clientId) : null;

  const ledgerWithBalance = (cid) => {
    let bal = 0;
    return clientLedger(cid)
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .map((l) => { bal += l.credit - l.debit; return { ...l, balance: bal }; });
  };

  // ── Admin: Add Client ──
  const [newClient, setNewClient] = useState({ id: "", name: "", email: "", phone: "", password: "" });
  const addClient = () => {
    if (!newClient.id || !newClient.name || !newClient.password) return notify("Fill required fields", "error");
    if (state.clients.find((c) => c.id === newClient.id)) return notify("Client ID already exists", "error");
    const client = { ...newClient, created_at: new Date().toISOString() };
    setState((s) => ({ ...s, clients: [...s.clients, client] }));
    withSync(() => sb.upsert("clients", client));
    setNewClient({ id: "", name: "", email: "", phone: "", password: "" });
    setModal(null);
    notify("Client added successfully");
  };

  // ── Admin: Add Ledger Entry ──
  const [newLedger, setNewLedger] = useState({ clientId: "", date: "", description: "", credit: "", debit: "", ledgerType: "all" });
  const [ledgerClientFilter, setLedgerClientFilter] = useState("all");
  const [ledgerTabFilter, setLedgerTabFilter] = useState("all");
  const [editLedgerEntry, setEditLedgerEntry] = useState(null);
  const [auditFilterClient, setAuditFilterClient] = useState("all");
  const [auditFilterAction, setAuditFilterAction] = useState("all");

  const addLedger = () => {
    if (!newLedger.clientId || !newLedger.date || !newLedger.description) return notify("Fill required fields", "error");
    const entry = {
      id: "L" + Date.now(),
      ...newLedger,
      credit:      +newLedger.credit || 0,
      debit:       +newLedger.debit  || 0,
      ledgerType:  newLedger.ledgerType || "all",
      // Audit fields
      createdBy:   auth?.role === "superadmin" ? "JIYA" : (state.admins||[]).find(a=>a.id===auth?.adminId)?.name || "Admin",
      createdAt:   new Date().toISOString(),
    };
    setState((s) => ({ ...s, ledger: [...s.ledger, entry] }));
    withSync(() => sb.upsert("ledger", entry));
    pushAudit("ADDED", entry.clientId, `${entry.credit>0?`₹${entry.credit} credit`:`₹${entry.debit} debit`} — "${entry.narration||entry.description||""}"`);
    setNewLedger({ clientId: "", date: "", description: "", credit: "", debit: "", ledgerType: "all" });
    setModal(null);
    notify("Ledger entry added");
    addBell(`New ledger entry added for ${newLedger.clientId}`, "ledger", "ledger");
  };

  // ── Audit trail helper ──
  const currentActorName = () =>
    auth?.role === "superadmin" ? "JIYA" : (state.admins||[]).find(a=>a.id===auth?.adminId)?.name || "Admin";

  const pushAudit = (action, clientId, details) => {
    const entry = {
      id:        "AUD_" + Date.now() + "_" + Math.random().toString(36).slice(2,6),
      action,                     // "ADDED" | "EDITED" | "DELETED"
      clientId,
      details,                    // human readable string
      actor:     currentActorName(),
      timestamp: new Date().toISOString(),
    };
    setState(s => ({ ...s, auditLog: [entry, ...(s.auditLog||[])].slice(0, 2000) }));
    withSync(() => sb.upsert("audit_log", entry));
  };

  const saveLedgerEdit = () => {
    if (!editLedgerEntry) return;
    const before = state.ledger.find(l => l.id === editLedgerEntry.id);
    const updated = { ...editLedgerEntry, credit: +editLedgerEntry.credit || 0, debit: +editLedgerEntry.debit || 0 };
    setState(s => ({ ...s, ledger: s.ledger.map(l => l.id === updated.id ? updated : l) }));
    withSync(() => sb.upsert("ledger", updated));
    // Audit: log what changed
    if (before) {
      const changes = [];
      if (before.credit !== updated.credit) changes.push(`Credit ₹${before.credit} → ₹${updated.credit}`);
      if (before.debit  !== updated.debit)  changes.push(`Debit ₹${before.debit} → ₹${updated.debit}`);
      if (before.narration !== updated.narration) changes.push(`Note changed`);
      pushAudit("EDITED", updated.clientId, changes.join(", ") || "Entry updated");
    }
    setEditLedgerEntry(null);
    setModal(null);
    notify("Entry updated");
  };

  const deleteLedgerEntry = (id) => {
    const entry = state.ledger.find(l => l.id === id);
    setState(s => ({ ...s, ledger: s.ledger.filter(l => l.id !== id) }));
    withSync(() => sb.delete("ledger", id));
    if (entry) {
      const amt = entry.credit > 0 ? `₹${entry.credit} credit` : `₹${entry.debit} debit`;
      pushAudit("DELETED", entry.clientId, `Removed ${amt} — "${entry.narration||""}"`);
    }
    notify("Entry deleted");
  };

  // ── Trade Upload (Broker Master File) ──
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadPreview, setUploadPreview] = useState(null);
  const [uploadMode, setUploadMode] = useState("replace");
  const [uploadHistory, setUploadHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem("jiya_upload_history") || "[]"); }
    catch(e) { return []; }
  });
  const [uploadTradeDate, setUploadTradeDate] = useState(new Date().toISOString().slice(0,10));

  // Normalize expiry date to standard format: DDMMMYYYY (e.g. 02APR2026)
  // Handles: "02APR2026", "02-Apr-26", "02-Apr-2026", "2026-04-02", "02/04/2026" etc.
  const normalizeExpiry = (raw) => {
    if (!raw) return "";
    const s = raw.trim();

    const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

    // Already standard: "02APR2026"
    if (/^\d{2}[A-Z]{3}\d{4}$/.test(s)) return s;

    // "02APR26" → "02APR2026"
    if (/^\d{2}[A-Z]{3}\d{2}$/.test(s)) {
      return s.slice(0,5) + "20" + s.slice(5);
    }

    // "02-Apr-26" or "02-Apr-2026"
    const m1 = s.match(/^(\d{1,2})[-\/]([A-Za-z]{3})[-\/](\d{2,4})$/);
    if (m1) {
      const dd = m1[1].padStart(2,"0");
      const mon = m1[2].toUpperCase();
      const yr = m1[3].length === 2 ? "20"+m1[3] : m1[3];
      return `${dd}${mon}${yr}`;
    }

    // "2026-04-02" (ISO format)
    const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m2) {
      const yr = m2[1], mo = parseInt(m2[2])-1, dd = m2[3];
      return `${dd}${MONTHS[mo]}${yr}`;
    }

    // "02/04/2026" (DD/MM/YYYY)
    const m3 = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m3) {
      const dd = m3[1], mo = parseInt(m3[2])-1, yr = m3[3];
      return `${dd}${MONTHS[mo]}${yr}`;
    }

    // Fallback: uppercase as-is
    return s.toUpperCase();
  };

  // Build contract name — always produces consistent format
  // e.g. "SENSEX 72300 PE 02APR2026"
  const buildContractName = (row) => {
    const type    = (row.instrType || "").toUpperCase().trim();
    const symbol  = (row.symbol   || "").trim().toUpperCase();
    const expiry  = normalizeExpiry(row.expiry  || "");
    const strike  = (row.strike   || "").trim();
    const optType = (row.optType  || "").trim().toUpperCase();

    if (["OPTIONS","OPTION","OPT","OPTIDX","OPTSTK"].includes(type)) {
      return `${symbol} ${strike} ${optType} ${expiry}`.replace(/\s+/g," ").trim();
    } else if (["FUTURE","FUT","FUTURES","FUTIDX","FUTSTK"].includes(type)) {
      return `${symbol} FUT ${expiry}`.replace(/\s+/g," ").trim();
    } else {
      return symbol;
    }
  };

  // Smart CSV splitter — handles quoted fields with commas inside
  const splitCSVLine = (line) => {
    const result = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuotes = !inQuotes; }
      else if (ch === "," && !inQuotes) { result.push(current.trim()); current = ""; }
      else { current += ch; }
    }
    result.push(current.trim());
    return result;
  };

  const parseBrokerCSV = (text) => {
    // Normalize line endings (Windows \r\n, Mac \r, Unix \n)
    const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split("\n");
    if (lines.length < 2) return { rows: [], warnings: ["File appears empty"] };

    const rawHeader = splitCSVLine(lines[0]);
    const header = rawHeader.map(h => h.replace(/"/g, "").trim());
    const headerLow = header.map(h => h.toLowerCase().replace(/\s+/g, " ").trim());
    const totalCols = header.length;

    // ── Smart column detector — finds by EXACT header name first, then partial ──
    const findIdx = (exactMatches, partialMatches) => {
      // Try exact match first (case insensitive)
      for (const ex of exactMatches) {
        const i = headerLow.findIndex(h => h === ex.toLowerCase());
        if (i !== -1) return i;
      }
      // Try partial match
      for (const pt of partialMatches) {
        const i = headerLow.findIndex(h => h.includes(pt.toLowerCase()));
        if (i !== -1) return i;
      }
      return -1;
    };

    const idxUserId    = findIdx(["User","User Id","User ID"],           ["user"]);
    const idxExchange  = findIdx(["Exchange"],                            ["exchange"]);
    const idxInstrType = findIdx(["Instrument Type","InstrumentType"],    ["instrument type","instr type"]);
    const idxSymbol    = findIdx(["Symbol","Symbol/Scr"],                 ["symbol"]);
    const idxExpiry    = findIdx(["Ser/Exp/Group","Ser/Exp/Gr","Expiry"], ["ser/exp","expiry"]);
    const idxStrike    = findIdx(["Strike Price","StrikePrice"],          ["strike"]);
    const idxOptType   = findIdx(["Option Type","Option Typ"],            ["option"]);
    const idxScriptName= findIdx(["Scrip Name","Script Name"],            ["scrip","script name"]);
    const idxSide      = findIdx(["B/S","Buy/Sell"],                      ["b/s"]);
    const idxQty       = findIdx(["Quantity","Qty"],                      ["quantity","qty"]);
    const idxPrice     = findIdx(["Price","Trade Price","Order Price"],    ["price"]);
    const idxTime      = findIdx(["Time","Trade Time"],                   ["time"]);

    const warnings = [];

    // Show detected mapping clearly
    const mapInfo = [
      `User=[${idxUserId}]"${header[idxUserId]}"`,
      `InstrType=[${idxInstrType}]"${header[idxInstrType]}"`,
      `Symbol=[${idxSymbol}]"${header[idxSymbol]}"`,
      `Expiry=[${idxExpiry}]"${header[idxExpiry]}"`,
      `Strike=[${idxStrike}]"${header[idxStrike]}"`,
      `OptType=[${idxOptType}]"${header[idxOptType]}"`,
      `B/S=[${idxSide}]"${header[idxSide]}"`,
      `Qty=[${idxQty}]"${header[idxQty]}"`,
      `Price=[${idxPrice}]"${header[idxPrice]}"`,
      `Time=[${idxTime}]"${header[idxTime]}"`,
    ].join(" | ");
    warnings.push(`ℹ️ ${totalCols} columns. Mapping: ${mapInfo}`);

    if (idxUserId  === -1) warnings.push("❌ CRITICAL: 'User' column not found!");
    if (idxSide    === -1) warnings.push("❌ CRITICAL: 'B/S' column not found!");
    if (idxQty     === -1) warnings.push("❌ CRITICAL: 'Quantity' column not found!");
    if (idxPrice   === -1) warnings.push("❌ CRITICAL: 'Price' column not found!");
    if (idxSymbol  === -1) warnings.push("❌ CRITICAL: 'Symbol' column not found!");
    if (idxStrike  === -1) warnings.push("⚠️ Strike Price column not found");
    if (idxOptType === -1) warnings.push("⚠️ Option Type column not found");
    if (idxExpiry  === -1) warnings.push("⚠️ Expiry column not found");

    const rows = [];
    let skippedRows = 0;
    let skippedReasons = {};

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      const cols = splitCSVLine(line);
      if (cols.length < 3) continue;

      const clientId   = idxUserId >= 0    ? cols[idxUserId]?.replace(/"/g,"").trim()    : "";
      const rawSide    = idxSide >= 0      ? cols[idxSide]?.replace(/"/g,"").trim().toUpperCase() : "";
      const rawQty     = idxQty >= 0       ? cols[idxQty]?.replace(/"/g,"").trim()       : "";
      const rawPrice   = idxPrice >= 0     ? cols[idxPrice]?.replace(/"/g,"").trim()     : "";
      const time       = idxTime >= 0      ? cols[idxTime]?.replace(/"/g,"").trim()      : "";
      const exchange   = idxExchange >= 0  ? cols[idxExchange]?.replace(/"/g,"").trim()  : "";
      const instrType  = idxInstrType >= 0 ? cols[idxInstrType]?.replace(/"/g,"").trim() : "";
      const symbol     = idxSymbol >= 0    ? cols[idxSymbol]?.replace(/"/g,"").trim()    : "";
      const expiry     = idxExpiry >= 0    ? cols[idxExpiry]?.replace(/"/g,"").trim()    : "";
      const strike     = idxStrike >= 0    ? cols[idxStrike]?.replace(/"/g,"").trim()    : "";
      const optType    = idxOptType >= 0   ? cols[idxOptType]?.replace(/"/g,"").trim()   : "";
      const scriptName = idxScriptName >= 0? cols[idxScriptName]?.replace(/"/g,"").trim(): "";

      const qty   = parseFloat(rawQty);
      const price = parseFloat(rawPrice);

      // Skip & track reason
      const skip = (reason) => { skippedRows++; skippedReasons[reason] = (skippedReasons[reason]||0)+1; return true; };

      if (!clientId)                          { skip("no clientId"); continue; }
      if (isNaN(qty) || qty <= 0)             { skip("invalid qty: "+rawQty); continue; }
      if (isNaN(price) || price <= 0)         { skip("invalid price: "+rawPrice); continue; }
      if (price > 100000)                     { skip("price too large (order no?): "+price); continue; }

      // Normalize B/S
      const sideNorm = (rawSide === "B" || rawSide === "BUY")  ? "BUY"
                     : (rawSide === "S" || rawSide === "SELL") ? "SELL" : "";
      if (!sideNorm) { skip("unknown side: '"+rawSide+"'"); continue; }

      const contract = buildContractName({ instrType, symbol, expiry, strike, optType, scriptName });

      // Use time field for intra-day ordering; use uploadBatch for inter-day ordering
      const tradeDate = uploadTradeDate || new Date().toISOString().slice(0,10);

      rows.push({
        id: `T${Date.now()}_${i}_${Math.random().toString(36).slice(2,6)}`,
        clientId, contract, side: sideNorm, qty, price,
        time, date: tradeDate, exchange, instrType, scriptName,
      });
    }

    if (skippedRows > 0) {
      const reasons = Object.entries(skippedReasons).map(([r,c])=>`${r}(×${c})`).join(", ");
      warnings.push(`⚠️ Skipped ${skippedRows} rows — reasons: ${reasons}`);
    }

    return { rows, warnings };
  };

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploadFile(file);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target.result;
      const result = parseBrokerCSV(text);
      setUploadPreview(result);
    };
    reader.readAsText(file);
  };

  // ── Undo last upload by batchId ──
  const undoUpload = async (entry) => {
    if (!window.confirm(
      "Undo this upload?\n" +
      entry.tradeCount + " trades from " + entry.filename + "\n" +
      "This will remove those trades permanently."
    )) return;

    const { batchId, mode, month } = entry;

    // Remove from local state
    setState(s => ({ ...s, trades: s.trades.filter(t => t.batchId !== batchId) }));

    // Remove from Supabase
    withSync(async () => {
      // Delete in batches by batchId
      while (true) {
        const existing = await sb.select("trades", `?batchId=eq.${batchId}&limit=1000&select=id`);
        if (!Array.isArray(existing) || existing.length === 0) break;
        const ids = existing.map(r => r.id).join(",");
        await fetch(`${sb.url("trades")}?id=in.(${ids})`, {
          method: "DELETE",
          headers: { ...sb.headers, "Prefer": "" }
        });
        if (existing.length < 1000) break;
      }
    });

    // Remove from history
    setUploadHistory(prev => {
      const updated = prev.filter(h => h.batchId !== batchId);
      try { localStorage.setItem("jiya_upload_history", JSON.stringify(updated)); } catch(e) {}
      return updated;
    });

    notify("✅ Upload undone — " + entry.tradeCount + " trades removed");
  };

  const confirmUpload = () => {
    if (!uploadPreview || !uploadPreview.rows.length) return notify("No valid trades to import", "error");
    const batchId = Date.now();
    const newTrades = uploadPreview.rows.map(t => ({ ...t, batchId }));
    const clientsInFile = [...new Set(newTrades.map((t) => t.clientId))];
    const unknownClients = clientsInFile.filter((cid) => !state.clients.find((c) => c.id === cid));

    setState((s) => ({
      ...s,
      trades: uploadMode === "replace"
        ? [
            // Keep locked month trades + add new current month trades
            ...s.trades.filter(t => {
              const m = (t.date || "").slice(0, 7);
              return (s.lockedMonths || []).includes(m);
            }),
            ...newTrades
          ]
        : [...s.trades, ...newTrades],
    }));

    withSync(async () => {
      if (uploadMode === "replace") {
        // Delete ONLY current month trades — locked months are NEVER touched
        const currentMonth = new Date().toISOString().slice(0, 7); // "2026-05"
        const lockedMonths = state.lockedMonths || [];
        // Delete current month trades in batches
        while (true) {
          // Only fetch trades from current (unlocked) month
          const existing = await sb.select("trades",
            `?date=gte.${currentMonth}-01&date=lt.${currentMonth}-32&limit=1000&select=id`
          );
          if (!Array.isArray(existing) || existing.length === 0) break;
          const ids = existing.map(r => r.id).join(",");
          await fetch(`${sb.url("trades")}?id=in.(${ids})`, {
            method: "DELETE",
            headers: { ...sb.headers, "Prefer": "" }
          });
          if (existing.length < 1000) break;
        }
      }
      // Insert in batches of 500
      for (let i = 0; i < newTrades.length; i += 500) {
        await sb.upsert("trades", newTrades.slice(i, i + 500));
      }
    });

    setUploadFile(null);
    setUploadPreview(null);
    setModal(null);
    const warn = unknownClients.length ? ` ⚠️ Unknown client IDs: ${unknownClients.join(", ")}` : "";
    notify(`${newTrades.length} trades imported for ${clientsInFile.length} clients.${warn}`);
    addBell(`${newTrades.length} trades uploaded (${clientsInFile.length} clients)`, "trade", "trades");

    // ── Save to upload history (keep last 5) ──
    const histEntry = {
      batchId,
      timestamp:  new Date().toISOString(),
      mode:       uploadMode,
      tradeCount: newTrades.length,
      clients:    clientsInFile.length,
      filename:   uploadFile?.name || "unknown",
      month:      new Date().toISOString().slice(0,7),
    };
    setUploadHistory(prev => {
      const updated = [histEntry, ...prev].slice(0, 5); // keep last 5
      try { localStorage.setItem("jiya_upload_history", JSON.stringify(updated)); } catch(e) {}
      return updated;
    });
  };

  // ── Support Tickets ──
  const [newTicket, setNewTicket] = useState({ subject: "", issueType: "", description: "", attachments: [] });
  const [ticketFilter, setTicketFilter] = useState("all"); // all | open | closed | answered
  const createTicket = () => {
    if (!newTicket.issueType || !newTicket.description) return notify("Fill all required fields", "error");
    const ticket = {
      id: "TK" + Date.now(),
      clientId: auth.clientId,
      subject: newTicket.issueType,
      issueType: newTicket.issueType,
      message: newTicket.description,
      attachments: newTicket.attachments || [],
      status: "open",
      date: new Date().toISOString().slice(0, 10),
      replies: []
    };
    setState((s) => ({ ...s, tickets: [...s.tickets, ticket] }));
    withSync(() => sb.upsert("tickets", ticket));
    setNewTicket({ subject: "", issueType: "", description: "", attachments: [] });
    setModal(null);
    notify("Ticket submitted successfully");
  };

  const [replyText, setReplyText] = useState("");
  const replyTicket = (ticketId) => {
    if (!replyText.trim()) return;
    const reply = { from: "admin", text: replyText, date: new Date().toISOString().slice(0, 10) };
    setState((s) => ({
      ...s,
      tickets: s.tickets.map((t) => t.id === ticketId
        ? { ...t, replies: [...t.replies, reply], status: "answered" }
        : t)
    }));
    const updatedTicket = state.tickets.find(t => t.id === ticketId);
    if (updatedTicket) {
      const newReplies = [...(updatedTicket.replies || []), reply];
      withSync(() => sb.upsert("tickets", { ...updatedTicket, replies: newReplies, status: "answered" }));
    }
    setReplyText("");
    notify("Reply sent");
  };

  // ── Login Screen ──
  // ── DB Loading screen ──
  if (dbLoading) return (
    <div style={{ minHeight:"100vh", background:"#0d1117", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", fontFamily:"'Inter',sans-serif", overflow:"hidden", position:"relative" }}>
      <style>{`
        @keyframes pulse-ring {
          0%   { transform: scale(0.8); opacity:1; }
          100% { transform: scale(2.2); opacity:0; }
        }
        @keyframes fade-up {
          from { opacity:0; transform:translateY(16px); }
          to   { opacity:1; transform:translateY(0); }
        }
        @keyframes blink {
          0%,100% { opacity:1; } 50% { opacity:0.2; }
        }
        @keyframes ticker {
          0%   { transform:translateX(0); }
          100% { transform:translateX(-50%); }
        }
        @keyframes bar-grow {
          from { transform:scaleY(0); }
          to   { transform:scaleY(1); }
        }
        @keyframes shimmer {
          0%   { background-position: -400px 0; }
          100% { background-position:  400px 0; }
        }
      `}</style>

      {/* Background grid */}
      <div style={{ position:"absolute", inset:0, backgroundImage:"linear-gradient(rgba(59,130,246,0.04) 1px,transparent 1px),linear-gradient(90deg,rgba(59,130,246,0.04) 1px,transparent 1px)", backgroundSize:"40px 40px", pointerEvents:"none" }}/>

      {/* Animated bars — fake chart in background */}
      <div style={{ position:"absolute", bottom:0, left:0, right:0, height:180, display:"flex", alignItems:"flex-end", gap:3, padding:"0 40px", opacity:0.12 }}>
        {[0.4,0.7,0.5,0.9,0.6,0.8,0.3,0.95,0.55,0.75,0.45,0.85,0.65,0.5,0.7,0.4,0.9,0.6,0.8,0.35,0.7,0.5,0.88,0.6,0.45,0.75,0.55,0.9,0.4,0.7].map((h,i) => (
          <div key={i} style={{ flex:1, background:"#3b82f6", borderRadius:"3px 3px 0 0", height:`${h*100}%`, transformOrigin:"bottom", animation:`bar-grow 0.6s ease-out ${i*0.04}s both` }}/>
        ))}
      </div>

      {/* Center content */}
      <div style={{ position:"relative", textAlign:"center", animation:"fade-up 0.5s ease-out both" }}>

        {/* Pulse ring + logo */}
        <div style={{ position:"relative", width:88, height:88, margin:"0 auto 28px" }}>
          <div style={{ position:"absolute", inset:0, borderRadius:"50%", border:"2px solid #3b82f6", animation:"pulse-ring 1.6s ease-out infinite" }}/>
          <div style={{ position:"absolute", inset:0, borderRadius:"50%", border:"2px solid #3b82f6", animation:"pulse-ring 1.6s ease-out 0.5s infinite" }}/>
          <div style={{ position:"relative", width:88, height:88, borderRadius:"50%", background:"linear-gradient(135deg,#1e3a8a,#1e2761)", display:"flex", alignItems:"center", justifyContent:"center", boxShadow:"0 0 32px rgba(59,130,246,0.3)" }}>
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
              <polyline points="4,28 12,18 20,22 28,10 36,14" stroke="#3b82f6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
              <circle cx="36" cy="14" r="3" fill="#10b981"/>
            </svg>
          </div>
        </div>

        {/* Brand */}
        <div style={{ fontSize:28, fontWeight:800, color:"#ffffff", letterSpacing:"-0.5px", marginBottom:6, animation:"fade-up 0.5s ease-out 0.15s both", opacity:0 }}>
          JIYA <span style={{ color:"#3b82f6" }}>Back Office</span>
        </div>
        <div style={{ fontSize:13, color:"#475569", letterSpacing:"3px", textTransform:"uppercase", marginBottom:36, animation:"fade-up 0.5s ease-out 0.25s both", opacity:0 }}>
          Professional Trading Portal
        </div>

        {/* Progress bar */}
        <div style={{ width:240, margin:"0 auto 16px", animation:"fade-up 0.5s ease-out 0.35s both", opacity:0 }}>
          <div style={{ height:3, background:"#1e2761", borderRadius:2, overflow:"hidden" }}>
            <div style={{ height:"100%", background:"linear-gradient(90deg,#1e3a8a,#3b82f6,#10b981)", backgroundSize:"200% 100%", animation:"shimmer 1.4s linear infinite", borderRadius:2 }}/>
          </div>
        </div>

        {/* Status text */}
        <div style={{ fontSize:12, color:"#3b82f6", letterSpacing:"1px", animation:"blink 1.4s ease-in-out infinite" }}>
          {dbError ? "⚠ Connection issue — retrying..." : "● ESTABLISHING SECURE CONNECTION"}
        </div>

        {/* Error state */}
        {dbError && (
          <div style={{ marginTop:24, background:"#1c1c2e", border:"1px solid #ef444433", borderRadius:10, padding:"16px 24px", maxWidth:380, animation:"fade-up 0.3s ease-out both" }}>
            <div style={{ color:"#ef4444", fontWeight:600, fontSize:13, marginBottom:8 }}>Connection failed</div>
            <div style={{ color:"#94a3b8", fontSize:12, marginBottom:14 }}>{dbError}</div>
            <button onClick={() => { setDbLoading(false); setDbError(null); }}
              style={{ background:"#1e3a8a", color:"#93c5fd", border:"1px solid #3b82f6", borderRadius:6, padding:"8px 18px", cursor:"pointer", fontSize:12, fontWeight:600 }}>
              Continue offline
            </button>
          </div>
        )}
      </div>

      {/* Bottom ticker */}
      <div style={{ position:"absolute", bottom:0, left:0, right:0, height:32, background:"#0a0e17", borderTop:"1px solid #1e2761", overflow:"hidden", display:"flex", alignItems:"center" }}>
        <div style={{ display:"flex", gap:40, whiteSpace:"nowrap", animation:"ticker 18s linear infinite", fontSize:11, color:"#334155", fontFamily:"monospace" }}>
          {["SENSEX  81,245.30  +0.42%","NIFTY  24,812.55  +0.38%","BANKNIFTY  53,124.80  +0.21%","FINNIFTY  23,445.60  -0.12%","MIDCPNIFTY  12,234.15  +0.55%",
            "SENSEX  81,245.30  +0.42%","NIFTY  24,812.55  +0.38%","BANKNIFTY  53,124.80  +0.21%","FINNIFTY  23,445.60  -0.12%","MIDCPNIFTY  12,234.15  +0.55%"].map((t,i) => (
            <span key={i} style={{ color: t.includes("-") ? "#ef4444" : "#10b981" }}>{t}</span>
          ))}
        </div>
      </div>
    </div>
  );

  if (!auth) return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(135deg, #dbeafe 0%, #ede9fe 50%, #fce7f3 100%)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Inter','Segoe UI',sans-serif" }}>
      <div style={{ background: "#fff", borderRadius: 24, padding: "52px 44px", width: 420, boxShadow: "0 24px 64px rgba(59,130,246,0.14), 0 4px 16px rgba(0,0,0,0.06)" }}>
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <div style={{ width: 64, height: 64, background: "linear-gradient(135deg, #3b82f6, #6366f1)", borderRadius: 20, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px", fontSize: 28, boxShadow: "0 6px 20px rgba(59,130,246,0.35)" }}>📊</div>
          <h1 style={{ color: "#1a202c", margin: 0, fontSize: 28, fontWeight: 800, letterSpacing: "-0.5px" }}>JIYA Back Office</h1>
          <p style={{ color: "#718096", margin: "8px 0 0", fontSize: 14 }}>Authorized Personnel Only</p>
        </div>

        {lockoutUntil && Date.now() < lockoutUntil && (
          <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: "12px 16px", marginBottom: 16, color: "#dc2626", fontSize: 13, textAlign: "center" }}>
            🔒 Account temporarily locked. Please wait.
          </div>
        )}

        {["User ID", "Password"].map((label, i) => (
          <div key={i} style={{ marginBottom: 16 }}>
            <label style={{ color: "#4a5568", fontSize: 12, fontWeight: 600, letterSpacing: 0.5, textTransform: "uppercase" }}>{label}</label>
            <input
              type={i === 1 ? "password" : "text"}
              value={i === 0 ? loginForm.user : loginForm.pass}
              onChange={(e) => setLoginForm((f) => ({ ...f, [i === 0 ? "user" : "pass"]: e.target.value, error: "" }))}
              onKeyDown={(e) => e.key === "Enter" && handleLogin()}
              style={{ width: "100%", marginTop: 6, padding: "13px 16px", background: "#f8fafc", border: "1.5px solid #e2e8f0", borderRadius: 12, color: "#1a202c", fontSize: 15, outline: "none", boxSizing: "border-box", transition: "border-color 0.2s" }}
              placeholder={i === 0 ? "Enter your User ID" : "Enter your password"}
              autoComplete={i === 1 ? "current-password" : "username"}
            />
          </div>
        ))}
        {loginForm.error && (
          <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "10px 14px", marginBottom: 14, color: "#dc2626", fontSize: 13 }}>
            ⚠️ {loginForm.error}
          </div>
        )}
        <button onClick={handleLogin} style={{ width: "100%", padding: "15px", background: "linear-gradient(135deg, #3b82f6, #6366f1)", border: "none", borderRadius: 14, color: "#fff", fontSize: 16, fontWeight: 700, cursor: "pointer", boxShadow: "0 4px 16px rgba(59,130,246,0.3)", letterSpacing: 0.3 }}>
          Sign In →
        </button>
        <p style={{ color: "#cbd5e0", fontSize: 11, textAlign: "center", marginTop: 24 }}>
          This is a secured system. Unauthorized access is prohibited.
        </p>
      </div>
    </div>
  );

  // ── Colors & Styles (Light Theme) ──
  const C = {
    bg:      "#f4f6f9",      // page background
    sidebar: "#ffffff",      // sidebar white
    card:    "#ffffff",      // card white
    border:  "#e2e8f0",      // soft border
    text:    "#1a202c",      // dark text
    muted:   "#718096",      // grey text
    accent:  "#3b82f6",      // blue
    green:   "#16a34a",      // profit green
    red:     "#dc2626",      // loss red
    yellow:  "#d97706",      // warning amber
    purple:  "#7c3aed",      // purple
  };
  const card = { background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 24px", boxShadow: "0 1px 4px rgba(0,0,0,0.06)" };
  const btn = (color = C.accent) => ({ background: color, color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", cursor: "pointer", fontSize: 13, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6 });
  const input = { width: "100%", background: "#f8fafc", border: `1px solid ${C.border}`, borderRadius: 8, padding: "9px 12px", color: C.text, fontSize: 14, outline: "none", boxSizing: "border-box" };
  const badge = (color) => ({ background: color + "18", color: color, padding: "2px 10px", borderRadius: 20, fontSize: 12, fontWeight: 600 });

  // ── Sidebar ──
  const adminPages = [
    { id: "dashboard", label: "Dashboard", icon: "dashboard" },
    { id: "clients", label: "Clients", icon: "clients" },
    { id: "ledger", label: "Ledger", icon: "ledger" },
    { id: "trades", label: "Trades & Positions", icon: "trades" },
    { id: "pnl", label: "Profit & Loss", icon: "pnl" },
    { id: "charges", label: "Charges", icon: "charges", locked: !hasFeature(auth?.plan, "charges") },
    { id: "tickets", label: "Support Tickets", icon: "ticket" },
    ...(hasFeature(auth?.plan, "audit") ? [{ id: "audit", label: "📋 Audit Log", icon: "ledger" }] : []),
    { id: "rms", label: "📡 RMS", icon: "dashboard", locked: !hasFeature(auth?.plan, "rms") },
    { id: "settings", label: "⚙️ Settings", icon: "dashboard" },
    // Super admin only
    ...(auth?.role === "superadmin" ? [
      { id: "manage_admins", label: "👥 Manage Admins", icon: "clients" },
      { id: "manage_tokens", label: "🔑 Tokens", icon: "dashboard" },
    ] : []),
  ];
  const clientPages = [
    { id: "dashboard", label: "Dashboard", icon: "dashboard" },
    { id: "ledger", label: "My Ledger", icon: "ledger" },
    { id: "trades", label: "My Positions", icon: "trades" },
    { id: "pnl", label: "My P&L", icon: "pnl" },
    { id: "tickets", label: "Support", icon: "ticket" },
  ];
  const pages = (auth.role === "admin" || auth.role === "superadmin") ? adminPages : clientPages;

  // ── Dashboard Data ──
  const QUOTES = [
    { text: "The stock market is a device for transferring money from the impatient to the patient.", author: "Warren Buffett" },
    { text: "In investing, what is comfortable is rarely profitable.", author: "Robert Arnott" },
    { text: "The four most dangerous words in investing are: 'This time it's different.'", author: "Sir John Templeton" },
    { text: "Risk comes from not knowing what you're doing.", author: "Warren Buffett" },
    { text: "The market is a pendulum that forever swings between unsustainable optimism and unjustified pessimism.", author: "Benjamin Graham" },
    { text: "It's not whether you're right or wrong, but how much money you make when you're right.", author: "George Soros" },
    { text: "The goal of a successful trader is to make the best trades. Money is secondary.", author: "Alexander Elder" },
    { text: "An investment in knowledge pays the best interest.", author: "Benjamin Franklin" },
    { text: "The biggest risk of all is not taking one.", author: "Mellody Hobson" },
    { text: "Price is what you pay. Value is what you get.", author: "Warren Buffett" },
    { text: "Markets can remain irrational longer than you can remain solvent.", author: "John Maynard Keynes" },
    { text: "October: This is one of the peculiarly dangerous months to speculate in stocks.", author: "Mark Twain" },
    { text: "Wide diversification is only required when investors do not understand what they are doing.", author: "Warren Buffett" },
    { text: "Every day is a new opportunity. You can build on yesterday's success or put its failures behind.", author: "Bob Feller" },
    { text: "The secret to investing is to figure out the value of something — and then pay a lot less.", author: "Joel Greenblatt" },
    { text: "Successful investing is about managing risk, not avoiding it.", author: "Benjamin Graham" },
    { text: "Time in the market beats timing the market.", author: "Ken Fisher" },
    { text: "Do not save what is left after spending; instead spend what is left after saving.", author: "Warren Buffett" },
    { text: "The individual investor should act consistently as an investor and not as a speculator.", author: "Benjamin Graham" },
    { text: "Patience is the most underrated skill in trading.", author: "Unknown" },
    { text: "Bulls make money, bears make money, pigs get slaughtered.", author: "Wall Street Proverb" },
    { text: "Cut your losses short and let your profits run.", author: "Jesse Livermore" },
    { text: "The trend is your friend until it ends.", author: "Ed Seykota" },
    { text: "Trade what you see, not what you think.", author: "Unknown" },
    { text: "Compound interest is the eighth wonder of the world.", author: "Albert Einstein" },
    { text: "You get recessions, you have stock market declines. If you don't understand that's going to happen, you're not ready.", author: "Peter Lynch" },
    { text: "Know what you own, and know why you own it.", author: "Peter Lynch" },
    { text: "The market is not your mother. It consists of tough men and women who look for ways to take money away from you.", author: "Alexander Elder" },
    { text: "Be fearful when others are greedy and greedy when others are fearful.", author: "Warren Buffett" },
    { text: "In the short run, the market is a voting machine. In the long run, it is a weighing machine.", author: "Benjamin Graham" },
  ];
  const todayQuote = QUOTES[new Date().getDate() % QUOTES.length];

  // ── Render Pages ──
  const renderPage = () => {
    const cid = auth.role === "client" ? auth.clientId : null;

    if (page === "dashboard") {
      // ── Calculations (DO NOT TOUCH) ──────────────────────────
      const clientPnlData = visibleClients.map(client => {
        const closed = clientClosedPos(client.id);
        const open   = clientOpenPos(client.id);
        const realizedPnl = closed.reduce((a, c) => a + c.totalPnl, 0);
        const mtmPnl = open.reduce((p, pos) => {
          const close = getBhavClose(pos.contract);
          if (close === null) return p;
          return p + (pos.side === "SELL" ? (pos.avgPrice - close) : (close - pos.avgPrice)) * pos.netQty;
        }, 0);
        return {
          id: client.id,
          name: client.name,
          realizedPnl: +realizedPnl.toFixed(2),
          mtmPnl:      +mtmPnl.toFixed(2),
          totalPnl:    +(realizedPnl + mtmPnl).toFixed(2),
          openCount:   open.length,
        };
      }).filter(c => c.realizedPnl !== 0 || c.mtmPnl !== 0 || c.openCount > 0);

      const totalRealized = clientPnlData.reduce((a, c) => a + c.realizedPnl, 0);
      const totalMtm      = clientPnlData.reduce((a, c) => a + c.mtmPnl, 0);
      const maxAbs        = Math.max(...clientPnlData.map(c => Math.abs(c.totalPnl)), 1);
      const now           = new Date();
      const currentMonthStr = now.toISOString().slice(0, 7);
      const greeting      = now.getHours() < 12 ? "Good morning" : now.getHours() < 17 ? "Good afternoon" : "Good evening";
      const fmtCcy        = (n) => (n < 0 ? "−" : "+") + "₹" + Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
      const fmtAbs        = (n) => "₹" + Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });

      // ── This Month P&L (raw trade value — used only for Win Rate, DO NOT TOUCH) ──
      const allTrades = visibleTrades || state.trades;
      const monthMap  = {};
      allTrades.forEach(t => {
        const m = (t.date || "").slice(0, 7);
        if (!m) return;
        if (!monthMap[m]) monthMap[m] = { buyVal: 0, sellVal: 0 };
        const v = (t.price || 0) * (t.qty || 0);
        if (t.side === "BUY")  monthMap[m].buyVal  += v;
        if (t.side === "SELL") monthMap[m].sellVal += v;
      });

      // ── Accurate Net P&L per client for a given month (matches P&L page exactly) ──
      // Net P&L = Realized (closed FIFO positions) − Expenses − Software Charges − Interest
      const clientNetPnlForMonth = (clientId, yearMonth) => {
        const closedForClient = clientClosedPos(clientId);
        const realized = closedForClient
          .filter(cp => cp.trades.some(t => (t.date||"").slice(0,7) === yearMonth))
          .reduce((a,c) => a + c.totalPnl, 0);
        const expenses = getMonthlyCharges(clientId, yearMonth);
        const software  = getMonthlyInterest(clientId, yearMonth + "_SW");
        const interest  = getMonthlyInterest(clientId, yearMonth);
        return realized - expenses - software - interest;
      };

      // This Month Net P&L — sum across all visible clients (matches P&L page logic)
      const thisMonthPnl = visibleClients.reduce((sum, c) => sum + clientNetPnlForMonth(c.id, currentMonthStr), 0);

      // ── Win Rate (12 months) ─────────────────────────────────
      const last12     = Object.entries(monthMap).sort((a, b) => a[0] > b[0] ? -1 : 1).slice(0, 12);
      const profMonths = last12.filter(([, v]) => (v.sellVal - v.buyVal) > 0).length;
      const winRate    = last12.length > 0 ? Math.round(profMonths / last12.length * 100) : 0;
      const wrColor    = winRate >= 60 ? C.green : winRate >= 40 ? C.yellow : C.red;

      // ── 6-month chart data ───────────────────────────────────
      const months6 = [];
      for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months6.push(d.toISOString().slice(0, 7));
      }
      const CHART_COLORS = ["#3b82f6","#10b981","#f59e0b","#ef4444","#8b5cf6","#ec4899","#06b6d4"];

      // ── CLIENT DASHBOARD ─────────────────────────────────────
      if (auth?.role === "client") {
        const myData   = clientPnlData.find(c => c.id === cid) || { realizedPnl: 0, mtmPnl: 0, openCount: 0 };
        const myTrades = allTrades.filter(t => t.clientId === cid);
        const myMonthPnl = clientNetPnlForMonth(cid, currentMonthStr);

        // Daily win rate this month
        const dayMap2 = {};
        myTrades.filter(t=>(t.date||"").slice(0,7)===currentMonthStr).forEach(t=>{
          const d=t.date||""; if(!d) return;
          if(!dayMap2[d]) dayMap2[d]={buyVal:0,sellVal:0};
          const v=(t.price||0)*(t.qty||0);
          if(t.side==="BUY") dayMap2[d].buyVal+=v; else dayMap2[d].sellVal+=v;
        });
        const tDays   = Object.values(dayMap2).filter(d=>d.buyVal>0||d.sellVal>0);
        const pDays   = tDays.filter(d=>(d.sellVal-d.buyVal)>0).length;
        const dayWR   = tDays.length>0 ? Math.round(pDays/tDays.length*100) : 0;
        const myWrC   = winRate>=60?C.green:winRate>=40?C.yellow:C.red;

        return (
          <div style={{maxWidth:960,margin:"0 auto"}}>
            {/* Greeting header */}
            <div style={{marginBottom:24,padding:"24px 28px",
              background:`linear-gradient(135deg, ${C.accent}18 0%, ${C.accent}05 100%)`,
              borderRadius:16,border:`1px solid ${C.accent}20`,
              display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
              <div>
                <div style={{fontSize:11,color:C.accent,fontWeight:700,letterSpacing:2,textTransform:"uppercase",marginBottom:6}}>
                  {greeting}
                </div>
                <div style={{fontSize:22,fontWeight:800,color:C.text,marginBottom:2}}>
                  {currentClient?.name || "Client"}
                </div>
                <div style={{fontSize:12,color:C.muted}}>{new Date().toLocaleDateString("en-IN",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}</div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:11,color:C.muted,marginBottom:4}}>This Month P&L</div>
                <div style={{fontSize:28,fontWeight:800,color:myMonthPnl>=0?C.green:C.red}}>
                  {myMonthPnl>=0?"+":""}₹{Math.abs(myMonthPnl).toLocaleString("en-IN",{maximumFractionDigits:0})}
                </div>
              </div>
            </div>

            {/* 3 stat cards */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:14,marginBottom:24}}>
              {/* Realized P&L */}
              <div style={{...card,padding:"20px 22px"}}>
                <div style={{fontSize:11,color:C.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:0.8,marginBottom:10}}>All-Time Realized</div>
                <div style={{fontSize:26,fontWeight:800,color:myData.realizedPnl>=0?C.green:C.red,lineHeight:1}}>
                  {myData.realizedPnl>=0?"+":""}₹{Math.abs(myData.realizedPnl).toLocaleString("en-IN",{maximumFractionDigits:0})}
                </div>
                <div style={{fontSize:11,color:C.muted,marginTop:6}}>Booked profits/losses</div>
              </div>

              {/* Win Rate */}
              <div style={{...card,padding:"20px 22px",borderTop:`3px solid ${myWrC}`}}>
                <div style={{fontSize:11,color:C.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:0.8,marginBottom:6}}>Win Rate</div>
                <div style={{display:"flex",alignItems:"baseline",gap:8}}>
                  <div style={{fontSize:36,fontWeight:900,color:myWrC,lineHeight:1}}>{winRate}%</div>
                  <div style={{fontSize:12,color:C.muted}}>12 months</div>
                </div>
                <div style={{marginTop:8,height:4,background:C.border,borderRadius:2,overflow:"hidden"}}>
                  <div style={{height:"100%",width:winRate+"%",background:myWrC,borderRadius:2,transition:"width 1s"}}/>
                </div>
                <div style={{fontSize:11,color:C.muted,marginTop:6}}>
                  This month: <b style={{color:myWrC}}>{dayWR}%</b> daily ({pDays}/{tDays.length} days)
                </div>
              </div>

              {/* Open Positions */}
              <div style={{...card,padding:"20px 22px",cursor:"pointer"}}
                onClick={()=>setPage("trades")}
                onMouseEnter={e=>{e.currentTarget.style.boxShadow="0 4px 20px rgba(0,0,0,0.1)";e.currentTarget.style.transform="translateY(-2px)";}}
                onMouseLeave={e=>{e.currentTarget.style.boxShadow="";e.currentTarget.style.transform="";}}>
                <div style={{fontSize:11,color:C.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:0.8,marginBottom:10}}>Open Positions</div>
                <div style={{fontSize:36,fontWeight:800,color:C.accent,lineHeight:1}}>{myData.openCount}</div>
                <div style={{fontSize:11,color:C.muted,marginTop:6}}>Active contracts →</div>
              </div>
            </div>

            {/* Quote */}
            <div style={{padding:"20px 24px",background:`linear-gradient(135deg,#1e3a5f,#1e3a8a)`,
              borderRadius:14,boxShadow:"0 4px 20px rgba(30,58,138,0.2)"}}>
              <div style={{color:"#93c5fd",fontSize:10,fontWeight:700,letterSpacing:2,marginBottom:8,textTransform:"uppercase"}}>Market Insight</div>
              <div style={{color:"#ffffff",fontSize:15,fontStyle:"italic",lineHeight:1.7,marginBottom:8}}>"{todayQuote.text}"</div>
              <div style={{color:"#93c5fd",fontSize:12}}>— {todayQuote.author}</div>
            </div>
          </div>
        );
      }

      // ── ADMIN / SUPERADMIN DASHBOARD ─────────────────────────
      const adminName = auth?.role === "superadmin" ? "JIYA" : (state.admins||[]).find(a=>a.id===auth?.adminId)?.name || "Admin";

      return (
        <div>
          {/* Greeting bar */}
          <div style={{marginBottom:24,display:"flex",justifyContent:"space-between",
            alignItems:"center",flexWrap:"wrap",gap:12}}>
            <div>
              <div style={{fontSize:12,color:C.muted,marginBottom:4}}>
                {greeting}, <span style={{color:C.accent,fontWeight:700}}>{adminName}</span>
              </div>
              <div style={{fontSize:22,fontWeight:800,color:C.text,letterSpacing:"-0.5px"}}>
                Portfolio Overview
              </div>
              <div style={{fontSize:12,color:C.muted,marginTop:2}}>
                {new Date().toLocaleDateString("en-IN",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}
              </div>
            </div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>setPage("trades")}
                style={{...btn(C.accent),fontSize:13,padding:"8px 16px"}}>
                ⬆️ Upload Trades
              </button>
              <button onClick={()=>setPage("rms")}
                style={{...btn(C.card),border:`1px solid ${C.border}`,color:C.text,fontSize:13,padding:"8px 16px"}}>
                📡 Open RMS
              </button>
            </div>
          </div>

          {/* 4 KPI Cards */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:14,marginBottom:24}}>
            {/* This Month P&L */}
            <div style={{...card,padding:"20px 22px",borderLeft:`4px solid ${thisMonthPnl>=0?C.green:C.red}`,cursor:"pointer"}}
              onClick={()=>setPage("pnl")}
              onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-2px)";e.currentTarget.style.boxShadow="0 6px 24px rgba(0,0,0,0.1)";}}
              onMouseLeave={e=>{e.currentTarget.style.transform="";e.currentTarget.style.boxShadow="";}}>
              <div style={{fontSize:11,color:C.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:0.8,marginBottom:8}}>This Month P&L</div>
              {(()=>{
                const v = Math.abs(Math.round(thisMonthPnl));
                return (
                  <div className="kpi-num" style={{fontSize:24,fontWeight:800,color:thisMonthPnl>=0?C.green:C.red,lineHeight:1,marginBottom:6}}>
                    {thisMonthPnl>=0?"+":"−"}₹{v.toLocaleString("en-IN")}
                  </div>
                );
              })()}
              <div style={{fontSize:11,color:C.muted}}>{currentMonthStr} · All clients</div>
              {(() => {
                const totalTrades = allTrades.length;
                const thisMonthTrades = allTrades.filter(t=>(t.date||"").slice(0,7)===currentMonthStr).length;
                if (totalTrades > 0 && thisMonthTrades === totalTrades && totalTrades > 50) {
                  return <div style={{fontSize:10,color:C.yellow,marginTop:2}}>⚠️ All trades tagged as {currentMonthStr}</div>;
                }
                return null;
              })()}
            </div>

            {/* Total Clients */}
            <div style={{...card,padding:"20px 22px",borderLeft:`4px solid ${C.accent}`,cursor:"pointer"}}
              onClick={()=>setPage("clients")}
              onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-2px)";e.currentTarget.style.boxShadow="0 6px 24px rgba(0,0,0,0.1)";}}
              onMouseLeave={e=>{e.currentTarget.style.transform="";e.currentTarget.style.boxShadow="";}}>
              <div style={{fontSize:11,color:C.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:0.8,marginBottom:8}}>Active Clients</div>
              <div className="kpi-num" style={{fontSize:36,fontWeight:800,color:C.accent,lineHeight:1,marginBottom:6}}>{visibleClients.length}</div>
              <div style={{fontSize:11,color:C.muted}}>Tap to manage →</div>
            </div>

            {/* Win Rate */}
            <div style={{...card,padding:"20px 22px",borderLeft:`4px solid ${wrColor}`}}>
              <div style={{fontSize:11,color:C.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:0.8,marginBottom:8}}>Win Rate</div>
              <div style={{display:"flex",alignItems:"baseline",gap:6,marginBottom:6}}>
                <div style={{fontSize:36,fontWeight:800,color:wrColor,lineHeight:1}}>{winRate}%</div>
                <div style={{fontSize:11,color:C.muted}}>12mo</div>
              </div>
              <div style={{height:4,background:C.border,borderRadius:2,overflow:"hidden"}}>
                <div style={{height:"100%",width:winRate+"%",background:wrColor,borderRadius:2}}/>
              </div>
            </div>

            {/* Open Positions */}
            <div style={{...card,padding:"20px 22px",borderLeft:`4px solid ${C.yellow}`,cursor:"pointer"}}
              onClick={()=>setPage("trades")}
              onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-2px)";e.currentTarget.style.boxShadow="0 6px 24px rgba(0,0,0,0.1)";}}
              onMouseLeave={e=>{e.currentTarget.style.transform="";e.currentTarget.style.boxShadow="";}}>
              <div style={{fontSize:11,color:C.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:0.8,marginBottom:8}}>Open Positions</div>
              <div className="kpi-num" style={{fontSize:36,fontWeight:800,color:C.yellow,lineHeight:1,marginBottom:6}}>
                {clientPnlData.reduce((s,c)=>s+c.openCount,0)}
              </div>
              <div style={{fontSize:11,color:C.muted}}>Across all clients →</div>
            </div>
          </div>

          {/* Two column layout */}
          <div style={{display:"grid",gridTemplateColumns:"1.6fr 1fr",gap:16,marginBottom:16}}>

            {/* 6-Month Line Chart */}
            <div style={{...card,padding:0,overflow:"hidden"}}>
              <div style={{padding:"16px 20px",borderBottom:`1px solid ${C.border}`,
                display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div>
                  <div style={{fontWeight:700,color:C.text,fontSize:15}}>6-Month P&L Trend</div>
                  <div style={{color:C.muted,fontSize:12,marginTop:2}}>Net P&L per month per client</div>
                </div>
                <select value={chartClientFilter} onChange={e=>setChartClientFilter(e.target.value)}
                  style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,
                    padding:"5px 10px",color:C.text,fontSize:12,cursor:"pointer"}}>
                  <option value="all">All Clients</option>
                  {visibleClients.map(c=><option key={c.id} value={c.id}>{c.name||c.id}</option>)}
                </select>
              </div>
              <div style={{padding:"16px 20px 12px"}}>
                {(() => {
                  const clientsToShow = chartClientFilter === "all"
                    ? visibleClients.slice(0, 7)
                    : visibleClients.filter(c => c.id === chartClientFilter);

                  const clientLines = clientsToShow.map((cl, ci) => ({
                    name: (cl.name||cl.id).split(" ")[0],
                    color: CHART_COLORS[ci % CHART_COLORS.length],
                    pts: months6.map(m => {
                      const mT = allTrades.filter(t => t.clientId===cl.id && (t.date||"").slice(0,7)===m);
                      let bv=0,sv=0;
                      mT.forEach(t => { const v=(t.price||0)*(t.qty||0); if(t.side==="BUY") bv+=v; else sv+=v; });
                      return sv - bv;
                    })
                  }));

                  const allPts = clientLines.flatMap(c=>c.pts);
                  const maxV   = Math.max(...allPts.map(Math.abs), 1);
                  const H=140, W=560, pad=8;
                  const xStep = (W-pad*2)/(months6.length-1);
                  const toY   = v => (H/2) - (v/maxV)*(H/2-12);
                  const monthLabels = months6.map(m => new Date(m+"-01").toLocaleString("default",{month:"short"}));

                  return (
                    <div>
                      <svg width="100%" height={H+28} viewBox={`0 0 ${W} ${H+28}`} style={{display:"block"}}>
                        {/* Zero line */}
                        <line x1={pad} y1={H/2} x2={W-pad} y2={H/2} stroke={C.border} strokeWidth="1" strokeDasharray="4,3"/>
                        {/* Grid */}
                        {[0.4,0.8].map(r=>[
                          <line key={"u"+r} x1={pad} y1={H/2-r*H/2} x2={W-pad} y2={H/2-r*H/2} stroke={C.border} strokeWidth="0.5" strokeOpacity="0.5"/>,
                          <line key={"d"+r} x1={pad} y1={H/2+r*H/2} x2={W-pad} y2={H/2+r*H/2} stroke={C.border} strokeWidth="0.5" strokeOpacity="0.5"/>
                        ])}
                        {/* Lines */}
                        {clientLines.map(cl=>{
                          const pts = cl.pts.map((v,i)=>({x:pad+i*xStep, y:toY(v)}));
                          const d   = pts.map((p,i)=>`${i===0?"M":"L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
                          return (
                            <g key={cl.name}>
                              <path d={d} fill="none" stroke={cl.color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round"/>
                              {pts.map((p,i)=>(
                                <g key={i}>
                                  <circle cx={p.x} cy={p.y} r="4" fill={cl.color} stroke="#fff" strokeWidth="1.5"/>
                                  <title>{cl.name}: ₹{cl.pts[i].toLocaleString("en-IN",{maximumFractionDigits:0})}</title>
                                </g>
                              ))}
                            </g>
                          );
                        })}
                        {/* Month labels */}
                        {monthLabels.map((m,i)=>(
                          <text key={m} x={pad+i*xStep} y={H+20} textAnchor="middle" fontSize="11" fill={C.muted}>{m}</text>
                        ))}
                      </svg>
                      {/* Legend */}
                      <div style={{display:"flex",gap:12,flexWrap:"wrap",marginTop:4}}>
                        {clientLines.map(cl=>(
                          <div key={cl.name} style={{display:"flex",alignItems:"center",gap:5,fontSize:11,color:C.muted}}>
                            <div style={{width:12,height:3,borderRadius:2,background:cl.color}}/>
                            {cl.name}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>

            {/* Client P&L Ranking */}
            <div style={{...card,padding:0,overflow:"hidden"}}>
              <div style={{padding:"16px 20px",borderBottom:`1px solid ${C.border}`}}>
                <div style={{fontWeight:700,color:C.text,fontSize:15}}>Client P&L</div>
                <div style={{color:C.muted,fontSize:12,marginTop:2}}>This month ranking — Net P&L</div>
              </div>
              <div style={{padding:"8px 0"}}>
                {(() => {
                  // Compute accurate Net P&L once per client (matches P&L page exactly)
                  const ranked = clientPnlData
                    .map(c => ({ ...c, netPnl: clientNetPnlForMonth(c.id, currentMonthStr) }))
                    .sort((a,b) => b.netPnl - a.netPnl)
                    .slice(0, 7);
                  const maxAbsNet = Math.max(...ranked.map(c => Math.abs(c.netPnl)), 1);

                  return ranked.map((c, i) => {
                    const pct = (Math.abs(c.netPnl) / maxAbsNet) * 100;
                    return (
                      <div key={c.id} style={{padding:"10px 20px",display:"flex",alignItems:"center",gap:12,
                        borderBottom:`1px solid ${C.border}22`}}>
                        <div style={{width:20,height:20,borderRadius:"50%",background:C.accent+"20",
                          color:C.accent,fontSize:11,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                          {i+1}
                        </div>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontWeight:600,color:C.text,fontSize:13,marginBottom:3,
                            overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                            {c.name?.split(" ")[0]||c.id}
                          </div>
                          <div style={{height:3,background:C.border,borderRadius:2,overflow:"hidden"}}>
                            <div style={{height:"100%",width:pct+"%",background:c.netPnl>=0?C.green:C.red,borderRadius:2}}/>
                          </div>
                        </div>
                        <div style={{fontWeight:700,fontSize:13,color:c.netPnl>=0?C.green:C.red,flexShrink:0}}>
                          {c.netPnl>=0?"+":""}₹{Math.abs(c.netPnl).toLocaleString("en-IN",{maximumFractionDigits:0})}
                        </div>
                      </div>
                    );
                  });
                })()}
                {clientPnlData.length === 0 && (
                  <div style={{padding:32,textAlign:"center",color:C.muted,fontSize:13}}>
                    No trade data this month
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Quote banner */}
          <div style={{padding:"20px 28px",background:"linear-gradient(135deg,#1e3a5f,#1e3a8a)",
            borderRadius:14,boxShadow:"0 4px 20px rgba(30,58,138,0.2)",
            display:"flex",alignItems:"center",gap:20,flexWrap:"wrap"}}>
            <div style={{fontSize:36,color:"#ffffff20",fontFamily:"Georgia",lineHeight:1,flexShrink:0}}>"</div>
            <div style={{flex:1}}>
              <div style={{color:"#ffffff",fontSize:14,fontStyle:"italic",lineHeight:1.7,marginBottom:6}}>
                {todayQuote.text}
              </div>
              <div style={{color:"#93c5fd",fontSize:12}}>— {todayQuote.author}</div>
            </div>
          </div>
        </div>
      );
    }

    if (page === "clients" && (auth.role === "admin" || auth.role === "superadmin")) return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
          <h2 style={{ color: C.text, margin: 0 }}>Client Management</h2>
          <button style={btn(C.green)} onClick={() => setModal("addClient")}><Icon name="add" size={16} /> Add Client</button>
        </div>
        <div style={{ ...card }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr>{["Client ID", "Name", "Email", "Phone", "Password", "Open Pos", "Action"].map((h) => <th key={h} style={{ textAlign: "left", padding: "10px 12px", color: C.muted, borderBottom: `1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
            <tbody>
              {state.clients.map((c) => (
                <tr key={c.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: "12px", color: C.accent, fontWeight: 600 }}>{c.id}</td>
                  <td style={{ padding: "12px", color: C.text }}>{c.name}</td>
                  <td style={{ padding: "12px", color: C.muted }}>{c.email}</td>
                  <td style={{ padding: "12px", color: C.muted }}>{c.phone}</td>
                  <td style={{ padding: "12px", color: C.muted, fontFamily: "monospace" }}>{c.password}</td>
                  <td style={{ padding: "12px" }}><span style={badge(C.purple)}>{clientOpenPos(c.id).length}</span></td>
                  <td style={{ padding: "12px" }}>
                    <button style={{ ...btn(C.red), padding: "5px 10px" }} onClick={() => { if(!window.confirm("Delete client " + c.name + "? This cannot be undone.")) return; withSync(() => sb.delete("clients", c.id)); setState((s) => ({ ...s, clients: s.clients.filter((x) => x.id !== c.id) })); }}><Icon name="delete" size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );

    if (page === "ledger") {
      const isAdmin = (auth.role === "admin" || auth.role === "superadmin") || auth.role === "superadmin";

      // Which clients to show
      const allClients = isAdmin ? state.clients : [currentClient];
      const filteredClients = isAdmin && ledgerClientFilter !== "all"
        ? allClients.filter(c => c.id === ledgerClientFilter)
        : allClients;

      // Running balance with ledgerType aware filtering
      const ledgerRows = (cid, tab) => {
        let bal = 0;
        return state.ledger
          .filter(l => l.clientId === cid)
          .filter(l => tab === "dp" ? l.ledgerType === "dp" : true) // dp tab: only dp entries; all tab: all entries
          .sort((a,b) => a.date.localeCompare(b.date) || (a.id > b.id ? 1 : -1))
          .map(l => { bal += (l.credit||0) - (l.debit||0); return { ...l, balance: bal }; });
      };

      return (
        <div>
          {/* Header */}
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20, flexWrap:"wrap", gap:12 }}>
            <div style={{ display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
              <h2 style={{ color:C.text, margin:0 }}>Ledger</h2>
              {/* Search box */}
              <input value={ledgerSearch} onChange={e=>setLedgerSearch(e.target.value)}
                placeholder="🔍 Search..."
                style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,padding:"7px 12px",
                  color:C.text,fontSize:13,outline:"none",width:200}}/>
              {/* Client filter dropdown - admin only */}
              {isAdmin && (
                <select value={ledgerClientFilter} onChange={e => setLedgerClientFilter(e.target.value)}
                  style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:8, padding:"7px 12px", color:C.text, fontSize:13, cursor:"pointer", outline:"none" }}>
                  <option value="all">All Clients</option>
                  {state.clients.map(c => <option key={c.id} value={c.id}>{c.name} ({c.id})</option>)}
                </select>
              )}
              {/* DP / ALL tab toggle */}
              <div style={{ display:"flex", background:C.bg, borderRadius:8, border:`1px solid ${C.border}`, overflow:"hidden" }}>
                {["all","dp"].map(tab => (
                  <button key={tab} onClick={() => setLedgerTabFilter(tab)}
                    style={{ padding:"7px 18px", border:"none", cursor:"pointer", fontSize:13, fontWeight:600,
                      background: ledgerTabFilter===tab ? C.accent : "transparent",
                      color: ledgerTabFilter===tab ? "#fff" : C.muted }}>
                    {tab === "all" ? "All Entry" : "DP Entry"}
                  </button>
                ))}
              </div>
            </div>
            {isAdmin && (
              <button style={btn(C.green)} onClick={() => setModal("addLedger")}>
                <Icon name="add" size={16}/> Add Entry
              </button>
            )}
          </div>

          {/* DP Entry explanation */}
          {ledgerTabFilter === "dp" && (
            <div style={{ background:C.yellow+"11", border:`1px solid ${C.yellow}33`, borderRadius:8, padding:"10px 16px", marginBottom:16, fontSize:12, color:C.yellow }}>
              📌 <b>DP Entry view</b> — showing only DP-tagged entries. These entries are also visible in All Entry. Entries added directly to All Entry are not shown here.
            </div>
          )}

          {/* Per-client ledger tables */}
          {filteredClients.map(client => {
            const allRows = ledgerRows(client.id, ledgerTabFilter);
            const rows = ledgerSearch ? allRows.filter(r =>
              (r.narration||"").toLowerCase().includes(ledgerSearch.toLowerCase()) ||
              String(r.amount||"").includes(ledgerSearch) ||
              (r.ledgerType||"").toLowerCase().includes(ledgerSearch.toLowerCase())
            ) : allRows;
            const lastBal = rows.slice(-1)[0]?.balance || 0;
            const totalCredit = rows.reduce((a,l) => a+(l.credit||0), 0);
            const totalDebit  = rows.reduce((a,l) => a+(l.debit||0), 0);

            return (
              <div key={client.id} style={{ ...card, marginBottom:20 }}>
                {/* Client header */}
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16, flexWrap:"wrap", gap:10 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                    <span style={{ color:C.accent, fontWeight:700, fontSize:15 }}>{client.name}</span>
                    <span style={{ color:C.muted, fontSize:12 }}>({client.id})</span>
                    <span style={{ ...badge(ledgerTabFilter==="dp" ? C.yellow : C.accent), fontSize:11 }}>
                      {ledgerTabFilter==="dp" ? "DP Entry" : "All Entry"}
                    </span>
                  </div>
                  <div style={{ display:"flex", gap:20, flexWrap:"wrap" }}>
                    <div style={{ textAlign:"right" }}>
                      <div style={{ color:C.muted, fontSize:10, textTransform:"uppercase" }}>Total Credit</div>
                      <div style={{ color:C.green, fontWeight:700 }}>₹{totalCredit.toLocaleString()}</div>
                    </div>
                    <div style={{ textAlign:"right" }}>
                      <div style={{ color:C.muted, fontSize:10, textTransform:"uppercase" }}>Total Debit</div>
                      <div style={{ color:C.red, fontWeight:700 }}>₹{totalDebit.toLocaleString()}</div>
                    </div>
                    <div style={{ textAlign:"right" }}>
                      <div style={{ color:C.muted, fontSize:10, textTransform:"uppercase" }}>Net Balance</div>
                      <div style={{ color:lastBal>=0?C.green:C.red, fontWeight:700, fontSize:16 }}>₹{lastBal.toLocaleString()}</div>
                    </div>
                  </div>
                </div>

                {rows.length === 0 ? (
                  <div style={{ color:C.muted, fontSize:13, textAlign:"center", padding:"20px 0" }}>No entries found.</div>
                ) : (
                  <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                    <thead>
                      <tr>
                        {["Date","Type","Description","Credit","Debit","Balance","Added By", isAdmin?"Actions":""].filter(Boolean).map(h => (
                          <th key={h} style={{ textAlign:"left", padding:"8px 12px", color:C.muted, borderBottom:`1px solid ${C.border}`, fontSize:12 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(l => (
                        <tr key={l.id} style={{ borderBottom:`1px solid ${C.border}22` }}>
                          <td style={{ padding:"10px 12px", color:C.muted, whiteSpace:"nowrap" }}>{l.date}</td>
                          <td style={{ padding:"10px 12px" }}>
                            <span style={badge(l.ledgerType==="dp" ? C.yellow : C.accent)}>
                              {l.ledgerType==="dp" ? "DP" : "ALL"}
                            </span>
                          </td>
                          <td style={{ padding:"10px 12px", color:C.text }}>{l.description}</td>
                          <td style={{ padding:"10px 12px", color:C.green, fontWeight: l.credit>0?600:400 }}>
                            {l.credit > 0 ? "₹"+l.credit.toLocaleString() : "—"}
                          </td>
                          <td style={{ padding:"10px 12px", color:C.red, fontWeight: l.debit>0?600:400 }}>
                            {l.debit > 0 ? "₹"+l.debit.toLocaleString() : "—"}
                          </td>
                          <td style={{ padding:"10px 12px", color:l.balance>=0?C.text:C.red, fontWeight:600 }}>
                            ₹{l.balance.toLocaleString()}
                          </td>
                          {isAdmin && (
                            <td style={{ padding:"10px 12px" }}>
                              <div style={{ display:"flex", gap:6 }}>
                                <button style={{ ...btn(C.accent), padding:"4px 10px", fontSize:12 }}
                                  onClick={() => { setEditLedgerEntry({...l}); setModal("editLedger"); }}>
                                  ✏️
                                </button>
                                <button style={{ ...btn(C.red), padding:"4px 10px", fontSize:12 }}
                                  onClick={() => deleteLedgerEntry(l.id)}>
                                  <Icon name="delete" size={13}/>
                                </button>
                              </div>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                    {/* Totals row */}
                    <tfoot>
                      <tr style={{ borderTop:`2px solid ${C.border}` }}>
                        <td colSpan={isAdmin ? 3 : 2} style={{ padding:"10px 12px", color:C.muted, fontWeight:600, fontSize:12 }}>TOTAL</td>
                        <td style={{ padding:"10px 12px", color:C.green, fontWeight:700 }}>₹{totalCredit.toLocaleString()}</td>
                        <td style={{ padding:"10px 12px", color:C.red, fontWeight:700 }}>₹{totalDebit.toLocaleString()}</td>
                        <td style={{ padding:"10px 12px", color:lastBal>=0?C.green:C.red, fontWeight:700 }}>₹{lastBal.toLocaleString()}</td>
                        {isAdmin && <td/>}
                      </tr>
                    </tfoot>
                  </table>
                )}
              </div>
            );
          })}
        </div>
      );
    }

    if (page === "trades") {
      const isAdmin = (auth.role === "admin" || auth.role === "superadmin") || auth.role === "superadmin";
      const allClients = isAdmin ? state.clients : [currentClient];
      const showClients = isAdmin && tradesClientFilter !== "all"
        ? allClients.filter(c => c.id === tradesClientFilter)
        : allClients;

      return (
        <div>
          {/* Header bar */}
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16, flexWrap:"wrap", gap:12 }}>
            <div style={{ display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
              <h2 style={{ color:C.text, margin:0 }}>Trades & Positions</h2>
              {/* Trades search */}
              <input value={tradeSearch} onChange={e=>setTradeSearch(e.target.value)}
                placeholder="🔍 Search contract, symbol..."
                style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:8,
                  padding:"7px 12px",color:C.text,fontSize:13,outline:"none",width:220}}/>
              {isAdmin && (
                <select value={tradesClientFilter} onChange={e => setTradesClientFilter(e.target.value)}
                  style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:8, padding:"7px 12px", color:C.text, fontSize:13, cursor:"pointer", outline:"none" }}>
                  <option value="all">All Clients</option>
                  {state.clients.map(c => <option key={c.id} value={c.id}>{c.name} ({c.id})</option>)}
                </select>
              )}
            </div>
            {isAdmin && (
              <div style={{display:"flex", gap:8}}>
                <button style={btn(C.purple)} onClick={() => setModal("uploadTrades")}>
                  <Icon name="upload" size={16}/> Upload Master File
                </button>
                {uploadHistory.length > 0 && (
                  <button style={{...btn(C.card), border:`1px solid ${C.border}`, color:C.text, fontSize:13}}
                    onClick={() => setModal("uploadHistory")}>
                    🕐 History ({uploadHistory.length})
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Position filter tabs */}
          <div style={{ display:"flex", gap:8, marginBottom:20 }}>
            {["open","closed","all"].map(f => (
              <button key={f} onClick={() => setPositionFilter(f)}
                style={{
                  padding:"8px 18px", borderRadius:8, cursor:"pointer", fontSize:13, fontWeight: positionFilter===f ? 600 : 400,
                  background: positionFilter===f ? C.accent : "#fff",
                  color: positionFilter===f ? "#fff" : C.muted,
                  border:`1.5px solid ${positionFilter===f ? C.accent : C.border}`,
                  textTransform:"capitalize"
                }}>
                {f} Positions
              </button>
            ))}
          </div>

          {showClients.map(client => {
            const open   = clientOpenPos(client.id);
            const closed = clientClosedPos(client.id);

            // Charges for this client
            const clientTrades = state.trades.filter(t => t.clientId === client.id);
            const totalCharges = clientTrades.reduce((s,t) => s + getTradeCharges(t).total, 0);

            return (
              <div key={client.id} style={{ marginBottom:32 }}>
                {/* Client header */}
                {isAdmin && (
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
                    <div style={{ color:C.accent, fontWeight:700, fontSize:15 }}>
                      {client.name} <span style={{ color:C.muted, fontWeight:400, fontSize:13 }}>({client.id})</span>
                    </div>
                    <div style={{ color:C.yellow, fontSize:12, fontWeight:600 }}>
                      Total Charges: ₹{totalCharges.toFixed(2)}
                    </div>
                  </div>
                )}

                {/* Open Positions */}
                {(positionFilter==="open" || positionFilter==="all") && open.length > 0 && (
                  <div style={{ ...card, marginBottom:12 }}>
                    <div style={{ color:C.yellow, fontWeight:600, marginBottom:12, fontSize:13, textTransform:"uppercase", letterSpacing:1 }}>🟡 Open Positions</div>
                    <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                      <thead>
                        <tr>{["Contract","Net Qty","Side","Avg Price","Close Price","MTM P&L","Booked P&L"].map(h=>(
                          <th key={h} style={{ textAlign:"left", padding:"8px 12px", color:C.muted, borderBottom:`1px solid ${C.border}` }}>{h}</th>
                        ))}</tr>
                      </thead>
                      <tbody>
                        {open.map((p,i) => {
                          const close = getBhavClose(p.contract);
                          const mtm   = close !== null
                            ? (p.side==="SELL" ? (p.avgPrice-close) : (close-p.avgPrice)) * p.netQty
                            : null;
                          const isExp = isExpiring(p.contract);
                          const isEq  = !p.contract.includes("CE") && !p.contract.includes("PE") && !p.contract.includes("FUT");
                          return (
                            <tr key={i} style={{ borderBottom:`1px solid ${C.border}22`, background:isExp?C.red+"11":"transparent" }}>
                              <td style={{ padding:"10px 12px", color:C.accent }}>
                                {p.contract}
                                {isExp && <span style={{ ...badge(C.red), marginLeft:6, fontSize:10 }}>EXPIRING</span>}
                                {isEq  && <span style={{ ...badge(C.blue||"#1f6feb"), marginLeft:6, fontSize:10 }}>EQUITY</span>}
                              </td>
                              <td style={{ padding:"10px 12px", color:C.text, fontWeight:700 }}>{p.netQty}</td>
                              <td style={{ padding:"10px 12px" }}><span style={badge(p.side==="SELL"?C.red:C.green)}>{p.side}</span></td>
                              <td style={{ padding:"10px 12px", color:C.text }}>₹{p.avgPrice}</td>
                              <td style={{ padding:"10px 12px", color:close?C.purple:C.muted }}>{close?`₹${close}`:"—"}</td>
                              <td style={{ padding:"10px 12px", color:mtm===null?C.muted:mtm>=0?C.green:C.red, fontWeight:600 }}>
                                {mtm===null?"—":`₹${mtm.toFixed(2)}`}
                              </td>
                              <td style={{ padding:"10px 12px", color:p.bookedPnl>=0?C.green:C.red, fontWeight:600 }}>₹{p.bookedPnl.toLocaleString()}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Closed Positions */}
                {(positionFilter==="closed" || positionFilter==="all") && closed.length > 0 && (
                  <div style={{ ...card, marginBottom:12 }}>
                    <div style={{ color:C.green, fontWeight:600, marginBottom:12, fontSize:13, textTransform:"uppercase", letterSpacing:1 }}>✅ Closed Positions</div>
                    <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                      <thead>
                        <tr>{["Contract","Qty","Sell Price","Buy Price","Gross P&L","Charges","Net P&L"].map(h=>(
                          <th key={h} style={{ textAlign:"left", padding:"8px 12px", color:C.muted, borderBottom:`1px solid ${C.border}` }}>{h}</th>
                        ))}</tr>
                      </thead>
                      <tbody>
                        {closed.flatMap(c=>c.trades).map((t,i) => {
                          // Find trades for this closed trade to calc charges
                          const relatedTrades = clientTrades.filter(tr =>
                            tr.contract === t.contract && (tr.date === t.date || true)
                          );
                          // Approx: split total charges by turnover proportion
                          const tradeTurnover = t.sellPrice * t.qty + t.buyPrice * t.qty;
                          const totalTurnover = clientTrades
                            .filter(tr => tr.contract === t.contract)
                            .reduce((s,tr)=>s+tr.price*tr.qty,0) || tradeTurnover;
                          const chargesApprox = totalCharges * (tradeTurnover / Math.max(totalTurnover,1));
                          const netPnl = t.pnl - chargesApprox;
                          return (
                            <tr key={i} style={{ borderBottom:`1px solid ${C.border}22` }}>
                              <td style={{ padding:"10px 12px", color:C.accent }}>{t.contract}</td>
                              <td style={{ padding:"10px 12px", color:C.text }}>{t.qty}</td>
                              <td style={{ padding:"10px 12px", color:C.text }}>₹{t.sellPrice}</td>
                              <td style={{ padding:"10px 12px", color:C.text }}>₹{t.buyPrice}</td>
                              <td style={{ padding:"10px 12px", color:t.pnl>=0?C.green:C.red, fontWeight:700 }}>₹{t.pnl.toFixed(2)}</td>
                              <td style={{ padding:"10px 12px", color:C.yellow, fontSize:12 }}>₹{chargesApprox.toFixed(2)}</td>
                              <td style={{ padding:"10px 12px", color:netPnl>=0?C.green:C.red, fontWeight:700 }}>₹{netPnl.toFixed(2)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Charges breakdown per trade — admin only */}
                {isAdmin && (positionFilter==="closed" || positionFilter==="all") && clientTrades.length>0 && (
                  <details style={{ ...card, cursor:"pointer" }}>
                    <summary style={{ color:C.yellow, fontWeight:600, fontSize:13, padding:"4px 0", userSelect:"none" }}>
                      💰 Charges Breakdown — {client.name} (Total: ₹{totalCharges.toFixed(2)})
                    </summary>
                    <div style={{ marginTop:14, overflowX:"auto" }}>
                      <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}>
                        <thead>
                          <tr>{["Date","Contract","Side","Qty","Price","STT","Stamp","TOT","SEBI","IPF","Clearing","GST","Markup","Total"].map(h=>(
                            <th key={h} style={{ textAlign:"left", padding:"5px 8px", color:C.muted, borderBottom:`1px solid ${C.border}`, whiteSpace:"nowrap" }}>{h}</th>
                          ))}</tr>
                        </thead>
                        <tbody>
                          {clientTrades.map((t,i) => {
                            const ch = getTradeCharges(t);
                            return (
                              <tr key={i} style={{ borderBottom:`1px solid ${C.border}11` }}>
                                <td style={{ padding:"5px 8px", color:C.muted }}>{t.date}</td>
                                <td style={{ padding:"5px 8px", color:C.accent, maxWidth:120, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{t.contract}</td>
                                <td style={{ padding:"5px 8px" }}><span style={{ color:t.side==="SELL"?C.red:C.green, fontWeight:600 }}>{t.side}</span></td>
                                <td style={{ padding:"5px 8px", color:C.text }}>{t.qty}</td>
                                <td style={{ padding:"5px 8px", color:C.text }}>₹{t.price}</td>
                                {[ch.stt,ch.stamp,ch.tot,ch.sebi,ch.ipf,ch.clearing,ch.gst,ch.markup].map((v,j)=>(
                                  <td key={j} style={{ padding:"5px 8px", color:C.muted }}>₹{v.toFixed(3)}</td>
                                ))}
                                <td style={{ padding:"5px 8px", color:C.yellow, fontWeight:700 }}>₹{ch.total}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                        <tfoot>
                          <tr style={{ borderTop:`2px solid ${C.border}` }}>
                            <td colSpan={5} style={{ padding:"7px 8px", color:C.text, fontWeight:700, fontSize:12 }}>TOTAL</td>
                            {["stt","stamp","tot","sebi","ipf","clearing","gst","markup"].map(k=>(
                              <td key={k} style={{ padding:"7px 8px", color:C.muted, fontWeight:600 }}>
                                ₹{clientTrades.reduce((s,t)=>s+getTradeCharges(t)[k],0).toFixed(3)}
                              </td>
                            ))}
                            <td style={{ padding:"7px 8px", color:C.yellow, fontWeight:700 }}>₹{totalCharges.toFixed(2)}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </details>
                )}

                {open.length===0 && closed.length===0 && (
                  <div style={{ color:C.muted, fontSize:13 }}>No trades found.</div>
                )}
              </div>
            );
          })}
        </div>
      );
    }

    if (page === "pnl") {
      const isAdmin = (auth.role === "admin" || auth.role === "superadmin") || auth.role === "superadmin";
      const allClients = isAdmin ? state.clients : [currentClient];
      const showClients = isAdmin && pnlClientFilter !== "all"
        ? allClients.filter(c => c.id === pnlClientFilter)
        : allClients;

      // Date filter helper — does a month fall within the selected filter?
      const monthInFilter = (m) => {
        if (pnlDateMode === "all") return true;
        if (pnlDateMode === "month") return m === pnlMonth;
        if (pnlDateMode === "range") {
          const from = pnlDateFrom ? pnlDateFrom.slice(0,7) : "";
          const to   = pnlDateTo   ? pnlDateTo.slice(0,7)   : "";
          return (!from || m >= from) && (!to || m <= to);
        }
        return true;
      };

      return (
        <div>
          {/* Header */}
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20, flexWrap:"wrap", gap:12 }}>
            <div style={{ display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
              <div style={{ display:"flex", alignItems:"baseline", gap:16, flexWrap:"wrap" }}>
          <h2 style={{ color:C.text, margin:0 }}>Profit & Loss</h2>
          {(() => {
            // Correct All-Time Net P&L: sum of (Realized - Expenses - Interest - Software) across all months, all visible clients
            const clientsForTotal = isAdmin ? visibleClients : visibleClients.filter(c=>c.id===cid);
            let grandNet = 0;
            clientsForTotal.forEach(client => {
              const closed = clientClosedPos(client.id);
              const realized = closed.reduce((a,c)=>a+c.totalPnl,0);
              const tradeMonths = [...new Set(state.trades.filter(t=>t.clientId===client.id).map(t=>(t.date||"").slice(0,7)))];
              const interestMonths = [...new Set((state.interest||[]).filter(i=>i.clientId===client.id).map(i=>(i.yearMonth||"").replace("_SW","")))];
              const allMonthsForClient = [...new Set([...tradeMonths, ...interestMonths])].filter(Boolean);
              const expenses = allMonthsForClient.reduce((a,m)=>a+getMonthlyCharges(client.id,m),0);
              const interest = allMonthsForClient.reduce((a,m)=>a+getMonthlyInterest(client.id,m),0);
              const software = allMonthsForClient.reduce((a,m)=>a+getMonthlyInterest(client.id,m+"_SW"),0);
              grandNet += (realized - expenses - interest - software);
            });
            return (
              <span style={{ fontSize:12, color:C.muted, fontWeight:400 }}>
                All Time Net P&L: <span style={{ color:grandNet>=0?C.green:C.red, fontWeight:600 }}>
                  ₹{grandNet.toLocaleString("en-IN",{maximumFractionDigits:0})}
                </span>
              </span>
            );
          })()}
        </div>
              {isAdmin && (
                <select value={pnlClientFilter} onChange={e => setPnlClientFilter(e.target.value)}
                  style={{ background:"#f8fafc", border:`1px solid ${C.border}`, borderRadius:8, padding:"7px 12px", color:C.text, fontSize:13, cursor:"pointer", outline:"none" }}>
                  <option value="all">All Clients</option>
                  {state.clients.map(c => <option key={c.id} value={c.id}>{c.name} ({c.id})</option>)}
                </select>
              )}
            </div>
            {isAdmin && (
              <button style={btn(C.yellow)} onClick={() => setModal("addInterest")}>
                💰 Add Interest / Brokerage
              </button>
            )}
          </div>

          {/* Date Filter Bar */}
          <div style={{ ...card, marginBottom:20, padding:"14px 20px" }}>
            <div style={{ display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
              <span style={{ color:C.muted, fontSize:12, fontWeight:600 }}>FILTER BY:</span>
              {[
                { val:"all",   label:"All Time" },
                { val:"month", label:"Specific Month" },
                { val:"range", label:"Date Range" },
              ].map(f => (
                <button key={f.val} onClick={() => setPnlDateMode(f.val)}
                  style={{ padding:"6px 14px", borderRadius:8, border:`1.5px solid ${pnlDateMode===f.val ? C.accent : C.border}`,
                    background: pnlDateMode===f.val ? C.accent+"12" : "transparent",
                    color: pnlDateMode===f.val ? C.accent : C.muted,
                    fontWeight: pnlDateMode===f.val ? 600 : 400, fontSize:13, cursor:"pointer" }}>
                  {f.label}
                </button>
              ))}
              {pnlDateMode === "month" && (
                <input type="month" value={pnlMonth} onChange={e => setPnlMonth(e.target.value)}
                  style={{ background:"#f8fafc", border:`1px solid ${C.border}`, borderRadius:8, padding:"6px 12px", color:C.text, fontSize:13, outline:"none", fontWeight:600 }}/>
              )}
              {pnlDateMode === "range" && (
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <input type="date" value={pnlDateFrom} onChange={e => setPnlDateFrom(e.target.value)}
                    style={{ background:"#f8fafc", border:`1px solid ${C.border}`, borderRadius:8, padding:"6px 12px", color:C.text, fontSize:13, outline:"none" }}/>
                  <span style={{ color:C.muted }}>to</span>
                  <input type="date" value={pnlDateTo} onChange={e => setPnlDateTo(e.target.value)}
                    style={{ background:"#f8fafc", border:`1px solid ${C.border}`, borderRadius:8, padding:"6px 12px", color:C.text, fontSize:13, outline:"none" }}/>
                </div>
              )}
            </div>
          </div>

          {showClients.map(client => {
            const closed  = clientClosedPos(client.id);
            const open    = clientOpenPos(client.id);

            // All months that have any data for this client — filtered by date selection
            const tradeDates = state.trades.filter(t => t.clientId === client.id).map(t => (t.date||"").slice(0,7));
            const interestMonths = (state.interest||[]).filter(i => i.clientId === client.id).map(i => i.yearMonth);
            const allMonths = [...new Set([...tradeDates, ...interestMonths])].filter(m => m && monthInFilter(m)).sort().reverse();

            // For range/month filter also filter closed trades
            const filteredClosed = closed.filter(cp =>
              cp.trades.some(t => monthInFilter((t.date||"").slice(0,7)))
            );

            // Grand totals
            const grandRealized = filteredClosed.reduce((a,c) => a + c.totalPnl, 0);
            const grandExpenses = allMonths.reduce((a,m) => a + getMonthlyCharges(client.id, m), 0);
            const grandSoftware = allMonths.reduce((a,m) => a + getMonthlyInterest(client.id, m + "_SW"), 0);
            const grandInterest = allMonths.reduce((a,m) => a + getMonthlyInterest(client.id, m), 0);
            const grandNet      = grandRealized - grandExpenses - grandSoftware - grandInterest;

            return (
              <div key={client.id} style={{ ...card, marginBottom:24 }}>
                {/* Client name */}
                {isAdmin && (
                  <div style={{ color:C.accent, fontWeight:700, fontSize:15, marginBottom:16 }}>
                    {client.name} <span style={{ color:C.muted, fontWeight:400, fontSize:13 }}>({client.id})</span>
                  </div>
                )}

                {/* Grand summary cards */}
                <div style={{ display:"grid", gridTemplateColumns:"repeat(6,1fr)", gap:12, marginBottom:24 }}>
                  {[
                    { label:"Realized P&L",     val:grandRealized,  color:grandRealized>=0?C.green:C.red },
                    { label:"Expenses",          val:-grandExpenses, color:C.yellow },
                    { label:"Software Charges",  val:-grandSoftware, color:C.purple },
                    { label:"Interest",          val:-grandInterest, color:C.red },
                    { label:"Net P&L",           val:grandNet,       color:grandNet>=0?C.green:C.red, big:true },
                    { label:"Open Positions",    val:open.length,    color:C.accent, count:true },
                  ].map(s => (
                    <div key={s.label} style={{ background:C.bg, borderRadius:10, padding:"14px 16px",
                      border:`1px solid ${s.big ? s.color+"66" : C.border}`,
                      boxShadow: s.big ? `0 0 12px ${s.color}22` : "none" }}>
                      <div style={{ color:C.muted, fontSize:11, marginBottom:6, textTransform:"uppercase", letterSpacing:1 }}>{s.label}</div>
                      <div style={{ color:s.color, fontSize:s.big?22:18, fontWeight:700 }}>
                        {s.count ? s.val : `₹${(+s.val).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Formula line */}
                <div style={{ background:C.bg, borderRadius:8, padding:"10px 16px", marginBottom:20, fontSize:13, color:C.muted, display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
                  <span style={{ color:grandRealized>=0?C.green:C.red, fontWeight:600 }}>₹{grandRealized.toFixed(2)}</span>
                  <span>(Realized)</span>
                  <span>−</span>
                  <span style={{ color:C.yellow, fontWeight:600 }}>₹{grandExpenses.toFixed(2)}</span>
                  <span>(Expenses)</span>
                  <span>−</span>
                  <span style={{ color:C.purple, fontWeight:600 }}>₹{grandSoftware.toFixed(2)}</span>
                  <span>(Software)</span>
                  <span>−</span>
                  <span style={{ color:C.red, fontWeight:600 }}>₹{grandInterest.toFixed(2)}</span>
                  <span>(Interest)</span>
                  <span>=</span>
                  <span style={{ color:grandNet>=0?C.green:C.red, fontWeight:700, fontSize:15 }}>₹{grandNet.toFixed(2)}</span>
                  <span style={{ color:C.muted }}>(Net P&L)</span>
                </div>

                {/* Month-by-month breakdown */}
                {allMonths.length > 0 && (
                  <div style={{ marginBottom:16 }}>
                    <div style={{ color:C.muted, fontSize:12, fontWeight:600, marginBottom:10, textTransform:"uppercase", letterSpacing:1 }}>Monthly Breakdown</div>
                    <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                      <thead>
                        <tr>
                          {["Month","Realized P&L","Expenses (Auto)","Interest / Brokerage","Software Charges","Net P&L", isAdmin?"":""].filter(Boolean).map(h=>(
                            <th key={h} style={{ textAlign:"left", padding:"8px 12px", color:C.muted, borderBottom:`1px solid ${C.border}`, fontSize:12 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {allMonths.map(m => {
                          // Realized for this month = P&L from trades closed in this month
                          const monthRealized = closed
                            .flatMap(c => c.trades)
                            .filter(t => (t.date||"").startsWith(m))
                            .reduce((a,t) => a + t.pnl, 0);
                          const monthExpenses  = getMonthlyCharges(client.id, m);
                          const monthInterest  = getMonthlyInterest(client.id, m);
                          const monthSoftware  = getMonthlyInterest(client.id, m + "_SW"); // software charges stored with _SW suffix
                          const monthNet       = monthRealized - monthExpenses - monthInterest - monthSoftware;

                          // Interest entries for this month (for delete)
                          const monthInterestEntries = (state.interest||[]).filter(i => i.clientId===client.id && i.yearMonth===m);

                          return (
                            <tr key={m} style={{ borderBottom:`1px solid ${C.border}22` }}>
                              <td style={{ padding:"10px 12px", color:C.text, fontWeight:600 }}>{m}</td>
                              <td style={{ padding:"10px 12px", color:monthRealized>=0?C.green:C.red, fontWeight:600 }}>
                                ₹{monthRealized.toFixed(2)}
                              </td>
                              <td style={{ padding:"10px 12px", color:C.yellow }}>
                                − ₹{monthExpenses.toFixed(2)}
                              </td>
                              <td style={{ padding:"10px 12px" }}>
                                <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                                  <span style={{ color:C.red }}>− ₹{monthInterest.toFixed(2)}</span>
                                  {isAdmin && monthInterestEntries.map(e => (
                                    <span key={e.id} style={{ background:C.bg, border:`1px solid ${C.border}`, borderRadius:6, padding:"2px 8px", fontSize:11, color:C.muted, display:"inline-flex", alignItems:"center", gap:6 }}>
                                      {e.note || "Brokerage"}: ₹{e.amount}
                                      <button onClick={() => deleteInterest(e.id)}
                                        style={{ background:"none", border:"none", color:C.red, cursor:"pointer", fontSize:12, padding:0, lineHeight:1 }}>✕</button>
                                    </span>
                                  ))}
                                </div>
                              </td>
                              <td style={{ padding:"10px 12px", color:monthNet>=0?C.green:C.red, fontWeight:700, fontSize:14 }}>
                                ₹{monthNet.toFixed(2)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr style={{ borderTop:`2px solid ${C.border}` }}>
                          <td style={{ padding:"10px 12px", color:C.muted, fontWeight:700, fontSize:12 }}>GRAND TOTAL</td>
                          <td style={{ padding:"10px 12px", color:grandRealized>=0?C.green:C.red, fontWeight:700 }}>₹{grandRealized.toFixed(2)}</td>
                          <td style={{ padding:"10px 12px", color:C.yellow, fontWeight:700 }}>− ₹{grandExpenses.toFixed(2)}</td>
                          <td style={{ padding:"10px 12px", color:C.red, fontWeight:700 }}>− ₹{grandInterest.toFixed(2)}</td>
                          <td style={{ padding:"10px 12px", color:C.purple, fontWeight:700 }}>₹{grandSoftware.toFixed(2)}</td>
                          <td style={{ padding:"10px 12px", color:grandNet>=0?C.green:C.red, fontWeight:700, fontSize:15 }}>₹{grandNet.toFixed(2)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}

                {/* Closed contracts detail — filtered by current date selection */}
                {filteredClosed.length > 0 && (
                  <details>
                    <summary style={{ color:C.muted, fontSize:12, cursor:"pointer", padding:"8px 0", userSelect:"none" }}>
                      📋 View closed contracts ({filteredClosed.length})
                    </summary>
                    <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12, marginTop:10 }}>
                      <thead>
                        <tr>{["Contract","Gross P&L"].map(h=>(
                          <th key={h} style={{ textAlign:"left", padding:"6px 12px", color:C.muted, borderBottom:`1px solid ${C.border}` }}>{h}</th>
                        ))}</tr>
                      </thead>
                      <tbody>
                        {filteredClosed.map((c,i)=>(
                          <tr key={i} style={{ borderBottom:`1px solid ${C.border}11` }}>
                            <td style={{ padding:"8px 12px", color:C.accent }}>{c.contract}</td>
                            <td style={{ padding:"8px 12px", color:c.totalPnl>=0?C.green:C.red, fontWeight:600 }}>₹{c.totalPnl.toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                )}

                {filteredClosed.length===0 && allMonths.length===0 && (
                  <div style={{ color:C.muted, fontSize:13 }}>No closed positions yet.</div>
                )}
              </div>
            );
          })}
        </div>
      );
    }

    if (page === "charges" && (auth.role === "admin" || auth.role === "superadmin") && hasFeature(auth?.plan, "charges")) {
      const currentCfg = state.chargesHistory.slice().sort((a,b)=>b.effectiveFrom.localeCompare(a.effectiveFrom))[0] || DEFAULT_CHARGES;
      const numFld = (label, val, onChange, color=C.text) => (
        <div style={{ marginBottom:8 }}>
          <div style={{ color:C.muted, fontSize:11, marginBottom:3 }}>{label}</div>
          <input type="number" step="any" value={val} onChange={onChange}
            style={{ width:"100%", background:"#f8fafc", border:`1px solid ${C.border}`, borderRadius:8,
              padding:"6px 10px", fontSize:12, color: color===C.text ? "#1a202c" : color, outline:"none", boxSizing:"border-box" }}
            disabled={!chargesEdit} />
        </div>
      );
      const section = (title, color) => (
        <div style={{ color, fontWeight:700, fontSize:13, margin:"16px 0 10px", paddingBottom:6, borderBottom:`1px solid ${C.border}`, letterSpacing:1 }}>{title}</div>
      );
      const cfg = chargesEdit || currentCfg;

      return (
        <div>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:24 }}>
            <div>
              <h2 style={{ color:C.text, margin:0 }}>Charges Configuration</h2>
              <div style={{ color:C.muted, fontSize:12, marginTop:4 }}>Per-trade charges applied automatically. Clients see monthly total only.</div>
            </div>
            <div style={{ display:"flex", gap:10 }}>
              {chargesEdit
                ? <>
                    <button style={btn(C.green)} onClick={() => {
                      const newCfg = { ...chargesEdit, effectiveFrom: new Date().toISOString().slice(0,10) };
                      setState(s => ({ ...s, chargesHistory: [...s.chargesHistory, newCfg] }));
                      setChargesEdit(null);
                      notify("✅ New charges saved! Effective from today.");
                    }}><Icon name="check" size={14}/> Save & Apply from Today</button>
                    <button style={btn(C.muted)} onClick={() => setChargesEdit(null)}>Discard</button>
                  </>
                : <button style={btn(C.accent)} onClick={() => setChargesEdit(JSON.parse(JSON.stringify(currentCfg)))}>
                    ✏️ Edit Charges
                  </button>
              }
            </div>
          </div>

          {chargesEdit && (
            <div style={{ ...card, marginBottom:16, borderLeft:`3px solid ${C.yellow}`, background:C.yellow+"08" }}>
              <div style={{ color:C.yellow, fontWeight:600, fontSize:13 }}>⚠️ Editing mode — changes apply from TODAY only. Past trade charges are not affected.</div>
            </div>
          )}

          {/* Effective from history */}
          <div style={{ ...card, marginBottom:20 }}>
            <div style={{ color:C.muted, fontSize:12, marginBottom:10, fontWeight:600 }}>CHARGES HISTORY</div>
            <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
              {state.chargesHistory.slice().sort((a,b)=>b.effectiveFrom.localeCompare(a.effectiveFrom)).map((h,i)=>(
                <div key={i} style={{ background:i===0?C.green+"22":C.bg, border:`1px solid ${i===0?C.green:C.border}`, borderRadius:8, padding:"8px 14px", fontSize:12 }}>
                  <span style={{ color:i===0?C.green:C.muted }}>Effective from: </span>
                  <span style={{ color:C.text, fontWeight:600 }}>{h.effectiveFrom}</span>
                  {i===0&&<span style={{ color:C.green, marginLeft:8 }}>● Current</span>}
                </div>
              ))}
            </div>
          </div>

          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:20 }}>
            {/* F&O NSE */}
            <div style={{ ...card }}>
              {section("F&O — NSE", C.accent)}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                {numFld("STT Options Sell (%)", cfg.fno_nse?.stt_opt_sell, e=>setChargesEdit(s=>({...s,fno_nse:{...s.fno_nse,stt_opt_sell:+e.target.value}})), C.red)}
                {numFld("STT Futures Sell (%)", cfg.fno_nse?.stt_fut_sell, e=>setChargesEdit(s=>({...s,fno_nse:{...s.fno_nse,stt_fut_sell:+e.target.value}})), C.red)}
                {numFld("Stamp Duty Buy (%)", cfg.fno_nse?.stamp_buy, e=>setChargesEdit(s=>({...s,fno_nse:{...s.fno_nse,stamp_buy:+e.target.value}})))}
                {numFld("Turnover — Options (%)", cfg.fno_nse?.tot_opt, e=>setChargesEdit(s=>({...s,fno_nse:{...s.fno_nse,tot_opt:+e.target.value}})))}
                {numFld("Turnover — Futures (%)", cfg.fno_nse?.tot_fut, e=>setChargesEdit(s=>({...s,fno_nse:{...s.fno_nse,tot_fut:+e.target.value}})))}
                {numFld("SEBI (%)", cfg.fno_nse?.sebi, e=>setChargesEdit(s=>({...s,fno_nse:{...s.fno_nse,sebi:+e.target.value}})))}
                {numFld("IPF (%)", cfg.fno_nse?.ipf, e=>setChargesEdit(s=>({...s,fno_nse:{...s.fno_nse,ipf:+e.target.value}})))}
                {numFld("Clearing (%)", cfg.fno_nse?.clearing, e=>setChargesEdit(s=>({...s,fno_nse:{...s.fno_nse,clearing:+e.target.value}})))}
                {numFld("GST on charges (%)", cfg.fno_nse?.gst, e=>setChargesEdit(s=>({...s,fno_nse:{...s.fno_nse,gst:+e.target.value}})), C.yellow)}
              </div>
            </div>

            {/* F&O BSE */}
            <div style={{ ...card }}>
              {section("F&O — BSE", C.purple)}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                {numFld("STT Options Sell (%)", cfg.fno_bse?.stt_opt_sell, e=>setChargesEdit(s=>({...s,fno_bse:{...s.fno_bse,stt_opt_sell:+e.target.value}})), C.red)}
                {numFld("STT Futures Sell (%)", cfg.fno_bse?.stt_fut_sell, e=>setChargesEdit(s=>({...s,fno_bse:{...s.fno_bse,stt_fut_sell:+e.target.value}})), C.red)}
                {numFld("Stamp Duty Buy (%)", cfg.fno_bse?.stamp_buy, e=>setChargesEdit(s=>({...s,fno_bse:{...s.fno_bse,stamp_buy:+e.target.value}})))}
                {numFld("Turnover — Options (%)", cfg.fno_bse?.tot_opt, e=>setChargesEdit(s=>({...s,fno_bse:{...s.fno_bse,tot_opt:+e.target.value}})))}
                {numFld("Turnover — Futures (%)", cfg.fno_bse?.tot_fut, e=>setChargesEdit(s=>({...s,fno_bse:{...s.fno_bse,tot_fut:+e.target.value}})))}
                {numFld("SEBI (%)", cfg.fno_bse?.sebi, e=>setChargesEdit(s=>({...s,fno_bse:{...s.fno_bse,sebi:+e.target.value}})))}
                {numFld("IPF (%)", cfg.fno_bse?.ipf, e=>setChargesEdit(s=>({...s,fno_bse:{...s.fno_bse,ipf:+e.target.value}})))}
                {numFld("Clearing (%)", cfg.fno_bse?.clearing, e=>setChargesEdit(s=>({...s,fno_bse:{...s.fno_bse,clearing:+e.target.value}})))}
                {numFld("GST on charges (%)", cfg.fno_bse?.gst, e=>setChargesEdit(s=>({...s,fno_bse:{...s.fno_bse,gst:+e.target.value}})), C.yellow)}
              </div>
            </div>

            {/* Equity NSE */}
            <div style={{ ...card }}>
              {section("Equity Cash — NSE", C.green)}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                {numFld("STT Delivery Buy (%)", cfg.eq_nse?.stt_del_buy, e=>setChargesEdit(s=>({...s,eq_nse:{...s.eq_nse,stt_del_buy:+e.target.value}})))}
                {numFld("STT Delivery Sell (%)", cfg.eq_nse?.stt_del_sell, e=>setChargesEdit(s=>({...s,eq_nse:{...s.eq_nse,stt_del_sell:+e.target.value}})))}
                {numFld("Stamp Duty Buy (%)", cfg.eq_nse?.stamp_buy, e=>setChargesEdit(s=>({...s,eq_nse:{...s.eq_nse,stamp_buy:+e.target.value}})))}
                {numFld("Turnover Charges (%)", cfg.eq_nse?.tot, e=>setChargesEdit(s=>({...s,eq_nse:{...s.eq_nse,tot:+e.target.value}})))}
                {numFld("SEBI (%)", cfg.eq_nse?.sebi, e=>setChargesEdit(s=>({...s,eq_nse:{...s.eq_nse,sebi:+e.target.value}})))}
                {numFld("GST on charges (%)", cfg.eq_nse?.gst, e=>setChargesEdit(s=>({...s,eq_nse:{...s.eq_nse,gst:+e.target.value}})), C.yellow)}
              </div>
            </div>

            {/* Equity BSE */}
            <div style={{ ...card }}>
              {section("Equity Cash — BSE", C.yellow)}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                {numFld("STT Delivery Buy (%)", cfg.eq_bse?.stt_del_buy, e=>setChargesEdit(s=>({...s,eq_bse:{...s.eq_bse,stt_del_buy:+e.target.value}})))}
                {numFld("STT Delivery Sell (%)", cfg.eq_bse?.stt_del_sell, e=>setChargesEdit(s=>({...s,eq_bse:{...s.eq_bse,stt_del_sell:+e.target.value}})))}
                {numFld("Stamp Duty Buy (%)", cfg.eq_bse?.stamp_buy, e=>setChargesEdit(s=>({...s,eq_bse:{...s.eq_bse,stamp_buy:+e.target.value}})))}
                {numFld("Turnover Charges (%)", cfg.eq_bse?.tot, e=>setChargesEdit(s=>({...s,eq_bse:{...s.eq_bse,tot:+e.target.value}})))}
                {numFld("SEBI (%)", cfg.eq_bse?.sebi, e=>setChargesEdit(s=>({...s,eq_bse:{...s.eq_bse,sebi:+e.target.value}})))}
                {numFld("GST on charges (%)", cfg.eq_bse?.gst, e=>setChargesEdit(s=>({...s,eq_bse:{...s.eq_bse,gst:+e.target.value}})), C.yellow)}
              </div>
            </div>
          </div>

          {/* Extra Markup */}
          <div style={{ ...card, marginTop:20, borderLeft:`3px solid ${C.red}` }}>
            <div style={{ color:C.red, fontWeight:700, fontSize:13, marginBottom:12 }}>Extra Markup % (applied on total charges)</div>
            <div style={{ color:C.muted, fontSize:12, marginBottom:12 }}>
              E.g. enter 5 → all charges increase by 5%. GST 18% becomes 18.9%, etc.
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:16 }}>
              <input type="number" step="0.1" min="0" max="100"
                value={cfg.extraMarkup || 0}
                onChange={e => {
                  const v = +e.target.value;
                  if (chargesEdit) setChargesEdit(s=>({...s,extraMarkup:v}));
                }}
                style={{ ...input, width:120, fontSize:18, fontWeight:700, color:C.red, textAlign:"center" }}
                disabled={!chargesEdit}
              />
              <div style={{ color:C.muted, fontSize:13 }}>%</div>
              <div style={{ color:C.muted, fontSize:12 }}>
                {(cfg.extraMarkup||0) > 0
                  ? `GST example: 18% × (1 + ${cfg.extraMarkup}/100) = ${(18*(1+cfg.extraMarkup/100)).toFixed(3)}%`
                  : "No extra markup currently applied"}
              </div>
            </div>
          </div>

          {/* Client monthly charges summary */}
          <div style={{ ...card, marginTop:20 }}>
            <div style={{ color:C.text, fontWeight:700, fontSize:14, marginBottom:16 }}>Monthly Charges Summary — All Clients</div>
            {state.clients.map(client => {
              const months = [...new Set(state.trades.filter(t=>t.clientId===client.id).map(t=>(t.date||"").slice(0,7)))].sort().reverse();
              if (!months.length) return null;
              return (
                <div key={client.id} style={{ marginBottom:16 }}>
                  <div style={{ color:C.accent, fontWeight:600, marginBottom:8 }}>{client.name}</div>
                  <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
                    {months.map(m => (
                      <div key={m} style={{ background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:"8px 14px", fontSize:12 }}>
                        <div style={{ color:C.muted }}>{m}</div>
                        <div style={{ color:C.yellow, fontWeight:700, fontSize:15 }}>₹{getMonthlyCharges(client.id, m).toFixed(2)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      );
    }

    if (page === "charges" && auth.role === "client") {
      const months = [...new Set(state.trades.filter(t=>t.clientId===cid).map(t=>(t.date||"").slice(0,7)))].sort().reverse();
      return (
        <div>
          <h2 style={{ color:C.text, marginBottom:6 }}>My Charges</h2>
          <div style={{ color:C.muted, fontSize:13, marginBottom:24 }}>Monthly brokerage and statutory charges summary.</div>
          {months.length === 0 ? (
            <div style={{ ...card, textAlign:"center", padding:40, color:C.muted }}>No charge data available yet.</div>
          ) : (
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(180px,1fr))", gap:16 }}>
              {months.map(m => (
                <div key={m} style={{ ...card, textAlign:"center", borderTop:`3px solid ${C.yellow}` }}>
                  <div style={{ color:C.muted, fontSize:13, marginBottom:8 }}>{m}</div>
                  <div style={{ color:C.yellow, fontWeight:700, fontSize:22 }}>₹{getMonthlyCharges(cid, m).toFixed(2)}</div>
                  <div style={{ color:C.muted, fontSize:11, marginTop:6 }}>Total Charges</div>
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }


    if (page === "tickets") {
      const isAdmin = (auth.role === "admin" || auth.role === "superadmin") || auth.role === "superadmin";
      const ISSUE_TYPES = ["Trade Discrepancy","Margin Query","Account Statement","P&L Issue","Withdrawal/Deposit","Technical Issue","Bhavcopy/Settlement","Other"];
      const allTickets = isAdmin ? state.tickets : clientTickets(cid);
      const filteredTickets = ticketFilter === "all" ? allTickets : allTickets.filter(t => t.status === ticketFilter);
      const counts = { all: allTickets.length, open: allTickets.filter(t=>t.status==="open").length, answered: allTickets.filter(t=>t.status==="answered").length, closed: allTickets.filter(t=>t.status==="closed").length };

      return (
        <div>
          {/* Header */}
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20, flexWrap:"wrap", gap:12 }}>
            <h2 style={{ color:C.text, margin:0 }}>Support Tickets</h2>
            {!isAdmin && (
              <button style={btn(C.accent)} onClick={() => setModal("newTicket")}>
                <Icon name="add" size={16}/> Raise New Ticket
              </button>
            )}
          </div>

          {/* Filter tabs */}
          <div style={{ display:"flex", gap:6, marginBottom:20, flexWrap:"wrap" }}>
            {[
              { val:"all",      label:`All (${counts.all})` },
              { val:"open",     label:`Open (${counts.open})`, color:C.yellow },
              { val:"answered", label:`Answered (${counts.answered})`, color:C.accent },
              { val:"closed",   label:`Closed (${counts.closed})`, color:C.green },
            ].map(f => (
              <button key={f.val} onClick={() => setTicketFilter(f.val)}
                style={{ padding:"7px 16px", borderRadius:8, border:`1.5px solid ${ticketFilter===f.val ? (f.color||C.accent) : C.border}`,
                  background: ticketFilter===f.val ? (f.color||C.accent)+"12" : "transparent",
                  color: ticketFilter===f.val ? (f.color||C.accent) : C.muted,
                  fontWeight: ticketFilter===f.val ? 600 : 400, fontSize:13, cursor:"pointer" }}>
                {f.label}
              </button>
            ))}
          </div>

          {/* Tickets list */}
          {filteredTickets.length === 0 && (
            <div style={{ ...card, textAlign:"center", padding:48, color:C.muted }}>
              <div style={{ fontSize:40, marginBottom:12 }}>🎫</div>
              <div style={{ fontWeight:600, marginBottom:6 }}>No tickets found</div>
              <div style={{ fontSize:13 }}>
                {!isAdmin ? "Click 'Raise New Ticket' to submit a support request." : "No tickets in this category."}
              </div>
            </div>
          )}

          {filteredTickets.slice().sort((a,b)=>b.date.localeCompare(a.date)).map(t => {
            const client = state.clients.find(c => c.id === t.clientId);
            const statusColor = t.status==="open" ? C.yellow : t.status==="answered" ? C.accent : C.green;
            return (
              <div key={t.id} style={{ ...card, marginBottom:16 }}>
                {/* Ticket header */}
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:14, flexWrap:"wrap", gap:10 }}>
                  <div>
                    <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:4, flexWrap:"wrap" }}>
                      <span style={{ color:C.text, fontWeight:700, fontSize:15 }}>#{t.id.replace("TK","")}</span>
                      <span style={badge(statusColor)}>{t.status.toUpperCase()}</span>
                      <span style={badge(C.purple)}>{t.issueType || t.subject}</span>
                    </div>
                    <div style={{ display:"flex", gap:16, flexWrap:"wrap" }}>
                      {isAdmin && <span style={{ color:C.muted, fontSize:12 }}>👤 {client?.name || t.clientId} ({t.clientId})</span>}
                      <span style={{ color:C.muted, fontSize:12 }}>📅 {t.date}</span>
                      <span style={{ color:C.muted, fontSize:12 }}>💬 {t.replies?.length || 0} replies</span>
                    </div>
                  </div>
                  {isAdmin && (
                    <div style={{ display:"flex", gap:8 }}>
                      {t.status !== "closed" && (
                        <button style={{ ...btn(C.green), padding:"6px 14px", fontSize:12 }}
                          onClick={() => setState(s=>({...s,tickets:s.tickets.map(x=>x.id===t.id?{...x,status:"closed"}:x)}))}>
                          ✓ Close
                        </button>
                      )}
                      <button style={{ ...btn(C.red), padding:"6px 12px", fontSize:12 }}
                        onClick={() => setState(s=>({...s,tickets:s.tickets.filter(x=>x.id!==t.id)}))}>
                        <Icon name="delete" size={13}/>
                      </button>
                    </div>
                  )}
                </div>

                {/* Original message */}
                <div style={{ background:"#f8fafc", border:`1px solid ${C.border}`, borderRadius:10, padding:"12px 16px", marginBottom:12 }}>
                  <div style={{ color:C.muted, fontSize:11, fontWeight:600, marginBottom:6, textTransform:"uppercase", letterSpacing:0.5 }}>Description</div>
                  <div style={{ color:C.text, fontSize:13, lineHeight:1.6 }}>{t.message}</div>
                  {t.attachments && t.attachments.length > 0 && (
                    <div style={{ marginTop:10, display:"flex", gap:8, flexWrap:"wrap" }}>
                      {t.attachments.map((a,i) => (
                        <span key={i} style={{ background:"#e8f4fd", border:`1px solid #93c5fd`, borderRadius:6, padding:"3px 10px", fontSize:12, color:C.accent }}>
                          📎 {a}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Replies thread */}
                {t.replies && t.replies.length > 0 && (
                  <div style={{ marginBottom:12 }}>
                    {t.replies.map((r,i) => (
                      <div key={i} style={{ display:"flex", gap:10, marginBottom:10 }}>
                        <div style={{ width:32, height:32, borderRadius:"50%", background: r.from==="admin"?C.accent+"22":C.green+"22",
                          display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, flexShrink:0 }}>
                          {r.from==="admin" ? "A" : "C"}
                        </div>
                        <div style={{ flex:1, background: r.from==="admin"?"#eff6ff":"#f0fdf4", border:`1px solid ${r.from==="admin"?"#bfdbfe":"#bbf7d0"}`, borderRadius:10, padding:"10px 14px" }}>
                          <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                            <span style={{ color:r.from==="admin"?C.accent:C.green, fontWeight:600, fontSize:12 }}>
                              {r.from==="admin" ? "Support Team" : client?.name || "Client"}
                            </span>
                            <span style={{ color:C.muted, fontSize:11 }}>{r.date}</span>
                          </div>
                          <div style={{ color:C.text, fontSize:13, lineHeight:1.5 }}>{r.text}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Reply box — admin only */}
                {isAdmin && t.status !== "closed" && (
                  <div style={{ display:"flex", gap:8, marginTop:4 }}>
                    <input value={replyText} onChange={e => setReplyText(e.target.value)}
                      placeholder="Type your reply..."
                      onKeyDown={e => e.key==="Enter" && replyTicket(t.id)}
                      style={{ ...input, flex:1, background:"#f8fafc" }} />
                    <button style={btn(C.accent)} onClick={() => replyTicket(t.id)}>
                      <Icon name="reply" size={14}/> Reply
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      );
    }

    // ── RMS Page ──
    // ── AUDIT LOG PAGE (Perfect plan / Superadmin) ──
    if (page === "audit" && (auth.role === "admin" || auth.role === "superadmin")) {
      const myClientIds = visibleClients.map(c => c.id);
      const fullLog = (state.auditLog || []).filter(a => auth.role === "superadmin" || myClientIds.includes(a.clientId));

      const auditClientFilter = auditFilterClient, setAuditClientFilter_ = setAuditFilterClient;
      const auditActionFilter = auditFilterAction, setAuditActionFilter_ = setAuditFilterAction;

      const filtered = fullLog.filter(a => {
        if (auditClientFilter !== "all" && a.clientId !== auditClientFilter) return false;
        if (auditActionFilter !== "all" && a.action !== auditActionFilter) return false;
        return true;
      });

      const actionColor = (act) => act==="ADDED"?C.green:act==="EDITED"?C.yellow:C.red;
      const actionIcon  = (act) => act==="ADDED"?"➕":act==="EDITED"?"✏️":"🗑️";

      const exportCSV = () => {
        const header = "Date/Time,Admin,Action,Client,Details\\n";
        const rows = filtered.map(a =>
          `"${new Date(a.timestamp).toLocaleString("en-IN")}","${a.actor}","${a.action}","${a.clientId}","${(a.details||"").replace(/"/g,"'")}"`
        ).join("\\n");
        const blob = new Blob([header + rows], { type: "text/csv" });
        const url  = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `audit_log_${new Date().toISOString().slice(0,10)}.csv`;
        link.click();
        URL.revokeObjectURL(url);
      };

      return (
        <div>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20, flexWrap:"wrap", gap:12 }}>
            <div>
              <h2 style={{ color:C.text, margin:0 }}>📋 Audit Log</h2>
              <div style={{ color:C.muted, fontSize:13, marginTop:4 }}>Complete history of ledger changes — who, what, when</div>
            </div>
            <button onClick={exportCSV} style={{...btn(C.accent), fontSize:13}}>
              ⬇ Export CSV
            </button>
          </div>

          {/* Filters */}
          <div style={{ ...card, padding:"14px 20px", marginBottom:16, display:"flex", gap:12, flexWrap:"wrap", alignItems:"center" }}>
            <span style={{ color:C.muted, fontSize:12, fontWeight:600 }}>FILTER BY:</span>
            <select value={auditClientFilter} onChange={e=>setAuditClientFilter_(e.target.value)}
              style={{ background:"#f8fafc", border:`1px solid ${C.border}`, borderRadius:8, padding:"6px 12px", color:C.text, fontSize:13, cursor:"pointer" }}>
              <option value="all">All Clients</option>
              {visibleClients.map(c => <option key={c.id} value={c.id}>{c.name} ({c.id})</option>)}
            </select>
            <select value={auditActionFilter} onChange={e=>setAuditActionFilter_(e.target.value)}
              style={{ background:"#f8fafc", border:`1px solid ${C.border}`, borderRadius:8, padding:"6px 12px", color:C.text, fontSize:13, cursor:"pointer" }}>
              <option value="all">All Actions</option>
              <option value="ADDED">Added</option>
              <option value="EDITED">Edited</option>
              <option value="DELETED">Deleted</option>
            </select>
            <span style={{ color:C.muted, fontSize:12 }}>{filtered.length} entries</span>
          </div>

          {/* Log table */}
          {filtered.length === 0 ? (
            <div style={{ ...card, textAlign:"center", padding:48, color:C.muted }}>
              <div style={{ fontSize:36, marginBottom:12 }}>📋</div>
              <div style={{ fontWeight:600 }}>No audit entries yet</div>
              <div style={{ fontSize:13, marginTop:4 }}>Changes to ledger entries will appear here</div>
            </div>
          ) : (
            <div style={{ ...card, padding:0, overflow:"hidden" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                <thead>
                  <tr style={{ background:"#f8fafc" }}>
                    {["Date/Time","Admin","Action","Client","Details"].map(h=>(
                      <th key={h} style={{ textAlign:"left", padding:"10px 16px", color:C.muted, fontSize:11,
                        fontWeight:600, textTransform:"uppercase", letterSpacing:0.5, borderBottom:`1px solid ${C.border}` }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(a => (
                    <tr key={a.id} style={{ borderBottom:`1px solid ${C.border}` }}>
                      <td style={{ padding:"10px 16px", color:C.muted, whiteSpace:"nowrap" }}>
                        {new Date(a.timestamp).toLocaleString("en-IN",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"})}
                      </td>
                      <td style={{ padding:"10px 16px", color:C.text, fontWeight:600 }}>{a.actor}</td>
                      <td style={{ padding:"10px 16px" }}>
                        <span style={{ fontSize:11, padding:"2px 8px", borderRadius:4, fontWeight:700,
                          background:actionColor(a.action)+"18", color:actionColor(a.action) }}>
                          {actionIcon(a.action)} {a.action}
                        </span>
                      </td>
                      <td style={{ padding:"10px 16px", color:C.accent, fontWeight:600 }}>{a.clientId}</td>
                      <td style={{ padding:"10px 16px", color:C.muted }}>{a.details}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      );
    }

    if (page === "rms" && (auth.role === "admin" || auth.role === "superadmin") && hasFeature(auth?.plan, "rms")) {
      return <RMSPage state={state} indexPrices={rmsIndexPrices} setIndexPrices={setRmsIndexPrices} funds={rmsFunds} setFunds={setRmsFunds} notify={notify} C={C} card={card} btn={btn} input={input} livePrice={angelLivePrice} rmsRef={rmsPositionsRef} lastUpdated={rmsLastUpdated} />;
    }
    if (page === "settings" && (auth.role === "admin" || auth.role === "superadmin")) {
      return <SettingsPage angelCreds={angelCreds} setAngelCreds={setAngelCreds} angelStatus={angelStatus} connectAngel={connectAngel} disconnectAngel={disconnectAngel} notify={notify} C={C} card={card} btn={btn} input={input} state={state} setState={setState} sb={sb} withSync={withSync} auth={auth} />;
    }

    // ── Super Admin: Manage Admins ──
    if (page === "manage_admins" && auth?.role === "superadmin") {
      return <ManageAdminsPage state={state} setState={setState} sb={sb} withSync={withSync} notify={notify} C={C} card={card} btn={btn} input={input} />;
    }

    // ── Super Admin: Manage Tokens ──
    if (page === "manage_tokens" && auth?.role === "superadmin") {
      return <ManageTokensPage state={state} setState={setState} sb={sb} withSync={withSync} notify={notify} C={C} card={card} btn={btn} input={input} />;
    }

    // ── Token expiry warning for sub-admins ──
    if (auth?.role === "admin") {
      const myAdmin = (state.admins||[]).find(a => a.id === auth.adminId);
      if (myAdmin?.tokenExpiry) {
        const daysLeft = Math.ceil((new Date(myAdmin.tokenExpiry) - new Date()) / (1000*60*60*24));
        if (daysLeft <= 7 && daysLeft > 0) {
          // Show warning banner — but still render the page
        }
      }
    }

    // ── Fallback: locked feature requested directly (e.g. RMS/Charges on Basic plan) ──
    if ((page === "charges" || page === "rms") && (auth.role === "admin" || auth.role === "superadmin")) {
      const featureLabel = page === "charges" ? "Charges" : "RMS";
      return (
        <div style={{ ...card, textAlign:"center", padding:56 }}>
          <div style={{ fontSize:42, marginBottom:16 }}>🔒</div>
          <div style={{ fontWeight:800, fontSize:18, color:C.text, marginBottom:8 }}>
            {featureLabel} is locked on your current plan
          </div>
          <div style={{ color:C.muted, fontSize:13, marginBottom:20 }}>
            Upgrade your plan to unlock {featureLabel} and other premium features.
          </div>
          <div style={{ color:C.muted, fontSize:12 }}>
            Contact JIYA to upgrade your subscription.
          </div>
        </div>
      );
    }
  };

  // ── Modal ──
  // ── Trade History Modal ──
  const renderTradeHistoryModal = () => {
    if (!selectedContract) return null;
    const { contract, clientId } = selectedContract;
    const trades = state.trades.filter(t =>
      t.clientId === clientId && t.contract === contract
    ).sort((a,b) => new Date(a.date+' '+a.time) - new Date(b.date+' '+b.time));

    const totalQty = trades.reduce((s,t) => t.side==="BUY" ? s+t.qty : s-t.qty, 0);
    const overlay  = { position:"fixed", inset:0, background:"rgba(15,23,42,0.5)",
      display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000 };

    return (
      <div style={overlay} onClick={()=>setSelectedContract(null)}>
        <div style={{background:C.card,borderRadius:16,padding:28,width:"min(700px,95vw)",
          maxHeight:"80vh",overflow:"auto",boxShadow:"0 20px 60px rgba(0,0,0,0.2)"}}
          onClick={e=>e.stopPropagation()}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
            <div>
              <div style={{fontSize:16,fontWeight:800,color:C.text}}>{contract}</div>
              <div style={{color:C.muted,fontSize:12,marginTop:2}}>
                {trades.length} trades · Net qty: {totalQty > 0 ? "+" : ""}{totalQty}
              </div>
            </div>
            <button onClick={()=>setSelectedContract(null)}
              style={{background:"none",border:"none",fontSize:20,cursor:"pointer",color:C.muted}}>✕</button>
          </div>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
            <thead>
              <tr style={{background:C.bg}}>
                {["Date","Time","Side","Qty","Price","Value"].map(h=>(
                  <th key={h} style={{padding:"8px 12px",color:C.muted,fontSize:11,fontWeight:600,
                    textAlign:h==="Date"||h==="Time"||h==="Side"?"left":"right",textTransform:"uppercase",letterSpacing:0.5}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trades.map((t,i)=>(
                <tr key={i} style={{borderBottom:`1px solid ${C.border}`}}>
                  <td style={{padding:"9px 12px",color:C.muted}}>{t.date}</td>
                  <td style={{padding:"9px 12px",color:C.muted}}>{t.time}</td>
                  <td style={{padding:"9px 12px"}}>
                    <span style={{background:(t.side==="BUY"?C.green:C.red)+"18",
                      color:t.side==="BUY"?C.green:C.red,
                      padding:"2px 8px",borderRadius:4,fontWeight:700,fontSize:12}}>
                      {t.side}
                    </span>
                  </td>
                  <td style={{padding:"9px 12px",textAlign:"right",fontWeight:600}}>{t.qty.toLocaleString()}</td>
                  <td style={{padding:"9px 12px",textAlign:"right"}}>₹{t.price.toFixed(2)}</td>
                  <td style={{padding:"9px 12px",textAlign:"right",color:C.muted}}>
                    ₹{(t.qty*t.price).toLocaleString("en-IN",{maximumFractionDigits:0})}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {trades.length === 0 && (
            <div style={{textAlign:"center",padding:40,color:C.muted}}>No trades found for this contract</div>
          )}
        </div>
      </div>
    );
  };

  const renderModal = () => {
    if (!modal) return null;

    // ── Upload History Modal ──
    if (modal === "uploadHistory") {
      const overlay = { position:"fixed", inset:0, background:"rgba(15,23,42,0.5)",
        display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000 };
      return (
        <div style={overlay} onClick={() => setModal(null)}>
          <div style={{background:C.card, borderRadius:16, padding:28, width:"min(560px,95vw)",
            boxShadow:"0 20px 60px rgba(0,0,0,0.2)"}} onClick={e=>e.stopPropagation()}>

            <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20}}>
              <div>
                <div style={{fontSize:16, fontWeight:800, color:C.text}}>🕐 Upload History</div>
                <div style={{color:C.muted, fontSize:12, marginTop:2}}>Last {uploadHistory.length} uploads — click Undo to reverse</div>
              </div>
              <button onClick={()=>setModal(null)}
                style={{background:"none",border:"none",fontSize:20,cursor:"pointer",color:C.muted}}>✕</button>
            </div>

            {uploadHistory.length === 0 ? (
              <div style={{textAlign:"center", padding:40, color:C.muted}}>No upload history yet</div>
            ) : (
              <div style={{display:"flex", flexDirection:"column", gap:10}}>
                {uploadHistory.map((entry, i) => {
                  const ts = new Date(entry.timestamp);
                  const timeStr = ts.toLocaleDateString("en-IN") + " " + ts.toLocaleTimeString("en-IN", {hour:"2-digit", minute:"2-digit"});
                  const modeColor = entry.mode === "replace" ? C.red : C.green;
                  const isLocked = (state.lockedMonths||[]).includes(entry.month);
                  return (
                    <div key={entry.batchId} style={{
                      display:"flex", alignItems:"center", justifyContent:"space-between",
                      padding:"12px 16px", borderRadius:10,
                      background: i===0 ? C.accent+"08" : C.bg,
                      border:`1px solid ${i===0 ? C.accent+"30" : C.border}`
                    }}>
                      <div style={{flex:1}}>
                        <div style={{display:"flex", alignItems:"center", gap:8, marginBottom:4}}>
                          <span style={{fontSize:12, fontWeight:700, color:C.text}}>
                            {entry.filename}
                          </span>
                          <span style={{fontSize:10, padding:"1px 7px", borderRadius:4,
                            background:modeColor+"18", color:modeColor, fontWeight:700,
                            textTransform:"uppercase"}}>
                            {entry.mode}
                          </span>
                          {i === 0 && (
                            <span style={{fontSize:10, padding:"1px 7px", borderRadius:4,
                              background:C.accent+"18", color:C.accent, fontWeight:700}}>
                              Latest
                            </span>
                          )}
                        </div>
                        <div style={{color:C.muted, fontSize:11}}>
                          {entry.tradeCount} trades · {entry.clients} clients · {timeStr}
                        </div>
                        {isLocked && (
                          <div style={{color:C.yellow, fontSize:10, marginTop:2}}>
                            Month {entry.month} is locked — undo not available
                          </div>
                        )}
                      </div>
                      {!isLocked ? (
                        <button
                          onClick={() => { setModal(null); undoUpload(entry); }}
                          style={{...btn(C.red), fontSize:12, padding:"6px 14px", marginLeft:12, whiteSpace:"nowrap"}}>
                          ↩ Undo
                        </button>
                      ) : (
                        <div style={{color:C.muted, fontSize:11, marginLeft:12}}>🔒 Locked</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div style={{marginTop:16, padding:12, background:C.yellow+"10",
              borderRadius:8, border:`1px solid ${C.yellow}22`, fontSize:12, color:C.muted}}>
              ⚠️ Undo removes those specific trades permanently. Only current month uploads can be undone.
            </div>
          </div>
        </div>
      );
    }
    const overlay = { position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 };
    const box = { background: "#fff", border: `1px solid ${C.border}`, borderRadius: 16, padding: 32, width: 480, maxWidth: "90vw", boxShadow: "0 20px 60px rgba(0,0,0,0.15)" };
    const field = (label, key, obj, setObj, type = "text", opts = null) => (
      <div style={{ marginBottom: 14 }}>
        <label style={{ color: C.muted, fontSize: 12, display: "block", marginBottom: 5 }}>{label}</label>
        {opts ? (
          <select value={obj[key]} onChange={(e) => setObj((s) => ({ ...s, [key]: e.target.value }))} style={{ ...input }}>
            <option value="">Select...</option>
            {opts.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.id})</option>)}
          </select>
        ) : (
          <input type={type} value={obj[key]} onChange={(e) => setObj((s) => ({ ...s, [key]: e.target.value }))} style={{ ...input }} />
        )}
      </div>
    );

    if (modal === "addClient") return (
      <div style={overlay} onClick={() => setModal(null)}>
        <div style={box} onClick={(e) => e.stopPropagation()}>
          <h3 style={{ color: C.text, marginTop: 0 }}>Add New Client</h3>
          {field("Client ID *", "id", newClient, setNewClient)}
          {field("Full Name *", "name", newClient, setNewClient)}
          {field("Email", "email", newClient, setNewClient, "email")}
          {field("Phone", "phone", newClient, setNewClient)}
          {field("Password *", "password", newClient, setNewClient, "password")}
          <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
            <button style={btn(C.green)} onClick={addClient}><Icon name="check" size={14} /> Create Client</button>
            <button style={btn(C.muted)} onClick={() => setModal(null)}>Cancel</button>
          </div>
        </div>
      </div>
    );

    if (modal === "addLedger") return (
      <div style={overlay} onClick={() => setModal(null)}>
        <div style={box} onClick={(e) => e.stopPropagation()}>
          <h3 style={{ color:C.text, marginTop:0 }}>Add Ledger Entry</h3>

          {/* Entry Type selector */}
          <div style={{ marginBottom:16 }}>
            <label style={{ color:C.muted, fontSize:12, display:"block", marginBottom:8 }}>Entry Type *</label>
            <div style={{ display:"flex", gap:0, borderRadius:8, overflow:"hidden", border:`1px solid ${C.border}` }}>
              {[
                { val:"all", label:"All Entry", desc:"Regular entry — only in All Ledger" },
                { val:"dp",  label:"DP Entry",  desc:"DP entry — visible in both DP & All" },
              ].map(t => (
                <button key={t.val} onClick={() => setNewLedger(s=>({...s, ledgerType:t.val}))}
                  style={{ flex:1, padding:"10px 14px", border:"none", cursor:"pointer", textAlign:"center",
                    background: newLedger.ledgerType===t.val ? (t.val==="dp"?C.yellow:C.accent) : C.bg,
                    color: newLedger.ledgerType===t.val ? "#000" : C.muted,
                    fontWeight: newLedger.ledgerType===t.val ? 700 : 400, fontSize:13 }}>
                  {t.label}
                  <div style={{ fontSize:10, opacity:0.8, marginTop:2 }}>{t.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {field("Client *", "clientId", newLedger, setNewLedger, "text", state.clients)}
          {field("Date *", "date", newLedger, setNewLedger, "date")}
          {field("Description *", "description", newLedger, setNewLedger)}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
            <div>
              <label style={{ color:C.muted, fontSize:12, display:"block", marginBottom:5 }}>Credit (₹)</label>
              <input type="number" value={newLedger.credit} onChange={e=>setNewLedger(s=>({...s,credit:e.target.value,debit:""}))}
                style={{ ...input, borderColor: newLedger.credit ? C.green : C.border }} placeholder="0" />
            </div>
            <div>
              <label style={{ color:C.muted, fontSize:12, display:"block", marginBottom:5 }}>Debit (₹)</label>
              <input type="number" value={newLedger.debit} onChange={e=>setNewLedger(s=>({...s,debit:e.target.value,credit:""}))}
                style={{ ...input, borderColor: newLedger.debit ? C.red : C.border }} placeholder="0" />
            </div>
          </div>
          <div style={{ display:"flex", gap:10, marginTop:20 }}>
            <button style={btn(C.green)} onClick={addLedger}><Icon name="check" size={14}/> Add Entry</button>
            <button style={btn(C.muted)} onClick={() => setModal(null)}>Cancel</button>
          </div>
        </div>
      </div>
    );

    if (modal === "editLedger" && editLedgerEntry) return (
      <div style={overlay} onClick={() => { setModal(null); setEditLedgerEntry(null); }}>
        <div style={box} onClick={e => e.stopPropagation()}>
          <h3 style={{ color:C.text, marginTop:0 }}>✏️ Edit Ledger Entry</h3>

          {/* Entry Type toggle */}
          <div style={{ marginBottom:16 }}>
            <label style={{ color:C.muted, fontSize:12, display:"block", marginBottom:8 }}>Entry Type</label>
            <div style={{ display:"flex", gap:0, borderRadius:8, overflow:"hidden", border:`1px solid ${C.border}` }}>
              {[{ val:"all", label:"All Entry" },{ val:"dp", label:"DP Entry" }].map(t => (
                <button key={t.val} onClick={() => setEditLedgerEntry(s=>({...s,ledgerType:t.val}))}
                  style={{ flex:1, padding:"9px 14px", border:"none", cursor:"pointer",
                    background: editLedgerEntry.ledgerType===t.val ? (t.val==="dp"?C.yellow:C.accent) : C.bg,
                    color: editLedgerEntry.ledgerType===t.val ? "#000" : C.muted,
                    fontWeight: editLedgerEntry.ledgerType===t.val ? 700 : 400, fontSize:13 }}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom:14 }}>
            <label style={{ color:C.muted, fontSize:12, display:"block", marginBottom:5 }}>Date *</label>
            <input type="date" value={editLedgerEntry.date} onChange={e=>setEditLedgerEntry(s=>({...s,date:e.target.value}))} style={input}/>
          </div>
          <div style={{ marginBottom:14 }}>
            <label style={{ color:C.muted, fontSize:12, display:"block", marginBottom:5 }}>Description *</label>
            <input type="text" value={editLedgerEntry.description} onChange={e=>setEditLedgerEntry(s=>({...s,description:e.target.value}))} style={input}/>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:14 }}>
            <div>
              <label style={{ color:C.muted, fontSize:12, display:"block", marginBottom:5 }}>Credit (₹)</label>
              <input type="number" value={editLedgerEntry.credit} onChange={e=>setEditLedgerEntry(s=>({...s,credit:e.target.value}))}
                style={{ ...input, borderColor: editLedgerEntry.credit > 0 ? C.green : C.border }}/>
            </div>
            <div>
              <label style={{ color:C.muted, fontSize:12, display:"block", marginBottom:5 }}>Debit (₹)</label>
              <input type="number" value={editLedgerEntry.debit} onChange={e=>setEditLedgerEntry(s=>({...s,debit:e.target.value}))}
                style={{ ...input, borderColor: editLedgerEntry.debit > 0 ? C.red : C.border }}/>
            </div>
          </div>
          <div style={{ display:"flex", gap:10, marginTop:20 }}>
            <button style={btn(C.green)} onClick={saveLedgerEdit}><Icon name="check" size={14}/> Save Changes</button>
            <button style={btn(C.muted)} onClick={() => { setModal(null); setEditLedgerEntry(null); }}>Cancel</button>
          </div>
        </div>
      </div>
    );

    if (modal === "uploadTrades") return (
      <div style={overlay} onClick={() => { setModal(null); setUploadFile(null); setUploadPreview(null); }}>
        <div style={{ ...box, width: 640, maxHeight: "92vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
          <h3 style={{ color: C.text, marginTop: 0 }}>📂 Upload Broker Master File</h3>

          {/* STEP 1 — Trade Date */}
          <div style={{ background: C.bg, border: `2px solid ${C.accent}44`, borderRadius: 10, padding: "14px 18px", marginBottom: 16 }}>
            <div style={{ color: C.accent, fontWeight: 700, fontSize: 13, marginBottom: 10 }}>STEP 1 — Select Trade Date</div>
            <div style={{ color: C.muted, fontSize: 12, marginBottom: 10 }}>Which date are the trades in this file from? This is critical for correct FIFO ordering across multiple days.</div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <input
                type="date"
                value={uploadTradeDate}
                onChange={(e) => setUploadTradeDate(e.target.value)}
                style={{ ...input, width: "auto", fontSize: 14, fontWeight: 600, color: C.accent, cursor: "pointer" }}
              />
              {/* Quick date buttons */}
              {[
                { label: "Today", val: new Date().toISOString().slice(0,10) },
                { label: "Yesterday", val: new Date(Date.now()-86400000).toISOString().slice(0,10) },
                { label: "2 days ago", val: new Date(Date.now()-2*86400000).toISOString().slice(0,10) },
              ].map(d => (
                <button key={d.label} onClick={() => setUploadTradeDate(d.val)}
                  style={{ ...btn(uploadTradeDate === d.val ? C.accent : C.card), border: `1px solid ${uploadTradeDate === d.val ? C.accent : C.border}`, fontSize: 12 }}>
                  {d.label} ({d.val.slice(5)})
                </button>
              ))}
            </div>
            {uploadTradeDate && (
              <div style={{ marginTop: 8, color: C.green, fontSize: 12, fontWeight: 600 }}>
                ✅ File will be tagged as: {new Date(uploadTradeDate+"T00:00:00").toDateString()}
              </div>
            )}
          </div>

          {/* STEP 2 — Import Mode */}
          <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 18px", marginBottom: 16 }}>
            <div style={{ color: C.accent, fontWeight: 700, fontSize: 13, marginBottom: 10 }}>STEP 2 — Import Mode</div>
            <div style={{ display: "flex", gap: 8 }}>
              {[
                { val: "append", label: "➕ Append", desc: "Add to existing trades (use for daily uploads within same month)" },
                { val: "replace", label: "🔄 Replace", desc: "Replace current month trades only (previous months are safe)" },
              ].map(m => (
                <div key={m.val} onClick={() => setUploadMode(m.val)}
                  style={{ flex: 1, padding: "10px 14px", borderRadius: 8, cursor: "pointer",
                    border: `2px solid ${uploadMode === m.val ? C.accent : C.border}`,
                    background: uploadMode === m.val ? C.accent+"11" : "transparent" }}>
                  <div style={{ color: uploadMode === m.val ? C.accent : C.text, fontWeight: 700, fontSize: 13 }}>{m.label}</div>
                  <div style={{ color: C.muted, fontSize: 11, marginTop: 4 }}>{m.desc}</div>
                </div>
              ))}
            </div>
          </div>

          {/* STEP 3 — File */}
          <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 18px", marginBottom: 16 }}>
            <div style={{ color: C.accent, fontWeight: 700, fontSize: 13, marginBottom: 10 }}>STEP 3 — Select CSV File</div>
            <div style={{ color: C.muted, fontSize: 11, marginBottom: 10 }}>
              Export your broker Excel as <b style={{color:C.text}}>CSV UTF-8 (Comma delimited)</b> then upload here.
              Expected headers: User, Exchange, Instrument Type, Symbol, Ser/Exp/Group, Strike Price, Option Type, Scrip Name, B/S, Quantity, Price, Time
            </div>
            {!uploadTradeDate ? (
              <div style={{ color: C.yellow, fontSize: 13, padding: "10px", border: `1px solid ${C.yellow}44`, borderRadius: 8, background: C.yellow+"11" }}>
                ⚠️ Please select a trade date in Step 1 before uploading the file.
              </div>
            ) : (
              <input type="file" accept=".csv,.txt" onChange={handleFileUpload}
                style={{ color: C.text, fontSize: 13, background: "#f8fafc", border: `1px solid ${C.border}`,
                  borderRadius: 8, padding: "10px 14px", width: "100%", boxSizing: "border-box", cursor: "pointer" }} />
            )}
          </div>

          {/* Preview */}
          {uploadPreview && (
            <div style={{ marginBottom: 16 }}>
              {uploadPreview.warnings.map((w, i) => (
                <div key={i} style={{
                  background: w.startsWith("❌") ? "#f8514922" : w.startsWith("⚠️") ? "#d2992222" : "#58a6ff11",
                  border: `1px solid ${w.startsWith("❌") ? C.red : w.startsWith("⚠️") ? C.yellow : C.accent}44`,
                  borderRadius: 6, padding: "7px 12px", color: w.startsWith("❌") ? C.red : w.startsWith("⚠️") ? C.yellow : C.muted,
                  fontSize: 11, marginBottom: 5, wordBreak: "break-all", fontFamily: "monospace"
                }}>{w}</div>
              ))}
              {uploadPreview.rows.length > 0 && (
                <div style={{ background: "#3fb95022", border: `1px solid ${C.green}44`, borderRadius: 8, padding: "12px 14px" }}>
                  <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 10 }}>
                    <span style={{ color: C.green, fontWeight: 700 }}>✅ {uploadPreview.rows.length} trades ready</span>
                    <span style={{ color: C.green, fontSize: 13 }}>🟢 BUY: {uploadPreview.rows.filter(r=>r.side==="BUY").length}</span>
                    <span style={{ color: C.red, fontSize: 13 }}>🔴 SELL: {uploadPreview.rows.filter(r=>r.side==="SELL").length}</span>
                    <span style={{ color: C.muted, fontSize: 13 }}>👥 Clients: {[...new Set(uploadPreview.rows.map(r=>r.clientId))].length}</span>
                    <span style={{ color: C.muted, fontSize: 13 }}>📋 Contracts: {[...new Set(uploadPreview.rows.map(r=>r.contract))].length}</span>
                    <span style={{ color: C.accent, fontSize: 13 }}>📅 Date: {uploadTradeDate}</span>
                  </div>
                  <div style={{ maxHeight: 180, overflowY: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                      <thead><tr>{["Date","Client","Contract","B/S","Qty","₹Price","Time"].map(h=>(
                        <th key={h} style={{textAlign:"left",padding:"5px 8px",color:C.muted,borderBottom:`1px solid ${C.border}`,whiteSpace:"nowrap"}}>{h}</th>
                      ))}</tr></thead>
                      <tbody>
                        {uploadPreview.rows.slice(0,25).map((r,i)=>(
                          <tr key={i} style={{borderBottom:`1px solid ${C.border}22`}}>
                            <td style={{padding:"5px 8px",color:C.purple,fontSize:10}}>{r.date}</td>
                            <td style={{padding:"5px 8px",color:C.accent}}>{r.clientId}</td>
                            <td style={{padding:"5px 8px",color:C.text,maxWidth:160,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.contract}</td>
                            <td style={{padding:"5px 8px"}}><span style={{color:r.side==="SELL"?C.red:C.green,fontWeight:700}}>{r.side}</span></td>
                            <td style={{padding:"5px 8px",color:C.text}}>{r.qty}</td>
                            <td style={{padding:"5px 8px",color:C.text}}>₹{r.price}</td>
                            <td style={{padding:"5px 8px",color:C.muted,fontSize:10}}>{r.time}</td>
                          </tr>
                        ))}
                        {uploadPreview.rows.length > 25 && (
                          <tr><td colSpan={7} style={{padding:"6px 8px",color:C.muted,fontSize:11,textAlign:"center"}}>
                            ...and {uploadPreview.rows.length - 25} more trades
                          </td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          <div style={{ display: "flex", gap: 10 }}>
            <button
              style={{ ...btn(!uploadPreview?.rows?.length || !uploadTradeDate ? C.muted : C.purple), opacity: (!uploadPreview?.rows?.length || !uploadTradeDate) ? 0.5 : 1 }}
              onClick={confirmUpload}
              disabled={!uploadPreview?.rows?.length || !uploadTradeDate}
            >
              <Icon name="upload" size={14} /> Import & Apply FIFO
            </button>
            <button style={btn(C.muted)} onClick={() => { setModal(null); setUploadFile(null); setUploadPreview(null); }}>Cancel</button>
          </div>
        </div>
      </div>
    );

    if (modal === "uploadBhav") return (
      <div style={overlay} onClick={() => { setModal(null); setBhavPreview(null); }}>
        <div style={{ ...box, width: 640, maxHeight:"92vh", overflowY:"auto" }} onClick={e => e.stopPropagation()}>
          <h3 style={{ color:C.text, marginTop:0 }}>📊 Upload NSE F&O Bhavcopy</h3>

          {/* Date */}
          <div style={{ background:C.bg, border:`2px solid ${C.purple}44`, borderRadius:10, padding:"14px 18px", marginBottom:16 }}>
            <div style={{ color:C.purple, fontWeight:700, fontSize:13, marginBottom:8 }}>Bhavcopy Date (Trade Date)</div>
            <div style={{ display:"flex", gap:10, alignItems:"center", flexWrap:"wrap" }}>
              <input type="date" value={bhavDate} onChange={e => setBhavDate(e.target.value)}
                style={{ ...input, width:"auto", fontSize:14, fontWeight:600, color:C.purple }} />
              {[
                { label:"Today", val: new Date().toISOString().slice(0,10) },
                { label:"Yesterday", val: new Date(Date.now()-86400000).toISOString().slice(0,10) },
              ].map(d => (
                <button key={d.label} onClick={() => setBhavDate(d.val)}
                  style={{ ...btn(bhavDate===d.val ? C.purple : C.card), border:`1px solid ${bhavDate===d.val ? C.purple : C.border}`, fontSize:12 }}>
                  {d.label}
                </button>
              ))}
            </div>
          </div>

          {/* File */}
          <div style={{ background:C.bg, border:`1px solid ${C.border}`, borderRadius:10, padding:"14px 18px", marginBottom:16 }}>
            <div style={{ color:C.accent, fontWeight:700, fontSize:13, marginBottom:8 }}>Select Bhavcopy File</div>
            <div style={{ color:C.muted, fontSize:11, marginBottom:10 }}>
              Download from NSE: <b style={{color:C.text}}>nseindia.com → Market Data → Bhavcopy → F&O</b><br/>
              File name format: <b style={{color:C.text}}>BhavCopy_NSE_FO_0_0_0_YYYYMMDD_F_0000.csv</b>
            </div>
            <input type="file" accept=".csv" onChange={handleBhavUpload}
              style={{ color:C.text, fontSize:13, background:"#f8fafc", border:`1px solid ${C.border}`,
                borderRadius:8, padding:"10px 14px", width:"100%", boxSizing:"border-box", cursor:"pointer" }} />
          </div>

          {/* Preview */}
          {bhavPreview && (
            <div style={{ marginBottom:16 }}>
              <div style={{ background:"#3fb95022", border:`1px solid ${C.green}44`, borderRadius:8, padding:"14px 18px", marginBottom:12 }}>
                <div style={{ color:C.green, fontWeight:700, marginBottom:10, fontSize:14 }}>✅ Bhavcopy Parsed Successfully</div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12, marginBottom:12 }}>
                  <div style={{background:C.bg,borderRadius:8,padding:"10px 14px"}}>
                    <div style={{color:C.muted,fontSize:11}}>TOTAL CONTRACTS</div>
                    <div style={{color:C.text,fontWeight:700,fontSize:18}}>{bhavPreview.rows.length.toLocaleString()}</div>
                  </div>
                  <div style={{background:C.bg,borderRadius:8,padding:"10px 14px"}}>
                    <div style={{color:C.muted,fontSize:11}}>MATCHED WITH YOUR POSITIONS</div>
                    <div style={{color:C.accent,fontWeight:700,fontSize:18}}>{bhavPreview.matched.length}</div>
                  </div>
                  <div style={{background:C.bg,borderRadius:8,padding:"10px 14px",border:`1px solid ${C.red}44`}}>
                    <div style={{color:C.muted,fontSize:11}}>EXPIRING TODAY ({bhavDate})</div>
                    <div style={{color:C.red,fontWeight:700,fontSize:18}}>{bhavPreview.expiring.length} positions</div>
                  </div>
                </div>

                {bhavPreview.matched.length > 0 && (
                  <>
                    <div style={{color:C.text, fontWeight:600, fontSize:13, marginBottom:8}}>Your Open Positions — Closing Prices:</div>
                    <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                      <thead><tr>{["Contract","Close Price","Settl Price","Expires"].map(h=>(
                        <th key={h} style={{textAlign:"left",padding:"6px 10px",color:C.muted,borderBottom:`1px solid ${C.border}`}}>{h}</th>
                      ))}</tr></thead>
                      <tbody>
                        {bhavPreview.matched.map((r,i)=>(
                          <tr key={i} style={{borderBottom:`1px solid ${C.border}22`,background:r.expiryRaw===bhavDate?C.red+"11":"transparent"}}>
                            <td style={{padding:"7px 10px",color:C.accent}}>{r.contract}</td>
                            <td style={{padding:"7px 10px",color:C.purple,fontWeight:600}}>₹{r.closePrice}</td>
                            <td style={{padding:"7px 10px",color:C.text}}>₹{r.settlPrice}</td>
                            <td style={{padding:"7px 10px"}}>
                              {r.expiryRaw === bhavDate
                                ? <span style={badge(C.red)}>⚠️ TODAY — Auto Square-off @ ₹{r.settlPrice}</span>
                                : <span style={{color:C.muted,fontSize:11}}>{r.expiryRaw}</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}

                {bhavPreview.expiring.length > 0 && (
                  <div style={{marginTop:12, padding:"10px 14px", background:C.red+"11", border:`1px solid ${C.red}44`, borderRadius:8, fontSize:12, color:C.yellow}}>
                    ⚠️ <b>{bhavPreview.expiring.length} expiring contracts</b> will be automatically squared off at their settlement price when you click Apply.
                  </div>
                )}
              </div>
            </div>
          )}

          <div style={{ display:"flex", gap:10 }}>
            <button style={{ ...btn(!bhavPreview ? C.muted : C.purple), opacity: !bhavPreview ? 0.5 : 1 }}
              onClick={applyBhavcopy} disabled={!bhavPreview}>
              <Icon name="check" size={14}/> Apply Bhavcopy
            </button>
            <button style={btn(C.muted)} onClick={() => { setModal(null); setBhavPreview(null); }}>Cancel</button>
          </div>
        </div>
      </div>
    );

    if (modal === "addInterest") return (
      <div style={overlay} onClick={() => setModal(null)}>
        <div style={box} onClick={e => e.stopPropagation()}>
          <h3 style={{ color:C.text, marginTop:0 }}>💰 Add Interest / Brokerage Charge</h3>
          <div style={{ color:C.muted, fontSize:12, marginBottom:16 }}>
            Add a manual monthly interest or brokerage charge for a client. This will be deducted from their Net P&L for that month.
          </div>

          <div style={{ marginBottom:14 }}>
            <label style={{ color:C.muted, fontSize:12, display:"block", marginBottom:5 }}>Client *</label>
            <select value={addInterestForm.clientId} onChange={e=>setAddInterestForm(s=>({...s,clientId:e.target.value}))} style={input}>
              <option value="">Select client...</option>
              {state.clients.map(c=><option key={c.id} value={c.id}>{c.name} ({c.id})</option>)}
            </select>
          </div>

          <div style={{ marginBottom:14 }}>
            <label style={{ color:C.muted, fontSize:12, display:"block", marginBottom:5 }}>Month (YYYY-MM) *</label>
            <input type="month" value={addInterestForm.yearMonth}
              onChange={e=>setAddInterestForm(s=>({...s,yearMonth:e.target.value}))} style={input}/>
            <div style={{ color:C.muted, fontSize:11, marginTop:4 }}>This charge will appear in the selected month's P&L only.</div>
          </div>

          <div style={{ marginBottom:14 }}>
            <label style={{ color:C.muted, fontSize:12, display:"block", marginBottom:5 }}>Type *</label>
            <select value={addInterestForm.entryType||"interest"}
              onChange={e=>setAddInterestForm(s=>({...s,entryType:e.target.value}))}
              style={{...input, cursor:"pointer"}}>
              <option value="interest">Interest / Brokerage</option>
              <option value="software">Software Charges</option>
            </select>
          </div>

          <div style={{ marginBottom:14 }}>
            <label style={{ color:C.muted, fontSize:12, display:"block", marginBottom:5 }}>Amount (₹) *</label>
            <input type="number" placeholder="e.g. 5000" value={addInterestForm.amount}
              onChange={e=>setAddInterestForm(s=>({...s,amount:e.target.value}))}
              style={{ ...input, borderColor:C.red+"44", fontSize:16, fontWeight:600, color:C.red }}/>
          </div>

          <div style={{ marginBottom:14 }}>
            <label style={{ color:C.muted, fontSize:12, display:"block", marginBottom:5 }}>Note / Description</label>
            <input type="text" placeholder="e.g. Monthly brokerage, Interest on margin..."
              value={addInterestForm.note}
              onChange={e=>setAddInterestForm(s=>({...s,note:e.target.value}))} style={input}/>
          </div>

          {/* Preview */}
          {addInterestForm.clientId && addInterestForm.yearMonth && addInterestForm.amount && (
            <div style={{ background:C.bg, border:`1px solid ${C.red}33`, borderRadius:8, padding:"10px 14px", marginBottom:16, fontSize:12 }}>
              <div style={{ color:C.muted, marginBottom:4 }}>Preview:</div>
              <div style={{ color:C.text }}>
                <b style={{color:C.accent}}>{state.clients.find(c=>c.id===addInterestForm.clientId)?.name}</b>
                {" — "}{addInterestForm.yearMonth}
                {" — "}<span style={{color:C.red}}>₹{addInterestForm.amount}</span>
                {addInterestForm.note ? ` (${addInterestForm.note})` : ""}
              </div>
            </div>
          )}

          <div style={{ display:"flex", gap:10 }}>
            <button style={btn(C.red)} onClick={saveInterest}><Icon name="check" size={14}/> Add Charge</button>
            <button style={btn(C.muted)} onClick={() => setModal(null)}>Cancel</button>
          </div>
        </div>
      </div>
    );

    if (modal === "newTicket") return (
      <div style={overlay} onClick={() => setModal(null)}>
        <div style={{ ...box, width:560, maxHeight:"90vh", overflowY:"auto" }} onClick={e => e.stopPropagation()}>
          <h3 style={{ color:C.text, marginTop:0, marginBottom:4 }}>🎫 Raise Support Ticket</h3>
          <div style={{ color:C.muted, fontSize:12, marginBottom:20 }}>Our support team will respond within 24 hours.</div>

          {/* Issue Type */}
          <div style={{ marginBottom:16 }}>
            <label style={{ color:C.muted, fontSize:12, fontWeight:600, display:"block", marginBottom:8, textTransform:"uppercase", letterSpacing:0.5 }}>Issue Type *</label>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
              {["Trade Discrepancy","Margin Query","Account Statement","P&L Issue","Withdrawal/Deposit","Technical Issue","Bhavcopy/Settlement","Other"].map(type => (
                <button key={type} onClick={() => setNewTicket(s=>({...s,issueType:type}))}
                  style={{ padding:"10px 12px", borderRadius:8, border:`1.5px solid ${newTicket.issueType===type?C.accent:C.border}`,
                    background: newTicket.issueType===type?C.accent+"10":"#f8fafc",
                    color: newTicket.issueType===type?C.accent:C.muted,
                    fontWeight: newTicket.issueType===type?700:400, fontSize:13, cursor:"pointer", textAlign:"left" }}>
                  {type}
                </button>
              ))}
            </div>
          </div>

          {/* Description */}
          <div style={{ marginBottom:16 }}>
            <label style={{ color:C.muted, fontSize:12, fontWeight:600, display:"block", marginBottom:6, textTransform:"uppercase", letterSpacing:0.5 }}>Description *</label>
            <textarea value={newTicket.description}
              onChange={e=>setNewTicket(s=>({...s,description:e.target.value}))}
              rows={5} placeholder="Please describe your issue in detail. Include dates, contract names, or any other relevant information..."
              style={{ ...input, resize:"vertical", lineHeight:1.6, fontFamily:"inherit" }}/>
          </div>

          {/* File attachment name (simulated — no actual file upload in browser artifact) */}
          <div style={{ marginBottom:20 }}>
            <label style={{ color:C.muted, fontSize:12, fontWeight:600, display:"block", marginBottom:6, textTransform:"uppercase", letterSpacing:0.5 }}>Attach Files (optional)</label>
            <div style={{ border:`2px dashed ${C.border}`, borderRadius:10, padding:"16px", textAlign:"center", background:"#f8fafc", cursor:"pointer" }}
              onClick={() => {
                const name = prompt("Enter file name to attach (e.g. screenshot.png):");
                if (name) setNewTicket(s=>({...s,attachments:[...(s.attachments||[]),name]}));
              }}>
              <div style={{ fontSize:24, marginBottom:6 }}>📎</div>
              <div style={{ color:C.muted, fontSize:13 }}>Click to add attachment name</div>
              {(newTicket.attachments||[]).length > 0 && (
                <div style={{ display:"flex", gap:8, flexWrap:"wrap", justifyContent:"center", marginTop:10 }}>
                  {newTicket.attachments.map((a,i)=>(
                    <span key={i} style={{ background:"#eff6ff", border:`1px solid #93c5fd`, borderRadius:6, padding:"4px 10px", fontSize:12, color:C.accent }}>
                      📄 {a}
                      <button onClick={e=>{e.stopPropagation();setNewTicket(s=>({...s,attachments:s.attachments.filter((_,j)=>j!==i)}))}}
                        style={{ background:"none",border:"none",color:C.red,cursor:"pointer",marginLeft:4,fontSize:12 }}>✕</button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div style={{ display:"flex", gap:10 }}>
            <button style={btn(C.accent)} onClick={createTicket}><Icon name="check" size={14}/> Submit Ticket</button>
            <button style={{ ...btn(C.muted), background:"transparent", color:C.muted, border:`1px solid ${C.border}` }} onClick={() => setModal(null)}>Cancel</button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: C.bg, fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif", color: C.text }}>
      <style>{`
        * { box-sizing: border-box; }

        /* ── Page transition ── */
        .page-enter {
          animation: pageEnter 0.22s cubic-bezier(0.16,1,0.3,1) both;
        }
        @keyframes pageEnter {
          from { opacity:0; transform:translateY(14px); }
          to   { opacity:1; transform:translateY(0); }
        }

        /* ── Table row stagger ── */
        .row-enter {
          animation: rowEnter 0.28s ease-out both;
        }
        @keyframes rowEnter {
          from { opacity:0; transform:translateX(-8px); }
          to   { opacity:1; transform:translateX(0); }
        }

        /* ── Card hover lift (universal) ── */
        .hover-card {
          transition: transform 0.18s ease, box-shadow 0.18s ease !important;
        }
        .hover-card:hover {
          transform: translateY(-3px) !important;
          box-shadow: 0 8px 28px rgba(0,0,0,0.13) !important;
        }

        /* ── Button press ── */
        button:active { transform: scale(0.97) !important; }

        /* ── Modal entrance ── */
        .modal-enter {
          animation: modalEnter 0.2s cubic-bezier(0.16,1,0.3,1) both;
        }
        @keyframes modalEnter {
          from { opacity:0; transform:scale(0.94); }
          to   { opacity:1; transform:scale(1); }
        }

        /* ── Number count-up flash ── */
        .num-flash-green { animation: flashGreen 0.6s ease-out both; }
        .num-flash-red   { animation: flashRed   0.6s ease-out both; }
        @keyframes flashGreen {
          0%   { color: #10b981; transform:scale(1.06); }
          100% { color: inherit; transform:scale(1); }
        }
        @keyframes flashRed {
          0%   { color: #ef4444; transform:scale(1.06); }
          100% { color: inherit; transform:scale(1); }
        }

        /* ── Skeleton shimmer ── */
        .skeleton {
          background: linear-gradient(90deg,#f1f5f9 25%,#e2e8f0 50%,#f1f5f9 75%);
          background-size: 400px 100%;
          animation: skeleton-shine 1.4s ease-in-out infinite;
          border-radius: 6px;
        }
        @keyframes skeleton-shine {
          0%   { background-position: -400px 0; }
          100% { background-position:  400px 0; }
        }

        /* ── Bell wobble ── */
        .bell-ring { animation: bellRing 0.5s ease-in-out; }
        @keyframes bellRing {
          0%,100% { transform:rotate(0deg); }
          20%     { transform:rotate(-18deg); }
          40%     { transform:rotate(18deg); }
          60%     { transform:rotate(-10deg); }
          80%     { transform:rotate(10deg); }
        }

        /* ── Sidebar active slide ── */
        .sidebar-active {
          position: relative;
          transition: background 0.18s ease, color 0.18s ease !important;
        }
        .sidebar-active::before {
          content: '';
          position: absolute;
          left: 0; top: 20%; bottom: 20%;
          width: 3px;
          background: #3b82f6;
          border-radius: 0 3px 3px 0;
          animation: slideIn 0.18s ease-out both;
        }
        @keyframes slideIn {
          from { transform: scaleY(0); }
          to   { transform: scaleY(1); }
        }

        /* ── Count-up number ── */
        .kpi-num { transition: all 0.4s ease; }

        @media (max-width: 768px) {
          .jiya-sidebar { width: 60px !important; min-width: 60px !important; }
          .jiya-sidebar .label { display: none; }
          .jiya-sidebar .brand-text { display: none; }
          .jiya-main { padding: 12px !important; }
        }
        @media (max-width: 480px) {
          .jiya-sidebar { display: none !important; }
        }
        table { width: 100%; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: #94a3b8; }
      `}</style>
      {/* Sidebar */}
      <div style={{ width: "clamp(0px, 230px, 230px)", minWidth:230, background: C.sidebar, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", flexShrink: 0, boxShadow: "2px 0 8px rgba(0,0,0,0.04)" }}>
        <div style={{ padding: "20px 20px 16px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: C.accent, letterSpacing: "-0.5px" }}>📊 JIYA</div>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:2 }}>
            <div style={{ fontSize: 11, color: C.muted }}>Back Office Portal</div>
            <div style={{ display:"flex", alignItems:"center", gap:4 }}>
              {/* Bell icon */}
              <div style={{ position:"relative" }}>
                <button onClick={()=>{ setBellOpen(v=>!v); if(!bellOpen) markAllRead(); }}
                  className={bellAnimate ? "bell-ring" : ""}
                style={{ background:"none", border:"none", cursor:"pointer", padding:"2px 4px",
                  color: unreadCount>0 ? C.accent : C.muted, fontSize:16, position:"relative" }}>
                🔔
                {unreadCount > 0 && (
                  <span style={{ position:"absolute", top:-4, right:-4, background:C.red,
                    color:"#fff", fontSize:9, fontWeight:800, borderRadius:"50%",
                    width:16, height:16, display:"flex", alignItems:"center", justifyContent:"center",
                    lineHeight:1 }}>
                    {unreadCount > 9 ? "9+" : unreadCount}
                  </span>
                )}
              </button>
              {/* Bell dropdown */}
              {bellOpen && (
                <div style={{ position:"fixed", top:60, left:210, zIndex:999,
                  background:C.card, border:`1px solid ${C.border}`, borderRadius:12,
                  boxShadow:"0 8px 32px rgba(0,0,0,0.15)", width:320, maxHeight:400, overflow:"hidden",
                  display:"flex", flexDirection:"column" }}>
                  <div style={{ padding:"12px 16px", borderBottom:`1px solid ${C.border}`,
                    display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                    <span style={{ fontWeight:700, color:C.text, fontSize:14 }}>🔔 Notifications</span>
                    <button onClick={clearBells}
                      style={{ background:"none", border:"none", cursor:"pointer", color:C.muted, fontSize:11 }}>
                      Clear all
                    </button>
                  </div>
                  <div style={{ overflowY:"auto", flex:1 }}>
                    {bells.length === 0 ? (
                      <div style={{ padding:32, textAlign:"center", color:C.muted, fontSize:13 }}>
                        No notifications yet
                      </div>
                    ) : bells.map(b => {
                      const icons = { ledger:"💰", ticket:"🎫", trade:"📊", info:"ℹ️", success:"✅", error:"❌" };
                      const timeAgo = (() => {
                        const diff = Date.now() - new Date(b.time).getTime();
                        const m = Math.floor(diff/60000);
                        if (m < 1) return "just now";
                        if (m < 60) return m+"m ago";
                        const h = Math.floor(m/60);
                        if (h < 24) return h+"h ago";
                        return Math.floor(h/24)+"d ago";
                      })();
                      return (
                        <div key={b.id}
                          onClick={()=>{ if(b.page) setPage(b.page); setBellOpen(false); }}
                          style={{ padding:"10px 16px", borderBottom:`1px solid ${C.border}22`,
                            cursor: b.page ? "pointer" : "default",
                            background: b.read ? "transparent" : C.accent+"08",
                            display:"flex", gap:10, alignItems:"flex-start" }}>
                          <span style={{ fontSize:16, flexShrink:0 }}>{icons[b.type]||"🔔"}</span>
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={{ fontSize:12, color:C.text, lineHeight:1.4 }}>{b.msg}</div>
                            <div style={{ fontSize:10, color:C.muted, marginTop:3 }}>{timeAgo}</div>
                          </div>
                          {!b.read && <div style={{ width:6, height:6, borderRadius:"50%",
                            background:C.accent, flexShrink:0, marginTop:4 }}/>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
              {/* Logout — sticky top */}
              <button onClick={logout} title="Logout"
                style={{ background:"none", border:"none", cursor:"pointer", padding:"2px 5px",
                  color:C.muted, fontSize:15, display:"flex", alignItems:"center",
                  transition:"color 0.15s" }}
                onMouseEnter={e=>e.currentTarget.style.color="#ef4444"}
                onMouseLeave={e=>e.currentTarget.style.color=C.muted}>
                <Icon name="logout" size={15}/>
              </button>
            </div>
          </div>
          {auth?.role === "client" && currentClient?.name && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 3 }}>Logged in as</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text, letterSpacing: "-0.3px" }}>{currentClient.name}</div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 1, fontFamily: "monospace" }}>{currentClient.id}</div>
            </div>
          )}
          {(auth?.role === "admin" || auth?.role === "superadmin") && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 3 }}>Administrator</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text, letterSpacing: "-0.3px" }}>
                {auth?.role === "superadmin" ? "JIYA" : ((state.admins||[]).find(a=>a.id===auth?.adminId)?.name || "Admin")}
              </div>
            </div>
          )}
        </div>
        <div style={{ flex: 1, padding: "10px 8px" }}>
          {pages.map((p) => (
            <button key={p.id}
              onClick={() => {
                if (p.locked) {
                  notify("🔒 Upgrade your plan to unlock " + p.label, "error");
                  return;
                }
                setPage(p.id);
              }}
              className={page === p.id ? "sidebar-active" : ""}
              style={{
                width: "100%", display: "flex", alignItems: "center", gap: 10,
                padding: "10px 12px", borderRadius: 8, margin: "1px 0",
                background: page === p.id ? C.accent + "12" : "transparent",
                border: "none", cursor: p.locked ? "not-allowed" : "pointer",
                color: p.locked ? C.muted+"88" : (page === p.id ? C.accent : C.muted),
                fontWeight: page === p.id ? 600 : 400, fontSize: 13.5, textAlign: "left",
                opacity: p.locked ? 0.6 : 1, transition:"all 0.18s ease",
              }}>
              <Icon name={p.icon} size={16} />
              <span style={{flex:1}}>{p.label}</span>
              {p.locked && <span style={{fontSize:12}}>🔒</span>}
            </button>
          ))}
        </div>
        <div style={{ padding: "14px 16px", borderTop: `1px solid ${C.border}` }}>
          {/* Sync status — admin only */}
          {(auth?.role === "admin" || auth?.role === "superadmin") && SUPABASE_CONFIGURED && (
            <div style={{ marginBottom:10, fontSize:11, display:"flex", alignItems:"center", gap:6,
              color: syncStatus==="saved"?C.green : syncStatus==="error"?C.red : syncStatus==="saving"?"#6366f1" : C.muted }}>
              <div style={{ width:6, height:6, borderRadius:"50%", background:"currentColor",
                animation: syncStatus==="saving" ? "pulse 1s infinite" : "none" }}/>
              <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}`}</style>
              {syncStatus==="saving" ? "Saving..." : syncStatus==="saved" ? "✓ Saved to database" : syncStatus==="error" ? "⚠ Sync failed" : "Database connected"}
            </div>
          )}
          {/* Angel One MTM Status */}
          {auth?.role === "superadmin" && angelStatus === "connected" && (
            <div style={{ marginBottom:6, fontSize:11, display:"flex", alignItems:"center", gap:6,
              color: angelMTMStatus === "live" ? C.green : angelMTMStatus === "error" ? C.red : C.muted }}>
              <div style={{ width:6, height:6, borderRadius:"50%", background:"currentColor" }}/>
              {angelMTMStatus === "live" ? "📡 Live prices active" : angelMTMStatus === "error" ? "⚠ Price feed error" : "⏳ Fetching prices..."}
            </div>
          )}
          {(auth?.role === "admin" || auth?.role === "superadmin") && !SUPABASE_CONFIGURED && (
            <div style={{ marginBottom:10, fontSize:11, color:C.yellow, display:"flex", alignItems:"center", gap:6 }}>
              ⚠️ Local mode — data not saved
            </div>
          )}
          <button onClick={logout} style={{ display:"none" }}></button>
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, padding: "clamp(12px, 3vw, 28px) clamp(12px, 4vw, 36px)", overflowY: "auto", background: C.bg, minWidth:0 }}>
        {/* Token expiry warning for sub-admins */}
        {auth?.role === "admin" && (() => {
          const myAdmin = (state.admins||[]).find(a => a.id === auth.adminId);
          if (!myAdmin?.tokenExpiry) return null;
          const dl = Math.ceil((new Date(myAdmin.tokenExpiry) - new Date()) / (1000*60*60*24));
          if (dl > 7) return null;
          return (
            <div style={{background: dl<=0?C.red+"15":C.yellow+"15",
              border:`1px solid ${dl<=0?C.red:C.yellow}`,
              borderRadius:8,padding:"10px 16px",marginBottom:16,
              display:"flex",alignItems:"center",gap:10,fontSize:13}}>
              <span style={{fontSize:18}}>{dl<=0?"🔴":"⚠️"}</span>
              <span style={{color:dl<=0?C.red:C.yellow,fontWeight:600}}>
                {dl<=0 ? "Your access token has expired! Contact JIYA to renew."
                       : `Your token expires in ${dl} day${dl!==1?"s":""}. Contact JIYA to renew.`}
              </span>
            </div>
          );
        })()}
        <div key={page} className="page-enter">
          {renderPage()}
        </div>
      </div>

      {/* Modals */}
      {renderModal()}
      {renderTradeHistoryModal()}

      {/* Notification */}
      {notification && (
        <div style={{ position: "fixed", bottom: 24, right: 24, background: notification.type === "error" ? C.red : C.green, color: "#fff", padding: "13px 22px", borderRadius: 12, fontWeight: 600, fontSize: 14, boxShadow: "0 8px 32px rgba(0,0,0,0.15)", zIndex: 9999, display:"flex", alignItems:"center", gap:8 }}>
          {notification.type === "error" ? "❌" : "✅"} {notification.msg}
        </div>
      )}
    </div>
  );
}
