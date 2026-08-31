import { createHash } from "node:crypto";
import type Stripe from "stripe";
import type { CheckoutAttemptState } from "./checkout-lease";

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

export const CHECKOUT_ATTEMPT_METADATA_KEY = "checkoutAttemptId";

export type CheckoutSessionSnapshot = {
  clientReferenceId: string | null;
  customerId: string | null;
  id: string;
  integrationIdentifier: string | null;
  metadata: Record<string, string>;
  mode: Stripe.Checkout.Session.Mode;
  status: Stripe.Checkout.Session.Status | null;
  url: string | null;
};

export type CheckoutSessionPage = {
  data: CheckoutSessionSnapshot[];
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

export async function reconcileCheckoutSessions(input: {
  attemptId: string;
  attemptState: CheckoutAttemptState;
  customerId: string;
  expire: (
    sessionId: string,
    options: { idempotencyKey: string }
  ) => Promise<void>;
  expirationIdempotencyKey: (sessionId: string) => string;
  listPage: (
    input: Stripe.Checkout.SessionListParams
  ) => Promise<CheckoutSessionPage>;
  priceId: string;
  providerIdempotencyKey: string;
  retrieve: (sessionId: string) => Promise<CheckoutSessionSnapshot>;
  userId: string;
}): Promise<
  | { kind: "complete"; sessionId: string }
  | { kind: "invalid_url"; sessionId: string }
  | { kind: "none" }
  | { kind: "retire_attempt" }
  | { kind: "retry_required" }
  | { kind: "reused"; sessionId: string; url: string }
> {
  const sessions = await listCheckoutSessions(input);
  const byId = new Map(sessions.map((session) => [session.id, session]));

  if (
    input.attemptState.kind === "session_created" &&
    !byId.has(input.attemptState.sessionId)
  ) {
    const storedSession = await input.retrieve(input.attemptState.sessionId);
    byId.set(storedSession.id, storedSession);
  }

  const currentSession = [...byId.values()].find((session) =>
    isCurrentAttempt(session, input)
  );
  if (currentSession) {
    const current = await input.retrieve(currentSession.id);
    if (!isAppOwned(current, input)) {
      return { kind: "retry_required" };
    }
    if (current.status === "expired") {
      return { kind: "retire_attempt" };
    }
    if (current.status === "complete") {
      return { kind: "complete", sessionId: current.id };
    }
    if (current.status !== "open") {
      return { kind: "retry_required" };
    }
    if (matchesCurrentFlow(current, input.priceId)) {
      for (const session of byId.values()) {
        if (
          session.id !== current.id &&
          session.status === "open" &&
          isAppOwned(session, input)
        ) {
          // biome-ignore lint/performance/noAwaitInLoops: reusable Checkout is returned only after every competing Session is expired.
          await expireAndVerify(await input.retrieve(session.id), input);
        }
      }
      return reusableSession(current);
    }

    await expireAndVerify(current, input);
    return { kind: "retire_attempt" };
  }

  if (input.attemptState.kind !== "fresh") {
    return { kind: "retry_required" };
  }

  const appOwnedOpen = [...byId.values()].filter(
    (session) => session.status === "open" && isAppOwned(session, input)
  );
  const reusable = appOwnedOpen.find((session) =>
    matchesCurrentFlow(session, input.priceId)
  );

  for (const session of appOwnedOpen) {
    if (session.id === reusable?.id) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: replacement is forbidden until each payable Session is proven expired.
    await expireAndVerify(await input.retrieve(session.id), input);
  }

  if (reusable) {
    return reusableSession(await input.retrieve(reusable.id));
  }
  return { kind: "none" };
}

async function listCheckoutSessions(input: {
  customerId: string;
  listPage: (
    input: Stripe.Checkout.SessionListParams
  ) => Promise<CheckoutSessionPage>;
}): Promise<CheckoutSessionSnapshot[]> {
  const sessions: CheckoutSessionSnapshot[] = [];
  for (const status of [
    "open",
    "complete",
    "expired",
  ] satisfies Stripe.Checkout.Session.Status[]) {
    let startingAfter: string | undefined;
    do {
      // biome-ignore lint/performance/noAwaitInLoops: each Stripe page supplies the cursor for the next.
      const page = await input.listPage({
        customer: input.customerId,
        limit: 100,
        starting_after: startingAfter,
        status,
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
  }
  return sessions;
}

async function expireAndVerify(
  session: CheckoutSessionSnapshot,
  input: {
    customerId: string;
    expire: (
      sessionId: string,
      options: { idempotencyKey: string }
    ) => Promise<void>;
    expirationIdempotencyKey: (sessionId: string) => string;
    retrieve: (sessionId: string) => Promise<CheckoutSessionSnapshot>;
  }
): Promise<void> {
  if (session.customerId !== input.customerId) {
    throw new CheckoutSessionCleanupError(
      "An obsolete Checkout Session belongs to another Customer."
    );
  }
  if (session.status === "expired") {
    return;
  }
  if (session.status !== "open") {
    throw new CheckoutSessionCleanupError(
      "An obsolete Checkout Session is no longer safely expirable."
    );
  }
  try {
    await input.expire(session.id, {
      idempotencyKey: input.expirationIdempotencyKey(session.id),
    });
    const reconciled = await input.retrieve(session.id);
    if (reconciled.status !== "expired") {
      throw new Error("Stripe did not confirm Checkout Session expiration.");
    }
  } catch (error) {
    throw new CheckoutSessionCleanupError(
      "An obsolete Checkout Session could not be expired.",
      { cause: error }
    );
  }
}

function isAppOwned(
  session: CheckoutSessionSnapshot,
  input: { customerId: string; userId: string }
): boolean {
  return (
    session.clientReferenceId === input.userId &&
    session.customerId === input.customerId &&
    session.metadata.userId === input.userId &&
    session.mode === "subscription"
  );
}

function isCurrentAttempt(
  session: CheckoutSessionSnapshot,
  input: {
    attemptId: string;
    attemptState: CheckoutAttemptState;
    providerIdempotencyKey: string;
  }
): boolean {
  return (
    (input.attemptState.kind === "session_created" &&
      session.id === input.attemptState.sessionId) ||
    session.metadata[CHECKOUT_ATTEMPT_METADATA_KEY] === input.attemptId ||
    (!session.metadata[CHECKOUT_ATTEMPT_METADATA_KEY] &&
      session.integrationIdentifier ===
        stableIntegrationIdentifier(input.providerIdempotencyKey))
  );
}

function matchesCurrentFlow(
  session: CheckoutSessionSnapshot,
  priceId: string
): boolean {
  return (
    session.metadata.checkoutFlowVersion === CHECKOUT_FLOW_VERSION &&
    session.metadata.priceId === priceId
  );
}

function reusableSession(
  session: CheckoutSessionSnapshot
):
  | { kind: "invalid_url"; sessionId: string }
  | { kind: "reused"; sessionId: string; url: string } {
  if (!isValidCheckoutSessionUrl(session.url)) {
    return { kind: "invalid_url", sessionId: session.id };
  }
  return { kind: "reused", sessionId: session.id, url: session.url };
}

export function isValidCheckoutSessionUrl(
  value: string | null
): value is string {
  if (!value) {
    return false;
  }
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
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
