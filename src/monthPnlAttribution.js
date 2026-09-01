export function isCarryForwardTrade(trade) {
  return /^CF_(?:CLOSE|OPEN)_/.test(String(trade?.id || ""));
}

export function hasGenuineTradeForMonth(trades, yearMonth) {
  if (!/^\d{4}-\d{2}$/.test(String(yearMonth || ""))) return false;
  return (trades || []).some(trade =>
    String(trade?.date || "").slice(0, 7) === yearMonth &&
    !isCarryForwardTrade(trade)
  );
}

// FIFO stays untouched. Monthly reporting is derived from the dated match rows
// emitted by FIFO, never by assigning a contract's all-time total to one month.
export function closedPositionSlicesForMonth(closedPositions, yearMonth) {
  if (!/^\d{4}-\d{2}$/.test(String(yearMonth || ""))) return [];
  return (closedPositions || []).map(position => {
    const monthTrades = (position.trades || []).filter(trade =>
      String(trade?.date || "").slice(0, 7) === yearMonth
    );
    if (!monthTrades.length) return null;
    return {
      ...position,
      trades: monthTrades,
      totalPnl: monthTrades.reduce((sum, trade) => sum + (Number(trade?.pnl) || 0), 0),
    };
  }).filter(Boolean);
}

export function closedPositionSlicesInFilter(closedPositions, monthPredicate) {
  return (closedPositions || []).map(position => {
    const filteredTrades = (position.trades || []).filter(trade =>
      monthPredicate(String(trade?.date || "").slice(0, 7))
    );
    if (!filteredTrades.length) return null;
    return {
      ...position,
      trades: filteredTrades,
      totalPnl: filteredTrades.reduce((sum, trade) => sum + (Number(trade?.pnl) || 0), 0),
    };
  }).filter(Boolean);
}
