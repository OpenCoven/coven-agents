import assert from "node:assert/strict";
import test from "node:test";
import {
  DaytonaNotFoundError,
  DaytonaTimeoutError,
  type Sandbox,
  SandboxState,
} from "@daytona/sdk";
import type { RunnerStore } from "../store";
import type { RunnerAgentRecord, RunnerPrincipal } from "../types";
import {
  classifyDaytonaProviderError,
  deleteDaytonaSandbox,
  ensureDaytonaSandbox,
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
    recover?: () => Promise<void>;
    start?: () => Promise<void>;
  } = {}
): Sandbox {
  return {
    delete: (timeout?: number, wait?: boolean) =>
      hooks.delete?.(timeout, wait) ?? Promise.resolve(),
    id: "sandbox-id",
    labels: {},
    recover: () => hooks.recover?.() ?? Promise.resolve(),
    start: () => hooks.start?.() ?? Promise.resolve(),
    state,
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

test("a stale generation deletes the unpersistable replacement", async () => {
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
        get: () => Promise.reject(new Error("no get")),
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
  assert.equal(deletes, 1);
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
      finishDaytonaSandboxWarm: (_p: unknown, input: { status: string }) => {
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
      finishDaytonaSandboxWarm: (_p: unknown, input: { status: string }) => {
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
