// biome-ignore-all lint/suspicious/useAwait: dependency doubles keep async signatures for clarity.
import assert from "node:assert/strict";
import test from "node:test";
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
        items: { data: [{ price: { id: "price_adapter" } }] },
        latest_invoice: "in_adapter",
        status: "active",
      }),
    },
  } as never);

  assert.deepEqual(await provider.retrieveSubscription("sub_adapter"), {
    customerId: "cus_adapter",
    id: "sub_adapter",
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
    stripeSubscriptionId: "sub_adapter",
  });
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
