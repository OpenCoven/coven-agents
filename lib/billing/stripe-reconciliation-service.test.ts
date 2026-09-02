// biome-ignore-all lint/performance/noAwaitInLoops: the test table intentionally executes isolated cases in sequence.
// biome-ignore-all lint/suspicious/useAwait: dependency doubles keep async signatures for clarity.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  reconcileStripeSubscriptions,
  type StripeInvoiceObservation,
  type StripeReconciliationLease,
  type StripeReconciliationProvider,
  StripeReconciliationProviderUnauthorizedError,
  type StripeReconciliationStore,
  type StripeReconciliationUser,
} from "./stripe-reconciliation";

const CUSTOMER_ID = "cus_reconcile";
const PRICE_ID = "price_reconcile";
const SUBSCRIPTION_ID = "sub_reconcile";
const USER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const PERIOD_START = new Date("2026-09-01T00:00:00.000Z");
const PERIOD_END = new Date("2026-10-01T00:00:00.000Z");
const OVERRIDE_AT = new Date("2026-09-25T00:00:00.000Z");

test("a paid latest invoice repairs the exact interval and attaches its verified subscription", async () => {
  const user: StripeReconciliationUser = {
    authVersion: 7,
    billingPeriodStart: null,
    id: USER_ID,
    stripeCustomerId: CUSTOMER_ID,
    stripeSubscriptionId: null,
    subscribedUntil: null,
  };
  const store = new MemoryStore([user]);

  const result = await reconcileStripeSubscriptions({
    bounds: {
      invoiceLinePageLimit: 2,
      invoiceLineResultLimit: 10,
      leaseTtlMs: 60_000,
      maxBatches: 1,
      maxUsers: 10,
      providerConcurrency: 1,
      subscriptionPageLimit: 2,
      subscriptionResultLimit: 10,
      userBatchSize: 10,
    },
    owner: "11111111-1111-4111-8111-111111111111",
    priceId: PRICE_ID,
    provider: {
      listInvoiceLines: async () => {
        throw new Error("embedded invoice lines are sufficient");
      },
      listSubscriptions: async (customerId) => {
        assert.equal(customerId, CUSTOMER_ID);
        return {
          data: [
            {
              customerId,
              id: SUBSCRIPTION_ID,
              itemsComplete: true,
              latestInvoiceId: "in_reconcile",
              priceIds: [PRICE_ID],
              status: "active",
            },
          ],
          hasMore: false,
        };
      },
      retrieveInvoice: async (invoiceId) => {
        assert.equal(invoiceId, "in_reconcile");
        return {
          billingReason: "subscription_cycle",
          customerId: CUSTOMER_ID,
          id: invoiceId,
          lines: {
            data: [
              {
                id: "il_reconcile",
                invalidSubscriptionReference: false,
                periodEnd: PERIOD_END,
                periodStart: PERIOD_START,
                priceId: PRICE_ID,
                proration: false,
                stripeSubscriptionId: SUBSCRIPTION_ID,
                subscriptionItem: true,
              },
            ],
            hasMore: false,
          },
          paid: true,
          paidAt: new Date("2026-09-26T00:00:00.000Z"),
          stripeSubscriptionId: SUBSCRIPTION_ID,
        };
      },
      retrieveSubscription: async () => null,
    },
    store,
  });

  assert.deepEqual(result, {
    applied: 1,
    conflicts: 0,
    deferred: 0,
    execution: "executed",
    failures: 0,
    scanned: 1,
    unchanged: 0,
  });
  assert.deepEqual(store.users, [
    {
      ...user,
      billingPeriodStart: PERIOD_START,
      stripeSubscriptionId: SUBSCRIPTION_ID,
      subscribedUntil: PERIOD_END,
    },
  ]);
});

test("reconciliation keeps an active override for invoice evidence at or before it", async () => {
  const user: StripeReconciliationUser = {
    authVersion: 7,
    billingPeriodStart: null,
    id: USER_ID,
    stripeCustomerId: CUSTOMER_ID,
    stripeSubscriptionId: SUBSCRIPTION_ID,
    subscribedUntil: null,
    subscriptionOverrideAction: "revoke",
    subscriptionOverrideAt: new Date("2026-09-26T00:00:00.000Z"),
  };
  const store = new MemoryStore([user]);

  const result = await reconcileStripeSubscriptions({
    bounds: minimalBounds(),
    owner: "11111111-1111-4111-8111-111111111111",
    priceId: PRICE_ID,
    provider: paidProvider(),
    store,
  });

  assert.deepEqual(result, {
    applied: 0,
    conflicts: 0,
    deferred: 0,
    execution: "executed",
    failures: 0,
    scanned: 1,
    unchanged: 1,
  });
  assert.deepEqual(store.users, [user]);
});

test("strictly newer reconciled paid evidence clears an active revoke atomically", async () => {
  const user: StripeReconciliationUser = {
    authVersion: 7,
    billingPeriodStart: null,
    id: USER_ID,
    stripeCustomerId: CUSTOMER_ID,
    stripeSubscriptionId: SUBSCRIPTION_ID,
    subscribedUntil: null,
    subscriptionOverrideAction: "revoke",
    subscriptionOverrideAt: OVERRIDE_AT,
  };
  const store = new MemoryStore([user]);

  const result = await reconcileStripeSubscriptions({
    bounds: minimalBounds(),
    owner: "11111111-1111-4111-8111-111111111111",
    priceId: PRICE_ID,
    provider: paidProvider(),
    store,
  });

  assert.equal(result.applied, 1);
  assert.deepEqual(store.users, [
    {
      ...user,
      billingPeriodStart: PERIOD_START,
      subscribedUntil: PERIOD_END,
      subscriptionOverrideAction: null,
      subscriptionOverrideAt: null,
    },
  ]);
});

test("reconciliation orders override supersession by the paid transition, not invoice creation", async () => {
  const user: StripeReconciliationUser = {
    authVersion: 7,
    billingPeriodStart: null,
    id: USER_ID,
    stripeCustomerId: CUSTOMER_ID,
    stripeSubscriptionId: SUBSCRIPTION_ID,
    subscribedUntil: null,
    subscriptionOverrideAction: "revoke",
    subscriptionOverrideAt: new Date("2026-09-25T00:00:00.000Z"),
  };
  const store = new MemoryStore([user]);

  const result = await reconcileStripeSubscriptions({
    bounds: minimalBounds(),
    owner: "11111111-1111-4111-8111-111111111111",
    priceId: PRICE_ID,
    provider: {
      ...paidProvider(),
      retrieveInvoice: async () => ({
        ...paidInvoice(),
        paidAt: new Date("2026-09-24T00:00:00.000Z"),
      }),
    },
    store,
  });

  assert.equal(result.unchanged, 1);
  assert.deepEqual(store.users, [user]);
});

test("reconciliation defers paid invoices without a valid paid transition", async () => {
  const user: StripeReconciliationUser = {
    authVersion: 7,
    billingPeriodStart: null,
    id: USER_ID,
    stripeCustomerId: CUSTOMER_ID,
    stripeSubscriptionId: SUBSCRIPTION_ID,
    subscribedUntil: null,
  };
  const store = new MemoryStore([user]);

  const result = await reconcileStripeSubscriptions({
    bounds: minimalBounds(),
    owner: "11111111-1111-4111-8111-111111111111",
    priceId: PRICE_ID,
    provider: {
      ...paidProvider(),
      retrieveInvoice: async () => ({ ...paidInvoice(), paidAt: null }),
    },
    store,
  });

  assert.equal(result.deferred, 1);
  assert.equal(result.applied, 0);
});

test("a provider outage for one user defers that user and continues later users", async () => {
  const first: StripeReconciliationUser = {
    authVersion: 1,
    billingPeriodStart: null,
    id: "11111111-1111-4111-8111-111111111111",
    stripeCustomerId: CUSTOMER_ID,
    stripeSubscriptionId: SUBSCRIPTION_ID,
    subscribedUntil: null,
  };
  const second: StripeReconciliationUser = {
    ...first,
    id: "22222222-2222-4222-8222-222222222222",
  };
  const store = new MemoryStore([first, second]);

  const result = await reconcileStripeSubscriptions({
    bounds: {
      invoiceLinePageLimit: 2,
      invoiceLineResultLimit: 10,
      leaseTtlMs: 60_000,
      maxBatches: 1,
      maxUsers: 10,
      providerConcurrency: 1,
      subscriptionPageLimit: 2,
      subscriptionResultLimit: 10,
      userBatchSize: 10,
    },
    owner: "11111111-1111-4111-8111-111111111111",
    priceId: PRICE_ID,
    provider: {
      listInvoiceLines: async () => {
        throw new Error("not reached");
      },
      listSubscriptions: async () => {
        throw new Error("not reached");
      },
      retrieveInvoice: async () => ({
        billingReason: "subscription_cycle",
        customerId: CUSTOMER_ID,
        id: "in_reconcile",
        lines: {
          data: [
            {
              id: "il_reconcile",
              invalidSubscriptionReference: false,
              periodEnd: PERIOD_END,
              periodStart: PERIOD_START,
              priceId: PRICE_ID,
              proration: false,
              stripeSubscriptionId: SUBSCRIPTION_ID,
              subscriptionItem: true,
            },
          ],
          hasMore: false,
        },
        paid: true,
        paidAt: new Date("2026-09-26T00:00:00.000Z"),
        stripeSubscriptionId: SUBSCRIPTION_ID,
      }),
      retrieveSubscription: async (subscriptionId) => {
        if (subscriptionId === SUBSCRIPTION_ID && store.calls === 0) {
          store.calls += 1;
          throw new Error("Stripe transport failure");
        }
        return {
          customerId: CUSTOMER_ID,
          id: SUBSCRIPTION_ID,
          itemsComplete: true,
          latestInvoiceId: "in_reconcile",
          priceIds: [PRICE_ID],
          status: "active",
        };
      },
    },
    store,
  });

  assert.deepEqual(result, {
    applied: 1,
    conflicts: 0,
    deferred: 1,
    execution: "executed",
    failures: 0,
    scanned: 2,
    unchanged: 0,
  });
  assert.equal(store.users[0]?.subscribedUntil, null);
  assert.equal(
    store.users[1]?.subscribedUntil?.getTime(),
    PERIOD_END.getTime()
  );
});

test("a provider authorization failure aborts reconciliation without committing a user deferral", async () => {
  const user: StripeReconciliationUser = {
    authVersion: 1,
    billingPeriodStart: null,
    id: USER_ID,
    stripeCustomerId: CUSTOMER_ID,
    stripeSubscriptionId: SUBSCRIPTION_ID,
    subscribedUntil: null,
  };
  const store = new MemoryStore([user]);

  await assert.rejects(
    reconcileStripeSubscriptions({
      bounds: minimalBounds(),
      owner: "11111111-1111-4111-8111-111111111111",
      priceId: PRICE_ID,
      provider: {
        ...paidProvider(),
        retrieveSubscription: async () => {
          throw new StripeReconciliationProviderUnauthorizedError();
        },
      },
      store,
    }),
    StripeReconciliationProviderUnauthorizedError
  );

  assert.equal(store.cursor, null);
  assert.deepEqual(store.users, [user]);
});

test("a truncated subscription result set is deferred without fetching an unbounded next page", async () => {
  const user: StripeReconciliationUser = {
    authVersion: 1,
    billingPeriodStart: null,
    id: USER_ID,
    stripeCustomerId: CUSTOMER_ID,
    stripeSubscriptionId: null,
    subscribedUntil: null,
  };
  const store = new MemoryStore([user]);
  let listCalls = 0;

  const result = await reconcileStripeSubscriptions({
    bounds: {
      invoiceLinePageLimit: 2,
      invoiceLineResultLimit: 1,
      leaseTtlMs: 60_000,
      maxBatches: 1,
      maxUsers: 1,
      providerConcurrency: 1,
      subscriptionPageLimit: 2,
      subscriptionResultLimit: 1,
      userBatchSize: 1,
    },
    owner: "11111111-1111-4111-8111-111111111111",
    priceId: PRICE_ID,
    provider: {
      listInvoiceLines: async () => {
        throw new Error("not reached");
      },
      listSubscriptions: async (_customerId, input) => {
        listCalls += 1;
        assert.equal(input.limit, 1);
        return {
          data: [
            {
              customerId: CUSTOMER_ID,
              id: SUBSCRIPTION_ID,
              itemsComplete: true,
              latestInvoiceId: "in_reconcile",
              priceIds: [PRICE_ID],
              status: "active",
            },
          ],
          hasMore: true,
        };
      },
      retrieveInvoice: async () => {
        throw new Error("not reached");
      },
      retrieveSubscription: async () => null,
    },
    store,
  });

  assert.equal(result.deferred, 1);
  assert.equal(result.applied, 0);
  assert.equal(listCalls, 1);
  assert.equal(store.users[0]?.subscribedUntil, null);
});

test("unsupported Stripe statuses are deferred and never treated as entitlement evidence", async () => {
  for (const status of [
    "trialing",
    "past_due",
    "unpaid",
    "canceled",
    "incomplete",
    "incomplete_expired",
    "paused",
    "future_status",
  ]) {
    const user: StripeReconciliationUser = {
      authVersion: 1,
      billingPeriodStart: null,
      id: USER_ID,
      stripeCustomerId: CUSTOMER_ID,
      stripeSubscriptionId: SUBSCRIPTION_ID,
      subscribedUntil: null,
    };
    const store = new MemoryStore([user]);
    let invoices = 0;
    const result = await reconcileStripeSubscriptions({
      bounds: minimalBounds(),
      owner: "11111111-1111-4111-8111-111111111111",
      priceId: PRICE_ID,
      provider: {
        listInvoiceLines: async () => {
          throw new Error("not reached");
        },
        listSubscriptions: async () => ({
          data: [],
          hasMore: false,
        }),
        retrieveInvoice: async () => {
          invoices += 1;
          throw new Error("status must prevent invoice retrieval");
        },
        retrieveSubscription: async () => ({
          customerId: CUSTOMER_ID,
          id: SUBSCRIPTION_ID,
          itemsComplete: true,
          latestInvoiceId: "in_reconcile",
          priceIds: [PRICE_ID],
          status,
        }),
      },
      store,
    });

    assert.equal(result.deferred, 1, status);
    assert.equal(result.applied, 0, status);
    assert.equal(invoices, 0, status);
    assert.equal(store.users[0]?.subscribedUntil, null, status);
  }
});

test("a changed authority snapshot conflicts without advancing the cursor or mutation", async () => {
  const user: StripeReconciliationUser = {
    authVersion: 1,
    billingPeriodStart: null,
    id: USER_ID,
    stripeCustomerId: CUSTOMER_ID,
    stripeSubscriptionId: SUBSCRIPTION_ID,
    subscribedUntil: null,
  };
  const store = new MemoryStore([user]);
  store.forceConflict = true;

  const result = await reconcileStripeSubscriptions({
    bounds: minimalBounds(),
    owner: "11111111-1111-4111-8111-111111111111",
    priceId: PRICE_ID,
    provider: paidProvider(),
    store,
  });

  assert.equal(result.conflicts, 1);
  assert.equal(result.applied, 0);
  assert.equal(store.cursor, null);
  assert.equal(store.users[0]?.subscribedUntil, null);
});

test("customer, invoice, and subscription contradictions defer without repair", async () => {
  const cases = [
    {
      name: "subscription customer",
      provider: () => ({
        ...paidProvider(),
        retrieveSubscription: async () => ({
          customerId: "cus_other",
          id: SUBSCRIPTION_ID,
          itemsComplete: true,
          latestInvoiceId: "in_reconcile",
          priceIds: [PRICE_ID],
          status: "active",
        }),
      }),
    },
    {
      name: "invoice customer",
      provider: () => ({
        ...paidProvider(),
        retrieveInvoice: async () => ({
          ...paidInvoice(),
          customerId: "cus_other",
        }),
      }),
    },
    {
      name: "invoice subscription",
      provider: () => ({
        ...paidProvider(),
        retrieveInvoice: async () => ({
          ...paidInvoice(),
          stripeSubscriptionId: "sub_other",
        }),
      }),
    },
  ] as const;

  for (const testCase of cases) {
    const user: StripeReconciliationUser = {
      authVersion: 1,
      billingPeriodStart: null,
      id: USER_ID,
      stripeCustomerId: CUSTOMER_ID,
      stripeSubscriptionId: SUBSCRIPTION_ID,
      subscribedUntil: null,
    };
    const store = new MemoryStore([user]);
    const result = await reconcileStripeSubscriptions({
      bounds: minimalBounds(),
      owner: "11111111-1111-4111-8111-111111111111",
      priceId: PRICE_ID,
      provider: testCase.provider(),
      store,
    });

    assert.equal(result.deferred, 1, testCase.name);
    assert.equal(result.applied, 0, testCase.name);
    assert.equal(store.users[0]?.subscribedUntil, null, testCase.name);
  }
});

test("missing subscriptions and multiple configured-price candidates are deferred", async () => {
  for (const provider of [
    {
      ...paidProvider(),
      listSubscriptions: async () => ({ data: [], hasMore: false }),
      retrieveSubscription: async () => null,
    },
    {
      ...paidProvider(),
      listSubscriptions: async () => ({
        data: [
          {
            customerId: CUSTOMER_ID,
            id: "sub_first",
            itemsComplete: true,
            latestInvoiceId: "in_first",
            priceIds: [PRICE_ID],
            status: "active",
          },
          {
            customerId: CUSTOMER_ID,
            id: "sub_second",
            itemsComplete: true,
            latestInvoiceId: "in_second",
            priceIds: [PRICE_ID],
            status: "active",
          },
        ],
        hasMore: false,
      }),
      retrieveSubscription: async () => null,
    },
  ] satisfies StripeReconciliationProvider[]) {
    const store = new MemoryStore([
      {
        authVersion: 1,
        billingPeriodStart: null,
        id: USER_ID,
        stripeCustomerId: CUSTOMER_ID,
        stripeSubscriptionId: null,
        subscribedUntil: null,
      },
    ]);
    const result = await reconcileStripeSubscriptions({
      bounds: minimalBounds(),
      owner: "11111111-1111-4111-8111-111111111111",
      priceId: PRICE_ID,
      provider,
      store,
    });
    assert.equal(result.deferred, 1);
    assert.equal(result.applied, 0);
  }
});

test("a canceled stored subscription with truncated items falls back to one active replacement", async () => {
  const user: StripeReconciliationUser = {
    authVersion: 1,
    billingPeriodStart: null,
    id: USER_ID,
    stripeCustomerId: CUSTOMER_ID,
    stripeSubscriptionId: "sub_canceled",
    subscribedUntil: null,
  };
  const store = new MemoryStore([user]);
  const replacement = "sub_active_replacement";
  let listReads = 0;

  const result = await reconcileStripeSubscriptions({
    bounds: minimalBounds(),
    owner: "11111111-1111-4111-8111-111111111111",
    priceId: PRICE_ID,
    provider: {
      ...paidProvider(),
      listSubscriptions: async () => {
        listReads += 1;
        return {
          data: [
            {
              customerId: CUSTOMER_ID,
              id: "sub_canceled",
              itemsComplete: false,
              latestInvoiceId: "in_canceled",
              priceIds: [PRICE_ID],
              status: "canceled",
            },
            {
              customerId: CUSTOMER_ID,
              id: replacement,
              itemsComplete: true,
              latestInvoiceId: "in_active_replacement",
              priceIds: [PRICE_ID],
              status: "active",
            },
          ],
          hasMore: false,
        };
      },
      retrieveInvoice: async () => ({
        ...paidInvoice(),
        id: "in_active_replacement",
        lines: {
          data: [
            invoiceLine({
              id: "il_active_replacement",
              stripeSubscriptionId: replacement,
            }),
          ],
          hasMore: false,
        },
        stripeSubscriptionId: replacement,
      }),
      retrieveSubscription: async () => ({
        customerId: CUSTOMER_ID,
        id: "sub_canceled",
        itemsComplete: false,
        latestInvoiceId: "in_canceled",
        priceIds: [PRICE_ID],
        status: "canceled",
      }),
    },
    store,
  });

  assert.equal(result.applied, 1);
  assert.equal(listReads, 1);
  assert.equal(store.users[0]?.stripeSubscriptionId, replacement);
});

test("listed terminal subscriptions with truncated items are ignored before a valid active candidate", async () => {
  const user: StripeReconciliationUser = {
    authVersion: 1,
    billingPeriodStart: null,
    id: USER_ID,
    stripeCustomerId: CUSTOMER_ID,
    stripeSubscriptionId: null,
    subscribedUntil: null,
  };
  const store = new MemoryStore([user]);

  const result = await reconcileStripeSubscriptions({
    bounds: minimalBounds(),
    owner: "11111111-1111-4111-8111-111111111111",
    priceId: PRICE_ID,
    provider: {
      ...paidProvider(),
      listSubscriptions: async () => ({
        data: [
          {
            customerId: CUSTOMER_ID,
            id: "sub_canceled",
            itemsComplete: false,
            latestInvoiceId: "in_canceled",
            priceIds: [PRICE_ID],
            status: "canceled",
          },
          {
            customerId: CUSTOMER_ID,
            id: "sub_incomplete_expired",
            itemsComplete: false,
            latestInvoiceId: "in_incomplete_expired",
            priceIds: [PRICE_ID],
            status: "incomplete_expired",
          },
          {
            customerId: CUSTOMER_ID,
            id: SUBSCRIPTION_ID,
            itemsComplete: true,
            latestInvoiceId: "in_reconcile",
            priceIds: [PRICE_ID],
            status: "active",
          },
        ],
        hasMore: false,
      }),
      retrieveInvoice: async () => paidInvoice(),
      retrieveSubscription: async () => null,
    },
    store,
  });

  assert.equal(result.deferred, 0);
  assert.equal(result.applied, 1);
});

test("only terminal subscriptions defer without attempting an invoice", async () => {
  const user: StripeReconciliationUser = {
    authVersion: 1,
    billingPeriodStart: null,
    id: USER_ID,
    stripeCustomerId: CUSTOMER_ID,
    stripeSubscriptionId: null,
    subscribedUntil: null,
  };
  const store = new MemoryStore([user]);
  let invoiceReads = 0;

  const result = await reconcileStripeSubscriptions({
    bounds: minimalBounds(),
    owner: "11111111-1111-4111-8111-111111111111",
    priceId: PRICE_ID,
    provider: {
      ...paidProvider(),
      listSubscriptions: async () => ({
        data: [
          {
            customerId: CUSTOMER_ID,
            id: "sub_canceled",
            itemsComplete: false,
            latestInvoiceId: "in_canceled",
            priceIds: [PRICE_ID],
            status: "canceled",
          },
          {
            customerId: CUSTOMER_ID,
            id: "sub_incomplete_expired",
            itemsComplete: false,
            latestInvoiceId: "in_incomplete_expired",
            priceIds: [PRICE_ID],
            status: "incomplete_expired",
          },
        ],
        hasMore: false,
      }),
      retrieveInvoice: async () => {
        invoiceReads += 1;
        throw new Error("terminal subscriptions are not invoice evidence");
      },
      retrieveSubscription: async () => null,
    },
    store,
  });

  assert.equal(result.deferred, 1);
  assert.equal(result.applied, 0);
  assert.equal(invoiceReads, 0);
});

test("an active subscription with duplicate configured-price items defers", async () => {
  const user: StripeReconciliationUser = {
    authVersion: 1,
    billingPeriodStart: null,
    id: USER_ID,
    stripeCustomerId: CUSTOMER_ID,
    stripeSubscriptionId: null,
    subscribedUntil: null,
  };
  const store = new MemoryStore([user]);
  let invoiceReads = 0;

  const result = await reconcileStripeSubscriptions({
    bounds: minimalBounds(),
    owner: "11111111-1111-4111-8111-111111111111",
    priceId: PRICE_ID,
    provider: {
      ...paidProvider(),
      listSubscriptions: async () => ({
        data: [
          {
            customerId: CUSTOMER_ID,
            id: SUBSCRIPTION_ID,
            itemsComplete: true,
            latestInvoiceId: "in_reconcile",
            priceIds: [PRICE_ID, PRICE_ID],
            status: "active",
          },
        ],
        hasMore: false,
      }),
      retrieveInvoice: async () => {
        invoiceReads += 1;
        throw new Error("ambiguous configured Price is not invoice evidence");
      },
      retrieveSubscription: async () => null,
    },
    store,
  });

  assert.equal(result.applied, 0);
  assert.equal(result.deferred, 1);
  assert.equal(invoiceReads, 0);
});

test("active and unknown future stored subscriptions with incomplete items defer", async () => {
  for (const status of ["active", "future_status"] as const) {
    const user: StripeReconciliationUser = {
      authVersion: 1,
      billingPeriodStart: null,
      id: USER_ID,
      stripeCustomerId: CUSTOMER_ID,
      stripeSubscriptionId: SUBSCRIPTION_ID,
      subscribedUntil: null,
    };
    const store = new MemoryStore([user]);
    let invoiceReads = 0;
    let listReads = 0;

    const result = await reconcileStripeSubscriptions({
      bounds: minimalBounds(),
      owner: "11111111-1111-4111-8111-111111111111",
      priceId: PRICE_ID,
      provider: {
        ...paidProvider(),
        listSubscriptions: async () => {
          listReads += 1;
          throw new Error("incomplete terminal evidence must not fall back");
        },
        retrieveInvoice: async () => {
          invoiceReads += 1;
          throw new Error("incomplete items are not invoice evidence");
        },
        retrieveSubscription: async () => ({
          customerId: CUSTOMER_ID,
          id: SUBSCRIPTION_ID,
          itemsComplete: false,
          latestInvoiceId: "in_reconcile",
          priceIds: [PRICE_ID, PRICE_ID],
          status,
        }),
      },
      store,
    });

    assert.equal(result.deferred, 1, status);
    assert.equal(result.applied, 0, status);
    assert.equal(invoiceReads, 0, status);
    assert.equal(listReads, 0, status);
  }
});

test("unknown future subscription statuses defer even when their price matches", async () => {
  const user: StripeReconciliationUser = {
    authVersion: 1,
    billingPeriodStart: null,
    id: USER_ID,
    stripeCustomerId: CUSTOMER_ID,
    stripeSubscriptionId: null,
    subscribedUntil: null,
  };
  const store = new MemoryStore([user]);

  const result = await reconcileStripeSubscriptions({
    bounds: minimalBounds(),
    owner: "11111111-1111-4111-8111-111111111111",
    priceId: PRICE_ID,
    provider: {
      ...paidProvider(),
      listSubscriptions: async () => ({
        data: [
          {
            customerId: CUSTOMER_ID,
            id: "sub_future",
            itemsComplete: true,
            latestInvoiceId: "in_future",
            priceIds: [PRICE_ID],
            status: "future_status",
          },
        ],
        hasMore: false,
      }),
      retrieveSubscription: async () => null,
    },
    store,
  });

  assert.equal(result.deferred, 1);
  assert.equal(result.applied, 0);
});

test("an invoice-line page may provide exact paid evidence within its strict bound", async () => {
  const user: StripeReconciliationUser = {
    authVersion: 1,
    billingPeriodStart: null,
    id: USER_ID,
    stripeCustomerId: CUSTOMER_ID,
    stripeSubscriptionId: SUBSCRIPTION_ID,
    subscribedUntil: null,
  };
  const store = new MemoryStore([user]);
  let continuation: string | null = null;
  const provider: StripeReconciliationProvider = {
    ...paidProvider(),
    listInvoiceLines: async (_invoiceId, input) => {
      continuation = input.startingAfter;
      return {
        data: [invoiceLine({ id: "il_reconcile", priceId: PRICE_ID })],
        hasMore: false,
      };
    },
    retrieveInvoice: async () => ({
      ...paidInvoice(),
      lines: {
        data: [invoiceLine({ id: "il_other", priceId: "price_other" })],
        hasMore: true,
      },
    }),
  };

  const result = await reconcileStripeSubscriptions({
    bounds: minimalBounds(),
    owner: "11111111-1111-4111-8111-111111111111",
    priceId: PRICE_ID,
    provider,
    store,
  });

  assert.equal(result.applied, 1);
  assert.equal(continuation, "il_other");
  assert.equal(
    store.users[0]?.subscribedUntil?.getTime(),
    PERIOD_END.getTime()
  );
});

test("provider work observes the configured concurrency bound", async () => {
  const users = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
  ].map((id) => ({
    authVersion: 1,
    billingPeriodStart: null,
    id,
    stripeCustomerId: CUSTOMER_ID,
    stripeSubscriptionId: SUBSCRIPTION_ID,
    subscribedUntil: null,
  }));
  const store = new MemoryStore(users);
  let active = 0;
  let maximum = 0;
  const provider: StripeReconciliationProvider = {
    ...paidProvider(),
    retrieveSubscription: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return {
        customerId: CUSTOMER_ID,
        id: SUBSCRIPTION_ID,
        itemsComplete: true,
        latestInvoiceId: "in_reconcile",
        priceIds: [PRICE_ID],
        status: "trialing",
      };
    },
  };

  const result = await reconcileStripeSubscriptions({
    bounds: { ...minimalBounds(), maxUsers: 3, providerConcurrency: 2 },
    owner: "11111111-1111-4111-8111-111111111111",
    priceId: PRICE_ID,
    provider,
    store,
  });

  assert.equal(result.deferred, 3);
  assert.equal(maximum, 2);
});

test("invalid injected bounds fail before the reconciliation lease is acquired", async () => {
  const store = new MemoryStore([]);

  await assert.rejects(
    reconcileStripeSubscriptions({
      bounds: { ...minimalBounds(), maxUsers: 0 },
      owner: "11111111-1111-4111-8111-111111111111",
      priceId: PRICE_ID,
      provider: paidProvider(),
      store,
    }),
    /maxUsers/
  );

  assert.equal(store.acquireCalls, 0);
});

test("an exhausted ordered cursor wraps without skipping deferred users", async () => {
  const user: StripeReconciliationUser = {
    authVersion: 1,
    billingPeriodStart: null,
    id: USER_ID,
    stripeCustomerId: CUSTOMER_ID,
    stripeSubscriptionId: SUBSCRIPTION_ID,
    subscribedUntil: null,
  };
  const store = new MemoryStore([user]);
  store.cursor = "ffffffff-ffff-4fff-8fff-ffffffffffff";

  const result = await reconcileStripeSubscriptions({
    bounds: { ...minimalBounds(), maxBatches: 2, maxUsers: 1 },
    owner: "11111111-1111-4111-8111-111111111111",
    priceId: PRICE_ID,
    provider: {
      ...paidProvider(),
      retrieveSubscription: async () => ({
        customerId: CUSTOMER_ID,
        id: SUBSCRIPTION_ID,
        itemsComplete: true,
        latestInvoiceId: "in_reconcile",
        priceIds: [PRICE_ID],
        status: "trialing",
      }),
    },
    store,
  });

  assert.equal(result.deferred, 1);
  assert.equal(result.scanned, 1);
  assert.equal(store.cursor, USER_ID);
});

test("reconciliation policy consumes provider-neutral observations only", () => {
  const source = readFileSync(
    new URL("./stripe-reconciliation.ts", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(source, /from ["']stripe["']/);
  assert.doesNotMatch(source, /\bStripe\./);
});

class MemoryStore implements StripeReconciliationStore {
  acquireCalls = 0;
  calls = 0;
  cursor: string | null = null;
  forceConflict = false;
  lease: StripeReconciliationLease | null = null;
  users: StripeReconciliationUser[];

  constructor(users: StripeReconciliationUser[]) {
    this.users = users;
  }

  async acquire(input: {
    leaseTtlMs: number;
    owner: string;
  }): Promise<
    { kind: "acquired"; lease: StripeReconciliationLease } | { kind: "held" }
  > {
    this.acquireCalls += 1;
    this.lease = {
      cursor: this.cursor,
      fence: 1,
      owner: input.owner,
    };
    return { kind: "acquired", lease: this.lease };
  }

  async commit(input: {
    lease: StripeReconciliationLease;
    mutation: Partial<
      Pick<
        StripeReconciliationUser,
        | "billingPeriodStart"
        | "stripeCustomerId"
        | "stripeSubscriptionId"
        | "subscribedUntil"
      >
    > | null;
    nextCursor: string;
    snapshot: StripeReconciliationUser;
  }): Promise<"committed" | "conflict" | "lost"> {
    assert.deepEqual(input.lease, this.lease);
    if (this.forceConflict) {
      return "conflict";
    }
    const index = this.users.findIndex((row) => row.id === input.snapshot.id);
    assert.notEqual(index, -1);
    const current = this.users[index] as StripeReconciliationUser;
    if (!sameSnapshot(current, input.snapshot)) {
      return "conflict";
    }

    this.users[index] = { ...current, ...input.mutation };
    this.cursor = input.nextCursor;
    return "committed";
  }

  async release(
    lease: StripeReconciliationLease
  ): Promise<"lost" | "released"> {
    assert.deepEqual(lease, this.lease);
    return "released";
  }

  async renew(input: {
    lease: StripeReconciliationLease;
    leaseTtlMs: number;
  }): Promise<
    { kind: "lost" } | { kind: "renewed"; lease: StripeReconciliationLease }
  > {
    assert.deepEqual(input.lease, this.lease);
    return { kind: "renewed", lease: input.lease };
  }

  async scanUsers(input: {
    after: string | null;
    limit: number;
  }): Promise<StripeReconciliationUser[]> {
    return this.users
      .filter((row) => row.id > (input.after ?? ""))
      .slice(0, input.limit)
      .map((row) => ({ ...row }));
  }

  async wrapCursor(
    lease: StripeReconciliationLease
  ): Promise<
    { kind: "lost" } | { kind: "wrapped"; lease: StripeReconciliationLease }
  > {
    assert.deepEqual(lease, this.lease);
    this.cursor = null;
    this.lease = { ...lease, cursor: null };
    return { kind: "wrapped", lease: this.lease };
  }
}

function minimalBounds() {
  return {
    invoiceLinePageLimit: 2,
    invoiceLineResultLimit: 10,
    leaseTtlMs: 60_000,
    maxBatches: 1,
    maxUsers: 10,
    providerConcurrency: 1,
    subscriptionPageLimit: 2,
    subscriptionResultLimit: 10,
    userBatchSize: 10,
  };
}

function invoiceLine(
  overrides: Partial<{
    id: string;
    priceId: string;
    stripeSubscriptionId: string;
  }> = {}
) {
  return {
    id: "il_reconcile",
    invalidSubscriptionReference: false,
    periodEnd: PERIOD_END,
    periodStart: PERIOD_START,
    priceId: PRICE_ID,
    proration: false,
    stripeSubscriptionId: SUBSCRIPTION_ID,
    subscriptionItem: true,
    ...overrides,
  };
}

function paidProvider(): StripeReconciliationProvider {
  return {
    listInvoiceLines: async () => ({
      data: [],
      hasMore: false,
    }),
    listSubscriptions: async () => ({
      data: [],
      hasMore: false,
    }),
    retrieveInvoice: async () => paidInvoice(),
    retrieveSubscription: async () => ({
      customerId: CUSTOMER_ID,
      id: SUBSCRIPTION_ID,
      itemsComplete: true,
      latestInvoiceId: "in_reconcile",
      priceIds: [PRICE_ID],
      status: "active",
    }),
  };
}

function paidInvoice(): StripeInvoiceObservation {
  return {
    billingReason: "subscription_cycle",
    customerId: CUSTOMER_ID,
    id: "in_reconcile",
    lines: {
      data: [
        {
          id: "il_reconcile",
          invalidSubscriptionReference: false,
          periodEnd: PERIOD_END,
          periodStart: PERIOD_START,
          priceId: PRICE_ID,
          proration: false,
          stripeSubscriptionId: SUBSCRIPTION_ID,
          subscriptionItem: true,
        },
      ],
      hasMore: false,
    },
    paid: true,
    paidAt: new Date("2026-09-26T00:00:00.000Z"),
    stripeSubscriptionId: SUBSCRIPTION_ID,
  };
}

function sameSnapshot(
  left: StripeReconciliationUser,
  right: StripeReconciliationUser
): boolean {
  return (
    left.authVersion === right.authVersion &&
    left.billingPeriodStart?.getTime() ===
      right.billingPeriodStart?.getTime() &&
    left.stripeCustomerId === right.stripeCustomerId &&
    left.stripeSubscriptionId === right.stripeSubscriptionId &&
    left.subscribedUntil?.getTime() === right.subscribedUntil?.getTime() &&
    left.subscriptionOverrideAction === right.subscriptionOverrideAction &&
    left.subscriptionOverrideAt?.getTime() ===
      right.subscriptionOverrideAt?.getTime()
  );
}
