// biome-ignore-all lint/suspicious/useAwait: dependency doubles keep async signatures for clarity.
import assert from "node:assert/strict";
import test from "node:test";
import type Stripe from "stripe";
import {
  type MinutePackCheckoutDependencies,
  minutePackCheckoutResponse,
} from "./minute-pack-checkout";

const USER_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const ORIGIN = "https://app.test";
const PACKS = [
  { minutes: 100, priceId: "price_small" },
  { minutes: 300, priceId: "price_mid" },
];

function request(body: unknown = { priceId: "price_mid" }): Request {
  return new Request(`${ORIGIN}/api/minute-packs/checkout`, {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function dependencies(
  calls: string[],
  created: Stripe.Checkout.SessionCreateParams[] = [],
  overrides: Partial<MinutePackCheckoutDependencies> = {}
): MinutePackCheckoutDependencies {
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
    checkoutEnabled: () => true,
    createCheckoutSession: async (_apiKey, params) => {
      calls.push("create");
      created.push(params);
      return { url: "https://checkout.stripe.test/cs_pack" };
    },
    enforceAbuse: async (input) => {
      calls.push(`abuse:${input.route}`);
      return { kind: "allowed" };
    },
    findUser: async () => {
      calls.push("user");
      return { stripeCustomerId: "cus_acme" };
    },
    getCheckoutConfig: () => ({
      apiKey: "sk_test",
      enabled: true,
      priceId: "price_plan",
      webhookSecret: "whsec_test",
    }),
    minutePacks: () => PACKS,
    origin: () => ORIGIN,
    ...overrides,
  };
}

test("a subscriber gets a one-time Checkout for the chosen pack with every app-owned marker", async () => {
  const calls: string[] = [];
  const created: Stripe.Checkout.SessionCreateParams[] = [];
  const response = await minutePackCheckoutResponse(
    request(),
    dependencies(calls, created),
    "203.0.113.9"
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    minutes: 300,
    url: "https://checkout.stripe.test/cs_pack",
  });
  assert.deepEqual(calls, [
    "abuse:minute_pack_checkout",
    "authorize",
    "user",
    "create",
  ]);
  assert.deepEqual(created, [
    {
      cancel_url: `${ORIGIN}/account?minutes=cancelled`,
      client_reference_id: USER_ID,
      customer: "cus_acme",
      line_items: [{ price: "price_mid", quantity: 1 }],
      metadata: {
        kind: "minute_pack",
        minutePackFlowVersion: "1",
        minutes: "300",
        priceId: "price_mid",
        userId: USER_ID,
      },
      mode: "payment",
      success_url: `${ORIGIN}/account?minutes=added`,
    },
  ]);
});

test("packs are unavailable without a signed-in user, checkout, or configured packs", async () => {
  const calls: string[] = [];
  const anonymous = await minutePackCheckoutResponse(
    request(),
    dependencies(calls, [], { authenticate: async () => null }),
    null
  );
  assert.equal(anonymous.status, 401);

  const disabled = await minutePackCheckoutResponse(
    request(),
    dependencies(calls, [], { checkoutEnabled: () => false }),
    null
  );
  assert.equal(disabled.status, 404);

  const none = await minutePackCheckoutResponse(
    request(),
    dependencies(calls, [], { minutePacks: () => [] }),
    null
  );
  assert.equal(none.status, 404);
  assert.deepEqual(calls, []);
});

test("only active subscribers with a Stripe Customer can buy a pack", async () => {
  const calls: string[] = [];
  const guest = await minutePackCheckoutResponse(
    request(),
    dependencies(calls, [], {
      authorize: async () => ({ kind: "subscription_required" }),
    }),
    null
  );
  assert.equal(guest.status, 403);

  const granted = await minutePackCheckoutResponse(
    request(),
    dependencies(calls, [], {
      findUser: async () => ({ stripeCustomerId: null }),
    }),
    null
  );
  assert.equal(granted.status, 409);
  assert.deepEqual(await granted.json(), { error: "customer_required" });
  assert.ok(!calls.includes("create"));
});

test("the body must name a configured pack", async () => {
  const calls: string[] = [];
  for (const [body, status, error] of [
    ["{", 400, "invalid_body"],
    [{ priceId: "prod_x" }, 400, "invalid_body"],
    [{ priceId: "price_unknown" }, 404, "minute_pack_unknown"],
    [
      `{"priceId":"price_mid","pad":"${"x".repeat(2000)}"}`,
      413,
      "body_too_large",
    ],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: Each case is independent and readable in order.
    const response = await minutePackCheckoutResponse(
      request(body),
      dependencies(calls),
      null
    );
    assert.equal(response.status, status, String(body));
    assert.deepEqual(await response.json(), { error });
  }
  assert.ok(!calls.includes("create"));
});

test("provider failures and missing destinations never leak and are retryable", async () => {
  const calls: string[] = [];
  const failed = await minutePackCheckoutResponse(
    request(),
    dependencies(calls, [], {
      createCheckoutSession: async () => {
        throw new Error("stripe exploded with cus_secret");
      },
    }),
    null
  );
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: "billing_unavailable" });

  const missing = await minutePackCheckoutResponse(
    request(),
    dependencies(calls, [], {
      createCheckoutSession: async () => ({ url: null }),
    }),
    null
  );
  assert.equal(missing.status, 503);
});
