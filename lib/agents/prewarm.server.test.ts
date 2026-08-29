import assert from "node:assert/strict";
import test from "node:test";
import { prewarmTenantSandbox } from "./prewarm.server";

const USER_ID = "3f1a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90";
const TENANT = "u_3f1a0f4e1f4d4a2e9c1b7d2f5a6b8c90";
const FUTURE = new Date(Date.now() + 86_400_000);

function subscribedUser() {
  return { authVersion: 7, id: USER_ID, subscribedUntil: FUTURE };
}

const AUTHORIZED = {
  authVersion: 7,
  kind: "allowed" as const,
  session: {
    kind: "subscriber" as const,
    tenant: TENANT,
    userId: USER_ID,
  },
  userId: USER_ID,
};

test("a subscriber warms in-process with the exact authenticated session and principal", async () => {
  let loaded = 0;
  let loadSignal: AbortSignal | undefined;
  let authorityInput: unknown;
  let authoritySignal: AbortSignal | undefined;
  let receivedSession: unknown;
  let receivedPrincipal: unknown;
  let receivedOptions: unknown;

  await prewarmTenantSandbox(subscribedUser(), {
    authorizeCurrent: (session, signal) => {
      authorityInput = session;
      authoritySignal = signal;
      return Promise.resolve(AUTHORIZED);
    },
    loadRunner: (signal) => {
      loaded += 1;
      loadSignal = signal;
      return Promise.resolve({
        createProductionRunnerService: (session) => {
          receivedSession = session;
          return {
            prewarmMostRecent: (principal, prewarmOptions) => {
              receivedPrincipal = principal;
              receivedOptions = prewarmOptions;
              return Promise.resolve({ kind: "none" as const });
            },
          };
        },
      });
    },
  });

  assert.equal(loaded, 1);
  assert.equal(loadSignal?.aborted, false);
  assert.equal(authoritySignal, loadSignal);
  assert.deepEqual(authorityInput, {
    user: { authVersion: 7, id: USER_ID, type: "subscriber" },
  });
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
  const options = receivedOptions as {
    deadline: number;
    signal: AbortSignal;
  };
  assert.equal(options.signal, loadSignal);
  assert.equal(options.signal.aborted, false);
  assert.ok(options.deadline > Date.now());
});

test("lapsed and missing subscriptions do not load the runner dependency", async () => {
  let loaded = 0;
  let authorityChecks = 0;
  const authorizeCurrent = () => {
    authorityChecks += 1;
    return Promise.resolve(AUTHORIZED);
  };
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
    { authorizeCurrent, loadRunner }
  );
  await prewarmTenantSandbox(
    { authVersion: 7, id: USER_ID, subscribedUntil: null },
    { authorizeCurrent, loadRunner }
  );

  assert.equal(loaded, 0);
  assert.equal(authorityChecks, 0);
});

test("runner failures are swallowed so sign-in cannot fail", async () => {
  await prewarmTenantSandbox(subscribedUser(), {
    authorizeCurrent: () => Promise.resolve(AUTHORIZED),
    loadRunner: () => Promise.reject(new Error("module unavailable")),
  });

  await prewarmTenantSandbox(subscribedUser(), {
    authorizeCurrent: () => Promise.resolve(AUTHORIZED),
    loadRunner: async () => ({
      createProductionRunnerService: () => ({
        prewarmMostRecent: () =>
          Promise.reject(new Error("Daytona unavailable")),
      }),
    }),
  });
});

test("the deadline aborts the in-process warm and waits for its cleanup", async () => {
  let attempted = false;
  let aborted = false;
  let released = false;
  const started = Date.now();

  await prewarmTenantSandbox(subscribedUser(), {
    authorizeCurrent: () => Promise.resolve(AUTHORIZED),
    loadRunner: async (loadSignal) => ({
      createProductionRunnerService: () => ({
        prewarmMostRecent: (_principal, options) => {
          attempted = true;
          assert.equal(options?.signal, loadSignal);
          return new Promise((resolve) => {
            options?.signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                released = true;
                resolve({
                  agentId: "11111111-1111-4111-8111-111111111111",
                  kind: "warmed" as const,
                  warm: {
                    status: "failed" as const,
                    updatedAt: new Date().toISOString(),
                  },
                });
              },
              { once: true }
            );
          });
        },
      }),
    }),
    timeoutMs: 5,
  });

  assert.equal(attempted, true);
  assert.equal(aborted, true);
  assert.equal(released, true);
  assert.ok(Date.now() - started < 1000);
});

test("stale, cancelled, missing, and unavailable current authority skip runner work", async () => {
  const decisions = [
    () => Promise.resolve({ ...AUTHORIZED, authVersion: 8 }),
    () => Promise.resolve({ kind: "subscription_required" as const }),
    () => Promise.resolve({ kind: "unauthorized" as const }),
    () => Promise.reject(new Error("account lookup failed")),
  ];

  await Promise.all(
    decisions.map(async (decision) => {
      let loaded = 0;
      await prewarmTenantSandbox(subscribedUser(), {
        authorizeCurrent: decision,
        loadRunner: () => {
          loaded += 1;
          return Promise.reject(new Error("must not load"));
        },
      });
      assert.equal(loaded, 0);
    })
  );
});

test("a cancelled current-authority lookup never reaches runner work", async () => {
  let loaded = 0;
  const started = Date.now();

  await prewarmTenantSandbox(subscribedUser(), {
    authorizeCurrent: () => new Promise(() => undefined),
    loadRunner: () => {
      loaded += 1;
      return Promise.reject(new Error("must not load"));
    },
    timeoutMs: 5,
  });

  assert.equal(loaded, 0);
  assert.ok(Date.now() - started < 1000);
});

test("a loader resolving at the deadline constructs and invokes no runner service", async () => {
  let constructed = 0;
  let invoked = 0;

  await prewarmTenantSandbox(subscribedUser(), {
    authorizeCurrent: () => Promise.resolve(AUTHORIZED),
    loadRunner: (signal) =>
      new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () =>
            resolve({
              createProductionRunnerService: () => {
                constructed += 1;
                return {
                  prewarmMostRecent: () => {
                    invoked += 1;
                    return Promise.resolve({ kind: "none" });
                  },
                };
              },
            }),
          { once: true }
        );
      }),
    timeoutMs: 5,
  });

  assert.equal(constructed, 0);
  assert.equal(invoked, 0);
});
