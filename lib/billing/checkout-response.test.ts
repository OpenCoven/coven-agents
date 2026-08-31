import assert from "node:assert/strict";
import test from "node:test";
import Stripe from "stripe";
import type {
  IdempotencyClaimHandle,
  IdempotencyClaimInput,
  IdempotencyClaimResult,
  IdempotencyCompleteInput,
  IdempotencyReleaseInput,
  IdempotencyStore,
  StoredIdempotencyResponse,
} from "@/lib/abuse/idempotency";
import { IDEMPOTENCY_CLAIM_TTL_MS } from "@/lib/abuse/idempotency";
import {
  type CheckoutSessionSnapshot,
  hasBlockingSubscription,
} from "@/lib/billing/checkout";
import type {
  CheckoutAttemptLease,
  CheckoutAttemptLeaseClaimInput,
  CheckoutAttemptLeaseClaimResult,
  CheckoutAttemptLeaseReleaseInput,
  CheckoutAttemptLeaseRenewInput,
  CheckoutAttemptLeaseStore,
} from "@/lib/billing/checkout-lease";
import { CHECKOUT_ATTEMPT_LEASE_TTL_MS } from "@/lib/billing/checkout-lease";
import {
  type CheckoutDependencies,
  type CheckoutProvider,
  CheckoutProviderRequestError,
  checkoutResponse,
} from "./checkout-response";
import { classifyStripeRequestOutcome } from "./stripe-error";

const USER_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const REQUEST_IDENTIFIER = "checkout-request-1234567890";
const ORIGIN = "https://app.opencoven.dev";

test("disabled checkout performs no abuse, database, or Stripe work", async () => {
  const calls: string[] = [];
  const dependencies = dependenciesFor({
    authenticate: () => {
      calls.push("authenticate");
      return Promise.resolve(userSession());
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
      return Promise.resolve(userSession());
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
    "checkout lease checkpoint",
    "attach customer",
    "create Checkout",
    "checkout lease renew",
    "checkout lease release",
    "idempotency renew",
    "idempotency release",
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

test("checkout renews both durable claims through long Stripe work and reconciles a later same-key retry", async () => {
  const clock = new ResponseManualClock();
  const checkoutTimers = new ResponseManualTimers();
  const responseTimers = new ResponseManualTimers();
  const providerKeys: string[] = [];
  let checkoutSession: ReturnType<typeof reconciledCheckoutSession> | null =
    null;
  let releaseProvider!: () => void;
  let signalProviderStarted!: () => void;
  const providerStarted = new Promise<void>((resolve) => {
    signalProviderStarted = resolve;
  });
  const providerGate = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  const provider = Object.assign(
    defaultProvider({
      async createCheckoutSession(input, options) {
        providerKeys.push(options.idempotencyKey);
        checkoutSession = reconciledCheckoutSession({
          customerId: "cus_existing",
          id: "cs_long_running",
          integrationIdentifier: input.integration_identifier ?? null,
          metadata: input.metadata ?? {},
          status: "open",
          url: "https://checkout.stripe.test/long-running",
        });
        signalProviderStarted();
        await providerGate;
        return checkoutSession;
      },
    }),
    reconciledProviderMethods({
      list(input) {
        const session = checkoutSession;
        if (!session || session.status !== input.status) {
          return [];
        }
        return [session];
      },
      retrieve() {
        assert.ok(checkoutSession);
        return checkoutSession;
      },
    })
  );
  const dependencies = dependenciesFor({
    checkoutLeaseTimers: checkoutTimers,
    createProvider: () => provider,
    idempotencyStore: new MemoryIdempotencyStore(),
    idempotencyTimers: responseTimers,
    now: clock.now,
  } as Partial<CheckoutDependencies> & {
    idempotencyTimers: ResponseManualTimers;
    now: () => Date;
  });

  const first = checkoutResponse(request(), dependencies, null);
  await providerStarted;

  clock.advance(
    Math.min(IDEMPOTENCY_CLAIM_TTL_MS, CHECKOUT_ATTEMPT_LEASE_TTL_MS) / 2
  );
  await responseTimers.runNext();
  await checkoutTimers.runNext();
  clock.advance(
    Math.max(IDEMPOTENCY_CLAIM_TTL_MS, CHECKOUT_ATTEMPT_LEASE_TTL_MS) / 2 + 1
  );

  const concurrent = await checkoutResponse(request(), dependencies, null);
  assert.equal(concurrent.status, 409);
  assert.deepEqual(await concurrent.json(), { error: "request_in_progress" });
  assert.equal(new Set(providerKeys).size, 1);

  releaseProvider();
  const completed = await first;
  assert.equal(completed.status, 200);
  assert.deepEqual(await completed.json(), {
    url: "https://checkout.stripe.test/long-running",
  });

  const reconciled = await checkoutResponse(request(), dependencies, null);
  assert.equal(reconciled.status, 200);
  assert.equal(reconciled.headers.get("idempotency-replayed"), null);
  assert.deepEqual(await reconciled.json(), {
    url: "https://checkout.stripe.test/long-running",
  });
  assert.equal(providerKeys.length, 1);
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

test("a takeover preserves the provider identity when Stripe returns an idempotency conflict", async () => {
  const leaseStore = new MemoryCheckoutAttemptLeaseStore();
  const sessions: ReturnType<typeof reconciledCheckoutSession>[] = [];
  const sessionKeys: string[] = [];
  let listCompletedSession = false;
  let releaseStaleCreate!: () => void;
  let signalStaleCreateStarted!: () => void;
  const staleCreateStarted = new Promise<void>((resolve) => {
    signalStaleCreateStarted = resolve;
  });
  const staleCreateGate = new Promise<void>((resolve) => {
    releaseStaleCreate = resolve;
  });
  const provider = Object.assign(
    defaultProvider({
      async createCheckoutSession(input, options) {
        sessionKeys.push(options.idempotencyKey);
        if (sessionKeys.length === 1) {
          signalStaleCreateStarted();
          await staleCreateGate;
          const session = reconciledCheckoutSession({
            customerId: "cus_existing",
            id: "cs_stale_create",
            integrationIdentifier: input.integration_identifier ?? null,
            metadata: input.metadata ?? {},
            status: "open",
            url: "https://checkout.stripe.test/stale-create",
          });
          sessions.push(session);
          return session;
        }
        if (sessionKeys[0] === options.idempotencyKey) {
          throw new CheckoutProviderRequestError(
            classifyStripeRequestOutcome(
              new Stripe.errors.StripeIdempotencyError({
                message:
                  "Another request with the same idempotency key is executing.",
                statusCode: 409,
                type: "idempotency_error",
              })
            )
          );
        }
        return reconciledCheckoutSession({
          customerId: "cus_existing",
          id: "cs_duplicate",
          integrationIdentifier: input.integration_identifier ?? null,
          metadata: input.metadata ?? {},
          status: "open",
          url: "https://checkout.stripe.test/duplicate",
        });
      },
    }),
    reconciledProviderMethods({
      list(input) {
        return listCompletedSession
          ? sessions.filter((session) => session.status === input.status)
          : [];
      },
      retrieve(sessionId) {
        const session = sessions.find(({ id }) => id === sessionId);
        assert.ok(session);
        return session;
      },
    })
  );
  const dependencies = dependenciesFor({
    checkoutLeaseStore: leaseStore,
    createProvider: () => provider,
  });

  const stale = checkoutResponse(
    request("checkout-request-stale-create"),
    dependencies,
    null
  );
  await staleCreateStarted;
  leaseStore.expireCheckoutLease();
  const conflicted = await checkoutResponse(
    request("checkout-request-conflicted-successor"),
    dependencies,
    null
  );

  assert.equal(conflicted.status, 502);
  releaseStaleCreate();
  const staleResponse = await stale;
  assert.equal(staleResponse.status, 409);

  const pending = await checkoutResponse(
    request("checkout-request-before-list-catches-up"),
    dependencies,
    null
  );
  assert.equal(pending.status, 409);
  assert.deepEqual(await pending.json(), { error: "request_in_progress" });
  assert.equal(new Set(sessionKeys).size, 1);

  listCompletedSession = true;
  const reconciled = await checkoutResponse(
    request("checkout-request-after-list-catches-up"),
    dependencies,
    null
  );
  assert.equal(reconciled.status, 200);
  assert.deepEqual(await reconciled.json(), {
    url: "https://checkout.stripe.test/stale-create",
  });
  assert.equal(sessionKeys.length, 2);
  assert.equal(new Set(sessionKeys).size, 1);
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
              checkoutAttemptId: "attempt-1",
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

test("a later request retrieves the durable Session when listing lags", async () => {
  const sessionByKey = new Map<
    string,
    ReturnType<typeof reconciledCheckoutSession>
  >();
  const sessionKeys: string[] = [];
  const dependencies = dependenciesFor({
    createProvider: () =>
      defaultProvider({
        createCheckoutSession(input, options) {
          sessionKeys.push(options.idempotencyKey);
          let checkoutSession = sessionByKey.get(options.idempotencyKey);
          if (!checkoutSession) {
            const sequence = sessionByKey.size + 1;
            checkoutSession = reconciledCheckoutSession({
              customerId: "cus_existing",
              id: `cs_${sequence}`,
              integrationIdentifier: input.integration_identifier ?? null,
              metadata: input.metadata ?? {},
              status: "open",
              url: `https://checkout.stripe.test/session-${sequence}`,
            });
            sessionByKey.set(options.idempotencyKey, checkoutSession);
          }
          return Promise.resolve(checkoutSession);
        },
        listCheckoutSessions: () =>
          Promise.resolve({ data: [], hasMore: false }),
        listOpenCheckoutSessions: () =>
          Promise.resolve({ data: [], hasMore: false }),
        retrieveCheckoutSession(sessionId) {
          const checkoutSession = [...sessionByKey.values()].find(
            ({ id }) => id === sessionId
          );
          assert.ok(checkoutSession);
          return Promise.resolve(checkoutSession);
        },
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
  assert.equal(sessionKeys.length, 1);
  assert.equal(sessionByKey.size, 1);
  assert.deepEqual(await later.json(), await first.json());
});

test("an expired current attempt is retired before one fresh Session is created", async () => {
  const sessionsByKey = new Map<
    string,
    ReturnType<typeof reconciledCheckoutSession>
  >();
  const sessionKeys: string[] = [];
  let firstSessionExpired = false;
  let createdMetadata: Stripe.MetadataParam | undefined;
  const provider = Object.assign(
    defaultProvider({
      createCheckoutSession(input, options) {
        sessionKeys.push(options.idempotencyKey);
        createdMetadata = input.metadata;
        let session = sessionsByKey.get(options.idempotencyKey);
        if (!session) {
          const sequence = sessionsByKey.size + 1;
          session = reconciledCheckoutSession({
            customerId: "cus_existing",
            id: `cs_${sequence}`,
            integrationIdentifier: input.integration_identifier ?? null,
            metadata: input.metadata ?? {},
            status: "open",
            url: `https://checkout.stripe.test/session-${sequence}`,
          });
          sessionsByKey.set(options.idempotencyKey, session);
        }
        return Promise.resolve({
          ...session,
          status:
            firstSessionExpired && session.id === "cs_1" ? "expired" : "open",
        });
      },
      listOpenCheckoutSessions: () =>
        Promise.resolve({
          data: [...sessionsByKey.values()]
            .map((session) => ({
              ...session,
              status:
                firstSessionExpired && session.id === "cs_1"
                  ? ("expired" as const)
                  : ("open" as const),
            }))
            .filter(({ status }) => status === "open"),
          hasMore: false,
        }),
    }),
    reconciledProviderMethods({
      list(input) {
        return [...sessionsByKey.values()]
          .map((session) => ({
            ...session,
            status:
              firstSessionExpired && session.id === "cs_1"
                ? ("expired" as const)
                : ("open" as const),
          }))
          .filter((session) => session.status === input.status);
      },
      retrieve(sessionId) {
        const session = [...sessionsByKey.values()].find(
          ({ id }) => id === sessionId
        );
        assert.ok(session);
        return {
          ...session,
          status:
            firstSessionExpired && session.id === "cs_1" ? "expired" : "open",
        };
      },
    })
  );
  const dependencies = dependenciesFor({ createProvider: () => provider });

  const first = await checkoutResponse(request(), dependencies, null);
  firstSessionExpired = true;
  const retirement = await checkoutResponse(request(), dependencies, null);
  const replacement = await checkoutResponse(request(), dependencies, null);

  assert.equal(first.status, 200);
  assert.equal(retirement.status, 409);
  assert.deepEqual(await retirement.json(), { error: "request_in_progress" });
  assert.equal(replacement.status, 200);
  assert.deepEqual(await replacement.json(), {
    url: "https://checkout.stripe.test/session-2",
  });
  assert.equal(sessionKeys.length, 2);
  assert.notEqual(sessionKeys[0], sessionKeys[1]);
  assert.equal(typeof createdMetadata?.checkoutAttemptId, "string");
  assert.notEqual(createdMetadata?.checkoutAttemptId, "");
});

test("a completed Session with a blocking subscription preserves the attempt until cancel-then-resubscribe", async () => {
  let currentStatus: Stripe.Checkout.Session.Status = "open";
  let subscriptionStatus: Stripe.Subscription.Status = "active";
  const sessions: ReturnType<typeof reconciledCheckoutSession>[] = [];
  const sessionKeys: string[] = [];
  const retrievedSubscriptions: string[] = [];
  const provider = Object.assign(
    defaultProvider({
      createCheckoutSession(input, options) {
        sessionKeys.push(options.idempotencyKey);
        const sequence = sessionKeys.length;
        const session = reconciledCheckoutSession({
          customerId: "cus_existing",
          id: `cs_completed_${sequence}`,
          integrationIdentifier: input.integration_identifier ?? null,
          metadata: input.metadata ?? {},
          status: "open",
          subscriptionId: null,
          url: `https://checkout.stripe.test/completed-${sequence}`,
        });
        sessions.push(session);
        currentStatus = "open";
        return Promise.resolve(session);
      },
      hasBlockingSubscription: () =>
        Promise.resolve(
          currentStatus === "complete" &&
            [
              "active",
              "incomplete",
              "past_due",
              "paused",
              "trialing",
              "unpaid",
            ].includes(subscriptionStatus)
        ),
    }),
    reconciledProviderMethods({
      list(input) {
        return sessions
          .map((session, index) =>
            index === 0
              ? {
                  ...session,
                  status: currentStatus,
                  subscriptionId:
                    currentStatus === "complete" ? "sub_completed" : null,
                }
              : session
          )
          .filter((session) => session.status === input.status);
      },
      retrieve(sessionId) {
        const session = sessions.find(({ id }) => id === sessionId);
        assert.ok(session);
        return session.id === "cs_completed_1"
          ? {
              ...session,
              status: currentStatus,
              subscriptionId:
                currentStatus === "complete" ? "sub_completed" : null,
            }
          : session;
      },
    }),
    {
      retrieveSubscription(subscriptionId: string) {
        retrievedSubscriptions.push(subscriptionId);
        return Promise.resolve({
          id: subscriptionId,
          status: subscriptionStatus,
        });
      },
    }
  );
  const dependencies = dependenciesFor({ createProvider: () => provider });

  const first = await checkoutResponse(request(), dependencies, null);
  currentStatus = "complete";
  const blocked = await checkoutResponse(request(), dependencies, null);
  subscriptionStatus = "canceled";
  const retirement = await checkoutResponse(request(), dependencies, null);
  const replacement = await checkoutResponse(request(), dependencies, null);

  assert.equal(first.status, 200);
  assert.equal(blocked.status, 409);
  assert.deepEqual(await blocked.json(), { error: "already_subscribed" });
  assert.equal(retirement.status, 409);
  assert.deepEqual(await retirement.json(), { error: "request_in_progress" });
  assert.equal(replacement.status, 200);
  assert.deepEqual(await replacement.json(), {
    url: "https://checkout.stripe.test/completed-2",
  });
  assert.deepEqual(retrievedSubscriptions, ["sub_completed", "sub_completed"]);
  assert.equal(sessionKeys.length, 2);
  assert.notEqual(sessionKeys[0], sessionKeys[1]);
});

test("a completed Session with an incomplete-expired subscription permits exactly one fresh retry", async () => {
  let status: Stripe.Checkout.Session.Status = "open";
  const sessions: ReturnType<typeof reconciledCheckoutSession>[] = [];
  const sessionKeys: string[] = [];
  const provider = Object.assign(
    defaultProvider({
      createCheckoutSession(input, options) {
        sessionKeys.push(options.idempotencyKey);
        const session = reconciledCheckoutSession({
          customerId: "cus_existing",
          id: `cs_failed_payment_${sessionKeys.length}`,
          integrationIdentifier: input.integration_identifier ?? null,
          metadata: input.metadata ?? {},
          status: "open",
          subscriptionId: null,
        });
        sessions.push(session);
        status = "open";
        return Promise.resolve(session);
      },
    }),
    reconciledProviderMethods({
      list(input) {
        return sessions
          .map((session, index) =>
            index === 0
              ? {
                  ...session,
                  status,
                  subscriptionId:
                    status === "complete" ? "sub_failed_payment" : null,
                }
              : session
          )
          .filter((session) => session.status === input.status);
      },
      retrieve(sessionId) {
        const session = sessions.find(({ id }) => id === sessionId);
        assert.ok(session);
        return session.id === "cs_failed_payment_1"
          ? {
              ...session,
              status,
              subscriptionId:
                status === "complete" ? "sub_failed_payment" : null,
            }
          : session;
      },
    }),
    {
      retrieveSubscription(subscriptionId: string) {
        return Promise.resolve({
          id: subscriptionId,
          status: "incomplete_expired" as const,
        });
      },
    }
  );
  const dependencies = dependenciesFor({ createProvider: () => provider });

  const first = await checkoutResponse(request(), dependencies, null);
  status = "complete";
  const retirement = await checkoutResponse(request(), dependencies, null);
  const replacement = await checkoutResponse(request(), dependencies, null);

  assert.equal(first.status, 200);
  assert.equal(retirement.status, 409);
  assert.deepEqual(await retirement.json(), { error: "request_in_progress" });
  assert.equal(replacement.status, 200);
  assert.equal(sessionKeys.length, 2);
  assert.notEqual(sessionKeys[0], sessionKeys[1]);
});

test("a completed Session without a resolvable subscription fails retryably without replacement", async () => {
  let status: Stripe.Checkout.Session.Status = "open";
  let session: ReturnType<typeof reconciledCheckoutSession> | null = null;
  let sessionCalls = 0;
  const provider = Object.assign(
    defaultProvider({
      createCheckoutSession(input) {
        sessionCalls += 1;
        session = reconciledCheckoutSession({
          customerId: "cus_existing",
          id: "cs_missing_subscription",
          integrationIdentifier: input.integration_identifier ?? null,
          metadata: input.metadata ?? {},
          status: "open",
          subscriptionId: null,
        });
        return Promise.resolve(session);
      },
    }),
    reconciledProviderMethods({
      list(input) {
        return session && status === input.status
          ? [{ ...session, status, subscriptionId: null }]
          : [];
      },
      retrieve() {
        assert.ok(session);
        return { ...session, status, subscriptionId: null };
      },
    }),
    {
      retrieveSubscription() {
        throw new Error("A missing subscription must not be retrieved.");
      },
    }
  );
  const dependencies = dependenciesFor({ createProvider: () => provider });

  const first = await checkoutResponse(request(), dependencies, null);
  status = "complete";
  const failed = await checkoutResponse(request(), dependencies, null);
  const retry = await checkoutResponse(request(), dependencies, null);

  assert.equal(first.status, 200);
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { error: "checkout_failed" });
  assert.equal(retry.status, 502);
  assert.equal(sessionCalls, 1);
});

test("a completed Session subscription retrieval failure preserves the attempt without replacement", async () => {
  let status: Stripe.Checkout.Session.Status = "open";
  let session: ReturnType<typeof reconciledCheckoutSession> | null = null;
  let sessionCalls = 0;
  let retrievalCalls = 0;
  const provider = Object.assign(
    defaultProvider({
      createCheckoutSession(input) {
        sessionCalls += 1;
        session = reconciledCheckoutSession({
          customerId: "cus_existing",
          id: "cs_subscription_failure",
          integrationIdentifier: input.integration_identifier ?? null,
          metadata: input.metadata ?? {},
          status: "open",
          subscriptionId: null,
        });
        return Promise.resolve(session);
      },
    }),
    reconciledProviderMethods({
      list(input) {
        return session && status === input.status
          ? [{ ...session, status, subscriptionId: "sub_uncertain" }]
          : [];
      },
      retrieve() {
        assert.ok(session);
        return { ...session, status, subscriptionId: "sub_uncertain" };
      },
    }),
    {
      retrieveSubscription() {
        retrievalCalls += 1;
        return Promise.reject(new Error("Stripe retrieval failed."));
      },
    }
  );
  const dependencies = dependenciesFor({ createProvider: () => provider });

  const first = await checkoutResponse(request(), dependencies, null);
  status = "complete";
  const failed = await checkoutResponse(request(), dependencies, null);
  const retry = await checkoutResponse(request(), dependencies, null);

  assert.equal(first.status, 200);
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { error: "checkout_failed" });
  assert.equal(retry.status, 502);
  assert.equal(retrievalCalls, 2);
  assert.equal(sessionCalls, 1);
});

test("an uncertain create failure recovers a discoverable Session without another create", async () => {
  let session: ReturnType<typeof reconciledCheckoutSession> | null = null;
  let stampedAttemptId: string | undefined;
  let sessionCalls = 0;
  const provider = Object.assign(
    defaultProvider({
      createCheckoutSession(input) {
        sessionCalls += 1;
        session = reconciledCheckoutSession({
          customerId: "cus_existing",
          id: "cs_uncertain_created",
          integrationIdentifier: input.integration_identifier ?? null,
          metadata: input.metadata ?? {},
          status: "open",
          url: "https://checkout.stripe.test/uncertain-created",
        });
        stampedAttemptId = session.metadata.checkoutAttemptId;
        return Promise.reject(providerFailure("uncertain"));
      },
      listOpenCheckoutSessions: () =>
        Promise.resolve({ data: [], hasMore: false }),
    }),
    reconciledProviderMethods({
      list(input) {
        if (!session || session.status !== input.status) {
          return [];
        }
        return [session];
      },
      retrieve() {
        assert.ok(session);
        return session;
      },
    })
  );
  const dependencies = dependenciesFor({ createProvider: () => provider });

  const uncertain = await checkoutResponse(request(), dependencies, null);
  const recovered = await checkoutResponse(request(), dependencies, null);

  assert.equal(uncertain.status, 502);
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), {
    url: "https://checkout.stripe.test/uncertain-created",
  });
  assert.equal(sessionCalls, 1);
  assert.equal(typeof stampedAttemptId, "string");
});

test("an uncertain create failure without a provably terminal attempt does not loop the provider key", async () => {
  const sessionKeys: string[] = [];
  const provider = Object.assign(
    defaultProvider({
      createCheckoutSession(_input, options) {
        sessionKeys.push(options.idempotencyKey);
        return Promise.reject(providerFailure("uncertain"));
      },
      listOpenCheckoutSessions: () =>
        Promise.resolve({ data: [], hasMore: false }),
    }),
    reconciledProviderMethods({
      list: () => [],
      retrieve() {
        throw new Error("No Session exists.");
      },
    })
  );
  const dependencies = dependenciesFor({ createProvider: () => provider });

  const uncertain = await checkoutResponse(request(), dependencies, null);
  const pending = await checkoutResponse(request(), dependencies, null);

  assert.equal(uncertain.status, 502);
  assert.equal(pending.status, 409);
  assert.deepEqual(await pending.json(), { error: "request_in_progress" });
  assert.equal(sessionKeys.length, 1);
});

test("a definite pre-request create failure retires the attempt for a fresh provider key", async () => {
  const sessionKeys: string[] = [];
  const provider = Object.assign(
    defaultProvider({
      createCheckoutSession(_input, options) {
        sessionKeys.push(options.idempotencyKey);
        if (sessionKeys.length === 1) {
          return Promise.reject(providerFailure("pre_request"));
        }
        return Promise.resolve({
          url: "https://checkout.stripe.test/after-local-failure",
        });
      },
      listOpenCheckoutSessions: () =>
        Promise.resolve({ data: [], hasMore: false }),
    }),
    reconciledProviderMethods({
      list: () => [],
      retrieve() {
        throw new Error("No Session exists.");
      },
    })
  );
  const dependencies = dependenciesFor({ createProvider: () => provider });

  const failed = await checkoutResponse(request(), dependencies, null);
  const retry = await checkoutResponse(request(), dependencies, null);

  assert.equal(failed.status, 502);
  assert.equal(retry.status, 200);
  assert.equal(sessionKeys.length, 2);
  assert.notEqual(sessionKeys[0], sessionKeys[1]);
});

test("expiration retries rotate their identity only after reconciling the Session as still open", async () => {
  let obsoleteStatus: "expired" | "open" = "open";
  const expirationKeys: string[] = [];
  let sessionCalls = 0;
  const obsolete = reconciledCheckoutSession({
    customerId: "cus_existing",
    id: "cs_obsolete_retry",
    integrationIdentifier: "older-attempt",
    metadata: {
      checkoutAttemptId: "older-attempt",
      checkoutFlowVersion: "0",
      priceId: "price_retired",
      userId: USER_ID,
    },
    status: "open",
  });
  const provider = Object.assign(
    defaultProvider({
      createCheckoutSession() {
        sessionCalls += 1;
        return Promise.resolve({
          url: "https://checkout.stripe.test/after-cleanup",
        });
      },
      expireCheckoutSession(_sessionId, options) {
        expirationKeys.push(options.idempotencyKey);
        if (new Set(expirationKeys).size === 1) {
          return Promise.reject(providerFailure("uncertain"));
        }
        obsoleteStatus = "expired";
        return Promise.resolve();
      },
      listOpenCheckoutSessions: () =>
        Promise.resolve({
          data:
            obsoleteStatus === "open"
              ? [{ ...obsolete, status: obsoleteStatus }]
              : [],
          hasMore: false,
        }),
    }),
    reconciledProviderMethods({
      list(input) {
        return obsoleteStatus === input.status
          ? [{ ...obsolete, status: obsoleteStatus }]
          : [];
      },
      retrieve() {
        return { ...obsolete, status: obsoleteStatus };
      },
    })
  );
  const dependencies = dependenciesFor({ createProvider: () => provider });

  const uncertainCleanup = await checkoutResponse(
    request("checkout-request-cleanup-one"),
    dependencies,
    null
  );
  const recovered = await checkoutResponse(
    request("checkout-request-cleanup-two"),
    dependencies,
    null
  );

  assert.equal(uncertainCleanup.status, 409);
  assert.equal(recovered.status, 200);
  assert.equal(expirationKeys.length, 2);
  assert.notEqual(expirationKeys[0], expirationKeys[1]);
  assert.equal(obsoleteStatus, "expired");
  assert.equal(sessionCalls, 1);
});

test("a matching open Session with a non-HTTPS URL is never returned or replaced", async () => {
  let sessionCalls = 0;
  const invalid = reconciledCheckoutSession({
    customerId: "cus_existing",
    id: "cs_invalid_url",
    integrationIdentifier: "current-attempt",
    metadata: {
      checkoutAttemptId: "attempt-1",
      checkoutFlowVersion: "1",
      priceId: "price_configured",
      userId: USER_ID,
    },
    status: "open",
    url: "http://checkout.stripe.test/not-safe",
  });
  const provider = Object.assign(
    defaultProvider({
      createCheckoutSession() {
        sessionCalls += 1;
        return Promise.resolve({ url: "impossible" });
      },
      listOpenCheckoutSessions: () =>
        Promise.resolve({ data: [invalid], hasMore: false }),
    }),
    reconciledProviderMethods({
      list(input) {
        return input.status === "open" ? [invalid] : [];
      },
      retrieve: () => invalid,
    })
  );
  const dependencies = dependenciesFor({ createProvider: () => provider });

  const response = await checkoutResponse(request(), dependencies, null);

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "checkout_failed" });
  assert.equal(sessionCalls, 0);
});

test("a matching current-price Checkout Session is reused across pages", async () => {
  const listCursors: Array<string | undefined> = [];
  let checkoutCalls = 0;
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    openCheckoutSession({
      id: `cs_unowned_${index}`,
      metadata: {},
      mode: "payment",
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
                  checkoutAttemptId: "attempt-1",
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

test("an unmarked legacy subscription Session fails closed without create or expiration", async () => {
  let checkoutCalls = 0;
  const expired: string[] = [];
  const provider = defaultProvider({
    createCheckoutSession() {
      checkoutCalls += 1;
      return Promise.resolve({ url: "impossible" });
    },
    expireCheckoutSession(sessionId) {
      expired.push(sessionId);
      return Promise.resolve();
    },
    listOpenCheckoutSessions: () =>
      Promise.resolve({
        data: [
          openCheckoutSession({
            id: "cs_unmarked_legacy",
            metadata: {},
          }),
        ],
        hasMore: false,
      }),
  });
  const dependencies = dependenciesFor({ createProvider: () => provider });

  const response = await checkoutResponse(request(), dependencies, null);

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "checkout_session_conflict",
  });
  assert.equal(checkoutCalls, 0);
  assert.deepEqual(expired, []);
});

test("foreign or mismatched subscription Session ownership fails closed", async (t) => {
  const cases = [
    openCheckoutSession({
      id: "cs_foreign_reference",
      metadata: {
        checkoutFlowVersion: "1",
        priceId: "price_configured",
        userId: USER_ID,
      },
      userId: "another-user",
    }),
    openCheckoutSession({
      id: "cs_foreign_metadata",
      metadata: {
        checkoutFlowVersion: "1",
        priceId: "price_configured",
        userId: "another-user",
      },
    }),
  ];

  await Promise.all(
    cases.map((session) =>
      t.test(session.id, async () => {
        let checkoutCalls = 0;
        const expired: string[] = [];
        const provider = defaultProvider({
          createCheckoutSession() {
            checkoutCalls += 1;
            return Promise.resolve({ url: "impossible" });
          },
          expireCheckoutSession(sessionId) {
            expired.push(sessionId);
            return Promise.resolve();
          },
          listOpenCheckoutSessions: () =>
            Promise.resolve({ data: [session], hasMore: false }),
        });
        const dependencies = dependenciesFor({
          createProvider: () => provider,
        });

        const response = await checkoutResponse(request(), dependencies, null);

        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), {
          error: "checkout_session_conflict",
        });
        assert.equal(checkoutCalls, 0);
        assert.deepEqual(expired, []);
      })
    )
  );
});

test("obsolete app-owned Checkout Sessions expire before a replacement is created", async () => {
  const calls: string[] = [];
  const expired = new Set<string>();
  const obsolete = [
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
  ];
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
        expired.add(sessionId);
        return Promise.resolve();
      },
      listOpenCheckoutSessions() {
        return Promise.resolve({
          data: obsolete.filter(({ id }) => !expired.has(id)),
          hasMore: false,
        });
      },
      retrieveCheckoutSession(sessionId: string) {
        const session = obsolete.find(({ id }) => id === sessionId);
        assert.ok(session);
        return Promise.resolve({
          ...session,
          customerId: "cus_existing",
          status: expired.has(sessionId) ? "expired" : "open",
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

test("a same-key retry does not replay a successful URL after the configured Price changes", async () => {
  const calls: string[] = [];
  const sessions: ReturnType<typeof reconciledCheckoutSession>[] = [];
  let configuredPrice = "price_retired";
  const provider = Object.assign(
    defaultProvider({
      createCheckoutSession(input) {
        const session = reconciledCheckoutSession({
          customerId: "cus_existing",
          id: `cs_price_${sessions.length + 1}`,
          integrationIdentifier: input.integration_identifier ?? null,
          metadata: input.metadata ?? {},
          status: "open",
          subscriptionId: null,
          url: `https://checkout.stripe.test/${String(
            input.line_items?.[0]?.price
          )}`,
        });
        sessions.push(session);
        calls.push(`create ${String(input.line_items?.[0]?.price)}`);
        return Promise.resolve(session);
      },
      expireCheckoutSession(sessionId) {
        const session = sessions.find(({ id }) => id === sessionId);
        assert.ok(session);
        session.status = "expired";
        calls.push(`expire ${sessionId}`);
        return Promise.resolve();
      },
    }),
    reconciledProviderMethods({
      list(input) {
        return sessions.filter((session) => session.status === input.status);
      },
      retrieve(sessionId) {
        const session = sessions.find(({ id }) => id === sessionId);
        assert.ok(session);
        return session;
      },
    })
  );
  const dependencies = dependenciesFor({
    createProvider: () => provider,
    getCheckoutConfig: () => ({
      apiKey: "sk_test_checkout",
      enabled: true,
      priceId: configuredPrice,
      webhookSecret: "whsec_configured",
    }),
  });

  const first = await checkoutResponse(request(), dependencies, null);
  configuredPrice = "price_configured";
  const cleanup = await checkoutResponse(request(), dependencies, null);
  const replacement = await checkoutResponse(request(), dependencies, null);

  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), {
    url: "https://checkout.stripe.test/price_retired",
  });
  assert.equal(cleanup.status, 409);
  assert.deepEqual(await cleanup.json(), { error: "request_in_progress" });
  assert.equal(replacement.status, 200);
  assert.deepEqual(await replacement.json(), {
    url: "https://checkout.stripe.test/price_configured",
  });
  assert.deepEqual(calls, [
    "create price_retired",
    "expire cs_price_1",
    "create price_configured",
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

test("a created Customer is recovered when database attachment initially fails", async () => {
  let attachCalls = 0;
  let customerCalls = 0;
  let sessionCalls = 0;
  const dependencies = dependenciesFor({
    attachCustomer: (_userId, customerId) => {
      attachCalls += 1;
      return attachCalls === 1
        ? Promise.reject(new Error("database unavailable"))
        : Promise.resolve(customerId);
    },
    createProvider: () =>
      defaultProvider({
        createCheckoutSession: () => {
          sessionCalls += 1;
          return Promise.resolve({
            url: "https://checkout.stripe.test/recovered-customer",
          });
        },
        createCustomer: () => {
          customerCalls += 1;
          return Promise.resolve({ id: "cus_recoverable" });
        },
      }),
    findUser: () => Promise.resolve({ stripeCustomerId: null }),
  });

  const failed = await checkoutResponse(request(), dependencies, null);
  const recovered = await checkoutResponse(request(), dependencies, null);

  assert.equal(failed.status, 502);
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), {
    url: "https://checkout.stripe.test/recovered-customer",
  });
  assert.equal(customerCalls, 1);
  assert.equal(attachCalls, 2);
  assert.equal(sessionCalls, 1);
});

test("a definite Customer rejection rotates the provider identity", async () => {
  const customerKeys: string[] = [];
  let sessionCalls = 0;
  const dependencies = dependenciesFor({
    createProvider: () =>
      defaultProvider({
        createCheckoutSession: () => {
          sessionCalls += 1;
          return Promise.resolve({
            url: "https://checkout.stripe.test/customer-retry",
          });
        },
        createCustomer: (_input, options) => {
          customerKeys.push(options.idempotencyKey);
          return customerKeys.length === 1
            ? Promise.reject(providerFailure("pre_request"))
            : Promise.resolve({ id: "cus_after_rejection" });
        },
      }),
    findUser: () => Promise.resolve({ stripeCustomerId: null }),
  });

  const rejected = await checkoutResponse(request(), dependencies, null);
  const retried = await checkoutResponse(request(), dependencies, null);

  assert.equal(rejected.status, 502);
  assert.equal(retried.status, 200);
  assert.equal(customerKeys.length, 2);
  assert.notEqual(customerKeys[0], customerKeys[1]);
  assert.equal(sessionCalls, 1);
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

test("a racing Customer winner is rechecked for blocking subscriptions", async () => {
  const inspectedCustomers: string[] = [];
  let checkoutCalls = 0;
  const dependencies = dependenciesFor({
    attachCustomer: () => Promise.resolve("cus_owned"),
    createProvider: () =>
      defaultProvider({
        createCheckoutSession() {
          checkoutCalls += 1;
          return Promise.resolve({ url: "impossible" });
        },
        createCustomer: () => Promise.resolve({ id: "cus_racing" }),
        hasBlockingSubscription(customerId) {
          inspectedCustomers.push(customerId);
          return Promise.resolve(customerId === "cus_owned");
        },
      }),
    findUser: () => Promise.resolve({ stripeCustomerId: null }),
  });

  const response = await checkoutResponse(request(), dependencies, null);

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "already_subscribed" });
  assert.deepEqual(inspectedCustomers, ["cus_owned"]);
  assert.equal(checkoutCalls, 0);
});

test("a racing Customer winner reuses its matching open Checkout Session", async () => {
  const listedCustomers: string[] = [];
  let checkoutCalls = 0;
  const dependencies = dependenciesFor({
    attachCustomer: () => Promise.resolve("cus_owned"),
    createProvider: () =>
      defaultProvider({
        createCheckoutSession() {
          checkoutCalls += 1;
          return Promise.resolve({ url: "impossible" });
        },
        createCustomer: () => Promise.resolve({ id: "cus_racing" }),
        listOpenCheckoutSessions(input) {
          listedCustomers.push(input.customer ?? "");
          return Promise.resolve({
            data: [
              openCheckoutSession({
                id: "cs_owned",
                metadata: {
                  checkoutAttemptId: "attempt-1",
                  checkoutFlowVersion: "1",
                  priceId: "price_configured",
                  userId: USER_ID,
                },
                url: "https://checkout.stripe.test/owned",
              }),
            ],
            hasMore: false,
          });
        },
      }),
    findUser: () => Promise.resolve({ stripeCustomerId: null }),
  });

  const response = await checkoutResponse(request(), dependencies, null);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    url: "https://checkout.stripe.test/owned",
  });
  assert.deepEqual(listedCustomers, ["cus_owned"]);
  assert.equal(checkoutCalls, 0);
});

test("a blocking subscription expires a prior payable Session and retires the attempt", async () => {
  let blocking = true;
  let status: Stripe.Checkout.Session.Status = "open";
  let sessionCalls = 0;
  const createdAttemptIds: string[] = [];
  const prior = reconciledCheckoutSession({
    customerId: "cus_existing",
    id: "cs_prior_payable",
    metadata: {
      checkoutAttemptId: "attempt-1",
      checkoutFlowVersion: "1",
      priceId: "price_configured",
      userId: USER_ID,
    },
    status: "open",
  });
  const provider = Object.assign(
    defaultProvider({
      createCheckoutSession(input) {
        sessionCalls += 1;
        createdAttemptIds.push(String(input.metadata?.checkoutAttemptId));
        return Promise.resolve({
          url: "https://checkout.stripe.test/replacement",
        });
      },
      expireCheckoutSession() {
        status = "expired";
        return Promise.resolve();
      },
      hasBlockingSubscription: () => Promise.resolve(blocking),
    }),
    reconciledProviderMethods({
      list(input) {
        return status === input.status ? [{ ...prior, status }] : [];
      },
      retrieve() {
        return { ...prior, status };
      },
    })
  );
  const dependencies = dependenciesFor({ createProvider: () => provider });

  const blocked = await checkoutResponse(request(), dependencies, null);

  assert.equal(blocked.status, 409);
  assert.deepEqual(await blocked.json(), { error: "already_subscribed" });
  assert.equal(status, "expired");
  assert.equal(sessionCalls, 0);

  blocking = false;
  const replacement = await checkoutResponse(request(), dependencies, null);
  assert.equal(replacement.status, 200);
  assert.equal(sessionCalls, 1);
  assert.deepEqual(createdAttemptIds, ["attempt-2"]);
});

test("blocking cleanup retrieves the durable Session when open listing lags", async () => {
  let blocking = false;
  let status: Stripe.Checkout.Session.Status = "open";
  let session: ReturnType<typeof reconciledCheckoutSession> | null = null;
  let sessionCalls = 0;
  const provider = Object.assign(
    defaultProvider({
      createCheckoutSession(input) {
        sessionCalls += 1;
        session = reconciledCheckoutSession({
          customerId: "cus_existing",
          id: "cs_blocking_list_lag",
          integrationIdentifier: input.integration_identifier ?? null,
          metadata: input.metadata ?? {},
          status: "open",
        });
        return Promise.resolve(session);
      },
      expireCheckoutSession() {
        status = "expired";
        return Promise.resolve();
      },
      hasBlockingSubscription: () => Promise.resolve(blocking),
    }),
    reconciledProviderMethods({
      list: () => [],
      retrieve() {
        assert.ok(session);
        return { ...session, status };
      },
    })
  );
  const dependencies = dependenciesFor({ createProvider: () => provider });

  const first = await checkoutResponse(request(), dependencies, null);
  blocking = true;
  const blocked = await checkoutResponse(request(), dependencies, null);

  assert.equal(first.status, 200);
  assert.equal(blocked.status, 409);
  assert.deepEqual(await blocked.json(), { error: "already_subscribed" });
  assert.equal(status, "expired");
  assert.equal(sessionCalls, 1);
});

test("a Session that completes during blocking cleanup reconciles its subscription", async () => {
  let retrieveCalls = 0;
  let expirationCalls = 0;
  let subscriptionCalls = 0;
  const prior = reconciledCheckoutSession({
    customerId: "cus_existing",
    id: "cs_completed_during_cleanup",
    metadata: {
      checkoutAttemptId: "attempt-1",
      checkoutFlowVersion: "1",
      priceId: "price_configured",
      userId: USER_ID,
    },
    status: "open",
  });
  const provider = Object.assign(
    defaultProvider({
      createCheckoutSession() {
        throw new Error("A replacement must not be created.");
      },
      expireCheckoutSession() {
        expirationCalls += 1;
        return Promise.resolve();
      },
      hasBlockingSubscription: () => Promise.resolve(true),
      retrieveSubscription(subscriptionId) {
        subscriptionCalls += 1;
        return Promise.resolve({ id: subscriptionId, status: "active" });
      },
    }),
    reconciledProviderMethods({
      list(input) {
        return input.status === "open" ? [prior] : [];
      },
      retrieve() {
        retrieveCalls += 1;
        return retrieveCalls === 1
          ? prior
          : {
              ...prior,
              status: "complete",
              subscriptionId: "sub_completed_during_cleanup",
            };
      },
    })
  );
  const dependencies = dependenciesFor({ createProvider: () => provider });

  const response = await checkoutResponse(request(), dependencies, null);

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "already_subscribed" });
  assert.equal(expirationCalls, 0);
  assert.equal(subscriptionCalls, 1);
});

test("blocking cleanup expiration failure returns a conflict without replacement", async () => {
  let sessionCalls = 0;
  let expirationCalls = 0;
  const prior = reconciledCheckoutSession({
    customerId: "cus_existing",
    id: "cs_blocking_cleanup_failure",
    metadata: {
      checkoutAttemptId: "attempt-1",
      checkoutFlowVersion: "1",
      priceId: "price_configured",
      userId: USER_ID,
    },
    status: "open",
  });
  const provider = Object.assign(
    defaultProvider({
      createCheckoutSession() {
        sessionCalls += 1;
        return Promise.resolve({ url: "impossible" });
      },
      expireCheckoutSession() {
        expirationCalls += 1;
        return Promise.reject(new Error("Stripe expiration failed."));
      },
      hasBlockingSubscription: () => Promise.resolve(true),
    }),
    reconciledProviderMethods({
      list(input) {
        return input.status === "open" ? [prior] : [];
      },
      retrieve() {
        return prior;
      },
    })
  );
  const dependencies = dependenciesFor({ createProvider: () => provider });

  const response = await checkoutResponse(request(), dependencies, null);

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "checkout_session_conflict",
  });
  assert.equal(expirationCalls, 1);
  assert.equal(sessionCalls, 0);
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
      checkoutAttemptId: "attempt-1",
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
    authenticate: () => Promise.resolve(userSession()),
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
  overrides: Partial<CheckoutProvider> & {
    listOpenCheckoutSessions?: (
      input: Stripe.Checkout.SessionListParams
    ) => Promise<{
      data: ReturnType<typeof openCheckoutSession>[];
      hasMore: boolean;
    }>;
  } = {}
): CheckoutProvider {
  const listedSessions = new Map<string, CheckoutSessionSnapshot>();
  const provider: CheckoutProvider = {
    createCheckoutSession: () =>
      Promise.resolve({ url: "https://checkout.stripe.test/session" }),
    createCustomer: () => Promise.resolve({ id: "cus_new" }),
    hasBlockingSubscription: () => Promise.resolve(false),
    retrieveSubscription: () =>
      Promise.reject(new Error("No Subscription was configured.")),
    ...overrides,
    async expireCheckoutSession(sessionId, options) {
      if (overrides.expireCheckoutSession) {
        await overrides.expireCheckoutSession(sessionId, options);
      }
      const session = listedSessions.get(sessionId);
      if (session) {
        listedSessions.set(sessionId, { ...session, status: "expired" });
      }
    },
    async listCheckoutSessions(input) {
      if (overrides.listCheckoutSessions) {
        return overrides.listCheckoutSessions(input);
      }
      const legacyList = (
        provider as CheckoutProvider & {
          listOpenCheckoutSessions?: NonNullable<
            typeof overrides.listOpenCheckoutSessions
          >;
        }
      ).listOpenCheckoutSessions;
      if (input.status !== "open" || !legacyList) {
        return { data: [], hasMore: false };
      }
      const page = await legacyList(input);
      const data = page.data.map((session) => {
        const reconciled = {
          ...session,
          customerId:
            typeof input.customer === "string" ? input.customer : null,
          status: "open" as const,
          subscriptionId: null,
        };
        listedSessions.set(reconciled.id, reconciled);
        return reconciled;
      });
      return { data, hasMore: page.hasMore };
    },
    retrieveCheckoutSession(sessionId) {
      if (overrides.retrieveCheckoutSession) {
        return overrides.retrieveCheckoutSession(sessionId);
      }
      const session = listedSessions.get(sessionId);
      if (!session) {
        return Promise.reject(new Error("Checkout Session was not listed."));
      }
      return Promise.resolve(session);
    },
  };
  return provider;
}

function request(idempotencyKey = REQUEST_IDENTIFIER) {
  return new Request(`${ORIGIN}/api/checkout`, {
    headers: { "idempotency-key": idempotencyKey },
    method: "POST",
  });
}

function userSession() {
  return { user: { id: USER_ID } };
}

function openCheckoutSession(input: {
  id: string;
  integrationIdentifier?: string | null;
  metadata: Record<string, string>;
  mode?: Stripe.Checkout.Session.Mode;
  url?: string;
  userId?: string;
}) {
  return {
    clientReferenceId: input.userId ?? USER_ID,
    id: input.id,
    integrationIdentifier: input.integrationIdentifier ?? null,
    metadata: input.metadata,
    mode: input.mode ?? ("subscription" as const),
    url: input.url ?? `https://checkout.stripe.test/${input.id}`,
  };
}

function reconciledCheckoutSession(input: {
  customerId: string;
  id: string;
  integrationIdentifier?: string | null;
  metadata: Stripe.MetadataParam;
  status: "complete" | "expired" | "open";
  subscriptionId?: string | null;
  url?: string;
}) {
  return {
    clientReferenceId: USER_ID,
    customerId: input.customerId,
    id: input.id,
    integrationIdentifier: input.integrationIdentifier ?? null,
    metadata: input.metadata as Record<string, string>,
    mode: "subscription" as const,
    status: input.status,
    subscriptionId: input.subscriptionId ?? null,
    url: input.url ?? `https://checkout.stripe.test/${input.id}`,
  };
}

function reconciledProviderMethods(input: {
  list: (
    params: Stripe.Checkout.SessionListParams
  ) => ReturnType<typeof reconciledCheckoutSession>[];
  retrieve: (sessionId: string) => ReturnType<typeof reconciledCheckoutSession>;
}) {
  return {
    listCheckoutSessions(params: Stripe.Checkout.SessionListParams) {
      return Promise.resolve({
        data: input.list(params),
        hasMore: false,
      });
    },
    retrieveCheckoutSession(sessionId: string) {
      return Promise.resolve(input.retrieve(sessionId));
    },
  };
}

function providerFailure(requestOutcome: "pre_request" | "uncertain"): Error {
  return Object.assign(new Error("Provider request failed."), {
    requestOutcome,
  });
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
    if (
      !record ||
      (record.response === null &&
        record.claim.claimExpiresAt.getTime() <= input.now.getTime())
    ) {
      const claim = {
        claimExpiresAt: input.claimExpiresAt,
        keyHash: input.keyHash,
        operation: input.operation,
        ...(input.ownerToken ? { ownerToken: input.ownerToken } : {}),
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

  complete(input: IdempotencyCompleteInput): Promise<"completed" | "lost"> {
    this.recordOperation("idempotency complete");
    const record = this.records.get(idempotencyScope(input.claim));
    if (
      !record ||
      record.claim.claimExpiresAt.getTime() !==
        input.claim.claimExpiresAt.getTime() ||
      record.claim.ownerToken !== input.claim.ownerToken
    ) {
      return Promise.resolve("lost");
    }
    record.response = input.response;
    return Promise.resolve("completed");
  }

  release(input: IdempotencyReleaseInput): Promise<"lost" | "released"> {
    this.recordOperation("idempotency release");
    const scope = idempotencyScope(input.claim);
    const record = this.records.get(scope);
    if (
      !record ||
      record.claim.claimExpiresAt.getTime() !==
        input.claim.claimExpiresAt.getTime() ||
      record.claim.ownerToken !== input.claim.ownerToken
    ) {
      return Promise.resolve("lost");
    }
    this.records.delete(scope);
    return Promise.resolve("released");
  }

  renew(
    input: Parameters<NonNullable<IdempotencyStore["renew"]>>[0]
  ): ReturnType<NonNullable<IdempotencyStore["renew"]>> {
    this.recordOperation("idempotency renew");
    const record = this.records.get(idempotencyScope(input.claim));
    if (
      !record ||
      record.response !== null ||
      record.claim.claimExpiresAt.getTime() !==
        input.claim.claimExpiresAt.getTime() ||
      record.claim.ownerToken !== input.claim.ownerToken ||
      record.claim.claimExpiresAt.getTime() <= input.now.getTime()
    ) {
      return Promise.resolve({ kind: "lost" });
    }
    record.claim = {
      ...record.claim,
      claimExpiresAt: input.claimExpiresAt,
    };
    return Promise.resolve({
      claim: record.claim,
      kind: "renewed",
    });
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
        attemptState: CheckoutAttemptLease["attemptState"];
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
        attemptState: { kind: "fresh" },
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

  checkpoint(input: {
    lease: CheckoutAttemptLease;
    leaseExpiresAt: Date;
    state: CheckoutAttemptLease["attemptState"];
    updatedAt: Date;
  }) {
    this.recordOperation("checkout lease checkpoint");
    if (
      !this.record ||
      this.record.ownerToken !== input.lease.ownerToken ||
      this.record.expiresAt.getTime() <= input.updatedAt.getTime()
    ) {
      return Promise.resolve({ kind: "lost" } as const);
    }
    this.record.attemptState = input.state;
    this.record.expiresAt = input.leaseExpiresAt;
    return Promise.resolve({
      kind: "checkpointed",
      lease: checkoutAttemptLease(this.record),
    } as const);
  }

  release(
    input: CheckoutAttemptLeaseReleaseInput
  ): Promise<"lost" | "released"> {
    this.recordOperation("checkout lease release");
    if (
      !this.record ||
      this.record.ownerToken !== input.lease.ownerToken ||
      this.record.expiresAt.getTime() <= input.releasedAt.getTime()
    ) {
      this.staleReleaseCount += 1;
      this.successorWasDeletedByStaleRelease = this.record === undefined;
      return Promise.resolve("lost");
    }
    if (input.disposition.kind === "retire_attempt") {
      this.record = undefined;
    } else {
      this.record.attemptState = input.disposition.state;
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
  attemptState: CheckoutAttemptLease["attemptState"];
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

class ResponseManualClock {
  private timestamp = Date.parse("2026-08-31T00:00:00.000Z");
  readonly now = () => new Date(this.timestamp);

  advance(milliseconds: number) {
    this.timestamp += milliseconds;
  }
}

type ResponseManualTimer = {
  callback: () => Promise<void>;
  cancelled: boolean;
};

class ResponseManualTimers {
  private readonly timers: ResponseManualTimer[] = [];

  clearTimeout(timer: unknown) {
    (timer as ResponseManualTimer).cancelled = true;
  }

  async runNext() {
    const timer = this.timers.find(({ cancelled }) => !cancelled);
    assert.ok(timer);
    timer.cancelled = true;
    await timer.callback();
  }

  setTimeout(callback: () => Promise<void>, _delayMs: number) {
    const timer = { callback, cancelled: false };
    this.timers.push(timer);
    return timer;
  }
}
