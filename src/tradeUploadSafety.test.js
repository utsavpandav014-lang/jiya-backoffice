import test from "node:test";
import assert from "node:assert/strict";
import { assertSafeUndoBatch, missingTradeRows } from "./tradeUploadSafety.js";

const row = (overrides={}) => ({
  id:"T1", batchId:1, clientId:"SNM3343A", contract:"NIFTY 24000 CE 22SEP2026",
  side:"BUY", qty:65, price:10, date:"2026-09-22", time:"10:00:00", ...overrides,
});

test("a complete re-upload inserts no duplicate rows", () => {
  const incoming=[row({id:"N1"}),row({id:"N2"}),row({id:"N3",price:11})];
  const existing=[row({id:"E1"}),row({id:"E2"}),row({id:"E3",price:11})];
  assert.equal(missingTradeRows(incoming,existing).length,0);
});

test("legitimate identical fills retain their multiplicity", () => {
  const incoming=[row({id:"N1"}),row({id:"N2"})];
  const existing=[row({id:"E1"})];
  assert.deepEqual(missingTradeRows(incoming,existing).map(x=>x.id),["N2"]);
});

test("undo rejects count mismatch and protected accounting rows", () => {
  assert.throws(()=>assertSafeUndoBatch([row()],1,2),/expected 2 trades/);
  assert.throws(()=>assertSafeUndoBatch([row({id:"CF_OPEN_X"})],1,1),/cannot be undone/);
  assert.throws(()=>assertSafeUndoBatch([row({id:"SETTLE_X"})],1,1),/cannot be undone/);
});

test("undo accepts one exact ordinary upload batch", () => {
  assert.equal(assertSafeUndoBatch([row(),row({id:"T2"})],1,2),true);
});
