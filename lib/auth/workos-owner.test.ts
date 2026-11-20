import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkOSAccessTokenResult,
  WorkOSUserResult,
} from "./workos-access-token";
import {
  authenticateWorkOSOwner,
  type WorkOSOwnerAccount,
  type WorkOSOwnerDependencies,
} from "./workos-owner";

const NOW = new Date("2026-11-11T12:00:00.000Z");
const configuration = { apiKey: "sk_test_fixture", clientId: "client_fixture" };
const account: WorkOSOwnerAccount = {
  authVersion: 4,
  emailVerified: true,
  id: "11111111-1111-4111-8111-111111111111",
  subscribedUntil: new Date("2026-12-01T00:00:00.000Z"),
};

function fixture(
  overrides: Readonly<{
    accounts?: readonly WorkOSOwnerAccount[] | Error;
    configured?: boolean | Error;
    token?: WorkOSAccessTokenResult;
    user?: WorkOSUserResult;
  }> = {}
) {
  const events: string[] = [];
  const dependencies: WorkOSOwnerDependencies = {
    configuration: () => {
      if (overrides.configured instanceof Error) {
        throw overrides.configured;
      }
      return overrides.configured === false ? null : configuration;
    },
    fetchUser: (userId) => {
      events.push(`user:${userId}`);
      return Promise.resolve(
        overrides.user ?? { email: "owner@example.test", kind: "verified" }
      );
    },
    findAccountsByEmail: (email) => {
      events.push(`accounts:${email}`);
      return overrides.accounts instanceof Error
        ? Promise.reject(overrides.accounts)
        : Promise.resolve(overrides.accounts ?? [account]);
    },
    now: () => NOW,
    verifier: () => (token) => {
      events.push(`verify:${token}`);
      return Promise.resolve(
        overrides.token ?? {
          kind: "verified",
          sessionId: "session_01FIXTURE",
          userId: "user_01FIXTURE",
        }
      );
    },
  };
  return { dependencies, events };
}

const bearer = (headers: Record<string, string> = {}) =>
  new Request("https://agents.example/api", {
    headers: { authorization: "Bearer aa.bb.cc", ...headers },
  });

test("a verified token resolves to the one matching account's current authority", async () => {
  const { dependencies, events } = fixture();
  assert.deepEqual(await authenticateWorkOSOwner(bearer(), dependencies), {
    kind: "authenticated",
    session: { user: { authVersion: 4, id: account.id, type: "subscriber" } },
  });
  assert.deepEqual(events, [
    "verify:aa.bb.cc",
    "user:user_01FIXTURE",
    "accounts:owner@example.test",
  ]);
});

test("an account without a live entitlement resolves to a non-subscriber type", async () => {
  const { dependencies } = fixture({
    accounts: [
      { ...account, subscribedUntil: new Date("2026-01-01T00:00:00Z") },
    ],
  });
  const result = await authenticateWorkOSOwner(bearer(), dependencies);
  assert.equal(
    result.kind === "authenticated" ? result.session?.user?.type : null,
    "demo"
  );
});

test("an unconfigured deployment is unavailable before the token is read", async () => {
  for (const configured of [false, new Error("bad env")] as const) {
    const { dependencies, events } = fixture({ configured });
    // biome-ignore lint/performance/noAwaitInLoops: Cases run in order so a failure names its own input.
    assert.deepEqual(await authenticateWorkOSOwner(bearer(), dependencies), {
      kind: "unavailable",
    });
    assert.deepEqual(events, []);
  }
});

test("a session cookie without a bearer token is not authentication", async () => {
  const { dependencies, events } = fixture();
  const request = new Request("https://agents.example/api", {
    headers: { cookie: "authjs.session-token=aa.bb.cc" },
  });
  assert.deepEqual(await authenticateWorkOSOwner(request, dependencies), {
    kind: "unauthorized",
  });
  assert.deepEqual(events, []);
});

test("a rejected token stops before any user or account lookup", async () => {
  const { dependencies, events } = fixture({ token: { kind: "rejected" } });
  assert.deepEqual(await authenticateWorkOSOwner(bearer(), dependencies), {
    kind: "unauthorized",
  });
  assert.deepEqual(events, ["verify:aa.bb.cc"]);
});

test("an unverified user stops before any account lookup", async () => {
  const { dependencies, events } = fixture({ user: { kind: "rejected" } });
  assert.deepEqual(await authenticateWorkOSOwner(bearer(), dependencies), {
    kind: "unauthorized",
  });
  assert.deepEqual(events, ["verify:aa.bb.cc", "user:user_01FIXTURE"]);
});

test("zero or several matching accounts are refused; none is created", async () => {
  for (const accounts of [[], [account, { ...account, id: "other" }]]) {
    const { dependencies } = fixture({ accounts });
    // biome-ignore lint/performance/noAwaitInLoops: Cases run in order so a failure names its own input.
    assert.deepEqual(await authenticateWorkOSOwner(bearer(), dependencies), {
      kind: "unauthorized",
    });
  }
});

test("the one matching account must have a locally verified email", async () => {
  const { dependencies } = fixture({
    accounts: [{ ...account, emailVerified: false }],
  });
  assert.deepEqual(await authenticateWorkOSOwner(bearer(), dependencies), {
    kind: "unauthorized",
  });
});

test("an upstream outage is unavailable, never authentication", async () => {
  for (const overrides of [
    { token: { kind: "unavailable" } },
    { user: { kind: "unavailable" } },
    { accounts: new Error("db down") },
  ] as const) {
    const { dependencies } = fixture(overrides);
    // biome-ignore lint/performance/noAwaitInLoops: Cases run in order so a failure names its own input.
    assert.deepEqual(await authenticateWorkOSOwner(bearer(), dependencies), {
      kind: "unavailable",
    });
  }
});
