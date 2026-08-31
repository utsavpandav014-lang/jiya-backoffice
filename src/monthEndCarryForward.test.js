import test from "node:test";
import assert from "node:assert/strict";
import { buildCarryForwardPreview, getMonthBoundary, verifyCarryForwardPairs } from "./monthEndCarryForward.js";

test("uses 31 August and reopens 1 September", () => {
  assert.deepEqual(getMonthBoundary("2026-08"), { monthEndDate:"2026-08-31", reopenDate:"2026-09-01" });
});

test("creates an opposite close and identical fresh reopen", () => {
  const preview = buildCarryForwardPreview({
    yearMonth:"2026-08",
    openPositions:[{ clientId:"A", contract:"RELIANCE FUT 24SEP2026", side:"BUY", netQty:500, avgPrice:2000 }],
    closingPrices:{ "RELIANCE FUT 24SEP2026":2050 },
  });
  assert.equal(preview.trades[0].side, "SELL");
  assert.equal(preview.trades[1].side, "BUY");
  assert.equal(preview.trades[0].price, 2050);
  assert.equal(preview.trades[1].price, 2050);
  assert.equal(preview.trades[1].qty, 500);
  assert.equal(preview.tradeBatchId, 20260831);
  assert.equal(preview.trades[0].batchId, 20260831);
  assert.deepEqual(verifyCarryForwardPairs(preview), []);
  assert.equal(preview.canExecute, true);
});

test("blocks execution when any closing price is missing", () => {
  const preview = buildCarryForwardPreview({ yearMonth:"2026-08", openPositions:[{clientId:"A",contract:"NIFTY FUT",side:"SELL",netQty:75}], closingPrices:{} });
  assert.equal(preview.canExecute, false);
  assert.equal(preview.missingPrices.length, 1);
});

test("blocks duplicate month processing", () => {
  const preview = buildCarryForwardPreview({ yearMonth:"2026-08", openPositions:[{clientId:"A",contract:"NIFTY FUT",side:"SELL",netQty:75}], closingPrices:{"NIFTY FUT":100}, existingTrades:[{batchId:20260831}] });
  assert.equal(preview.duplicate, true);
  assert.equal(preview.canExecute, false);
});
