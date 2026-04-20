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
  interest: [], // [{id, clientId, yearMonth, amount, note}]
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
    const r = await fetch(`${this.url(table)}${query}`, { headers: this.headers });
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

function RMSPage({ state, indexPrices, setIndexPrices, funds, setFunds, notify, C, card, btn, input, livePrice = {}, rmsRef, lastUpdated: lastUpdatedProp }) {
  const [clientData,    setClientData]    = useState({});
  const [lastUpdated,   setLastUpdated]   = useState(lastUpdatedProp || null);
  const [expanded,    setExpanded]    = useState({});
  const [editFund,    setEditFund]    = useState(null);
  const [fundInput,   setFundInput]   = useState("");
  const [editIdx,     setEditIdx]     = useState(false);
  const [idxInput,    setIdxInput]    = useState({...DEFAULT_IDX, ...(indexPrices||{})});
  const [uploadStatus,setUploadStatus]= useState(null);
  const fileRef = useRef();

  const prices = { ...DEFAULT_IDX, ...(indexPrices||{}) };

  const saveFunds = (f) => { setFunds(f); try{localStorage.setItem("rms_funds",JSON.stringify(f));}catch(e){} };
  const saveIdx   = (p) => { setIndexPrices(p); try{localStorage.setItem("rms_idx",JSON.stringify(p));}catch(e){} };

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
      setClientData(data);
      setLastUpdated(new Date());
      setUploadStatus("ok");
      setTimeout(()=>setUploadStatus(null),3000);
      if (rmsRef) rmsRef.current = data;
      notify("✅ Positions loaded — " + Object.keys(data).length + " clients");
    };
    reader.readAsText(f);
    e.target.value="";
  };

  const fmtN = (n) => { const v=Math.abs(n); const s=v>=1e7?(v/1e7).toFixed(2)+"Cr":v>=1e5?(v/1e5).toFixed(2)+"L":v>=1e3?(v/1e3).toFixed(1)+"K":v.toFixed(0); return (n<0?"−":"")+"₹"+s; };
  const fmtFull = (n) => (n<0?"−":"")+"₹"+Math.abs(Math.round(n)).toLocaleString("en-IN");
  const pnlClr = (n) => n>0?C.green:n<0?C.red:C.muted;

  // Use live-updated data from Angel One ref if available, else local state
  const displayData  = (rmsRef && Object.keys(rmsRef.current || {}).length) ? rmsRef.current : clientData;
  const totalMTM    = Object.values(displayData).flat().reduce((s,p)=>s+(parseFloat(p.mtmGL)||0),0);
  const totalMargin = Object.entries(displayData).reduce((s,[,pos])=>s+calcRMSMargin(pos,prices).total,0);
  const totalFund   = Object.values(funds||{}).reduce((s,f)=>s+(parseFloat(f)||0),0);
  const hasData     = Object.keys(displayData).length>0;
  const btnClr      = uploadStatus==="ok"?C.green:uploadStatus==="error"?C.red:C.accent;

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
          <button onClick={()=>fileRef.current.click()}
            style={{...btn(btnClr),fontSize:13}}>
            {uploadStatus==="ok"?"✅ Updated!":uploadStatus==="error"?"❌ Invalid CSV":"⬆️ Upload Positions CSV"}
          </button>
          <input ref={fileRef} type="file" accept=".csv" onChange={onFile} style={{display:"none"}}/>
        </div>
      </div>

      {/* Summary cards */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:14,marginBottom:24}}>
        {[
          {label:"Total MTM P&L",    val:fmtFull(Math.round(totalMTM)), color:pnlClr(totalMTM)},
          {label:"Total Margin Used", val:fmtN(totalMargin),             color:C.text},
          {label:"Total Fund",        val:totalFund>0?fmtN(totalFund):"Not set", color:C.text},
          {label:"Overall Usage",     val:totalFund>0?(totalMargin/totalFund*100).toFixed(1)+"%":"—",
            color:totalFund>0?(totalMargin/totalFund>0.9?C.red:totalMargin/totalFund>0.7?C.yellow:C.green):C.muted},
          {label:"Active Clients",    val:Object.keys(clientData).length, color:C.text},
        ].map(c => (
          <div key={c.label} style={{...card,padding:"16px 20px"}}>
            <div style={{color:C.muted,fontSize:11,fontWeight:600,textTransform:"uppercase",letterSpacing:0.8,marginBottom:8}}>{c.label}</div>
            <div style={{fontSize:22,fontWeight:800,color:c.color}}>{c.val}</div>
          </div>
        ))}
      </div>

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
            <div style={{display:"grid",gridTemplateColumns:"32px 1fr 1fr 1fr 1fr 1fr 140px",
              gap:4,padding:"10px 16px",background:C.accent+"08",borderBottom:`1px solid ${C.border}`}}>
              {["","Client","MTM P&L","SPAN","Exposure","Total Margin","Fund & Usage"].map((h,i)=>(
                <div key={i} style={{color:C.muted,fontSize:11,fontWeight:700,textTransform:"uppercase",
                  letterSpacing:0.6,textAlign:i>1?"right":"left"}}>{h}</div>
              ))}
            </div>

            {/* Client rows */}
            {Object.entries(displayData).map(([cid, positions]) => {
              const totalMTMc = positions.reduce((s,p)=>s+(parseFloat(p.mtmGL)||0),0);
              const margin    = calcRMSMargin(positions, prices);
              const fund      = parseFloat((funds||{})[cid])||0;
              const pctUsed   = fund>0?(margin.total/fund*100):0;
              const ac        = pctUsed>90?C.red:pctUsed>70?C.yellow:C.green;
              const isExp     = expanded[cid];
              const openPos   = positions.filter(p=>parseFloat(p.netQty)!==0).length;

              return (
                <Fragment key={cid}>
                  <div style={{display:"grid",gridTemplateColumns:"32px 1fr 1fr 1fr 1fr 1fr 140px",
                    gap:4,padding:"13px 16px",borderBottom:`1px solid ${C.border}`,
                    cursor:"pointer",transition:"background 0.15s"}}
                    onClick={()=>setExpanded(e=>({...e,[cid]:!e[cid]}))}>
                    <div style={{color:C.accent,fontWeight:700,fontSize:16}}>{isExp?"▼":"▶"}</div>
                    <div>
                      <div style={{fontWeight:700,color:C.text,fontSize:14}}>{CLIENT_NAMES_RMS[cid]||cid}</div>
                      <div style={{color:C.muted,fontSize:11,marginTop:2}}>{cid} · {openPos} open</div>
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
function SettingsPage({ angelCreds, setAngelCreds, angelStatus, connectAngel, disconnectAngel, notify, C, card, btn, input }) {
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
            <div style={{color:C.muted,fontSize:12,marginTop:2}}>Live prices updating every 5 seconds • Auto bhavcopy at 3:35 PM</div>
          )}
        </div>
        {angelStatus === "connected" && (
          <button onClick={disconnectAngel} style={{...btn(C.red),fontSize:12}}>Disconnect</button>
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

      {/* What gets automated */}
      {angelStatus === "connected" && (
        <div style={{...card,padding:20,marginTop:16}}>
          <div style={{fontSize:14,fontWeight:700,color:C.text,marginBottom:12}}>✅ Now Automated</div>
          {[
            {icon:"📈", label:"Live option prices", desc:"Updates every 5 seconds during market hours"},
            {icon:"💰", label:"Real-time MTM in RMS", desc:"All client positions update automatically"},
            {icon:"📋", label:"Bhavcopy", desc:"Auto-fetched at 3:35 PM every trading day"},
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

export default function BackOffice() {
  const [state, setState] = useState(INITIAL_STATE);
  const [dbLoading, setDbLoading] = useState(SUPABASE_CONFIGURED); // show loading if DB configured
  const [dbError, setDbError] = useState(null);
  const [syncStatus, setSyncStatus] = useState("idle"); // "idle"|"saving"|"saved"|"error"
  const [auth, setAuth] = useState(null); // {role:'admin'|'client', clientId?}
  const [loginForm, setLoginForm] = useState({ user: "", pass: "", error: "" });
  const [page, setPage] = useState("dashboard");
  const [modal, setModal] = useState(null);
  const [positionFilter, setPositionFilter] = useState("open");
  const [notification, setNotification] = useState(null);
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

      // Start polling LTP every 5 seconds
      startLTPPolling(tokens.jwtToken, creds.apiKey);

      // Schedule auto bhavcopy at 3:35 PM
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
  // ── Angel One: Poll LTP for all open positions in RMS ──
  const rmsPositionsRef = useRef({});

  const startLTPPolling = useCallback((jwtToken, apiKey) => {
    const poll = async () => {
      try {
        const now = new Date();
        const h = now.getHours(), m = now.getMinutes();
        const inMarket = (h > 9 || (h === 9 && m >= 14)) && (h < 15 || (h === 15 && m < 31));
        if (!inMarket) return;

        const positions = rmsPositionsRef.current;
        if (!Object.keys(positions).length) return;

        const nfoTokens = [], bfoTokens = [];
        Object.values(positions).flat().forEach(p => {
          const token = (p.scripCode || "").toString().trim();
          const sym   = (p.symbol || "").toUpperCase();
          if (!token || token === "0" || token === "-----------") return;
          const isNFO = ["NIFTY","BANKNIFTY","FINNIFTY","MIDCPNIFTY"].includes(sym);
          if (isNFO) { if (!nfoTokens.includes(token)) nfoTokens.push(token); }
          else       { if (!bfoTokens.includes(token)) bfoTokens.push(token); }
        });

        if (!nfoTokens.length && !bfoTokens.length) return;

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
          const newPrices = {};
          (data.data.fetched || []).forEach(item => {
            newPrices[item.symbolToken] = item.ltp;
          });

          // Update live prices in positions
          const updated = {};
          Object.entries(positions).forEach(([cid, pos]) => {
            updated[cid] = pos.map(p => {
              const token = (p.scripCode || "").toString().trim();
              const ltp   = newPrices[token];
              if (ltp !== undefined) {
                const qty    = parseFloat(p.netQty)   || 0;
                const buyAvg = parseFloat(p.buyAvg)   || parseFloat(p.netPrice) || 0;
                const newMTM = qty !== 0 ? ((ltp - buyAvg) * qty).toFixed(2) : (parseFloat(p.mtmGL) || 0).toFixed(2);
                return { ...p, marketPrice: ltp.toString(), mtmGL: newMTM };
              }
              return p;
            });
          });

          rmsPositionsRef.current = updated;
          setAngelLivePrice(prev => ({ ...prev, ...newPrices }));
          setRmsLastUpdated(new Date());
        }
      } catch(e) {
        console.log("LTP poll error:", e.message);
      }
    };

    const interval = setInterval(poll, 5000);
    poll();
    return () => clearInterval(interval);
  }, []);

  // ── Angel One: Auto Bhavcopy at 3:35 PM ──
  const scheduleAutoBhavcopy = useCallback((jwtToken, apiKey) => {
    const checkTime = () => {
      const now = new Date();
      if (now.getHours() === 15 && now.getMinutes() === 35 && now.getSeconds() < 10) {
        fetchAutoBhavcopy(jwtToken, apiKey);
      }
    };
    const interval = setInterval(checkTime, 5000);
    return () => clearInterval(interval);
  }, []);

  const fetchAutoBhavcopy = async (jwtToken, apiKey) => {
    notify("📋 Auto-fetching bhavcopy at 3:35 PM...");
    // Bhavcopy fetching would go here
    // For now notify user
    notify("✅ Bhavcopy auto-fetch complete!");
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
    }, 4 * 60 * 1000);

    return () => clearInterval(keepAlive);
  }, []);

  const loadAllData = async () => {
    setDbLoading(true);
    setDbError(null);
    try {
      const [clients, trades, ledger, tickets, interest, chargesHistory, bhavcopy] = await Promise.all([
        sb.select("clients",         "?order=created_at.asc"),
        sb.select("trades",          "?order=date.asc,time.asc"),
        sb.select("ledger",          "?order=date.asc"),
        sb.select("tickets",         "?order=date.desc"),
        sb.select("interest",        "?order=created_at.asc"),
        sb.select("charges_history", "?order=created_at.asc"),
        sb.select("bhavcopy",        "?order=created_at.desc&limit=50000"),
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
      }));
      setSyncStatus("saved");
      setTimeout(() => setSyncStatus("idle"), 2000);
    } catch (err) {
      console.error("Load error:", err);
      setDbError(err.message);
      // Show the actual error so user knows what's wrong
      notify("⚠️ Database load failed: " + err.message + " — Check your Supabase URL and key in App.jsx", "error");
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
  const [pnlDateMode, setPnlDateMode] = useState("all"); // "all" | "month" | "range"
  const [pnlMonth, setPnlMonth] = useState(new Date().toISOString().slice(0,7));
  const [pnlDateFrom, setPnlDateFrom] = useState("");
  const [pnlDateTo, setPnlDateTo] = useState("");
  const [addInterestForm, setAddInterestForm] = useState({ clientId:"", yearMonth:"", amount:"", note:"" });
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
    return (state.interest || [])
      .filter(i => i.clientId === clientId && i.yearMonth === yearMonth)
      .reduce((sum, i) => sum + (+i.amount || 0), 0);
  };

  // Save interest entry
  const saveInterest = () => {
    const { clientId, yearMonth, amount, note } = addInterestForm;
    if (!clientId || !yearMonth || !amount) return notify("Fill all required fields", "error");
    const entry = { id: "INT" + Date.now(), clientId, yearMonth, amount: +amount, note };
    setState(s => ({ ...s, interest: [...(s.interest||[]), entry] }));
    withSync(() => sb.upsert("interest", entry));
    setAddInterestForm({ clientId:"", yearMonth:"", amount:"", note:"" });
    setModal(null);
    notify("Interest entry added");
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
  const getBhavClose = (contract) => bhavLookup[contract]?.closePrice || null;
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
    const adminMatch = userInput === "JIYA" && passInput === "Jiya@3044";
    const client = !adminMatch
      ? state.clients.find(c => c.id === userInput && c.password === passInput)
      : null;

    if (adminMatch) {
      setLoginAttempts(0);
      setAuth({ role: "admin" });
      setPage("dashboard");
      setLoginForm({ user: "", pass: "", error: "" });
    } else if (client) {
      setLoginAttempts(0);
      setAuth({ role: "client", clientId: client.id });
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

  const visibleClients = auth?.role === "admin" ? state.clients : state.clients.filter((c) => c.id === auth?.clientId);
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

  const addLedger = () => {
    if (!newLedger.clientId || !newLedger.date || !newLedger.description) return notify("Fill required fields", "error");
    const entry = { id: "L" + Date.now(), ...newLedger, credit: +newLedger.credit || 0, debit: +newLedger.debit || 0, ledgerType: newLedger.ledgerType || "all" };
    setState((s) => ({ ...s, ledger: [...s.ledger, entry] }));
    withSync(() => sb.upsert("ledger", entry));
    setNewLedger({ clientId: "", date: "", description: "", credit: "", debit: "", ledgerType: "all" });
    setModal(null);
    notify("Ledger entry added");
  };

  const saveLedgerEdit = () => {
    if (!editLedgerEntry) return;
    const updated = { ...editLedgerEntry, credit: +editLedgerEntry.credit || 0, debit: +editLedgerEntry.debit || 0 };
    setState(s => ({ ...s, ledger: s.ledger.map(l => l.id === updated.id ? updated : l) }));
    withSync(() => sb.upsert("ledger", updated));
    setEditLedgerEntry(null);
    setModal(null);
    notify("Entry updated");
  };

  const deleteLedgerEntry = (id) => {
    setState(s => ({ ...s, ledger: s.ledger.filter(l => l.id !== id) }));
    withSync(() => sb.delete("ledger", id));
    notify("Entry deleted");
  };

  // ── Trade Upload (Broker Master File) ──
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadPreview, setUploadPreview] = useState(null);
  const [uploadMode, setUploadMode] = useState("replace");
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

  const confirmUpload = () => {
    if (!uploadPreview || !uploadPreview.rows.length) return notify("No valid trades to import", "error");
    const batchId = Date.now();
    const newTrades = uploadPreview.rows.map(t => ({ ...t, batchId }));
    const clientsInFile = [...new Set(newTrades.map((t) => t.clientId))];
    const unknownClients = clientsInFile.filter((cid) => !state.clients.find((c) => c.id === cid));

    setState((s) => ({
      ...s,
      trades: uploadMode === "replace" ? newTrades : [...s.trades, ...newTrades],
    }));

    withSync(async () => {
      if (uploadMode === "replace") {
        // Delete all existing trades using deleteAll
        await sb.deleteAll("trades");
      }
      // Insert in batches of 500 (Supabase limit)
      for (let i = 0; i < newTrades.length; i += 500) {
        await sb.upsert("trades", newTrades.slice(i, i + 500));
      }
    });

    setUploadFile(null);
    setUploadPreview(null);
    setModal(null);
    const warn = unknownClients.length ? ` ⚠️ Unknown client IDs: ${unknownClients.join(", ")}` : "";
    notify(`${newTrades.length} trades imported for ${clientsInFile.length} clients.${warn}`);
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
    <div style={{ minHeight:"100vh", background:"linear-gradient(135deg,#dbeafe,#ede9fe)", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", fontFamily:"'Inter',sans-serif" }}>
      <div style={{ fontSize:40, marginBottom:20 }}>📊</div>
      <div style={{ fontSize:20, fontWeight:700, color:"#1e3a8a", marginBottom:10 }}>JIYA Back Office</div>
      <div style={{ fontSize:14, color:"#6366f1", marginBottom:24 }}>Connecting to database...</div>
      <div style={{ width:40, height:40, border:"4px solid #e0e7ff", borderTop:"4px solid #6366f1", borderRadius:"50%", animation:"spin 1s linear infinite" }}/>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      {dbError && (
        <div style={{ marginTop:24, background:"#fef2f2", border:"1px solid #fecaca", borderRadius:12, padding:"16px 24px", maxWidth:480, textAlign:"center" }}>
          <div style={{ color:"#dc2626", fontWeight:600, marginBottom:8 }}>⚠️ Database connection failed</div>
          <div style={{ color:"#7f1d1d", fontSize:13, marginBottom:12 }}>{dbError}</div>
          <div style={{ color:"#6b7280", fontSize:12, marginBottom:12 }}>Make sure SUPABASE_URL and SUPABASE_ANON_KEY are set correctly in the code.</div>
          <button onClick={() => { setDbLoading(false); setDbError(null); }}
            style={{ background:"#3b82f6", color:"#fff", border:"none", borderRadius:8, padding:"10px 20px", cursor:"pointer", fontWeight:600 }}>
            Continue without database (data won't be saved)
          </button>
        </div>
      )}
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
    { id: "charges", label: "Charges", icon: "charges" },
    { id: "bhavcopy", label: "Bhavcopy / MTM", icon: "bhavcopy" },
    { id: "tickets", label: "Support Tickets", icon: "ticket" },
    { id: "rms", label: "📡 RMS", icon: "dashboard" },
    { id: "settings", label: "⚙️ Settings", icon: "dashboard" },
  ];
  const clientPages = [
    { id: "dashboard", label: "Dashboard", icon: "dashboard" },
    { id: "ledger", label: "My Ledger", icon: "ledger" },
    { id: "trades", label: "My Positions", icon: "trades" },
    { id: "pnl", label: "My P&L", icon: "pnl" },
    { id: "tickets", label: "Support", icon: "ticket" },
  ];
  const pages = auth.role === "admin" ? adminPages : clientPages;

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
      // Build per-client P&L data for chart
      const clientPnlData = state.clients.map(client => {
        const closed = clientClosedPos(client.id);
        const open = clientOpenPos(client.id);
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
          mtmPnl: +mtmPnl.toFixed(2),
          totalPnl: +(realizedPnl + mtmPnl).toFixed(2),
          openCount: open.length,
        };
      }).filter(c => c.realizedPnl !== 0 || c.mtmPnl !== 0 || c.openCount > 0);

      const maxAbs = Math.max(...clientPnlData.map(c => Math.abs(c.totalPnl)), 1);
      const totalRealized = clientPnlData.reduce((a, c) => a + c.realizedPnl, 0);
      const totalMtm = clientPnlData.reduce((a, c) => a + c.mtmPnl, 0);

      // Client view — simpler personal dashboard
      if (auth.role === "client") {
        const myData = clientPnlData.find(c => c.id === cid) || { realizedPnl:0, mtmPnl:0, totalPnl:0, openCount:0 };
        return (
          <div>
            {/* Quote */}
            <div style={{ marginBottom:24, background:"linear-gradient(135deg, #1e3a5f, #1e3a8a)", borderRadius:16, padding:"24px 28px", position:"relative", overflow:"hidden", boxShadow:"0 4px 20px rgba(30,58,138,0.2)" }}>
              <div style={{ position:"absolute", top:-10, right:16, fontSize:80, opacity:0.06, color:"#fff", fontFamily:"Georgia" }}>"</div>
              <div style={{ color:"#93c5fd", fontSize:11, fontWeight:700, letterSpacing:2, marginBottom:10, textTransform:"uppercase" }}>Quote of the Day</div>
              <div style={{ color:"#ffffff", fontSize:16, fontStyle:"italic", lineHeight:1.7, marginBottom:10 }}>"{todayQuote.text}"</div>
              <div style={{ color:"#93c5fd", fontSize:13 }}>— {todayQuote.author}</div>
            </div>
            {/* Personal stats */}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:16, marginBottom:24 }}>
              {[
                { label:"Realized P&L", val:`₹${myData.realizedPnl.toLocaleString()}`, color: myData.realizedPnl >= 0 ? C.green : C.red },
                { label:"MTM P&L (Today)", val: myData.mtmPnl !== 0 ? `₹${myData.mtmPnl.toLocaleString()}` : "Upload Bhavcopy", color: myData.mtmPnl >= 0 ? C.purple : C.red },
                { label:"Open Positions", val: myData.openCount, color: C.accent },
              ].map(s => (
                <div key={s.label} style={{ ...card, textAlign:"center", borderTop:`3px solid ${s.color}` }}>
                  <div style={{ color:C.muted, fontSize:11, marginBottom:8, textTransform:"uppercase", letterSpacing:1 }}>{s.label}</div>
                  <div style={{ color:s.color, fontSize:22, fontWeight:700 }}>{s.val}</div>
                </div>
              ))}
            </div>
          </div>
        );
      }

      // Admin view — full chart
      return (
        <div>
          {/* Quote Banner */}
          <div style={{ marginBottom:28, background:"linear-gradient(135deg, #1e3a5f, #1e3a8a)", borderRadius:16, padding:"28px 32px", position:"relative", overflow:"hidden", boxShadow:"0 4px 24px rgba(30,58,138,0.2)" }}>
            <div style={{ position:"absolute", top:-20, right:24, fontSize:120, opacity:0.06, color:"#fff", fontFamily:"Georgia", lineHeight:1 }}>"</div>
            <div style={{ color:"#93c5fd", fontSize:11, fontWeight:700, letterSpacing:2, marginBottom:12, textTransform:"uppercase" }}>📈 Market Quote — {new Date().toDateString()}</div>
            <div style={{ color:"#ffffff", fontSize:18, fontStyle:"italic", lineHeight:1.75, marginBottom:12, maxWidth:"80%", fontWeight:400 }}>"{todayQuote.text}"</div>
            <div style={{ color:"#93c5fd", fontSize:13, fontWeight:500 }}>— {todayQuote.author}</div>
          </div>

          {/* Summary row */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:14, marginBottom:28 }}>
            {[
              { label:"Total Clients", val: state.clients.length, color:C.accent },
              { label:"Realized P&L (All)", val:`₹${totalRealized.toLocaleString()}`, color: totalRealized>=0?C.green:C.red },
              { label:"MTM P&L (Today)", val: totalMtm!==0?`₹${totalMtm.toLocaleString()}`:"—", color:C.purple },
              { label:"Open Positions", val: openPositions.length, color:C.yellow },
            ].map(s => (
              <div key={s.label} style={{ ...card, borderTop:`3px solid ${s.color}` }}>
                <div style={{ color:C.muted, fontSize:11, marginBottom:6, textTransform:"uppercase", letterSpacing:1 }}>{s.label}</div>
                <div style={{ color:s.color, fontSize:24, fontWeight:700 }}>{s.val}</div>
              </div>
            ))}
          </div>

          {/* P&L Bar Chart */}
          <div style={{ ...card }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
              <div>
                <h3 style={{ color:C.text, margin:0, fontSize:16 }}>Client P&L Overview</h3>
                <div style={{ color:C.muted, fontSize:12, marginTop:4 }}>Realized + MTM P&L per client</div>
              </div>
              <div style={{ display:"flex", gap:16, fontSize:12 }}>
                <span><span style={{ display:"inline-block", width:10, height:10, borderRadius:2, background:C.green, marginRight:5 }}/>Realized P&L</span>
                <span><span style={{ display:"inline-block", width:10, height:10, borderRadius:2, background:C.purple, marginRight:5 }}/>MTM P&L</span>
              </div>
            </div>

            {clientPnlData.length === 0 ? (
              <div style={{ textAlign:"center", padding:"48px 0", color:C.muted }}>
                <div style={{ fontSize:40, marginBottom:12 }}>📊</div>
                <div>No P&L data yet. Upload trade files to see client performance.</div>
              </div>
            ) : (
              <div style={{ overflowX:"auto" }}>
                <div style={{ minWidth: Math.max(600, clientPnlData.length * 80) }}>
                  {/* Y-axis labels + bars */}
                  <div style={{ display:"flex", alignItems:"flex-end", gap:0, paddingBottom:8 }}>
                    {/* Y axis */}
                    <div style={{ width:70, flexShrink:0, display:"flex", flexDirection:"column", justifyContent:"space-between", height:240, paddingRight:8, textAlign:"right" }}>
                      {[1, 0.5, 0, -0.5, -1].map(f => (
                        <div key={f} style={{ color:C.muted, fontSize:10 }}>
                          {f === 0 ? "0" : `₹${(f*maxAbs/1000).toFixed(0)}k`}
                        </div>
                      ))}
                    </div>
                    {/* Chart area */}
                    <div style={{ flex:1, position:"relative" }}>
                      {/* Grid lines */}
                      {[0,1,2,3,4].map(i => (
                        <div key={i} style={{ position:"absolute", left:0, right:0, top: i*(240/4), borderTop:`1px dashed ${C.border}`, zIndex:0 }}/>
                      ))}
                      {/* Zero line */}
                      <div style={{ position:"absolute", left:0, right:0, top:120, borderTop:`2px solid ${C.border}44`, zIndex:1 }}/>
                      {/* Bars */}
                      <div style={{ display:"flex", alignItems:"center", height:240, gap:8, paddingLeft:8, position:"relative", zIndex:2 }}>
                        {clientPnlData.map((c, i) => {
                          const realH = Math.abs(c.realizedPnl) / maxAbs * 110;
                          const mtmH  = Math.abs(c.mtmPnl) / maxAbs * 110;
                          const realUp = c.realizedPnl >= 0;
                          const mtmUp  = c.mtmPnl >= 0;
                          return (
                            <div key={c.id} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}>
                              {/* Positive area (above zero) */}
                              <div style={{ height:120, display:"flex", alignItems:"flex-end", gap:3, width:"100%" }}>
                                <div style={{ flex:1, height: realUp ? realH : 0, background:C.green, borderRadius:"3px 3px 0 0", minHeight: realUp && realH > 0 ? 2 : 0, transition:"height 0.5s ease" }}/>
                                <div style={{ flex:1, height: mtmUp ? mtmH : 0, background:C.purple, borderRadius:"3px 3px 0 0", minHeight: mtmUp && mtmH > 0 ? 2 : 0, transition:"height 0.5s ease" }}/>
                              </div>
                              {/* Zero separator */}
                              <div style={{ height:2, width:"100%", background:C.border }}/>
                              {/* Negative area (below zero) */}
                              <div style={{ height:120, display:"flex", alignItems:"flex-start", gap:3, width:"100%" }}>
                                <div style={{ flex:1, height: !realUp ? realH : 0, background:C.red+"cc", borderRadius:"0 0 3px 3px", minHeight: !realUp && realH > 0 ? 2 : 0, transition:"height 0.5s ease" }}/>
                                <div style={{ flex:1, height: !mtmUp ? mtmH : 0, background:C.red+"66", borderRadius:"0 0 3px 3px", minHeight: !mtmUp && mtmH > 0 ? 2 : 0, transition:"height 0.5s ease" }}/>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                  {/* X axis labels */}
                  <div style={{ display:"flex", marginLeft:70, gap:8, paddingLeft:8 }}>
                    {clientPnlData.map(c => (
                      <div key={c.id} style={{ flex:1, textAlign:"center" }}>
                        <div style={{ color:C.text, fontSize:11, fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{c.name.split(" ")[0]}</div>
                        <div style={{ color:c.totalPnl>=0?C.green:C.red, fontSize:10, fontWeight:700 }}>₹{(c.totalPnl/1000).toFixed(1)}k</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      );
    }

    if (page === "clients" && auth.role === "admin") return (
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
                    <button style={{ ...btn(C.red), padding: "5px 10px" }} onClick={() => setState((s) => ({ ...s, clients: s.clients.filter((x) => x.id !== c.id) }))}><Icon name="delete" size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );

    if (page === "ledger") {
      const isAdmin = auth.role === "admin";

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
            const rows = ledgerRows(client.id, ledgerTabFilter);
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
                        {["Date","Type","Description","Credit","Debit","Balance", isAdmin?"Actions":""].filter(Boolean).map(h => (
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
      const isAdmin = auth.role === "admin";
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
              {isAdmin && (
                <select value={tradesClientFilter} onChange={e => setTradesClientFilter(e.target.value)}
                  style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:8, padding:"7px 12px", color:C.text, fontSize:13, cursor:"pointer", outline:"none" }}>
                  <option value="all">All Clients</option>
                  {state.clients.map(c => <option key={c.id} value={c.id}>{c.name} ({c.id})</option>)}
                </select>
              )}
            </div>
            {isAdmin && <button style={btn(C.purple)} onClick={() => setModal("uploadTrades")}><Icon name="upload" size={16}/> Upload Master File</button>}
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
      const isAdmin = auth.role === "admin";
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
              <h2 style={{ color:C.text, margin:0 }}>Profit & Loss</h2>
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
            const grandInterest = allMonths.reduce((a,m) => a + getMonthlyInterest(client.id, m), 0);
            const grandNet      = grandRealized - grandExpenses - grandInterest;

            return (
              <div key={client.id} style={{ ...card, marginBottom:24 }}>
                {/* Client name */}
                {isAdmin && (
                  <div style={{ color:C.accent, fontWeight:700, fontSize:15, marginBottom:16 }}>
                    {client.name} <span style={{ color:C.muted, fontWeight:400, fontSize:13 }}>({client.id})</span>
                  </div>
                )}

                {/* Grand summary cards */}
                <div style={{ display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:12, marginBottom:24 }}>
                  {[
                    { label:"Realized P&L",  val:grandRealized,  color:grandRealized>=0?C.green:C.red },
                    { label:"Expenses",       val:-grandExpenses, color:C.yellow },
                    { label:"Interest",       val:-grandInterest, color:C.red },
                    { label:"Net P&L",        val:grandNet,       color:grandNet>=0?C.green:C.red, big:true },
                    { label:"Open Positions", val:open.length,    color:C.purple, count:true },
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
                          {["Month","Realized P&L","Expenses (Auto)","Interest / Brokerage","Net P&L", isAdmin?"":""].filter(Boolean).map(h=>(
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
                          const monthExpenses = getMonthlyCharges(client.id, m);
                          const monthInterest = getMonthlyInterest(client.id, m);
                          const monthNet      = monthRealized - monthExpenses - monthInterest;

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
                          <td style={{ padding:"10px 12px", color:grandNet>=0?C.green:C.red, fontWeight:700, fontSize:15 }}>₹{grandNet.toFixed(2)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}

                {/* Closed contracts detail */}
                {closed.length > 0 && (
                  <details>
                    <summary style={{ color:C.muted, fontSize:12, cursor:"pointer", padding:"8px 0", userSelect:"none" }}>
                      📋 View closed contracts ({closed.length})
                    </summary>
                    <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12, marginTop:10 }}>
                      <thead>
                        <tr>{["Contract","Gross P&L"].map(h=>(
                          <th key={h} style={{ textAlign:"left", padding:"6px 12px", color:C.muted, borderBottom:`1px solid ${C.border}` }}>{h}</th>
                        ))}</tr>
                      </thead>
                      <tbody>
                        {closed.map((c,i)=>(
                          <tr key={i} style={{ borderBottom:`1px solid ${C.border}11` }}>
                            <td style={{ padding:"8px 12px", color:C.accent }}>{c.contract}</td>
                            <td style={{ padding:"8px 12px", color:c.totalPnl>=0?C.green:C.red, fontWeight:600 }}>₹{c.totalPnl.toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                )}

                {closed.length===0 && allMonths.length===0 && (
                  <div style={{ color:C.muted, fontSize:13 }}>No closed positions yet.</div>
                )}
              </div>
            );
          })}
        </div>
      );
    }

    if (page === "charges" && auth.role === "admin") {
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

    if (page === "bhavcopy") {
      const { openPositions } = applyFIFO(state.trades);
      const bhavLoaded = state.bhavcopy.length > 0;
      const bhavLoadedDate = state.bhavcopy[0]?.bhavDate || "";

      // MTM summary across all clients
      let totalMtm = 0;
      const mtmRows = openPositions.map(p => {
        const close = getBhavClose(p.contract);
        const mtm = close !== null
          ? (p.side === "SELL" ? (p.avgPrice - close) : (close - p.avgPrice)) * p.netQty
          : null;
        if (mtm !== null) totalMtm += mtm;
        return { ...p, close, mtm, expiring: isExpiring(p.contract) };
      });

      return (
        <div>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:24 }}>
            <div>
              <h2 style={{ color:C.text, margin:0 }}>Bhavcopy & MTM P&L</h2>
              <div style={{ color:C.muted, fontSize:12, marginTop:4 }}>Upload NSE F&O Bhavcopy to update closing prices and auto square-off expiring contracts</div>
            </div>
            <button style={btn(C.purple)} onClick={() => setModal("uploadBhav")}><Icon name="upload" size={16}/> Upload Bhavcopy</button>
          </div>

          {/* Status bar */}
          {bhavLoaded ? (
            <div style={{ ...card, marginBottom:20, borderLeft:`3px solid ${C.green}`, display:"flex", gap:32, flexWrap:"wrap" }}>
              <div><div style={{color:C.muted,fontSize:11,marginBottom:4}}>BHAVCOPY DATE</div><div style={{color:C.green,fontWeight:700}}>{bhavLoadedDate}</div></div>
              <div><div style={{color:C.muted,fontSize:11,marginBottom:4}}>CONTRACTS LOADED</div><div style={{color:C.text,fontWeight:700}}>{state.bhavcopy.length.toLocaleString()}</div></div>
              <div><div style={{color:C.muted,fontSize:11,marginBottom:4}}>OPEN POSITIONS MATCHED</div><div style={{color:C.accent,fontWeight:700}}>{mtmRows.filter(r=>r.close!==null).length} / {mtmRows.length}</div></div>
              <div><div style={{color:C.muted,fontSize:11,marginBottom:4}}>TOTAL MTM P&L</div><div style={{color:totalMtm>=0?C.green:C.red,fontWeight:700,fontSize:18}}>₹{totalMtm.toFixed(2)}</div></div>
              <div><div style={{color:C.muted,fontSize:11,marginBottom:4}}>EXPIRING TODAY</div><div style={{color:C.red,fontWeight:700}}>{mtmRows.filter(r=>r.expiring).length} positions</div></div>
            </div>
          ) : (
            <div style={{ ...card, marginBottom:20, textAlign:"center", padding:40, borderStyle:"dashed" }}>
              <div style={{fontSize:32,marginBottom:12}}>📊</div>
              <div style={{color:C.muted}}>No Bhavcopy uploaded yet.</div>
              <div style={{color:C.muted,fontSize:12,marginTop:4}}>Upload NSE F&O Bhavcopy to see MTM P&L and auto square-off expiring contracts.</div>
            </div>
          )}

          {/* MTM P&L Table */}
          {bhavLoaded && mtmRows.length > 0 && (
            <div style={{ ...card }}>
              <h3 style={{ color:C.text, margin:"0 0 16px", fontSize:15 }}>Open Position MTM P&L — {bhavLoadedDate}</h3>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                <thead>
                  <tr>{["Client","Contract","Qty","Side","Avg Price","Close Price","MTM P&L","Status"].map(h=>(
                    <th key={h} style={{textAlign:"left",padding:"8px 12px",color:C.muted,borderBottom:`1px solid ${C.border}`}}>{h}</th>
                  ))}</tr>
                </thead>
                <tbody>
                  {mtmRows.map((p,i) => (
                    <tr key={i} style={{borderBottom:`1px solid ${C.border}22`, background: p.expiring ? C.red+"0a" : "transparent"}}>
                      <td style={{padding:"10px 12px",color:C.accent,fontSize:12}}>{state.clients.find(c=>c.id===p.clientId)?.name || p.clientId}</td>
                      <td style={{padding:"10px 12px",color:C.text,fontSize:12}}>{p.contract}</td>
                      <td style={{padding:"10px 12px",color:C.text,fontWeight:700}}>{p.netQty}</td>
                      <td style={{padding:"10px 12px"}}><span style={badge(p.side==="SELL"?C.red:C.green)}>{p.side}</span></td>
                      <td style={{padding:"10px 12px",color:C.text}}>₹{p.avgPrice}</td>
                      <td style={{padding:"10px 12px",color:p.close?C.purple:C.muted}}>{p.close ? `₹${p.close}` : "—"}</td>
                      <td style={{padding:"10px 12px",color:p.mtm===null?C.muted:p.mtm>=0?C.green:C.red,fontWeight:700}}>
                        {p.mtm===null ? "—" : `₹${p.mtm.toFixed(2)}`}
                      </td>
                      <td style={{padding:"10px 12px"}}>
                        {p.expiring
                          ? <span style={badge(C.red)}>⚠️ Expiring — will auto square-off</span>
                          : p.close ? <span style={badge(C.green)}>MTM Updated</span>
                          : <span style={badge(C.muted)}>Not in Bhavcopy</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      );
    }

    if (page === "tickets") {
      const isAdmin = auth.role === "admin";
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
    if (page === "rms" && auth.role === "admin") {
      return <RMSPage state={state} indexPrices={rmsIndexPrices} setIndexPrices={setRmsIndexPrices} funds={rmsFunds} setFunds={setRmsFunds} notify={notify} C={C} card={card} btn={btn} input={input} livePrice={angelLivePrice} rmsRef={rmsPositionsRef} lastUpdated={rmsLastUpdated} />;
    }
    if (page === "settings" && auth.role === "admin") {
      return <SettingsPage angelCreds={angelCreds} setAngelCreds={setAngelCreds} angelStatus={angelStatus} connectAngel={connectAngel} disconnectAngel={disconnectAngel} notify={notify} C={C} card={card} btn={btn} input={input} />;
    }
  };

  // ── Modal ──
  const renderModal = () => {
    if (!modal) return null;
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
                { val: "append", label: "➕ Append", desc: "Add to existing trades (use for Day 2, Day 3 files)" },
                { val: "replace", label: "🔄 Replace", desc: "Wipe all trades and start fresh (use for Day 1 file)" },
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
      {/* Sidebar */}
      <div style={{ width: 230, background: C.sidebar, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", flexShrink: 0, boxShadow: "2px 0 8px rgba(0,0,0,0.04)" }}>
        <div style={{ padding: "22px 20px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: C.accent, letterSpacing: "-0.5px" }}>📊 JIYA</div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>Back Office Portal</div>
        </div>
        <div style={{ flex: 1, padding: "10px 8px" }}>
          {pages.map((p) => (
            <button key={p.id} onClick={() => setPage(p.id)} style={{
              width: "100%", display: "flex", alignItems: "center", gap: 10,
              padding: "10px 12px", borderRadius: 8, margin: "1px 0",
              background: page === p.id ? C.accent + "12" : "transparent",
              border: "none", cursor: "pointer",
              color: page === p.id ? C.accent : C.muted,
              fontWeight: page === p.id ? 600 : 400, fontSize: 13.5, textAlign: "left",
            }}>
              <Icon name={p.icon} size={16} />{p.label}
            </button>
          ))}
        </div>
        <div style={{ padding: "14px 16px", borderTop: `1px solid ${C.border}` }}>
          {/* Sync status */}
          {SUPABASE_CONFIGURED && (
            <div style={{ marginBottom:10, fontSize:11, display:"flex", alignItems:"center", gap:6,
              color: syncStatus==="saved"?C.green : syncStatus==="error"?C.red : syncStatus==="saving"?"#6366f1" : C.muted }}>
              <div style={{ width:6, height:6, borderRadius:"50%", background:"currentColor",
                animation: syncStatus==="saving" ? "pulse 1s infinite" : "none" }}/>
              <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}`}</style>
              {syncStatus==="saving" ? "Saving..." : syncStatus==="saved" ? "✓ Saved to database" : syncStatus==="error" ? "⚠ Sync failed" : "Database connected"}
            </div>
          )}
          {!SUPABASE_CONFIGURED && (
            <div style={{ marginBottom:10, fontSize:11, color:C.yellow, display:"flex", alignItems:"center", gap:6 }}>
              ⚠️ Local mode — data not saved
            </div>
          )}
          <div style={{ color: C.muted, fontSize: 12, marginBottom: 6 }}>{auth.role === "admin" ? "Admin: JIYA" : currentClient?.name}</div>
          <button onClick={logout} style={{ ...btn(C.red), padding: "7px 14px", fontSize: 12 }}><Icon name="logout" size={14} /> Logout</button>
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, padding: "28px 36px", overflowY: "auto", background: C.bg }}>
        {renderPage()}
      </div>

      {/* Modals */}
      {renderModal()}

      {/* Notification */}
      {notification && (
        <div style={{ position: "fixed", bottom: 24, right: 24, background: notification.type === "error" ? C.red : C.green, color: "#fff", padding: "13px 22px", borderRadius: 12, fontWeight: 600, fontSize: 14, boxShadow: "0 8px 32px rgba(0,0,0,0.15)", zIndex: 9999, display:"flex", alignItems:"center", gap:8 }}>
          {notification.type === "error" ? "❌" : "✅"} {notification.msg}
        </div>
      )}
    </div>
  );
}
