import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_RUNNER_API_VERSION,
  runEventSchema,
  runSnapshotSchema,
} from "@opencoven/agent-contracts";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { MAX_EVENTS_PER_RUN } from "./evidence";
import { createRunnerStore, type RunnerStoreStatement } from "./store";
import type {
  RunnerAgentRecord,
  RunnerOperator,
  RunnerPrincipal,
  RunnerRunRecord,
} from "./types";

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

function agent(overrides: Partial<RunnerAgentRecord> = {}): RunnerAgentRecord {
  return {
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    daytonaSandboxId: null,
    description: "",
    id: "00000000-0000-4000-8000-000000000001",
    instructions: "test instructions",
    lastRunAt: null,
    model: "test-model",
    name: "test",
    runtime: "cloud",
    sandboxGeneration: 0,
    sandboxLifecycle: "unprovisioned",
    status: "idle",
    tenant: principal.tenant,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    version: 0,
    warmStatus: "not_started",
    warmUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
    workspace: null,
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
  const { statements, store } = scripted([current], [updated], [event], []);

  const result = await store.appendEvent(principal, {
    event: { output: "progress", type: "output" },
    expectedVersion: 2,
    leaseToken: "lease-a",
    runId: current.id,
  });

  assert.equal(result.kind, "appended");
  assert.equal(result.kind === "appended" && result.event.eventId, 42);
  assert.equal(statements[1]?.args.eventId, 42);
  assert.equal(statements[2]?.args.eventId, 42);
  assert.equal(statements[3]?.name, "prune-run-events-after-append");
  assert.equal(statements[3]?.args.maxEvents, MAX_EVENTS_PER_RUN);
  assert.match(
    queryText(statements[3] as RunnerStoreStatement),
    /DELETE FROM "RunnerRunEvent"/
  );
  assert.match(
    queryText(statements[3] as RunnerStoreStatement),
    /ORDER BY "eventId" DESC\s+OFFSET \$\d+/
  );
  const [lockedStatement] = statements;
  assert.ok(lockedStatement);
  assert.match(queryText(lockedStatement), /FOR UPDATE/);
  assert.match(
    queryText(statements[1] as RunnerStoreStatement),
    /"dispatchState" = 'running'/
  );
  assert.match(
    queryText(statements[1] as RunnerStoreStatement),
    /"dispatchLeaseExpiresAt" > clock_timestamp\(\)/
  );
  assert.equal("now" in (statements[1] as RunnerStoreStatement).args, false);
});

test("event retention prunes only the oldest rows in the append transaction", async () => {
  const current = run({
    dispatchState: "running",
    logCursor: MAX_EVENTS_PER_RUN,
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    status: "running",
  });
  const updated = run({
    ...current,
    logCursor: MAX_EVENTS_PER_RUN + 1,
    version: current.version + 1,
  });
  const inserted = {
    createdAt: new Date(),
    event: {
      id: MAX_EVENTS_PER_RUN + 1,
      output: "newest",
      type: "output",
    } as const,
    eventId: MAX_EVENTS_PER_RUN + 1,
    runId: current.id,
  };
  const { statements, store } = scripted([current], [updated], [inserted], []);

  const result = await store.appendEvent(principal, {
    event: { output: "newest", type: "output" },
    expectedVersion: current.version,
    leaseToken: current.dispatchLeaseToken as string,
    runId: current.id,
  });

  assert.equal(result.kind, "appended");
  assert.deepEqual(
    statements.map((entry) => entry.name),
    [
      "lock-principal-run",
      "update-run-after-event",
      "insert-run-event",
      "prune-run-events-after-append",
    ]
  );
  assert.match(
    queryText(statements[3] as RunnerStoreStatement),
    /WHERE "runId" = \$\d+[\s\S]*AND "eventId" IN/
  );
});

test("finalization retains the terminal event when the live history is at capacity", async () => {
  const startedAt = new Date("2026-01-01T00:00:00.000Z");
  const current = run({
    dispatchState: "running",
    logCursor: MAX_EVENTS_PER_RUN,
    startedAt,
    status: "running",
  });
  const finalized = run({
    completedAt: new Date("2026-01-01T00:00:01.000Z"),
    dispatchState: "terminal",
    logCursor: MAX_EVENTS_PER_RUN + 1,
    startedAt,
    status: "completed",
    version: current.version + 1,
  });
  const { statements, store } = scripted([current], [finalized], [], [], []);

  const result = await store.finalizeRun(operator, {
    commandEvidence: [],
    completedAt: finalized.completedAt as Date,
    expectedVersion: current.version,
    fileEvidence: [],
    leaseToken: current.dispatchLeaseToken as string,
    output: "",
    runId: current.id,
    status: "completed",
  });

  assert.equal(result.kind, "finalized");
  assert.deepEqual(
    statements.map((entry) => entry.name),
    [
      "lock-operator-run",
      "finalize-run",
      "insert-terminal-event",
      "prune-run-events-after-finalize",
      "prune-terminal-runs",
    ]
  );
  const terminalEvent = JSON.parse(
    String((statements[2] as RunnerStoreStatement).args.event)
  );
  assert.equal(terminalEvent.id, MAX_EVENTS_PER_RUN + 1);
  assert.equal(terminalEvent.type, "completed");
  const prune = statements[3] as RunnerStoreStatement;
  assert.equal(prune.args.maxEvents, MAX_EVENTS_PER_RUN);
  assert.equal(prune.args.runId, current.id);
  assert.equal(prune.args.tenant, current.tenant);
  assert.match(queryText(prune), /DELETE FROM "RunnerRunEvent"/);
  assert.match(queryText(prune), /ORDER BY "eventId" DESC\s+OFFSET \$\d+/);
});

test("event reads return the retained stale-resume suffix in bounded cursor order", async () => {
  const retained = [7, 8, 9].map((eventId) => ({
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    event: {
      at: "2026-01-01T00:00:00.000Z",
      id: eventId,
      output: `event ${eventId}`,
      type: "output",
    } as const,
    eventId,
    runId: "run",
  }));
  const { statements, store } = scripted(retained);

  const events = await store.readEventsAfter(principal, "run", 1);

  assert.deepEqual(
    events.map((event) => event.eventId),
    [7, 8, 9]
  );
  assert.equal(statements[0]?.args.afterEventId, 1);
  assert.equal(statements[0]?.args.maxEvents, MAX_EVENTS_PER_RUN);
  assert.match(
    queryText(statements[0] as RunnerStoreStatement),
    /ORDER BY "RunnerRunEvent"\."eventId" ASC\s+LIMIT \$\d+/
  );
});

test("stale versions are rejected before an event write", async () => {
  const { statements, store } = scripted([run({ version: 9 })]);

  const result = await store.appendEvent(principal, {
    event: { output: "progress", type: "output" },
    expectedVersion: 8,
    leaseToken: "lease-a",
    runId: run().id,
  });

  assert.deepEqual(result, { kind: "stale_version" });
  assert.equal(statements.length, 1);
});

test("database-clock lease fences and dispatch state prevent event appends", async () => {
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
    runId: run().id,
  };

  assert.deepEqual(await expired.store.appendEvent(principal, input), {
    kind: "lease_lost",
  });
  assert.deepEqual(await nonLive.store.appendEvent(principal, input), {
    kind: "not_live",
  });
  assert.equal(expired.statements.length, 2);
  assert.equal(nonLive.statements.length, 1);
  assert.match(
    queryText(expired.statements[1] as RunnerStoreStatement),
    /"dispatchLeaseExpiresAt" > clock_timestamp\(\)/
  );
});

test("lease fencing rejects a stale dispatcher", async () => {
  const { statements, store } = scripted([run({ dispatchLeaseToken: "new" })]);

  const result = await store.markDispatchRunning(operator, {
    expectedVersion: 7,
    leaseToken: "old",
    runId: run().id,
  });

  assert.deepEqual(result, { kind: "lease_lost" });
  assert.equal(statements.length, 1);
});

test("all live lease mutations predicate against the database clock", async () => {
  const dispatching = run();
  const running = run({
    dispatchState: "running",
    startedAt: new Date("2026-01-01T00:00:01.000Z"),
    status: "running",
  });
  const terminal = run({
    completedAt: new Date("2026-01-01T00:00:02.000Z"),
    dispatchState: "terminal",
    startedAt: running.startedAt,
    status: "completed",
    version: running.version + 1,
  });
  const mark = scripted([dispatching], [running]);
  const renew = scripted([running], [run({ ...running, version: 8 })]);
  const finalize = scripted([running], [terminal], [], []);

  await mark.store.markDispatchRunning(operator, {
    expectedVersion: dispatching.version,
    leaseToken: "lease-a",
    runId: dispatching.id,
  });
  await renew.store.renewDispatchLease(operator, {
    expectedVersion: running.version,
    leaseExpiresAt: new Date("2026-01-01T00:05:00.000Z"),
    leaseToken: "lease-a",
    runId: running.id,
  });
  await finalize.store.finalizeRun(operator, {
    commandEvidence: [],
    completedAt: terminal.completedAt as Date,
    expectedVersion: running.version,
    fileEvidence: [],
    leaseToken: "lease-a",
    output: "",
    runId: running.id,
    status: "completed",
  });

  for (const statement of [
    mark.statements[1],
    renew.statements[1],
    finalize.statements[1],
  ]) {
    assert.ok(statement);
    assert.match(
      queryText(statement),
      /"dispatchLeaseExpiresAt" > clock_timestamp\(\)/
    );
    assert.equal("now" in statement.args, false);
  }
});

test("expired dispatch recovery requeues only ID-free rows with a database-clock fence", async () => {
  const current = run();
  const requeued = run({
    dispatchLeaseExpiresAt: null,
    dispatchLeaseToken: null,
    dispatchState: "queued",
    startedAt: null,
    version: current.version + 1,
  });
  const { statements, store } = scripted([current], [requeued]);

  const result = await store.requeueExpiredDispatch(operator, {
    expectedDispatchState: "dispatching",
    oldLeaseToken: current.dispatchLeaseToken as string,
    runId: current.id,
  });

  assert.equal(result.kind, "requeued");
  assert.equal(result.kind === "requeued" && result.value.version, 8);
  const update = statements[1] as RunnerStoreStatement;
  assert.match(
    queryText(update),
    /"dispatchLeaseExpiresAt" <= clock_timestamp\(\)/
  );
  assert.match(queryText(update), /"daytonaSessionId" IS NULL/);
  assert.match(queryText(update), /"daytonaCommandId" IS NULL/);
  assert.match(queryText(update), /"startedAt" = NULL/);
});

test("expired dispatch recovery reports stale, non-expired, and provider-attached rows", async () => {
  const current = run();
  const stale = scripted([run({ dispatchLeaseToken: "newer-lease" })]);
  const unexpired = scripted([current], []);
  const attached = scripted([run({ daytonaSessionId: "session" })]);

  const input = {
    expectedDispatchState: "dispatching" as const,
    oldLeaseToken: "lease-a",
    runId: current.id,
  };
  assert.deepEqual(await stale.store.requeueExpiredDispatch(operator, input), {
    kind: "lease_lost",
  });
  assert.deepEqual(
    await unexpired.store.requeueExpiredDispatch(operator, input),
    { kind: "not_expired" }
  );
  assert.deepEqual(
    await attached.store.requeueExpiredDispatch(operator, input),
    { kind: "provider_identifiers_attached" }
  );
  assert.equal(stale.statements.length, 1);
  assert.equal(unexpired.statements.length, 2);
  assert.equal(attached.statements.length, 1);
});

test("expired dispatch recovery adopts a new lease with the expected live state", async () => {
  const current = run({
    daytonaCommandId: "command",
    daytonaSessionId: "session",
  });
  const adopted = run({
    daytonaCommandId: "command",
    daytonaSessionId: "session",
    dispatchLeaseExpiresAt: new Date("2026-01-01T00:05:00.000Z"),
    dispatchLeaseToken: "replacement-lease",
    version: current.version + 1,
  });
  const { statements, store } = scripted([current], [adopted]);
  const input = {
    expectedDispatchState: "dispatching",
    leaseExpiresAt: adopted.dispatchLeaseExpiresAt as Date,
    newLeaseToken: "replacement-lease",
    oldLeaseToken: "lease-a",
    runId: current.id,
  } as const;

  const result = await store.adoptExpiredDispatchLease(operator, input);

  assert.equal(result.kind, "adopted");
  assert.equal(
    result.kind === "adopted" && result.value.dispatchLeaseToken,
    "replacement-lease"
  );
  const update = statements[1] as RunnerStoreStatement;
  assert.match(
    queryText(update),
    /"dispatchLeaseExpiresAt" <= clock_timestamp\(\)/
  );
  assert.match(queryText(update), /"dispatchState" = \$\d+/);

  const stale = scripted([run({ dispatchLeaseToken: "newer-lease" })]);
  assert.deepEqual(
    await stale.store.adoptExpiredDispatchLease(operator, input),
    { kind: "lease_lost" }
  );
  assert.equal(stale.statements.length, 1);
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
  const create = scripted([]);
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
    expectedVersion: 0,
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
    [updated],
    [{ id: dispatching.agentId }]
  );

  const result = await store.attachDaytonaIdentifiers(operator, {
    commandId: "command",
    expectedVersion: dispatching.version,
    leaseToken: "lease-a",
    runId: dispatching.id,
    sandboxGeneration: 1,
    sandboxId: "sandbox",
    sessionId: "session",
  });

  assert.equal(result.kind, "updated");
  const [, , update] = statements;
  assert.ok(update);
  assert.equal(update.args.tenant, dispatching.tenant);
  assert.match(queryText(update), /"tenant"\s*=\s*\$\d+/);
  assert.match(
    queryText(update),
    /"dispatchLeaseExpiresAt" > clock_timestamp\(\)/
  );
  assert.equal("now" in update.args, false);
  const sandboxUpdate = statements[3] as RunnerStoreStatement;
  assert.match(queryText(sandboxUpdate), /"version" = "version" \+ 1/);
});

test("agent updates use integer versions", async () => {
  const current = agent({ version: 4 });
  const updated = agent({ version: 5 });
  const update = scripted([updated]);

  const result = await update.store.updateAgent(principal, {
    description: "updated",
    expectedVersion: current.version,
    id: current.id,
    instructions: current.instructions,
    model: current.model,
    name: current.name,
    runtime: current.runtime,
    workspace: current.workspace,
  });

  assert.equal(result.kind, "updated");
  assert.equal(result.kind === "updated" && result.value.version, 5);
  const query = queryText(update.statements[0] as RunnerStoreStatement);
  assert.match(query, /"version" = "version" \+ 1/);
  assert.match(query, /AND "version" = \$\d+/);
  assert.doesNotMatch(query, /"updatedAt" = \$\d+/);
});

test("raw database rows serialize nullable errors in canonical snapshots", async () => {
  const raw: Record<string, unknown> = {
    ...run({
      commandEvidence: [
        {
          command: "echo complete",
          exitCode: 0,
          stderr: "",
          stdout: "complete",
        },
      ],
      fileEvidence: [{ operation: "create", path: "/workspace/result.txt" }],
    }),
    error: null,
  };
  const { store } = scripted([raw]);

  const snapshot = await store.getRun(principal, String(raw.id));
  const serialized = JSON.parse(JSON.stringify(snapshot));

  assert.equal("apiVersion" in raw, false);
  assert.equal(snapshot?.apiVersion, AGENT_RUNNER_API_VERSION);
  assert.equal(runSnapshotSchema.safeParse(serialized).success, true);
  assert.equal(Object.hasOwn(serialized, "error"), true);
  assert.equal(serialized.error, null);
});

test("terminal events serialize nullable errors from raw database rows", async () => {
  const startedAt = new Date("2026-01-01T00:00:01.000Z");
  const current: Record<string, unknown> = {
    ...run({
      dispatchState: "running",
      startedAt,
      status: "running",
    }),
    error: null,
  };
  const finalized: Record<string, unknown> = {
    ...run({
      completedAt: new Date("2026-01-01T00:00:02.000Z"),
      dispatchState: "terminal",
      startedAt,
      status: "completed",
      version: 8,
    }),
    error: null,
  };
  const { statements, store } = scripted([current], [finalized], [], []);

  const result = await store.finalizeRun(operator, {
    commandEvidence: [],
    completedAt: finalized.completedAt as Date,
    expectedVersion: 7,
    fileEvidence: [],
    leaseToken: "lease-a",
    output: "",
    runId: String(finalized.id),
    status: "completed",
  });

  assert.equal(result.kind, "finalized");
  assert.equal(
    result.kind === "finalized" && Object.hasOwn(result.run, "error"),
    true
  );
  assert.equal(result.kind === "finalized" && result.run.error, null);
  const event = JSON.parse(
    String((statements[2] as RunnerStoreStatement).args.event)
  );
  assert.equal(runEventSchema.safeParse(event).success, true);
  assert.equal(Object.hasOwn(event.run, "error"), true);
  assert.equal(event.run.error, null);
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

test("sandbox generation reservation locks and fences the stored ID", async () => {
  const current = agent({
    daytonaSandboxId: "old-sandbox",
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
  const { statements, store } = scripted([current], [reserved]);

  const result = await store.reserveDaytonaSandbox(principal, {
    agentId: current.id,
    expectedGeneration: current.sandboxGeneration,
    expectedSandboxId: current.daytonaSandboxId,
    expectedVersion: current.version,
  });

  assert.equal(result.kind, "reserved");
  assert.deepEqual(
    statements.map((item) => item.name),
    [
      "lock-agent-for-daytona-sandbox-reservation",
      "reserve-daytona-sandbox-generation",
    ]
  );
  assert.match(queryText(statements[0] as RunnerStoreStatement), /FOR UPDATE/u);
  const query = queryText(statements[1] as RunnerStoreStatement);
  assert.match(query, /"sandboxGeneration" = "sandboxGeneration" \+ 1/u);
  assert.match(query, /"sandboxLifecycle" = 'provisioning'/u);
  assert.match(query, /"daytonaSandboxId" IS NOT DISTINCT FROM/u);
});

test("warm and decommission transitions retain generation and version fences", async () => {
  const current = agent({
    daytonaSandboxId: "sandbox",
    sandboxGeneration: 2,
    sandboxLifecycle: "ready",
    version: 3,
  });
  const warming = agent({ ...current, version: 4, warmStatus: "provisioning" });
  const decommissioning = agent({
    ...warming,
    sandboxLifecycle: "decommissioning",
    version: 5,
  });
  const { statements, store } = scripted(
    [current],
    [warming],
    [current],
    [],
    [decommissioning],
    [{ id: current.id }]
  );

  assert.equal(
    (
      await store.beginDaytonaSandboxWarm(principal, {
        agentId: current.id,
        expectedGeneration: current.sandboxGeneration,
        expectedVersion: current.version,
      })
    ).kind,
    "started"
  );
  assert.equal(
    (await store.beginDaytonaSandboxDecommission(principal, current.id)).kind,
    "decommissioning"
  );
  assert.equal(
    (
      await store.deleteDecommissionedAgent(principal, {
        agentId: current.id,
        expectedGeneration: current.sandboxGeneration,
        expectedVersion: decommissioning.version,
      })
    ).kind,
    "deleted"
  );

  const warmQuery = queryText(statements[1] as RunnerStoreStatement);
  const decommissionQuery = queryText(statements[4] as RunnerStoreStatement);
  const deleteQuery = queryText(statements[5] as RunnerStoreStatement);
  assert.match(warmQuery, /"warmStatus" = 'provisioning'/u);
  assert.match(warmQuery, /"sandboxGeneration" = \$/u);
  assert.match(decommissionQuery, /"sandboxLifecycle" = 'decommissioning'/u);
  assert.match(deleteQuery, /"sandboxLifecycle" = 'decommissioning'/u);
  assert.match(deleteQuery, /"version" = \$/u);
});

test("durable decommissioning resumes with its current generation and provider ID", async () => {
  const decommissioning = agent({
    daytonaSandboxId: "sandbox-after-crash",
    sandboxGeneration: 8,
    sandboxLifecycle: "decommissioning",
    version: 13,
  });
  const { statements, store } = scripted([decommissioning]);

  const result = await store.beginDaytonaSandboxDecommission(
    principal,
    decommissioning.id
  );

  assert.deepEqual(result, { kind: "decommissioning", value: decommissioning });
  assert.deepEqual(
    statements.map((item) => item.name),
    ["lock-agent-for-daytona-decommission"]
  );
  assert.equal(
    result.kind === "decommissioning" && result.value.daytonaSandboxId,
    "sandbox-after-crash"
  );
  assert.equal(
    result.kind === "decommissioning" && result.value.sandboxGeneration,
    8
  );
});

test("permanent decommission failures persist error, warm, and lifecycle state", async () => {
  const decommissioning = agent({
    daytonaSandboxId: "sandbox",
    sandboxGeneration: 2,
    sandboxLifecycle: "decommissioning",
    version: 5,
  });
  const failed = agent({
    ...decommissioning,
    sandboxLifecycle: "decommission_failed",
    status: "error",
    version: 6,
    warmStatus: "failed",
  });
  const { statements, store } = scripted([failed]);

  assert.deepEqual(
    await store.failDaytonaSandboxDecommission(principal, {
      agentId: decommissioning.id,
      expectedGeneration: decommissioning.sandboxGeneration,
      expectedVersion: decommissioning.version,
    }),
    { kind: "updated", value: failed }
  );

  const query = queryText(statements[0] as RunnerStoreStatement);
  assert.match(query, /"sandboxLifecycle" = 'decommission_failed'/u);
  assert.match(query, /"status" = 'error'/u);
  assert.match(query, /"warmStatus" = 'failed'/u);
  assert.match(query, /"warmUpdatedAt" = now\(\)/u);
});

test("the production statement shape remains Drizzle-safe", () => {
  const statement: RunnerStoreStatement = {
    args: {},
    name: "shape",
    query: sql`SELECT 1`,
  };
  assert.equal(queryText(statement), "SELECT 1");
});
