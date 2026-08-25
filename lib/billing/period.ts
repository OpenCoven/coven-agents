/**
 * The start of the billing period a run counts against.
 *
 * Derived from the renewal date rather than the calendar month, because a
 * subscription that starts on the 20th resets on the 20th and that is what the
 * customer's statement says.
 *
 * Stepping back a month is clamped to the last valid day, because JavaScript
 * rolls an impossible date forward — 31 March minus one month becomes 3 March
 * — which would shorten the period and undercount usage. Setting the day to 1
 * before changing the month is what keeps that roll from happening at all.
 */
export function periodStart(subscribedUntil: Date | null): Date | null {
  if (!subscribedUntil) {
    return null;
  }

  const start = new Date(subscribedUntil.getTime());
  const day = start.getUTCDate();

  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth() - 1);

  // Day 0 of the following month is the last day of this one, which handles
  // both short months and leap years without a table.
  const lastDayOfMonth = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)
  ).getUTCDate();

  start.setUTCDate(Math.min(day, lastDayOfMonth));

  return start;
}
