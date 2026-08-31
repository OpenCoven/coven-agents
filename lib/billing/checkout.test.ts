import assert from "node:assert/strict";
import test from "node:test";
import type Stripe from "stripe";
import {
  CHECKOUT_ATTEMPT_METADATA_KEY,
  CheckoutSessionCleanupError,
  checkoutDecision,
  checkoutSessionSubscriptionId,
  hasBlockingSubscription,
  isBlockingSubscriptionStatus,
  reconcileCheckoutSessions,
  stableIntegrationIdentifier,
} from "./checkout";
import { createStripeClient } from "./stripe-client";

type CheckoutSessionStatus = Parameters<typeof checkoutSession>[0]["status"];

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

test("subscription discovery stops after three endless pages", async () => {
  let calls = 0;

  await assert.rejects(
    hasBlockingSubscription("cus_existing", () => {
      calls += 1;
      if (calls > 3) {
        throw new Error("Unbounded fourth subscription page.");
      }
      return Promise.resolve({
        data: [{ id: `sub_terminal_${calls}`, status: "canceled" }],
        hasMore: true,
      });
    }),
    /discovery limit/
  );
  assert.equal(calls, 3);
});

test("subscription discovery rejects a blocking third page when more results remain", async () => {
  let calls = 0;

  await assert.rejects(
    hasBlockingSubscription("cus_existing", () => {
      calls += 1;
      return Promise.resolve({
        data: [
          {
            id: `sub_${calls}`,
            status: calls === 3 ? "active" : "canceled",
          },
        ],
        hasMore: true,
      });
    }),
    /discovery limit/
  );
  assert.equal(calls, 3);
});

test("subscription discovery accepts exactly three full terminal pages", async () => {
  let calls = 0;

  const result = await hasBlockingSubscription("cus_existing", () => {
    calls += 1;
    return Promise.resolve({
      data: Array.from({ length: 100 }, (_, index) => ({
        id: `sub_${calls}_${index}`,
        status: "canceled" as const,
      })),
      hasMore: calls < 3,
    });
  });

  assert.equal(result, false);
  assert.equal(calls, 3);
});

test("Checkout Session discovery rejects an oversized history before cleanup", async () => {
  let cleanupCalls = 0;
  let completePageCalls = 0;

  await assert.rejects(
    reconcileCheckoutSessions({
      attemptId: "attempt-current",
      attemptState: { kind: "fresh" },
      cleanupSessions: () => {
        cleanupCalls += 1;
        return Promise.resolve([]);
      },
      customerId: "cus_existing",
      listPage(input) {
        if (input.status !== "complete") {
          return Promise.resolve({ data: [], hasMore: false });
        }
        completePageCalls += 1;
        if (completePageCalls > 3) {
          throw new Error("Unbounded fourth Checkout Session page.");
        }
        return Promise.resolve({
          data: Array.from({ length: 100 }, (_, index) =>
            checkoutSession({
              attemptId: `other-attempt-${completePageCalls}-${index}`,
              id: `cs_${completePageCalls}_${index}`,
              status: "complete",
            })
          ),
          hasMore: true,
        });
      },
      priceId: "price_configured",
      providerIdempotencyKey: "provider-key",
      retrieve: () => Promise.reject(new Error("Retrieval was not expected.")),
      userId: "user-1",
    }),
    /discovery limit/
  );

  assert.equal(completePageCalls, 3);
  assert.equal(cleanupCalls, 0);
});

test("Checkout Session discovery caps aggregate requests across statuses", async () => {
  let cleanupCalls = 0;
  let requestCalls = 0;
  const callsByStatus = new Map<string, number>();

  await assert.rejects(
    reconcileCheckoutSessions({
      attemptId: "attempt-current",
      attemptState: { kind: "fresh" },
      cleanupSessions: () => {
        cleanupCalls += 1;
        return Promise.resolve([]);
      },
      customerId: "cus_existing",
      listPage(input) {
        requestCalls += 1;
        const status = input.status ?? "open";
        const statusCalls = (callsByStatus.get(status) ?? 0) + 1;
        callsByStatus.set(status, statusCalls);
        return Promise.resolve({
          data: [
            checkoutSession({
              attemptId: `other-${status}-${statusCalls}`,
              id: `cs_${status}_${statusCalls}`,
              status,
            }),
          ],
          hasMore: statusCalls === 1,
        });
      },
      priceId: "price_configured",
      providerIdempotencyKey: "provider-key",
      retrieve: () => Promise.reject(new Error("Retrieval was not expected.")),
      userId: "user-1",
    }),
    /discovery limit/
  );

  assert.equal(requestCalls, 5);
  assert.equal(cleanupCalls, 0);
});

test("Checkout Session discovery accepts exactly 300 results", async () => {
  let completePageCalls = 0;
  const current = checkoutSession({
    attemptId: "attempt-current",
    id: "cs_current_exact_bound",
    status: "complete",
  });

  const result = await reconcileCheckoutSessions({
    attemptId: "attempt-current",
    attemptState: { kind: "create_uncertain" },
    cleanupSessions: () =>
      Promise.reject(new Error("Cleanup was not expected.")),
    customerId: "cus_existing",
    listPage(input) {
      if (input.status !== "complete") {
        return Promise.resolve({ data: [], hasMore: false });
      }
      completePageCalls += 1;
      const data = Array.from({ length: 100 }, (_, index) =>
        checkoutSession({
          attemptId: `other-attempt-${completePageCalls}-${index}`,
          id: `cs_exact_${completePageCalls}_${index}`,
          status: "complete",
        })
      );
      if (completePageCalls === 3) {
        data[99] = current;
      }
      return Promise.resolve({
        data,
        hasMore: completePageCalls < 3,
      });
    },
    priceId: "price_configured",
    providerIdempotencyKey: "provider-key",
    retrieve: () => Promise.resolve(current),
    userId: "user-1",
  });

  assert.deepEqual(result, {
    kind: "complete",
    sessionId: "cs_current_exact_bound",
    subscriptionId: "sub_current",
  });
  assert.equal(completePageCalls, 3);
});

test("completed Checkout subscription references normalize string, expanded, and null values", () => {
  assert.equal(checkoutSessionSubscriptionId("sub_string"), "sub_string");
  assert.equal(
    checkoutSessionSubscriptionId({
      id: "sub_expanded",
    } as Stripe.Subscription),
    "sub_expanded"
  );
  assert.equal(checkoutSessionSubscriptionId(null), null);
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
    cleanupSessions: () =>
      Promise.reject(new Error("Expiration was not expected.")),
    customerId: "cus_existing",
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

  assert.deepEqual(result, {
    kind: "complete",
    sessionId: "cs_current",
    subscriptionId: "sub_current",
  });
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

test("a listed open current attempt routes a retrieved completed Session through subscription reconciliation", async () => {
  const listed = checkoutSession({
    attemptId: "attempt-current",
    id: "cs_current",
    status: "open",
  });
  const result = await reconcileCheckoutSessions({
    attemptId: "attempt-current",
    attemptState: { kind: "session_created", sessionId: listed.id },
    cleanupSessions: () =>
      Promise.reject(new Error("Expiration was not expected.")),
    customerId: "cus_existing",
    listPage(input) {
      return Promise.resolve({
        data: input.status === "open" ? [listed] : [],
        hasMore: false,
      });
    },
    priceId: "price_configured",
    providerIdempotencyKey: "provider-key",
    retrieve: () =>
      Promise.resolve({
        ...listed,
        status: "complete",
        subscriptionId: "sub_completed",
      }),
    userId: "user-1",
  });

  assert.deepEqual(result, {
    kind: "complete",
    sessionId: "cs_current",
    subscriptionId: "sub_completed",
  });
});

test("a listed reusable Session that expires before retrieve is retired", async () => {
  const listed = checkoutSession({
    attemptId: "older-attempt",
    id: "cs_expired",
    status: "open",
  });
  const result = await reconcileCheckoutSessions({
    attemptId: "attempt-current",
    attemptState: { kind: "fresh" },
    cleanupSessions: () =>
      Promise.reject(new Error("Expiration was not expected.")),
    customerId: "cus_existing",
    listPage(input) {
      return Promise.resolve({
        data: input.status === "open" ? [listed] : [],
        hasMore: false,
      });
    },
    priceId: "price_configured",
    providerIdempotencyKey: "provider-key",
    retrieve: () =>
      Promise.resolve({
        ...listed,
        status: "expired",
      }),
    userId: "user-1",
  });

  assert.deepEqual(result, { kind: "retire_attempt" });
});

test("an app-owned open Session from another attempt is expired instead of reused", async () => {
  const listed = checkoutSession({
    attemptId: "older-attempt",
    id: "cs_older_attempt",
    status: "open",
  });
  let status: CheckoutSessionStatus = "open";
  const expired: string[] = [];
  const result = await reconcileCheckoutSessions({
    attemptId: "attempt-current",
    attemptState: { kind: "fresh" },
    cleanupSessions(input) {
      expired.push(...input.sessionIds);
      status = "expired";
      return Promise.resolve(
        input.sessionIds.map((sessionId) => ({
          sessionId,
          status: "expired" as const,
          subscriptionId: null,
        }))
      );
    },
    customerId: "cus_existing",
    listPage(input) {
      return Promise.resolve({
        data: input.status === "open" ? [listed] : [],
        hasMore: false,
      });
    },
    priceId: "price_configured",
    providerIdempotencyKey: "provider-key",
    retrieve: () => Promise.resolve({ ...listed, status }),
    userId: "user-1",
  });

  assert.deepEqual(result, { kind: "retire_attempt" });
  assert.deepEqual(expired, ["cs_older_attempt"]);
});

test("a retrieved Session with another Customer fails closed without expiration", async () => {
  const listed = checkoutSession({
    attemptId: "older-attempt",
    id: "cs_other_customer",
    status: "open",
  });
  const expired: string[] = [];
  await assert.rejects(
    reconcileCheckoutSessions({
      attemptId: "attempt-current",
      attemptState: { kind: "fresh" },
      cleanupSessions(input) {
        expired.push(...input.sessionIds);
        return Promise.resolve([]);
      },
      customerId: "cus_existing",
      listPage(input) {
        return Promise.resolve({
          data: input.status === "open" ? [listed] : [],
          hasMore: false,
        });
      },
      priceId: "price_configured",
      providerIdempotencyKey: "provider-key",
      retrieve: () =>
        Promise.resolve({
          ...listed,
          customerId: "cus_unrelated",
        }),
      userId: "user-1",
    }),
    CheckoutSessionCleanupError
  );
  assert.deepEqual(expired, []);
});

test("an app-owned retrieved Session with changed attempt metadata is expired before rotation", async () => {
  const listed = checkoutSession({
    attemptId: "attempt-current",
    id: "cs_changed_attempt",
    status: "open",
  });
  let status: CheckoutSessionStatus = "open";
  const expired: string[] = [];
  const result = await reconcileCheckoutSessions({
    attemptId: "attempt-current",
    attemptState: { kind: "session_created", sessionId: listed.id },
    cleanupSessions(input) {
      expired.push(...input.sessionIds);
      status = "expired";
      return Promise.resolve(
        input.sessionIds.map((sessionId) => ({
          sessionId,
          status: "expired" as const,
          subscriptionId: null,
        }))
      );
    },
    customerId: "cus_existing",
    listPage(input) {
      return Promise.resolve({
        data: input.status === "open" ? [listed] : [],
        hasMore: false,
      });
    },
    priceId: "price_configured",
    providerIdempotencyKey: "provider-key",
    retrieve: () =>
      Promise.resolve({
        ...listed,
        metadata: {
          ...listed.metadata,
          [CHECKOUT_ATTEMPT_METADATA_KEY]: "another-attempt",
        },
        status,
      }),
    userId: "user-1",
  });

  assert.deepEqual(result, { kind: "retire_attempt" });
  assert.deepEqual(expired, ["cs_changed_attempt"]);
});

test("Stripe clients use the pinned Dahlia API version", () => {
  const client = createStripeClient("sk_test_checkout");

  assert.equal(client.getApiField("version"), "2026-08-26.dahlia");
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
    subscriptionId: input.status === "complete" ? "sub_current" : null,
    url: `https://checkout.stripe.test/${input.id}`,
  };
}
