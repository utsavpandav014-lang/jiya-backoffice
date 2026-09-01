import test from "node:test";
import assert from "node:assert/strict";
import { closedPositionSlicesForMonth, closedPositionSlicesInFilter, hasGenuineTradeForMonth, isCarryForwardTrade } from "./monthPnlAttribution.js";

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

test("attributes FIFO match profit to its actual closing month", () => {
  const closed = [{contract:"WIPRO FUT 29SEP2026",totalPnl:10890,trades:[
    {date:"2026-08-31",pnl:10890},
  ]}];
  assert.equal(closedPositionSlicesForMonth(closed,"2026-08")[0].totalPnl,10890);
  assert.deepEqual(closedPositionSlicesForMonth(closed,"2026-09"),[]);
});

test("does not move an August close into September because of a September reopen", () => {
  const closed = [{contract:"WIPRO FUT 29SEP2026",totalPnl:10890,trades:[
    {date:"2026-08-31",pnl:10890},
  ]}];
  const september = closedPositionSlicesInFilter(closed, month => month === "2026-09");
  assert.equal(september.length,0);
});
