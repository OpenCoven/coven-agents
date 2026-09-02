// biome-ignore-all lint/suspicious/useAwait: dependency doubles keep async signatures for clarity.
import assert from "node:assert/strict";
import test from "node:test";
import { StripeReconciliationProviderUnauthorizedError } from "./stripe-reconciliation";
import { stripeReconciliationResponse } from "./stripe-reconciliation-route";

test("reconciliation route admits abuse before secret validation and service construction", async () => {
  const calls: string[] = [];

  const response = await stripeReconciliationResponse(
    new Request("https://app.test/api/internal/stripe-reconcile"),
    {
      authorize: () => {
        calls.push("secret");
        return "allowed";
      },
      createProvider: () => {
        calls.push("provider");
        return {};
      },
      enforceAbuse: (input) => {
        calls.push("abuse");
        assert.deepEqual(input, {
          ip: "203.0.113.9",
          route: "stripe_reconcile",
        });
        return Promise.resolve({
          kind: "denied" as const,
          responseStatus: 429 as const,
          retryAfterSeconds: 10,
        });
      },
      getConfig: () => {
        calls.push("config");
        return { apiKey: "sk_test", priceId: "price_test" };
      },
      reconcile: () => {
        calls.push("service");
        return Promise.resolve(successfulResult());
      },
    },
    "203.0.113.9"
  );

  assert.equal(response.status, 429);
  assert.deepEqual(calls, ["abuse"]);
});

test("reconciliation route rejects an invalid secret before billing configuration", async () => {
  const calls: string[] = [];

  const response = await stripeReconciliationResponse(
    new Request("https://app.test/api/internal/stripe-reconcile"),
    {
      authorize: () => {
        calls.push("secret");
        return "unauthorized";
      },
      createProvider: () => {
        calls.push("provider");
        return {};
      },
      enforceAbuse: () => {
        calls.push("abuse");
        return Promise.resolve({ kind: "allowed" as const });
      },
      getConfig: () => {
        calls.push("config");
        return { apiKey: "sk_test", priceId: "price_test" };
      },
      reconcile: () => {
        calls.push("service");
        return Promise.resolve(successfulResult());
      },
    },
    "203.0.113.9"
  );

  assert.equal(response.status, 401);
  assert.deepEqual(calls, ["abuse", "secret"]);
});

test("reconciliation route fails closed for missing billing configuration", async () => {
  const calls: string[] = [];

  const response = await stripeReconciliationResponse(
    new Request("https://app.test/api/internal/stripe-reconcile"),
    {
      authorize: () => "allowed",
      createProvider: () => {
        calls.push("provider");
        return {};
      },
      enforceAbuse: () => Promise.resolve({ kind: "allowed" as const }),
      getConfig: () => null,
      reconcile: () => {
        calls.push("service");
        return Promise.resolve(successfulResult());
      },
    },
    "203.0.113.9"
  );

  assert.equal(response.status, 503);
  assert.deepEqual(calls, []);
});

test("reconciliation route returns aggregate counts only", async () => {
  let provider: unknown;
  const response = await stripeReconciliationResponse(
    new Request("https://app.test/api/internal/stripe-reconcile"),
    {
      authorize: () => "allowed",
      createProvider: () => ({ marker: "provider" }),
      enforceAbuse: () => Promise.resolve({ kind: "allowed" as const }),
      getConfig: () => ({ apiKey: "sk_test", priceId: "price_test" }),
      reconcile: ({ priceId, provider: candidate }) => {
        provider = candidate;
        assert.equal(priceId, "price_test");
        return Promise.resolve({
          ...successfulResult(),
          invoiceId: "in_not_returned",
        } as never);
      },
    },
    "203.0.113.9"
  );

  assert.deepEqual(provider, { marker: "provider" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), successfulResult());
});

test("reconciliation route rejects a body before billing configuration", async () => {
  const calls: string[] = [];
  const request = {
    body: null,
    headers: new Headers({ "content-length": "1" }),
  } as unknown as Request;
  const response = await stripeReconciliationResponse(
    request,
    {
      authorize: () => {
        calls.push("secret");
        return "allowed";
      },
      createProvider: () => {
        calls.push("provider");
        return {};
      },
      enforceAbuse: () => {
        calls.push("abuse");
        return Promise.resolve({ kind: "allowed" as const });
      },
      getConfig: () => {
        calls.push("config");
        return { apiKey: "sk_test", priceId: "price_test" };
      },
      reconcile: () => {
        calls.push("service");
        return Promise.resolve(successfulResult());
      },
    },
    "203.0.113.9"
  );

  assert.equal(response.status, 400);
  assert.deepEqual(calls, ["abuse", "secret"]);
});

test("reconciliation route rejects malformed service aggregates without returning extra fields", async () => {
  const response = await stripeReconciliationResponse(
    new Request("https://app.test/api/internal/stripe-reconcile"),
    {
      authorize: () => "allowed",
      createProvider: () => ({}),
      enforceAbuse: () => Promise.resolve({ kind: "allowed" as const }),
      getConfig: () => ({ apiKey: "sk_test", priceId: "price_test" }),
      reconcile: () =>
        Promise.resolve({
          ...successfulResult(),
          invoicePayload: "must-not-leak",
          scanned: -1,
        } as never),
    },
    "203.0.113.9"
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "reconcile_unavailable" });
});

test("reconciliation route fails closed without Stripe error details on provider authorization failure", async () => {
  const response = await stripeReconciliationResponse(
    new Request("https://app.test/api/internal/stripe-reconcile"),
    {
      authorize: () => "allowed",
      createProvider: () => ({}),
      enforceAbuse: () => Promise.resolve({ kind: "allowed" as const }),
      getConfig: () => ({ apiKey: "sk_test", priceId: "price_test" }),
      reconcile: () =>
        Promise.reject(new StripeReconciliationProviderUnauthorizedError()),
    },
    "203.0.113.9"
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "billing_provider_unauthorized",
  });
});

function successfulResult() {
  return {
    applied: 3,
    conflicts: 2,
    deferred: 4,
    execution: "executed" as const,
    failures: 0,
    scanned: 9,
    unchanged: 0,
  };
}
