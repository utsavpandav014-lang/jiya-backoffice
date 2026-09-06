const roundMoney = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const isInternalCarry = match => /^(CF_CLOSE_|CF_OPEN_|ME_CLOSE_|ME_OPEN_)/i.test(String(match?.sourceTradeId || match?.id || ""));

function marketHour(time) {
  const parsed = String(time || "").match(/(\d+):(\d+)(?::\d+)?\s*(AM|PM)?/i);
  if (!parsed) return null;
  let hour=Number(parsed[1]); const minute=Number(parsed[2]), meridiem=(parsed[3]||"").toUpperCase();
  if (meridiem==="PM" && hour!==12) hour+=12;
  if (meridiem==="AM" && hour===12) hour=0;
  const minutes=hour*60+minute;
  return minutes>=555 && minutes<=930 ? hour : null;
}

export function positionsAsOfDate(trades, selectedDate, fifo) {
  if (!selectedDate || typeof fifo !== "function") return { openPositions:[], closedPositions:[] };
  return fifo((trades || []).filter(trade => String(trade.date || "") <= selectedDate));
}

export function dailyTradingResults(closedPositions, tradeCharges = () => 0) {
  const days = new Map();
  for (const position of closedPositions || []) {
    for (const match of position.trades || []) {
      if (!match.date || isInternalCarry(match)) continue;
      const row = days.get(match.date) || { date:match.date, grossPnl:0, charges:0, netPnl:0, matches:0 };
      row.grossPnl += Number(match.pnl || 0);
      row.matches += 1;
      days.set(match.date, row);
    }
  }
  for (const charge of tradeCharges() || []) {
    if (!charge?.date) continue;
    const row = days.get(charge.date) || { date:charge.date, grossPnl:0, charges:0, netPnl:0, matches:0 };
    row.charges += Number(charge.amount || 0);
    days.set(charge.date, row);
  }
  return [...days.values()].map(row => ({...row,grossPnl:roundMoney(row.grossPnl),charges:roundMoney(row.charges),netPnl:roundMoney(row.grossPnl-row.charges)})).sort((a,b)=>a.date.localeCompare(b.date));
}

const percentage = (wins, total) => total ? Math.round(wins * 1000 / total) / 10 : 0;

export function tradingPatterns(closedPositions) {
  const weekdayNames = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const weekday = weekdayNames.map(label => ({label,profit:0,loss:0,pnl:0,trades:0}));
  const hour = Array.from({length:24},(_,h)=>({hour:h,label:`${String(h).padStart(2,"0")}:00–${String(h).padStart(2,"0")}:59`,profit:0,loss:0,pnl:0,trades:0}));
  for (const position of closedPositions || []) {
    for (const match of position.trades || []) {
      if (!match.date || isInternalCarry(match)) continue;
      const pnl = Number(match.pnl || 0);
      const day = new Date(`${match.date}T00:00:00Z`).getUTCDay();
      const h = marketHour(match.time);
      for (const bucket of [weekday[day], h!==null&&h>=0&&h<24 ? hour[h] : null].filter(Boolean)) {
        bucket.pnl += pnl; bucket.trades += 1;
        if (pnl >= 0) bucket.profit += 1; else bucket.loss += 1;
      }
    }
  }
  const finish = rows => rows.filter(r=>r.trades).map(r=>({...r,pnl:roundMoney(r.pnl),winRate:percentage(r.profit,r.trades)}));
  const weekdays = finish(weekday);
  const hours = finish(hour);
  const bestTime = [...hours].sort((a,b)=>b.winRate-a.winRate || b.pnl-a.pnl)[0] || null;
  const weakTime = [...hours].sort((a,b)=>a.winRate-b.winRate || a.pnl-b.pnl)[0] || null;
  const bestDay = [...weekdays].sort((a,b)=>b.winRate-a.winRate || b.pnl-a.pnl)[0] || null;
  return { weekdays, hours, bestTime, weakTime, bestDay };
}
