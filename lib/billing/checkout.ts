import { createHash } from "node:crypto";
import type Stripe from "stripe";

const BLOCKING_SUBSCRIPTION_STATUSES = new Set<Stripe.Subscription.Status>([
  "active",
  "incomplete",
  "past_due",
  "paused",
  "trialing",
  "unpaid",
]);

export type CheckoutDecision =
  | { kind: "allowed"; userId: string }
  | { kind: "already_subscribed" }
  | { kind: "unauthorized" };

export type CheckoutSubscriptionPage = {
  data: Pick<Stripe.Subscription, "id" | "status">[];
  hasMore: boolean;
};

/**
 * Whether this user may open a checkout session.
 *
 * Stripe remains the duplicate-subscription authority. Live subscriptions,
 * including an incomplete first-payment attempt, block a new Checkout.
 * Canceled and incomplete-expired subscriptions are terminal and permit
 * cancel-then-resubscribe with the same Customer.
 *
 * Signed-out is checked first so an anonymous caller never learns whether some
 * account is subscribed.
 */
export function checkoutDecision(input: {
  hasBlockingSubscription: boolean;
  userId: string | null;
}): CheckoutDecision {
  if (!input.userId) {
    return { kind: "unauthorized" };
  }

  if (input.hasBlockingSubscription) {
    return { kind: "already_subscribed" };
  }

  return { kind: "allowed", userId: input.userId };
}

export function isBlockingSubscriptionStatus(
  status: Stripe.Subscription.Status
): boolean {
  return BLOCKING_SUBSCRIPTION_STATUSES.has(status);
}

export async function hasBlockingSubscription(
  customerId: string,
  listPage: (
    input: Stripe.SubscriptionListParams
  ) => Promise<CheckoutSubscriptionPage>
): Promise<boolean> {
  let startingAfter: string | undefined;

  do {
    // biome-ignore lint/performance/noAwaitInLoops: each Stripe page supplies the cursor for the next.
    const page = await listPage({
      customer: customerId,
      limit: 100,
      starting_after: startingAfter,
      status: "all",
    });
    if (page.data.some(({ status }) => isBlockingSubscriptionStatus(status))) {
      return true;
    }
    if (!page.hasMore) {
      return false;
    }

    const lastSubscription = page.data.at(-1);
    if (!lastSubscription) {
      throw new Error("Stripe returned an empty non-terminal page.");
    }
    startingAfter = lastSubscription.id;
  } while (startingAfter);

  return false;
}

export function stableIntegrationIdentifier(
  providerIdempotencyKey: string
): string {
  const digest = createHash("sha256")
    .update(providerIdempotencyKey, "utf8")
    .digest();
  const suffix = Array.from(digest.subarray(0, 8), (byte) =>
    String.fromCharCode(97 + (byte % 26))
  ).join("");

  return `opencoven_coven_agents_${suffix}`;
}
