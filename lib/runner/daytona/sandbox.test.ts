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
import { daytonaSandboxName } from "./names";
import { probeDaytonaHarnesses } from "./process";
import {
  classifyDaytonaProviderError,
  classifyDaytonaSandboxCreateError,
  DaytonaSandboxLifecycleError,
  daytonaSandboxConfiguration,
  deleteDaytonaSandbox,
  ensureDaytonaSandbox,
  resetDaytonaSandboxForCancellation,
  warmDaytonaSandbox,
} from "./sandbox";

const principal: RunnerPrincipal = {
  kind: "subscriber",
  tenant: "private_tenant",
  userId: "user",
};
const config = {
  autoArchiveInterval: 10_080,
  autoStopInterval: 15,
  snapshotName: "coven-agents-copilot-1",
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
    sandboxUpdatedAt: new Date(),
    status: "idle",
    tenant: principal.tenant,
    updatedAt: new Date(),
    version: 0,
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
    waitUntilStarted: (timeout?: number) =>
      hooks.waitUntilStarted?.(timeout) ?? Promise.resolve(),
  } as unknown as Sandbox;
}

function store(methods: Record<string, unknown>): RunnerStore {
  return methods as RunnerStore;
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

  assert.equal(reset, true);
  assert.deepEqual(calls, ["begin", "delete", "finish"]);
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
    SandboxState.RESIZING,
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

test("stale provisioning reconciles its deterministic name before creating", async () => {
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
  const existing = sandbox(SandboxState.STARTED);
  const attached = agent({
    ...reserved,
    daytonaSandboxId: existing.id,
    sandboxLifecycle: "ready",
    version: 10,
  });
  let createCalls = 0;
  const result = await ensureDaytonaSandbox(principal, stale, config, {
    daytona: {
      create: () => {
        createCalls += 1;
        return Promise.reject(new Error("must not create"));
      },
      get: (identifier) => {
        assert.equal(
          identifier,
          daytonaSandboxName(principal.tenant, stale.id)
        );
        return Promise.resolve(existing);
      },
    },
    store: store({
      attachDaytonaSandbox: () =>
        Promise.resolve({ kind: "updated" as const, value: attached }),
      reserveDaytonaSandbox: (
        _principal: unknown,
        input: { provisioningStaleBefore: Date }
      ) => {
        assert.ok(input.provisioningStaleBefore > stale.sandboxUpdatedAt);
        return Promise.resolve({ kind: "reserved" as const, value: reserved });
      },
    }),
  });
  assert.equal(result.agent, attached);
  assert.equal(result.sandbox, existing);
  assert.equal(createCalls, 0);
});

test("an attach-loss leaves a reconciled sandbox intact", async () => {
  const reserved = agent({
    sandboxGeneration: 1,
    sandboxLifecycle: "provisioning",
    version: 1,
  });
  let deletes = 0;
  const existing = sandbox(SandboxState.STARTED, {
    delete: () => {
      deletes += 1;
      return Promise.resolve();
    },
  });
  await assert.rejects(
    ensureDaytonaSandbox(principal, agent(), config, {
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
  let createParameters: Record<string, unknown> | undefined;
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
  assert.equal(createParameters?.snapshot, config.snapshotName);
  assert.equal(createParameters?.ephemeral, false);
  assert.equal(createParameters?.autoDeleteInterval, -1);
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
  const adopted = agent({
    ...newReservation,
    daytonaSandboxId: "sandbox-id",
    sandboxLifecycle: "ready",
    version: 3,
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
  const created = sandbox(SandboxState.STARTED, {
    delete: () => {
      deletes += 1;
      return Promise.resolve();
    },
  });
  const providerLookups = [
    Promise.reject(new DaytonaNotFoundError("missing")),
    Promise.resolve(created),
  ];
  const lifecycleStore = store({
    attachDaytonaSandbox: () => {
      attachCalls += 1;
      signalOldAttach();
      return attachCalls === 1
        ? oldAttach
        : Promise.resolve({ kind: "updated" as const, value: adopted });
    },
    reserveDaytonaSandbox: () =>
      Promise.resolve(
        attachCalls === 0
          ? { kind: "reserved" as const, value: oldReservation }
          : { kind: "reserved" as const, value: newReservation }
      ),
  });

  const old = ensureDaytonaSandbox(principal, agent(), config, {
    daytona: {
      create: () => Promise.resolve(created),
      get: () => providerLookups.shift() as Promise<Sandbox>,
    },
    store: lifecycleStore,
  });
  await oldAttachReached;
  const newer = await ensureDaytonaSandbox(principal, oldReservation, config, {
    daytona: {
      create: () => Promise.reject(new Error("must not create")),
      get: () => Promise.resolve(created),
    },
    store: lifecycleStore,
  });
  releaseOldAttach();
  await assert.rejects(old, /generation changed/u);

  assert.equal(deletes, 0);
  assert.equal(newer.agent.daytonaSandboxId, created.id);
  assert.equal(newer.agent.sandboxGeneration, newReservation.sandboxGeneration);
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
  const success = await warmDaytonaSandbox(principal, current, config, {
    daytona: {
      create: () => Promise.reject(new Error("no create")),
      get: () => Promise.resolve(sandbox(SandboxState.STARTED)),
    },
    probe: (value) => {
      calls.push(value.id);
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
  const commandRejectors: ((error: Error) => void)[] = [];
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
        for (const reject of commandRejectors) {
          reject(new Error("probe session deleted"));
        }
        return Promise.resolve();
      },
      executeCommand: () =>
        Promise.reject(new Error("prewarm probe must use a session")),
      executeSessionCommand: () => {
        probeStarted();
        return new Promise((_resolve, reject) => {
          commandRejectors.push(reject);
        });
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
    probe: (value, signal, timeoutSeconds) =>
      probeDaytonaHarnesses(value, { signal, timeoutSeconds }).then(
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
  const result = await pending;

  assert.equal(probeDeletes, 1);
  assert.equal(sessions.size, 0);
  assert.deepEqual(statuses, ["failed"]);
  assert.deepEqual(result, { error: "retryable", kind: "failed" });
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

  const discovered = sandbox(SandboxState.STARTED);
  const attached = agent({
    ...ambiguous,
    daytonaSandboxId: discovered.id,
    sandboxLifecycle: "ready",
    version: 3,
  });
  const reconciled = await ensureDaytonaSandbox(principal, ambiguous, config, {
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
  });
  assert.equal(reconciled.agent, attached);
  assert.equal(reconciled.sandbox, discovered);
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
