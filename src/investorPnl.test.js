import test from "node:test";
import assert from "node:assert/strict";
import { investorPnlForMonth } from "./investorPnl.js";

test("keeps strategy P&L untouched and combines exact investor portions", () => {
  const strategyPnl = { A: 24500, B: -50000 };
  const result = investorPnlForMonth({
    investorId: "I1",
    yearMonth: "2026-09",
    allocations: [
      { investorClientId:"I1", strategyClientId:"A", ownershipPct:23.809524, effectiveFrom:"2026-09-01T01:31:00Z", status:"active" },
      { investorClientId:"I1", strategyClientId:"B", ownershipPct:23.809524, effectiveFrom:"2026-09-01T02:30:00Z", status:"active" },
    ],
    strategyPnl: (id) => strategyPnl[id],
  });
  assert.equal(strategyPnl.A, 24500);
  assert.equal(strategyPnl.B, -50000);
  assert.equal(result.pnl, -6071.43);
  assert.equal(result.complete, true);
});

test("does not guess mid-month P&L without an LTP snapshot", () => {
  const result = investorPnlForMonth({
    investorId:"I1", yearMonth:"2026-09",
    allocations:[{ investorClientId:"I1", strategyClientId:"A", ownershipPct:50, effectiveFrom:"2026-09-15T06:30:00Z", status:"active" }],
    strategyPnl:()=>10000,
  });
  assert.equal(result.pnl, 0);
  assert.equal(result.pendingCount, 1);
  assert.equal(result.complete, false);
});
