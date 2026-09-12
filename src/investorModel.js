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
  const adhocDeposit = normalizeMoney(client.adhocDeposit);
  if (!["trading", "investor", "hybrid"].includes(type)) errors.push("Select a valid account type");
  if (["investor", "hybrid"].includes(type) && deposit <= 0) errors.push("Investor deposited fund must be greater than zero");
  if (["trading", "hybrid"].includes(type) && strategyCapital <= 0) errors.push("Monthly strategy capital must be greater than zero");
  if (adhocDeposit < 0) errors.push("Adhoc deposit cannot be negative");
  return errors;
}

export function calculateOwnershipPct(allocatedAmount, strategyCapital) {
  const amount = normalizeMoney(allocatedAmount), capital = normalizeMoney(strategyCapital);
  if (amount <= 0 || capital <= 0) return 0;
  return Math.round((amount / capital) * 100000000) / 1000000;
}

export function calculateAllocationAmount(ownershipPct, strategyCapital) {
  const percentage = Number(ownershipPct), capital = normalizeMoney(strategyCapital);
  if (!Number.isFinite(percentage) || percentage <= 0 || capital <= 0) return 0;
  return normalizeMoney(capital * percentage / 100);
}

export function validateAllocationChange({ allocatedAmount, effectiveFrom, reason, originalEffectiveFrom, investorDeposit, investorOtherAllocated = 0, strategyCapital, strategyOtherAllocated = 0, now = new Date() }) {
  const errors = [];
  const amount = normalizeMoney(allocatedAmount), deposit = normalizeMoney(investorDeposit), capital = normalizeMoney(strategyCapital);
  const effective = new Date(effectiveFrom).getTime(), original = new Date(originalEffectiveFrom).getTime(), current = new Date(now).getTime();
  if (amount <= 0) errors.push("Allocation amount must be greater than zero");
  if (!Number.isFinite(effective)) errors.push("Enter a valid effective date and time");
  if (Number.isFinite(effective) && Number.isFinite(original) && effective <= original) errors.push("Change date must be after the original allocation start");
  if (Number.isFinite(effective) && Number.isFinite(current) && effective > current + 5 * 60 * 1000) errors.push("Change date cannot be in the future");
  if (!String(reason || "").trim()) errors.push("Narration is mandatory");
  if (amount + normalizeMoney(investorOtherAllocated) > deposit) errors.push("Allocation exceeds the investor's available deposited fund");
  if (amount + normalizeMoney(strategyOtherAllocated) > capital) errors.push("Total investor allocation exceeds the strategy capital");
  return errors;
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
