import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_RUNNER_API_VERSION,
  type RunSnapshot,
} from "@opencoven/agent-contracts";
import { cancelRunnerRun, reconcileAndDispatch } from "./attempt-reconcile";
import { createRunnerService } from "./service";
import type {
  RunnerAgentRecord,
  RunnerClaimedDispatch,
  RunnerDispatchAuthority,
  RunnerOperator,
  RunnerPrincipal,
  RunnerRunRecord,
} from "./types";

const AGENT_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_AGENT_ID = "22222222-3333-4444-8555-666666666666";
const RUN_ID = "33333333-4444-4555-8666-777777777777";
const OPERATION_ID = "44444444-5555-4666-8777-888888888888";
const PRINCIPAL: RunnerPrincipal = {
  kind: "subscriber",
  tenant: "u_9c8589018a57479181fe4c455b099bc9",
  userId: "9c858901-8a57-4791-81fe-4c455b099bc9",
};
const OPERATOR: RunnerOperator = { kind: "runner-operator" };

function agent(overrides: Partial<RunnerAgentRecord> = {}): RunnerAgentRecord {
  return {
    createdAt: new Date("2026-08-28T15:00:00.000Z"),
    daytonaSandboxId: null,
    description: "",
    familiarId: "auto",
    id: AGENT_ID,
    instructions: "Do the thing.",
    lastRunAt: null,
    model: "auto",
    name: "Runner",
    runtime: "copilot",
    sandboxGeneration: 0,
    sandboxLifecycle: "unprovisioned",
    sandboxTrust: "clean",
    sandboxUpdatedAt: new Date("2026-08-28T15:00:00.000Z"),
    status: "idle",
    tenant: PRINCIPAL.tenant,
    updatedAt: new Date("2026-08-28T15:00:00.000Z"),
    version: 4,
    warmAttemptVersion: 0,
    warmStatus: "not_started",
    warmUpdatedAt: new Date("2026-08-28T15:00:00.000Z"),
    workspace: null,
    ...overrides,
  };
}

function run(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    agentId: AGENT_ID,
    apiVersion: AGENT_RUNNER_API_VERSION,
    commandEvidence: [],
    completedAt: null,
    createdAt: "2026-08-28T15:00:00.000Z",
    fileEvidence: [],
    id: RUN_ID,
    operationId: OPERATION_ID,
    output: "",
    startedAt: null,
    status: "queued",
    task: "Do the thing.",
    ...overrides,
  };
}

function baseStore(overrides: Record<string, unknown> = {}) {
  return {
    createAgent: async () => ({ agent: agent(), kind: "created" as const }),
    getAgent: async () => agent(),
    getRun: async () => run(),
    listAgentRuns: async () => [run()],
    listAgents: async () => [agent()],
    readEventsAfter: async () => [],
    startRun: async () => ({ kind: "created" as const, run: run() }),
    updateAgent: async () => ({
      kind: "updated" as const,
      value: agent({ name: "Updated", version: 5 }),
    }),
    ...overrides,
  } as never;
}

function definition(overrides: Record<string, unknown> = {}) {
  return {
    backend: "cloud",
    description: "",
    instructions: "Do the thing.",
    model: "auto",
    name: "Runner",
    runtime: "copilot",
    ...overrides,
  };
}

test("agent creation stamps the authenticated tenant and rejects supplied ownership", async () => {
  let createdInput: unknown;
  const service = createRunnerService({
    createId: () => AGENT_ID,
    store: baseStore({
      createAgent: (principal: RunnerPrincipal, input: unknown) => {
        createdInput = { input, principal };
        return Promise.resolve({ agent: agent(), kind: "created" as const });
      },
    }),
  });

  const created = await service.createAgent(PRINCIPAL, definition());
  assert.equal(created.kind, "created");
  if (created.kind === "created") {
    assert.equal(created.agent.familiarId, "auto");
    assert.equal(created.agent.owner.kind, "tenant");
    if (created.agent.owner.kind === "tenant") {
      assert.equal(created.agent.owner.tenantId, PRINCIPAL.tenant);
    }
  }
  assert.deepEqual(
    (createdInput as { principal: RunnerPrincipal }).principal,
    PRINCIPAL
  );
  assert.equal(
    (createdInput as { input: { familiarId: string } }).input.familiarId,
    "auto"
  );

  const ownerInjected = await service.createAgent(
    PRINCIPAL,
    definition({ owner: { kind: "tenant", tenantId: "other" } })
  );
  assert.deepEqual(ownerInjected, { kind: "invalid" });
});

test("idempotent agent creation derives one stable id and recovers a committed row", async () => {
  const ids: string[] = [];
  let stored: RunnerAgentRecord | null = null;
  const service = createRunnerService({
    store: baseStore({
      createAgent: (_principal: RunnerPrincipal, input: { id: string }) => {
        ids.push(input.id);
        if (stored) {
          return Promise.resolve({ kind: "conflict" as const });
        }
        stored = agent({ id: input.id });
        return Promise.resolve({ agent: stored, kind: "created" as const });
      },
      getAgent: () => Promise.resolve(stored),
    }),
  });
  const providerIdempotencyKey = `coven_${"a".repeat(64)}`;

  const first = await service.createAgent(
    PRINCIPAL,
    definition(),
    providerIdempotencyKey
  );
  const replay = await service.createAgent(
    PRINCIPAL,
    definition(),
    providerIdempotencyKey
  );

  assert.equal(first.kind, "created");
  assert.equal(replay.kind, "created");
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  assert.equal(
    first.kind === "created" && replay.kind === "created"
      ? first.agent.id
      : null,
    replay.kind === "created" ? replay.agent.id : null
  );
});

test("public agent projections require warm state and omit provider records", async () => {
  const service = createRunnerService({
    createId: () => AGENT_ID,
    store: baseStore(),
  });

  const created = await service.createAgent(PRINCIPAL, definition());
  assert.equal(created.kind, "created");
  if (created.kind !== "created") {
    return;
  }
  assert.deepEqual(created.agent.warm, {
    status: "not_started",
    updatedAt: "2026-08-28T15:00:00.000Z",
  });
  assert.deepEqual(Object.keys(created.agent).sort(), [
    "backend",
    "createdAt",
    "description",
    "familiarId",
    "id",
    "instructions",
    "lastRunAt",
    "model",
    "name",
    "owner",
    "runtime",
    "status",
    "updatedAt",
    "warm",
  ]);
  const serialized = JSON.stringify(created.agent);
  for (const internalField of [
    "daytonaSandboxId",
    "sandboxGeneration",
    "sandboxLifecycle",
    "version",
  ]) {
    assert.equal(serialized.includes(internalField), false);
  }
});

test("agent creation reports retryable database unavailability", async () => {
  const service = createRunnerService({
    createId: () => AGENT_ID,
    store: baseStore({
      createAgent: () => Promise.reject(new Error("database=private-detail")),
    }),
  });

  assert.deepEqual(await service.createAgent(PRINCIPAL, definition()), {
    kind: "unavailable",
    source: "database",
  });
});

test("agent creation refuses non-runnable harnesses before persistence", async () => {
  let writes = 0;
  const service = createRunnerService({
    store: baseStore({
      createAgent: () => {
        writes += 1;
        return Promise.resolve({ agent: agent(), kind: "created" as const });
      },
    }),
  });

  assert.deepEqual(
    await service.createAgent(PRINCIPAL, definition({ runtime: "codex" })),
    { kind: "unsupported_harness" }
  );
  assert.equal(writes, 0);
});

test("agent updates preserve tenant ownership and expose stale versions", async () => {
  let updateInput: unknown;
  const service = createRunnerService({
    store: baseStore({
      updateAgent: (_principal: RunnerPrincipal, input: unknown) => {
        updateInput = input;
        return Promise.resolve({ kind: "stale_version" as const });
      },
    }),
  });

  assert.deepEqual(
    await service.updateAgent(
      PRINCIPAL,
      AGENT_ID,
      definition({ name: "Next" })
    ),
    { kind: "stale_version" }
  );
  assert.equal(
    (updateInput as { expectedVersion: number }).expectedVersion,
    agent().version
  );
  assert.equal((updateInput as { familiarId: string }).familiarId, "auto");
});

test("agent creation and updates persist explicit familiar selections", async () => {
  let createdInput: unknown;
  let updateInput: unknown;
  const service = createRunnerService({
    createId: () => AGENT_ID,
    store: baseStore({
      createAgent: (_principal: RunnerPrincipal, input: unknown) => {
        createdInput = input;
        return Promise.resolve({
          agent: agent({ familiarId: "scribe" }),
          kind: "created" as const,
        });
      },
      updateAgent: (_principal: RunnerPrincipal, input: unknown) => {
        updateInput = input;
        return Promise.resolve({
          kind: "updated" as const,
          value: agent({ familiarId: "critic", version: 5 }),
        });
      },
    }),
  });

  const created = await service.createAgent(
    PRINCIPAL,
    definition({ familiarId: "scribe" })
  );
  assert.equal(
    created.kind === "created" && created.agent.familiarId,
    "scribe"
  );
  assert.equal((createdInput as { familiarId: string }).familiarId, "scribe");

  const updated = await service.updateAgent(
    PRINCIPAL,
    AGENT_ID,
    definition({ familiarId: "critic" })
  );
  assert.equal(
    updated.kind === "updated" && updated.agent.familiarId,
    "critic"
  );
  assert.equal((updateInput as { familiarId: string }).familiarId, "critic");
});

test("agent updates preserve the explicit busy outcome", async () => {
  const service = createRunnerService({
    store: baseStore({
      updateAgent: () => Promise.resolve({ kind: "busy" as const }),
    }),
  });

  assert.deepEqual(
    await service.updateAgent(PRINCIPAL, AGENT_ID, definition()),
    { kind: "busy" }
  );
});

test("agent updates reject unsupported runtimes before reading or mutating storage", async () => {
  let reads = 0;
  let writes = 0;
  const service = createRunnerService({
    store: baseStore({
      getAgent: () => {
        reads += 1;
        return Promise.resolve(agent());
      },
      updateAgent: () => {
        writes += 1;
        return Promise.resolve({
          kind: "updated" as const,
          value: agent({ runtime: "copilot", version: 5 }),
        });
      },
    }),
  });

  assert.deepEqual(
    await service.updateAgent(
      PRINCIPAL,
      AGENT_ID,
      definition({ runtime: "codex" })
    ),
    { kind: "unsupported_harness" }
  );
  assert.equal(reads, 0);
  assert.equal(writes, 0);
});

test("agent updates report retryable database unavailability", async () => {
  const service = createRunnerService({
    store: baseStore({
      updateAgent: () => Promise.reject(new Error("database=private-detail")),
    }),
  });

  assert.deepEqual(
    await service.updateAgent(PRINCIPAL, AGENT_ID, definition()),
    {
      kind: "unavailable",
      source: "database",
    }
  );
});

test("agent deletion delegates provider-first decommissioning", async () => {
  const calls: string[] = [];
  const service = createRunnerService({
    resourceLifecycle: {
      decommission: (principal, agentId) => {
        calls.push(`${principal.tenant}:${agentId}`);
        return Promise.resolve({ kind: "deleted" as const });
      },
      prewarm: () => Promise.reject(new Error("must not prewarm")),
    },
    store: baseStore(),
  });

  assert.deepEqual(await service.deleteAgent(PRINCIPAL, AGENT_ID), {
    kind: "deleted",
  });
  assert.deepEqual(calls, [`${PRINCIPAL.tenant}:${AGENT_ID}`]);
});

test("agent deletion preserves busy, stale, and provider retryability outcomes", async () => {
  const outcomes = [
    [{ kind: "busy" }, { kind: "busy" }],
    [{ kind: "stale_version" }, { kind: "stale_version" }],
    [
      { kind: "unavailable", source: "provider" },
      { kind: "unavailable", source: "provider" },
    ],
    [
      { kind: "unavailable", source: "database" },
      { kind: "unavailable", source: "database" },
    ],
    [{ kind: "provider_rejected" }, { kind: "provider_rejected" }],
  ] as const;

  await Promise.all(
    outcomes.map(async ([providerResult, expected]) => {
      const service = createRunnerService({
        resourceLifecycle: {
          decommission: async () => providerResult as never,
          prewarm: () => Promise.reject(new Error("must not prewarm")),
        },
        store: baseStore(),
      });
      assert.deepEqual(
        await service.deleteAgent(PRINCIPAL, AGENT_ID),
        expected
      );
    })
  );
});

test("agent deletion converts thrown provider or database work into retryable unavailability", async () => {
  const service = createRunnerService({
    resourceLifecycle: {
      decommission: () =>
        Promise.reject(new Error("provider-or-database=private-detail")),
      prewarm: () => Promise.reject(new Error("must not prewarm")),
    },
    store: baseStore(),
  });

  assert.deepEqual(await service.deleteAgent(PRINCIPAL, AGENT_ID), {
    kind: "unavailable",
    source: "provider",
  });
});

test("start maps idempotent admission outcomes and preserves a request hash", async () => {
  let admission: unknown;
  const service = createRunnerService({
    admit: (input) => {
      admission = input;
      return Promise.resolve({ kind: "duplicate" as const, run: run() });
    },
    createId: () => RUN_ID,
    store: baseStore(),
  });

  const started = await (
    service.startRun as unknown as (
      principal: RunnerPrincipal,
      authVersion: number,
      agentId: string,
      input: unknown
    ) => ReturnType<typeof service.startRun>
  )(PRINCIPAL, 7, AGENT_ID, {
    operationId: OPERATION_ID,
    task: "Do the thing.",
  });

  assert.equal(started.kind, "accepted");
  assert.equal(started.kind === "accepted" && started.run.id, RUN_ID);
  assert.equal(
    typeof (admission as { requestHash: unknown }).requestHash,
    "string"
  );
  assert.equal((admission as { requestHash: string }).requestHash.length, 64);
  assert.equal((admission as { authVersion: number }).authVersion, 7);
});

test("start preserves an admitted claim as opaque scheduling intent", async () => {
  const authority = {
    expectedVersion: 1,
    leaseToken: "opaque-claim",
    runId: RUN_ID,
  } as RunnerDispatchAuthority;
  const claim = {
    authority,
    run: run(),
  } as unknown as RunnerClaimedDispatch;
  const dispatched: RunnerClaimedDispatch[] = [];
  const service = createRunnerService({
    admit: () =>
      Promise.resolve({
        claimed: claim,
        kind: "claimed" as const,
        run: run(),
      }),
    createId: () => RUN_ID,
    dispatchClaim: (claimed) => {
      dispatched.push(claimed);
      return Promise.resolve({ kind: "started", runId: RUN_ID });
    },
    store: baseStore(),
  });

  const started = await service.startRun(PRINCIPAL, 7, AGENT_ID, {
    operationId: OPERATION_ID,
    task: "Do the thing.",
  });

  assert.deepEqual(started, {
    admission: "claimed",
    claimed: claim,
    kind: "accepted",
    run: run(),
  });
  assert.equal(dispatched.length, 0);
});

test("start preserves duplicates without dispatch or recovery scheduling", async () => {
  const existing = run({
    id: "55555555-6666-4777-8888-999999999999",
  });
  let dispatched = 0;
  const service = createRunnerService({
    admit: () => Promise.resolve({ kind: "duplicate" as const, run: existing }),
    createId: () => RUN_ID,
    dispatchClaim: () => {
      dispatched += 1;
      return Promise.resolve({ kind: "idle" });
    },
    store: baseStore(),
  });

  assert.deepEqual(
    await service.startRun(PRINCIPAL, 7, AGENT_ID, {
      operationId: OPERATION_ID,
      task: "Do the thing.",
    }),
    { admission: "duplicate", kind: "accepted", run: existing }
  );
  assert.equal(dispatched, 0);
});

test("start marks only newly queued runs for bounded recovery", async () => {
  const service = createRunnerService({
    admit: () => Promise.resolve({ kind: "created" as const, run: run() }),
    createId: () => RUN_ID,
    dispatchClaim: () =>
      Promise.reject(new Error("created runs must not dispatch directly")),
    store: baseStore(),
  });

  assert.deepEqual(
    await service.startRun(PRINCIPAL, 7, AGENT_ID, {
      operationId: OPERATION_ID,
      task: "Do the thing.",
    }),
    { admission: "created", kind: "accepted", run: run() }
  );
});

test("start does not begin claimed provider dispatch before scheduling", async () => {
  const claim = {
    authority: {
      expectedVersion: 1,
      leaseToken: "opaque-secret-claim",
      runId: RUN_ID,
    } as RunnerDispatchAuthority,
    run: run(),
  } as unknown as RunnerClaimedDispatch;
  let dispatches = 0;
  const service = createRunnerService({
    admit: () =>
      Promise.resolve({
        claimed: claim,
        kind: "claimed" as const,
        run: run(),
      }),
    createId: () => RUN_ID,
    dispatchClaim: () => {
      dispatches += 1;
      return new Promise(() => undefined);
    },
    store: baseStore(),
  });

  const started = await service.startRun(PRINCIPAL, 7, AGENT_ID, {
    operationId: OPERATION_ID,
    task: "Do the thing.",
  });

  assert.deepEqual(started, {
    admission: "claimed",
    claimed: claim,
    kind: "accepted",
    run: run(),
  });
  assert.equal(dispatches, 0);
});

test("start maps admission conflict, capacity, and unavailable results without provider work", async () => {
  const outcomes = [
    {
      code: "operation_conflict",
      expected: {
        code: "operation_conflict",
        kind: "refused",
        retryable: false,
      },
    },
    {
      code: "global_busy",
      expected: { code: "busy", kind: "refused", retryable: true },
    },
    {
      code: "admission_unavailable",
      expected: {
        code: "admission_unavailable",
        kind: "refused",
        retryable: true,
      },
    },
    {
      code: "sandbox_unavailable",
      expected: {
        code: "lifecycle_conflict",
        kind: "refused",
        retryable: true,
      },
    },
  ] as const;

  await Promise.all(
    outcomes.map(async ({ code, expected }) => {
      const service = createRunnerService({
        admit: () =>
          Promise.resolve({
            error: {
              code,
              message: "safe",
              name: "RunnerAdmissionError",
              retryable: code !== "operation_conflict",
            },
            kind: "refused",
          } as never),
        createId: () => RUN_ID,
        store: baseStore(),
      });
      assert.deepEqual(
        await service.startRun(PRINCIPAL, 1, AGENT_ID, {
          operationId: OPERATION_ID,
          task: "Do the thing.",
        }),
        expected
      );
    })
  );
});

test("start converts an admission exception into typed retryable unavailability", async () => {
  const failures: unknown[] = [];
  const service = createRunnerService({
    admit: () => Promise.reject(new Error("database=private-detail")),
    createId: () => RUN_ID,
    reportAdmissionFailure: (failure) => {
      failures.push(failure);
    },
    store: baseStore(),
  });

  assert.deepEqual(
    await service.startRun(PRINCIPAL, 1, AGENT_ID, {
      operationId: OPERATION_ID,
      task: "Do the thing.",
    }),
    {
      code: "admission_unavailable",
      kind: "refused",
      retryable: true,
    }
  );
  assert.deepEqual(failures, [
    { code: null, name: "Error", stage: "admission" },
  ]);
  assert.equal(JSON.stringify(failures).includes("private-detail"), false);
});

test("start reports a sanitized agent lookup failure stage", async () => {
  const failures: unknown[] = [];
  const service = createRunnerService({
    reportAdmissionFailure: (failure) => {
      failures.push(failure);
    },
    store: baseStore({
      getAgent: () =>
        Promise.reject(
          Object.assign(new Error("database=private-detail"), {
            code: "42P01",
            name: "tenant_private_identifier_ABC123",
          })
        ),
    }),
  });

  assert.deepEqual(
    await service.startRun(PRINCIPAL, 1, AGENT_ID, {
      operationId: OPERATION_ID,
      task: "Do the thing.",
    }),
    {
      code: "admission_unavailable",
      kind: "refused",
      retryable: true,
    }
  );
  assert.deepEqual(failures, [
    { code: "42P01", name: "unknown", stage: "agent_lookup" },
  ]);
  assert.equal(JSON.stringify(failures).includes("private-detail"), false);
});

test("start rejects unsupported harnesses before admission, persistence, dispatch, or scheduling", async () => {
  let admissions = 0;
  let dispatches = 0;
  let runWrites = 0;
  const service = createRunnerService({
    admit: () => {
      admissions += 1;
      return Promise.resolve({ kind: "created" as const, run: run() });
    },
    createId: () => RUN_ID,
    dispatchClaim: () => {
      dispatches += 1;
      return Promise.resolve({ kind: "idle" });
    },
    store: baseStore({
      getAgent: async () => agent({ runtime: "codex" }),
      startRun: () => {
        runWrites += 1;
        return Promise.resolve({ kind: "created" as const, run: run() });
      },
    }),
  });

  assert.deepEqual(
    await service.startRun(PRINCIPAL, 1, AGENT_ID, {
      operationId: OPERATION_ID,
      task: "Do the thing.",
    }),
    { kind: "unsupported_harness" }
  );
  assert.equal(admissions, 0);
  assert.equal(runWrites, 0);
  assert.equal(dispatches, 0);
});

test("run reads and event pages remain tenant scoped and terminal-aware", async () => {
  const event = {
    at: "2026-08-28T15:00:00.000Z",
    id: 1,
    operationId: OPERATION_ID,
    runId: RUN_ID,
    type: "accepted" as const,
  };
  const service = createRunnerService({
    store: baseStore({
      getRun: () =>
        Promise.resolve(
          run({
            completedAt: "2026-08-28T15:01:00.000Z",
            status: "completed",
          })
        ),
      readEventsAfter: () => Promise.resolve([{ event }]),
    }),
  });

  const page = await service.readRunEvents(PRINCIPAL, RUN_ID, 0);
  assert.deepEqual(page, {
    events: [event],
    kind: "found",
    terminal: true,
  });
});

test("stop verifies tenant ownership before cancellation and returns terminal snapshots idempotently", async () => {
  let cancellationCalls = 0;
  const denied = createRunnerService({
    cancelRun: () => {
      cancellationCalls += 1;
      return Promise.resolve({
        kind: "already_terminal" as const,
        runId: RUN_ID,
      });
    },
    store: baseStore({ getRun: async () => null }),
  });
  assert.deepEqual(await denied.stopRun(PRINCIPAL, RUN_ID), {
    kind: "not_found",
  });
  assert.equal(cancellationCalls, 0);

  const allowed = createRunnerService({
    cancelRun: () => {
      cancellationCalls += 1;
      return Promise.resolve({
        kind: "already_terminal" as const,
        runId: RUN_ID,
      });
    },
    store: baseStore({
      getRun: async () =>
        run({
          completedAt: "2026-08-28T15:01:00.000Z",
          status: "cancelled",
        }),
    }),
  });
  const stopped = await allowed.stopRun(PRINCIPAL, RUN_ID);
  assert.equal(stopped.kind, "stopped");
  assert.equal(stopped.kind === "stopped" && stopped.run.status, "cancelled");
  assert.equal(cancellationCalls, 1);
});

test("reconciliation recovers a cancelled terminal row after lease cleanup failed", async () => {
  let cleanupAttempts = 0;
  let persisted: RunnerRunRecord = {
    agentId: AGENT_ID,
    agentInstructions: "Do the thing.",
    agentModel: "auto",
    agentRuntime: "copilot",
    agentWorkspace: null,
    authVersion: 1,
    cancellationRequestedAt: null,
    commandEvidence: [],
    completedAt: null,
    createdAt: new Date("2026-08-28T15:00:00.000Z"),
    daytonaAttemptId: null,
    daytonaCommandId: null,
    daytonaLogCursor: 0,
    daytonaSessionId: null,
    dispatchLeaseExpiresAt: new Date("2026-08-28T14:59:00.000Z"),
    dispatchLeaseToken: "initial-lease",
    dispatchState: "dispatching",
    error: null,
    executionPermission: "unrestricted",
    executionProvenance: null,
    fileEvidence: [],
    githubBrokerPolicy: null,
    id: RUN_ID,
    logCursor: 1,
    operationId: OPERATION_ID,
    output: "",
    queueSequence: 1,
    requestHash: "a".repeat(64),
    startedAt: null,
    status: "queued",
    task: "Do the thing.",
    teamStepId: null,
    tenant: PRINCIPAL.tenant,
    version: 1,
  };
  const snapshot = (): RunSnapshot => ({
    agentId: persisted.agentId,
    apiVersion: AGENT_RUNNER_API_VERSION,
    commandEvidence: persisted.commandEvidence,
    completedAt: persisted.completedAt?.toISOString() ?? null,
    createdAt: persisted.createdAt.toISOString(),
    error: persisted.error,
    fileEvidence: persisted.fileEvidence,
    id: persisted.id,
    operationId: persisted.operationId,
    output: persisted.output,
    startedAt: persisted.startedAt?.toISOString() ?? null,
    status: persisted.status,
    task: persisted.task,
  });
  const cleanupTerminalLease = (
    _operator: RunnerOperator,
    authority: RunnerDispatchAuthority
  ) => {
    cleanupAttempts += 1;
    if (cleanupAttempts === 1) {
      return Promise.reject(new Error("simulated cleanup database failure"));
    }
    if (
      persisted.id !== authority.runId ||
      persisted.version !== authority.expectedVersion ||
      persisted.dispatchLeaseToken !== authority.leaseToken
    ) {
      return Promise.resolve({ kind: "stale_version" as const });
    }
    persisted = {
      ...persisted,
      dispatchLeaseExpiresAt: null,
      dispatchLeaseToken: null,
      version: persisted.version + 1,
    };
    return Promise.resolve({ kind: "updated" as const, value: persisted });
  };
  const cancellationStore = {
    cleanupTerminalLease,
    finalizeRun: (
      _operator: RunnerOperator,
      input: {
        completedAt: Date;
        expectedVersion: number;
        leaseToken: string;
      }
    ) => {
      persisted = {
        ...persisted,
        completedAt: input.completedAt,
        dispatchState: "terminal",
        status: "cancelled",
        version: persisted.version + 1,
      };
      return Promise.resolve({
        kind: "finalized" as const,
        prunedRunIds: [],
        run: persisted,
      });
    },
    requestRunCancellation: () => {
      if (persisted.dispatchState === "terminal") {
        return Promise.resolve({
          kind: "already_terminal" as const,
          run: persisted,
        });
      }
      persisted = {
        ...persisted,
        cancellationRequestedAt: new Date("2026-08-28T15:00:00.000Z"),
        dispatchLeaseExpiresAt: new Date("2026-08-28T15:01:00.000Z"),
        dispatchLeaseToken: "cancel-lease",
        version: persisted.version + 1,
      };
      return Promise.resolve({
        authority: {
          expectedVersion: persisted.version,
          leaseToken: persisted.dispatchLeaseToken,
          runId: persisted.id,
        } as RunnerDispatchAuthority,
        kind: "requested" as const,
        run: persisted,
      });
    },
  };
  const cancelRun = (runId: string) =>
    cancelRunnerRun(runId, {
      clock: () => new Date("2026-08-28T15:00:00.000Z"),
      operator: OPERATOR,
      provider: {
        resolveExecutionContext: () =>
          Promise.reject(new Error("must not resolve")),
        stop: () => Promise.reject(new Error("must not stop")),
      },
      rollbackCredentialResources: () => Promise.resolve(),
      store: cancellationStore as never,
    });
  const service = createRunnerService({
    cancelRun,
    store: baseStore({ getRun: async () => snapshot() }),
  });

  assert.deepEqual(await service.stopRun(PRINCIPAL, RUN_ID), {
    kind: "unavailable",
    source: "database",
  });
  assert.equal(persisted.dispatchState, "terminal");
  assert.equal(persisted.daytonaAttemptId, null);
  assert.equal(persisted.dispatchLeaseToken, "cancel-lease");

  const reconciliation = await reconcileAndDispatch({
    operator: OPERATOR,
    provider: {
      resolveExecutionContext: () =>
        Promise.reject(new Error("must not resolve")),
      stop: () => Promise.reject(new Error("must not stop")),
    },
    store: {
      cleanupTerminalLease,
      scanExpiredDispatchLeases: async () => [],
      scanTerminalLeaseCleanups: async () => [persisted],
    } as never,
  });

  assert.equal(reconciliation.terminalLeaseCleaned, 1);
  assert.equal(persisted.dispatchLeaseToken, null);
  const stopped = await service.stopRun(PRINCIPAL, RUN_ID);
  assert.equal(stopped.kind, "stopped");
  assert.equal(stopped.kind === "stopped" && stopped.run.status, "cancelled");
});

test("stop preserves cancellation in-progress and cleanup-required outcomes", async () => {
  const outcomes = [
    ["in_progress", "in_progress"],
    ["cleanup_required", "cleanup_required"],
    ["sandbox_reset_required", "sandbox_reset_required"],
    ["stale_version", "stale_version"],
  ] as const;

  await Promise.all(
    outcomes.map(async ([cancelKind, expectedKind]) => {
      const service = createRunnerService({
        cancelRun: async () => ({ kind: cancelKind, runId: RUN_ID }),
        store: baseStore(),
      });
      const result = await service.stopRun(PRINCIPAL, RUN_ID);
      assert.equal(result.kind, expectedKind);
      if (result.kind === "in_progress") {
        assert.equal(result.run.id, RUN_ID);
        assert.equal(result.scheduleReconciliation, true);
      }
    })
  );
});

test("stop preserves provider and database cancellation unavailability", async () => {
  const outcomes = ["provider", "database"] as const;
  await Promise.all(
    outcomes.map(async (source) => {
      const service = createRunnerService({
        cancelRun: async () => ({
          kind: "unavailable" as const,
          runId: RUN_ID,
          source,
        }),
        store: baseStore(),
      });
      assert.deepEqual(await service.stopRun(PRINCIPAL, RUN_ID), {
        kind: "unavailable",
        source,
      });
    })
  );
});

test("stop reports retryable database unavailability", async () => {
  const service = createRunnerService({
    cancelRun: async () => ({ kind: "cancelled", runId: RUN_ID }),
    store: baseStore({
      getRun: () => Promise.reject(new Error("database=private-detail")),
    }),
  });

  assert.deepEqual(await service.stopRun(PRINCIPAL, RUN_ID), {
    kind: "unavailable",
    source: "database",
  });
});

test("prewarm targets the most recently used agent without credential access", async () => {
  const warmed: string[] = [];
  const controller = new AbortController();
  const deadline = Date.now() + 5000;
  let receivedOptions: unknown;
  const service = createRunnerService({
    clock: () => new Date("2026-08-28T16:00:00.000Z"),
    resourceLifecycle: {
      decommission: () => Promise.reject(new Error("must not decommission")),
      prewarm: (_principal, target, options) => {
        warmed.push(target.id);
        receivedOptions = options;
        return Promise.resolve({
          agent: agent({
            id: target.id,
            warmStatus: "provisioning",
            warmUpdatedAt: new Date("2026-08-28T16:00:00.000Z"),
          }),
          kind: "in_progress" as const,
        });
      },
    },
    store: baseStore({
      listAgents: async () => [
        agent({
          id: AGENT_ID,
          lastRunAt: new Date("2026-08-28T15:00:00.000Z"),
        }),
        agent({
          id: OTHER_AGENT_ID,
          lastRunAt: new Date("2026-08-28T15:30:00.000Z"),
        }),
      ],
    }),
  });

  assert.deepEqual(
    await service.prewarmMostRecent(PRINCIPAL, {
      deadline,
      signal: controller.signal,
    }),
    {
      agentId: OTHER_AGENT_ID,
      kind: "in_progress",
      warm: {
        status: "provisioning",
        updatedAt: "2026-08-28T16:00:00.000Z",
      },
    }
  );
  assert.deepEqual(warmed, [OTHER_AGENT_ID]);
  assert.deepEqual(receivedOptions, {
    deadline,
    signal: controller.signal,
  });
});

test("prewarm and warm reject unsupported harnesses before sandbox mutation or provider work", async () => {
  let warmCalls = 0;
  const unsupported = agent({ runtime: "codex" });
  const service = createRunnerService({
    resourceLifecycle: {
      decommission: () => Promise.reject(new Error("must not decommission")),
      prewarm: () => {
        warmCalls += 1;
        return Promise.resolve({
          agent: unsupported,
          kind: "in_progress" as const,
        });
      },
    },
    store: baseStore({
      getAgent: async () => unsupported,
      listAgents: async () => [unsupported],
    }),
  });

  assert.deepEqual(await service.prewarmMostRecent(PRINCIPAL), {
    kind: "unsupported_harness",
  });
  assert.deepEqual(await service.warmAgent(PRINCIPAL, AGENT_ID), {
    kind: "unsupported_harness",
  });
  assert.equal(warmCalls, 0);
});

test("warm reports ready, in-progress, stale, missing, unavailable, and rejected outcomes", async () => {
  const readyAgent = agent({
    warmStatus: "ready",
    warmUpdatedAt: new Date("2026-08-28T16:00:00.000Z"),
  });
  const progressingAgent = agent({
    warmStatus: "provisioning",
    warmUpdatedAt: new Date("2026-08-28T16:01:00.000Z"),
  });
  const outcomes = [
    [
      { agent: readyAgent, kind: "ready" },
      {
        kind: "ready",
        warm: {
          status: "ready",
          updatedAt: "2026-08-28T16:00:00.000Z",
        },
      },
    ],
    [
      { agent: progressingAgent, kind: "in_progress" },
      {
        kind: "in_progress",
        warm: {
          status: "provisioning",
          updatedAt: "2026-08-28T16:01:00.000Z",
        },
      },
    ],
    [{ kind: "not_found" }, { kind: "not_found" }],
    [{ kind: "stale_version" }, { kind: "stale_version" }],
    [
      { kind: "unavailable", source: "provider" },
      { kind: "unavailable", source: "provider" },
    ],
    [{ kind: "provider_rejected" }, { kind: "provider_rejected" }],
  ] as const;

  await Promise.all(
    outcomes.map(async ([providerResult, expected]) => {
      const service = createRunnerService({
        resourceLifecycle: {
          decommission: () =>
            Promise.reject(new Error("must not decommission")),
          prewarm: async () => providerResult as never,
        },
        store: baseStore(),
      });
      assert.deepEqual(await service.warmAgent(PRINCIPAL, AGENT_ID), expected);
    })
  );
});

test("prewarm exposes concurrency and typed provider/database failures", async () => {
  const outcomes = [
    [
      {
        agent: agent({
          warmStatus: "provisioning",
          warmUpdatedAt: new Date("2026-08-28T16:01:00.000Z"),
        }),
        kind: "in_progress",
      },
      {
        agentId: AGENT_ID,
        kind: "in_progress",
        warm: {
          status: "provisioning",
          updatedAt: "2026-08-28T16:01:00.000Z",
        },
      },
    ],
    [{ kind: "stale_version" }, { kind: "stale_version" }],
    [
      { kind: "unavailable", source: "provider" },
      { kind: "unavailable", source: "provider" },
    ],
    [{ kind: "provider_rejected" }, { kind: "provider_rejected" }],
  ] as const;

  await Promise.all(
    outcomes.map(async ([providerResult, expected]) => {
      const service = createRunnerService({
        resourceLifecycle: {
          decommission: () =>
            Promise.reject(new Error("must not decommission")),
          prewarm: async () => providerResult as never,
        },
        store: baseStore(),
      });
      assert.deepEqual(await service.prewarmMostRecent(PRINCIPAL), expected);
    })
  );

  const unavailable = createRunnerService({
    store: baseStore({
      listAgents: () => Promise.reject(new Error("database=private-detail")),
    }),
  });
  assert.deepEqual(await unavailable.prewarmMostRecent(PRINCIPAL), {
    kind: "unavailable",
    source: "database",
  });
});
