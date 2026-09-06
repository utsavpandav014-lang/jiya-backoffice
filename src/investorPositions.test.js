import test from "node:test";
import assert from "node:assert/strict";
import { investorPositions, roundToNearestLot } from "./investorPositions.js";

test("rounds an allocated quantity to the nearest exchange lot", () => {
  assert.equal(roundToNearestLot(357.14, 65), 325);
  assert.equal(roundToNearestLot(390, 65), 390);
});

test("combines active allocated strategy positions without exposing strategy splits", () => {
  const positions = investorPositions({
    investorId:"I1",
    at:"2026-09-06T10:00:00Z",
    allocations:[
      {investorClientId:"I1",strategyClientId:"A",ownershipPct:40,effectiveFrom:"2026-09-01T01:00:00Z",status:"active"},
      {investorClientId:"I1",strategyClientId:"B",ownershipPct:20,effectiveFrom:"2026-09-01T01:00:00Z",status:"active"},
    ],
    strategyPositions:[
      {clientId:"A",contract:"SENSEX 78700 CE",side:"SELL",netQty:1500,avgPrice:100},
      {clientId:"B",contract:"SENSEX 78700 CE",side:"SELL",netQty:1500,avgPrice:80},
    ],
    lotSizeForPosition:()=>20,
  });
  assert.deepEqual(positions, [{
    clientId:"I1", contract:"SENSEX 78700 CE", side:"SELL", netQty:900,
    avgPrice:93.33, bookedPnl:0, openLots:[], lotSize:20,
  }]);
});

test("does not show positions before the allocation start date", () => {
  const positions = investorPositions({
    investorId:"I1",
    at:"2026-09-06T10:00:00Z",
    allocations:[{investorClientId:"I1",strategyClientId:"A",ownershipPct:50,effectiveFrom:"2026-09-10T01:00:00Z",status:"active"}],
    strategyPositions:[{clientId:"A",contract:"NIFTY FUT",side:"BUY",netQty:650,avgPrice:24000}],
    lotSizeForPosition:()=>65,
  });
  assert.deepEqual(positions, []);
});

test("historical view includes an allocation that closed later", () => {
  const positions=investorPositions({
    investorId:"INV1",at:"2026-09-10T10:00:00Z",
    allocations:[{investorClientId:"INV1",strategyClientId:"S1",ownershipPct:50,effectiveFrom:"2026-09-01T00:00:00Z",effectiveTo:"2026-09-20T00:00:00Z",status:"closed"}],
    strategyPositions:[{clientId:"S1",contract:"NIFTY FUT",side:"BUY",netQty:100,avgPrice:25000}],
  });
  assert.equal(positions.length,1);
  assert.equal(positions[0].netQty,50);
});
