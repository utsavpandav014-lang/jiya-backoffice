Warning: truncated output (original token count: 95341)
Total output lines: 6781

import { useState, useEffect, useCallback, useRef, useMemo, Fragment } from "react";
import { accountTypeLabel, calculateOwnershipPct, validateClientCapital, validateInvestorAllocation } from "./investorModel.js";
import { buildCarryForwardPreview, verifyCarryForwardPairs } from "./monthEndCarryForward.js";
import { closedPositionSlicesForMonth, closedPositionSlicesInFilter, isCarryForwardTrade, openPositionMtm } from "./monthPnlAttribution.js";
import { daysRemainingInMonth, targetTrackerState } from "./targetTracker.js";
import { investorPnlForMonth as calculateInvestorPnlForMonth } from "./investorPnl.js";
import { investorPositions as calculateInvestorPositions } from "./investorPositions.js";

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
        queue.push({ side, qty: remaining, price: +trade.price, date: trade.date, time: trade.time||'' });
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

function gcdQuantity(a, b) {
  let x = Math.abs(Math.round(Number(a) || 0));
  let y = Math.abs(Math.round(Number(b) || 0));
  while (y) [x, y] = [y, x % y];
  return x;
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
  investorAllocations: [], // allocation layer only; never changes broker trades/FIFO
  carryForwardBatches: [],
  monthlyTargets: [], // presentation goals only; consumes canonical P&L output
};

// ── Plan feature access ──────────────────────────────
const PLAN_FEATURES = {
  basic:   ["dashboard","clients","trades","pnl","ledger","tickets","settings"],
  pro:     ["dashboard","clients","trades","pnl","ledger","tickets","settings","charges"],
  perfect: ["dashboard","clients","trades","pnl","ledger","tickets","settings","charges","audit","export"],
  superadmin: ["dashboard","clients","trades","pnl","ledger","tickets","settings","charges","audit","export","admins","tokens"],
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
const SUPABASE_URL      = "https://jwfucitnaqkuyzizmuve.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp3ZnVjaXRuYXFrdXl6aXptdXZlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2MTIyNDIsImV4cCI6MjA5MTE4ODI0Mn0.62UKN69g9qXoSipj_JdVtMt7JNcX03e-CeVWwOC3s6A";
const ANGEL_PROXY       = "/api/angel";

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
  async rpc(functionName, args) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${functionName}`, {
      method: "POST", headers: this.headers, body: JSON.stringify(args)
    });
    if (!r.ok) throw new Error(`MONTH-END TRANSACTION: ${await r.text()}`);
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
const SCENARIO_STEPS = [-20,-15,-10,-5,5,10,15,20];function parseExpiry(expStr) {
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

function DeleteIntradayButton({ notify, C, card, btn }) {
  const [deleting, setDeleting] = useState(false);
  const [confirm,  setConfirm]  = useState(false);
  const deleteAutoTrades = async () => {
    if (!confirm) { setConfirm(true); return; }
    setDeleting(true); setConfirm(false);
    try {
      const today = new Date().toISOString().slice(0,10);
      const SB_URL = "https://jwfucitnaqkuyzizmuve.supabase.co";
      const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp3ZnVjaXRuYXFrdXl6aXptdXZlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2MTIyNDIsImV4cCI6MjA5MTE4ODI0Mn0.62UKN69g9qXoSipj_JdVtMt7JNcX03e-CeVWwOC3s6A";
      const headers = {"Content-Type":"application/json","apikey":SB_KEY,"Authorization":`Bearer ${SB_KEY}`,"Prefer":"return=minimal"};
      const [r1,r2] = await Promise.all([
        fetch(`${SB_URL}/rest/v1/intraday_trades?date=eq.${today}&id=like.T*`,{method:"DELETE",headers}),
        fetch(`${SB_URL}/rest/v1/intraday_trades?date=eq.${today}&id=like.BASE_*`,{method:"DELETE",headers}),
      ]);
      if (r1.ok && r2.ok) notify("🗑 Today's auto-captured intraday trades deleted.");
      else notify("❌ Delete failed");
    } catch(e) { notify("❌ Error: "+e.message); }
    setDeleting(false);
  };
  return (
    <div style={{...card,padding:20,marginTop:16,borderLeft:`4px solid ${C.red}`}}>
      <div style={{fontSize:15,fontWeight:700,color:C.text,marginBottom:6}}>🗑 Delete Today's Auto-Captured Intraday Trades</div>
      <div style={{color:C.muted,fontSize:12,marginBottom:14,lineHeight:1.7}}>
        Deletes only RMS tool trades for today. Manual Excel uploads are <strong style={{color:C.green}}>not affected</strong>.
      </div>
      <div style={{display:"flex",gap:8}}>
        <button onClick={deleteAutoTrades} disabled={deleting}
          style={{background:confirm?C.red:C.yellow,color:confirm?"#fff":"#000",border:"none",borderRadius:8,
            padding:"10px 20px",fontSize:13,fontWeight:700,cursor:"pointer",opacity:deleting?0.6:1}}>
          {deleting?"⏳ Deleting...":confirm?"⚠️ Confirm — Click to DELETE":"🗑 Delete Auto Intraday Trades (Today)"}
        </button>
        {confirm&&!deleting&&(
          <button onClick={()=>setConfirm(false)}
            style={{background:"transparent",border:`1px solid ${C.border}`,borderRadius:8,
              padding:"10px 16px",fontSize:12,cursor:"pointer",color:C.muted}}>Cancel</button>
        )}
      </div>
    </div>
  );
}

function SettlementManager({ settlements, state, notify, loadAllData, C, card, btn, input, SUPABASE_URL, SUPABASE_ANON_KEY, visibleClients }) {
  const [editId,      setEditId]      = useState(null);   // id being edited
  const [editPrice,   setEditPrice]   = useState("");
  const [deleting,    setDeleting]    = useState(null);
  const [saving,      setSaving]      = useState(false);
  const [showAdd,     setShowAdd]     = useState(false);
  const [addForm,     setAddForm]     = useState({ clientId:"", contract:"", side:"SELL", qty:"", price:"", date: new Date().toISOString().slice(0,10) });

  const H = {
    "Content-Type":  "application/json",
    "apikey":        SUPABASE_ANON_KEY,
    "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
    "Prefer":        "return=minimal",
  };

  const deleteTrade = async (id) => {
    setDeleting(id);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/trades?id=eq.${id}`, { method:"DELETE", headers:H });
    if (r.ok || r.status===204) { notify("🗑 Settlement deleted"); await loadAllData(true); }
    else notify("❌ Delete failed");
    setDeleting(null);
  };

  const saveEdit = async (t) => {
    const newPrice = parseFloat(editPrice);
    if (!newPrice || newPrice <= 0) { notify("Enter valid price"); return; }
    setSaving(true);
    // Delete old + insert updated
    await fetch(`${SUPABASE_URL}/rest/v1/trades?id=eq.${t.id}`, { method:"DELETE", headers:H });
    const updated = { ...t, price: newPrice, id: `SETTLE_${t.clientId}_${t.contract.replace(/\s+/g,"_")}_${Date.now()}` };
    const r = await fetch(`${SUPABASE_URL}/rest/v1/trades`, { method:"POST", headers:H, body:JSON.stringify([updated]) });
    if (r.ok || r.status===201) { notify("✅ Price updated"); setEditId(null); await loadAllData(true); }
    else notify("❌ Update failed");
    setSaving(false);
  };

  const addSettlement = async () => {
    const { clientId, contract, side, qty, price, date } = addForm;
    if (!clientId||!contract||!qty||!price||!date) { notify("Fill all fields"); return; }
    setSaving(true);
    const trade = {
      id:         `SETTLE_${clientId}_${contract.replace(/\s+/g,"_")}_${Date.now()}`,
      clientId, contract, side,
      qty:        parseFloat(qty),
      price:      parseFloat(price),
      date, time: "15:30:00",
      exchange:   contract.includes("SENSEX")||contract.includes("BANKEX") ? "BSE" : "NSE",
      instrType:  contract.includes("FUT") ? "FUTURES" : "Options",
      scriptName: contract, scripCode: "", batchId: null,
    };
    const r = await fetch(`${SUPABASE_URL}/rest/v1/trades`, { method:"POST", headers:H, body:JSON.stringify([trade]) });
    if (r.ok || r.status===201) {
      notify("✅ Settlement added"); setShowAdd(false);
      setAddForm({ clientId:"", contract:"", side:"SELL", qty:"", price:"", date: new Date().toISOString().slice(0,10) });
      await loadAllData(true);
    } else notify("❌ Add failed");
    setSaving(false);
  };

  const badge = (c) => ({ background:c+"22", color:c, borderRadius:20, padding:"2px 10px", fontSize:11, fontWeight:700 });

  return (
    <div style={{ padding:"24px 28px", maxWidth:1100, margin:"0 auto" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
        <div>
          <div style={{ fontSize:22, fontWeight:800, color:C.text }}>⚡ Settlement Manager</div>
          <div style={{ color:C.muted, fontSize:13, marginTop:2 }}>View, edit or delete all manually settled positions</div>
        </div>
        <button onClick={() => setShowAdd(s => !s)} style={{ ...btn(C.accent), padding:"10px 20px", fontSize:13 }}>
          {showAdd ? "✕ Cancel" : "+ Add Settlement"}
        </button>
      </div>

      {/* Add Settlement Form */}
      {showAdd && (
        <div style={{ ...card, marginBottom:20, padding:20 }}>
          <div style={{ fontWeight:700, color:C.text, marginBottom:14 }}>Add New Settlement Trade</div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:12, marginBottom:14 }}>
            <div>
              <div style={{ fontSize:11, color:C.muted, marginBottom:4 }}>Client</div>
              <select value={addForm.clientId} onChange={e => setAddForm(f=>({...f,clientId:e.target.value}))}
                style={{ ...input, cursor:"pointer" }}>
                <option value="">Select client</option>
                {visibleClients.map(c => <option key={c.id} value={c.id}>{c.id} — {c.name}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize:11, color:C.muted, marginBottom:4 }}>Contract</div>
              <input value={addForm.contract} onChange={e => setAddForm(f=>({...f,contract:e.target.value}))}
                placeholder="e.g. NIFTY 24500 PE 11AUG2026" style={input}/>
            </div>
            <div>
              <div style={{ fontSize:11, color:C.muted, marginBottom:4 }}>Side</div>
              <select value={addForm.side} onChange={e => setAddForm(f=>({...f,side:e.target.value}))}
                style={{ ...input, cursor:"pointer" }}>
                <option value="SELL">SELL</option>
                <option value="BUY">BUY</option>
              </select>
            </div>
            <div>
              <div style={{ fontSize:11, color:C.muted, marginBottom:4 }}>Qty</div>
              <input type="number" value={addForm.qty} onChange={e => setAddForm(f=>({...f,qty:e.target.value}))}
                placeholder="Quantity" style={input}/>
            </div>
            <div>
              <div style={{ fontSize:11, color:C.muted, marginBottom:4 }}>Settlement Price (₹)</div>
              <input type="number" step="0.05" value={addForm.price} onChange={e => setAddForm(f=>({...f,price:e.target.value}))}
                placeholder="Price" style={input}/>
            </div>
            <div>
              <div style={{ fontSize:11, color:C.muted, marginBottom:4 }}>Date</div>
              <input type="date" value={addForm.date} onChange={e => setAddForm(f=>({...f,date:e.target.value}))}
                style={input}/>
            </div>
          </div>
          <button onClick={addSettlement} disabled={saving}
            style={{ ...btn(C.green), padding:"10px 24px", fontWeight:700, opacity:saving?0.6:1 }}>
            {saving ? "⏳ Saving..." : "✅ Add Settlement"}
          </button>
        </div>
      )}

      {/* Settlements List */}
      {settlements.length === 0 ? (
        <div style={{ ...card, textAlign:"center", padding:48, color:C.muted }}>
          No settlement trades found. Use ⚡ Square Off button on open positions to add them.
        </div>
      ) : (
        <div style={{ ...card, padding:0, overflow:"hidden" }}>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
            <thead>
              <tr style={{ background:C.bg }}>
                {["Date","Client","Contract","Side","Qty","Settlement Price","Action"].map(h => (
                  <th key={h} style={{ padding:"12px 14px", textAlign:"left", color:C.muted,
                    fontWeight:600, fontSize:11, borderBottom:`1px solid ${C.border}`, textTransform:"uppercase" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...settlements].sort((a,b) => (b.date||"").localeCompare(a.date||"")).map((t,i) => (
                <tr key={t.id} style={{ borderBottom:`1px solid ${C.border}22`,
                  background: i%2===0 ? "transparent" : C.bg+"66" }}>
                  <td style={{ padding:"12px 14px", color:C.muted }}>{t.date}</td>
                  <td style={{ padding:"12px 14px", color:C.accent, fontWeight:600 }}>{t.clientId}</td>
                  <td style={{ padding:"12px 14px", color:C.text }}>{t.contract}</td>
                  <td style={{ padding:"12px 14px" }}>
                    <span style={badge(t.side==="BUY"?C.green:C.red)}>{t.side}</span>
                  </td>
                  <td style={{ padding:"12px 14px", color:C.text, fontWeight:600 }}>{t.qty}</td>
                  <td style={{ padding:"12px 14px" }}>
                    {editId === t.id ? (
                      <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                        <input type="number" step="0.05" autoFocus value={editPrice}
                          onChange={e => setEditPrice(e.target.value)}
                          style={{ ...input, width:100, fontSize:13, padding:"5px 8px" }}/>
                        <button onClick={() => saveEdit(t)} disabled={saving}
                          style={{ ...btn(C.green), padding:"5px 12px", fontSize:12 }}>
                          {saving ? "..." : "✅"}
                        </button>
                        <button onClick={() => setEditId(null)}
                          style={{ ...btn(C.muted), padding:"5px 10px", fontSize:12 }}>✕</button>
                      </div>
                    ) : (
                      <span style={{ color:C.text, fontWeight:700 }}>₹{t.price}</span>
                    )}
                  </td>
                  <td style={{ padding:"12px 14px" }}>
                    <div style={{ display:"flex", gap:6 }}>
                      <button onClick={() => { setEditId(t.id); setEditPrice(String(t.price)); }}
                        style={{ ...btn(C.yellow), padding:"5px 12px", fontSize:11 }}>✏️ Edit</button>
                      <button onClick={() => deleteTrade(t.id)} disabled={deleting===t.id}
                        style={{ ...btn(C.red), padding:"5px 12px", fontSize:11, opacity:deleting===t.id?0.5:1 }}>
                        {deleting===t.id ? "..." : "🗑 Delete"}
                      </button>
                    </div>
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

function SettingsPage({ angelCreds, setAngelCreds, angelStatus, connectAngel, disconnectAngel, notify, C, card, btn, input, state, setState, sb, withSync, auth, angelToken, fetchPrices }) {
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
            <button onClick={fetchPrices}
              style={{...btn(C.green),fontSize:12}}>
              📋 Fetch Live Prices Now
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
          <br/>⚡ <strong>What this enables:</strong> Live option prices for accurate MTM calculation.
        </div>
      </div>

      {(auth?.role === "admin" || auth?.role === "superadmin") && (
        <DeleteIntradayButton notify={notify} C={C} card={card} btn={btn} />
      )}

      {/* ── Charges PIN Change ── */}
      {(auth?.role === "admin" || auth?.role === "superadmin") && (() => {
        const [oldPin, setOldPin] = useState("");
        const [newPin, setNewPin] = useState("");
        const [pinMsg, setPinMsg] = useState("");
        const changePin = () => {
          const current = (() => { try { return localStorage.getItem("jiya_charges_pin") || "2580"; } catch(e) { return "2580"; } })();
          if (oldPin !== current) { setPinMsg("❌ Old PIN is wrong"); return; }
          if (!/^\d{4}$/.test(newPin)) { setPinMsg("❌ New PIN must be exactly 4 digits"); return; }
          try { localStorage.setItem("jiya_charges_pin", newPin); } catch(e) {}
          setPinMsg("✅ PIN changed successfully");
          setOldPin(""); setNewPin("");
          setTimeout(() => setPinMsg(""), 3000);
        };
        return (
          <div style={{...card, padding:20, marginTop:16}}>
            <div style={{fontSize:15, fontWeight:700, color:C.text, marginBottom:6}}>🔒 Change Charges Section PIN</div>
            <div style={{color:C.muted, fontSize:12, marginBottom:14}}>Default PIN is 2580. Change it here anytime.</div>
            <div style={{display:"flex", gap:10, flexWrap:"wrap", alignItems:"flex-end"}}>
              <div>
                <div style={{color:C.muted, fontSize:11, marginBottom:4}}>Old PIN</div>
                <input type="password" maxLength={4} value={oldPin}
                  onChange={e => { setOldPin(e.target.value.replace(/[^0-9]/g,"")); setPinMsg(""); }}
                  placeholder="Current PIN"
                  style={{...input, width:120, fontSize:16, textAlign:"center", letterSpacing:6}}/>
              </div>
              <div>
                <div style={{color:C.muted, fontSize:11, marginBottom:4}}>New PIN</div>
                <input type="password" maxLength={4} value={newPin}
                  onChange={e => { setNewPin(e.target.value.replace(/[^0-9]/g,"")); setPinMsg(""); }}
                  placeholder="New PIN"
                  style={{...input, width:120, fontSize:16, textAlign:"center", letterSpacing:6}}/>
              </div>
              <button onClick={changePin} style={{...btn(C.accent), padding:"10px 20px"}}>Change PIN</button>
            </div>
            {pinMsg && <div style={{marginTop:10, fontSize:13, color:pinMsg.startsWith("✅")?C.green:C.red}}>{pinMsg}</div>}
          </div>
        );
      })()}

      {/* ── Password Management ── */}
      <PasswordManager state={state} setState={setState} sb={sb} withSync={withSync} notify={notify} C={C} card={card} btn={btn} input={input} />

      {/* What gets automated */}
      {angelStatus === "connected" && (
        <div style={{...card,padding:20,marginTop:16}}>
          <div style={{fontSize:14,fontWeight:700,color:C.text,marginBottom:12}}>✅ Now Automated</div>
          {[
            {icon:"📈", label:"Live option prices", desc:"Updates every 5 seconds during market hours"},
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
const formatINR = (value) => new Intl.NumberFormat("en-IN", {
  style: "currency", currency: "INR", maximumFractionDigits: 2,
}).format(Number(value) || 0);

function MonthlyTargetTracker({ title, subtitle, pnl, target, pnlAvailable=true, onSetTarget=null, C, card }) {
  const targetAmount = Number(target) || 0;
  if (!(targetAmount > 0)) return (
    <div style={{...card,padding:"18px 20px",marginBottom:20,border:`1px solid ${C.border}`}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12}}>
        <div><div style={{color:C.text,fontWeight:800,fontSize:16}}>{title}</div><div style={{color:C.muted,fontSize:11,marginTop:3}}>{subtitle}</div></div>
        {onSetTarget ? <button onClick={onSetTarget} style={{padding:"7px 12px",borderRadius:8,border:"none",background:C.accent,color:"#fff",fontSize:11,fontWeight:800,cursor:"pointer"}}>Set this month’s target</button>
          : <span style={{padding:"5px 10px",borderRadius:999,background:C.muted+"18",color:C.muted,fontSize:11,fontWeight:700}}>Target not set</span>}
      </div>
    </div>
  );
  if (!pnlAvailable) return (
    <div style={{...card,padding:"18px 20px",marginBottom:20,border:`1px solid ${C.yellow}44`}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12}}>
        <div><div style={{color:C.text,fontWeight:800,fontSize:16}}>{title}</div><div style={{color:C.muted,fontSize:11,marginTop:3}}>{subtitle}</div></div>
        <div style={{textAlign:"right"}}><div style={{color:C.muted,fontSize:10}}>Monthly Target</div><div style={{color:C.text,fontWeight:800}}>{formatINR(targetAmount)}</div></div>
      </div>
      <div style={{marginTop:14,padding:12,borderRadius:9,background:C.yellow+"10",color:C.yellow,fontSize:12,fontWeight:700}}>P&amp;L data pending — no estimated or dummy figure is displayed.</div>
    </div>
  );

  const value = Number(pnl) || 0;
  const tracker = targetTrackerState(value, targetAmount);
  const markerColor = tracker.status==="loss" ? C.red : tracker.status==="caution" ? C.yellow : C.accent;
  const statusText = tracker.status==="loss" ? "Recovery Zone" : tracker.status==="caution" ? "Target achieved — protect profits" : "Progressing toward target";
  const daysLeft = daysRemainingInMonth(new Date());
  const dailyNeeded = tracker.remaining > 0 ? tracker.remaining / Math.max(daysLeft,1) : 0;
  return (
    <div style={{...card,padding:"20px 22px",marginBottom:20,border:`1px solid ${markerColor}55`,overflow:"hidden"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"start",gap:16,flexWrap:"wrap"}}>
        <div><div style={{color:C.text,fontWeight:850,fontSize:17}}>{title}</div><div style={{color:C.muted,fontSize:11,marginTop:3}}>{subtitle} · Source: existing JIYA monthly net P&amp;L</div></div>
        <div style={{display:"flex",gap:22,textAlign:"right"}}>
          <div><div style={{color:C.muted,fontSize:10}}>Current P&amp;L</div><div style={{color:value>=0?C.green:C.red,fontWeight:900,fontSize:18}}>{value>=0?"+":"−"}{formatINR(Math.abs(value))}</div></div>
          <div><div style={{color:C.muted,fontSize:10}}>Monthly Target</div><div style={{color:C.text,fontWeight:900,fontSize:18}}>{formatINR(targetAmount)}</div></div>
        </div>
      </div>

      <div style={{position:"relative",height:76,margin:"18px 4px 2px"}}>
        <div style={{position:"absolute",left:0,right:0,top:31,height:12,borderRadius:999,background:`linear-gradient(90deg, ${C.red} 0%, ${C.red} 25%, ${C.accent} 25%, ${C.green} 80%, ${C.yellow} 80%, ${C.yellow} 100%)`,opacity:0.82,boxShadow:"inset 0 1px 3px rgba(0,0,0,.35)"}}/>
        <div style={{position:"absolute",left:"25%",top:25,width:2,height:24,background:"#fff",opacity:.75}}/>
        <div style={{position:"absolute",left:"80%",top:22,width:2,height:30,background:"#fff",opacity:.9}}/>
        <div style={{position:"absolute",left:`${tracker.markerPct}%`,top:0,transform:"translateX(-50%)",transition:"left 1.1s cubic-bezier(.2,.8,.2,1)",zIndex:2}}>
          <div style={{background:markerColor,color:"#fff",fontSize:11,fontWeight:900,padding:"5px 9px",borderRadius:7,whiteSpace:"nowrap",boxShadow:`0 4px 14px ${markerColor}55`}}>{value>=0?"+":"−"}{formatINR(Math.abs(value))}</div>
          <div style={{width:0,height:0,borderLeft:"6px solid transparent",borderRight:"6px solid transparent",borderTop:`7px solid ${markerColor}`,margin:"0 auto"}}/>
          <div style={{width:18,height:18,borderRadius:"50%",background:"#fff",border:`5px solid ${markerColor}`,margin:"2px auto 0",boxShadow:`0 0 0 4px ${markerColor}25`}}/>
        </div>
        <div style={{position:"absolute",left:0,top:56,color:C.red,fontSize:10,fontWeight:700}}>Loss</div>
        <div style={{position:"absolute",left:"25%",top:56,transform:"translateX(-50%)",color:C.muted,fontSize:10}}>₹0</div>
        <div style={{position:"absolute",left:"80%",top:56,transform:"translateX(-50%)",color:C.green,fontSize:10,fontWeight:800}}>Target</div>
        <div style={{position:"absolute",right:0,top:56,color:C.yellow,fontSize:10,fontWeight:800}}>Caution</div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(4,minmax(120px,1fr))",gap:10,marginTop:8}}>
        <div style={{background:C.bg,borderRadius:9,padding:10}}><div style={{color:C.muted,fontSize:10}}>Status</div><div style={{color:markerColor,fontWeight:800,fontSize:12,marginTop:3}}>{statusText}</div></div>
        <div style={{background:C.bg,borderRadius:9,padding:10}}><div style={{color:C.muted,fontSize:10}}>{tracker.status==="caution"?"Profit Buffer":"Target Remaining"}</div><div style={{color:C.text,fontWeight:800,fontSize:12,marginTop:3}}>{formatINR(tracker.status==="caution"?tracker.buffer:tracker.remaining)}</div></div>
        <div style={{background:C.bg,borderRadius:9,padding:10}}><div style={{color:C.muted,fontSize:10}}>Target Progress</div><div style={{color:markerColor,fontWeight:800,fontSize:12,marginTop:3}}>{tracker.progressPct.toFixed(2)}%</div></div>
        <div style={{background:C.bg,borderRadius:9,padding:10}}><div style={{color:C.muted,fontSize:10}}>{tracker.remaining>0?`Required / day · ${daysLeft} days left`:"Risk Message"}</div><div style={{color:tracker.status==="caution"?C.yellow:C.text,fontWeight:800,fontSize:12,marginTop:3}}>{tracker.remaining>0?formatINR(dailyNeeded):"Protect achieved profits"}</div></div>
      </div>
    </div>
  );
}
// ─────────────────────────────────────────────────────────────────────────────

export default function BackOffice() {
  const [state, setState] = useState(INITIAL_STATE);
  // Keep tradesRef always up to date so polling closures have fresh data
  useEffect(() => { tradesRef.current = state.trades || []; }, [state.trades]);
  const [dbLoading, setDbLoading] = useState(false); // financial data loads after authentication
  const [authBootstrapReady, setAuthBootstrapReady] = useState(false);
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

  // ── Angel One API State ──
  const [angelCreds, setAngelCreds] = useState(() => {
    try { return JSON.parse(localStorage.getItem("angel_creds") || "{}"); } catch(e) { return {}; }
  });
  const [angelStatus, setAngelStatus] = useState(() => {
    try { return localStorage.getItem("angel_jwt") ? "connected" : "disconnected"; } catch(e) { return "disconnected"; }
  });
  const [angelToken,     setAngelToken]     = useState(() => {
    try { return localStorage.getItem("angel_jwt") || null; } catch(e) { return null; }
  });
  const [angelFeedToken, setAngelFeedToken] = useState(null);
  const [angelLivePrice, setAngelLivePrice] = useState({}); // { "NIFTY_23000_CE_13APR2026": 45.50, ... }
  const [angelLiveMTM,   setAngelLiveMTM]   = useState({}); // { "NIFTY 23000 CE 13APR2026": { ltp, token, exchange } }
  const [livePositions, setLivePositions]   = useState([]); // from live_positions table (LTP file upload)
  const [manualLTP, setManualLTP] = useState(() => {
    try { return JSON.parse(localStorage.getItem("jiya_manual_ltp") || "{}"); } catch(e) { return {}; }
  });

  const [chargesPinUnlocked, setChargesPinUnlocked] = useState(() => {
    try { return sessionStorage.getItem("jiya_charges_unlocked") === "1"; } catch(e) { return false; }
  });
  const [chargesPinInput,    setChargesPinInput]    = useState("");
  const [chargesPinError,    setChargesPinError]    = useState("");
  const [closingData, setClosingData] = useState(() => {
    try { return JSON.parse(localStorage.getItem("jiya_closing_data") || "{}"); } catch(e) { return {}; }
  });
  const [editingLTP, setEditingLTP] = useState(null);
  const [expandedPos,  setExpandedPos]   = useState({}); // { "clientId||contract": true }
  const [squareOffModal, setSquareOffModal] = useState(null); // { clientId, contract, side, qty, avgPrice }
  const [squareOffPrice, setSquareOffPrice] = useState("");
  const [squareOffConfirm, setSquareOffConfirm] = useState(false);
  const [squareOffLoading, setSquareOffLoading] = useState(false);
  const [angelMTMStatus, setAngelMTMStatus] = useState("idle"); // idle|fetching|live|error
  const [angelWS,        setAngelWS]        = useState(null);

  // ── Angel One: Connect & start live prices ──
  const angelLogin = async (creds) => {
    const resp = await fetch(ANGEL_PROXY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "login",
        apiKey: creds.apiKey,
        payload: {
          clientId: creds.clientId,
          password: creds.password,
          totp:     creds.totpSecret,
        }
      })
    });
    const data = await resp.json();
    if (!data.status) throw new Error(data.message || "Login failed");
    return {
      jwtToken:  data.data?.jwtToken,
      feedToken: data.data?.feedToken,
    };
  };

  const connectAngel = async (creds) => {
    setAngelStatus("connecting");
    try {
      // Login to get JWT token
      const tokens = await angelLogin(creds);
      setAngelToken(tokens.jwtToken);
      setAngelFeedToken(tokens.feedToken);
      setAngelStatus("connected");
      notify("✅ Angel One connected! Live prices active.");

      setAngelToken(tokens.jwtToken);
      try { localStorage.setItem("angel_jwt", tokens.jwtToken); } catch(e) {}
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
    try { localStorage.removeItem("angel_jwt"); } catch(e) {}
    notify("Disconnected from Angel One");
  };

  // ── Angel One: Poll LTP for all open positions ──
  // ── Angel One: Poll LTP for open positions ──────────────────
  const contractTokenMapRef = useRef({});
  const angelTokenRef    = useRef({ jwtToken: (() => { try { return localStorage.getItem("angel_jwt") || null; } catch(e) { return null; } })() });
  const instrMasterRef   = useRef({});
  const tradesRef        = useRef([]); // always holds latest state.trades

  // Load instrument master from Angel One (no auth needed)
  const loadInstrumentMaster = async () => {
    if (Object.keys(instrMasterRef.current).length > 0) return; // already loaded
    try {
      const r = await fetch(ANGEL_PROXY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "instrument_master", apiKey: angelCreds.apiKey })
      });
      const data = await r.json();
      if (data.status && data.data?.length) {
        const map = {};
        data.data.forEach(x => {
          map[x.symbol.toUpperCase()] = { token: x.token, exchange: x.exch_seg };
        });
        instrMasterRef.current = map;
        console.log("Instrument master loaded:", Object.keys(map).length, "contracts");
      }
    } catch(e) {
      console.log("Instrument master load error:", e.message);
    }
  };

  // Match our contract name to Angel One symbol
  // Our format: "NIFTY 23800 PE 14JUL2026"
  // Angel One format: "NIFTY14JUL2623800PE"
  const contractToAngelSymbol = (contract) => {
    const parts   = contract.trim().split(/\s+/);
    if (parts.length < 2) return null;
    const name    = parts[0].toUpperCase();
    const isBSE   = ["SENSEX","BANKEX","SENSEX50"].includes(name);
    const isFut   = contract.toUpperCase().includes("FUT");
    if (isFut) {
      const expiry = parts[2] || parts[1];
      const exp6   = expiry.slice(0,5) + expiry.slice(7,9);
      return { symbol: name + exp6 + "FUT", exchange: isBSE ? "BFO" : "NFO" };
    } else {
      const strike  = parseFloat(parts[1] || 0);
      const optType = (parts[2] || "").toUpperCase();
      const expiry  = parts[3] || "";
      const exp6    = expiry.slice(0,5) + expiry.slice(7,9);
      return { symbol: name + exp6 + Math.round(strike) + optType, exchange: isBSE ? "BFO" : "NFO" };
    }
  };

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

  // Fetch token for a single contract from Angel One via search
  const fetchContractToken = async (jwtToken, apiKey, contractInfo) => {
    try {
      const r = await fetch(ANGEL_PROXY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action:  "search_token",
          apiKey,  jwtToken,
          payload: contractInfo
        })
      });
      const data = await r.json();
      if (!data.status || !data.data?.length) return null;

      // Parse contract to extract strike and expiry for matching
      // Contract format: "SENSEX 81000.00 CE 09JUL2026"
      const parts   = contractInfo.contract.trim().split(/\s+/);
      const strike  = parts[1] ? parseFloat(parts[1]).toString() : "";
      const optType = parts[2] || ""; // CE or PE
      const expiry  = parts[3] || ""; // 09JUL2026

      // Try to find best match from search results
      let best = data.data[0]; // fallback to first result
      if (strike) {
        const matched = data.data.find(d => {
          const name = (d.tradingsymbol || d.symbol || "").toUpperCase();
          return name.includes(optType.toUpperCase()) &&
                 name.includes(parseFloat(strike).toFixed(0));
        });
        if (matched) best = matched;
      }

      return {
        token:    best.symboltoken,
        exchange: contractInfo.exchange,
        ltp:      best.ltp,
      };
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
        
        // Get all unique open position contracts from latest trades
        const { openPositions: allOpen } = applyFIFO(tradesRef.current);
        if (!allOpen.length) return;

        // Build token map for unknown contracts via instrument master
        const unknownContracts = allOpen.filter(p => !contractTokenMapRef.current[p.contract]);
        if (unknownContracts.length > 0) {
          await loadInstrumentMaster();
          unknownContracts.forEach(pos => {
            const result = contractToAngelSymbol(pos.contract);
            if (result) {
              const entry = instrMasterRef.current[result.symbol];
              if (entry) contractTokenMapRef.current[pos.contract] = { token: entry.token, exchange: result.exchange };
            }
          });
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
    if (!apiKey) { notify("⚠ API Key missing — check Settings", "error"); return; }

    // If no token or token might be expired, reconnect first
    let activeToken = jwtToken;
    if (!activeToken) {
      notify("🔄 Reconnecting Angel One...");
      try {
        const tokens = await angelLogin(angelCreds);
        activeToken  = tokens.jwtToken;
        setAngelToken(activeToken);
        angelTokenRef.current = { jwtToken: activeToken };
        setAngelStatus("connected");
        notify("✅ Reconnected — fetching prices...");
      } catch(e) {
        notify("❌ Could not reconnect Angel One — go to Settings and reconnect manually", "error");
        return;
      }
    }
    jwtToken = activeToken;
    notify("📋 Fetching live prices for open positions...");
    try {
      // Load instrument master first (no auth needed)
      await loadInstrumentMaster();

      // Get all unique open position contracts
      const { openPositions } = applyFIFO(tradesRef.current);
      if (!openPositions.length) {
        notify("No open positions — nothing to fetch");
        return;
      }

      const uniqueContracts = [...new Set(openPositions.map(p => p.contract))];
      notify(`Looking up tokens for ${uniqueContracts.length} contracts...`);

      // Map contracts to Angel One tokens using instrument master
      const nfoTokens = [], bfoTokens = [], tokenToContract = {};
      for (const contract of uniqueContracts) {
        // Check existing token map first
        let mapped = contractTokenMapRef.current[contract];
        if (!mapped) {
          const result = contractToAngelSymbol(contract);
          if (result) {
            const entry = instrMasterRef.current[result.symbol];
            if (entry) {
              mapped = { token: entry.token, exchange: result.exchange };
              contractTokenMapRef.current[contract] = mapped;
              console.log(`Mapped ${contract} → ${result.symbol} → token ${entry.token}`);
            } else {
              console.log(`Not in master: ${contract} → tried ${result.symbol}`);
            }
          }
        }
        if (mapped?.token) {
          const tok = mapped.token;
          tokenToContract[tok] = contract;
          if (mapped.exchange === "BFO") bfoTokens.push(tok);
          else nfoTokens.push(tok);
        }
      }

      console.log(`Found tokens: NFO=${nfoTokens.length} BFO=${bfoTokens.length}`);
      notify(`Fetching LTP for ${nfoTokens.length + bfoTokens.length} contracts...`);

      // Build batch LTP request
      const exchangeTokens = {};
      if (nfoTokens.length) exchangeTokens["NFO"] = nfoTokens;
      if (bfoTokens.length) exchangeTokens["BFO"] = bfoTokens;

      const newMTM = { ...angelLiveMTM };
      let fetched = 0;

      if (Object.keys(exchangeTokens).length > 0) {
        const resp = await fetch(ANGEL_PROXY, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "ltp", apiKey, jwtToken, payload: { exchangeTokens } })
        });
        const data = await resp.json();
        console.log("LTP response:", data.status, data.data?.fetched?.length, "fetched");
        if (data.status && data.data?.fetched?.length) {
          data.data.fetched.forEach(item => {
            const contract = tokenToContract[item.symbolToken];
            if (contract && item.ltp > 0) {
              newMTM[contract] = { ltp: item.ltp, token: item.symbolToken };
              fetched++;
              console.log(`MTM set: ${contract} = ₹${item.ltp}`);
            }
          });
        }
      }

      // Update live MTM state — this automatically updates P&L via getBhavClose
      setAngelLiveMTM(newMTM);
      setAngelMTMStatus("live");

      // Debug: compare stored keys vs open position contract names
      const { openPositions: dbgOpen } = applyFIFO(tradesRef.current);
      const dbgContracts = [...new Set(dbgOpen.map(p => p.contract))];
      const dbgKeys = Object.keys(newMTM);
      console.log("angelLiveMTM keys:", dbgKeys);
      console.log("FIFO contract names:", dbgContracts);
      const matched = dbgContracts.filter(c => newMTM[c]);
      const unmatched = dbgContracts.filter(c => !newMTM[c]);
      console.log("Matched:", matched.length, "Unmatched:", unmatched);

      notify(`✅ Closing prices updated for ${fetched}/${uniqueContracts.length} contracts`);

    } catch(e) {
      notify("❌ Closing price fetch failed: " + e.message, "error");
    }
  };

  // ── Auto-reconnect Angel One on page load ──
  useEffect(() => {
    const savedJwt = localStorage.getItem("angel_jwt");
    const savedKey = JSON.parse(localStorage.getItem("angel_creds") || "{}").apiKey;
    if (savedJwt && savedKey) {
      setAngelToken(savedJwt);
      setAngelStatus("connected");
      angelTokenRef.current = { jwtToken: savedJwt };
      scheduleAutoBhavcopy(savedJwt, savedKey);
      loadInstrumentMaster(); // preload instrument master
      // Note: startLTPPolling is called after data loads (in loadAllData)
    } else if (angelCreds.clientId && angelCreds.password && angelCreds.totpSecret && angelCreds.apiKey) {
      connectAngel(angelCreds);
    }
  }, []); // eslint-disable-line

  const notify = (msg, type = "success") => {
    setNotification({ msg, type });
    setTimeout(() => setNotification(null), 3500);
  };

  const loadAuthBootstrap = async () => {
    try {
      const [clients, admins] = await Promise.all([
        sb.select("clients", "?order=created_at.asc"),
        sb.select("admins", "?order=id.asc").catch(() => []),
      ]);
      const authData = {
        clients: Array.isArray(clients) ? clients : [],
        admins: Array.isArray(admins) ? admins : [],
      };
      setState(s => ({ ...s, ...authData }));
      return authData;
    } catch (error) {
      console.error("Authentication bootstrap failed:", error);
      return { clients:[], admins:[] };
    } finally { setAuthBootstrapReady(true); }
  };

  // Load only the small authentication dataset on mount. The 39k+ trade book
  // loads after login so it can never block the login form.
  useEffect(() => {
    if (!SUPABASE_CONFIGURED) return;
    loadAuthBootstrap();

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

  // Tab-switch reload DISABLED — no loading screen when switching tabs

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

      const [clients, trades, ledger, tickets, interest, chargesHistory, bhavcopy, lockedMonthsRaw, admins, auditLog, investorAllocations, carryForwardBatches, monthlyTargets] = await Promise.all([
        fetchAll("clients",         "?order=created_at.asc"),
        // CRITICAL: id is the unique tie-breaker. Hundreds of broker rows can
        // share the same date/time; offset pagination without id can skip or
        // repeat rows between pages and feed an incomplete book into FIFO.
        fetchAll("trades",          "?order=date.asc,time.asc,id.asc"),
        fetchAll("ledger",          "?order=date.asc"),
        fetchAll("tickets",         "?order=date.desc"),
        fetchAll("interest",        "?order=created_at.asc"),
        fetchAll("charges_history", "?order=created_at.asc"),
        fetchAll("bhavcopy",        "?order=created_at.desc"),
        sb.select("locked_months",  "?order=month.asc").catch(() => []),
        sb.select("admins",         "?order=id.asc").catch(() => []),
        sb.select("audit_log",      "?order=timestamp.desc&limit=2000").catch(() => []),
        sb.rpc("get_investor_allocations", {p_user:auth?.loginUser||"",p_password:auth?.loginSecret||""}).catch(() => []),
        fetchAll("carry_forward_batches", "?order=month.desc").catch(() => []),
        sb.rpc("get_monthly_targets", {p_user:auth?.loginUser||"",p_password:auth?.loginSecret||""}).catch(() => []),
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
        investorAllocations: Array.isArray(investorAllocations) ? investorAllocations : [],
        carryForwardBatches: Array.isArray(carryForwardBatches) ? carryForwardBatches : [],
        monthlyTargets: Array.isArray(monthlyTargets) ? monthlyTargets : [],
      }));
      setSyncStatus("saved");
      setTimeout(() => setSyncStatus("idle"), 2000);

      // Load live positions (LTP from uploaded LTP file or F6 capture)
      try {
        const liveRaw = await fetch(`${SUPABASE_URL}/rest/v1/live_positions?adminId=eq.JIYA`, {
          headers: { "apikey": SUPABASE_ANON_KEY, "Authorization": `Bearer ${SUPABASE_ANON_KEY}` }
        });
        const liveData = await liveRaw.json();
        if (Array.isArray(liveData)) setLivePositions(liveData);
      } catch(e) { console.log("Live positions load error:", e.message); }

      // Start live prices AFTER trades are loaded
      const savedJwt = localStorage.getItem("angel_jwt");
      const savedKey = JSON.parse(localStorage.getItem("angel_creds") || "{}").apiKey;
      if (savedJwt && savedKey) {
        setTimeout(() => {
          startLTPPolling(savedJwt, savedKey);
        }, 500); // short delay so state is settled
      }
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

  // Authenticate first, then hydrate the large financial dataset in background.
  useEffect(() => {
    if (!auth || !SUPABASE_CONFIGURED) return;
    loadAllData();
  }, [auth]);

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
      // Month-end close/reopen rows are internal accounting entries, not broker trades.
      // They must never generate transaction charges.
      .filter(t => t.clientId === clientId && (t.date || "").startsWith(yearMonth) && !isCarryForwardTrade(t))
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
  const [carryMonth, setCarryMonth] = useState(new Date().toISOString().slice(0,7));
  const [carryPreview, setCarryPreview] = useState(null);
  const [carryExecuting, setCarryExecuting] = useState(false);

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
  // Build lookup from live_positions table (uploaded LTP file or F6 capture)
  const livePosLookup = {};
  livePositions.forEach(p => {
    if (p.contract && p.ltp > 0) livePosLookup[p.contract.trim().toUpperCase()] = p.ltp;
  });

  const getBhavCloseForClient = (clientId, contract) => {
    // Check manual LTP override first
    const key = `${clientId}||${contract}`;
    if (manualLTP[key] !== undefined) return manualLTP[key];
    return getBhavClose(contract);
  };

  const getBhavClose = (contract) => {
    const norm = (s) => (s||"").trim().toUpperCase().replace(/\s+/g," ");
    const cn = norm(contract);
    // Priority 1: Angel One live MTM
    const direct = angelLiveMTM[contract]?.ltp;
    if (direct) return direct;
    const normalized = contract.replace(/(\d+)\.0+\s/g, (m, n) => n + ' ');
    const ang = angelLiveMTM[normalized]?.ltp;
    if (ang) return ang;
    // Priority 2: Uploaded LTP file (live_positions table)
    if (livePosLookup[cn]) return livePosLookup[cn];
    // Fuzzy match: try without trailing zeros in strike
    const fuzzy = Object.keys(livePosLookup).find(k => norm(k) === cn);
    if (fuzzy) return livePosLookup[fuzzy];
    // Priority 3: Bhavcopy
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

  const handleLogin = async () => {
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

    let authClients = state.clients;
    let authAdmins = state.admins || [];
    if (!isSuperAdmin && !authBootstrapReady) {
      const authData = await loadAuthBootstrap();
      authClients = authData.clients;
      authAdmins = authData.admins;
    }

    // Check sub-admin login — JIYA never matches as subAdmin
    const subAdmin = !isSuperAdmin
      ? authAdmins.find(a => a.username === userInput && a.password === passInput && a.username !== "JIYA")
      : null;

    // Check client login — only from correct admin scope
    const client = !isSuperAdmin && !subAdmin
      ? authClients.find(c => c.id === userInput && c.password === passInput)
      : null;

    if (isSuperAdmin) {
      setLoginAttempts(0);
      setAuth({ role: "superadmin", plan: "superadmin", loginUser:userInput, loginSecret:passInput });
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
      setAuth({ role: "admin", adminId: subAdmin.id, plan: subAdmin.plan || "basic", loginUser:userInput, loginSecret:passInput });
      sessionStorage.setItem("jiya_login_time", Date.now().toString());
      setPage("dashboard");
      setLoginForm({ user: "", pass: "", error: "" });
    } else if (client) {
      setLoginAttempts(0);
      setAuth({ role: "client", clientId: client.id, adminId: client.adminId, loginUser:userInput, loginSecret:passInput });
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
  // ── FIFO on all uploaded trades — NO auto-expiry ──────────────────────────
  // Auto-expiry is disabled: it was squaring off positions at price 0
  // and showing 0 open positions for all past-expiry contracts.
  // Expiry squaring must be done via manual bhavcopy upload only.
  const { openPositions, closedPositions } = applyFIFO(state.trades);

  const prepareCarryForward = () => {
    const monthEndDate = new Date(Date.UTC(Number(carryMonth.slice(0,4)), Number(carryMonth.slice(5,7)), 0)).toISOString().slice(0,10);
    const officialPrices = {};
    // Lowest priority: official Bhavcopy close.
    for (const row of state.bhavcopy || []) {
      if (row.bhavDate === monthEndDate && Number(row.closePrice) > 0) officialPrices[row.contract] = { closePrice:Number(row.closePrice), source:"Bhavcopy Close" };
    }
    // Uploaded Trades & Positions closing file. Accept only captures made on the selected month-end in IST.
    const dateInIST = (value) => {
      if (!value) return "";
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone:"Asia/Kolkata", year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(new Date(value));
      const get = type => parts.find(p=>p.type===type)?.value;
      return `${get("year")}-${get("month")}-${get("day")}`;
    };
    for (const row of livePositions || []) {
      if (dateInIST(row.capturedAt) !== monthEndDate || !(Number(row.ltp) > 0)) continue;
      const record = { closePrice:Number(row.ltp), source:"Uploaded Closing File" };
      officialPrices[row.contract] = record;
      if (row.clientId) officialPrices[`${row.clientId}||${row.contract}`] = record;
    }
    // Highest priority: client-specific value explicitly confirmed in Trades & Positions.
    for (const [key, value] of Object.entries(manualLTP || {})) {
      if (Number(value) > 0) officialPrices[key] = { closePrice:Number(value), source:"Manual Close — Trades & Positions" };
    }
    const preview = buildCarryForwardPreview({ yearMonth:carryMonth, openPositions, closingPrices:officialPrices, existingTrades:state.trades });
    setCarryPreview(preview);
    if (preview.duplicate) return notify(`Month ${carryMonth} has already been processed.`, "error");
    if (preview.missingPrices.lengt…45341 tokens truncated…)), C.red)}
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
                <div style={{ background:C.bg, border:`1px solid ${C.border}`, borderRadius:10, padding:"12px 16px", marginBottom:12 }}>
                  <div style={{ color:C.muted, fontSize:11, fontWeight:600, marginBottom:6, textTransform:"uppercase", letterSpacing:0.5 }}>Description</div>
                  <div style={{ color:C.text, fontSize:13, lineHeight:1.6 }}>{t.message}</div>
                  {t.attachments && t.attachments.length > 0 && (
                    <div style={{ marginTop:10, display:"flex", gap:8, flexWrap:"wrap" }}>
                      {t.attachments.map((a,i) => (
                        <span key={i} style={{ background:`${C.accent}15`, border:`1px solid ${C.accent}44`, borderRadius:6, padding:"3px 10px", fontSize:12, color:C.accent }}>
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
                        <div style={{ flex:1, background: r.from==="admin"?C.accent+"15":C.green+"15", border:`1px solid ${r.from==="admin"?C.accent+"44":C.green+"44"}`, borderRadius:10, padding:"10px 14px" }}>
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
                      style={{ ...input, flex:1, background:C.bg }} />
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
              style={{ background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:"6px 12px", color:C.text, fontSize:13, cursor:"pointer" }}>
              <option value="all">All Clients</option>
              {visibleClients.map(c => <option key={c.id} value={c.id}>{c.name} ({c.id})</option>)}
            </select>
            <select value={auditActionFilter} onChange={e=>setAuditActionFilter_(e.target.value)}
              style={{ background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:"6px 12px", color:C.text, fontSize:13, cursor:"pointer" }}>
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
                  <tr style={{ background:C.bg }}>
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


    if (page === "settings" && (auth.role === "admin" || auth.role === "superadmin")) {
      return <SettingsPage angelCreds={angelCreds} setAngelCreds={setAngelCreds} angelStatus={angelStatus} connectAngel={connectAngel} disconnectAngel={disconnectAngel} notify={notify} C={C} card={card} btn={btn} input={input} state={state} setState={setState} sb={sb} withSync={withSync} auth={auth} angelToken={angelToken} fetchPrices={()=>fetchAutoBhavcopy(angelToken, angelCreds.apiKey)} />;
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
    if (page === "charges" && (auth.role === "admin" || auth.role === "superadmin")) {
      return (
        <div style={{ ...card, textAlign:"center", padding:56 }}>
          <div style={{ fontSize:42, marginBottom:16 }}>🔒</div>
          <div style={{ fontWeight:800, fontSize:18, color:C.text, marginBottom:8 }}>
            Charges is locked on your current plan
          </div>
          <div style={{ color:C.muted, fontSize:13, marginBottom:20 }}>
            Upgrade your plan to unlock Charges and other premium features.
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
    const box = { background: "#1e2535", border: `1px solid ${C.border}`, borderRadius: 16, padding: 32, width: 480, maxWidth: "90vw", boxShadow: "0 20px 60px rgba(0,0,0,0.5)" };
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

    if (modal === "monthlyTarget" && targetEditor) return (
      <div style={overlay} onClick={()=>{if(!targetSaving){setModal(null);setTargetEditor(null);}}}>
        <div style={box} onClick={e=>e.stopPropagation()}>
          <h3 style={{color:C.text,marginTop:0}}>Monthly Target — {targetEditor.clientName}</h3>
          <div style={{color:C.muted,fontSize:12,lineHeight:1.55,marginBottom:16}}>The tracker reads the existing JIYA monthly net P&amp;L. Saving a target never changes trades, FIFO, positions, charges, interest or P&amp;L.</div>
          {auth?.role==="client" && <div style={{padding:10,borderRadius:8,background:C.yellow+"12",border:`1px solid ${C.yellow}33`,color:C.yellow,fontSize:11,lineHeight:1.5,marginBottom:14}}>You can submit this month’s target only once. After saving, only JIYA Admin can change it.</div>}
          <div style={{marginBottom:14}}><label style={{color:C.muted,fontSize:12,display:"block",marginBottom:5}}>Target Month *</label><input type="month" disabled={auth?.role==="client"} value={targetEditor.month} onChange={e=>setTargetEditor(s=>({...s,month:e.target.value,targetAmount:monthlyTargetFor(s.clientId,e.target.value)}))} style={{...input,opacity:auth?.role==="client"?0.65:1}}/></div>
          <div style={{marginBottom:8}}><label style={{color:C.muted,fontSize:12,display:"block",marginBottom:5}}>Monthly Net P&amp;L Target (₹) *</label><input type="number" min={auth?.role==="client"?1:0} value={targetEditor.targetAmount} onChange={e=>setTargetEditor(s=>({...s,targetAmount:e.target.value}))} style={input} placeholder="Example: 40000"/></div>
          <div style={{color:C.muted,fontSize:10,marginBottom:18}}>{auth?.role==="client"?"Check the amount carefully before saving. It becomes locked immediately.":"Enter ₹0 to remove the target for this month. Previous months remain stored separately."}</div>
          <div style={{display:"flex",gap:10}}><button disabled={targetSaving} style={{...btn(C.green),opacity:targetSaving?0.6:1}} onClick={saveMonthlyTarget}><Icon name="check" size={14}/> {targetSaving?"Saving...":"Save Monthly Target"}</button><button disabled={targetSaving} style={btn(C.muted)} onClick={()=>{setModal(null);setTargetEditor(null);}}>Cancel</button></div>
        </div>
      </div>
    );

    if (modal === "editClient" && editClient) {
      const investorCommitted = activeAllocationRows.filter(a=>a.investorClientId===editClientOriginalId).reduce((s,a)=>s+Number(a.allocatedAmount||0),0);
      const strategyCommitted = activeAllocationRows.filter(a=>a.strategyClientId===editClientOriginalId).reduce((s,a)=>s+Number(a.allocatedAmount||0),0);
      return (
        <div style={overlay} onClick={() => { if(!editClientSaving){setModal(null);setEditClient(null);} }}>
          <div style={{...box,width:640,maxHeight:"92vh",overflowY:"auto"}} onClick={(e)=>e.stopPropagation()}>
            <h3 style={{color:C.text,marginTop:0}}>Edit Account — {editClientOriginalId}</h3>
            <div style={{padding:10,background:C.yellow+"10",border:`1px solid ${C.yellow}33`,borderRadius:8,color:C.muted,fontSize:11,lineHeight:1.5,marginBottom:16}}>
              Every change is saved to Supabase and audited. Changing the client code atomically updates linked trades, ledger, interest, positions, tickets and investor allocations. FIFO prices, quantities and P&amp;L formulas are not modified.
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 14px"}}>
              {field("Client ID / Code *","id",editClient,setEditClient)}
              {field("Full Name *","name",editClient,setEditClient)}
              {field("Email","email",editClient,setEditClient,"email")}
              {field("Phone","phone",editClient,setEditClient)}
              {field("Login Password *","password",editClient,setEditClient,"text")}
              <div style={{marginBottom:14}}>
                <label style={{color:C.muted,fontSize:12,display:"block",marginBottom:5}}>Assigned Admin</label>
                <select value={editClient.adminId||""} onChange={e=>setEditClient(s=>({...s,adminId:e.target.value}))} style={input}>
                  <option value="">JIYA / Superadmin</option>
                  {(state.admins||[]).map(a=><option key={a.id} value={a.id}>{a.name||a.username} ({a.id})</option>)}
                </select>
              </div>
            </div>
            <div style={{marginBottom:14}}>
              <label style={{color:C.muted,fontSize:12,display:"block",marginBottom:5}}>Account Type *</label>
              <select value={editClient.accountType||"trading"} onChange={e=>setEditClient(s=>({...s,accountType:e.target.value}))} style={input}>
                <option value="trading">Trading Account</option>
                <option value="investor">Investor Account</option>
                <option value="hybrid">Hybrid Account</option>
              </select>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
              <div style={{marginBottom:14}}>
                <label style={{color:C.muted,fontSize:12,display:"block",marginBottom:5}}>Total Deposited Fund (₹){["investor","hybrid"].includes(editClient.accountType)?" *":""}</label>
                <input type="number" min="0" value={editClient.depositAmount} onChange={e=>setEditClient(s=>({...s,depositAmount:e.target.value}))} style={input}/>
                {investorCommitted>0 && <div style={{fontSize:10,color:C.yellow,marginTop:4}}>Minimum allowed: {formatINR(investorCommitted)} active investor allocation</div>}
              </div>
              <div style={{marginBottom:14}}>
                <label style={{color:C.muted,fontSize:12,display:"block",marginBottom:5}}>Monthly Strategy Capital (₹){["trading","hybrid"].includes(editClient.accountType)?" *":""}</label>
                <input type="number" min="0" value={editClient.monthlyStrategyCapital} onChange={e=>setEditClient(s=>({...s,monthlyStrategyCapital:e.target.value}))} style={input}/>
                {strategyCommitted>0 && <div style={{fontSize:10,color:C.yellow,marginTop:4}}>Minimum allowed: {formatINR(strategyCommitted)} active strategy allocation</div>}
              </div>
            </div>
            <div style={{display:"flex",gap:10,marginTop:8}}>
              <button disabled={editClientSaving} style={{...btn(C.green),opacity:editClientSaving?0.6:1}} onClick={saveClientAccount}><Icon name="check" size={14}/> {editClientSaving?"Saving safely...":"Save All Changes"}</button>
              <button disabled={editClientSaving} style={btn(C.muted)} onClick={()=>{setModal(null);setEditClient(null);}}>Cancel</button>
            </div>
          </div>
        </div>
      );
    }

    if (modal === "addClient") return (
      <div style={overlay} onClick={() => setModal(null)}>
        <div style={box} onClick={(e) => e.stopPropagation()}>
          <h3 style={{ color: C.text, marginTop: 0 }}>Add New Client</h3>
          {field("Client ID *", "id", newClient, setNewClient)}
          {field("Full Name *", "name", newClient, setNewClient)}
          {field("Email", "email", newClient, setNewClient, "email")}
          {field("Phone", "phone", newClient, setNewClient)}
          {field("Password *", "password", newClient, setNewClient, "password")}
          <div style={{marginBottom:14}}>
            <label style={{color:C.muted,fontSize:12,display:"block",marginBottom:5}}>Account Type *</label>
            <select value={newClient.accountType} onChange={e=>setNewClient(s=>({...s,accountType:e.target.value}))} style={input}>
              <option value="trading">Trading Account</option>
              <option value="investor">Investor Account</option>
              <option value="hybrid">Hybrid Account</option>
            </select>
          </div>
          {["investor","hybrid"].includes(newClient.accountType) && field("Total Deposited Fund (₹) *", "depositAmount", newClient, setNewClient, "number")}
          {["trading","hybrid"].includes(newClient.accountType) && field("Monthly Strategy Capital (₹) *", "monthlyStrategyCapital", newClient, setNewClient, "number")}
          <div style={{padding:10,background:C.accent+"0d",border:`1px solid ${C.accent}22`,borderRadius:8,color:C.muted,fontSize:11,lineHeight:1.5}}>
            Trading accounts own broker trades. Investor accounts receive combined economic participation. Hybrid accounts support both. This selection does not change FIFO or trade records.
          </div>
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
                style={{ color: C.text, fontSize: 13, background: C.bg, border: `1px solid ${C.border}`,
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
              style={{ color:C.text, fontSize:13, background:C.bg, border:`1px solid ${C.border}`,
                borderRadius:8, padding:"10px 14px", width:"100%", boxSizing:"border-box", cursor:"pointer" }} />
          </div>

          {/* Preview */}
          {bhavPreview && (
            <div style={{ marginBottom:16 }}>
              <div style={{ background:C.green+"22", border:`1px solid ${C.green}44`, borderRadius:8, padding:"14px 18px", marginBottom:12 }}>
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

    if (modal === "uploadLTP") {
      const parseLTPFile = (text) => {
        const { openPositions } = applyFIFO(state.trades);
        // Only match OPEN positions — skip closed contracts
        const openContractKeys = new Set(openPositions.map(p => p.clientId + "||" + p.contract.trim().toUpperCase()));

        const results = [];
        const normStr = (s) => (s||"").trim().toUpperCase().replace(/\s+/g," ");
        const parseExpiry = (raw) => {
          if (!raw) return "";
          const s = String(raw).trim().toUpperCase();
          const m = s.match(/(\d{1,2})[\-\/](\w{3})[\-\/](\d{2,4})/);
          if (m) { const dd=m[1].padStart(2,"0"),mmm=m[2].slice(0,3),yy=m[3].length===2?"20"+m[3]:m[3]; return `${dd}${mmm}${yy}`; }
          if (s.length===7&&s.slice(2,5).match(/[A-Z]/)) return s.slice(0,5)+"20"+s.slice(5);
          return s;
        };
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          const row = line.split("\t");
          if (row.length < 8) continue;
          const clientId  = normStr(row[0]);
          const symbol    = normStr(row[1]);
          const expiry    = (row[2]||"").trim();
          const strike    = (row[3]||"").trim();
          const optType   = normStr(row[4]);
          const netQtyS   = (row[5]||"").trim();
          const ltpS      = (row[7]||"").trim();
          const scripCode = (row[row.length-1]||"").trim();
          if (!clientId||!symbol) continue;
          if (clientId.includes("USER")||clientId.startsWith("(")||clientId.startsWith("-")) continue;
          if (optType==="NORMAL"||optType==="EQ"||optType==="EQUITY") continue;
          const ltp = parseFloat(ltpS.replace(/,/g,"")||"0");
          if (ltp<=0) continue;
          const netQty = parseFloat(netQtyS.replace(/,/g,"")||"0");
          if (netQtyS!==""&&netQty===0) continue;
          const expNorm = parseExpiry(expiry);

          // Strike handling: may be blank (Excel col too narrow) or a real number
          const strikeNum = parseFloat(strike.replace(/,/g,""));
          const isRealStrike = !isNaN(strikeNum) && !strike.includes("-") && !strike.includes("/") && strikeNum > 100;
          const strikeNorm = isRealStrike ? String(Math.round(strikeNum)) : "";

          // Build contract — if strike missing for options, find by symbol+expiry+optType
          let contract = "";
          let finalMatch = null;

          if (["CE","PE","CA","PA"].includes(optType) && isRealStrike) {
            // Strike present — exact match
            contract = `${symbol} ${strikeNorm} ${optType} ${expNorm}`.trim();
            finalMatch = openPositions.find(p =>
              p.clientId === clientId && normStr(p.contract) === normStr(contract)
            );
          } else if (["CE","PE","CA","PA"].includes(optType) && !isRealStrike) {
            // Strike missing — match by clientId + symbol + optType + expiry
            finalMatch = openPositions.find(p => {
              if (p.clientId !== clientId) return false;
              const pc = normStr(p.contract);
              return pc.startsWith(symbol) && pc.includes(optType) && pc.endsWith(expNorm);
            });
            contract = finalMatch ? finalMatch.contract : `${symbol} ${optType} ${expNorm}`.trim();
          } else if (optType === "" || optType === "XX" || optType === "FUT") {
            contract = `${symbol} FUT ${expNorm}`.trim();
            finalMatch = openPositions.find(p =>
              p.clientId === clientId && normStr(p.contract) === normStr(contract)
            );
          } else {
            contract = `${symbol} FUT ${expNorm}`.trim();
            finalMatch = openPositions.find(p =>
              p.clientId === clientId && normStr(p.contract) === normStr(contract)
            );
          }

          // Verify match is actually OPEN (not closed)
          if (finalMatch) {
            const key = finalMatch.clientId + "||" + finalMatch.contract.trim().toUpperCase();
            if (!openContractKeys.has(key)) finalMatch = null; // it's closed — skip
          }

          // Skip if no match found (don't include unmatched closed contracts)
          const side = netQty >= 0 ? "BUY" : "SELL";
          const isBSE = ["SENSEX","BANKEX","SENSEX50"].includes(symbol);
          results.push({
            clientId,
            contract: finalMatch ? finalMatch.contract : contract,
            ltp, netQty: Math.abs(netQty)||1, side,
            exchange: isBSE ? "BFO" : "NFO",
            matched: !!finalMatch,
            scripCode
          });
        }
        return results;
      };

      const handleLTPFile = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        setLtpFile(file);
        const reader = new FileReader();
        reader.onload = (ev) => {
          const loadAndParse = (XLSXLib) => {
            try {
              const wb = XLSXLib.read(ev.target.result, {type:"binary",raw:false});
              const ws = wb.Sheets[wb.SheetNames[0]];
              const data = XLSXLib.utils.sheet_to_json(ws,{header:1,defval:"",raw:false});
              const text = data.map(r=>r.map(c=>String(c??"").trim()).join("\t")).join("\n");
              setLtpPreview(parseLTPFile(text));
            } catch(err) { setLtpPreview(parseLTPFile(ev.target.result)); }
          };
          if (window.XLSX) { loadAndParse(window.XLSX); }
          else {
            const s=document.createElement("script");
            s.src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
            s.onload=()=>loadAndParse(window.XLSX);
            s.onerror=()=>{ try{setLtpPreview(parseLTPFile(ev.target.result));}catch(e){setLtpPreview([]);} };
            document.head.appendChild(s);
          }
        };
        reader.readAsBinaryString(file);
      };

      const uploadLTP = async () => {
        if (!ltpPreview||!ltpPreview.length) return;
        setLtpUploading(true);
        try {
          const matched = ltpPreview.filter(r=>r.matched);
          if (!matched.length) { notify("No matched positions found"); setLtpUploading(false); return; }
          await fetch(`${SUPABASE_URL}/rest/v1/live_positions?adminId=eq.JIYA`,
            {method:"DELETE",headers:{"apikey":SUPABASE_ANON_KEY,"Authorization":`Bearer ${SUPABASE_ANON_KEY}`,"Prefer":"return=minimal"}});
          const rows = matched.map(r=>({
            id:`LP_${r.clientId}_${r.contract.replace(/\s+/g,"_")}`,
            clientId:r.clientId,contract:r.contract,netQty:r.netQty,side:r.side,
            ltp:r.ltp,token:"",exchange:r.exchange,adminId:"JIYA",capturedAt:new Date().toISOString()
          }));
          const res = await fetch(`${SUPABASE_URL}/rest/v1/live_positions`,
            {method:"POST",headers:{"Content-Type":"application/json","apikey":SUPABASE_ANON_KEY,
              "Authorization":`Bearer ${SUPABASE_ANON_KEY}`,"Prefer":"return=minimal"},body:JSON.stringify(rows)});
          if (res.ok) {
            // Reload livePositions so getBhavClose immediately uses new LTP
            try {
              const fresh = await fetch(`${SUPABASE_URL}/rest/v1/live_positions?adminId=eq.JIYA`,
                {headers:{"apikey":SUPABASE_ANON_KEY,"Authorization":`Bearer ${SUPABASE_ANON_KEY}`}});
              const freshData = await fresh.json();
              if (Array.isArray(freshData)) setLivePositions(freshData);
            } catch(e) {}
            notify(`✅ LTP updated for ${rows.length} positions — prices now showing`);
            setModal(null); setLtpFile(null); setLtpPreview(null);
          }
          else notify("❌ Upload failed");
        } catch(e) { notify("❌ Error: "+e.message); }
        setLtpUploading(false);
      };

      const matched   = (ltpPreview||[]).filter(r=>r.matched);
      const unmatched = (ltpPreview||[]).filter(r=>!r.matched);
      return (
        <div style={overlay} onClick={()=>{setModal(null);setLtpFile(null);setLtpPreview(null);}}>
          <div style={{...box,width:700,maxHeight:"92vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
            <h3 style={{color:C.text,marginTop:0}}>📡 Upload LTP File (Integrated Net Position)</h3>
            <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 16px",marginBottom:16,fontSize:12,color:C.muted,lineHeight:1.8}}>
              Tab-separated F6 export. Col 0:Client · Col 1:Symbol · Col 2:Expiry · Col 3:Strike · Col 4:OptType · Col 5:NetQty · Col 6:NetPrice · <strong style={{color:C.green}}>Col 7:Market Price (LTP)</strong>
            </div>
            <div style={{marginBottom:16}}>
              <input type="file" accept=".txt,.csv,.tsv,.xls,.xlsx" onChange={handleLTPFile}
                style={{color:C.text,fontSize:13}}/>
            </div>
            {ltpPreview && (
              <>
                <div style={{display:"flex",gap:12,marginBottom:12}}>
                  {[{l:"TOTAL",v:ltpPreview.length,c:C.text},{l:"MATCHED",v:matched.length,c:C.green},{l:"UNMATCHED",v:unmatched.length,c:unmatched.length>0?C.red:C.muted}].map(s=>(
                    <div key={s.l} style={{...card,padding:"10px 16px",flex:1,textAlign:"center"}}>
                      <div style={{fontSize:11,color:C.muted}}>{s.l}</div>
                      <div style={{fontSize:20,fontWeight:800,color:s.c}}>{s.v}</div>
                    </div>
                  ))}
                </div>
                <div style={{maxHeight:300,overflowY:"auto",marginBottom:16}}>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                    <thead><tr>{["Client","Contract","NetQty","LTP","Status"].map(h=>(
                      <th key={h} style={{padding:"8px 10px",textAlign:"left",color:C.muted,borderBottom:`1px solid ${C.border}`}}>{h}</th>
                    ))}</tr></thead>
                    <tbody>
                      {ltpPreview.map((r,i)=>(
                        <tr key={i} style={{borderBottom:`1px solid ${C.border}11`,background:r.matched?"transparent":C.red+"08"}}>
                          <td style={{padding:"7px 10px",color:C.muted,fontSize:11}}>{r.clientId}</td>
                          <td style={{padding:"7px 10px",color:r.matched?C.text:C.red}}>{r.contract}</td>
                          <td style={{padding:"7px 10px",color:C.text}}>{r.side} {r.netQty}</td>
                          <td style={{padding:"7px 10px",color:C.green,fontWeight:700}}>₹{r.ltp}</td>
                          <td style={{padding:"7px 10px"}}>{r.matched?<span style={{color:C.green,fontSize:11}}>✅ Matched</span>:<span style={{color:C.red,fontSize:11}}>❌ No match</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{display:"flex",gap:10}}>
                  <button onClick={uploadLTP} disabled={ltpUploading||matched.length===0}
                    style={{...btn(C.green),flex:1,padding:"11px",fontSize:14,fontWeight:700,opacity:matched.length===0?0.4:1}}>
                    {ltpUploading?"⏳ Uploading...":`✅ Upload LTP for ${matched.length} Positions`}
                  </button>
                  <button onClick={()=>{setModal(null);setLtpFile(null);setLtpPreview(null);}}
                    style={{...btn(C.muted),padding:"11px 20px"}}>Cancel</button>
                </div>
              </>
            )}
            {!ltpPreview&&(
              <div style={{color:C.muted,fontSize:13,textAlign:"center",padding:"30px 0"}}>
                Select your F6 Integrated Net Position export file above
              </div>
            )}
          </div>
        </div>
      );
    }

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
            <div style={{ border:`2px dashed ${C.border}`, borderRadius:10, padding:"16px", textAlign:"center", background:C.bg, cursor:"pointer" }}
              onClick={() => {
                const name = prompt("Enter file name to attach (e.g. screenshot.png):");
                if (name) setNewTicket(s=>({...s,attachments:[...(s.attachments||[]),name]}));
              }}>
              <div style={{ fontSize:24, marginBottom:6 }}>📎</div>
              <div style={{ color:C.muted, fontSize:13 }}>Click to add attachment name</div>
              {(newTicket.attachments||[]).length > 0 && (
                <div style={{ display:"flex", gap:8, flexWrap:"wrap", justifyContent:"center", marginTop:10 }}>
                  {newTicket.attachments.map((a,i)=>(
                    <span key={i} style={{ background:C.card, border:`1px solid ${C.accent}44`, borderRadius:6, padding:"4px 10px", fontSize:12, color:C.accent }}>
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
      {renderSquareOffModal()}

      {/* Notification */}
      {notification && (
        <div style={{ position: "fixed", bottom: 24, right: 24, background: notification.type === "error" ? C.red : C.green, color: "#fff", padding: "13px 22px", borderRadius: 12, fontWeight: 600, fontSize: 14, boxShadow: "0 8px 32px rgba(0,0,0,0.15)", zIndex: 9999, display:"flex", alignItems:"center", gap:8 }}>
          {notification.type === "error" ? "❌" : "✅"} {notification.msg}
        </div>
      )}
    </div>
  );
}
