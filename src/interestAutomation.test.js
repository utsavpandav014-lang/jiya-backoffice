import test from "node:test";
import assert from "node:assert/strict";
import { calculateDailyInterest } from "./interestAutomation.js";

test("calculates daily simple interest from annual rate",()=>{
  assert.equal(calculateDailyInterest(6_300_000,10),1726.03);
});

test("rejects unusable interest inputs",()=>{
  assert.equal(calculateDailyInterest(0,10),0);
  assert.equal(calculateDailyInterest(1_000_000,-1),0);
});
