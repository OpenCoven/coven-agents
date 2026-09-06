import { isSubscribedAt } from "../subscription";
import { CAMPAIGN_PERIOD_EPOCH, campaignGrantActiveAt } from "./campaign";
import { MONTHLY_MINUTE_CAP, RUN_MINUTE_RESERVATION } from "./limits";
import { periodStart } from "./period";

export type EntitlementAccount = Readonly<{
  billingPeriodStart: Date | null;
  campaignExpiresAt?: Date | null;
  campaignGrantedAt?: Date | null;
  subscribedUntil: Date | null;
}>;

/**
 * What a run is admitted with: the period its minutes are counted in, the
 * total it may draw from, and the minutes one run reserves.
 *
 * `costUnits` is both the reservation and the run's time limit. Admission
 * reserves it, and the reconciler stops the run when it has been running that
 * long — see `RunnerRun.entitlementMinutes`.
 */
export type RunEntitlement = Readonly<{
  costUnits: number;
  periodStart: Date;
  source: "campaign" | "subscription";
  tenantMonthlyCap: number;
}>;

/**
 * The entitlement a run should be admitted under, or null if the account has
 * none.
 *
 * A paid subscription wins over a campaign grant when an account holds both.
 * The subscription is larger in every dimension -- 300 minutes against 20,
 * 15-minute runs against 5 -- so spending the grant first would silently
 * downgrade a customer who paid, and hold their campaign minutes hostage
 * behind an expiry they no longer care about.
 *
 * Campaign minutes are counted against `CAMPAIGN_PERIOD_EPOCH` rather than a
 * rolling period, which is what makes the 20 minutes a lifetime total instead
 * of a monthly allowance that quietly refills.
 *
 * The daily cap is deliberately left at its default for campaign runs. It is
 * 100 minutes, five times the entire grant, so it can never bind first -- and
 * that matters for honesty, not just arithmetic: a refusal has to say "you are
 * out of campaign minutes", not "you hit a daily limit" the account could
 * never have reached.
 */
export function runEntitlementFor(
  account: EntitlementAccount | null | undefined,
  now: Date,
  campaignMinutes: Readonly<{ minutes: number; runMinutes: number }>
): RunEntitlement | null {
  if (!account) {
    return null;
  }

  /**
   * `isSubscribedAt` and not merely a non-null period. `periodStart` derives a
   * date from any `subscribedUntil`, including one already in the past, so
   * testing the period alone would hand a lapsed subscriber the full 300
   * minutes against a stale window. That was unreachable while the authority
   * check upstream demanded a live subscription; it stopped being unreachable
   * the moment campaign grants could satisfy that check instead.
   */
  const subscriptionPeriod = isSubscribedAt(account, now)
    ? periodStart(account.subscribedUntil, account.billingPeriodStart)
    : null;
  if (subscriptionPeriod) {
    return {
      costUnits: RUN_MINUTE_RESERVATION,
      periodStart: subscriptionPeriod,
      source: "subscription",
      tenantMonthlyCap: MONTHLY_MINUTE_CAP,
    };
  }

  if (
    campaignGrantActiveAt(account, now) &&
    campaignMinutes.minutes > 0 &&
    campaignMinutes.runMinutes > 0
  ) {
    return {
      costUnits: Math.min(campaignMinutes.runMinutes, campaignMinutes.minutes),
      periodStart: CAMPAIGN_PERIOD_EPOCH,
      source: "campaign",
      tenantMonthlyCap: campaignMinutes.minutes,
    };
  }

  return null;
}
