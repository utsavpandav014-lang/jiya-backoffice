import test from "node:test";
import assert from "node:assert/strict";
import { dailyTradingResults, positionsAsOfDate, tradingPatterns } from "./tradingInsights.js";

test("reconstructs positions using trades available by selected day", () => {
  const trades=[{date:"2026-09-01"},{date:"2026-09-02"}];
  const result=positionsAsOfDate(trades,"2026-09-01",rows=>({openPositions:rows,closedPositions:[]}));
  assert.equal(result.openPositions.length,1);
});

test("creates daily net pnl after charges", () => {
  const closed=[{trades:[{date:"2026-09-01",pnl:100},{date:"2026-09-01",pnl:-20}]}];
  assert.equal(dailyTradingResults(closed,()=>[{date:"2026-09-01",amount:10}])[0].netPnl,70);
});

test("finds profitable weekday and closing time patterns", () => {
  const closed=[{trades:[
    {date:"2026-09-07",time:"10:15:00 AM",pnl:100},
    {date:"2026-09-14",time:"10:30:00 AM",pnl:50},
    {date:"2026-09-08",time:"02:15:00 PM",pnl:-40},
  ]}];
  const result=tradingPatterns(closed);
  assert.equal(result.bestDay.label,"Monday");
  assert.equal(result.bestTime.hour,10);
  assert.equal(result.weakTime.hour,14);
});

test("excludes internal carry and out-of-market timestamps from timing patterns", () => {
  const result=tradingPatterns([{trades:[
    {date:"2026-09-01",time:"10:00:00 AM",pnl:20,sourceTradeId:"REAL1"},
    {date:"2026-09-01",time:"07:00:00 PM",pnl:-999,sourceTradeId:"REAL2"},
    {date:"2026-09-01",time:"03:29:00 PM",pnl:500,sourceTradeId:"CF_CLOSE_1"},
  ]}]);
  assert.deepEqual(result.hours.map(row=>row.hour),[10]);
  assert.equal(result.bestTime.pnl,20);
});
