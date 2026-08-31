export const ACCOUNT_TYPES = Object.freeze({ TRADING: "trading", INVESTOR: "investor", HYBRID: "hybrid" });

export const accountTypeLabel = (type) => ({ trading: "Trading Account", investor: "Investor Account", hybrid: "Hybrid Account" }[type] || "Trading Account");

export const normalizeMoney = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
};

export function validateClientCapital(client) {
  const errors = [];
  const type = client.accountType || "trading";
  const deposit = normalizeMoney(client.depositAmount);
  const strategyCapital = normalizeMoney(client.monthlyStrategyCapital);
  if (!["trading", "investor", "hybrid"].includes(type)) errors.push("Select a valid account type");
  if (["investor", "hybrid"].includes(type) && deposit <= 0) errors.push("Investor deposited fund must be greater than zero");
  if (["trading", "hybrid"].includes(type) && strategyCapital <= 0) errors.push("Monthly strategy capital must be greater than zero");
  return errors;
}

export function calculateOwnershipPct(allocatedAmount, strategyCapital) {
  const amount = normalizeMoney(allocatedAmount), capital = normalizeMoney(strategyCapital);
  if (amount <= 0 || capital <= 0) return 0;
  return Math.round((amount / capital) * 100000000) / 1000000;
}

export function getActiveAllocations(allocations, at = new Date()) {
  const timestamp = new Date(at).getTime();
  return (allocations || []).filter((a) => {
    const starts = new Date(a.effectiveFrom).getTime();
    const ends = a.effectiveTo ? new Date(a.effectiveTo).getTime() : Infinity;
    return a.status !== "closed" && starts <= timestamp && timestamp < ends;
  });
}

export function validateInvestorAllocation({ investorId, strategyId, allocatedAmount, effectiveFrom, reason, investorDeposit, investorActiveAllocated = 0, strategyCapital, strategyActiveAllocated = 0 }) {
  const errors = [];
  const amount = normalizeMoney(allocatedAmount), deposit = normalizeMoney(investorDeposit), capital = normalizeMoney(strategyCapital);
  if (!investorId) errors.push("Select an investor account");
  if (!strategyId) errors.push("Select a trading strategy");
  if (investorId && strategyId && investorId === strategyId) errors.push("Investor and strategy must be different accounts");
  if (amount <= 0) errors.push("Allocation amount must be greater than zero");
  if (!Number.isFinite(new Date(effectiveFrom).getTime())) errors.push("Enter a valid effective date and time");
  if (!String(reason || "").trim()) errors.push("Narration is mandatory");
  if (amount + normalizeMoney(investorActiveAllocated) > deposit) errors.push("Allocation exceeds the investor's available deposited fund");
  if (amount + normalizeMoney(strategyActiveAllocated) > capital) errors.push("Total investor allocation exceeds the strategy capital");
  return errors;
}
