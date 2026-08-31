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

export const CHECKOUT_FLOW_VERSION = "1";

export type CheckoutDecision =
  | { kind: "allowed"; userId: string }
  | { kind: "already_subscribed" }
  | { kind: "unauthorized" };

export type CheckoutSubscriptionPage = {
  data: Pick<Stripe.Subscription, "id" | "status">[];
  hasMore: boolean;
};

export type OpenCheckoutSession = {
  clientReferenceId: string | null;
  id: string;
  integrationIdentifier: string | null;
  metadata: Record<string, string>;
  mode: Stripe.Checkout.Session.Mode;
  url: string | null;
};

export type OpenCheckoutSessionPage = {
  data: OpenCheckoutSession[];
  hasMore: boolean;
};

export class CheckoutSessionCleanupError extends Error {}

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

export async function recoverOpenCheckoutSession(input: {
  customerId: string;
  expire: (
    sessionId: string,
    options: { idempotencyKey: string }
  ) => Promise<void>;
  listPage: (
    input: Stripe.Checkout.SessionListParams
  ) => Promise<OpenCheckoutSessionPage>;
  priceId: string;
  providerIdempotencyKey: string;
  userId: string;
}): Promise<
  | { kind: "none" }
  | { kind: "retry_required" }
  | { kind: "reused"; url: string | null }
> {
  const sessions: OpenCheckoutSession[] = [];
  let startingAfter: string | undefined;

  do {
    // biome-ignore lint/performance/noAwaitInLoops: each Stripe page supplies the cursor for the next.
    const page = await input.listPage({
      customer: input.customerId,
      limit: 100,
      starting_after: startingAfter,
      status: "open",
    });
    sessions.push(...page.data);
    if (!page.hasMore) {
      break;
    }

    const lastSession = page.data.at(-1);
    if (!lastSession) {
      throw new Error("Stripe returned an empty non-terminal page.");
    }
    startingAfter = lastSession.id;
  } while (startingAfter);

  const appOwned = sessions.filter(
    (session) =>
      session.clientReferenceId === input.userId &&
      session.metadata.userId === input.userId &&
      session.mode === "subscription"
  );
  const reusable = appOwned.find(
    (session) =>
      session.metadata.checkoutFlowVersion === CHECKOUT_FLOW_VERSION &&
      session.metadata.priceId === input.priceId
  );
  let expiredCurrentAttempt = false;

  for (const session of appOwned) {
    if (session.id === reusable?.id) {
      continue;
    }
    if (
      session.integrationIdentifier ===
      stableIntegrationIdentifier(input.providerIdempotencyKey)
    ) {
      expiredCurrentAttempt = true;
    }
    try {
      // biome-ignore lint/performance/noAwaitInLoops: a replacement must not be created until every obsolete payable Session is expired.
      await input.expire(session.id, {
        idempotencyKey: `${input.providerIdempotencyKey}:expire:${session.id}`,
      });
    } catch (error) {
      throw new CheckoutSessionCleanupError(
        "An obsolete Checkout Session could not be expired.",
        { cause: error }
      );
    }
  }

  if (reusable) {
    return { kind: "reused", url: reusable.url };
  }
  if (expiredCurrentAttempt) {
    return { kind: "retry_required" };
  }
  return { kind: "none" };
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
