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
  subscriptionId: string | null;
  url: string | null;
};

export type CheckoutSessionPage = {
  data: CheckoutSessionSnapshot[];
  hasMore: boolean;
};

export type CheckoutSessionCleanupResult = {
  sessionId: string;
  status: "complete" | "expired";
  subscriptionId: string | null;
};

export type CheckoutSessionCleanup = (input: {
  cleanupKind: "blocking" | "obsolete";
  customerId: string;
  sessionIds: readonly string[];
  userId: string;
}) => Promise<CheckoutSessionCleanupResult[]>;

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

export function checkoutSessionSubscriptionId(
  subscription: Stripe.Checkout.Session["subscription"]
): string | null {
  return typeof subscription === "string"
    ? subscription
    : (subscription?.id ?? null);
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
  cleanupSessions: CheckoutSessionCleanup;
  customerId: string;
  listPage: (
    input: Stripe.Checkout.SessionListParams
  ) => Promise<CheckoutSessionPage>;
  priceId: string;
  providerIdempotencyKey: string;
  retrieve: (sessionId: string) => Promise<CheckoutSessionSnapshot>;
  userId: string;
}): Promise<
  | {
      completedSessions?: Array<{
        sessionId: string;
        subscriptionId: string | null;
      }>;
      kind: "complete";
      sessionId: string;
      subscriptionId: string | null;
    }
  | { kind: "invalid_url"; sessionId: string }
  | { kind: "none" }
  | { kind: "retire_attempt" }
  | { kind: "retry_required" }
  | { kind: "reused"; sessionId: string; url: string }
> {
  const sessions = await listCheckoutSessions(input);
  assertOpenSubscriptionSessionOwnership(sessions, input);
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
    if (!isAppOwnedCheckoutSession(current, input)) {
      throw new CheckoutSessionCleanupError(
        "A Checkout Session is not safely app-owned."
      );
    }
    if (!hasExpectedAttemptIdentity(current, input)) {
      if (current.status === "expired") {
        return { kind: "retire_attempt" };
      }
      if (current.status === "open") {
        return (
          (await cleanupObsoleteSessions([current.id], input)) ?? {
            kind: "retire_attempt",
          }
        );
      }
      return { kind: "retry_required" };
    }
    if (current.status === "expired") {
      return { kind: "retire_attempt" };
    }
    if (current.status === "complete") {
      return completedSession(current);
    }
    if (current.status !== "open") {
      return { kind: "retry_required" };
    }
    if (matchesCurrentFlow(current, input.priceId)) {
      const completed = await cleanupObsoleteSessions(
        [...byId.values()]
          .filter(
            (session) =>
              session.id !== current.id &&
              session.status === "open" &&
              isAppOwnedCheckoutSession(session, input)
          )
          .map(({ id }) => id),
        input
      );
      if (completed) {
        return completed;
      }
      return reusableSession(current);
    }

    return (
      (await cleanupObsoleteSessions([current.id], input)) ?? {
        kind: "retire_attempt",
      }
    );
  }

  if (
    input.attemptState.kind === "create_uncertain" ||
    input.attemptState.kind === "session_created"
  ) {
    return { kind: "retry_required" };
  }

  const appOwnedOpen = [...byId.values()].filter(
    (session) =>
      session.status === "open" && isAppOwnedCheckoutSession(session, input)
  );
  const reusable = appOwnedOpen.find((session) =>
    matchesCurrentFlow(session, input.priceId)
  );

  const completed = await cleanupObsoleteSessions(
    appOwnedOpen
      .filter((session) => session.id !== reusable?.id)
      .map(({ id }) => id),
    input
  );
  if (completed) {
    return completed;
  }

  if (reusable) {
    return reconcileRetrievedReusable(
      await input.retrieve(reusable.id),
      reusable,
      input
    );
  }
  return { kind: "none" };
}

export async function reconcileBlockingCheckoutSessions(input: {
  cleanupSessions: CheckoutSessionCleanup;
  customerId: string;
  knownSessionIds?: readonly string[];
  listPage: (
    input: Stripe.Checkout.SessionListParams
  ) => Promise<CheckoutSessionPage>;
  userId: string;
}): Promise<Array<{ sessionId: string; subscriptionId: string | null }>> {
  const sessions = await listCheckoutSessions(input, ["open"]);
  assertOpenSubscriptionSessionOwnership(sessions, input);
  const sessionIds = new Set([
    ...sessions
      .filter((session) => session.mode === "subscription")
      .map((session) => session.id),
    ...(input.knownSessionIds ?? []),
  ]);
  const terminal = await input.cleanupSessions({
    cleanupKind: "blocking",
    customerId: input.customerId,
    sessionIds: [...sessionIds],
    userId: input.userId,
  });
  return terminal
    .filter(({ status }) => status === "complete")
    .map(({ sessionId, subscriptionId }) => ({
      sessionId,
      subscriptionId,
    }));
}

async function reconcileRetrievedReusable(
  session: CheckoutSessionSnapshot,
  listed: CheckoutSessionSnapshot,
  input: {
    attemptId: string;
    cleanupSessions: CheckoutSessionCleanup;
    customerId: string;
    priceId: string;
    providerIdempotencyKey: string;
    retrieve: (sessionId: string) => Promise<CheckoutSessionSnapshot>;
    userId: string;
  }
): Promise<
  | { kind: "complete"; sessionId: string; subscriptionId: string | null }
  | { kind: "invalid_url"; sessionId: string }
  | { kind: "retire_attempt" }
  | { kind: "retry_required" }
  | { kind: "reused"; sessionId: string; url: string }
> {
  if (!isAppOwnedCheckoutSession(session, input)) {
    throw new CheckoutSessionCleanupError(
      "A Checkout Session is not safely app-owned."
    );
  }
  if (!hasExpectedAttemptIdentity(session, input)) {
    if (session.status === "expired") {
      return { kind: "retire_attempt" };
    }
    if (session.status === "open") {
      return (
        (await cleanupObsoleteSessions([session.id], input)) ?? {
          kind: "retire_attempt",
        }
      );
    }
    return { kind: "retry_required" };
  }
  if (!hasSameAttemptIdentity(session, listed)) {
    if (session.status === "expired") {
      return { kind: "retire_attempt" };
    }
    if (session.status === "open") {
      return (
        (await cleanupObsoleteSessions([session.id], input)) ?? {
          kind: "retire_attempt",
        }
      );
    }
    return { kind: "retry_required" };
  }
  if (!matchesCurrentFlow(session, input.priceId)) {
    if (session.status === "expired") {
      return { kind: "retire_attempt" };
    }
    if (session.status === "open") {
      return (
        (await cleanupObsoleteSessions([session.id], input)) ?? {
          kind: "retire_attempt",
        }
      );
    }
    return { kind: "retry_required" };
  }
  if (session.status === "expired") {
    return { kind: "retire_attempt" };
  }
  if (session.status === "complete") {
    return completedSession(session);
  }
  if (session.status !== "open") {
    return { kind: "retry_required" };
  }
  return reusableSession(session);
}

async function listCheckoutSessions(
  input: {
    customerId: string;
    listPage: (
      input: Stripe.Checkout.SessionListParams
    ) => Promise<CheckoutSessionPage>;
  },
  statuses: readonly Stripe.Checkout.Session.Status[] = [
    "open",
    "complete",
    "expired",
  ]
): Promise<CheckoutSessionSnapshot[]> {
  const sessions: CheckoutSessionSnapshot[] = [];
  for (const status of statuses) {
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

async function cleanupObsoleteSessions(
  sessionIds: readonly string[],
  input: {
    cleanupSessions: CheckoutSessionCleanup;
    customerId: string;
    userId: string;
  }
): Promise<{
  completedSessions?: Array<{
    sessionId: string;
    subscriptionId: string | null;
  }>;
  kind: "complete";
  sessionId: string;
  subscriptionId: string | null;
} | null> {
  if (sessionIds.length === 0) {
    return null;
  }
  let terminal: CheckoutSessionCleanupResult[];
  try {
    terminal = await input.cleanupSessions({
      cleanupKind: "obsolete",
      customerId: input.customerId,
      sessionIds,
      userId: input.userId,
    });
  } catch (error) {
    throw new CheckoutSessionCleanupError(
      "An obsolete Checkout Session could not be expired.",
      { cause: error }
    );
  }
  const completed = terminal.filter(({ status }) => status === "complete");
  const [firstCompleted] = completed;
  if (!firstCompleted) {
    return null;
  }
  return {
    ...(completed.length > 1
      ? {
          completedSessions: completed.map(({ sessionId, subscriptionId }) => ({
            sessionId,
            subscriptionId,
          })),
        }
      : {}),
    kind: "complete",
    sessionId: firstCompleted.sessionId,
    subscriptionId: firstCompleted.subscriptionId,
  };
}

function assertOpenSubscriptionSessionOwnership(
  sessions: readonly CheckoutSessionSnapshot[],
  input: { customerId: string; userId: string }
): void {
  if (
    sessions.some(
      (session) =>
        session.status === "open" &&
        session.mode === "subscription" &&
        !isAppOwnedCheckoutSession(session, input)
    )
  ) {
    throw new CheckoutSessionCleanupError(
      "An open Checkout Session is not safely app-owned."
    );
  }
}

export function isAppOwnedCheckoutSession(
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

function hasExpectedAttemptIdentity(
  session: CheckoutSessionSnapshot,
  input: { attemptId: string; providerIdempotencyKey: string }
): boolean {
  const metadataAttemptId =
    session.metadata[CHECKOUT_ATTEMPT_METADATA_KEY] ?? null;
  return metadataAttemptId
    ? metadataAttemptId === input.attemptId
    : session.integrationIdentifier ===
        stableIntegrationIdentifier(input.providerIdempotencyKey);
}

function hasSameAttemptIdentity(
  session: CheckoutSessionSnapshot,
  expected: CheckoutSessionSnapshot
): boolean {
  return (
    session.metadata[CHECKOUT_ATTEMPT_METADATA_KEY] ===
      expected.metadata[CHECKOUT_ATTEMPT_METADATA_KEY] &&
    session.integrationIdentifier === expected.integrationIdentifier
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

function completedSession(session: CheckoutSessionSnapshot): {
  kind: "complete";
  sessionId: string;
  subscriptionId: string | null;
} {
  return {
    kind: "complete",
    sessionId: session.id,
    subscriptionId: session.subscriptionId,
  };
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
