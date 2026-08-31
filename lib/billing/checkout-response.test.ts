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
import { hasBlockingSubscription } from "@/lib/billing/checkout";
import type {
  CheckoutAttemptLease,
  CheckoutAttemptLeaseClaimInput,
  CheckoutAttemptLeaseClaimResult,
  CheckoutAttemptLeaseReleaseInput,
  CheckoutAttemptLeaseRenewInput,
  CheckoutAttemptLeaseStore,
} from "@/lib/billing/checkout-lease";
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
      return Promise.resolve("cus_new");
    },
    authenticate: () => {
      calls.push("authenticate");
      return Promise.resolve(session());
    },
    checkoutEnabled: () => {
      calls.push("launch");
      return true;
    },
    checkoutLeaseStore: new MemoryCheckoutAttemptLeaseStore((operation) =>
      calls.push(operation)
    ),
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
    "checkout lease claim",
    "read user",
    "create Stripe client",
    "create Customer",
    "attach customer",
    "create Checkout",
    "checkout lease renew",
    "checkout lease release",
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

test("concurrent distinct browser keys create only one payable Checkout attempt", async () => {
  let attachedCustomerId: string | null = null;
  let customerCalls = 0;
  let releaseFirstCustomer!: () => void;
  let sessionCalls = 0;
  let signalFirstCustomerStarted!: () => void;
  const firstCustomerStarted = new Promise<void>((resolve) => {
    signalFirstCustomerStarted = resolve;
  });
  const firstCustomerGate = new Promise<void>((resolve) => {
    releaseFirstCustomer = resolve;
  });
  const dependencies = dependenciesFor({
    attachCustomer: (_userId, customerId) => {
      attachedCustomerId ??= customerId;
      return Promise.resolve(attachedCustomerId);
    },
    createProvider: () =>
      defaultProvider({
        createCheckoutSession(input) {
          sessionCalls += 1;
          return Promise.resolve({
            url: `https://checkout.stripe.test/${input.customer}`,
          });
        },
        async createCustomer() {
          customerCalls += 1;
          if (customerCalls === 1) {
            signalFirstCustomerStarted();
            await firstCustomerGate;
          }
          return { id: `cus_${customerCalls}` };
        },
      }),
    findUser: () => Promise.resolve({ stripeCustomerId: attachedCustomerId }),
  });

  const first = checkoutResponse(
    request("checkout-request-distinct-one"),
    dependencies,
    null
  );
  await firstCustomerStarted;
  const concurrent = await checkoutResponse(
    request("checkout-request-distinct-two"),
    dependencies,
    null
  );

  assert.equal(concurrent.status, 409);
  assert.deepEqual(await concurrent.json(), { error: "request_in_progress" });

  releaseFirstCustomer();
  const completed = await first;

  assert.equal(completed.status, 200);
  assert.equal(customerCalls, 1);
  assert.equal(sessionCalls, 1);
  assert.equal(attachedCustomerId, "cus_1");
});

test("an expired lease takeover reuses provider identities and fences the stale holder", async () => {
  const leaseStore = new MemoryCheckoutAttemptLeaseStore();
  let attachedCustomerId: string | null = null;
  let releaseCustomer!: () => void;
  let signalCustomerStarted!: () => void;
  const customerStarted = new Promise<void>((resolve) => {
    signalCustomerStarted = resolve;
  });
  const customerGate = new Promise<void>((resolve) => {
    releaseCustomer = resolve;
  });
  const customerByKey = new Map<string, string>();
  const sessionByKey = new Map<string, string>();
  const customerKeys: string[] = [];
  const sessionKeys: string[] = [];
  const dependencies = dependenciesFor({
    attachCustomer: (_userId, customerId) => {
      attachedCustomerId ??= customerId;
      return Promise.resolve(attachedCustomerId);
    },
    checkoutLeaseStore: leaseStore,
    createProvider: () =>
      defaultProvider({
        createCheckoutSession(_input, options) {
          sessionKeys.push(options.idempotencyKey);
          let url = sessionByKey.get(options.idempotencyKey);
          if (!url) {
            url = `https://checkout.stripe.test/session-${sessionByKey.size + 1}`;
            sessionByKey.set(options.idempotencyKey, url);
          }
          return Promise.resolve({ url });
        },
        async createCustomer(_input, options) {
          customerKeys.push(options.idempotencyKey);
          let customerId = customerByKey.get(options.idempotencyKey);
          if (!customerId) {
            customerId = `cus_${customerByKey.size + 1}`;
            customerByKey.set(options.idempotencyKey, customerId);
          }
          if (customerKeys.length === 1) {
            signalCustomerStarted();
          }
          await customerGate;
          return { id: customerId };
        },
      }),
    findUser: () => Promise.resolve({ stripeCustomerId: attachedCustomerId }),
  });

  const stale = checkoutResponse(
    request("checkout-request-expired-owner"),
    dependencies,
    null
  );
  await customerStarted;
  leaseStore.expireCheckoutLease();
  const successor = checkoutResponse(
    request("checkout-request-successor"),
    dependencies,
    null
  );

  releaseCustomer();
  const [staleResponse, successorResponse] = await Promise.all([
    stale,
    successor,
  ]);

  assert.equal(staleResponse.status, 409);
  assert.deepEqual(await staleResponse.json(), {
    error: "request_in_progress",
  });
  assert.equal(successorResponse.status, 200);
  assert.equal(new Set(customerKeys).size, 1);
  assert.equal(new Set(sessionKeys).size, 1);
  assert.equal(customerByKey.size, 1);
  assert.equal(sessionByKey.size, 1);
  assert.equal(leaseStore.staleReleaseCount, 1);
  assert.equal(leaseStore.successorWasDeletedByStaleRelease, false);
});

test("a later distinct browser key reuses the open Checkout Session", async () => {
  let openCheckout: ReturnType<typeof openCheckoutSession> | null = null;
  let sessionCalls = 0;
  const dependencies = dependenciesFor({
    createProvider: () =>
      defaultProvider({
        createCheckoutSession() {
          sessionCalls += 1;
          openCheckout = openCheckoutSession({
            id: `cs_${sessionCalls}`,
            metadata: {
              checkoutFlowVersion: "1",
              priceId: "price_configured",
              userId: USER_ID,
            },
            url: `https://checkout.stripe.test/session-${sessionCalls}`,
          });
          return Promise.resolve({ url: openCheckout.url });
        },
        listOpenCheckoutSessions: () =>
          Promise.resolve({
            data: openCheckout ? [openCheckout] : [],
            hasMore: false,
          }),
      }),
  });

  const first = await checkoutResponse(
    request("checkout-request-distinct-one"),
    dependencies,
    null
  );
  const later = await checkoutResponse(
    request("checkout-request-distinct-two"),
    dependencies,
    null
  );

  assert.equal(first.status, 200);
  assert.equal(later.status, 200);
  assert.deepEqual(await first.json(), {
    url: "https://checkout.stripe.test/session-1",
  });
  assert.deepEqual(await later.json(), {
    url: "https://checkout.stripe.test/session-1",
  });
  assert.equal(sessionCalls, 1);
});

test("a later request reuses the provider Session key when open-session listing lags", async () => {
  const sessionByKey = new Map<string, string>();
  const sessionKeys: string[] = [];
  const dependencies = dependenciesFor({
    createProvider: () =>
      defaultProvider({
        createCheckoutSession(_input, options) {
          sessionKeys.push(options.idempotencyKey);
          let url = sessionByKey.get(options.idempotencyKey);
          if (!url) {
            url = `https://checkout.stripe.test/session-${sessionByKey.size + 1}`;
            sessionByKey.set(options.idempotencyKey, url);
          }
          return Promise.resolve({ url });
        },
        listOpenCheckoutSessions: () =>
          Promise.resolve({ data: [], hasMore: false }),
      }),
  });

  const first = await checkoutResponse(
    request("checkout-request-first-success"),
    dependencies,
    null
  );
  const later = await checkoutResponse(
    request("checkout-request-list-lag"),
    dependencies,
    null
  );

  assert.equal(first.status, 200);
  assert.equal(later.status, 200);
  assert.equal(new Set(sessionKeys).size, 1);
  assert.equal(sessionByKey.size, 1);
  assert.deepEqual(await later.json(), await first.json());
});

test("a matching current-price Checkout Session is reused across pages", async () => {
  const listCursors: Array<string | undefined> = [];
  let checkoutCalls = 0;
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    openCheckoutSession({
      id: `cs_unowned_${index}`,
      metadata: {},
      userId: `other-user-${index}`,
    })
  );
  const provider = Object.assign(
    defaultProvider({
      createCheckoutSession() {
        checkoutCalls += 1;
        return Promise.resolve({ url: "impossible" });
      },
    }),
    {
      expireCheckoutSession() {
        return Promise.resolve();
      },
      listOpenCheckoutSessions(input: Stripe.Checkout.SessionListParams) {
        listCursors.push(input.starting_after);
        if (input.starting_after === firstPage.at(-1)?.id) {
          return Promise.resolve({
            data: [
              openCheckoutSession({
                id: "cs_current",
                metadata: {
                  checkoutFlowVersion: "1",
                  priceId: "price_configured",
                  userId: USER_ID,
                },
                url: "https://checkout.stripe.test/current",
              }),
            ],
            hasMore: false,
          });
        }
        return Promise.resolve({ data: firstPage, hasMore: true });
      },
    }
  );
  const dependencies = dependenciesFor({ createProvider: () => provider });

  const response = await checkoutResponse(request(), dependencies, null);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    url: "https://checkout.stripe.test/current",
  });
  assert.deepEqual(listCursors, [undefined, firstPage.at(-1)?.id]);
  assert.equal(checkoutCalls, 0);
});

test("obsolete app-owned Checkout Sessions expire before a replacement is created", async () => {
  const calls: string[] = [];
  const provider = Object.assign(
    defaultProvider({
      createCheckoutSession() {
        calls.push("create");
        return Promise.resolve({
          url: "https://checkout.stripe.test/replacement",
        });
      },
    }),
    {
      expireCheckoutSession(sessionId: string) {
        calls.push(`expire ${sessionId}`);
        return Promise.resolve();
      },
      listOpenCheckoutSessions() {
        return Promise.resolve({
          data: [
            openCheckoutSession({
              id: "cs_old_price",
              metadata: {
                checkoutFlowVersion: "1",
                priceId: "price_retired",
                userId: USER_ID,
              },
            }),
            openCheckoutSession({
              id: "cs_old_version",
              metadata: {
                checkoutFlowVersion: "0",
                priceId: "price_configured",
                userId: USER_ID,
              },
            }),
          ],
          hasMore: false,
        });
      },
    }
  );
  const dependencies = dependenciesFor({ createProvider: () => provider });

  const response = await checkoutResponse(request(), dependencies, null);

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    "expire cs_old_price",
    "expire cs_old_version",
    "create",
  ]);
});

test("a recovered attempt uses a new Session key after the configured Price changes", async () => {
  const calls: string[] = [];
  const sessionKeys: string[] = [];
  let configuredPrice = "price_retired";
  let openCheckout: ReturnType<typeof openCheckoutSession> | null = null;
  const dependencies = dependenciesFor({
    createProvider: () =>
      defaultProvider({
        createCheckoutSession(input, options) {
          calls.push(`create ${input.line_items?.[0]?.price}`);
          sessionKeys.push(options.idempotencyKey);
          if (sessionKeys.length === 1) {
            openCheckout = openCheckoutSession({
              id: "cs_uncertain_old_price",
              integrationIdentifier: input.integration_identifier ?? null,
              metadata: {
                checkoutFlowVersion: "1",
                priceId: "price_retired",
                userId: USER_ID,
              },
            });
            return Promise.resolve({ url: null });
          }
          return Promise.resolve({
            url: "https://checkout.stripe.test/current-price",
          });
        },
        expireCheckoutSession(sessionId) {
          calls.push(`expire ${sessionId}`);
          openCheckout = null;
          return Promise.resolve();
        },
        listOpenCheckoutSessions: () =>
          Promise.resolve({
            data: openCheckout ? [openCheckout] : [],
            hasMore: false,
          }),
      }),
    getCheckoutConfig: () => ({
      apiKey: "sk_test_checkout",
      enabled: true,
      priceId: configuredPrice,
      webhookSecret: "whsec_configured",
    }),
  });

  const uncertain = await checkoutResponse(request(), dependencies, null);
  configuredPrice = "price_configured";
  const cleanup = await checkoutResponse(request(), dependencies, null);
  const recovered = await checkoutResponse(request(), dependencies, null);

  assert.equal(uncertain.status, 502);
  assert.equal(cleanup.status, 409);
  assert.deepEqual(await cleanup.json(), { error: "request_in_progress" });
  assert.equal(recovered.status, 200);
  assert.deepEqual(calls, [
    "create price_retired",
    "expire cs_uncertain_old_price",
    "create price_configured",
  ]);
  assert.notEqual(sessionKeys[0], sessionKeys[1]);
});

test("Checkout cleanup failure returns non-success without creating another Session", async () => {
  let checkoutCalls = 0;
  const provider = Object.assign(
    defaultProvider({
      createCheckoutSession() {
        checkoutCalls += 1;
        return Promise.resolve({ url: "impossible" });
      },
    }),
    {
      expireCheckoutSession() {
        return Promise.reject(new Error("Stripe expiration failed"));
      },
      listOpenCheckoutSessions() {
        return Promise.resolve({
          data: [
            openCheckoutSession({
              id: "cs_obsolete",
              metadata: {
                checkoutFlowVersion: "0",
                priceId: "price_retired",
                userId: USER_ID,
              },
            }),
          ],
          hasMore: false,
        });
      },
    }
  );
  const dependencies = dependenciesFor({ createProvider: () => provider });

  const response = await checkoutResponse(request(), dependencies, null);

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "checkout_session_conflict",
  });
  assert.equal(checkoutCalls, 0);
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

test("Checkout uses the Customer that won the atomic ownership attachment", async () => {
  let checkoutCustomer: string | undefined;
  const dependencies = dependenciesFor({
    attachCustomer: () => Promise.resolve("cus_owned"),
    createProvider: () =>
      defaultProvider({
        createCheckoutSession(input) {
          checkoutCustomer =
            typeof input.customer === "string" ? input.customer : undefined;
          return Promise.resolve({
            url: "https://checkout.stripe.test/session",
          });
        },
        createCustomer: () => Promise.resolve({ id: "cus_racing" }),
      }),
    findUser: () => Promise.resolve({ stripeCustomerId: null }),
  });

  const response = await checkoutResponse(request(), dependencies, null);

  assert.equal(response.status, 200);
  assert.equal(checkoutCustomer, "cus_owned");
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
              hasBlockingSubscription: () => Promise.resolve(true),
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

test("a blocking subscription on a later page prevents Checkout", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: `sub_terminal_${index}`,
    status: "canceled" as const,
  }));
  const startingAfter: Array<string | undefined> = [];
  let checkoutCalls = 0;
  const dependencies = dependenciesFor({
    createProvider: () =>
      defaultProvider({
        createCheckoutSession() {
          checkoutCalls += 1;
          return Promise.resolve({ url: "impossible" });
        },
        hasBlockingSubscription: (customerId) =>
          hasBlockingSubscription(customerId, (input) => {
            startingAfter.push(input.starting_after);
            if (input.starting_after === firstPage.at(-1)?.id) {
              return Promise.resolve({
                data: [{ id: "sub_blocking", status: "active" as const }],
                hasMore: false,
              });
            }
            return Promise.resolve({ data: firstPage, hasMore: true });
          }),
      }),
  });

  const response = await checkoutResponse(request(), dependencies, null);

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "already_subscribed" });
  assert.deepEqual(startingAfter, [undefined, firstPage.at(-1)?.id]);
  assert.equal(checkoutCalls, 0);
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
              hasBlockingSubscription: () => Promise.resolve(false),
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
      return Promise.resolve(customerId);
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
    metadata: {
      checkoutFlowVersion: "1",
      priceId: "price_configured",
      userId: USER_ID,
    },
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
          hasBlockingSubscription: () =>
            Promise.reject(new Error("Stripe failed")),
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
    attachCustomer: (_userId, customerId) => Promise.resolve(customerId),
    authenticate: () => Promise.resolve(session()),
    checkoutEnabled: () => true,
    checkoutLeaseStore: new MemoryCheckoutAttemptLeaseStore(),
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
    expireCheckoutSession: () => Promise.resolve(),
    hasBlockingSubscription: () => Promise.resolve(false),
    listOpenCheckoutSessions: () =>
      Promise.resolve({ data: [], hasMore: false }),
    ...overrides,
  };
}

function request(idempotencyKey = REQUEST_IDENTIFIER) {
  return new Request(`${ORIGIN}/api/checkout`, {
    headers: { "idempotency-key": idempotencyKey },
    method: "POST",
  });
}

function session() {
  return { user: { id: USER_ID } };
}

function openCheckoutSession(input: {
  id: string;
  integrationIdentifier?: string | null;
  metadata: Record<string, string>;
  url?: string;
  userId?: string;
}) {
  return {
    clientReferenceId: input.userId ?? USER_ID,
    id: input.id,
    integrationIdentifier: input.integrationIdentifier ?? null,
    metadata: input.metadata,
    mode: "subscription" as const,
    url: input.url ?? `https://checkout.stripe.test/${input.id}`,
  };
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

  private readonly records = new Map<
    string,
    {
      claim: IdempotencyClaimHandle;
      response: StoredIdempotencyResponse | null;
    }
  >();

  constructor(recordOperation: (operation: string) => void = () => undefined) {
    this.recordOperation = recordOperation;
  }

  claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
    this.recordOperation("idempotency claim");
    const scope = idempotencyScope(input);
    const record = this.records.get(scope);
    if (!record) {
      const claim = {
        claimExpiresAt: input.claimExpiresAt,
        keyHash: input.keyHash,
        operation: input.operation,
        ownerId: input.ownerId,
        requestHash: input.requestHash,
      };
      this.records.set(scope, { claim, response: null });
      return Promise.resolve({ claim, kind: "claimed" });
    }
    if (record.claim.requestHash !== input.requestHash) {
      return Promise.resolve({ kind: "conflict" });
    }
    if (!record.response) {
      return Promise.resolve({ kind: "in_progress" });
    }
    return Promise.resolve({
      kind: "completed",
      response: record.response,
    });
  }

  cleanupExpired(): Promise<void> {
    this.recordOperation("idempotency cleanup");
    return Promise.resolve();
  }

  complete(input: IdempotencyCompleteInput): Promise<void> {
    this.recordOperation("idempotency complete");
    const record = this.records.get(idempotencyScope(input.claim));
    assert.ok(record);
    record.response = input.response;
    return Promise.resolve();
  }

  release(input: IdempotencyReleaseInput): Promise<void> {
    this.recordOperation("idempotency release");
    this.records.delete(idempotencyScope(input.claim));
    return Promise.resolve();
  }
}

class MemoryCheckoutAttemptLeaseStore implements CheckoutAttemptLeaseStore {
  staleReleaseCount = 0;
  successorWasDeletedByStaleRelease = false;
  private nextAttemptId = 1;
  private readonly recordOperation: (operation: string) => void;
  private record:
    | {
        attemptId: string;
        expiresAt: Date;
        ownerId: string;
        ownerToken: string;
      }
    | undefined;

  constructor(recordOperation: (operation: string) => void = () => undefined) {
    this.recordOperation = recordOperation;
  }

  claim(
    input: CheckoutAttemptLeaseClaimInput
  ): Promise<CheckoutAttemptLeaseClaimResult> {
    this.recordOperation("checkout lease claim");
    if (this.record && this.record.expiresAt.getTime() > input.now.getTime()) {
      return Promise.resolve({ kind: "in_progress" });
    }

    if (this.record) {
      this.record.expiresAt = input.leaseExpiresAt;
      this.record.ownerToken = input.ownerToken;
    } else {
      this.record = {
        attemptId: `attempt-${this.nextAttemptId}`,
        expiresAt: input.leaseExpiresAt,
        ownerId: input.ownerId,
        ownerToken: input.ownerToken,
      };
      this.nextAttemptId += 1;
    }
    return Promise.resolve({
      kind: "claimed",
      lease: checkoutAttemptLease(this.record),
    });
  }

  expireCheckoutLease() {
    assert.ok(this.record);
    this.record.expiresAt = new Date(0);
  }

  release(
    input: CheckoutAttemptLeaseReleaseInput
  ): Promise<"lost" | "released"> {
    this.recordOperation("checkout lease release");
    if (!this.record || this.record.ownerToken !== input.lease.ownerToken) {
      this.staleReleaseCount += 1;
      this.successorWasDeletedByStaleRelease = this.record === undefined;
      return Promise.resolve("lost");
    }
    if (input.disposition === "retire_attempt") {
      this.record = undefined;
    } else {
      this.record.expiresAt = input.releasedAt;
    }
    return Promise.resolve("released");
  }

  renew(
    input: CheckoutAttemptLeaseRenewInput
  ): Promise<
    { kind: "lost" } | { kind: "renewed"; lease: CheckoutAttemptLease }
  > {
    this.recordOperation("checkout lease renew");
    if (
      !this.record ||
      this.record.ownerToken !== input.lease.ownerToken ||
      this.record.expiresAt.getTime() <= input.now.getTime()
    ) {
      return Promise.resolve({ kind: "lost" });
    }
    this.record.expiresAt = input.leaseExpiresAt;
    return Promise.resolve({
      kind: "renewed",
      lease: checkoutAttemptLease(this.record),
    });
  }
}

function checkoutAttemptLease(record: {
  attemptId: string;
  expiresAt: Date;
  ownerId: string;
  ownerToken: string;
}): CheckoutAttemptLease {
  return { ...record };
}

function idempotencyScope(input: {
  keyHash: string;
  operation: string;
  ownerId: string;
}) {
  return `${input.ownerId}\0${input.operation}\0${input.keyHash}`;
}
