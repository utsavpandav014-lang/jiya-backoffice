const roundMoney = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

export function roundToNearestLot(quantity, lotSize = 1) {
  const qty = Number(quantity);
  const lot = Math.max(1, Number(lotSize) || 1);
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  return Math.round(qty / lot) * lot;
}

export function investorPositions({
  investorId,
  allocations = [],
  strategyPositions = [],
  at = new Date(),
  lotSizeForPosition = () => 1,
}) {
  const timestamp = new Date(at).getTime();
  if (!investorId || !Number.isFinite(timestamp)) return [];

  const active = allocations.filter(allocation => {
    const starts = new Date(allocation.effectiveFrom).getTime();
    const ends = allocation.effectiveTo ? new Date(allocation.effectiveTo).getTime() : Infinity;
    return allocation.investorClientId === investorId &&
      allocation.status !== "closed" && allocation.status !== "cancelled" &&
      Number.isFinite(starts) && starts <= timestamp && timestamp < ends;
  });

  const combined = new Map();
  for (const allocation of active) {
    const ownership = Number(allocation.ownershipPct) / 100;
    if (!Number.isFinite(ownership) || ownership <= 0) continue;
    for (const position of strategyPositions) {
      if (position.clientId !== allocation.strategyClientId) continue;
      const lotSize = Math.max(1, Number(lotSizeForPosition(position)) || 1);
      const allocatedQty = roundToNearestLot(Number(position.netQty) * ownership, lotSize);
      if (!(allocatedQty > 0)) continue;
      const signedQty = position.side === "SELL" ? -allocatedQty : allocatedQty;
      const current = combined.get(position.contract) || { signedQty:0, signedCost:0, lotSize };
      current.signedQty += signedQty;
      current.signedCost += signedQty * Number(position.avgPrice || 0);
      current.lotSize = Math.min(current.lotSize, lotSize);
      combined.set(position.contract, current);
    }
  }

  return [...combined.entries()].map(([contract, position]) => {
    if (Math.abs(position.signedQty) < 0.0001) return null;
    const side = position.signedQty < 0 ? "SELL" : "BUY";
    const netQty = Math.abs(position.signedQty);
    return {
      clientId: investorId,
      contract,
      side,
      netQty,
      avgPrice: roundMoney(position.signedCost / position.signedQty),
      bookedPnl: 0,
      openLots: [],
      lotSize: position.lotSize,
    };
  }).filter(Boolean).sort((a,b) => a.contract.localeCompare(b.contract));
}
