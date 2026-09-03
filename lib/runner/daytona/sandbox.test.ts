import assert from "node:assert/strict";
import test from "node:test";
import {
  DaytonaBadRequestError,
  DaytonaNotFoundError,
  DaytonaTimeoutError,
  type Sandbox,
  SandboxState,
} from "@daytona/sdk";
import type { RunnerStore } from "../store";
import type { RunnerAgentRecord, RunnerPrincipal } from "../types";
import {
  DAYTONA_SANDBOX_RESOURCE_POLICY_CAPS,
  DAYTONA_SANDBOX_RESOURCE_POLICY_DEFAULTS,
} from "./config";
import {
  daytonaProbeSessionName,
  daytonaSandboxLabels,
  daytonaSandboxName,
} from "./names";
import { probeDaytonaHarnesses } from "./process";
import {
  classifyDaytonaProviderError,
  classifyDaytonaSandboxCreateError,
  type DaytonaSandboxConfiguration,
  type DaytonaSandboxCreateParameters,
  DaytonaSandboxLifecycleError,
  daytonaSandboxConfiguration,
  deleteDaytonaSandbox,
  ensureDaytonaSandbox,
  ensureDaytonaSandboxForDispatch,
  resetDaytonaSandboxForCancellation,
  warmDaytonaSandbox,
} from "./sandbox";

const principal: RunnerPrincipal = {
  kind: "subscriber",
  tenant: "private_tenant",
  userId: "user",
};
const config: DaytonaSandboxConfiguration = {
  autoArchiveInterval: 10_080,
  autoDeleteInterval: -1,
  autoStopInterval: 15,
  resources: { cpu: 2, disk: 20, memory: 4 },
  snapshotName: "coven-agents-copilot-1",
  target: "us",
  ttlMinutes: 0,
};

function agent(overrides: Partial<RunnerAgentRecord> = {}): RunnerAgentRecord {
  return {
    createdAt: new Date(),
    daytonaSandboxId: null,
    description: "",
    id: "00000000-0000-4000-8000-000000000001",
    instructions: "test",
    lastRunAt: null,
    model: "test",
    name: "test",
    runtime: "copilot",
    sandboxGeneration: 0,
    sandboxLifecycle: "unprovisioned",
    sandboxTrust: "clean",
    sandboxUpdatedAt: new Date(),
    status: "idle",
    tenant: principal.tenant,
    updatedAt: new Date(),
    version: 0,
    warmAttemptVersion: 0,
    warmStatus: "not_started",
    warmUpdatedAt: new Date(),
    workspace: null,
    ...overrides,
  };
}

function sandbox(
  state: SandboxState | undefined,
  hooks: {
    delete?: (timeout?: number, wait?: boolean) => Promise<void>;
    refreshData?: () => Promise<void>;
    recover?: () => Promise<void>;
    start?: () => Promise<void>;
    waitForResizeComplete?: (timeout?: number) => Promise<void>;
    waitUntilStarted?: (timeout?: number) => Promise<void>;
  } = {}
): Sandbox {
  return {
    delete: (timeout?: number, wait?: boolean) =>
      hooks.delete?.(timeout, wait) ?? Promise.resolve(),
    id: "sandbox-id",
    labels: {},
    recover: () => hooks.recover?.() ?? Promise.resolve(),
    refreshData: () => hooks.refreshData?.() ?? Promise.resolve(),
    start: () => hooks.start?.() ?? Promise.resolve(),
    state,
    waitForResizeComplete: (timeout?: number) =>
      hooks.waitForResizeComplete?.(timeout) ?? Promise.resolve(),
    waitUntilStarted: (timeout?: number) =>
      hooks.waitUntilStarted?.(timeout) ?? Promise.resolve(),
  } as unknown as Sandbox;
}

function store(methods: Record<string, unknown>): RunnerStore {
  return methods as RunnerStore;
}

function settlesWithin<T>(promise: Promise<T>, milliseconds = 100): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("operation did not settle promptly")),
      milliseconds
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

test("stored provider IDs are resolved and stopped or archived sandboxes start", async () => {
  await Promise.all(
    [SandboxState.STOPPED, SandboxState.ARCHIVED].map(async (state) => {
      let starts = 0;
      const resolved = sandbox(state, {
        start: () => {
          starts += 1;
          return Promise.resolve();
        },
      });

      const result = await ensureDaytonaSandbox(
        principal,
        agent({ daytonaSandboxId: "stored", sandboxLifecycle: "ready" }),
        config,
        {
          daytona: {
            create: () => Promise.reject(new Error("must not create")),
            get: (id) => {
              assert.equal(id, "stored");
              return Promise.resolve(resolved);
            },
          },
          store: store({}),
        }
      );
      assert.equal(result.sandbox, resolved);
      assert.equal(starts, 1);
    })
  );
});

test("dispatch replaces a sandbox when gateway egress configuration identity changes", async () => {
  const calls: string[] = [];
  const currentAgent = agent({
    daytonaSandboxId: "stored",
    sandboxGeneration: 2,
    sandboxLifecycle: "ready",
    version: 4,
  });
  const resettingAgent = agent({
    ...currentAgent,
    sandboxGeneration: 3,
    sandboxLifecycle: "resetting",
    version: 5,
  });
  const resetAgent = agent({
    ...resettingAgent,
    daytonaSandboxId: null,
    sandboxLifecycle: "unprovisioned",
    version: 6,
  });
  const reservedAgent = agent({
    ...resetAgent,
    sandboxGeneration: 4,
    sandboxLifecycle: "provisioning",
    version: 7,
  });
  const attachedAgent = agent({
    ...reservedAgent,
    daytonaSandboxId: "replacement",
    sandboxLifecycle: "ready",
    version: 8,
  });
  const oldSandbox = Object.assign(
    sandbox(SandboxState.STOPPED, {
      delete: () => {
        calls.push("delete");
        return Promise.resolve();
      },
    }),
    { labels: { configurationId: "old-configuration" } }
  );
  const replacement = Object.assign(sandbox(SandboxState.STARTED), {
    id: "replacement",
    labels: {
      ...daytonaSandboxLabels(principal.tenant, currentAgent.id),
      configurationId: "new-configuration",
      sandboxGeneration: String(reservedAgent.sandboxGeneration),
    },
  });
  const configuration = {
    ...config,
    configurationId: "new-configuration",
    domainAllowList: "api.github.com,app.example",
    gatewayHostname: "app.example",
  };

  const result = await ensureDaytonaSandboxForDispatch(
    { kind: "runner-operator" },
    {
      expectedVersion: 1,
      leaseToken: "dispatch-lease",
      runId: "00000000-0000-4000-8000-000000000002",
    } as never,
    configuration,
    {
      daytona: {
        create: (parameters) => {
          calls.push("create");
          assert.equal(
            parameters.labels?.configurationId,
            configuration.configurationId
          );
          return Promise.resolve(replacement);
        },
        get: (identifier) => {
          calls.push(`get:${identifier}`);
          return identifier === "stored"
            ? Promise.resolve(oldSandbox)
            : Promise.reject(new DaytonaNotFoundError("replacement absent"));
        },
      },
      store: store({
        attachDaytonaSandboxForDispatch: () => {
          calls.push("attach");
          return Promise.resolve({
            kind: "updated" as const,
            value: attachedAgent,
          });
        },
        beginDaytonaSandboxResetForDispatch: () => {
          calls.push("begin-reset");
          return Promise.resolve({
            kind: "updated" as const,
            value: resettingAgent,
          });
        },
        finishDaytonaSandboxResetForDispatch: () => {
          calls.push("finish-reset");
          return Promise.resolve({
            kind: "updated" as const,
            value: resetAgent,
          });
        },
        getDispatchAgent: () => {
          calls.push("get-dispatch");
          return Promise.resolve({
            agent: currentAgent,
            kind: "found" as const,
            run: {} as never,
          });
        },
        reserveDaytonaSandboxForDispatch: () => {
          calls.push("reserve");
          return Promise.resolve({
            kind: "reserved" as const,
            value: reservedAgent,
          });
        },
      }),
    }
  );

  assert.equal(result.agent.sandboxGeneration, 4);
  assert.equal(result.sandbox, replacement);
  assert.deepEqual(calls, [
    "get-dispatch",
    "get:stored",
    "begin-reset",
    "delete",
    "finish-reset",
    "reserve",
    `get:${daytonaSandboxName(principal.tenant, currentAgent.id)}`,
    "create",
    "attach",
  ]);
});

test("cancellation reset fences the sandbox before clearing its generation", async () => {
  const calls: string[] = [];
  const dispatchAuthority = {
    expectedVersion: 2,
    leaseToken: "cancel-lease",
    runId: "00000000-0000-4000-8000-000000000002",
  } as never;
  const resetting = agent({
    daytonaSandboxId: "sandbox",
    sandboxGeneration: 2,
    sandboxLifecycle: "resetting",
    version: 4,
  });
  const cleared = agent({
    ...resetting,
    daytonaSandboxId: null,
    sandboxLifecycle: "unprovisioned",
    version: 5,
  });

  const reset = await resetDaytonaSandboxForCancellation(
    { kind: "runner-operator" },
    dispatchAuthority,
    {
      daytona: {
        create: () => Promise.reject(new Error("must not create")),
        get: () =>
          Promise.resolve(
            sandbox(SandboxState.STARTED, {
              delete: () => {
                calls.push("delete");
                return Promise.resolve();
              },
            })
          ),
      },
      store: store({
        beginDaytonaSandboxResetForCancellation: () => {
          calls.push("begin");
          return Promise.resolve({
            kind: "resetting" as const,
            value: resetting,
          });
        },
        finishDaytonaSandboxResetForRecovery: () => {
          calls.push("finish");
          return Promise.resolve({ kind: "updated" as const, value: cleared });
        },
      }),
    }
  );

  assert.deepEqual(reset, { kind: "reset" });
  assert.deepEqual(calls, ["begin", "delete", "finish"]);
});

test("cancellation reset preserves absence, provider outage, and stale fences", async () => {
  const dispatchAuthority = {
    expectedVersion: 2,
    leaseToken: "cancel-lease",
    runId: "00000000-0000-4000-8000-000000000002",
  } as never;
  const resetting = agent({
    daytonaSandboxId: "sandbox",
    sandboxGeneration: 2,
    sandboxLifecycle: "resetting",
    version: 4,
  });
  const cleared = agent({
    ...resetting,
    daytonaSandboxId: null,
    sandboxLifecycle: "unprovisioned",
    version: 5,
  });

  const absent = await resetDaytonaSandboxForCancellation(
    { kind: "runner-operator" },
    dispatchAuthority,
    {
      daytona: {
        create: () => Promise.reject(new Error("must not create")),
        get: () => Promise.reject(new DaytonaNotFoundError("absent")),
      },
      store: store({
        beginDaytonaSandboxResetForCancellation: async () => ({
          kind: "resetting" as const,
          value: resetting,
        }),
        finishDaytonaSandboxResetForRecovery: async () => ({
          kind: "updated" as const,
          value: cleared,
        }),
      }),
    }
  );
  assert.deepEqual(absent, { kind: "provider_not_found" });

  const unavailable = await resetDaytonaSandboxForCancellation(
    { kind: "runner-operator" },
    dispatchAuthority,
    {
      daytona: {
        create: () => Promise.reject(new Error("must not create")),
        get: () => Promise.reject(new DaytonaTimeoutError("timeout")),
      },
      store: store({
        beginDaytonaSandboxResetForCancellation: async () => ({
          kind: "resetting" as const,
          value: resetting,
        }),
      }),
    }
  );
  assert.deepEqual(unavailable, {
    kind: "unavailable",
    source: "provider",
  });

  const stale = await resetDaytonaSandboxForCancellation(
    { kind: "runner-operator" },
    dispatchAuthority,
    {
      daytona: {
        create: () => Promise.reject(new Error("must not create")),
        get: () => Promise.reject(new Error("must not resolve")),
      },
      store: store({
        beginDaytonaSandboxResetForCancellation: async () => ({
          kind: "stale_version" as const,
        }),
      }),
    }
  );
  assert.deepEqual(stale, { kind: "stale_version" });
});

test("only Daytona-reported recoverable errors call recover", async () => {
  let recoveries = 0;
  await ensureDaytonaSandbox(
    principal,
    agent({ daytonaSandboxId: "stored", sandboxLifecycle: "ready" }),
    config,
    {
      daytona: {
        create: () => Promise.reject(new Error("must not create")),
        get: () => {
          const value = Object.assign(
            sandbox(SandboxState.ERROR, {
              recover: () => {
                recoveries += 1;
                return Promise.resolve();
              },
            }),
            { recoverable: true }
          );
          return Promise.resolve(value);
        },
      },
      store: store({}),
    }
  );
  assert.equal(recoveries, 1);
});

test("only started sandboxes are ready; Daytona lifecycle methods handle every other state", async () => {
  const starts = [
    SandboxState.STOPPED,
    SandboxState.ARCHIVED,
    SandboxState.PAUSED,
  ];
  const waits = [
    SandboxState.CREATING,
    SandboxState.RESTORING,
    SandboxState.STARTING,
    SandboxState.PENDING_BUILD,
    SandboxState.BUILDING_SNAPSHOT,
    SandboxState.PULLING_SNAPSHOT,
    SandboxState.SNAPSHOTTING,
    SandboxState.FORKING,
    SandboxState.RESUMING,
    SandboxState.UNKNOWN,
    SandboxState.UNKNOWN_DEFAULT_OPEN_API,
  ];
  const available = agent({
    daytonaSandboxId: "stored",
    sandboxLifecycle: "ready",
  });

  let startedCalls = 0;
  await ensureDaytonaSandbox(principal, available, config, {
    daytona: {
      create: () => Promise.reject(new Error("must not create")),
      get: () =>
        Promise.resolve(
          sandbox(SandboxState.STARTED, {
            start: () => {
              startedCalls += 1;
              return Promise.resolve();
            },
            waitUntilStarted: () => {
              startedCalls += 1;
              return Promise.resolve();
            },
          })
        ),
    },
    store: store({}),
  });
  assert.equal(startedCalls, 0);

  await Promise.all(
    starts.map(async (state) => {
      let startCalls = 0;
      let waitCalls = 0;
      await ensureDaytonaSandbox(principal, available, config, {
        daytona: {
          create: () => Promise.reject(new Error("must not create")),
          get: () =>
            Promise.resolve(
              sandbox(state, {
                start: () => {
                  startCalls += 1;
                  return Promise.resolve();
                },
                waitUntilStarted: () => {
                  waitCalls += 1;
                  return Promise.resolve();
                },
              })
            ),
        },
        store: store({}),
      });
      assert.equal(startCalls, 1);
      assert.equal(waitCalls, 0);
    })
  );

  await Promise.all(
    waits.map(async (state) => {
      let waitCalls = 0;
      await ensureDaytonaSandbox(principal, available, config, {
        daytona: {
          create: () => Promise.reject(new Error("must not create")),
          get: () =>
            Promise.resolve(
              sandbox(state, {
                waitUntilStarted: () => {
                  waitCalls += 1;
                  return Promise.resolve();
                },
              })
            ),
        },
        store: store({}),
      });
      assert.equal(waitCalls, 1);
    })
  );

  await Promise.all(
    (
      [
        [SandboxState.DESTROYED, false],
        [SandboxState.DESTROYING, true],
        [SandboxState.ERROR, false],
        [SandboxState.BUILD_FAILED, false],
      ] as const
    ).map(([state, retryable]) =>
      assert.rejects(
        ensureDaytonaSandbox(principal, available, config, {
          daytona: {
            create: () => Promise.reject(new Error("must not create")),
            get: () => Promise.resolve(sandbox(state)),
          },
          store: store({}),
        }),
        (error: unknown) =>
          error instanceof Error &&
          classifyDaytonaProviderError(error) ===
            (retryable ? "retryable" : "non_retryable")
      )
    )
  );
});

test("a resizing sandbox completes its resize before starting", async () => {
  const available = agent({
    daytonaSandboxId: "stored",
    sandboxLifecycle: "ready",
  });
  let resizeWaits = 0;
  let starts = 0;
  let startedWaits = 0;
  const resolved = sandbox(SandboxState.RESIZING, {
    start: () => {
      starts += 1;
      return Promise.resolve();
    },
    waitForResizeComplete: () => {
      resizeWaits += 1;
      resolved.state = SandboxState.STOPPED;
      return Promise.resolve();
    },
    waitUntilStarted: () => {
      startedWaits += 1;
      return Promise.resolve();
    },
  });

  await ensureDaytonaSandbox(principal, available, config, {
    daytona: {
      create: () => Promise.reject(new Error("must not create")),
      get: () => Promise.resolve(resolved),
    },
    store: store({}),
  });

  assert.equal(resizeWaits, 1);
  assert.equal(starts, 1);
  assert.equal(startedWaits, 0);
});

test("shutdown transitions refresh to every stable startable state before starting", async () => {
  const available = agent({
    daytonaSandboxId: "stored",
    sandboxLifecycle: "ready",
  });
  const transitions = [
    SandboxState.STOPPING,
    SandboxState.ARCHIVING,
    SandboxState.PAUSING,
  ] as const;
  const stableStates = [
    SandboxState.STOPPED,
    SandboxState.ARCHIVED,
    SandboxState.PAUSED,
  ] as const;

  await Promise.all(
    transitions.flatMap((transition) =>
      stableStates.map(async (stable) => {
        let refreshes = 0;
        let starts = 0;
        let waits = 0;
        const resolved = sandbox(transition, {
          refreshData: () => {
            refreshes += 1;
            resolved.state = stable;
            return Promise.resolve();
          },
          start: () => {
            starts += 1;
            assert.equal(resolved.state, stable);
            return Promise.resolve();
          },
          waitUntilStarted: () => {
            waits += 1;
            return Promise.resolve();
          },
        });
        await ensureDaytonaSandbox(principal, available, config, {
          daytona: {
            create: () => Promise.reject(new Error("must not create")),
            get: () => Promise.resolve(resolved),
          },
          lifecycle: {
            sleep: () => Promise.reject(new Error("must not sleep")),
          },
          store: store({}),
        });
        assert.equal(refreshes, 1);
        assert.equal(starts, 1);
        assert.equal(waits, 0);
      })
    )
  );
});

test("a shutdown transition that reaches started returns without starting again", async () => {
  const available = agent({
    daytonaSandboxId: "stored",
    sandboxLifecycle: "ready",
  });
  let starts = 0;
  let waits = 0;
  const resolved = sandbox(SandboxState.STOPPING, {
    refreshData: () => {
      resolved.state = SandboxState.STARTED;
      return Promise.resolve();
    },
    start: () => {
      starts += 1;
      return Promise.resolve();
    },
    waitUntilStarted: () => {
      waits += 1;
      return Promise.resolve();
    },
  });

  await ensureDaytonaSandbox(principal, available, config, {
    daytona: {
      create: () => Promise.reject(new Error("must not create")),
      get: () => Promise.resolve(resolved),
    },
    store: store({}),
  });
  assert.equal(starts, 0);
  assert.equal(waits, 0);
});

test("timed out shutdown transitions return retryable lifecycle errors", async () => {
  const available = agent({
    daytonaSandboxId: "stored",
    sandboxLifecycle: "ready",
  });
  let now = 0;
  let refreshes = 0;
  const resolved = sandbox(SandboxState.ARCHIVING, {
    refreshData: () => {
      refreshes += 1;
      return Promise.resolve();
    },
  });

  await assert.rejects(
    ensureDaytonaSandbox(principal, available, config, {
      daytona: {
        create: () => Promise.reject(new Error("must not create")),
        get: () => Promise.resolve(resolved),
      },
      lifecycle: {
        now: () => now,
        sleep: (milliseconds) => {
          now += milliseconds;
          return Promise.resolve();
        },
        transitionTimeoutMs: 2000,
      },
      store: store({}),
    }),
    (error: unknown) =>
      error instanceof DaytonaSandboxLifecycleError &&
      error.retryable === true &&
      /did not finish/u.test(error.message)
  );
  assert.equal(refreshes, 2);
});

test("terminal shutdown transition failures are explicitly non-retryable", async () => {
  const available = agent({
    daytonaSandboxId: "stored",
    sandboxLifecycle: "ready",
  });
  await Promise.all(
    (
      [
        [SandboxState.ERROR, /shutdown transition failed/u],
        [SandboxState.DESTROYED, /was destroyed during shutdown/u],
      ] as const
    ).map(async ([terminal, message]) => {
      const resolved = sandbox(SandboxState.PAUSING, {
        refreshData: () => {
          resolved.state = terminal;
          return Promise.resolve();
        },
      });

      await assert.rejects(
        ensureDaytonaSandbox(principal, available, config, {
          daytona: {
            create: () => Promise.reject(new Error("must not create")),
            get: () => Promise.resolve(resolved),
          },
          store: store({}),
        }),
        (error: unknown) =>
          error instanceof DaytonaSandboxLifecycleError &&
          error.retryable === false &&
          message.test(error.message)
      );
    })
  );
});

test("stale provisioning refuses a deterministic sandbox from the previous generation", async () => {
  const stale = agent({
    sandboxGeneration: 4,
    sandboxLifecycle: "provisioning",
    sandboxUpdatedAt: new Date("2025-12-31T23:50:00.000Z"),
    version: 8,
  });
  const reserved = agent({
    ...stale,
    sandboxGeneration: 5,
    sandboxUpdatedAt: new Date(),
    version: 9,
  });
  const resetting = agent({
    ...reserved,
    sandboxGeneration: 6,
    sandboxLifecycle: "resetting",
    version: 10,
  });
  const reset = agent({
    ...resetting,
    sandboxLifecycle: "unprovisioned",
    version: 11,
  });
  const replacementReservation = agent({
    ...reset,
    sandboxGeneration: 7,
    sandboxLifecycle: "provisioning",
    version: 12,
  });
  const currentConfiguration = {
    ...config,
    configurationId: "current-configuration",
  };
  const calls: string[] = [];
  const existing = Object.assign(
    sandbox(SandboxState.STARTED, {
      delete: () => {
        calls.push("delete");
        return Promise.resolve();
      },
      start: () => {
        calls.push("stale-start");
        return Promise.resolve();
      },
    }),
    {
      labels: {
        ...daytonaSandboxLabels(principal.tenant, stale.id),
        configurationId: currentConfiguration.configurationId,
        sandboxGeneration: String(stale.sandboxGeneration),
      },
    }
  );
  const replacement = Object.assign(sandbox(SandboxState.STARTED), {
    id: "replacement",
    labels: {
      ...daytonaSandboxLabels(principal.tenant, stale.id),
      configurationId: currentConfiguration.configurationId,
      sandboxGeneration: String(replacementReservation.sandboxGeneration),
    },
  });
  const attached = agent({
    ...replacementReservation,
    daytonaSandboxId: replacement.id,
    sandboxLifecycle: "ready",
    version: 13,
  });
  let lookups = 0;
  let reservations = 0;
  const result = await ensureDaytonaSandbox(
    principal,
    stale,
    currentConfiguration,
    {
      daytona: {
        create: (parameters) => {
          calls.push("create");
          assert.equal(
            parameters.labels?.sandboxGeneration,
            String(replacementReservation.sandboxGeneration)
          );
          return Promise.resolve(replacement);
        },
        get: (identifier) => {
          calls.push("get");
          assert.equal(
            identifier,
            daytonaSandboxName(principal.tenant, stale.id)
          );
          lookups += 1;
          return lookups === 1
            ? Promise.resolve(existing)
            : Promise.reject(new DaytonaNotFoundError("deleted"));
        },
      },
      store: store({
        attachDaytonaSandbox: () => {
          calls.push("attach");
          return Promise.resolve({ kind: "updated" as const, value: attached });
        },
        beginDaytonaSandboxReset: () =>
          Promise.resolve({ kind: "updated" as const, value: resetting }),
        finishDaytonaSandboxReset: () =>
          Promise.resolve({ kind: "updated" as const, value: reset }),
        reserveDaytonaSandbox: (
          _principal: unknown,
          input: { provisioningStaleBefore: Date }
        ) => {
          assert.ok(input.provisioningStaleBefore > stale.sandboxUpdatedAt);
          reservations += 1;
          return Promise.resolve({
            kind: "reserved" as const,
            value: reservations === 1 ? reserved : replacementReservation,
          });
        },
      }),
    }
  );
  assert.equal(result.agent, attached);
  assert.equal(result.sandbox, replacement);
  assert.deepEqual(calls, ["get", "delete", "get", "create", "attach"]);
  assert.equal(calls.includes("stale-start"), false);
});

test("an attach-loss leaves a reconciled sandbox intact", async () => {
  const reserved = agent({
    sandboxGeneration: 1,
    sandboxLifecycle: "provisioning",
    version: 1,
  });
  const currentConfiguration = {
    ...config,
    configurationId: "current-configuration",
  };
  let deletes = 0;
  const existing = Object.assign(
    sandbox(SandboxState.STARTED, {
      delete: () => {
        deletes += 1;
        return Promise.resolve();
      },
    }),
    {
      labels: {
        ...daytonaSandboxLabels(principal.tenant, reserved.id),
        configurationId: currentConfiguration.configurationId,
        sandboxGeneration: String(reserved.sandboxGeneration),
      },
    }
  );
  await assert.rejects(
    ensureDaytonaSandbox(principal, agent(), currentConfiguration, {
      daytona: {
        create: () => Promise.reject(new Error("must not create")),
        get: () => Promise.resolve(existing),
      },
      store: store({
        attachDaytonaSandbox: () => Promise.resolve({ kind: "stale_version" }),
        reserveDaytonaSandbox: () =>
          Promise.resolve({ kind: "reserved" as const, value: reserved }),
      }),
    }),
    /generation changed/u
  );
  assert.equal(deletes, 0);
});

test("a provider-not-found stored ID fences a replacement before persisting it", async () => {
  const stale = agent({
    daytonaSandboxId: "missing",
    sandboxGeneration: 4,
    sandboxLifecycle: "ready",
    version: 8,
  });
  const reserved = agent({
    daytonaSandboxId: null,
    sandboxGeneration: 5,
    sandboxLifecycle: "provisioning",
    version: 9,
  });
  let createParameters: DaytonaSandboxCreateParameters | undefined;
  const result = await ensureDaytonaSandbox(principal, stale, config, {
    daytona: {
      create: (parameters) => {
        createParameters = parameters;
        return Promise.resolve(sandbox(SandboxState.STARTED));
      },
      get: () => Promise.reject(new DaytonaNotFoundError("gone")),
    },
    store: store({
      attachDaytonaSandbox: (
        _principal: unknown,
        input: Record<string, unknown>
      ) => {
        assert.equal(input.expectedGeneration, 5);
        assert.equal(input.expectedVersion, 9);
        return Promise.resolve({
          kind: "updated",
          value: agent({
            daytonaSandboxId: "sandbox-id",
            sandboxGeneration: 5,
            sandboxLifecycle: "ready",
            version: 10,
          }),
        });
      },
      reserveDaytonaSandbox: (
        _principal: unknown,
        input: Record<string, unknown>
      ) => {
        assert.equal(input.expectedSandboxId, "missing");
        return Promise.resolve({ kind: "reserved", value: reserved });
      },
    }),
  });
  assert.equal(result.agent.daytonaSandboxId, "sandbox-id");
  assert.deepEqual(createParameters, {
    autoArchiveInterval: config.autoArchiveInterval,
    autoDeleteInterval: -1,
    autoPauseInterval: 0,
    autoStopInterval: config.autoStopInterval,
    ephemeral: false,
    labels: {
      ...daytonaSandboxLabels(principal.tenant, reserved.id),
      sandboxGeneration: String(reserved.sandboxGeneration),
    },
    language: "python",
    name: daytonaSandboxName(principal.tenant, reserved.id),
    public: false,
    snapshot: config.snapshotName,
    ttlMinutes: 0,
  });
  assert.equal(
    JSON.stringify(createParameters).includes(principal.tenant),
    false
  );
});

test("a stale generation leaves its deterministic replacement intact", async () => {
  let deletes = 0;
  const created = sandbox(SandboxState.STARTED, {
    delete: () => {
      deletes += 1;
      return Promise.resolve();
    },
  });
  await assert.rejects(
    ensureDaytonaSandbox(principal, agent(), config, {
      daytona: {
        create: () => Promise.resolve(created),
        get: () => Promise.reject(new DaytonaNotFoundError("missing")),
      },
      store: store({
        attachDaytonaSandbox: () => Promise.resolve({ kind: "stale_version" }),
        reserveDaytonaSandbox: () =>
          Promise.resolve({
            kind: "reserved",
            value: agent({
              sandboxGeneration: 1,
              sandboxLifecycle: "provisioning",
              version: 1,
            }),
          }),
      }),
    }),
    /generation changed/u
  );
  assert.equal(deletes, 0);
});

test("an unconfirmed created-sandbox attach reports retryable cleanup needed", async () => {
  let deletes = 0;
  const created = sandbox(SandboxState.STARTED, {
    delete: () => {
      deletes += 1;
      return Promise.resolve();
    },
  });

  await assert.rejects(
    ensureDaytonaSandbox(principal, agent(), config, {
      daytona: {
        create: () => Promise.resolve(created),
        get: () => Promise.reject(new DaytonaNotFoundError("missing")),
      },
      store: store({
        attachDaytonaSandbox: () => Promise.reject(new Error("store outage")),
        reserveDaytonaSandbox: () =>
          Promise.resolve({
            kind: "reserved" as const,
            value: agent({
              sandboxGeneration: 1,
              sandboxLifecycle: "provisioning",
              version: 1,
            }),
          }),
      }),
    }),
    (error: unknown) =>
      error instanceof DaytonaSandboxLifecycleError &&
      error.kind === "cleanup_needed" &&
      error.retryable
  );
  assert.equal(deletes, 0);
});

test("an older creator cannot delete a sandbox adopted by a newer generation", async () => {
  const oldReservation = agent({
    sandboxGeneration: 1,
    sandboxLifecycle: "provisioning",
    version: 1,
  });
  const newReservation = agent({
    ...oldReservation,
    sandboxGeneration: 2,
    version: 2,
  });
  const resetting = agent({
    ...newReservation,
    sandboxGeneration: 3,
    sandboxLifecycle: "resetting",
    version: 3,
  });
  const reset = agent({
    ...resetting,
    sandboxLifecycle: "unprovisioned",
    version: 4,
  });
  const replacementReservation = agent({
    ...reset,
    sandboxGeneration: 4,
    sandboxLifecycle: "provisioning",
    version: 5,
  });
  const adopted = agent({
    ...replacementReservation,
    daytonaSandboxId: "replacement",
    sandboxLifecycle: "ready",
    version: 6,
  });
  let attachCalls = 0;
  let deletes = 0;
  let signalOldAttach!: () => void;
  let releaseOldAttach!: () => void;
  const oldAttachReached = new Promise<void>((resolve) => {
    signalOldAttach = resolve;
  });
  const oldAttach = new Promise<{ kind: "stale_version" }>((resolve) => {
    releaseOldAttach = () => resolve({ kind: "stale_version" });
  });
  const currentConfiguration = {
    ...config,
    configurationId: "current-configuration",
  };
  const created = Object.assign(
    sandbox(SandboxState.STARTED, {
      delete: () => {
        deletes += 1;
        return Promise.resolve();
      },
    }),
    {
      labels: {
        ...daytonaSandboxLabels(principal.tenant, oldReservation.id),
        configurationId: currentConfiguration.configurationId,
        sandboxGeneration: String(oldReservation.sandboxGeneration),
      },
    }
  );
  const replacement = Object.assign(sandbox(SandboxState.STARTED), {
    id: "replacement",
    labels: {
      ...daytonaSandboxLabels(principal.tenant, newReservation.id),
      configurationId: currentConfiguration.configurationId,
      sandboxGeneration: String(replacementReservation.sandboxGeneration),
    },
  });
  const providerLookups = [
    Promise.reject(new DaytonaNotFoundError("missing")),
    Promise.resolve(created),
    Promise.reject(new DaytonaNotFoundError("deleted")),
  ];
  let reserveCalls = 0;
  const lifecycleStore = store({
    attachDaytonaSandbox: () => {
      attachCalls += 1;
      signalOldAttach();
      return attachCalls === 1
        ? oldAttach
        : Promise.resolve({ kind: "updated" as const, value: adopted });
    },
    beginDaytonaSandboxReset: () =>
      Promise.resolve({ kind: "updated" as const, value: resetting }),
    finishDaytonaSandboxReset: () =>
      Promise.resolve({ kind: "updated" as const, value: reset }),
    reserveDaytonaSandbox: () => {
      reserveCalls += 1;
      return Promise.resolve({
        kind: "reserved" as const,
        value:
          reserveCalls === 1
            ? oldReservation
            : reserveCalls === 2
              ? newReservation
              : replacementReservation,
      });
    },
  });

  const old = ensureDaytonaSandbox(principal, agent(), currentConfiguration, {
    daytona: {
      create: () => Promise.resolve(created),
      get: () => providerLookups.shift() as Promise<Sandbox>,
    },
    store: lifecycleStore,
  });
  await oldAttachReached;
  const newer = await ensureDaytonaSandbox(
    principal,
    oldReservation,
    currentConfiguration,
    {
      daytona: {
        create: () => Promise.resolve(replacement),
        get: () => providerLookups.shift() as Promise<Sandbox>,
      },
      store: lifecycleStore,
    }
  );
  releaseOldAttach();
  await assert.rejects(old, /generation changed/u);

  assert.equal(deletes, 1);
  assert.equal(newer.agent.daytonaSandboxId, replacement.id);
  assert.equal(
    newer.agent.sandboxGeneration,
    replacementReservation.sandboxGeneration
  );
});

test("warming probes only the sandbox and persists success or failure through fences", async () => {
  const current = agent({
    daytonaSandboxId: "stored",
    sandboxLifecycle: "ready",
    version: 4,
  });
  const warming = agent({ ...current, version: 5, warmStatus: "provisioning" });
  const completed = agent({ ...warming, version: 6, warmStatus: "ready" });
  const calls: string[] = [];
  let probeSessionId = "";
  const success = await warmDaytonaSandbox(principal, current, config, {
    daytona: {
      create: () => Promise.reject(new Error("no create")),
      get: () => Promise.resolve(sandbox(SandboxState.STARTED)),
    },
    probe: (value, _signal, _timeoutSeconds, sessionId) => {
      calls.push(value.id);
      probeSessionId = sessionId ?? "";
      return Promise.resolve();
    },
    store: store({
      beginDaytonaSandboxWarm: () =>
        Promise.resolve({
          kind: "started",
          value: warming,
        }),
      finishDaytonaSandboxWarm: (
        _p: unknown,
        input: { status: "failed" | "ready" }
      ) => {
        assert.equal(input.status, "ready");
        return Promise.resolve({ kind: "updated", value: completed });
      },
    }),
  });
  assert.equal(success.kind, "ready");
  assert.deepEqual(calls, ["sandbox-id"]);
  assert.equal(
    probeSessionId,
    daytonaProbeSessionName(
      warming.id,
      warming.sandboxGeneration,
      warming.warmAttemptVersion,
      warming.warmUpdatedAt
    )
  );

  let failed = false;
  const failure = await warmDaytonaSandbox(principal, current, config, {
    daytona: {
      create: () => Promise.reject(new Error("no create")),
      get: () => Promise.resolve(sandbox(SandboxState.STARTED)),
    },
    probe: () => Promise.reject(new DaytonaTimeoutError("timeout")),
    store: store({
      beginDaytonaSandboxWarm: () =>
        Promise.resolve({
          kind: "started",
          value: warming,
        }),
      finishDaytonaSandboxWarm: (
        _p: unknown,
        input: { status: "failed" | "ready" }
      ) => {
        failed = input.status === "failed";
        return Promise.resolve({
          kind: "updated",
          value: agent({ ...warming, warmStatus: "failed" }),
        });
      },
    }),
  });
  assert.deepEqual(failure, { error: "retryable", kind: "failed" });
  assert.equal(failed, true);
});

test("successful probe work with unconfirmed cleanup remains durably provisioning", async () => {
  const current = agent({
    daytonaSandboxId: "stored",
    sandboxLifecycle: "ready",
    version: 4,
  });
  const warming = agent({ ...current, version: 5, warmStatus: "provisioning" });
  let finishes = 0;
  const providerSandbox = {
    ...sandbox(SandboxState.STARTED),
    process: {
      createSession: () => Promise.resolve(),
      deleteSession: () => new Promise(() => undefined),
      executeCommand: () =>
        Promise.reject(new Error("prewarm probe must use a session")),
      executeSessionCommand: () =>
        Promise.resolve({
          cmdId: "probe-command",
          exitCode: 0,
          stdout: "1.0.0",
        }),
      getSessionCommand: () => Promise.resolve({}),
      getSessionCommandLogs: () => Promise.resolve({}),
      listSessions: () => new Promise(() => undefined),
    },
  } as unknown as Sandbox;
  const result = await warmDaytonaSandbox(principal, current, config, {
    daytona: {
      create: () => Promise.reject(new Error("must not create")),
      get: () => Promise.resolve(providerSandbox),
    },
    lifecycle: {
      deadline: Date.now() + 5,
      signal: new AbortController().signal,
    },
    probe: (value, signal, timeoutSeconds, sessionId) =>
      probeDaytonaHarnesses(value, {
        deadline: Date.now() + 5,
        sessionId,
        signal,
        timeoutSeconds,
      }).then(() => undefined),
    store: store({
      beginDaytonaSandboxWarm: () =>
        Promise.resolve({ kind: "started", value: warming }),
      finishDaytonaSandboxWarm: () => {
        finishes += 1;
        return Promise.resolve({
          kind: "updated",
          value: agent({ ...warming, version: 6, warmStatus: "ready" }),
        });
      },
    }),
  });

  assert.deepEqual(result, { agent: warming, kind: "in_progress" });
  assert.equal(finishes, 0);
});

test("an aborted warm propagates to the probe and releases its durable warm fence", async () => {
  const current = agent({
    daytonaSandboxId: "stored",
    sandboxLifecycle: "ready",
    version: 4,
  });
  const warming = agent({ ...current, version: 5, warmStatus: "provisioning" });
  const controller = new AbortController();
  const statuses: string[] = [];
  const sessions = new Set<string>();
  let probeStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    probeStarted = resolve;
  });
  let probeDeletes = 0;
  const providerSandbox = {
    ...sandbox(SandboxState.STARTED),
    process: {
      createSession: (sessionId: string) => {
        sessions.add(sessionId);
        return Promise.resolve();
      },
      deleteSession: (sessionId: string) => {
        probeDeletes += 1;
        sessions.delete(sessionId);
        return Promise.resolve();
      },
      executeCommand: () =>
        Promise.reject(new Error("prewarm probe must use a session")),
      executeSessionCommand: () => {
        probeStarted();
        return new Promise(() => undefined);
      },
      getSessionCommand: () => Promise.resolve({}),
      getSessionCommandLogs: () => Promise.resolve({}),
      listSessions: () =>
        Promise.resolve(
          [...sessions].map((sessionId) => ({ commands: [], sessionId }))
        ),
    },
  } as unknown as Sandbox;

  const pending = warmDaytonaSandbox(principal, current, config, {
    daytona: {
      create: () => Promise.reject(new Error("must not create")),
      get: () => Promise.resolve(providerSandbox),
    },
    lifecycle: {
      deadline: Date.now() + 5000,
      signal: controller.signal,
    },
    probe: (value, signal, timeoutSeconds, sessionId) =>
      probeDaytonaHarnesses(value, { sessionId, signal, timeoutSeconds }).then(
        () => undefined
      ),
    store: store({
      beginDaytonaSandboxWarm: () =>
        Promise.resolve({ kind: "started", value: warming }),
      finishDaytonaSandboxWarm: (
        _p: unknown,
        input: { status: "failed" | "ready" }
      ) => {
        statuses.push(input.status);
        return Promise.resolve({
          kind: "updated",
          value: agent({ ...warming, warmStatus: input.status }),
        });
      },
    }),
  });

  await started;
  controller.abort(new Error("prewarm deadline exceeded"));
  const result = await settlesWithin(pending);

  assert.equal(probeDeletes, 1);
  assert.equal(sessions.size, 0);
  assert.deepEqual(statuses, ["failed"]);
  assert.deepEqual(result, { error: "retryable", kind: "failed" });
});

test("an aborted warm stays recoverable when probe and fence cleanup never return", async () => {
  const current = agent({
    daytonaSandboxId: "stored",
    sandboxLifecycle: "ready",
    version: 4,
  });
  const warming = agent({ ...current, version: 5, warmStatus: "provisioning" });
  const controller = new AbortController();
  const deadline = Date.now() + 5;
  let probeStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    probeStarted = resolve;
  });
  let finishes = 0;
  const providerSandbox = {
    ...sandbox(SandboxState.STARTED),
    process: {
      createSession: () => Promise.resolve(),
      deleteSession: () => new Promise(() => undefined),
      executeCommand: () =>
        Promise.reject(new Error("prewarm probe must use a session")),
      executeSessionCommand: () => {
        probeStarted();
        return new Promise(() => undefined);
      },
      getSessionCommand: () => Promise.resolve({}),
      getSessionCommandLogs: () => Promise.resolve({}),
      listSessions: () => new Promise(() => undefined),
    },
  } as unknown as Sandbox;

  const pending = warmDaytonaSandbox(principal, current, config, {
    daytona: {
      create: () => Promise.reject(new Error("must not create")),
      get: () => Promise.resolve(providerSandbox),
    },
    lifecycle: {
      deadline,
      signal: controller.signal,
    },
    probe: (value, signal, timeoutSeconds, sessionId) =>
      probeDaytonaHarnesses(value, {
        deadline,
        sessionId,
        signal,
        timeoutSeconds,
      }).then(() => undefined),
    store: store({
      beginDaytonaSandboxWarm: () =>
        Promise.resolve({ kind: "started", value: warming }),
      finishDaytonaSandboxWarm: (
        _p: unknown,
        _input: { status: "failed" | "ready" }
      ) => {
        finishes += 1;
        return new Promise(() => undefined);
      },
    }),
  });

  await started;
  controller.abort(new Error("prewarm deadline exceeded"));
  const result = await settlesWithin(pending);

  assert.deepEqual(result, { agent: warming, kind: "in_progress" });
  assert.equal(finishes, 0);
  assert.equal(warming.warmStatus, "provisioning");
});

test("aborting provider lookup releases provisioning and prevents post-timeout continuation", async () => {
  const reserved = agent({
    sandboxGeneration: 1,
    sandboxLifecycle: "provisioning",
    version: 1,
  });
  const controller = new AbortController();
  let releaseLookup!: (value: Sandbox) => void;
  let lookupStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    lookupStarted = resolve;
  });
  const lookup = new Promise<Sandbox>((resolve) => {
    releaseLookup = resolve;
  });
  let attachCalls = 0;
  let beginWarmCalls = 0;
  let createCalls = 0;
  let failCalls = 0;

  const pending = warmDaytonaSandbox(principal, agent(), config, {
    daytona: {
      create: () => {
        createCalls += 1;
        return Promise.reject(new Error("must not create"));
      },
      get: () => {
        lookupStarted();
        return lookup;
      },
    },
    lifecycle: {
      deadline: Date.now() + 5000,
      signal: controller.signal,
    },
    probe: () => Promise.resolve(),
    store: store({
      attachDaytonaSandbox: () => {
        attachCalls += 1;
        return Promise.resolve({ kind: "updated", value: reserved });
      },
      beginDaytonaSandboxWarm: () => {
        beginWarmCalls += 1;
        return Promise.resolve({ kind: "in_progress", value: reserved });
      },
      failDaytonaSandboxReservation: () => {
        failCalls += 1;
        return Promise.resolve({
          kind: "updated",
          value: agent({ sandboxLifecycle: "unprovisioned", version: 2 }),
        });
      },
      reserveDaytonaSandbox: () =>
        Promise.resolve({ kind: "reserved", value: reserved }),
    }),
  });

  await started;
  controller.abort(new Error("prewarm deadline exceeded"));
  releaseLookup(sandbox(SandboxState.STARTED));
  const result = await pending;
  await Promise.resolve();

  assert.deepEqual(result, { error: "retryable", kind: "failed" });
  assert.equal(failCalls, 1);
  assert.equal(attachCalls, 0);
  assert.equal(beginWarmCalls, 0);
  assert.equal(createCalls, 0);
});

test("aborting an ambiguous provider create fences reconciliation and prevents attachment", async () => {
  const reserved = agent({
    sandboxGeneration: 1,
    sandboxLifecycle: "provisioning",
    version: 1,
  });
  const ambiguous = agent({
    ...reserved,
    sandboxLifecycle: "provisioning_ambiguous",
    version: 2,
  });
  const controller = new AbortController();
  let createStarted!: () => void;
  let releaseCreate!: (value: Sandbox) => void;
  const started = new Promise<void>((resolve) => {
    createStarted = resolve;
  });
  const create = new Promise<Sandbox>((resolve) => {
    releaseCreate = resolve;
  });
  let attachCalls = 0;
  let failCalls = 0;
  let markAmbiguousCalls = 0;

  const pending = warmDaytonaSandbox(principal, agent(), config, {
    daytona: {
      create: () => {
        createStarted();
        return create;
      },
      get: () => Promise.reject(new DaytonaNotFoundError("absent")),
    },
    lifecycle: {
      deadline: Date.now() + 5000,
      signal: controller.signal,
    },
    probe: () => Promise.resolve(),
    store: store({
      attachDaytonaSandbox: () => {
        attachCalls += 1;
        return Promise.resolve({ kind: "updated", value: ambiguous });
      },
      failDaytonaSandboxReservation: () => {
        failCalls += 1;
        return Promise.resolve({ kind: "updated", value: agent() });
      },
      markDaytonaSandboxReservationAmbiguous: () => {
        markAmbiguousCalls += 1;
        return Promise.resolve({ kind: "updated", value: ambiguous });
      },
      reserveDaytonaSandbox: () =>
        Promise.resolve({ kind: "reserved", value: reserved }),
    }),
  });

  await started;
  controller.abort(new Error("prewarm deadline exceeded"));
  const result = await pending;
  releaseCreate(sandbox(SandboxState.STARTED));
  await Promise.resolve();

  assert.deepEqual(result, { error: "retryable", kind: "failed" });
  assert.equal(markAmbiguousCalls, 1);
  assert.equal(failCalls, 0);
  assert.equal(attachCalls, 0);
});

test("warm errors preserve a lifecycle error's retryability", async () => {
  const result = await warmDaytonaSandbox(
    principal,
    agent({ sandboxLifecycle: "decommissioning" }),
    config,
    {
      daytona: {
        create: () => Promise.reject(new Error("must not create")),
        get: () => Promise.reject(new Error("must not get")),
      },
      probe: () => Promise.resolve(),
      store: store({}),
    }
  );
  assert.deepEqual(result, { error: "retryable", kind: "failed" });
});

test("warming preserves store concurrency outcomes and their current records", async () => {
  const current = agent({
    daytonaSandboxId: "stored",
    sandboxLifecycle: "ready",
    version: 4,
  });
  const provisioning = agent({
    ...current,
    version: 5,
    warmStatus: "provisioning",
  });
  const outcomes = [
    [
      { kind: "in_progress", value: provisioning },
      { agent: provisioning, kind: "in_progress" },
    ],
    [{ kind: "not_found" }, { kind: "not_found" }],
    [{ kind: "stale_version" }, { kind: "stale_version" }],
  ] as const;

  await Promise.all(
    outcomes.map(async ([storeResult, expected]) => {
      const result = await warmDaytonaSandbox(principal, current, config, {
        daytona: {
          create: () => Promise.reject(new Error("must not create")),
          get: () => Promise.resolve(sandbox(SandboxState.STARTED)),
        },
        probe: () => Promise.resolve(),
        store: store({
          beginDaytonaSandboxWarm: async () => storeResult as never,
        }),
      });
      assert.deepEqual(result, expected);
    })
  );
});

test("warming distinguishes durable-store failure from provider rejection", async () => {
  const result = await warmDaytonaSandbox(
    principal,
    agent({ sandboxLifecycle: "unprovisioned" }),
    config,
    {
      daytona: {
        create: () => Promise.reject(new Error("must not create")),
        get: () => Promise.reject(new Error("must not get")),
      },
      probe: () => Promise.resolve(),
      store: store({
        reserveDaytonaSandbox: () =>
          Promise.reject(new Error("database=private-detail")),
      }),
    }
  );

  assert.deepEqual(result, {
    kind: "unavailable",
    source: "database",
  });
});

test("decommissioning is durable until provider deletion or provider-not-found", async () => {
  const decommissioning = agent({
    daytonaSandboxId: "stored",
    sandboxGeneration: 3,
    sandboxLifecycle: "decommissioning",
    version: 6,
  });
  let deleteWait: boolean | undefined;
  const baseStore = {
    beginDaytonaSandboxDecommission: () =>
      Promise.resolve({
        kind: "decommissioning" as const,
        value: decommissioning,
      }),
    deleteDecommissionedAgent: () =>
      Promise.resolve({ kind: "deleted" as const }),
  };
  const success = await deleteDaytonaSandbox(principal, decommissioning.id, {
    daytona: {
      create: () => Promise.reject(new Error("no create")),
      get: () =>
        Promise.resolve(
          sandbox(SandboxState.STARTED, {
            delete: (_timeout, wait) => {
              deleteWait = wait;
              return Promise.resolve();
            },
          })
        ),
    },
    store: store(baseStore),
  });
  assert.deepEqual(success, { kind: "deleted" });
  assert.equal(deleteWait, true);

  const absent = await deleteDaytonaSandbox(principal, decommissioning.id, {
    daytona: {
      create: () => Promise.reject(new Error("no create")),
      get: () => Promise.reject(new DaytonaNotFoundError("gone")),
    },
    store: store(baseStore),
  });
  assert.deepEqual(absent, { kind: "deleted" });

  let persistedFailure = false;
  const retry = await deleteDaytonaSandbox(principal, decommissioning.id, {
    daytona: {
      create: () => Promise.reject(new Error("no create")),
      get: () => Promise.reject(new DaytonaTimeoutError("retry")),
    },
    store: store({
      beginDaytonaSandboxDecommission:
        baseStore.beginDaytonaSandboxDecommission,
      failDaytonaSandboxDecommission: () => {
        persistedFailure = true;
        return Promise.resolve({ kind: "updated", value: decommissioning });
      },
    }),
  });
  assert.deepEqual(retry, { error: "retryable", kind: "failed" });
  assert.equal(persistedFailure, false);
});

test("a durable decommission retries with the current sandbox fence after a crash", async () => {
  const recovered = agent({
    daytonaSandboxId: "sandbox-after-crash",
    sandboxGeneration: 7,
    sandboxLifecycle: "decommissioning",
    version: 12,
  });
  let fetchedId: string | undefined;
  let deleted = 0;
  let deletionFence: Record<string, unknown> | undefined;

  const result = await deleteDaytonaSandbox(principal, recovered.id, {
    daytona: {
      create: () => Promise.reject(new Error("no create")),
      get: (id) => {
        fetchedId = id;
        return Promise.resolve(
          sandbox(SandboxState.STARTED, {
            delete: () => {
              deleted += 1;
              return Promise.resolve();
            },
          })
        );
      },
    },
    store: store({
      beginDaytonaSandboxDecommission: () =>
        Promise.resolve({ kind: "decommissioning" as const, value: recovered }),
      deleteDecommissionedAgent: (
        _principal: unknown,
        input: Record<string, unknown>
      ) => {
        deletionFence = input;
        return Promise.resolve({ kind: "deleted" as const });
      },
    }),
  });

  assert.deepEqual(result, { kind: "deleted" });
  assert.equal(fetchedId, recovered.daytonaSandboxId);
  assert.equal(deleted, 1);
  assert.deepEqual(deletionFence, {
    agentId: recovered.id,
    expectedGeneration: 7,
    expectedVersion: 12,
  });
});

test("stale provisioning decommission reconciles the deterministic sandbox name", async () => {
  const decommissioning = agent({
    sandboxGeneration: 8,
    sandboxLifecycle: "decommissioning",
    version: 13,
  });
  let identifier: string | undefined;
  let deletes = 0;
  const result = await deleteDaytonaSandbox(principal, decommissioning.id, {
    daytona: {
      create: () => Promise.reject(new Error("must not create")),
      get: (value) => {
        identifier = value;
        return Promise.resolve(
          sandbox(SandboxState.STARTED, {
            delete: () => {
              deletes += 1;
              return Promise.resolve();
            },
          })
        );
      },
    },
    store: store({
      beginDaytonaSandboxDecommission: () =>
        Promise.resolve({
          kind: "decommissioning" as const,
          value: decommissioning,
        }),
      deleteDecommissionedAgent: () =>
        Promise.resolve({ kind: "deleted" as const }),
    }),
  });
  assert.deepEqual(result, { kind: "deleted" });
  assert.equal(
    identifier,
    daytonaSandboxName(principal.tenant, decommissioning.id)
  );
  assert.equal(deletes, 1);
});

test("a retryable decommission failure remains resumable for a later successful retry", async () => {
  const decommissioning = agent({
    daytonaSandboxId: "stored",
    sandboxGeneration: 5,
    sandboxLifecycle: "decommissioning",
    version: 10,
  });
  let attempts = 0;
  let deleted = 0;
  const dependencies = {
    daytona: {
      create: () => Promise.reject(new Error("no create")),
      get: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new DaytonaTimeoutError("retry"))
          : Promise.resolve(sandbox(SandboxState.STARTED));
      },
    },
    store: store({
      beginDaytonaSandboxDecommission: () =>
        Promise.resolve({
          kind: "decommissioning" as const,
          value: decommissioning,
        }),
      deleteDecommissionedAgent: () => {
        deleted += 1;
        return Promise.resolve({ kind: "deleted" as const });
      },
      failDaytonaSandboxDecommission: () =>
        Promise.reject(new Error("retryable failures must not transition")),
    }),
  };

  assert.deepEqual(
    await deleteDaytonaSandbox(principal, decommissioning.id, dependencies),
    { error: "retryable", kind: "failed" }
  );
  assert.deepEqual(
    await deleteDaytonaSandbox(principal, decommissioning.id, dependencies),
    { kind: "deleted" }
  );
  assert.equal(attempts, 2);
  assert.equal(deleted, 1);
});

test("concurrent decommission retries tolerate provider and database idempotency", async () => {
  const decommissioning = agent({
    daytonaSandboxId: "stored",
    sandboxGeneration: 3,
    sandboxLifecycle: "decommissioning",
    version: 6,
  });
  let providerDeletes = 0;
  let databaseDeletes = 0;
  const result = await Promise.all(
    [1, 2].map(() =>
      deleteDaytonaSandbox(principal, decommissioning.id, {
        daytona: {
          create: () => Promise.reject(new Error("no create")),
          get: () =>
            Promise.resolve(
              sandbox(SandboxState.STARTED, {
                delete: () => {
                  providerDeletes += 1;
                  return providerDeletes === 1
                    ? Promise.resolve()
                    : Promise.reject(new DaytonaNotFoundError("gone"));
                },
              })
            ),
        },
        store: store({
          beginDaytonaSandboxDecommission: () =>
            Promise.resolve({
              kind: "decommissioning" as const,
              value: decommissioning,
            }),
          deleteDecommissionedAgent: () => {
            databaseDeletes += 1;
            return Promise.resolve(
              databaseDeletes === 1
                ? { kind: "deleted" as const }
                : { kind: "not_found" as const }
            );
          },
        }),
      })
    )
  );

  assert.deepEqual(result, [{ kind: "deleted" }, { kind: "not_found" }]);
  assert.equal(providerDeletes, 2);
  assert.equal(databaseDeletes, 2);
});

test("non-retryable decommission failures persist the terminal lifecycle state", async () => {
  const decommissioning = agent({
    daytonaSandboxId: "stored",
    sandboxGeneration: 4,
    sandboxLifecycle: "decommissioning",
    version: 9,
  });
  let persistedFence: Record<string, unknown> | undefined;

  const result = await deleteDaytonaSandbox(principal, decommissioning.id, {
    daytona: {
      create: () => Promise.reject(new Error("no create")),
      get: () => Promise.reject(new Error("invalid provider request")),
    },
    store: store({
      beginDaytonaSandboxDecommission: () =>
        Promise.resolve({
          kind: "decommissioning" as const,
          value: decommissioning,
        }),
      failDaytonaSandboxDecommission: (
        _principal: unknown,
        input: Record<string, unknown>
      ) => {
        persistedFence = input;
        return Promise.resolve({
          kind: "updated" as const,
          value: agent({
            ...decommissioning,
            sandboxLifecycle: "decommission_failed",
            status: "error",
            warmStatus: "failed",
          }),
        });
      },
    }),
  });

  assert.deepEqual(result, { error: "non_retryable", kind: "failed" });
  assert.deepEqual(persistedFence, {
    agentId: decommissioning.id,
    expectedGeneration: 4,
    expectedVersion: 9,
  });
});

test("provider error classification separates absent, retryable, and permanent failures", () => {
  assert.equal(
    classifyDaytonaProviderError(new DaytonaNotFoundError("missing")),
    "not_found"
  );
  assert.equal(
    classifyDaytonaProviderError(new DaytonaTimeoutError("timeout")),
    "retryable"
  );
  assert.equal(
    classifyDaytonaProviderError(new Error("invalid")),
    "non_retryable"
  );
});

test("creation failures distinguish provider rejections from ambiguous outcomes", () => {
  assert.equal(
    classifyDaytonaSandboxCreateError(new DaytonaBadRequestError("invalid")),
    "definite_rejection"
  );
  assert.equal(
    classifyDaytonaSandboxCreateError(new DaytonaTimeoutError("timeout")),
    "ambiguous"
  );
  assert.equal(
    classifyDaytonaSandboxCreateError(new Error("opaque transport failure")),
    "ambiguous"
  );
});

test("production Daytona egress configuration is required and normalized", () => {
  const environment = {
    DAYTONA_API_KEY: "test-key",
    DAYTONA_DOMAIN_ALLOW_LIST: " GitHub.com,api.github.com,github.com ",
    DAYTONA_SNAPSHOT: "coven-agents-copilot-1",
    NODE_ENV: "production",
  } as NodeJS.ProcessEnv;
  assert.equal(
    daytonaSandboxConfiguration(environment).domainAllowList,
    "github.com,api.github.com"
  );
  assert.equal(daytonaSandboxConfiguration(environment).target, "us");
  for (const invalidValue of [
    undefined,
    "",
    "github.com,",
    "https://github.com",
    "github.com/path",
    "github.com:443",
  ]) {
    assert.throws(
      () =>
        daytonaSandboxConfiguration({
          ...environment,
          DAYTONA_DOMAIN_ALLOW_LIST: invalidValue,
        }),
      /DAYTONA_DOMAIN_ALLOW_LIST/u
    );
  }
});

test("sandbox configuration identity includes required GitHub gateway egress", () => {
  const environment = {
    APP_ORIGIN: "https://app.example",
    AUTH_URL: "https://app.example",
    DAYTONA_API_KEY: "test-key",
    DAYTONA_DOMAIN_ALLOW_LIST:
      "github.com,api.github.com,app.example,next.example",
    DAYTONA_SNAPSHOT: "coven-agents-copilot-1",
    GITHUB_TEAMS_ENABLED: "on",
    NODE_ENV: "production",
  } as NodeJS.ProcessEnv;
  const current = daytonaSandboxConfiguration(environment);
  const next = daytonaSandboxConfiguration({
    ...environment,
    APP_ORIGIN: "https://next.example",
    AUTH_URL: "https://next.example",
  });
  const reordered = daytonaSandboxConfiguration({
    ...environment,
    DAYTONA_DOMAIN_ALLOW_LIST:
      "next.example,app.example,api.github.com,github.com",
  });

  assert.equal(current.gatewayHostname, "app.example");
  assert.equal(next.gatewayHostname, "next.example");
  assert.match(current.configurationId ?? "", /^[a-f0-9]{64}$/u);
  assert.notEqual(current.configurationId, next.configurationId);
  assert.equal(current.configurationId, reordered.configurationId);

  const unrestricted = daytonaSandboxConfiguration({
    DAYTONA_API_KEY: "test-key",
    DAYTONA_DOMAIN_ALLOW_LIST: "",
    DAYTONA_SNAPSHOT: "coven-agents-copilot-1",
    GITHUB_TEAMS_ENABLED: "off",
    NODE_ENV: "development",
  });
  assert.equal(unrestricted.domainAllowList, undefined);
  assert.equal(unrestricted.gatewayHostname, undefined);
});

test("sandbox policy supplies bounded resource limits and persistent lifecycle settings", () => {
  const environment = {
    DAYTONA_API_KEY: "test-key",
    DAYTONA_DOMAIN_ALLOW_LIST: "github.com",
    DAYTONA_SNAPSHOT: "coven-agents-copilot-1",
    NODE_ENV: "production",
  } as NodeJS.ProcessEnv;

  const configuration = daytonaSandboxConfiguration(environment);
  assert.match(configuration.configurationId ?? "", /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    { ...configuration, configurationId: undefined },
    {
      autoArchiveInterval: 10_080,
      autoDeleteInterval: -1,
      autoStopInterval: 15,
      configurationId: undefined,
      domainAllowList: "github.com",
      resources: { cpu: 2, disk: 10, memory: 4 },
      snapshotName: "coven-agents-copilot-1",
      target: "us",
      ttlMinutes: 0,
    }
  );

  for (const [name, value] of [
    ["DAYTONA_AUTO_ARCHIVE_MINUTES", "59"],
    ["DAYTONA_AUTO_ARCHIVE_MINUTES", "43201"],
    ["DAYTONA_AUTO_STOP_MINUTES", "4"],
    ["DAYTONA_AUTO_STOP_MINUTES", "61"],
    ["DAYTONA_SANDBOX_CPU_CORES", "0"],
    ["DAYTONA_SANDBOX_CPU_CORES", "5"],
    ["DAYTONA_SANDBOX_MEMORY_GIB", "0"],
    ["DAYTONA_SANDBOX_MEMORY_GIB", "9"],
    ["DAYTONA_SANDBOX_DISK_GIB", "2"],
    ["DAYTONA_SANDBOX_DISK_GIB", "11"],
    ["DAYTONA_SANDBOX_CPU_CORES", "1.5"],
  ] as const) {
    assert.throws(
      () => daytonaSandboxConfiguration({ ...environment, [name]: value }),
      new RegExp(name)
    );
  }
});

test("a timeout after Daytona may have accepted creation remains durable until deterministic reconciliation attaches it", async () => {
  const reserved = agent({
    sandboxGeneration: 1,
    sandboxLifecycle: "provisioning",
    version: 1,
  });
  const ambiguous = agent({
    ...reserved,
    sandboxLifecycle: "provisioning_ambiguous",
    version: 2,
  });
  let resetCalls = 0;
  let marked = 0;

  await assert.rejects(
    ensureDaytonaSandbox(principal, agent(), config, {
      daytona: {
        create: () => Promise.reject(new DaytonaTimeoutError("timed out")),
        get: () =>
          Promise.reject(new DaytonaNotFoundError("absent before create")),
      },
      store: store({
        failDaytonaSandboxReservation: () => {
          resetCalls += 1;
          return Promise.resolve({ kind: "updated" as const, value: agent() });
        },
        markDaytonaSandboxReservationAmbiguous: () => {
          marked += 1;
          return Promise.resolve({
            kind: "updated" as const,
            value: ambiguous,
          });
        },
        reserveDaytonaSandbox: () =>
          Promise.resolve({ kind: "reserved" as const, value: reserved }),
      }),
    }),
    (error: unknown) =>
      error instanceof DaytonaSandboxLifecycleError &&
      error.kind === "cleanup_needed" &&
      error.retryable
  );
  assert.equal(marked, 1);
  assert.equal(resetCalls, 0);

  let starts = 0;
  const discovered = Object.assign(
    sandbox(SandboxState.STOPPED, {
      start: () => {
        starts += 1;
        return Promise.resolve();
      },
    }),
    {
      labels: {
        ...daytonaSandboxLabels(principal.tenant, ambiguous.id),
        configurationId: "current-configuration",
        sandboxGeneration: String(ambiguous.sandboxGeneration),
      },
    }
  );
  const currentConfiguration = {
    ...config,
    configurationId: "current-configuration",
  };
  const attached = agent({
    ...ambiguous,
    daytonaSandboxId: discovered.id,
    sandboxLifecycle: "ready",
    version: 3,
  });
  const reconciled = await ensureDaytonaSandbox(
    principal,
    ambiguous,
    currentConfiguration,
    {
      daytona: {
        create: () => Promise.reject(new Error("must not create")),
        get: (identifier) => {
          assert.equal(
            identifier,
            daytonaSandboxName(principal.tenant, ambiguous.id)
          );
          return Promise.resolve(discovered);
        },
      },
      store: store({
        attachDaytonaSandbox: () =>
          Promise.resolve({ kind: "updated" as const, value: attached }),
      }),
    }
  );
  assert.equal(reconciled.agent, attached);
  assert.equal(reconciled.sandbox, discovered);
  assert.equal(starts, 1);
});

test("ambiguous recovery deletes and reprovisions stale configuration or generation before attachment", async () => {
  const baseEnvironment = {
    APP_ORIGIN: "https://app.example",
    AUTH_URL: "https://app.example",
    DAYTONA_API_KEY: "test-key",
    DAYTONA_DOMAIN_ALLOW_LIST:
      "github.com,api.github.com,app.example,next.example",
    DAYTONA_SNAPSHOT: "coven-agents-copilot-1",
    GITHUB_TEAMS_ENABLED: "on",
    NODE_ENV: "production",
  } as NodeJS.ProcessEnv;
  const currentConfiguration = daytonaSandboxConfiguration({
    ...baseEnvironment,
    APP_ORIGIN: "https://next.example",
    AUTH_URL: "https://next.example",
  });
  const priorConfiguration = daytonaSandboxConfiguration(baseEnvironment);

  for (const staleLabels of [
    {
      configurationId: priorConfiguration.configurationId,
      sandboxGeneration: "1",
    },
    {
      configurationId: currentConfiguration.configurationId,
      sandboxGeneration: "0",
    },
  ]) {
    const calls: string[] = [];
    const ambiguous = agent({
      sandboxGeneration: 1,
      sandboxLifecycle: "provisioning_ambiguous",
      version: 2,
    });
    const resetting = agent({
      ...ambiguous,
      sandboxGeneration: 2,
      sandboxLifecycle: "resetting",
      version: 3,
    });
    const reset = agent({
      ...resetting,
      sandboxLifecycle: "unprovisioned",
      version: 4,
    });
    const reserved = agent({
      ...reset,
      sandboxGeneration: 3,
      sandboxLifecycle: "provisioning",
      version: 5,
    });
    const attached = agent({
      ...reserved,
      daytonaSandboxId: "replacement",
      sandboxLifecycle: "ready",
      version: 6,
    });
    const stale = Object.assign(
      sandbox(SandboxState.STARTED, {
        delete: () => {
          calls.push("delete");
          return Promise.resolve();
        },
        start: () => {
          calls.push("stale-start");
          return Promise.resolve();
        },
      }),
      {
        labels: {
          ...daytonaSandboxLabels(principal.tenant, ambiguous.id),
          ...staleLabels,
        },
      }
    );
    const replacement = Object.assign(
      sandbox(SandboxState.STOPPED, {
        start: () => {
          calls.push("replacement-start");
          return Promise.resolve();
        },
      }),
      {
        id: "replacement",
        labels: {
          ...daytonaSandboxLabels(principal.tenant, ambiguous.id),
          configurationId: currentConfiguration.configurationId,
          sandboxGeneration: String(reserved.sandboxGeneration),
        },
      }
    );
    let lookups = 0;

    // biome-ignore lint/performance/noAwaitInLoops: each mismatch owns an isolated durable generation
    const result = await ensureDaytonaSandbox(
      principal,
      ambiguous,
      currentConfiguration,
      {
        daytona: {
          create: (parameters) => {
            calls.push("create");
            assert.equal(
              parameters.labels?.configurationId,
              currentConfiguration.configurationId
            );
            assert.equal(
              parameters.labels?.sandboxGeneration,
              String(reserved.sandboxGeneration)
            );
            return Promise.resolve(replacement);
          },
          get: () => {
            lookups += 1;
            calls.push(`get:${lookups}`);
            return lookups === 1
              ? Promise.resolve(stale)
              : Promise.reject(new DaytonaNotFoundError("deleted"));
          },
        },
        store: store({
          attachDaytonaSandbox: () => {
            calls.push("attach");
            return Promise.resolve({
              kind: "updated" as const,
              value: attached,
            });
          },
          beginDaytonaSandboxReset: () => {
            calls.push("begin-reset");
            return Promise.resolve({
              kind: "updated" as const,
              value: resetting,
            });
          },
          finishDaytonaSandboxReset: () => {
            calls.push("finish-reset");
            return Promise.resolve({ kind: "updated" as const, value: reset });
          },
          reserveDaytonaSandbox: () => {
            calls.push("reserve");
            return Promise.resolve({
              kind: "reserved" as const,
              value: reserved,
            });
          },
        }),
      }
    );

    assert.equal(result.agent, attached);
    assert.equal(result.sandbox, replacement);
    assert.deepEqual(calls, [
      "get:1",
      "begin-reset",
      "delete",
      "finish-reset",
      "reserve",
      "get:2",
      "create",
      "attach",
      "replacement-start",
    ]);
    assert.equal(calls.includes("stale-start"), false);
  }
});

test("a stale ambiguous recovery cannot delete a sandbox owned by a newer durable generation", async () => {
  const ambiguous = agent({
    sandboxGeneration: 1,
    sandboxLifecycle: "provisioning_ambiguous",
    version: 2,
  });
  let deletes = 0;
  const newer = Object.assign(
    sandbox(SandboxState.STARTED, {
      delete: () => {
        deletes += 1;
        return Promise.resolve();
      },
    }),
    {
      labels: {
        ...daytonaSandboxLabels(principal.tenant, ambiguous.id),
        configurationId: "current-configuration",
        sandboxGeneration: "2",
      },
    }
  );

  await assert.rejects(
    ensureDaytonaSandbox(
      principal,
      ambiguous,
      { ...config, configurationId: "current-configuration" },
      {
        daytona: {
          create: () => Promise.reject(new Error("must not create")),
          get: () => Promise.resolve(newer),
        },
        store: store({
          beginDaytonaSandboxReset: () =>
            Promise.resolve({ kind: "stale_version" as const }),
        }),
      }
    ),
    /generation changed|stale/i
  );
  assert.equal(deletes, 0);
});

test("definite Daytona creation rejection resets the reservation", async () => {
  const reserved = agent({
    sandboxGeneration: 1,
    sandboxLifecycle: "provisioning",
    version: 1,
  });
  let resetCalls = 0;

  await assert.rejects(
    ensureDaytonaSandbox(principal, agent(), config, {
      daytona: {
        create: () => Promise.reject(new DaytonaBadRequestError("invalid")),
        get: () => Promise.reject(new DaytonaNotFoundError("absent")),
      },
      store: store({
        failDaytonaSandboxReservation: () => {
          resetCalls += 1;
          return Promise.resolve({
            kind: "updated" as const,
            value: agent({ sandboxLifecycle: "unprovisioned" }),
          });
        },
        markDaytonaSandboxReservationAmbiguous: () =>
          Promise.reject(new Error("must not mark ambiguity")),
        reserveDaytonaSandbox: () =>
          Promise.resolve({ kind: "reserved" as const, value: reserved }),
      }),
    }),
    /invalid/u
  );
  assert.equal(resetCalls, 1);
});

test("decommissioning an ambiguously created sandbox retains its row when reconciliation is not found", async () => {
  const ambiguous = agent({
    sandboxGeneration: 2,
    sandboxLifecycle: "provisioning_ambiguous",
    version: 4,
  });
  let deleted = 0;
  const result = await deleteDaytonaSandbox(principal, ambiguous.id, {
    daytona: {
      create: () => Promise.reject(new Error("must not create")),
      get: () => Promise.reject(new DaytonaNotFoundError("not yet visible")),
    },
    store: store({
      beginDaytonaSandboxDecommission: () =>
        Promise.resolve({
          kind: "cleanup_required" as const,
          value: ambiguous,
        }),
      deleteDecommissionedAgent: () => {
        deleted += 1;
        return Promise.resolve({ kind: "deleted" as const });
      },
    }),
  });
  assert.deepEqual(result, { error: "retryable", kind: "failed" });
  assert.equal(deleted, 0);
});

test("the resource policy stays inside Daytona per-sandbox maxima", () => {
  // Daytona allows at most 4 vCPU, 8 GiB of memory, and 10 GiB of disk per
  // sandbox. A policy above those is not stricter: the provider refuses the
  // sandbox, which is why these caps are the provider limits themselves.
  assert.deepEqual(
    {
      cpu: DAYTONA_SANDBOX_RESOURCE_POLICY_CAPS.cpu,
      disk: DAYTONA_SANDBOX_RESOURCE_POLICY_CAPS.disk,
      memory: DAYTONA_SANDBOX_RESOURCE_POLICY_CAPS.memory,
    },
    { cpu: 4, disk: 10, memory: 8 }
  );

  for (const field of ["cpu", "disk", "memory"] as const) {
    assert.ok(
      DAYTONA_SANDBOX_RESOURCE_POLICY_DEFAULTS[field] <=
        DAYTONA_SANDBOX_RESOURCE_POLICY_CAPS[field],
      `${field} default must stay inside the provider maximum`
    );
  }
});
