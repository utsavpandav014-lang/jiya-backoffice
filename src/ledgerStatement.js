const entryTimestamp = entry => entry?.createdAt || entry?.created_at || "";

export function buildLedgerStatement(entries, clientId) {
  let balance = 0;
  return (entries || [])
    .filter(entry => entry.clientId === clientId)
    .map(entry => ({
      ...entry,
      credit: Number(entry.credit) || 0,
      debit: Number(entry.debit) || 0,
    }))
    .sort((a, b) =>
      String(a.date || "").localeCompare(String(b.date || "")) ||
      String(entryTimestamp(a)).localeCompare(String(entryTimestamp(b))) ||
      String(a.id || "").localeCompare(String(b.id || ""))
    )
    .map(entry => {
      balance += entry.credit - entry.debit;
      return { ...entry, balance };
    });
}

export function ledgerTotals(statement) {
  const rows = statement || [];
  return {
    totalCredit: rows.reduce((sum, row) => sum + row.credit, 0),
    totalDebit: rows.reduce((sum, row) => sum + row.debit, 0),
    closingBalance: rows.length ? rows[rows.length - 1].balance : 0,
  };
}
