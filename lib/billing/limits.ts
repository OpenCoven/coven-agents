/**
 * Minutes of agent run time included in a billing period.
 *
 * One constant, read by the pricing copy, the usage endpoint and the
 * enforcement point. A cap quoted in three places that can disagree is worse
 * than no cap, because two of them will be a lie.
 *
 * The plan is a prepaid bucket: 300 minutes for the configured monthly price,
 * drained by the minutes each run actually held. Nothing is billed per run
 * and nothing is billed beyond the price.
 */
export const MONTHLY_MINUTE_CAP = 300;

/**
 * Minutes a single run reserves when it is admitted.
 *
 * A run's duration is unknown until it ends, so admission reserves the most a
 * run can hold, which is the runner's execution time limit, and terminal
 * cleanup settles the reservation down to the whole minutes actually used.
 * Reserving the maximum keeps admission fail-closed: the cap can never be
 * exceeded by a run that was admitted with less than a full run remaining.
 *
 * Kept equal to `RUNNER_MID_RUN_ENTITLEMENT_POLICY.maxDurationMs` by a test
 * rather than by import, so billing stays free of runner modules.
 */
export const RUN_MINUTE_RESERVATION = 15;

/**
 * Days of access granted after a failed *renewal*, once.
 *
 * Stripe retries a failed card over roughly two weeks; without this an expired
 * card locks a paying customer out mid-run. Never applied to a first payment —
 * see `graceExtension`.
 */
export const GRACE_PERIOD_DAYS = 3;
