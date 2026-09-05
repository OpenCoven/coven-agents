// biome-ignore-all lint/suspicious/useAwait: dependency doubles keep async signatures for clarity.
import assert from "node:assert/strict";
import test from "node:test";
import type Stripe from "stripe";
import {
  type BillingPortalDependencies,
  billingPortalResponse,
} from "./portal";

const USER_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const ORIGIN = "https://app.test";

function request(): Request {
  return new Request(`${ORIGIN}/api/billing/portal`, { method: "POST" });
}

function dependencies(
  calls: string[],
  created: Stripe.BillingPortal.SessionCreateParams[] = [],
  overrides: Partial<BillingPortalDependencies> = {}
): BillingPortalDependencies {
  return {
    appBasePath: () => "",
    authenticate: async () => ({
      user: { authVersion: 1, id: USER_ID, type: "subscriber" },
    }),
    authorize: async () => {
      calls.push("authorize");
      return {
        authVersion: 1,
        kind: "allowed",
        session: { id: USER_ID, kind: "subscriber", tenant: "u_x" } as never,
        userId: USER_ID,
      };
    },
    createPortalSession: async (_apiKey, params) => {
      calls.push("portal");
      created.push(params);
      return { url: "https://billing.stripe.test/session" };
    },
    enforceAbuse: async (input) => {
      calls.push(`abuse:${input.route}`);
      return { kind: "allowed" };
    },
    findUser: async () => {
      calls.push("user");
      return { stripeCustomerId: "cus_acme" };
    },
    getApiKey: () => "sk_test",
    origin: () => ORIGIN,
    ...overrides,
  };
}

test("a subscriber is sent to their own Stripe portal session", async () => {
  const calls: string[] = [];
  const created: Stripe.BillingPortal.SessionCreateParams[] = [];

  const response = await billingPortalResponse(
    request(),
    dependencies(calls, created),
    "203.0.113.9"
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    url: "https://billing.stripe.test/session",
  });
  assert.deepEqual(created, [
    {
      customer: "cus_acme",
      return_url: `${ORIGIN}/account?billing=managed`,
    },
  ]);
  assert.deepEqual(calls, [
    "abuse:billing_portal",
    "authorize",
    "user",
    "portal",
  ]);
});

test("the portal stays open while new purchases are paused", async () => {
  // There is no checkout-enabled dependency to switch off: someone who pays
  // must be able to leave even when the product has stopped selling.
  const calls: string[] = [];
  const injected = dependencies(calls);

  assert.equal("checkoutEnabled" in injected, false);
  assert.equal(
    (await billingPortalResponse(request(), injected, null)).status,
    200
  );
});

test("only a signed-in subscriber with a Stripe Customer reaches Stripe", async () => {
  const calls: string[] = [];

  const anonymous = await billingPortalResponse(
    request(),
    dependencies(calls, [], { authenticate: async () => null }),
    null
  );
  assert.equal(anonymous.status, 401);

  const guest = await billingPortalResponse(
    request(),
    dependencies(calls, [], {
      authorize: async () => ({ kind: "subscription_required" }),
    }),
    null
  );
  assert.equal(guest.status, 403);

  const granted = await billingPortalResponse(
    request(),
    dependencies(calls, [], {
      findUser: async () => ({ stripeCustomerId: null }),
    }),
    null
  );
  assert.equal(granted.status, 409);
  assert.deepEqual(await granted.json(), { error: "customer_required" });

  assert.equal(calls.includes("portal"), false);
});

test("provider and configuration failures never leak, and are retryable", async () => {
  const calls: string[] = [];

  const unconfigured = await billingPortalResponse(
    request(),
    dependencies(calls, [], { getApiKey: () => null }),
    null
  );
  assert.equal(unconfigured.status, 503);

  // Stripe refuses when no portal configuration exists in the dashboard.
  const refused = await billingPortalResponse(
    request(),
    dependencies(calls, [], {
      createPortalSession: async () => {
        throw new Error("No configuration provided for cus_secret");
      },
    }),
    null
  );
  assert.equal(refused.status, 503);
  assert.doesNotMatch(await refused.text(), /configuration|cus_/i);

  const missingUrl = await billingPortalResponse(
    request(),
    dependencies(calls, [], {
      createPortalSession: async () => ({ url: null }),
    }),
    null
  );
  assert.equal(missingUrl.status, 503);
});

test("admission runs before authorization and before any Stripe work", async () => {
  const calls: string[] = [];
  const response = await billingPortalResponse(
    request(),
    dependencies(calls, [], {
      enforceAbuse: async (input) => {
        calls.push(`abuse:${input.route}`);
        return {
          kind: "denied" as const,
          responseStatus: 429 as const,
          retryAfterSeconds: 30,
        };
      },
    }),
    "203.0.113.9"
  );

  assert.equal(response.status, 429);
  assert.deepEqual(calls, ["abuse:billing_portal"]);
});
