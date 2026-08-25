import { graceExtension } from "./grace";

export type SubscriptionUpdate = { subscribedUntil: Date } | null;

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
  periodEnd: Date | null;
  type: string;
}): SubscriptionUpdate {
  if (input.type === "invoice.paid") {
    // No date means nothing to grant. Defaulting to "now plus a month" would
    // invent a subscription the invoice never described.
    return input.periodEnd ? { subscribedUntil: input.periodEnd } : null;
  }

  if (input.type === "invoice.payment_failed") {
    const extended = graceExtension({
      billingReason: input.billingReason,
      // Grace applies once. A second failure inside the window finds a date
      // already beyond the paid period and does not extend again.
      graceAlreadyApplied: Boolean(
        input.current && input.periodEnd && input.current > input.periodEnd
      ),
      subscribedUntil: input.current,
    });

    return extended ? { subscribedUntil: extended } : null;
  }

  return null;
}
