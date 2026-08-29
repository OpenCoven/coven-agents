import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_RUNNER_API_VERSION,
  type RunSnapshot,
} from "@opencoven/agent-contracts";
import { createRunnerService } from "./service";
import type { RunnerAgentRecord, RunnerPrincipal } from "./types";

const AGENT_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_AGENT_ID = "22222222-3333-4444-8555-666666666666";
const RUN_ID = "33333333-4444-4555-8666-777777777777";
const OPERATION_ID = "44444444-5555-4666-8777-888888888888";
const PRINCIPAL: RunnerPrincipal = {
  kind: "subscriber",
  tenant: "u_9c8589018a57479181fe4c455b099bc9",
  userId: "9c858901-8a57-4791-81fe-4c455b099bc9",
};

function agent(overrides: Partial<RunnerAgentRecord> = {}): RunnerAgentRecord {
  return {
    createdAt: new Date("2026-08-28T15:00:00.000Z"),
    daytonaSandboxId: null,
    description: "",
    id: AGENT_ID,
    instructions: "Do the thing.",
    lastRunAt: null,
    model: "auto",
    name: "Runner",
    runtime: "copilot",
    sandboxGeneration: 0,
    sandboxLifecycle: "unprovisioned",
    sandboxUpdatedAt: new Date("2026-08-28T15:00:00.000Z"),
    status: "idle",
    tenant: PRINCIPAL.tenant,
    updatedAt: new Date("2026-08-28T15:00:00.000Z"),
    version: 4,
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
    assert.equal(created.agent.owner.kind, "tenant");
    if (created.agent.owner.kind === "tenant") {
      assert.equal(created.agent.owner.tenantId, PRINCIPAL.tenant);
    }
  }
  assert.deepEqual(
    (createdInput as { principal: RunnerPrincipal }).principal,
    PRINCIPAL
  );

  const ownerInjected = await service.createAgent(
    PRINCIPAL,
    definition({ owner: { kind: "tenant", tenantId: "other" } })
  );
  assert.deepEqual(ownerInjected, { kind: "invalid" });
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

test("agent updates preserve tenant ownership and expose lifecycle conflicts", async () => {
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
    { kind: "lifecycle_conflict" }
  );
  assert.equal(
    (updateInput as { expectedVersion: number }).expectedVersion,
    agent().version
  );
});

test("agent deletion delegates provider-first decommissioning", async () => {
  const calls: string[] = [];
  const service = createRunnerService({
    deleteSandbox: (principal, agentId) => {
      calls.push(`${principal.tenant}:${agentId}`);
      return Promise.resolve({ kind: "deleted" as const });
    },
    store: baseStore(),
  });

  assert.deepEqual(await service.deleteAgent(PRINCIPAL, AGENT_ID), {
    kind: "deleted",
  });
  assert.deepEqual(calls, [`${PRINCIPAL.tenant}:${AGENT_ID}`]);
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

  const started = await service.startRun(PRINCIPAL, AGENT_ID, {
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
        await service.startRun(PRINCIPAL, AGENT_ID, {
          operationId: OPERATION_ID,
          task: "Do the thing.",
        }),
        expected
      );
    })
  );
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

test("prewarm targets the most recently used agent without credential access", async () => {
  const warmed: string[] = [];
  const service = createRunnerService({
    clock: () => new Date("2026-08-28T16:00:00.000Z"),
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
    warmSandbox: (_principal, target) => {
      warmed.push(target.id);
      return Promise.resolve({ kind: "in_progress" as const });
    },
  });

  assert.deepEqual(await service.prewarmMostRecent(PRINCIPAL), {
    agentId: OTHER_AGENT_ID,
    kind: "warmed",
    warm: {
      status: "provisioning",
      updatedAt: "2026-08-28T16:00:00.000Z",
    },
  });
  assert.deepEqual(warmed, [OTHER_AGENT_ID]);
});
