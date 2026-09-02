/**
 * Ceiling on minutes of agent run time in one billing period.
 *
 * One constant, read by the pricing copy, the usage endpoint and the
 * enforcement point. A cap quoted in three places that can disagree is worse
 * than no cap, because two of them will be a lie.
 *
 * Minutes are not included in the base price: the subscription is a monthly
 * base fee plus a metered per-minute charge, both configured in Stripe. This
 * ceiling is a spend guard, not an allowance. A minute of the default sandbox
 * profile (2 vCPU, 4 GiB, 20 GiB) costs roughly $0.0028 at Daytona list
 * pricing, so at the intended $0.10 per minute the metered charge covers the
 * container many times over; the base fee covers the sandbox's idle time and
 * stopped disk. 1,500 minutes is about 50 minutes a day, high enough that a
 * daily user never has to think about it and low enough that a runaway agent
 * cannot produce a surprise invoice.
 */
export const MONTHLY_MINUTE_CAP = 1500;

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
