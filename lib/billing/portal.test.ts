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
    authenticate: async () => ({ authVersion: 1, userId: USER_ID }),
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
      return { authVersion: 1, stripeCustomerId: "cus_acme" };
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
  assert.deepEqual(calls, ["abuse:billing_portal", "user", "portal", "user"]);
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

test("only a current signed-in owner with a Stripe Customer reaches Stripe", async () => {
  const calls: string[] = [];

  const anonymous = await billingPortalResponse(
    request(),
    dependencies(calls, [], { authenticate: async () => null }),
    null
  );
  assert.equal(anonymous.status, 401);

  const revoked = await billingPortalResponse(
    request(),
    dependencies(calls, [], {
      findUser: async () => ({ authVersion: 2, stripeCustomerId: "cus_acme" }),
    }),
    null
  );
  assert.equal(revoked.status, 401);

  const granted = await billingPortalResponse(
    request(),
    dependencies(calls, [], {
      findUser: async () => ({ authVersion: 1, stripeCustomerId: null }),
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

test("admission runs before the account read and any Stripe work", async () => {
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

test("expired billing does not prevent payment recovery or invoice access", async () => {
  const calls: string[] = [];
  const response = await billingPortalResponse(
    request(),
    dependencies(calls, [], {
      findUser: async () => ({
        authVersion: 1,
        stripeCustomerId: "cus_expired",
        subscribedUntil: new Date("2020-01-01T00:00:00Z"),
      }),
    }),
    null
  );
  assert.equal(response.status, 200);
  assert.ok(calls.includes("portal"));
});

test("revocation or customer reassignment during provider work withholds the portal URL", async () => {
  await Promise.all(
    [
      { authVersion: 2, stripeCustomerId: "cus_acme" },
      { authVersion: 1, stripeCustomerId: "cus_reassigned" },
      null,
    ].map(async (changedOwner) => {
      let reads = 0;
      const response = await billingPortalResponse(
        request(),
        dependencies([], [], {
          findUser: async () => {
            reads += 1;
            return reads === 1
              ? { authVersion: 1, stripeCustomerId: "cus_acme" }
              : changedOwner;
          },
        }),
        null
      );
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "unauthorized" });
      assert.equal(reads, 2);
    })
  );
});

test("missing owners, stale credentials, and malformed identities cannot reach billing", async () => {
  const cases: Partial<BillingPortalDependencies>[] = [
    { findUser: async () => null },
    { authenticate: async () => ({ authVersion: 1, userId: "forged" }) },
    { authenticate: async () => ({ authVersion: -1, userId: USER_ID }) },
    {
      findUser: async () => ({
        authVersion: 2,
        stripeCustomerId: "cus_other",
      }),
    },
  ];
  await Promise.all(
    cases.map(async (overrides) => {
      const calls: string[] = [];
      const response = await billingPortalResponse(
        request(),
        dependencies(calls, [], overrides),
        null
      );
      assert.equal(response.status, 401);
      assert.equal(calls.includes("portal"), false);
    })
  );
});
