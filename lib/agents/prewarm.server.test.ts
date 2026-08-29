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
  let loadSignal: AbortSignal | undefined;
  let receivedSession: unknown;
  let receivedPrincipal: unknown;
  let receivedOptions: unknown;

  await prewarmTenantSandbox(subscribedUser(), {
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

test("the deadline aborts the in-process warm and waits for its cleanup", async () => {
  let attempted = false;
  let aborted = false;
  let released = false;
  const started = Date.now();

  await prewarmTenantSandbox(subscribedUser(), {
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
