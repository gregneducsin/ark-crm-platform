/**
 * Pure calculation logic, deliberately kept out of the persistence layer so
 * it's cheap to unit test without a database (see the testing strategy in
 * ARCHITECTURE.md) and reusable from the dashboard for a live preview
 * before submit.
 *
 * Uses plain floating-point multiply + toFixed(2), not arbitrary-precision
 * decimal arithmetic — acceptable for this domain (typical hourly wages,
 * not high-frequency financial calculation) since both inputs are
 * 2-decimal-precision currency/hour values well within float64's exact
 * range for values this size.
 */
export function calculateHourlyEarnings(hoursWorked: string, hourlyRate: string): string {
  const hours = Number(hoursWorked);
  const rate = Number(hourlyRate);
  if (!Number.isFinite(hours) || !Number.isFinite(rate)) {
    throw new Error(`Invalid numeric input: hoursWorked=${hoursWorked}, hourlyRate=${hourlyRate}`);
  }
  return (hours * rate).toFixed(2);
}

/**
 * Total pay for a week: hourly earnings + commission + bonuses. All amounts
 * are decimal strings in, decimal string out.
 */
export function calculateWeeklyTotal(parts: { hourlyEarnings: string; commissionAmount?: string | null; bonusAmounts?: string[] }): string {
  const hourly = Number(parts.hourlyEarnings);
  const commission = parts.commissionAmount ? Number(parts.commissionAmount) : 0;
  const bonuses = (parts.bonusAmounts ?? []).reduce((sum, b) => sum + Number(b), 0);
  return (hourly + commission + bonuses).toFixed(2);
}
