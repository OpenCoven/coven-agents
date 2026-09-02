// biome-ignore-all lint/suspicious/useAwait: dependency doubles keep async signatures for clarity.
import assert from "node:assert/strict";
import test from "node:test";
import {
  UsageMeteringProviderUnauthorizedError,
  type UsageMeteringResult,
} from "./usage-metering";
import {
  type UsageMeteringRouteDependencies,
  usageMeteringResponse,
} from "./usage-metering-route";

const RESULT: UsageMeteringResult = {
  batches: 1,
  noCustomer: 0,
  notBillable: 1,
  reported: 3,
  scanned: 4,
  stopped: "drained",
};

function dependencies(
  calls: string[],
  overrides: Partial<UsageMeteringRouteDependencies<object>> = {}
): UsageMeteringRouteDependencies<object> {
  return {
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
      assert.deepEqual(input, { ip: "203.0.113.9", route: "stripe_usage" });
      return Promise.resolve({ kind: "allowed" as const });
    },
    getConfig: () => {
      calls.push("config");
      return { apiKey: "sk_test", eventName: "run_minutes" };
    },
    meter: (input) => {
      calls.push(`meter:${input.eventName}`);
      return Promise.resolve(RESULT);
    },
    ...overrides,
  };
}

test("usage route admits abuse before the secret, config, or provider", async () => {
  const calls: string[] = [];
  const response = await usageMeteringResponse(
    new Request("https://app.test/api/internal/stripe-usage"),
    dependencies(calls, {
      enforceAbuse: () => {
        calls.push("abuse");
        return Promise.resolve({
          kind: "denied" as const,
          responseStatus: 429 as const,
          retryAfterSeconds: 10,
        });
      },
    }),
    "203.0.113.9"
  );

  assert.equal(response.status, 429);
  assert.deepEqual(calls, ["abuse"]);
});

test("usage route rejects a bad secret before reading billing configuration", async () => {
  const calls: string[] = [];
  const response = await usageMeteringResponse(
    new Request("https://app.test/api/internal/stripe-usage"),
    dependencies(calls, { authorize: () => "unauthorized" }),
    "203.0.113.9"
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthorized" });
  assert.deepEqual(calls, ["abuse"]);
});

test("usage route requires an empty body and configured billing", async () => {
  const calls: string[] = [];
  const withBody = await usageMeteringResponse(
    new Request("https://app.test/api/internal/stripe-usage", {
      body: "{}",
      method: "POST",
    }),
    dependencies(calls),
    "203.0.113.9"
  );
  assert.equal(withBody.status, 400);

  const unconfigured = await usageMeteringResponse(
    new Request("https://app.test/api/internal/stripe-usage"),
    dependencies(calls, { getConfig: () => null }),
    "203.0.113.9"
  );
  assert.equal(unconfigured.status, 503);
  assert.deepEqual(await unconfigured.json(), { error: "billing_unavailable" });
});

test("usage route returns only aggregate counts", async () => {
  const calls: string[] = [];
  const response = await usageMeteringResponse(
    new Request("https://app.test/api/internal/stripe-usage"),
    dependencies(calls),
    "203.0.113.9"
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), RESULT);
  assert.deepEqual(calls, [
    "abuse",
    "secret",
    "config",
    "provider",
    "meter:run_minutes",
  ]);
});

test("usage route reports a rejected Stripe credential distinctly", async () => {
  const calls: string[] = [];
  const response = await usageMeteringResponse(
    new Request("https://app.test/api/internal/stripe-usage"),
    dependencies(calls, {
      meter: () => Promise.reject(new UsageMeteringProviderUnauthorizedError()),
    }),
    "203.0.113.9"
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "billing_provider_unauthorized",
  });

  const failed = await usageMeteringResponse(
    new Request("https://app.test/api/internal/stripe-usage"),
    dependencies(calls, { meter: () => Promise.reject(new Error("boom")) }),
    "203.0.113.9"
  );
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: "usage_unavailable" });
});
