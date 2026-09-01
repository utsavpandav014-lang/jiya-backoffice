import test from "node:test";
import assert from "node:assert/strict";
import { hasGenuineTradeForMonth, isCarryForwardTrade } from "./monthPnlAttribution.js";

test("recognizes both internal carry-forward trade sides", () => {
  assert.equal(isCarryForwardTrade({id:"CF_CLOSE_CF_2026_08_00001"}), true);
  assert.equal(isCarryForwardTrade({id:"CF_OPEN_CF_2026_08_00001"}), true);
});

test("carry reopen alone does not activate new-month P&L", () => {
  const trades = [{id:"CF_OPEN_CF_2026_08_00001",date:"2026-09-01"}];
  assert.equal(hasGenuineTradeForMonth(trades, "2026-09"), false);
});

test("an uploaded trade activates new-month P&L", () => {
  const trades = [
    {id:"CF_OPEN_CF_2026_08_00001",date:"2026-09-01"},
    {id:"BROKER_20260901_1",date:"2026-09-01"},
  ];
  assert.equal(hasGenuineTradeForMonth(trades, "2026-09"), true);
});
