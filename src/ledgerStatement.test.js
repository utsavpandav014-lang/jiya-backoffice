import test from "node:test";
import assert from "node:assert/strict";
import { buildLedgerStatement, ledgerTotals } from "./ledgerStatement.js";

const rows = [
  { id:"3", clientId:"C1", date:"2026-08-01", credit:100, debit:0, ledgerType:"dp" },
  { id:"1", clientId:"C1", date:"2026-07-29", credit:0, debit:50, ledgerType:"all" },
  { id:"2", clientId:"C1", date:"2026-07-30", credit:200, debit:0, ledgerType:"dp" },
];

test("creates a chronological bank-statement running balance", () => {
  const statement = buildLedgerStatement(rows, "C1");
  assert.deepEqual(statement.map(row => row.balance), [-50, 150, 250]);
  assert.deepEqual(ledgerTotals(statement), {totalCredit:300,totalDebit:50,closingBalance:250});
});

test("recalculates every later balance after an entry is deleted", () => {
  const statement = buildLedgerStatement(rows.filter(row => row.id !== "2"), "C1");
  assert.deepEqual(statement.map(row => row.balance), [-50, 50]);
  assert.equal(ledgerTotals(statement).closingBalance, 50);
});

test("a filtered view retains balances from the complete statement", () => {
  const statement = buildLedgerStatement(rows, "C1");
  const dpRows = statement.filter(row => row.ledgerType === "dp");
  assert.deepEqual(dpRows.map(row => row.balance), [150, 250]);
  assert.equal(ledgerTotals(statement).closingBalance, 250);
});
