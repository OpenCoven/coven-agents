import assert from "node:assert/strict";
import test from "node:test";
import type Stripe from "stripe";
import {
  CHECKOUT_ATTEMPT_METADATA_KEY,
  checkoutDecision,
  isBlockingSubscriptionStatus,
  reconcileCheckoutSessions,
  stableIntegrationIdentifier,
} from "./checkout";
import { createStripeClient } from "./stripe-client";

const BLOCKING_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "paused",
  "incomplete",
] satisfies Stripe.Subscription.Status[];

test("every live subscription status blocks checkout", () => {
  for (const status of BLOCKING_STATUSES) {
    assert.equal(isBlockingSubscriptionStatus(status), true, status);
  }
});

test("terminal subscriptions allow a new checkout", () => {
  for (const status of [
    "canceled",
    "incomplete_expired",
  ] satisfies Stripe.Subscription.Status[]) {
    assert.equal(isBlockingSubscriptionStatus(status), false, status);
  }
});

test("an anonymous caller is refused before subscription state is disclosed", () => {
  assert.equal(
    checkoutDecision({
      hasBlockingSubscription: true,
      userId: null,
    }).kind,
    "unauthorized"
  );
});

test("an allowed decision carries the authenticated user", () => {
  const decision = checkoutDecision({
    hasBlockingSubscription: false,
    userId: "user-1",
  });

  assert.equal(decision.kind, "allowed");
  if (decision.kind === "allowed") {
    assert.equal(decision.userId, "user-1");
  }
});

test("integration identifiers are stable and end in eight lowercase letters", () => {
  const first = stableIntegrationIdentifier("provider-key-one");
  const retry = stableIntegrationIdentifier("provider-key-one");
  const other = stableIntegrationIdentifier("provider-key-two");

  assert.equal(first, retry);
  assert.notEqual(first, other);
  assert.match(first, /^opencoven_coven_agents_[a-z]{8}$/);
});

test("current attempts are reconciled across paginated completed Sessions", async () => {
  const cursors: Array<{
    startingAfter: string | undefined;
    status: Stripe.Checkout.SessionListParams.Status | undefined;
  }> = [];
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    checkoutSession({
      attemptId: `other-attempt-${index}`,
      id: `cs_other_${index}`,
      status: "complete",
    })
  );
  const current = checkoutSession({
    attemptId: "attempt-current",
    id: "cs_current",
    status: "complete",
  });

  const result = await reconcileCheckoutSessions({
    attemptId: "attempt-current",
    attemptState: { kind: "create_uncertain" },
    customerId: "cus_existing",
    expirationIdempotencyKey: (sessionId) => `expire-${sessionId}`,
    expire: () => Promise.resolve(),
    listPage(input) {
      cursors.push({
        startingAfter: input.starting_after,
        status: input.status,
      });
      if (input.status !== "complete") {
        return Promise.resolve({ data: [], hasMore: false });
      }
      if (input.starting_after === firstPage.at(-1)?.id) {
        return Promise.resolve({ data: [current], hasMore: false });
      }
      return Promise.resolve({ data: firstPage, hasMore: true });
    },
    priceId: "price_configured",
    providerIdempotencyKey: "provider-key",
    retrieve: () => Promise.resolve(current),
    userId: "user-1",
  });

  assert.deepEqual(result, { kind: "complete", sessionId: "cs_current" });
  assert.deepEqual(
    cursors.filter(({ status }) => status === "complete"),
    [
      { startingAfter: undefined, status: "complete" },
      {
        startingAfter: firstPage.at(-1)?.id,
        status: "complete",
      },
    ]
  );
});

test("Stripe clients use the pinned Dahlia API version", () => {
  const client = createStripeClient("sk_test_checkout");

  assert.equal(client.getApiField("version"), "2026-07-29.dahlia");
});

function checkoutSession(input: {
  attemptId: string;
  id: string;
  status: Stripe.Checkout.Session.Status;
}) {
  return {
    clientReferenceId: "user-1",
    customerId: "cus_existing",
    id: input.id,
    integrationIdentifier: null,
    metadata: {
      [CHECKOUT_ATTEMPT_METADATA_KEY]: input.attemptId,
      checkoutFlowVersion: "1",
      priceId: "price_configured",
      userId: "user-1",
    },
    mode: "subscription" as const,
    status: input.status,
    url: `https://checkout.stripe.test/${input.id}`,
  };
}
