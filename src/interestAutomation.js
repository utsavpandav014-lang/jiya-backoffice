export function calculateDailyInterest(capital, annualRate) {
  const principal=Number(capital), rate=Number(annualRate);
  if (!Number.isFinite(principal) || !Number.isFinite(rate) || principal<=0 || rate<=0) return 0;
  return Math.round((principal*rate/100/365+Number.EPSILON)*100)/100;
}
