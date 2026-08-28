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
  const current = run({ logCursor: 41, version: 2 });
  const updated = run({ logCursor: 42, version: 3 });
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
    runId: current.id,
  });

  assert.equal(result.kind, "appended");
  assert.equal(result.kind === "appended" && result.event.eventId, 42);
  assert.equal(statements[1]?.args.eventId, 42);
  assert.equal(statements[2]?.args.eventId, 42);
  const [lockedStatement] = statements;
  assert.ok(lockedStatement);
  assert.match(queryText(lockedStatement), /FOR UPDATE/);
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

test("the production statement shape remains Drizzle-safe", () => {
  const statement: RunnerStoreStatement = {
    args: {},
    name: "shape",
    query: sql`SELECT 1`,
  };
  assert.equal(queryText(statement), "SELECT 1");
});
