export type CheckoutDecision =
  | { kind: "allowed"; userId: string }
  | { kind: "already_subscribed" }
  | { kind: "unauthorized" };

/**
 * Whether this user may open a checkout session.
 *
 * "At most one active subscription" is enforced by asking Stripe, not by a
 * database constraint on the customer id. A cancel-then-resubscribe reuses the
 * same Customer, so a constraint there would reject the returning customer --
 * the case most worth not breaking -- while minting a fresh Customer per
 * checkout would make the constraint useless anyway.
 *
 * Signed-out is checked first so an anonymous caller never learns whether some
 * account is subscribed.
 */
export function checkoutDecision(input: {
  hasActiveSubscription: boolean;
  userId: string | null;
}): CheckoutDecision {
  if (!input.userId) {
    return { kind: "unauthorized" };
  }

  if (input.hasActiveSubscription) {
    return { kind: "already_subscribed" };
  }

  return { kind: "allowed", userId: input.userId };
}
