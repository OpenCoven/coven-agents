import { GRACE_PERIOD_DAYS } from "./limits";

const DAY_MS = 86_400_000;

export type GraceInput = {
  billingReason: string;
  graceAlreadyApplied: boolean;
  subscribedUntil: Date | null;
};

/**
 * The new `subscribedUntil` after a failed invoice, or null for no change.
 *
 * Allow-listed on `subscription_cycle` rather than excluding
 * `subscription_create`, because a new billing reason added by Stripe should
 * default to granting nothing. An exclusion list would silently admit it.
 *
 * A renewal is by definition an extension of a period already paid for, so a
 * null `subscribedUntil` is refused even when the reason looks right: there is
 * nothing to extend, and extending from `now` would be a free subscription.
 */
export function graceExtension(input: GraceInput): Date | null {
  if (input.billingReason !== "subscription_cycle") {
    return null;
  }

  if (input.graceAlreadyApplied) {
    return null;
  }

  if (!input.subscribedUntil) {
    return null;
  }

  return new Date(input.subscribedUntil.getTime() + GRACE_PERIOD_DAYS * DAY_MS);
}
