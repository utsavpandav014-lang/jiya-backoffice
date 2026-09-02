const monthStartMarketOpenUtc = (yearMonth) => {
  const [year, month] = String(yearMonth).split("-").map(Number);
  if (!year || !month) return NaN;
  // 09:15 Asia/Kolkata is 03:45 UTC. India does not observe daylight saving.
  return Date.UTC(year, month - 1, 1, 3, 45, 0, 0);
};

const monthEndUtc = (yearMonth) => {
  const [year, month] = String(yearMonth).split("-").map(Number);
  if (!year || !month) return NaN;
  return Date.UTC(year, month, 1, 0, 0, 0, 0) - 1;
};

export function investorPnlForMonth({ investorId, yearMonth, allocations = [], strategyPnl }) {
  const marketOpen = monthStartMarketOpenUtc(yearMonth);
  const monthEnd = monthEndUtc(yearMonth);
  const rows = allocations.filter((allocation) => {
    if (allocation.investorClientId !== investorId || allocation.status === "cancelled") return false;
    const starts = new Date(allocation.effectiveFrom).getTime();
    const ends = allocation.effectiveTo ? new Date(allocation.effectiveTo).getTime() : Infinity;
    return Number.isFinite(starts) && starts <= monthEnd && ends >= marketOpen;
  });

  let pnl = 0;
  let eligibleCount = 0;
  let pendingCount = 0;
  for (const allocation of rows) {
    const starts = new Date(allocation.effectiveFrom).getTime();
    // Full-month sharing is exact only when ownership existed before the first
    // market session. Mid-month sharing requires the separately captured LTP snapshot.
    const ends = allocation.effectiveTo ? new Date(allocation.effectiveTo).getTime() : Infinity;
    if (starts > marketOpen || ends < monthEnd) {
      pendingCount += 1;
      continue;
    }
    const ownership = Number(allocation.ownershipPct) / 100;
    if (!Number.isFinite(ownership) || ownership <= 0) continue;
    pnl += Number(strategyPnl(allocation.strategyClientId, yearMonth) || 0) * ownership;
    eligibleCount += 1;
  }

  return {
    pnl: Math.round((pnl + Number.EPSILON) * 100) / 100,
    eligibleCount,
    pendingCount,
    hasAllocations: rows.length > 0,
    complete: rows.length > 0 && pendingCount === 0,
  };
}
