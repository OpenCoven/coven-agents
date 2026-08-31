import assert from "node:assert/strict";
import test from "node:test";
import type Stripe from "stripe";
import type {
  IdempotencyClaimHandle,
  IdempotencyClaimInput,
  IdempotencyClaimResult,
  IdempotencyCompleteInput,
  IdempotencyReleaseInput,
  IdempotencyStore,
  StoredIdempotencyResponse,
} from "@/lib/abuse/idempotency";
import {
  type CheckoutDependencies,
  type CheckoutProvider,
  checkoutResponse,
} from "./checkout-response";

const USER_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const REQUEST_IDENTIFIER = "checkout-request-1234567890";
const ORIGIN = "https://app.opencoven.dev";

test("disabled checkout performs no abuse, database, or Stripe work", async () => {
  const calls: string[] = [];
  const dependencies = dependenciesFor({
    authenticate: () => {
      calls.push("authenticate");
      return Promise.resolve(session());
    },
    checkoutEnabled: () => {
      calls.push("launch");
      return false;
    },
    createProvider: () => {
      calls.push("stripe");
      throw new Error("Stripe must not be created");
    },
    enforceAbuse: () => {
      calls.push("abuse");
      return Promise.resolve({ kind: "allowed" });
    },
    findUser: () => {
      calls.push("database");
      return Promise.resolve(null);
    },
    idempotencyStore: throwingStore(calls),
  });

  const response = await checkoutResponse(request(), dependencies, null);

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: "subscriptions_unavailable",
  });
  assert.deepEqual(calls, ["authenticate", "launch"]);
});

test("anonymous callers are rejected before launch-state disclosure", async () => {
  const calls: string[] = [];
  const dependencies = dependenciesFor({
    authenticate: () => {
      calls.push("authenticate");
      return Promise.resolve(null);
    },
    checkoutEnabled: () => {
      calls.push("launch");
      return false;
    },
  });

  const response = await checkoutResponse(request(), dependencies, null);

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthorized" });
  assert.deepEqual(calls, ["authenticate"]);
});

test("enabled but misconfigured checkout fails before provider work", async () => {
  let providerCalls = 0;
  const dependencies = dependenciesFor({
    createProvider: () => {
      providerCalls += 1;
      return defaultProvider();
    },
    getCheckoutConfig: () => {
      throw new Error(
        "Subscription Checkout requires nonblank environment variables."
      );
    },
  });

  const response = await checkoutResponse(request(), dependencies, null);

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "billing_unavailable" });
  assert.equal(providerCalls, 0);
});

test("enabled checkout preserves the required operation order", async () => {
  const calls: string[] = [];
  const dependencies = dependenciesFor({
    attachCustomer: () => {
      calls.push("attach customer");
      return Promise.resolve();
    },
    authenticate: () => {
      calls.push("authenticate");
      return Promise.resolve(session());
    },
    checkoutEnabled: () => {
      calls.push("launch");
      return true;
    },
    createProvider: () => {
      calls.push("create Stripe client");
      return defaultProvider({
        createCheckoutSession: () => {
          calls.push("create Checkout");
          return Promise.resolve({
            url: "https://checkout.stripe.test/session",
          });
        },
        createCustomer: () => {
          calls.push("create Customer");
          return Promise.resolve({ id: "cus_new" });
        },
      });
    },
    enforceAbuse: () => {
      calls.push("abuse");
      return Promise.resolve({ kind: "allowed" });
    },
    findUser: () => {
      calls.push("read user");
      return Promise.resolve({ stripeCustomerId: null });
    },
    getCheckoutConfig: () => {
      calls.push("configuration");
      return {
        apiKey: "sk_test_checkout",
        enabled: true,
        priceId: "price_configured",
        webhookSecret: "whsec_configured",
      };
    },
    idempotencyStore: new MemoryIdempotencyStore((operation) =>
      calls.push(operation)
    ),
  });

  const response = await checkoutResponse(request(), dependencies, null);

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    "authenticate",
    "launch",
    "abuse",
    "idempotency cleanup",
    "idempotency claim",
    "configuration",
    "read user",
    "create Stripe client",
    "create Customer",
    "attach customer",
    "create Checkout",
    "idempotency complete",
  ]);
});

test("same browser key reuses provider keys and integration identifier on retry", async () => {
  const customerKeys: string[] = [];
  const sessionKeys: string[] = [];
  const integrationIdentifiers: string[] = [];
  let sessionAttempt = 0;
  const provider = defaultProvider({
    createCheckoutSession(input, options) {
      sessionAttempt += 1;
      sessionKeys.push(options.idempotencyKey);
      integrationIdentifiers.push(input.integration_identifier ?? "");
      return Promise.resolve({
        url:
          sessionAttempt === 1 ? null : "https://checkout.stripe.test/session",
      });
    },
    createCustomer(_input, options) {
      customerKeys.push(options.idempotencyKey);
      return Promise.resolve({ id: "cus_stable" });
    },
  });
  const dependencies = dependenciesFor({
    createProvider: () => provider,
    findUser: () => Promise.resolve({ stripeCustomerId: null }),
  });

  const first = await checkoutResponse(request(), dependencies, null);
  const retry = await checkoutResponse(request(), dependencies, null);

  assert.equal(first.status, 502);
  assert.equal(retry.status, 200);
  assert.equal(customerKeys.length, 2);
  assert.equal(sessionKeys.length, 2);
  assert.equal(integrationIdentifiers.length, 2);
  assert.equal(customerKeys[0], customerKeys[1]);
  assert.equal(sessionKeys[0], sessionKeys[1]);
  assert.equal(integrationIdentifiers[0], integrationIdentifiers[1]);
  assert.notEqual(customerKeys[0], sessionKeys[0]);
  assert.match(integrationIdentifiers[0] ?? "", /[a-z]{8}$/);
});

test("Customer and Checkout creation use separate derived idempotency keys", async () => {
  let customerKey = "";
  let sessionKey = "";
  const dependencies = dependenciesFor({
    createProvider: () =>
      defaultProvider({
        createCheckoutSession(_input, options) {
          sessionKey = options.idempotencyKey;
          return Promise.resolve({
            url: "https://checkout.stripe.test/session",
          });
        },
        createCustomer(_input, options) {
          customerKey = options.idempotencyKey;
          return Promise.resolve({ id: "cus_new" });
        },
      }),
    findUser: () => Promise.resolve({ stripeCustomerId: null }),
  });

  const response = await checkoutResponse(request(), dependencies, null);

  assert.equal(response.status, 200);
  assert.match(customerKey, /:customer$/);
  assert.match(sessionKey, /:session$/);
  assert.notEqual(customerKey, sessionKey);
});

test("every blocking subscription status returns already_subscribed", async (t) => {
  await Promise.all(
    (
      [
        "active",
        "trialing",
        "past_due",
        "unpaid",
        "paused",
        "incomplete",
      ] satisfies Stripe.Subscription.Status[]
    ).map((status) =>
      t.test(status, async () => {
        let checkoutCalls = 0;
        const dependencies = dependenciesFor({
          createProvider: () =>
            defaultProvider({
              createCheckoutSession() {
                checkoutCalls += 1;
                return Promise.resolve({ url: "impossible" });
              },
              listSubscriptions: () => Promise.resolve({ data: [{ status }] }),
            }),
        });

        const response = await checkoutResponse(request(), dependencies, null);

        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), {
          error: "already_subscribed",
        });
        assert.equal(checkoutCalls, 0);
      })
    )
  );
});

test("terminal subscriptions allow a new Checkout Session", async (t) => {
  await Promise.all(
    (
      ["canceled", "incomplete_expired"] satisfies Stripe.Subscription.Status[]
    ).map((status) =>
      t.test(status, async () => {
        const dependencies = dependenciesFor({
          createProvider: () =>
            defaultProvider({
              listSubscriptions: () => Promise.resolve({ data: [{ status }] }),
            }),
        });

        const response = await checkoutResponse(request(), dependencies, null);

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
          url: "https://checkout.stripe.test/session",
        });
      })
    )
  );
});

test("Checkout carries the user, configured Price, and account return URLs", async () => {
  let attached: { customerId: string; userId: string } | null = null;
  let customerInput: Stripe.CustomerCreateParams | null = null;
  const checkoutInput: {
    value: Stripe.Checkout.SessionCreateParams | null;
  } = { value: null };
  const dependencies = dependenciesFor({
    attachCustomer(userId, customerId) {
      attached = { customerId, userId };
      return Promise.resolve();
    },
    createProvider: () =>
      defaultProvider({
        createCheckoutSession(input) {
          checkoutInput.value = input;
          return Promise.resolve({
            url: "https://checkout.stripe.test/session",
          });
        },
        createCustomer(input) {
          customerInput = input;
          return Promise.resolve({ id: "cus_new" });
        },
      }),
    findUser: () => Promise.resolve({ stripeCustomerId: null }),
  });

  const response = await checkoutResponse(request(), dependencies, null);

  assert.equal(response.status, 200);
  assert.deepEqual(customerInput, { metadata: { userId: USER_ID } });
  assert.deepEqual(attached, { customerId: "cus_new", userId: USER_ID });
  assert.ok(checkoutInput.value);
  assert.deepEqual(checkoutInput.value, {
    cancel_url: `${ORIGIN}/account?checkout=cancelled`,
    client_reference_id: USER_ID,
    customer: "cus_new",
    integration_identifier: checkoutInput.value.integration_identifier,
    line_items: [{ price: "price_configured", quantity: 1 }],
    metadata: { userId: USER_ID },
    mode: "subscription",
    subscription_data: { metadata: { userId: USER_ID } },
    success_url: `${ORIGIN}/account?checkout=success`,
  });
  assert.match(checkoutInput.value.integration_identifier ?? "", /[a-z]{8}$/);
  assert.equal(
    Object.hasOwn(checkoutInput.value, "payment_method_types"),
    false
  );
  assert.equal(Object.hasOwn(checkoutInput.value, "automatic_tax"), false);
});

test("a null Checkout URL returns an explicit failure", async () => {
  const dependencies = dependenciesFor({
    createProvider: () =>
      defaultProvider({
        createCheckoutSession: () => Promise.resolve({ url: null }),
      }),
  });

  const response = await checkoutResponse(request(), dependencies, null);

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "checkout_failed" });
});

test("Stripe failures return explicit non-success responses", async (t) => {
  const cases: {
    name: string;
    createProvider: () => CheckoutProvider;
    userHasCustomer: boolean;
  }[] = [
    {
      createProvider: () => {
        throw new Error("Stripe failed");
      },
      name: "client creation",
      userHasCustomer: true,
    },
    {
      createProvider: () =>
        defaultProvider({
          listSubscriptions: () => Promise.reject(new Error("Stripe failed")),
        }),
      name: "subscription lookup",
      userHasCustomer: true,
    },
    {
      createProvider: () =>
        defaultProvider({
          createCustomer: () => Promise.reject(new Error("Stripe failed")),
        }),
      name: "Customer creation",
      userHasCustomer: false,
    },
    {
      createProvider: () =>
        defaultProvider({
          createCheckoutSession: () =>
            Promise.reject(new Error("Stripe failed")),
        }),
      name: "Checkout creation",
      userHasCustomer: true,
    },
  ];

  await Promise.all(
    cases.map((entry) =>
      t.test(entry.name, async () => {
        const dependencies = dependenciesFor({
          createProvider: entry.createProvider,
          findUser: () =>
            Promise.resolve({
              stripeCustomerId: entry.userHasCustomer ? "cus_existing" : null,
            }),
        });

        const response = await checkoutResponse(request(), dependencies, null);

        assert.equal(response.status, 502);
        assert.deepEqual(await response.json(), { error: "checkout_failed" });
      })
    )
  );
});

function dependenciesFor(
  overrides: Partial<CheckoutDependencies> = {}
): CheckoutDependencies {
  return {
    attachCustomer: () => Promise.resolve(),
    authenticate: () => Promise.resolve(session()),
    checkoutEnabled: () => true,
    createProvider: () => defaultProvider(),
    enforceAbuse: () => Promise.resolve({ kind: "allowed" }),
    findUser: () => Promise.resolve({ stripeCustomerId: "cus_existing" }),
    getCheckoutConfig: () => ({
      apiKey: "sk_test_checkout",
      enabled: true,
      priceId: "price_configured",
      webhookSecret: "whsec_configured",
    }),
    idempotencyStore: new MemoryIdempotencyStore(),
    origin: () => ORIGIN,
    ...overrides,
  };
}

function defaultProvider(
  overrides: Partial<CheckoutProvider> = {}
): CheckoutProvider {
  return {
    createCheckoutSession: () =>
      Promise.resolve({ url: "https://checkout.stripe.test/session" }),
    createCustomer: () => Promise.resolve({ id: "cus_new" }),
    listSubscriptions: () => Promise.resolve({ data: [] }),
    ...overrides,
  };
}

function request() {
  return new Request(`${ORIGIN}/api/checkout`, {
    headers: { "idempotency-key": REQUEST_IDENTIFIER },
    method: "POST",
  });
}

function session() {
  return { user: { id: USER_ID } };
}

function throwingStore(calls: string[]): IdempotencyStore {
  return {
    claim() {
      calls.push("database");
      throw new Error("Idempotency store must not be called");
    },
    cleanupExpired() {
      calls.push("database");
      throw new Error("Idempotency store must not be called");
    },
    complete() {
      calls.push("database");
      throw new Error("Idempotency store must not be called");
    },
    release() {
      calls.push("database");
      throw new Error("Idempotency store must not be called");
    },
  };
}

class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly recordOperation: (operation: string) => void;

  private record:
    | {
        claim: IdempotencyClaimHandle;
        response: StoredIdempotencyResponse | null;
      }
    | undefined;

  constructor(recordOperation: (operation: string) => void = () => undefined) {
    this.recordOperation = recordOperation;
  }

  claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
    this.recordOperation("idempotency claim");
    if (!this.record) {
      const claim = {
        claimExpiresAt: input.claimExpiresAt,
        keyHash: input.keyHash,
        operation: input.operation,
        ownerId: input.ownerId,
        requestHash: input.requestHash,
      };
      this.record = { claim, response: null };
      return Promise.resolve({ claim, kind: "claimed" });
    }
    if (this.record.claim.requestHash !== input.requestHash) {
      return Promise.resolve({ kind: "conflict" });
    }
    if (!this.record.response) {
      return Promise.resolve({ kind: "in_progress" });
    }
    return Promise.resolve({
      kind: "completed",
      response: this.record.response,
    });
  }

  cleanupExpired(): Promise<void> {
    this.recordOperation("idempotency cleanup");
    return Promise.resolve();
  }

  complete(input: IdempotencyCompleteInput): Promise<void> {
    this.recordOperation("idempotency complete");
    assert.ok(this.record);
    this.record.response = input.response;
    return Promise.resolve();
  }

  release(_input: IdempotencyReleaseInput): Promise<void> {
    this.recordOperation("idempotency release");
    this.record = undefined;
    return Promise.resolve();
  }
}
