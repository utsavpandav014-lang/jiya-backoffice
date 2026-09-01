import test from "node:test";
import assert from "node:assert/strict";
import { daysRemainingInMonth, targetTrackerState } from "./targetTracker.js";

test("moves a loss left into the red zone", () => {
  const state = targetTrackerState(-1500, 40000);
  assert.equal(state.status, "loss");
  assert.ok(state.markerPct < 25);
});

test("uses cumulative original P&L value for target progress", () => {
  const state = targetTrackerState(13500, 40000);
  assert.equal(state.progressPct, 33.75);
  assert.equal(state.remaining, 26500);
  assert.ok(state.markerPct > 25 && state.markerPct < 80);
});

test("moves profit above target into caution zone", () => {
  const state = targetTrackerState(46000, 40000);
  assert.equal(state.status, "caution");
  assert.equal(state.buffer, 6000);
  assert.ok(state.markerPct > 80);
});

test("counts remaining calendar days without inventing market data", () => {
  assert.equal(daysRemainingInMonth(new Date(2026, 8, 1)), 29);
});
