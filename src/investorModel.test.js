import test from "node:test";
import assert from "node:assert/strict";
import { calculateOwnershipPct, getActiveAllocations, validateClientCapital, validateInvestorAllocation } from "./investorModel.js";

test("calculates ownership from rupees", () => assert.equal(calculateOwnershipPct(2_000_000, 5_000_000), 40));
test("requires capital by account type", () => {
  assert.deepEqual(validateClientCapital({ accountType: "trading", monthlyStrategyCapital: 0 }), ["Monthly strategy capital must be greater than zero"]);
  assert.deepEqual(validateClientCapital({ accountType: "investor", depositAmount: 0 }), ["Investor deposited fund must be greater than zero"]);
  assert.deepEqual(validateClientCapital({ accountType: "hybrid", depositAmount: 1, monthlyStrategyCapital: 1 }), []);
});
test("blocks allocation above deposit", () => {
  const errors = validateInvestorAllocation({ investorId:"INV1", strategyId:"A", allocatedAmount:300000, effectiveFrom:"2026-08-15T12:00", reason:"Increase", investorDeposit:1000000, investorActiveAllocated:800000, strategyCapital:5000000 });
  assert.ok(errors.includes("Allocation exceeds the investor's available deposited fund"));
});
test("blocks strategy above 100 percent", () => {
  const errors = validateInvestorAllocation({ investorId:"INV1", strategyId:"A", allocatedAmount:600000, effectiveFrom:"2026-08-15T12:00", reason:"New", investorDeposit:1000000, strategyCapital:5000000, strategyActiveAllocated:4500000 });
  assert.ok(errors.includes("Total investor allocation exceeds the strategy capital"));
});
test("allows one investor to add multiple strategies within remaining fund", () => {
  const secondStrategy = validateInvestorAllocation({ investorId:"INV1", strategyId:"B", allocatedAmount:1_000_000, effectiveFrom:"2026-09-01T09:30", reason:"Diversification", investorDeposit:3_000_000, investorActiveAllocated:1_500_000, strategyCapital:5_000_000, strategyActiveAllocated:0 });
  assert.deepEqual(secondStrategy, []);
  const exceedsRemaining = validateInvestorAllocation({ investorId:"INV1", strategyId:"C", allocatedAmount:600_000, effectiveFrom:"2026-09-01T09:31", reason:"Diversification", investorDeposit:3_000_000, investorActiveAllocated:2_500_000, strategyCapital:5_000_000, strategyActiveAllocated:0 });
  assert.ok(exceedsRemaining.includes("Allocation exceeds the investor's available deposited fund"));
});
test("preserves timestamped periods", () => {
  const periods = [{ effectiveFrom:"2026-08-15T12:00:00Z", effectiveTo:"2026-08-21T09:00:00Z", status:"closed" }, { effectiveFrom:"2026-08-21T09:00:00Z", effectiveTo:null, status:"active" }];
  assert.equal(getActiveAllocations(periods, "2026-08-22T00:00:00Z").length, 1);
});
