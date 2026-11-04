function calculatePnl(position, currentPrice) {
  const entryPrice = Number(position?.entryPrice);
  const price = Number(currentPrice);
  const sizeBase = Number(position?.sizeBase ?? position?.size ?? 0);
  if (!Number.isFinite(entryPrice) || !Number.isFinite(price) || !Number.isFinite(sizeBase)) return 0;
  if (position?.type === 'LONG') return (price - entryPrice) * sizeBase;
  if (position?.type === 'SHORT') return (entryPrice - price) * sizeBase;
  return 0;
}

/* Penanda posisi copy trade di Trading Ledger (2026-11-02, permintaan user).
 * Entry history bisa datang dari 3 jalur: server closedLog (origin),
 * browser fLog (origin, sejak fix futuresEngine), atau entry lama yang
 * hanya punya closeReason COPY_* — ketiganya harus ketanda, supaya jelas
 * mana posisi manual dan mana posisi copy trade. */
function isCopyTradeLedgerEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.origin === 'COPY_TRADE') return true;
  if (entry.copyMeta && entry.copyMeta.source) return true;
  const reason = String(entry.closeReason || '');
  return reason.startsWith('COPY_') || reason.includes('COPY_TRADE');
}

function ledgerReasonText(entry) {
  const base = entry ? String(entry.closeReason || entry.status || '') : '';
  return isCopyTradeLedgerEntry(entry) ? `Copy Trade: ${base}` : base;
}

if (typeof window !== 'undefined') {
  window.calculatePnl = calculatePnl;
  window.isCopyTradeLedgerEntry = isCopyTradeLedgerEntry;
  window.ledgerReasonText = ledgerReasonText;
}
if (typeof module !== 'undefined' && module.exports) module.exports = { calculatePnl, isCopyTradeLedgerEntry, ledgerReasonText };
