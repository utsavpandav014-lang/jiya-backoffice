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
