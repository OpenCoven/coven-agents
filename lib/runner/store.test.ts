import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_RUNNER_API_VERSION } from "@opencoven/agent-contracts";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { createRunnerStore, type RunnerStoreStatement } from "./store";
import type { RunnerOperator, RunnerPrincipal, RunnerRunRecord } from "./types";

const principal: RunnerPrincipal = {
  kind: "subscriber",
  tenant: "tenant_a",
  userId: "user_a",
};
const operator: RunnerOperator = { kind: "runner-operator" };
const dialect = new PgDialect();

function queryText(statement: RunnerStoreStatement): string {
  return dialect.sqlToQuery(statement.query).sql;
}

function run(overrides: Partial<RunnerRunRecord> = {}): RunnerRunRecord {
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    apiVersion: AGENT_RUNNER_API_VERSION,
    commandEvidence: [],
    completedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    daytonaCommandId: null,
    daytonaSessionId: null,
    dispatchLeaseExpiresAt: new Date("2026-01-01T00:01:00.000Z"),
    dispatchLeaseToken: "lease-a",
    dispatchState: "dispatching",
    error: null,
    fileEvidence: [],
    id: "00000000-0000-4000-8000-000000000002",
    logCursor: 3,
    operationId: "00000000-0000-4000-8000-000000000003",
    output: "",
    queueSequence: 1,
    requestHash: "a".repeat(64),
    startedAt: null,
    status: "queued",
    task: "test task",
    tenant: "tenant_a",
    version: 7,
    ...overrides,
  };
}

function scripted(...responses: Record<string, unknown>[][]) {
  const statements: RunnerStoreStatement[] = [];
  const store = createRunnerStore({
    transaction: (callback) =>
      callback({
        execute: <Row extends Record<string, unknown>>(
          statement: RunnerStoreStatement
        ) => {
          statements.push(statement);
          return Promise.resolve((responses.shift() ?? []) as Row[]);
        },
      }),
  });
  return { statements, store };
}

test("principal methods bind every read and mutation to its tenant", async () => {
  const { statements, store } = scripted([], [], [], []);
  await store.getAgent(principal, "agent");
  await store.listAgentRuns(principal, "agent");
  await store.getRun(principal, "run");
  await store.readEventsAfter(principal, "run", 0);

  for (const statement of statements) {
    assert.equal(statement.args.tenant, principal.tenant);
    assert.match(queryText(statement), /"tenant"\s*=\s*\$\d+/);
  }
});

test("duplicate starts return the immutable matching request", async () => {
  const existing = run();
  const { store } = scripted([{ id: existing.agentId }], [], [existing]);

  const result = await store.startRun(principal, {
    agentId: existing.agentId,
    id: existing.id,
    operationId: existing.operationId,
    requestHash: existing.requestHash,
    task: existing.task,
  });

  assert.equal(result.kind, "duplicate");
  assert.equal(result.kind === "duplicate" && result.run.id, existing.id);
  assert.equal(
    result.kind === "duplicate" && "dispatchLeaseToken" in result.run,
    false
  );
});

test("reusing an operation with another request hash conflicts", async () => {
  const existing = run();
  const { store } = scripted([{ id: existing.agentId }], [], [existing]);

  const result = await store.startRun(principal, {
    agentId: existing.agentId,
    id: existing.id,
    operationId: existing.operationId,
    requestHash: "b".repeat(64),
    task: existing.task,
  });

  assert.equal(result.kind, "conflict");
  assert.equal(result.kind === "conflict" && result.run.id, existing.id);
});

test("event ids advance from the locked run cursor and update atomically", async () => {
  const now = new Date("2026-01-01T00:00:01.000Z");
  const current = run({
    dispatchState: "running",
    logCursor: 41,
    startedAt: now,
    status: "running",
    version: 2,
  });
  const updated = run({
    dispatchState: "running",
    logCursor: 42,
    startedAt: now,
    status: "running",
    version: 3,
  });
  const event = {
    createdAt: new Date(),
    event: { id: 42, output: "progress", type: "output" } as const,
    eventId: 42,
    runId: current.id,
  };
  const { statements, store } = scripted([current], [updated], [event]);

  const result = await store.appendEvent(principal, {
    event: { output: "progress", type: "output" },
    expectedVersion: 2,
    leaseToken: "lease-a",
    now,
    runId: current.id,
  });

  assert.equal(result.kind, "appended");
  assert.equal(result.kind === "appended" && result.event.eventId, 42);
  assert.equal(statements[1]?.args.eventId, 42);
  assert.equal(statements[2]?.args.eventId, 42);
  const [lockedStatement] = statements;
  assert.ok(lockedStatement);
  assert.match(queryText(lockedStatement), /FOR UPDATE/);
  assert.match(
    queryText(statements[1] as RunnerStoreStatement),
    /"dispatchState" = 'running'/
  );
});

test("stale versions are rejected before an event write", async () => {
  const { statements, store } = scripted([run({ version: 9 })]);

  const result = await store.appendEvent(principal, {
    event: { output: "progress", type: "output" },
    expectedVersion: 8,
    leaseToken: "lease-a",
    now: new Date("2026-01-01T00:00:01.000Z"),
    runId: run().id,
  });

  assert.deepEqual(result, { kind: "stale_version" });
  assert.equal(statements.length, 1);
});

test("expired and non-live dispatches cannot append events", async () => {
  const now = new Date("2026-01-01T00:01:00.000Z");
  const expired = scripted([
    run({
      dispatchState: "running",
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      status: "running",
    }),
  ]);
  const nonLive = scripted([
    run({
      dispatchLeaseExpiresAt: new Date("2026-01-01T00:02:00.000Z"),
      dispatchState: "terminal",
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      status: "completed",
    }),
  ]);
  const input = {
    event: { output: "progress", type: "output" } as const,
    expectedVersion: 7,
    leaseToken: "lease-a",
    now,
    runId: run().id,
  };

  assert.deepEqual(await expired.store.appendEvent(principal, input), {
    kind: "lease_lost",
  });
  assert.deepEqual(await nonLive.store.appendEvent(principal, input), {
    kind: "not_live",
  });
  assert.equal(expired.statements.length, 1);
  assert.equal(nonLive.statements.length, 1);
});

test("lease fencing rejects a stale dispatcher", async () => {
  const { statements, store } = scripted([run({ dispatchLeaseToken: "new" })]);

  const result = await store.markDispatchRunning(operator, {
    expectedVersion: 7,
    leaseToken: "old",
    now: new Date("2026-01-01T00:00:01.000Z"),
    runId: run().id,
  });

  assert.deepEqual(result, { kind: "lease_lost" });
  assert.equal(statements.length, 1);
});

test("terminal retention deletes only terminal runs beyond the newest twenty", async () => {
  const { statements, store } = scripted([{ id: "old-run" }]);
  const deleted = await store.pruneTerminalRuns(principal, "agent");

  assert.deepEqual(deleted, ["old-run"]);
  const [pruneStatement] = statements;
  assert.ok(pruneStatement);
  const query = queryText(pruneStatement);
  assert.match(query, /"status" IN \('completed', 'failed', 'cancelled'\)/);
  assert.match(query, /OFFSET 20/);
  assert.match(query, /"tenant"\s*=\s*\$\d+/);
});

test("global scans require the operator authority and do not manufacture tenant scope", async () => {
  const { statements, store } = scripted([], []);
  await store.scanLiveRuns(operator, 10);
  await store.scanExpiredDispatchLeases(operator, new Date(), 10);

  for (const statement of statements) {
    assert.equal("tenant" in statement.args, false);
    assert.doesNotMatch(queryText(statement), /"tenant"\s*=\s*\$\d+/);
  }
});

test("principal mutations bind every affected row to the principal tenant", async () => {
  const current = run({
    dispatchState: "running",
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    status: "running",
  });
  const append = scripted(
    [current],
    [run({ version: 8 })],
    [
      {
        createdAt: new Date(),
        event: { id: 4, output: "progress", type: "output" },
        eventId: 4,
        runId: current.id,
      },
    ]
  );
  const create = scripted([{}]);
  const update = scripted([], [{ id: current.agentId }]);
  const remove = scripted(
    [{ id: current.agentId }],
    [],
    [{ id: current.agentId }]
  );
  const start = scripted([{ id: current.agentId }], [], [current]);

  await append.store.appendEvent(principal, {
    event: { output: "progress", type: "output" },
    expectedVersion: 7,
    leaseToken: "lease-a",
    now: new Date("2026-01-01T00:00:01.000Z"),
    runId: current.id,
  });
  await create.store.createAgent(principal, {
    id: current.agentId,
    instructions: "test instructions",
    model: "test-model",
    name: "test",
    runtime: "cloud",
  });
  await update.store.updateAgent(principal, {
    description: "",
    expectedUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
    id: current.agentId,
    instructions: "test instructions",
    model: "test-model",
    name: "test",
    runtime: "cloud",
    workspace: null,
  });
  await remove.store.deleteAgent(principal, current.agentId);
  await start.store.startRun(principal, {
    agentId: current.agentId,
    id: current.id,
    operationId: current.operationId,
    requestHash: current.requestHash,
    task: current.task,
  });

  for (const statement of [
    ...append.statements,
    ...create.statements,
    ...update.statements,
    ...remove.statements,
    ...start.statements,
  ]) {
    assert.equal(statement.args.tenant, principal.tenant);
    assert.match(queryText(statement), /"tenant"/);
  }
});

test("Daytona attachment validates mismatches before making any update", async () => {
  const dispatching = run();
  const { statements, store } = scripted(
    [dispatching],
    [{ id: dispatching.agentId, sandboxGeneration: 2 }]
  );

  const result = await store.attachDaytonaIdentifiers(operator, {
    commandId: "command",
    expectedVersion: dispatching.version,
    leaseToken: "lease-a",
    now: new Date("2026-01-01T00:00:01.000Z"),
    runId: dispatching.id,
    sandboxGeneration: 1,
    sandboxId: "sandbox",
    sessionId: "session",
  });

  assert.deepEqual(result, { kind: "generation_mismatch" });
  assert.deepEqual(
    statements.map((statement) => statement.name),
    ["lock-operator-run", "lock-agent-for-daytona-attach"]
  );
});

test("Daytona identifier conflicts cannot partially attach a sandbox", async () => {
  const dispatching = run({ daytonaSessionId: "existing-session" });
  const { statements, store } = scripted([dispatching]);

  const result = await store.attachDaytonaIdentifiers(operator, {
    commandId: "command",
    expectedVersion: dispatching.version,
    leaseToken: "lease-a",
    now: new Date("2026-01-01T00:00:01.000Z"),
    runId: dispatching.id,
    sandboxGeneration: 1,
    sandboxId: "sandbox",
    sessionId: "different-session",
  });

  assert.deepEqual(result, { kind: "stale_version" });
  assert.deepEqual(
    statements.map((statement) => statement.name),
    ["lock-operator-run"]
  );
});

test("Daytona attachment keeps the run update tenant scoped", async () => {
  const dispatching = run();
  const updated = run({ version: dispatching.version + 1 });
  const { statements, store } = scripted(
    [dispatching],
    [{ id: dispatching.agentId, sandboxGeneration: 1 }],
    [updated]
  );

  const result = await store.attachDaytonaIdentifiers(operator, {
    commandId: "command",
    expectedVersion: dispatching.version,
    leaseToken: "lease-a",
    now: new Date("2026-01-01T00:00:01.000Z"),
    runId: dispatching.id,
    sandboxGeneration: 1,
    sessionId: "session",
  });

  assert.equal(result.kind, "updated");
  const [, , update] = statements;
  assert.ok(update);
  assert.equal(update.args.tenant, dispatching.tenant);
  assert.match(queryText(update), /"tenant"\s*=\s*\$\d+/);
});

test("agent deletion and starts serialize through the same agent lock", async () => {
  const current = run();
  const deletion = scripted(
    [{ id: current.agentId }],
    [],
    [{ id: current.agentId }]
  );
  const start = scripted([{ id: current.agentId }], [], [current]);

  assert.deepEqual(
    await deletion.store.deleteAgent(principal, current.agentId),
    { kind: "deleted" }
  );
  await start.store.startRun(principal, {
    agentId: current.agentId,
    id: current.id,
    operationId: current.operationId,
    requestHash: current.requestHash,
    task: current.task,
  });

  assert.deepEqual(
    deletion.statements.map((statement) => statement.name),
    ["lock-agent-for-delete", "find-live-run-for-agent", "delete-idle-agent"]
  );
  assert.deepEqual(
    start.statements.slice(0, 2).map((statement) => statement.name),
    ["lock-agent-for-run-start", "insert-run"]
  );
  for (const statement of [deletion.statements[0], start.statements[0]]) {
    assert.ok(statement);
    assert.match(queryText(statement), /FOR UPDATE/);
    assert.match(queryText(statement), /"tenant"\s*=\s*\$\d+/);
  }
});

test("the production statement shape remains Drizzle-safe", () => {
  const statement: RunnerStoreStatement = {
    args: {},
    name: "shape",
    query: sql`SELECT 1`,
  };
  assert.equal(queryText(statement), "SELECT 1");
});
