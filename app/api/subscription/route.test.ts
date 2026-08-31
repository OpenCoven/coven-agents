import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { encode, type JWT } from "next-auth/jwt";
import type { AbuseAdmission } from "@/lib/abuse/enforce";
import { verifiedJwtIdentity } from "@/lib/auth/verified-jwt";
import { subscriptionCheckoutEnabled } from "@/lib/billing/config-core";
import {
  type SubscriptionStatusDependencies,
  subscriptionResponse,
} from "@/lib/billing/subscription-status";

const USER_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const OTHER_USER_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const NOW = new Date("2026-08-31T12:00:00.000Z");
const FUTURE = new Date("2026-09-30T12:00:00.000Z");
const AUTH_SECRET = "subscription-route-verified-jwt-secret";
const SECURE_SESSION_COOKIE = "__Secure-authjs.session-token";

test("missing and noncanonical verified identities are rejected before admission", async () => {
  await Promise.all(
    [
      null,
      { authVersion: 4, userId: "" },
      { authVersion: 4, userId: "synthetic-demo" },
    ].map(async (identityCandidate) => {
      const calls: string[] = [];
      const response = await subscriptionResponse(
        request(),
        dependenciesFor({
          authenticate: () => {
            calls.push("authenticate");
            return Promise.resolve(identityCandidate);
          },
          enforceAbuse: () => {
            calls.push("abuse");
            return Promise.resolve({ kind: "allowed" });
          },
          findUser: () => {
            calls.push("database");
            return Promise.resolve({
              authVersion: 4,
              subscribedUntil: FUTURE,
            });
          },
        }),
        null
      );

      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "unauthorized" });
      assertNoStore(response);
      assert.deepEqual(calls, ["authenticate"]);
    })
  );
});

test("admission uses IP and authenticated user before the database read", async () => {
  const calls: string[] = [];
  const response = await subscriptionResponse(
    request(),
    dependenciesFor({
      authenticate: (receivedRequest) => {
        calls.push("authenticate");
        assert.equal(receivedRequest.url, request().url);
        return Promise.resolve(identity());
      },
      enforceAbuse: (input) => {
        calls.push("abuse");
        assert.deepEqual(input, {
          ip: "203.0.113.10",
          route: "subscription_read",
          userId: USER_ID,
        });
        return Promise.resolve({ kind: "allowed" });
      },
      findUser: (userId) => {
        calls.push(`database:${userId}`);
        return Promise.resolve({ authVersion: 4, subscribedUntil: null });
      },
    }),
    "203.0.113.10"
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["authenticate", "abuse", `database:${USER_ID}`]);
});

test("admission denial performs no database or configuration work", async () => {
  const calls: string[] = [];
  const response = await subscriptionResponse(
    request(),
    dependenciesFor({
      checkoutEnabled: () => {
        calls.push("configuration");
        return true;
      },
      enforceAbuse: () => {
        calls.push("abuse");
        return Promise.resolve({
          kind: "denied",
          responseStatus: 429,
          retryAfterSeconds: 9,
        });
      },
      findUser: () => {
        calls.push("database");
        return Promise.resolve({ authVersion: 4, subscribedUntil: FUTURE });
      },
    }),
    null
  );

  assert.equal(response.status, 429);
  assertNoStore(response);
  assert.deepEqual(calls, ["abuse"]);
});

test("active and inactive status come from the database, not token type", async () => {
  const cases = [
    {
      expectedActive: true,
      storedUntil: FUTURE,
    },
    {
      expectedActive: false,
      storedUntil: null,
    },
    {
      expectedActive: false,
      storedUntil: NOW,
    },
  ];

  await Promise.all(
    cases.map(async ({ expectedActive, storedUntil }) => {
      const response = await subscriptionResponse(
        request(),
        dependenciesFor({
          findUser: () =>
            Promise.resolve({ authVersion: 4, subscribedUntil: storedUntil }),
        }),
        null
      );

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        active: expectedActive,
        checkoutEnabled: false,
        subscribedUntil: storedUntil?.toISOString() ?? null,
      });
      assertNoStore(response);
    })
  );
});

test("the exact checkout parser reports on and off while the endpoint remains available", async () => {
  await Promise.all(
    (
      [
        ["off", false],
        ["on", true],
      ] as const
    ).map(async ([configured, expected]) => {
      const response = await subscriptionResponse(
        request(),
        dependenciesFor({
          checkoutEnabled: () =>
            subscriptionCheckoutEnabled({
              SUBSCRIPTION_CHECKOUT_ENABLED: configured,
            }),
          findUser: () =>
            Promise.resolve({ authVersion: 4, subscribedUntil: FUTURE }),
        }),
        null
      );

      assert.equal(response.status, 200);
      assert.equal(
        ((await response.json()) as { checkoutEnabled: boolean })
          .checkoutEnabled,
        expected
      );
      assertNoStore(response);
    })
  );
});

test("an invalid checkout flag is an explicit no-store server error", async () => {
  const response = await subscriptionResponse(
    request(),
    dependenciesFor({
      checkoutEnabled: () =>
        subscriptionCheckoutEnabled({
          SUBSCRIPTION_CHECKOUT_ENABLED: "ON",
        }),
    }),
    null
  );

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "billing_configuration_invalid",
  });
  assertNoStore(response);
});

test("missing users and database failures fail closed", async () => {
  const missing = await subscriptionResponse(
    request(),
    dependenciesFor({ findUser: () => Promise.resolve(null) }),
    null
  );
  assert.equal(missing.status, 401);
  assert.deepEqual(await missing.json(), { error: "unauthorized" });
  assertNoStore(missing);

  const failed = await subscriptionResponse(
    request(),
    dependenciesFor({
      findUser: () => Promise.reject(new Error("database unavailable")),
    }),
    null
  );
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), {
    error: "subscription_unavailable",
  });
  assertNoStore(failed);
});

test("an auth-version mismatch is revoked after exactly one admitted lookup", async () => {
  let lookups = 0;
  const response = await subscriptionResponse(
    request(),
    dependenciesFor({
      findUser: () => {
        lookups += 1;
        return Promise.resolve({ authVersion: 5, subscribedUntil: FUTURE });
      },
    }),
    null
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthorized" });
  assert.equal(lookups, 1);
  assertNoStore(response);
});

test("verified-token infrastructure failure is unavailable without admission or database work", async () => {
  const calls: string[] = [];
  const response = await subscriptionResponse(
    request(),
    dependenciesFor({
      authenticate: () => {
        calls.push("authenticate");
        return Promise.reject(new Error("AUTH_SECRET missing"));
      },
      enforceAbuse: () => {
        calls.push("abuse");
        return Promise.resolve({ kind: "allowed" });
      },
      findUser: () => {
        calls.push("database");
        return Promise.resolve({ authVersion: 4, subscribedUntil: FUTURE });
      },
    }),
    null
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "subscription_unavailable",
  });
  assert.deepEqual(calls, ["authenticate"]);
  assertNoStore(response);
});

test("browser-supplied identity cannot select the database user", async () => {
  let readUserId: string | null = null;
  const response = await subscriptionResponse(
    new Request(`https://app.test/api/subscription?userId=${OTHER_USER_ID}`, {
      headers: { "x-user-id": OTHER_USER_ID },
    }),
    dependenciesFor({
      findUser: (userId) => {
        readUserId = userId;
        return Promise.resolve({
          authVersion: 4,
          subscribedUntil: FUTURE,
        });
      },
    }),
    null
  );

  assert.equal(response.status, 200);
  assert.equal(readUserId, USER_ID);
  const payload = await response.json();
  assert.deepEqual(Object.keys(payload).sort(), [
    "active",
    "checkoutEnabled",
    "subscribedUntil",
  ]);
  for (const field of [
    "authVersion",
    "billingPeriodStart",
    "stripeCustomerId",
    "stripeSubscriptionId",
  ]) {
    assert.equal(field in payload, false);
  }
  assertNoStore(response);
});

test("the production route verifies Auth.js JWT directly instead of calling auth()", () => {
  const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

  assert.match(source, /verifiedJwtIdentity/);
  assert.doesNotMatch(source, /from ["']@\/app\/\(auth\)\/auth["']/);
  assert.doesNotMatch(source, /authenticate:\s*auth/);
});

test("production-style JWT verification rejects invalid, expired, missing-id, and demo tokens before abuse", async () => {
  const requests = [
    await signedSubscriptionRequest(identityToken(), {
      secret: "subscription-route-wrong-secret",
    }),
    await signedSubscriptionRequest(identityToken(), { maxAge: -60 }),
    await signedSubscriptionRequest({ authVersion: 4, type: "demo" }),
    await signedSubscriptionRequest({
      authVersion: 4,
      id: "demo:visitor",
      type: "demo",
    }),
  ];

  await Promise.all(
    requests.map(async (candidate) => {
      const calls: string[] = [];
      const response = await subscriptionResponse(
        candidate,
        dependenciesFor({
          authenticate: (receivedRequest) => {
            calls.push("verify");
            return verifiedJwtIdentity(receivedRequest, {
              environment: {
                AUTH_SECRET,
                AUTH_URL: "https://app.test",
              },
            });
          },
          enforceAbuse: () => {
            calls.push("abuse");
            return Promise.resolve({ kind: "allowed" });
          },
          findUser: () => {
            calls.push("database");
            return Promise.resolve({ authVersion: 4, subscribedUntil: FUTURE });
          },
        }),
        null
      );

      assert.equal(response.status, 401);
      assert.deepEqual(calls, ["verify"]);
      assertNoStore(response);
    })
  );
});

test("production-style JWT verification admits before one authority lookup", async () => {
  const calls: string[] = [];
  let lookups = 0;
  const response = await subscriptionResponse(
    await signedSubscriptionRequest(identityToken()),
    dependenciesFor({
      authenticate: (receivedRequest) => {
        calls.push("verify");
        return verifiedJwtIdentity(receivedRequest, {
          environment: {
            AUTH_SECRET,
            AUTH_URL: "https://app.test",
          },
        });
      },
      enforceAbuse: () => {
        calls.push("abuse");
        return Promise.resolve({ kind: "allowed" });
      },
      findUser: () => {
        calls.push("database");
        lookups += 1;
        return Promise.resolve({ authVersion: 4, subscribedUntil: FUTURE });
      },
    }),
    "203.0.113.50"
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["verify", "abuse", "database"]);
  assert.equal(lookups, 1);
});

function dependenciesFor(
  overrides: Partial<SubscriptionStatusDependencies> = {}
): SubscriptionStatusDependencies {
  return {
    authenticate: () => Promise.resolve(identity()),
    checkoutEnabled: () => false,
    enforceAbuse: () =>
      Promise.resolve({ kind: "allowed" } satisfies AbuseAdmission),
    findUser: () => Promise.resolve({ authVersion: 4, subscribedUntil: null }),
    now: () => NOW,
    ...overrides,
  };
}

function identity() {
  return { authVersion: 4, userId: USER_ID };
}

function request(): Request {
  return new Request("https://app.test/api/subscription");
}

async function signedSubscriptionRequest(
  claims: Partial<JWT>,
  options: { maxAge?: number; secret?: string } = {}
): Promise<Request> {
  const value = await encode({
    maxAge: options.maxAge,
    salt: SECURE_SESSION_COOKIE,
    secret: options.secret ?? AUTH_SECRET,
    token: claims,
  });
  return new Request("https://app.test/api/subscription", {
    headers: { cookie: `${SECURE_SESSION_COOKIE}=${value}` },
  });
}

function identityToken(): JWT {
  return {
    authVersion: 4,
    id: USER_ID,
    type: "demo",
  };
}

function assertNoStore(response: Response): void {
  assert.equal(response.headers.get("cache-control"), "no-store");
}
