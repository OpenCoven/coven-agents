/**
 * Runs included in a billing period.
 *
 * One constant, read by the pricing page, the usage endpoint and the
 * enforcement point. A cap quoted in three places that can disagree is worse
 * than no cap, because two of them will be a lie.
 *
 * 750 is about 25 runs a day. At the worst-case sandbox profile a fully
 * utilised 750 is roughly $1.70 of raw container cost against a $25 price, so
 * margin survives payment fees while the cap stays high enough that a daily
 * user never has to think about it.
 */
export const MONTHLY_RUN_CAP = 750;

/**
 * Days of access granted after a failed *renewal*, once.
 *
 * Stripe retries a failed card over roughly two weeks; without this an expired
 * card locks a paying customer out mid-run. Never applied to a first payment —
 * see `graceExtension`.
 */
export const GRACE_PERIOD_DAYS = 3;
