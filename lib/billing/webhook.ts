import { graceExtension } from "./grace";
import { periodStart } from "./period";

export type SubscriptionUpdate = {
  billingPeriodStart: Date;
  subscribedUntil: Date;
} | null;

/** Keeps normalized entitlement monotonic under delayed/out-of-order delivery. */
export function advancingSubscriptionUpdate(
  current: Date | null,
  update: SubscriptionUpdate
): SubscriptionUpdate {
  if (!update) {
    return null;
  }
  return !current || update.subscribedUntil > current ? update : null;
}

/**
 * What a Stripe event changes about `subscribedUntil`, if anything.
 *
 * Pure, so the decision that grants paid access is testable without a webhook
 * delivery. Allow-listed on event type: an event Stripe adds later defaults to
 * changing nothing rather than falling into a branch it was never considered
 * for.
 *
 * A cancellation deliberately revokes nothing. The period is already paid for,
 * and access ends when the date passes.
 */
export function subscriptionUpdate(input: {
  billingReason: string;
  current: Date | null;
  currentPeriodStart?: Date | null;
  periodEnd: Date | null;
  periodStart?: Date | null;
  type: string;
}): SubscriptionUpdate {
  if (input.type === "invoice.paid") {
    // No date means nothing to grant. Defaulting to "now plus a month" would
    // invent a subscription the invoice never described.
    const billingPeriodStart =
      input.periodStart ?? periodStart(input.periodEnd);
    return input.periodEnd && billingPeriodStart
      ? {
          billingPeriodStart,
          subscribedUntil: input.periodEnd,
        }
      : null;
  }

  if (input.type === "invoice.payment_failed") {
    // A failed event without the provider's affected paid-period boundary is
    // not strong enough evidence to extend access. Otherwise a delayed or
    // malformed failure could add grace to a newer successful renewal.
    if (!input.periodEnd) {
      return null;
    }

    const extended = graceExtension({
      billingReason: input.billingReason,
      // Grace applies once. A second failure inside the window finds a date
      // already beyond the paid period and does not extend again.
      graceAlreadyApplied: Boolean(
        input.current && input.current > input.periodEnd
      ),
      subscribedUntil: input.current,
    });

    const billingPeriodStart =
      input.currentPeriodStart ?? periodStart(input.periodEnd);
    return extended && billingPeriodStart
      ? { billingPeriodStart, subscribedUntil: extended }
      : null;
  }

  return null;
}
