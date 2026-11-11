import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  DaytonaBadRequestError,
  DaytonaForbiddenError,
  DaytonaNotFoundError,
  DaytonaTimeoutError,
  type Sandbox,
  SandboxState,
} from "@daytona/sdk";
import type { RunnerResourceOperationObservation } from "../resource-observability";
import type { RunnerStore } from "../store";
import type { RunnerAgentRecord, RunnerPrincipal } from "../types";
import {
  daytonaProbeSessionName,
  daytonaSandboxLabels,
  daytonaSandboxName,
} from "./names";
import { probeDaytonaHarnesses } from "./process";
import {
  adoptDaytonaSandboxPolicy,
  assertDaytonaCredentialBoundary,
  assertReplacementSnapshotReady,
  classifyDaytonaProviderError,
  classifyDaytonaSandboxCreateError,
  DAYTONA_CREDENTIAL_BOUNDARY_VERSION,
  type DaytonaSandboxConfiguration,
  type DaytonaSandboxCreateParameters,
  DaytonaSandboxLifecycleError,
  type DaytonaSandboxService,
  daytonaSandboxConfiguration,
  daytonaSandboxConfigurationIdentity,
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
  resources: { cpu: 2, disk: 10, memory: 4 },
  snapshotName: "coven-agents-copilot-2",
  target: "us",
  ttlMinutes: 0,
};

test("legacy persistent sandboxes require approved reset rather than inferred process containment", () => {
  const legacyLabels: Record<string, string>[] = [
    {},
    { credentialBoundaryVersion: "legacy" },
  ];
  for (const labels of legacyLabels) {
    assert.throws(
      () => assertDaytonaCredentialBoundary({ labels }),
      (error: unknown) =>
        error instanceof DaytonaSandboxLifecycleError &&
        error.kind === "cleanup_needed" &&
        !error.retryable
    );
  }
  assert.doesNotThrow(() =>
    assertDaytonaCredentialBoundary({
      labels: {
        credentialBoundaryVersion: DAYTONA_CREDENTIAL_BOUNDARY_VERSION,
      },
    })
  );
});

/**
 * A snapshot service that resolves the configured snapshot at policy size.
 * Reprovisioning fails closed without one, so any test that exercises the
 * delete-then-recreate path must state what the replacement snapshot is.
 */
const policySnapshot = (
  name: string = config.snapshotName
): NonNullable<DaytonaSandboxService["snapshot"]> => ({
  get: (requested) =>
    requested === name
      ? // Daytona's snapshot DTO names memory `mem` and always reports state.
        Promise.resolve({ cpu: 2, disk: 10, mem: 4, name, state: "active" })
      : Promise.reject(new DaytonaNotFoundError("snapshot absent")),
});

function agent(overrides: Partial<RunnerAgentRecord> = {}): RunnerAgentRecord {
  return {
    createdAt: new Date(),
    daytonaSandboxId: null,
    description: "",
    familiarId: "auto",
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
    setAutoArchiveInterval?: (interval: number) => Promise<void>;
    setAutostopInterval?: (interval: number) => Promise<void>;
    setLabels?: (
      labels: Record<string, string>
    ) => Promise<Record<string, string>>;
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
    setAutoArchiveInterval: (interval: number) =>
      hooks.setAutoArchiveInterval?.(interval) ?? Promise.resolve(),
    setAutostopInterval: (interval: number) =>
      hooks.setAutostopInterval?.(interval) ?? Promise.resolve(),
    setLabels: (labels: Record<string, string>) =>
      hooks.setLabels?.(labels) ?? Promise.resolve(labels),
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

test("dispatch preserves a sandbox when gateway egress configuration identity changes", async () => {
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

  const result = ensureDaytonaSandboxForDispatch(
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
        snapshot: policySnapshot(),
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

  await assert.rejects(result, /approved reset/u);
  assert.deepEqual(calls, ["get-dispatch", "get:stored"]);
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
    config,
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
    config,
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
    config,
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
    config,
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

test("a reset retry cannot follow a stable name into a replacement generation", async () => {
  await Promise.all(
    ["stored-id", "ambiguous-name", "matching-name", "unproven-name"].map(
      async (lookup) => {
        const calls: string[] = [];
        const resetting = agent({
          daytonaSandboxId: lookup === "stored-id" ? "old-sandbox" : null,
          sandboxGeneration: 2,
          sandboxLifecycle: "resetting",
          version: 4,
        });
        const result = await resetDaytonaSandboxForCancellation(
          { kind: "runner-operator" },
          {
            expectedVersion: 2,
            leaseToken: "cancel-lease",
            runId: "00000000-0000-4000-8000-000000000002",
          } as never,
          config,
          {
            daytona: {
              create: () => Promise.reject(new Error("must not create")),
              get: (identifier) => {
                calls.push(`get:${identifier}`);
                if (identifier === "old-sandbox") {
                  return Promise.reject(new DaytonaNotFoundError("absent"));
                }
                return Promise.resolve(
                  Object.assign(
                    sandbox(SandboxState.STARTED, {
                      delete: () => {
                        calls.push("delete-replacement");
                        return Promise.resolve();
                      },
                    }),
                    {
                      labels: {
                        ...daytonaSandboxLabels(resetting.tenant, resetting.id),
                        ...(lookup === "unproven-name"
                          ? {}
                          : {
                              sandboxGeneration:
                                lookup === "matching-name" ? "1" : "2",
                            }),
                      },
                    }
                  )
                );
              },
            },
            store: store({
              beginDaytonaSandboxResetForCancellation: async () => ({
                kind: "resetting" as const,
                value: resetting,
              }),
              finishDaytonaSandboxResetForRecovery: async () => ({
                kind: "stale_version" as const,
              }),
            }),
          }
        );
        assert.equal(
          calls.includes("delete-replacement"),
          lookup === "matching-name"
        );
        assert.equal(
          result.kind,
          lookup === "stored-id" || lookup === "matching-name"
            ? "stale_version"
            : "sandbox_reset_required"
        );
        if (lookup === "stored-id") {
          assert.deepEqual(calls, ["get:old-sandbox"]);
        }
      }
    )
  );
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
  const result = ensureDaytonaSandbox(principal, stale, currentConfiguration, {
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
      snapshot: policySnapshot(),
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
  });
  await assert.rejects(result, /approved reset/u);
  assert.deepEqual(calls, ["get"]);
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
      credentialBoundaryVersion: DAYTONA_CREDENTIAL_BOUNDARY_VERSION,
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

test("neither a superseded creator nor a newer reservation can delete an existing workspace", async () => {
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
      snapshot: policySnapshot(),
    },
    store: lifecycleStore,
  });
  await oldAttachReached;
  const newer = ensureDaytonaSandbox(
    principal,
    oldReservation,
    currentConfiguration,
    {
      daytona: {
        create: () => Promise.resolve(replacement),
        get: () => providerLookups.shift() as Promise<Sandbox>,
        snapshot: policySnapshot(),
      },
      store: lifecycleStore,
    }
  );
  await assert.rejects(newer, /approved reset/u);
  releaseOldAttach();
  await assert.rejects(old, /generation changed/u);

  assert.equal(deletes, 0);
  assert.equal(attachCalls, 1);
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
    // The probe must finish inside the deadline so that only its cleanup is
    // left unconfirmed. Five milliseconds lost that race on a loaded machine
    // and reported a retryable failure instead.
    lifecycle: {
      deadline: Date.now() + 250,
      signal: new AbortController().signal,
    },
    probe: (value, signal, timeoutSeconds, sessionId) =>
      probeDaytonaHarnesses(value, {
        deadline: Date.now() + 250,
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
  const deadline = 5;
  let now = 0;
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
      now: () => now,
      signal: controller.signal,
    },
    probe: (value, signal, timeoutSeconds, sessionId) =>
      probeDaytonaHarnesses(value, {
        deadline,
        now: () => now,
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

  await settlesWithin(started);
  now = deadline;
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

test("sandbox identity covers only what forces a new sandbox; the resource policy is adoptable", () => {
  const environment = {
    DAYTONA_API_KEY: "test-key",
    DAYTONA_DOMAIN_ALLOW_LIST: "github.com,api.github.com",
    DAYTONA_SNAPSHOT: "coven-agents-copilot-2",
    NODE_ENV: "production",
  } as NodeJS.ProcessEnv;
  const current = daytonaSandboxConfiguration(environment);

  // Editing any resource or idle value leaves the identity alone (#224).
  for (const [name, value] of [
    ["DAYTONA_AUTO_ARCHIVE_MINUTES", "120"],
    ["DAYTONA_AUTO_STOP_MINUTES", "30"],
    ["DAYTONA_SANDBOX_CPU_CORES", "4"],
    ["DAYTONA_SANDBOX_MEMORY_GIB", "8"],
  ] as const) {
    const edited = daytonaSandboxConfiguration({
      ...environment,
      [name]: value,
    });
    assert.equal(edited.configurationId, current.configurationId, name);
    assert.notDeepEqual(
      edited.priorConfigurationIds,
      current.priorConfigurationIds,
      name
    );
  }

  // The image, region and egress policy still do.
  for (const [name, value] of [
    ["DAYTONA_DOMAIN_ALLOW_LIST", "github.com"],
    ["DAYTONA_SNAPSHOT", "coven-agents-copilot-3"],
    ["DAYTONA_TARGET", "eu"],
  ] as const) {
    const edited = daytonaSandboxConfiguration({
      ...environment,
      [name]: value,
    });
    assert.notEqual(edited.configurationId, current.configurationId, name);
  }

  // The fleet was stamped with a hash over the whole policy before the split.
  // That exact digest must stay recognised or every workspace refuses on the
  // first attach after deploy.
  // Key order is part of the digest: the policy came first, then the identity
  // fields. The spread keeps the formatter from re-sorting it.
  const legacyPolicy = {
    autoArchiveInterval: 10_080,
    autoDeleteInterval: -1,
    autoStopInterval: 15,
    resources: { cpu: 2, disk: 10, memory: 4 },
    ttlMinutes: 0,
  };
  const legacy = createHash("sha256")
    .update(
      JSON.stringify({
        ...legacyPolicy,
        domainAllowList: "api.github.com,github.com",
        gatewayHostname: null,
        snapshotName: "coven-agents-copilot-2",
        target: "us",
      }),
      "utf8"
    )
    .digest("hex");
  assert.deepEqual(current.priorConfigurationIds, [legacy]);
  assert.notEqual(current.configurationId, legacy);
});

test("a stamped identity is current, a recognised prior one, or a mismatch", () => {
  const configuration = {
    configurationId: "split",
    priorConfigurationIds: ["whole-policy"],
  };
  assert.equal(
    daytonaSandboxConfigurationIdentity(
      { labels: { configurationId: "split" } },
      configuration
    ),
    "current"
  );
  assert.equal(
    daytonaSandboxConfigurationIdentity(
      { labels: { configurationId: "whole-policy" } },
      configuration
    ),
    "prior"
  );
  assert.equal(
    daytonaSandboxConfigurationIdentity(
      { labels: { configurationId: "something-else" } },
      configuration
    ),
    "mismatch"
  );
  assert.equal(
    daytonaSandboxConfigurationIdentity({ labels: {} }, configuration),
    "mismatch"
  );
  // A sandbox stamped with a prior id matches nothing once the deployment
  // stops listing it; unconfigured identity never matches.
  assert.equal(
    daytonaSandboxConfigurationIdentity(
      { labels: { configurationId: "whole-policy" } },
      { configurationId: "split" }
    ),
    "mismatch"
  );
  assert.equal(
    daytonaSandboxConfigurationIdentity(
      { labels: { configurationId: "split" } },
      { configurationId: undefined }
    ),
    "mismatch"
  );
});

test("a sandbox stamped before the identity split is adopted, relabelled and retuned, never reset", async () => {
  const calls: string[] = [];
  const observations: RunnerResourceOperationObservation[] = [];
  const configuration = {
    ...config,
    autoArchiveInterval: 4320,
    autoStopInterval: 30,
    configurationId: "split",
    priorConfigurationIds: ["whole-policy"],
  };
  const existing = Object.assign(
    sandbox(SandboxState.STOPPED, {
      delete: () => {
        calls.push("delete");
        return Promise.resolve();
      },
      setAutoArchiveInterval: (interval) => {
        calls.push(`archive:${interval}`);
        return Promise.resolve();
      },
      setAutostopInterval: (interval) => {
        calls.push(`stop:${interval}`);
        return Promise.resolve();
      },
      setLabels: (labels) => {
        calls.push(`labels:${labels.configurationId}:${labels.keep}`);
        return Promise.resolve(labels);
      },
      start: () => {
        calls.push("start");
        return Promise.resolve();
      },
    }),
    {
      autoArchiveInterval: 10_080,
      autoStopInterval: 15,
      labels: { configurationId: "whole-policy", keep: "me" },
    }
  );

  const result = await ensureDaytonaSandbox(
    principal,
    agent({ daytonaSandboxId: "stored", sandboxLifecycle: "ready" }),
    configuration,
    {
      daytona: {
        create: () => Promise.reject(new Error("must not create")),
        get: () => Promise.resolve(existing),
        snapshot: {
          get: () => Promise.reject(new Error("must not need a snapshot")),
        },
      },
      observe: (observation) => observations.push(observation),
      store: store({}),
    }
  );

  assert.equal(result.sandbox, existing);
  assert.deepEqual(calls, [
    "start",
    "labels:split:me",
    "stop:30",
    "archive:4320",
  ]);
  assert.deepEqual(observations, [{ operation: "adopt", outcome: "repaired" }]);
});

test("a current sandbox already on policy is left untouched", async () => {
  const observations: RunnerResourceOperationObservation[] = [];
  const configuration = { ...config, configurationId: "split" };
  const existing = Object.assign(
    sandbox(SandboxState.STARTED, {
      setAutoArchiveInterval: () => Promise.reject(new Error("must not tune")),
      setAutostopInterval: () => Promise.reject(new Error("must not tune")),
      setLabels: () => Promise.reject(new Error("must not relabel")),
    }),
    {
      autoArchiveInterval: config.autoArchiveInterval,
      autoStopInterval: config.autoStopInterval,
      labels: { configurationId: "split" },
    }
  );
  const result = await ensureDaytonaSandbox(
    principal,
    agent({ daytonaSandboxId: "stored", sandboxLifecycle: "ready" }),
    configuration,
    {
      daytona: {
        create: () => Promise.reject(new Error("must not create")),
        get: () => Promise.resolve(existing),
      },
      observe: (observation) => observations.push(observation),
      store: store({}),
    }
  );
  assert.equal(result.sandbox, existing);
  assert.deepEqual(observations, []);
});

test("a refused adoption keeps the workspace attached and reports the provider signal", async () => {
  const observations: RunnerResourceOperationObservation[] = [];
  const refusal = Object.assign(new DaytonaForbiddenError("no"), {
    code: "SANDBOX_LABELS_FORBIDDEN",
    source: "DAYTONA_API",
    statusCode: 403,
  });
  const existing = Object.assign(
    sandbox(SandboxState.STARTED, {
      setLabels: () => Promise.reject(refusal),
    }),
    { autoStopInterval: 15, labels: { configurationId: "whole-policy" } }
  );
  await adoptDaytonaSandboxPolicy(
    existing,
    {
      ...config,
      autoStopInterval: 30,
      configurationId: "split",
      priorConfigurationIds: ["whole-policy"],
    },
    { observe: (observation) => observations.push(observation) }
  );
  assert.deepEqual(observations, [
    {
      operation: "adopt",
      outcome: "failed",
      providerCode: "SANDBOX_LABELS_FORBIDDEN",
      providerSource: "DAYTONA_API",
      providerStatus: 403,
    },
  ]);
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
    {
      ...configuration,
      configurationId: undefined,
      priorConfigurationIds: undefined,
    },
    {
      autoArchiveInterval: 10_080,
      autoDeleteInterval: -1,
      autoStopInterval: 15,
      configurationId: undefined,
      domainAllowList: "github.com",
      priorConfigurationIds: undefined,
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
    ["DAYTONA_SANDBOX_DISK_GIB", "9"],
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

test("ambiguous recovery preserves stale configuration and generation until an approved reset", async () => {
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

    const result = ensureDaytonaSandbox(
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
          snapshot: policySnapshot("coven-agents-copilot-1"),
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

    // biome-ignore lint/performance/noAwaitInLoops: each mismatch owns an isolated durable generation
    await assert.rejects(result, /approved reset/u);
    assert.deepEqual(calls, ["get:1"]);
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
          snapshot: policySnapshot(),
        },
        store: store({
          beginDaytonaSandboxReset: () =>
            Promise.resolve({ kind: "stale_version" as const }),
        }),
      }
    ),
    /approved reset/u
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

/**
 * Reprovisioning deletes the persistent workspace and only then creates its
 * replacement, so a snapshot that cannot be resolved would destroy tenant work
 * and then fail. DAYTONA_SNAPSHOT is only shape-checked at build time, which
 * is how a snapshot that was never built reaches this path.
 */
test("a workspace is never deleted when the replacement snapshot is missing", async () => {
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

  const attempt = ensureDaytonaSandboxForDispatch(
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
        snapshot: {
          get: () =>
            Promise.reject(new DaytonaNotFoundError("snapshot absent")),
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

  await assert.rejects(
    attempt,
    (error: unknown) => {
      assert.ok(error instanceof DaytonaSandboxLifecycleError);
      assert.match(
        error.message,
        /replacement snapshot "coven-agents-copilot-2" could not be resolved/u
      );
      // A snapshot that is not there stays not there. Marking this retryable
      // buries the misconfiguration in a queue that never drains.
      assert.equal(
        error.retryable,
        false,
        "a missing snapshot is a permanent condition, not a transient one"
      );
      return true;
    },
    "an unresolvable snapshot must stop the reprovision"
  );
  assert.ok(
    !calls.includes("begin-reset"),
    `the reset must not begin: a committed "resetting" row is deleted by the
     recovery scanner on the next tick, so refusing after it only postpones
     the destruction. Got: ${calls.join(", ")}`
  );
  assert.ok(
    !calls.includes("delete"),
    `the workspace must survive an unusable replacement, got: ${calls.join(", ")}`
  );
  assert.ok(
    !calls.includes("create"),
    "nothing may be created after refusing to delete"
  );
});

/**
 * The snapshot service is optional in the type only so the existing
 * construction sites need not change. Optionality must never mean permission:
 * a caller that cannot prove the replacement is usable does not get to delete.
 */
test("a caller that cannot verify the snapshot may not delete either", async () => {
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

  const attempt = ensureDaytonaSandboxForDispatch(
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

  await assert.rejects(
    attempt,
    /no way to verify the replacement snapshot exists/u,
    "absence of a snapshot service must fail closed, not permit deletion"
  );
  assert.ok(
    !calls.includes("begin-reset"),
    `the reset must not begin: a committed "resetting" row is deleted by the
     recovery scanner on the next tick, so refusing after it only postpones
     the destruction. Got: ${calls.join(", ")}`
  );
  assert.ok(
    !calls.includes("delete"),
    `the workspace must survive an unusable replacement, got: ${calls.join(", ")}`
  );
  assert.ok(
    !calls.includes("create"),
    "nothing may be created after refusing to delete"
  );
});

/**
 * A snapshot that exists is not automatically a usable replacement. Destroying
 * a workspace to rebuild it below policy trades tenant data for no gain.
 */
test("a workspace is never deleted for a snapshot that is below policy", async () => {
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

  const attempt = ensureDaytonaSandboxForDispatch(
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
        snapshot: {
          // Generation-1 sizing: the snapshot resolves, but a sandbox built
          // from it would land straight back in drift.
          // Real provider shape: memory is reported as `mem`. Making it the
          // ONLY shortfall means a guard that reads `memory` alone — which is
          // what the SDK's write-side type suggests — fails this test instead
          // of silently enforcing nothing.
          get: (name) =>
            Promise.resolve({
              cpu: 2,
              disk: 10,
              mem: 1,
              name,
              state: "active",
            }),
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

  await assert.rejects(
    attempt,
    /is outside policy \(memory\)/u,
    "replacing a workspace with an undersized one is not a repair"
  );
  assert.ok(
    !calls.includes("begin-reset"),
    `the reset must not begin: a committed "resetting" row is deleted by the
     recovery scanner on the next tick, so refusing after it only postpones
     the destruction. Got: ${calls.join(", ")}`
  );
  assert.ok(
    !calls.includes("delete"),
    `the workspace must survive an unusable replacement, got: ${calls.join(", ")}`
  );
  assert.ok(
    !calls.includes("create"),
    "nothing may be created after refusing to delete"
  );
});

/**
 * The snapshot service is optional in the type only so the existing
 * construction sites need not change. Optionality must never mean permission:
 * a caller that cannot prove the replacement is usable does not get to delete.
 */

/** Missing provider metadata must not authorize destructive reprovisioning. */
test("a missing resource field blocks reprovisioning without deleting the workspace", async () => {
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

  const result = ensureDaytonaSandboxForDispatch(
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
        snapshot: {
          // Missing metadata cannot prove the replacement meets policy.
          get: (name) =>
            Promise.resolve({ cpu: 2, disk: 10, name, state: "active" }),
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

  await assert.rejects(result, /outside policy \(memory\)/u);
  assert.equal(calls.includes("begin-reset"), false);
  assert.equal(calls.includes("delete"), false);
  assert.equal(calls.includes("create"), false);
});

/**
 * Existence is not usability: snapshot.get resolves for building, error and
 * build_failed alike. The likeliest real state during a botched cutover is a
 * snapshot that resolves but failed to build.
 */
test("a workspace is never deleted for a snapshot that is not active", async () => {
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

  const attempt = ensureDaytonaSandboxForDispatch(
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
        snapshot: {
          // Generation-1 sizing: the snapshot resolves, but a sandbox built
          // from it would land straight back in drift.
          get: (name) =>
            Promise.resolve({
              cpu: 2,
              disk: 10,
              mem: 4,
              name,
              state: "build_failed",
            }),
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

  await assert.rejects(
    attempt,
    /is not active/u,
    "a snapshot that exists but cannot serve a create is not a replacement"
  );
  assert.ok(
    !calls.includes("begin-reset"),
    `the reset must not begin: a committed "resetting" row is deleted by the
     recovery scanner on the next tick, so refusing after it only postpones
     the destruction. Got: ${calls.join(", ")}`
  );
  assert.ok(
    !calls.includes("delete"),
    `the workspace must survive an unusable replacement, got: ${calls.join(", ")}`
  );
  assert.ok(
    !calls.includes("create"),
    "nothing may be created after refusing to delete"
  );
});

/**
 * The refusal must distinguish a permanent misconfiguration from a passing
 * provider fault. Marking everything permanent fails the whole fleet on a
 * blip; marking everything transient buries a missing snapshot in a queue that
 * never drains.
 */
test("a transient provider fault defers the refusal rather than failing it", async () => {
  const permanent = assertReplacementSnapshotReady(config, {
    daytona: {
      snapshot: {
        get: () => Promise.reject(new DaytonaNotFoundError("absent")),
      },
    },
  });
  await assert.rejects(permanent, (error: unknown) => {
    assert.ok(error instanceof DaytonaSandboxLifecycleError);
    assert.equal(error.retryable, false, "a missing snapshot is permanent");
    return true;
  });

  const transient = assertReplacementSnapshotReady(config, {
    daytona: {
      snapshot: {
        get: () => Promise.reject(new DaytonaTimeoutError("timeout")),
      },
    },
  });
  await assert.rejects(transient, (error: unknown) => {
    assert.ok(error instanceof DaytonaSandboxLifecycleError);
    assert.equal(
      error.retryable,
      true,
      "a timeout must not permanently fail every workspace in the fleet"
    );
    return true;
  });

  const building = assertReplacementSnapshotReady(config, {
    daytona: {
      snapshot: {
        get: (name: string) =>
          Promise.resolve({
            cpu: 2,
            disk: 10,
            mem: 4,
            name,
            state: "building",
          }),
      },
    },
  });
  await assert.rejects(building, (error: unknown) => {
    assert.ok(error instanceof DaytonaSandboxLifecycleError);
    assert.equal(
      error.retryable,
      true,
      "a snapshot mid-build settles on its own; the deploy window must heal"
    );
    return true;
  });
});

/**
 * A denylist of terminal states left `inactive`, `removing` and the SDK's
 * unknown-default classified as "wait, it will settle" — none of which ever
 * do. That deferred forever and reported healthy, which is exactly the
 * outcome the refusal-as-failure change exists to prevent. Only states that
 * genuinely settle may defer.
 */
test("only a snapshot state that settles on its own is treated as transient", async () => {
  const classify = async (state: string) => {
    try {
      await assertReplacementSnapshotReady(config, {
        daytona: {
          snapshot: {
            get: (name) =>
              Promise.resolve({ cpu: 2, disk: 10, mem: 4, name, state }),
          },
        },
      });
      return "accepted";
    } catch (error) {
      assert.ok(error instanceof DaytonaSandboxLifecycleError);
      return error.retryable ? "deferred" : "failed";
    }
  };

  for (const state of ["building", "pending", "pulling", "snapshotting"]) {
    assert.equal(
      // biome-ignore lint/performance/noAwaitInLoops: each case needs its own isolated call
      await classify(state),
      "deferred",
      `${state} settles on its own`
    );
  }
  for (const state of [
    "inactive",
    "removing",
    "error",
    "build_failed",
    "11184809",
  ]) {
    assert.equal(
      // biome-ignore lint/performance/noAwaitInLoops: each case needs its own isolated call
      await classify(state),
      "failed",
      `${state} never settles by waiting and must surface`
    );
  }
  assert.equal(await classify("active"), "accepted");
});

/**
 * Cancellation deliberately deletes without the snapshot guard: the harness
 * process lives in the sandbox, so refusing would leave a cancelled agent
 * running with live credentials. Containment outranks preserving capacity.
 *
 * But it must not be silent. When the snapshot cannot back the replacement,
 * the cancellation has destroyed a workspace with no rebuild path, and that
 * has to reach an operator before it reaches the tenant as a failed dispatch.
 */
test("a cancellation that cannot be rebuilt still cancels, and says so", async () => {
  for (const [label, snapshot, expected] of [
    [
      "unusable snapshot",
      {
        get: () => Promise.reject(new DaytonaNotFoundError("absent")),
      },
      [{ operation: "reset", outcome: "failed" }],
    ],
    [
      "usable snapshot",
      {
        get: (name: string) =>
          Promise.resolve({ cpu: 2, disk: 10, mem: 4, name, state: "active" }),
      },
      [],
    ],
  ] as const) {
    const observations: unknown[] = [];
    const deletes: string[] = [];
    // biome-ignore lint/performance/noAwaitInLoops: each case needs its own isolated call
    const reset = await resetDaytonaSandboxForCancellation(
      { kind: "runner-operator" },
      {
        expectedVersion: 2,
        leaseToken: "cancel-lease",
        runId: "00000000-0000-4000-8000-000000000002",
      } as never,
      config,
      {
        daytona: {
          create: () => Promise.reject(new Error("must not create")),
          get: (identifier) =>
            Promise.resolve({
              delete: () => {
                deletes.push(identifier);
                return Promise.resolve();
              },
              id: identifier,
            } as never),
          snapshot,
        },
        observe: (observation) => observations.push(observation),
        store: store({
          beginDaytonaSandboxResetForCancellation: () =>
            Promise.resolve({
              kind: "resetting" as const,
              value: agent({
                daytonaSandboxId: "sandbox",
                sandboxGeneration: 2,
                sandboxLifecycle: "resetting",
                version: 3,
              }),
            }),
          finishDaytonaSandboxResetForRecovery: () =>
            Promise.resolve({
              kind: "updated" as const,
              value: agent({ sandboxGeneration: 2, version: 4 }),
            }),
        }),
      }
    );

    assert.equal(reset.kind, "reset", `${label}: cancellation must complete`);
    assert.equal(
      deletes.length > 0,
      true,
      `${label}: the sandbox must be deleted either way — it is the kill switch`
    );
    assert.deepEqual(observations, expected, `${label}: observability`);
  }
});
