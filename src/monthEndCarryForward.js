const money = (value) => Math.round(Number(value) * 10000) / 10000;

export function getMonthBoundary(yearMonth) {
  if (!/^\d{4}-\d{2}$/.test(yearMonth || "")) throw new Error("Month must use YYYY-MM format");
  const [year, month] = yearMonth.split("-").map(Number);
  if (month < 1 || month > 12) throw new Error("Invalid month");
  const end = new Date(Date.UTC(year, month, 0));
  const next = new Date(Date.UTC(year, month, 1));
  return { monthEndDate:end.toISOString().slice(0,10), reopenDate:next.toISOString().slice(0,10) };
}

export function buildCarryForwardPreview({ yearMonth, openPositions, closingPrices, existingTrades = [] }) {
  const { monthEndDate, reopenDate } = getMonthBoundary(yearMonth);
  const batchId = `CF_${yearMonth.replace("-", "_")}`;
  const tradeBatchId = Number(monthEndDate.replaceAll("-", ""));
  const duplicate = existingTrades.some(t => Number(t.batchId) === tradeBatchId || String(t.id || "").includes(batchId));
  const positions = [...(openPositions || [])].sort((a,b) => `${a.clientId}|${a.contract}`.localeCompare(`${b.clientId}|${b.contract}`));
  const missingPrices = [];
  const entries = [];
  const trades = [];

  positions.forEach((position, index) => {
    const priceRecord = closingPrices?.[`${position.clientId}||${position.contract}`] || closingPrices?.[position.contract];
    const closingPrice = money(typeof priceRecord === "object" ? priceRecord?.closePrice : priceRecord);
    if (!(closingPrice > 0)) {
      missingPrices.push({ clientId:position.clientId, contract:position.contract });
      return;
    }
    const qty = Number(position.netQty);
    if (!(qty > 0)) return;
    const sequence = String(index + 1).padStart(5, "0");
    const closeSide = position.side === "BUY" ? "SELL" : "BUY";
    const common = {
      clientId:position.clientId, contract:position.contract, qty,
      price:closingPrice,
      exchange:position.contract.includes("SENSEX") || position.contract.includes("BANKEX") ? "BSE" : "NSE",
      instrType:position.contract.includes("FUT") ? "FUTURES" : "Options",
      scriptName:position.contract, scripCode:"", batchId:tradeBatchId,
    };
    const closeTrade = { ...common, id:`CF_CLOSE_${batchId}_${sequence}`, side:closeSide, date:monthEndDate, time:"23:59:59" };
    const reopenTrade = { ...common, id:`CF_OPEN_${batchId}_${sequence}`, side:position.side, date:reopenDate, time:"00:00:01" };
    trades.push(closeTrade, reopenTrade);
    entries.push({ clientId:position.clientId, contract:position.contract, side:position.side, qty, previousAvgPrice:Number(position.avgPrice)||0, closingPrice, closingPriceSource:typeof priceRecord === "object" ? priceRecord.source : "Closing price", closeTradeId:closeTrade.id, reopenTradeId:reopenTrade.id });
  });

  return {
    batchId, tradeBatchId, yearMonth, monthEndDate, reopenDate, positionCount:positions.length, entries, trades, missingPrices, duplicate,
    canExecute:positions.length > 0 && entries.length === positions.length && missingPrices.length === 0 && !duplicate,
  };
}

export function verifyCarryForwardPairs(preview) {
  const errors = [];
  for (const entry of preview?.entries || []) {
    const close = preview.trades.find(t => t.id === entry.closeTradeId);
    const reopen = preview.trades.find(t => t.id === entry.reopenTradeId);
    if (!close || !reopen) { errors.push(`${entry.clientId} ${entry.contract}: missing linked trade`); continue; }
    if (close.qty !== reopen.qty || close.price !== reopen.price) errors.push(`${entry.clientId} ${entry.contract}: quantity/price mismatch`);
    if (close.side === reopen.side) errors.push(`${entry.clientId} ${entry.contract}: closing side is invalid`);
    if (reopen.side !== entry.side) errors.push(`${entry.clientId} ${entry.contract}: reopened side changed`);
  }
  return errors;
}
