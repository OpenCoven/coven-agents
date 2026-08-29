import assert from "node:assert/strict";
import test from "node:test";
import { prewarmTenantSandbox } from "./prewarm.server";

const USER_ID = "3f1a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90";
const TENANT = "u_3f1a0f4e1f4d4a2e9c1b7d2f5a6b8c90";
const FUTURE = new Date(Date.now() + 86_400_000);

function subscribedUser() {
  return { authVersion: 7, id: USER_ID, subscribedUntil: FUTURE };
}

test("a subscriber warms in-process with the exact authenticated session and principal", async () => {
  let loaded = 0;
  let receivedSession: unknown;
  let receivedPrincipal: unknown;

  await prewarmTenantSandbox(subscribedUser(), {
    loadRunner: () => {
      loaded += 1;
      return Promise.resolve({
        createProductionRunnerService: (session) => {
          receivedSession = session;
          return {
            prewarmMostRecent: (principal) => {
              receivedPrincipal = principal;
              return Promise.resolve({ kind: "none" as const });
            },
          };
        },
      });
    },
  });

  assert.equal(loaded, 1);
  assert.deepEqual(receivedSession, {
    kind: "subscriber",
    tenant: TENANT,
    userId: USER_ID,
  });
  assert.deepEqual(receivedPrincipal, {
    kind: "subscriber",
    tenant: TENANT,
    userId: USER_ID,
  });
});

test("lapsed and missing subscriptions do not load the runner dependency", async () => {
  let loaded = 0;
  const loadRunner = () => {
    loaded += 1;
    return Promise.reject(new Error("must not load"));
  };

  await prewarmTenantSandbox(
    {
      authVersion: 7,
      id: USER_ID,
      subscribedUntil: new Date(Date.now() - 1000),
    },
    { loadRunner }
  );
  await prewarmTenantSandbox(
    { authVersion: 7, id: USER_ID, subscribedUntil: null },
    { loadRunner }
  );

  assert.equal(loaded, 0);
});

test("runner failures are swallowed so sign-in cannot fail", async () => {
  await prewarmTenantSandbox(subscribedUser(), {
    loadRunner: () => Promise.reject(new Error("module unavailable")),
  });

  await prewarmTenantSandbox(subscribedUser(), {
    loadRunner: async () => ({
      createProductionRunnerService: () => ({
        prewarmMostRecent: () =>
          Promise.reject(new Error("Daytona unavailable")),
      }),
    }),
  });
});

test("the in-process warm attempt is bounded without eagerly loading dependencies", async () => {
  let attempted = false;
  const started = Date.now();

  await prewarmTenantSandbox(subscribedUser(), {
    loadRunner: async () => ({
      createProductionRunnerService: () => ({
        prewarmMostRecent: () => {
          attempted = true;
          return new Promise(() => undefined);
        },
      }),
    }),
    timeoutMs: 5,
  });

  assert.equal(attempted, true);
  assert.ok(Date.now() - started < 1000);
});
