import assert from "node:assert/strict";
import test from "node:test";
import type { AbuseAdmission } from "@/lib/abuse/enforce";
import { subscriptionCheckoutEnabled } from "@/lib/billing/config-core";
import {
  type SubscriptionStatusDependencies,
  subscriptionResponse,
} from "@/lib/billing/subscription-status";

const USER_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const OTHER_USER_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const NOW = new Date("2026-08-31T12:00:00.000Z");
const FUTURE = new Date("2026-09-30T12:00:00.000Z");

test("signed-out and synthetic demo callers are rejected before database work", async () => {
  await Promise.all(
    [
      null,
      { user: null },
      { user: { id: null, type: "demo" } },
      { user: { id: "synthetic-demo", type: "demo" } },
    ].map(async (session) => {
      const calls: string[] = [];
      const response = await subscriptionResponse(
        request(),
        dependenciesFor({
          authenticate: () => {
            calls.push("authenticate");
            return Promise.resolve(session);
          },
          enforceAbuse: () => {
            calls.push("abuse");
            return Promise.resolve({ kind: "allowed" });
          },
          findUser: () => {
            calls.push("database");
            return Promise.resolve({ subscribedUntil: FUTURE });
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
      authenticate: () => {
        calls.push("authenticate");
        return Promise.resolve(userSession("demo"));
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
        return Promise.resolve({ subscribedUntil: null });
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
        return Promise.resolve({ subscribedUntil: FUTURE });
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
      tokenType: "demo" as const,
    },
    {
      expectedActive: false,
      storedUntil: null,
      tokenType: "subscriber" as const,
    },
    {
      expectedActive: false,
      storedUntil: NOW,
      tokenType: "subscriber" as const,
    },
  ];

  await Promise.all(
    cases.map(async ({ expectedActive, storedUntil, tokenType }) => {
      const response = await subscriptionResponse(
        request(),
        dependenciesFor({
          authenticate: () => Promise.resolve(userSession(tokenType)),
          findUser: () => Promise.resolve({ subscribedUntil: storedUntil }),
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
          findUser: () => Promise.resolve({ subscribedUntil: FUTURE }),
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

test("browser-supplied identity cannot select the database user", async () => {
  let readUserId: string | null = null;
  const response = await subscriptionResponse(
    new Request(`https://app.test/api/subscription?userId=${OTHER_USER_ID}`, {
      headers: { "x-user-id": OTHER_USER_ID },
    }),
    dependenciesFor({
      findUser: (userId) => {
        readUserId = userId;
        return Promise.resolve({ subscribedUntil: FUTURE });
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

function dependenciesFor(
  overrides: Partial<SubscriptionStatusDependencies> = {}
): SubscriptionStatusDependencies {
  return {
    authenticate: () => Promise.resolve(userSession("demo")),
    checkoutEnabled: () => false,
    enforceAbuse: () =>
      Promise.resolve({ kind: "allowed" } satisfies AbuseAdmission),
    findUser: () => Promise.resolve({ subscribedUntil: null }),
    now: () => NOW,
    ...overrides,
  };
}

function userSession(type: "demo" | "subscriber") {
  return { user: { authVersion: 4, id: USER_ID, type } };
}

function request(): Request {
  return new Request("https://app.test/api/subscription");
}

function assertNoStore(response: Response): void {
  assert.equal(response.headers.get("cache-control"), "no-store");
}
