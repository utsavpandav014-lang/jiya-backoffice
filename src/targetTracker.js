export function targetTrackerState(pnlValue, targetValue) {
  const pnl = Number(pnlValue);
  const target = Number(targetValue);
  if (!Number.isFinite(pnl) || !Number.isFinite(target) || target <= 0) {
    return { configured:false, markerPct:25, progressPct:0, remaining:0, status:"not-configured" };
  }
  const progressPct = (pnl / target) * 100;
  let markerPct;
  if (pnl < 0) markerPct = 25 - Math.min(Math.abs(pnl) / target, 1) * 25;
  else if (pnl <= target) markerPct = 25 + (pnl / target) * 55;
  else markerPct = 80 + Math.min((pnl - target) / (target * 0.25), 1) * 20;
  const status = pnl < 0 ? "loss" : pnl < target ? "progress" : "caution";
  return {
    configured:true,
    markerPct:Math.max(0, Math.min(100, markerPct)),
    progressPct,
    remaining:Math.max(0, target - pnl),
    buffer:Math.max(0, pnl - target),
    status,
  };
}

export function daysRemainingInMonth(now = new Date()) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) return 0;
  const finalDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  return Math.max(0, finalDay - date.getDate());
}
