export function tradeDedupKey(trade) {
  return [trade.clientId, trade.contract, trade.side, Number(trade.qty), Number(trade.price), trade.date || "", trade.time || ""].join("|");
}

// Preserve legitimate repeated fills in one broker file while preventing a
// second upload of the same file from inserting another copy of every row.
export function missingTradeRows(incomingRows, existingRows) {
  const existingCounts = new Map();
  for (const row of existingRows || []) {
    const key = tradeDedupKey(row);
    existingCounts.set(key, (existingCounts.get(key) || 0) + 1);
  }
  const incomingCounts = new Map();
  return (incomingRows || []).filter((row) => {
    const key = tradeDedupKey(row);
    const occurrence = (incomingCounts.get(key) || 0) + 1;
    incomingCounts.set(key, occurrence);
    return occurrence > (existingCounts.get(key) || 0);
  });
}

export function assertSafeUndoBatch(rows, batchId, expectedCount) {
  if (!Number.isFinite(Number(batchId))) throw new Error("Invalid upload batch ID");
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("Upload batch no longer exists");
  if (Number.isFinite(Number(expectedCount)) && rows.length !== Number(expectedCount)) {
    throw new Error(`Safety check failed: expected ${expectedCount} trades but found ${rows.length}`);
  }
  if (rows.some((row) => Number(row.batchId) !== Number(batchId))) {
    throw new Error("Safety check failed: batch contains unrelated trades");
  }
  if (rows.some((row) => String(row.id || "").startsWith("CF_") || String(row.id || "").startsWith("SETTLE_"))) {
    throw new Error("Safety check failed: carry-forward or settlement rows cannot be undone as an upload");
  }
  return true;
}
