// biome-ignore-all lint/suspicious/useAwait: dependency doubles keep async signatures for clarity.
import assert from "node:assert/strict";
import test from "node:test";
import Stripe from "stripe";
import { createStripeReconciliationProviderFromClient } from "./stripe-reconciliation-provider";

test("Stripe adapter emits normalized observations without provider payloads", async () => {
  const provider = createStripeReconciliationProviderFromClient({
    invoices: {
      listLineItems: async () => ({
        data: [],
        has_more: false,
      }),
      retrieve: async () => ({
        billing_reason: "subscription_cycle",
        created: 1_790_380_800,
        customer: "cus_adapter",
        id: "in_adapter",
        lines: {
          data: [
            {
              id: "il_adapter",
              parent: {
                subscription_item_details: {
                  proration: false,
                  subscription: "sub_adapter",
                },
                type: "subscription_item_details",
              },
              period: { end: 1_790_812_800, start: 1_788_220_800 },
              pricing: {
                price_details: { price: "price_adapter" },
                type: "price_details",
              },
              subscription: "sub_adapter",
            },
          ],
          has_more: false,
        },
        parent: {
          subscription_details: { subscription: "sub_adapter" },
        },
        status: "paid",
        status_transitions: { paid_at: 1_790_467_200 },
      }),
    },
    subscriptions: {
      list: async () => ({
        data: [],
        has_more: false,
      }),
      retrieve: async () => ({
        customer: "cus_adapter",
        id: "sub_adapter",
        items: {
          data: [{ price: { id: "price_adapter" } }],
          has_more: false,
        },
        latest_invoice: "in_adapter",
        status: "active",
      }),
    },
  } as never);

  assert.deepEqual(await provider.retrieveSubscription("sub_adapter"), {
    customerId: "cus_adapter",
    id: "sub_adapter",
    itemsComplete: true,
    latestInvoiceId: "in_adapter",
    priceIds: ["price_adapter"],
    status: "active",
  });
  assert.deepEqual(await provider.retrieveInvoice("in_adapter"), {
    billingReason: "subscription_cycle",
    customerId: "cus_adapter",
    id: "in_adapter",
    lines: {
      data: [
        {
          id: "il_adapter",
          invalidSubscriptionReference: false,
          periodEnd: new Date("2026-10-01T00:00:00.000Z"),
          periodStart: new Date("2026-09-01T00:00:00.000Z"),
          priceId: "price_adapter",
          proration: false,
          stripeSubscriptionId: "sub_adapter",
          subscriptionItem: true,
          subscriptionItemSubscriptionId: "sub_adapter",
        },
      ],
      hasMore: false,
    },
    paid: true,
    paidAt: new Date("2026-09-27T00:00:00.000Z"),
    stripeSubscriptionId: "sub_adapter",
  });
});

test("Stripe adapter rejects incomplete items and invalid paid-transition timestamps", async () => {
  const provider = createStripeReconciliationProviderFromClient({
    invoices: {
      listLineItems: async () => ({ data: [], has_more: false }),
      retrieve: async () => ({
        billing_reason: "subscription_cycle",
        created: 1_790_380_800,
        customer: "cus_adapter",
        id: "in_adapter",
        lines: { data: [], has_more: false },
        parent: {
          subscription_details: { subscription: "sub_adapter" },
        },
        status: "paid",
        status_transitions: { paid_at: Number.POSITIVE_INFINITY },
      }),
    },
    subscriptions: {
      list: async () => ({ data: [], has_more: false }),
      retrieve: async () => ({
        customer: "cus_adapter",
        id: "sub_adapter",
        items: {
          data: [
            { price: { id: "price_adapter" } },
            { price: { id: "not_a_price" } },
          ],
          has_more: true,
        },
        latest_invoice: "in_adapter",
        status: "active",
      }),
    },
  } as never);

  assert.deepEqual(await provider.retrieveSubscription("sub_adapter"), {
    customerId: "cus_adapter",
    id: "sub_adapter",
    itemsComplete: false,
    latestInvoiceId: "in_adapter",
    priceIds: ["price_adapter"],
    status: "active",
  });
  assert.equal((await provider.retrieveInvoice("in_adapter"))?.paidAt, null);
});

test("Stripe adapter preserves only complete, bounded item observations", async () => {
  const valid = { price: { id: "price_adapter" } };
  const cases = [
    {
      complete: true,
      items: { data: [valid], has_more: false },
      name: "exactly one valid configured price",
      priceIds: ["price_adapter"],
    },
    {
      complete: true,
      items: { data: [valid, valid], has_more: false },
      name: "multiple valid configured prices",
      priceIds: ["price_adapter", "price_adapter"],
    },
    {
      complete: false,
      items: { data: [valid], has_more: true },
      name: "a truncated item page",
      priceIds: ["price_adapter"],
    },
    {
      complete: false,
      items: { data: [{ price: { id: "not_a_price" } }], has_more: false },
      name: "a malformed visible item",
      priceIds: [],
    },
    {
      complete: false,
      items: {
        data: [valid, { price: { id: "not_a_price" } }],
        has_more: false,
      },
      name: "a malformed item hidden after a valid item",
      priceIds: ["price_adapter"],
    },
    {
      complete: false,
      items: {
        data: Array.from({ length: 101 }, () => valid),
        has_more: false,
      },
      name: "an excessive item count",
      priceIds: Array.from({ length: 101 }, () => "price_adapter"),
    },
  ] as const;

  await Promise.all(
    cases.map(async (testCase) => {
      const provider = createStripeReconciliationProviderFromClient({
        invoices: {
          listLineItems: async () => ({ data: [], has_more: false }),
          retrieve: async () => {
            throw new Error("not reached");
          },
        },
        subscriptions: {
          list: async () => ({ data: [], has_more: false }),
          retrieve: async () => ({
            customer: "cus_adapter",
            id: "sub_adapter",
            items: testCase.items,
            latest_invoice: "in_adapter",
            status: "active",
          }),
        },
      } as never);

      const observation = await provider.retrieveSubscription("sub_adapter");
      assert.equal(
        observation?.itemsComplete,
        testCase.complete,
        testCase.name
      );
      assert.deepEqual(observation?.priceIds, testCase.priceIds, testCase.name);
    })
  );
});

test("Stripe adapter makes customer-scoped bounded list calls only", async () => {
  let received: unknown;
  const provider = createStripeReconciliationProviderFromClient({
    invoices: {
      listLineItems: async () => ({ data: [], has_more: false }),
      retrieve: async () => {
        throw new Error("not reached");
      },
    },
    subscriptions: {
      list: async (input: unknown) => {
        received = input;
        return {
          data: [],
          has_more: false,
        };
      },
      retrieve: async () => {
        throw new Error("not reached");
      },
    },
  } as never);

  assert.deepEqual(
    await provider.listSubscriptions("cus_adapter", {
      limit: 7,
      startingAfter: "sub_before",
    }),
    { data: [], hasMore: false }
  );
  assert.deepEqual(received, {
    customer: "cus_adapter",
    limit: 7,
    starting_after: "sub_before",
    status: "all",
  });
});

test("Stripe adapter turns 401 and 403 provider failures into a finite systemic error", async () => {
  await Promise.all(
    [401, 403].map(async (statusCode) => {
      const provider = createStripeReconciliationProviderFromClient({
        invoices: {
          listLineItems: async () => ({ data: [], has_more: false }),
          retrieve: async () => {
            throw new Error("not reached");
          },
        },
        subscriptions: {
          list: async () => {
            const error = Object.create(
              Stripe.errors.StripeAuthenticationError.prototype
            ) as Stripe.errors.StripeAuthenticationError;
            Object.assign(error, { statusCode });
            throw error;
          },
          retrieve: async () => {
            throw new Error("not reached");
          },
        },
      } as never);

      await assert.rejects(
        provider.listSubscriptions("cus_adapter", { limit: 1 }),
        (error: unknown) =>
          error instanceof Error &&
          error.name === "StripeReconciliationProviderUnauthorizedError" &&
          error.message === "Stripe billing provider is unauthorized."
      );
    })
  );
});
