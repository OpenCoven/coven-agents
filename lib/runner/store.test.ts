// biome-ignore-all lint/suspicious/noShadow: Isolated nested fixtures intentionally reuse conventional record names.
import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_RUNNER_API_VERSION,
  runEventSchema,
  runSnapshotSchema,
} from "@opencoven/agent-contracts";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { daytonaDispatchAuthorizers } from "./daytona/dispatch";
import {
  daytonaProbeSessionName,
  daytonaRunSessionName,
} from "./daytona/names";
import {
  hashRunRequest,
  MAX_EVENT_PAGE_BYTES,
  MAX_EVENTS_PER_PAGE,
  MAX_EVENTS_PER_RUN,
  MAX_PERSISTED_EVENT_BYTES_PER_RUN,
} from "./evidence";
import type { RunnerExecutionProvenance } from "./execution-provenance";
import {
  createRunnerStore,
  type RunnerStoreDatabase,
  type RunnerStoreStatement,
} from "./store";
import type {
  RunnerAgentRecord,
  RunnerDaytonaAttemptId,
  RunnerDispatchAuthority,
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
const executionProvenance: RunnerExecutionProvenance = {
  adapterVersion: "daytona-adapter-v1",
  capabilityContractVersion: "hosted-v1",
  lifecycle: "persistent",
  pinnedSnapshot: "coven-agents-copilot-1",
  productExecutionClass: "hosted",
  provider: "daytona",
  target: "us",
};
const retryExecutionProvenance: RunnerExecutionProvenance = {
  ...executionProvenance,
  pinnedSnapshot: "coven-agents-copilot-2",
  target: "eu",
};

function queryText(statement: RunnerStoreStatement): string {
  return dialect.sqlToQuery(statement.query).sql;
}

function queryParams(statement: RunnerStoreStatement): unknown[] {
  return dialect.sqlToQuery(statement.query).params;
}

function postgresTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/(\.\d{3})Z$/u, "$1000");
}

function run(overrides: Partial<RunnerRunRecord> = {}): RunnerRunRecord {
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    agentInstructions: "test instructions",
    agentModel: "test-model",
    agentRuntime: "copilot",
    agentWorkspace: null,
    authorityRevalidation: false,
    authVersion: 1,
    cancellationRequestedAt: null,
    commandEvidence: [],
    completedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    daytonaAttemptId: null,
    daytonaCommandId: null,
    daytonaLogCursor: 0,
    daytonaSessionId: null,
    dispatchLeaseExpiresAt: new Date("2026-01-01T00:01:00.000Z"),
    dispatchLeaseToken: "lease-a",
    dispatchState: "dispatching",
    error: null,
    executionPermission: "unrestricted",
    executionProvenance: null,
    fileEvidence: [],
    githubBrokerPolicy: null,
    id: "00000000-0000-4000-8000-000000000002",
    logCursor: 3,
    operationId: "00000000-0000-4000-8000-000000000003",
    output: "",
    queueSequence: 1,
    requestHash: "a".repeat(64),
    startedAt: null,
    status: "queued",
    task: "test task",
    teamStepId: null,
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
    runtime: "copilot",
    sandboxGeneration: 0,
    sandboxLifecycle: "unprovisioned",
    sandboxTrust: "clean",
    sandboxUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
    status: "idle",
    tenant: principal.tenant,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    version: 0,
    warmAttemptVersion: 0,
    warmStatus: "not_started",
    warmUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
    workspace: null,
    ...overrides,
  };
}

function hasDispatchLease(
  record: RunnerRunRecord
): record is RunnerRunRecord & {
  dispatchLeaseExpiresAt: Date;
  dispatchLeaseToken: string;
} {
  return (
    record.dispatchLeaseToken !== null && record.dispatchLeaseExpiresAt !== null
  );
}

function satisfiesDispatchLeaseConstraint(record: RunnerRunRecord): boolean {
  return (
    (record.dispatchState === "queued" &&
      record.status === "queued" &&
      !hasDispatchLease(record)) ||
    (record.dispatchState === "dispatching" &&
      record.status === "queued" &&
      hasDispatchLease(record) &&
      record.dispatchLeaseExpiresAt > record.createdAt) ||
    (record.dispatchState === "running" &&
      record.status === "running" &&
      hasDispatchLease(record) &&
      record.dispatchLeaseExpiresAt > record.createdAt) ||
    (record.dispatchState === "terminal" &&
      (record.status === "completed" ||
        record.status === "failed" ||
        record.status === "cancelled") &&
      (hasDispatchLease(record) ||
        (record.dispatchLeaseToken === null &&
          record.dispatchLeaseExpiresAt === null)))
  );
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

function resultRows<Row extends Record<string, unknown>>(
  values: readonly unknown[]
): Promise<Row[]> {
  return Promise.resolve(values as Row[]);
}

function serializedAgentStore() {
  let currentAgent = agent({ runtime: "copilot", version: 4 });
  const currentRuns: RunnerRunRecord[] = [];
  let transactionTail = Promise.resolve();
  const database: RunnerStoreDatabase = {
    transaction: async (callback) => {
      const previous = transactionTail;
      let release: () => void = () => undefined;
      transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await callback({
          execute: <Row extends Record<string, unknown>>(
            currentStatement: RunnerStoreStatement
          ): Promise<Row[]> => {
            switch (currentStatement.name) {
              case "lock-agent-for-run-start":
                return resultRows<Row>([currentAgent]);
              case "lock-agent-for-update":
                return resultRows<Row>([currentAgent]);
              case "get-operation-run-before-admission":
              case "get-operation-run":
                return resultRows<Row>(
                  currentRuns.filter(
                    (currentRun) =>
                      currentRun.agentId === currentStatement.args.agentId &&
                      currentRun.operationId ===
                        currentStatement.args.operationId &&
                      currentRun.tenant === currentStatement.args.tenant
                  )
                );
              case "find-live-run-for-agent-update":
                return resultRows<Row>(
                  currentRuns
                    .filter(
                      (currentRun) =>
                        currentRun.agentId === currentStatement.args.agentId &&
                        currentRun.tenant === currentStatement.args.tenant &&
                        (currentRun.status === "queued" ||
                          currentRun.status === "running")
                    )
                    .map(({ id }) => ({ id }))
                );
              case "insert-run": {
                const inserted = run({
                  agentId: String(currentStatement.args.agentId),
                  agentInstructions: String(
                    currentStatement.args.agentInstructions
                  ),
                  agentModel: String(currentStatement.args.agentModel),
                  agentRuntime: String(
                    currentStatement.args.agentRuntime
                  ) as RunnerRunRecord["agentRuntime"],
                  agentWorkspace:
                    currentStatement.args.agentWorkspace === null
                      ? null
                      : String(currentStatement.args.agentWorkspace),
                  authVersion: Number(currentStatement.args.authVersion),
                  id: String(currentStatement.args.id),
                  operationId: String(currentStatement.args.operationId),
                  requestHash: String(currentStatement.args.requestHash),
                  task: String(currentStatement.args.task),
                  tenant: String(currentStatement.args.tenant),
                });
                currentRuns.push(inserted);
                return resultRows<Row>([inserted]);
              }
              case "insert-accepted-event":
                return resultRows<Row>([{ eventId: 1 }]);
              case "advance-run-after-acceptance": {
                const index = currentRuns.findIndex(
                  (candidate) =>
                    candidate.id === currentStatement.args.runId &&
                    candidate.tenant === currentStatement.args.tenant
                );
                const currentRun = currentRuns[index];
                assert.ok(currentRun);
                const advanced = {
                  ...currentRun,
                  logCursor: 1,
                  version: currentRun.version + 1,
                };
                currentRuns[index] = advanced;
                return resultRows<Row>([advanced]);
              }
              case "update-agent":
                currentAgent = {
                  ...currentAgent,
                  description: String(currentStatement.args.description),
                  instructions: String(currentStatement.args.instructions),
                  model: String(currentStatement.args.model),
                  name: String(currentStatement.args.name),
                  runtime: String(
                    currentStatement.args.runtime
                  ) as RunnerAgentRecord["runtime"],
                  updatedAt: new Date("2026-01-01T00:00:01.000Z"),
                  version: currentAgent.version + 1,
                  workspace:
                    currentStatement.args.workspace === null
                      ? null
                      : String(currentStatement.args.workspace),
                };
                return resultRows<Row>([currentAgent]);
              default:
                throw new Error(
                  `Unexpected serialized statement: ${currentStatement.name}`
                );
            }
          },
        });
      } finally {
        release();
      }
    },
  };
  return {
    agent: () => currentAgent,
    runs: () => [...currentRuns],
    store: createRunnerStore(database),
  };
}

test("reconciliation lease acquisition uses database time and skips a live holder", async () => {
  const expiresAt = new Date("2026-08-28T21:40:00.000Z");
  const acquired = scripted([
    {
      reconciliationLeaseExpiresAt: expiresAt,
      reconciliationLeaseFence: "7",
      reconciliationLeaseOwner: "owner-a",
    },
  ]);
  const held = scripted([]);

  assert.deepEqual(
    await acquired.store.acquireReconciliationLease(operator, {
      ownerToken: "owner-a",
      ttlSeconds: 360,
    }),
    {
      kind: "acquired",
      lease: { expiresAt, fence: 7, ownerToken: "owner-a" },
    }
  );
  assert.deepEqual(
    await held.store.acquireReconciliationLease(operator, {
      ownerToken: "owner-b",
      ttlSeconds: 360,
    }),
    { kind: "held" }
  );

  const acquireSql = queryText(acquired.statements[0] as RunnerStoreStatement);
  assert.match(acquireSql, /ON CONFLICT \("singleton"\) DO UPDATE/u);
  assert.match(acquireSql, /clock_timestamp\(\)/u);
  assert.match(acquireSql, /make_interval\(secs => \$\d+\)/u);
  assert.match(
    acquireSql,
    /"reconciliationLeaseExpiresAt" <= clock_timestamp\(\)/u
  );
});

test("expired reconciliation lease is reclaimed with a new fence", async () => {
  const expiresAt = new Date("2026-08-28T21:46:00.000Z");
  const { statements, store } = scripted([
    {
      reconciliationLeaseExpiresAt: expiresAt,
      reconciliationLeaseFence: 12,
      reconciliationLeaseOwner: "owner-new",
    },
  ]);

  const result = await store.acquireReconciliationLease(operator, {
    ownerToken: "owner-new",
    ttlSeconds: 360,
  });

  assert.deepEqual(result, {
    kind: "acquired",
    lease: { expiresAt, fence: 12, ownerToken: "owner-new" },
  });
  assert.match(
    queryText(statements[0] as RunnerStoreStatement),
    /"reconciliationLeaseFence" = "RunnerScheduler"."reconciliationLeaseFence" \+ 1/u
  );
});

test("reconciliation lease parses zone-less PostgreSQL timestamps as UTC", async () => {
  const expiresAt = new Date("2026-08-28T21:46:00.000Z");
  const { store } = scripted([
    {
      reconciliationLeaseExpiresAt: "2026-08-28 21:46:00.000000",
      reconciliationLeaseFence: 12,
      reconciliationLeaseOwner: "owner-new",
    },
  ]);

  const previousTimezone = process.env.TZ;
  process.env.TZ = "America/Chicago";
  try {
    assert.deepEqual(
      await store.acquireReconciliationLease(operator, {
        ownerToken: "owner-new",
        ttlSeconds: 360,
      }),
      {
        kind: "acquired",
        lease: { expiresAt, fence: 12, ownerToken: "owner-new" },
      }
    );
  } finally {
    if (previousTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousTimezone;
    }
  }
});

test("reconciliation lease rejects invalid PostgreSQL calendar timestamps", async () => {
  const { store } = scripted([
    {
      reconciliationLeaseExpiresAt: "2026-02-30 00:00:00.000000",
      reconciliationLeaseFence: 12,
      reconciliationLeaseOwner: "owner-new",
    },
  ]);

  await assert.rejects(
    store.acquireReconciliationLease(operator, {
      ownerToken: "owner-new",
      ttlSeconds: 360,
    }),
    /invalid "reconciliationLeaseExpiresAt"/u
  );
});

test("runner rows normalize raw PostgreSQL timestamp columns", async () => {
  const createdAt = new Date("2026-01-01T00:00:00.000Z");
  const updatedAt = new Date("2026-01-01T00:00:01.000Z");
  const lastRunAt = new Date("2026-01-01T00:00:02.000Z");
  const sandboxUpdatedAt = new Date("2026-01-01T00:00:03.000Z");
  const warmUpdatedAt = new Date("2026-01-01T00:00:04.000Z");
  const cancellationRequestedAt = new Date("2026-01-01T00:00:05.000Z");
  const completedAt = new Date("2026-01-01T00:00:06.000Z");
  const dispatchLeaseExpiresAt = new Date("2026-01-01T00:01:00.000Z");
  const startedAt = new Date("2026-01-01T00:00:07.000Z");
  const rawAgent = {
    ...agent(),
    createdAt: postgresTimestamp(createdAt),
    lastRunAt: postgresTimestamp(lastRunAt),
    sandboxUpdatedAt: postgresTimestamp(sandboxUpdatedAt),
    updatedAt: postgresTimestamp(updatedAt),
    warmUpdatedAt: postgresTimestamp(warmUpdatedAt),
  };
  const rawRun = {
    ...run({
      cancellationRequestedAt,
      completedAt,
      dispatchState: "terminal",
      startedAt,
      status: "completed",
    }),
    cancellationRequestedAt: postgresTimestamp(cancellationRequestedAt),
    completedAt: postgresTimestamp(completedAt),
    createdAt: postgresTimestamp(createdAt),
    dispatchLeaseExpiresAt: postgresTimestamp(dispatchLeaseExpiresAt),
    startedAt: postgresTimestamp(startedAt),
  };
  const eventCreatedAt = new Date("2026-01-01T00:00:08.000Z");
  const rawEvent = {
    createdAt: postgresTimestamp(eventCreatedAt),
    event: { id: 1, status: "running", type: "status" },
    eventId: 1,
    runId: rawRun.id,
  };
  const { store } = scripted([rawAgent], [rawRun], [rawEvent]);

  const hydratedAgent = await store.getAgent(principal, rawAgent.id);
  const [hydratedRun] = await store.scanExpiredDispatchLeases(
    operator,
    new Date(),
    1
  );
  const [hydratedEvent] = await store.readEventsAfter(principal, rawRun.id, 0);

  assert.deepEqual(
    {
      createdAt: hydratedAgent?.createdAt,
      lastRunAt: hydratedAgent?.lastRunAt,
      sandboxUpdatedAt: hydratedAgent?.sandboxUpdatedAt,
      updatedAt: hydratedAgent?.updatedAt,
      warmUpdatedAt: hydratedAgent?.warmUpdatedAt,
    },
    { createdAt, lastRunAt, sandboxUpdatedAt, updatedAt, warmUpdatedAt }
  );
  assert.deepEqual(
    {
      cancellationRequestedAt: hydratedRun?.cancellationRequestedAt,
      completedAt: hydratedRun?.completedAt,
      createdAt: hydratedRun?.createdAt,
      dispatchLeaseExpiresAt: hydratedRun?.dispatchLeaseExpiresAt,
      startedAt: hydratedRun?.startedAt,
    },
    {
      cancellationRequestedAt,
      completedAt,
      createdAt,
      dispatchLeaseExpiresAt,
      startedAt,
    }
  );
  assert.deepEqual(hydratedEvent?.createdAt, eventCreatedAt);
});

test("runner scan timestamps are serialized before reaching PostgreSQL", async () => {
  const before = new Date("2026-01-01T00:00:00.000Z");
  const staleBefore = new Date("2026-01-01T00:01:00.000Z");
  const { statements, store } = scripted([], []);

  await store.scanExpiredDispatchLeases(operator, before, 25);
  await store.scanDaytonaWarmRecoveries(operator, staleBefore, 25);

  assert.equal(
    queryParams(statements[0] as RunnerStoreStatement)[0],
    before.toISOString()
  );
  assert.equal(
    queryParams(statements[1] as RunnerStoreStatement)[0],
    staleBefore.toISOString()
  );
});

test("reconciliation release is fenced by both owner and generation", async () => {
  const stale = scripted([]);
  const current = scripted([{ singleton: true }]);
  const staleLease = {
    expiresAt: new Date("2026-08-28T21:40:00.000Z"),
    fence: 3,
    ownerToken: "owner-old",
  };
  const currentLease = {
    expiresAt: new Date("2026-08-28T21:46:00.000Z"),
    fence: 4,
    ownerToken: "owner-current",
  };

  assert.deepEqual(
    await stale.store.releaseReconciliationLease(operator, staleLease),
    { kind: "stale" }
  );
  assert.deepEqual(
    await current.store.releaseReconciliationLease(operator, currentLease),
    { kind: "released" }
  );

  const releaseSql = queryText(stale.statements[0] as RunnerStoreStatement);
  assert.match(releaseSql, /"reconciliationLeaseOwner" = \$\d+/u);
  assert.match(releaseSql, /"reconciliationLeaseFence" = \$\d+/u);
  assert.equal(stale.statements[0]?.args.ownerToken, "owner-old");
  assert.equal(stale.statements[0]?.args.fence, 3);
});

async function claimedAuthority(value: RunnerRunRecord) {
  const { store } = scripted(
    [
      {
        consecutiveDispatchCount: 0,
        lastDispatchedTenantHash: null,
      },
    ],
    [{ activeCount: 0 }],
    [value],
    [value],
    []
  );
  const claimed = await store.claimNextDispatch(operator, {
    leaseExpiresAt: value.dispatchLeaseExpiresAt as Date,
    leaseToken: value.dispatchLeaseToken as string,
    limits: {
      consecutiveDispatches: 2,
      deploymentActiveRuns: 25,
      tenantActiveRuns: 2,
      tenantQueuedRuns: 10,
    },
  });
  assert.ok(claimed);
  return claimed.authority;
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
  const existing = { ...run(), authVersion: 4 } as RunnerRunRecord;
  const { store } = scripted(
    [agent({ id: existing.agentId, sandboxLifecycle: "ready" })],
    [existing]
  );

  const result = await store.startRun(principal, {
    agentId: existing.agentId,
    authVersion: 9,
    id: existing.id,
    operationId: existing.operationId,
    requestHash: existing.requestHash,
    task: existing.task,
  } as never);

  assert.equal(result.kind, "duplicate");
  assert.equal(result.kind === "duplicate" && result.run.id, existing.id);
  assert.equal(
    result.kind === "duplicate" && "dispatchLeaseToken" in result.run,
    false
  );
  assert.equal(
    result.kind === "duplicate" && "authVersion" in result.run,
    false
  );
  assert.equal(existing.authVersion, 4);
});

test("broker policy duplicate equality ignores JSON object key order but preserves array order", async () => {
  const teamStepId = "10000000-0000-4000-8000-000000000001";
  const repositories = [
    {
      accountId: "123",
      accountLogin: "OpenCoven",
      accountType: "Organization" as const,
      appContentsPermission: "write" as const,
      appIssuesPermission: "write" as const,
      appOrganizationProjectsPermission: "write" as const,
      appPullRequestsPermission: "write" as const,
      connectionId: "10000000-0000-4000-8000-000000000002",
      githubUserId: "112233",
      githubUserLogin: "BunsDev",
      installationId: "456",
      repository: "opencoven/a-repository",
      repositoryId: "789",
      repositoryName: "a-repository",
      repositoryNodeId: "R_a",
      repositoryOwner: "OpenCoven",
      tenant: principal.tenant,
      userPermissionCeiling: "write" as const,
      userPermissionCurrent: "write" as const,
      userProjectAuthorityAuthVersion: null,
      userProjectAuthorityConnectionGeneration: null,
      userProjectAuthorityExpiresAt: null,
      userProjectAuthorityIssuedAt: null,
      userProjectIds: [],
      userProjectManagementCeiling: false,
      userProjectManagementCurrent: false,
    },
    {
      accountId: "123",
      accountLogin: "OpenCoven",
      accountType: "Organization" as const,
      appContentsPermission: "write" as const,
      appIssuesPermission: "write" as const,
      appOrganizationProjectsPermission: "write" as const,
      appPullRequestsPermission: "write" as const,
      connectionId: "10000000-0000-4000-8000-000000000003",
      githubUserId: "112233",
      githubUserLogin: "BunsDev",
      installationId: "456",
      repository: "opencoven/z-repository",
      repositoryId: "790",
      repositoryName: "z-repository",
      repositoryNodeId: "R_z",
      repositoryOwner: "OpenCoven",
      tenant: principal.tenant,
      userPermissionCeiling: "write" as const,
      userPermissionCurrent: "write" as const,
      userProjectAuthorityAuthVersion: null,
      userProjectAuthorityConnectionGeneration: null,
      userProjectAuthorityExpiresAt: null,
      userProjectAuthorityIssuedAt: null,
      userProjectIds: [],
      userProjectManagementCeiling: false,
      userProjectManagementCurrent: false,
    },
  ];
  const policy = {
    actorUserId: "9c858901-8a57-4791-81fe-4c455b099bc9",
    allowedCapabilities: ["github.issues.read" as const],
    approvedCapabilities: [],
    authVersion: 8,
    connectionGeneration: 3,
    declaredCapabilities: ["github.issues.read" as const],
    maxCallCount: 32,
    repositories,
    teamRunId: "10000000-0000-4000-8000-000000000004",
    teamStepId,
    tenant: principal.tenant,
    version: 1 as const,
  };
  const reorderedFromJsonb = {
    actorUserId: policy.actorUserId,
    allowedCapabilities: ["github.issues.read" as const],
    approvedCapabilities: [],
    authVersion: 8,
    connectionGeneration: 3,
    declaredCapabilities: ["github.issues.read" as const],
    maxCallCount: 32,
    repositories: repositories.map((repository) => ({
      accountId: repository.accountId,
      accountLogin: repository.accountLogin,
      accountType: repository.accountType,
      appContentsPermission: repository.appContentsPermission,
      appIssuesPermission: repository.appIssuesPermission,
      appOrganizationProjectsPermission:
        repository.appOrganizationProjectsPermission,
      appPullRequestsPermission: repository.appPullRequestsPermission,
      connectionId: repository.connectionId,
      githubUserId: repository.githubUserId,
      githubUserLogin: repository.githubUserLogin,
      installationId: repository.installationId,
      repository: repository.repository,
      repositoryId: repository.repositoryId,
      repositoryName: repository.repositoryName,
      repositoryNodeId: repository.repositoryNodeId,
      repositoryOwner: repository.repositoryOwner,
      tenant: repository.tenant,
      userPermissionCeiling: repository.userPermissionCeiling,
      userPermissionCurrent: repository.userPermissionCurrent,
      userProjectAuthorityAuthVersion:
        repository.userProjectAuthorityAuthVersion,
      userProjectAuthorityConnectionGeneration:
        repository.userProjectAuthorityConnectionGeneration,
      userProjectAuthorityExpiresAt: repository.userProjectAuthorityExpiresAt,
      userProjectAuthorityIssuedAt: repository.userProjectAuthorityIssuedAt,
      userProjectIds: [],
      userProjectManagementCeiling: repository.userProjectManagementCeiling,
      userProjectManagementCurrent: repository.userProjectManagementCurrent,
    })),
    teamRunId: policy.teamRunId,
    teamStepId,
    tenant: policy.tenant,
    version: 1 as const,
  };
  const existing = run({
    authVersion: 8,
    executionPermission: "github_only",
    githubBrokerPolicy: reorderedFromJsonb,
    teamStepId,
  });
  const start = async (githubBrokerPolicy: typeof policy) => {
    const fixture = scripted(
      [
        agent({
          id: existing.agentId,
          sandboxLifecycle: "ready",
          sandboxTrust: "restricted",
        }),
      ],
      [existing]
    );
    return await fixture.store.startRun(principal, {
      agentId: existing.agentId,
      authVersion: 8,
      executionPermission: "github_only",
      githubBrokerPolicy,
      id: existing.id,
      operationId: existing.operationId,
      requestHash: existing.requestHash,
      task: existing.task,
      teamStepId,
    });
  };

  assert.equal((await start(policy)).kind, "duplicate");
  assert.equal(
    (
      await start({
        ...policy,
        connectionGeneration: policy.connectionGeneration + 1,
      })
    ).kind,
    "conflict"
  );
  assert.equal(
    (
      await start({
        ...policy,
        repositories: [...policy.repositories].reverse(),
      })
    ).kind,
    "conflict"
  );
});

test("duplicate starts conflict when execution permission differs", async () => {
  const existing = run({ executionPermission: "workspace_read" });
  const { store } = scripted(
    [agent({ id: existing.agentId, sandboxLifecycle: "ready" })],
    [existing]
  );

  const result = await store.startRun(principal, {
    agentId: existing.agentId,
    authVersion: 9,
    executionPermission: "workspace_write",
    id: existing.id,
    operationId: existing.operationId,
    requestHash: existing.requestHash,
    task: existing.task,
  });

  assert.equal(result.kind, "conflict");
});

test("restricted starts refuse an unrestricted sandbox trust profile", async () => {
  const current = run({ executionPermission: "workspace_read" });
  const { statements, store } = scripted(
    [
      agent({
        id: current.agentId,
        sandboxLifecycle: "ready",
        sandboxTrust: "unrestricted",
      }),
    ],
    []
  );

  const result = await store.startRun(principal, {
    agentId: current.agentId,
    authVersion: 9,
    executionPermission: "workspace_read",
    id: current.id,
    operationId: current.operationId,
    requestHash: current.requestHash,
    task: current.task,
  });

  assert.deepEqual(result, { kind: "sandbox_trust_conflict" });
  assert.deepEqual(
    statements.map((statement) => statement.name),
    ["lock-agent-for-run-start", "get-operation-run-before-admission"]
  );
});

test("restricted starts refuse a pending unrestricted run before admission", async () => {
  const current = run({ executionPermission: "workspace_read" });
  const { statements, store } = scripted(
    [
      agent({
        id: current.agentId,
        sandboxLifecycle: "ready",
        sandboxTrust: "restricted",
      }),
    ],
    [],
    [{ id: "pending-unrestricted-run" }]
  );

  const result = await store.startRun(principal, {
    agentId: current.agentId,
    authVersion: 9,
    executionPermission: "workspace_read",
    id: current.id,
    operationId: current.operationId,
    requestHash: current.requestHash,
    task: current.task,
  });

  assert.deepEqual(result, { kind: "sandbox_trust_conflict" });
  assert.equal(statements[2]?.name, "find-pending-unrestricted-run");
  assert.match(
    queryText(statements[2] as RunnerStoreStatement),
    /"cancellationRequestedAt" IS NULL[\s\S]*"executionPermission" = 'unrestricted'/u
  );
});

test("restricted retries accept only their exact legacy pre-migration hash", async () => {
  const existing = run({
    executionPermission: "workspace_read",
    requestHash: hashRunRequest(run().agentId, run().task),
  });
  const exact = scripted(
    [agent({ id: existing.agentId, sandboxLifecycle: "ready" })],
    [existing]
  );
  const changed = scripted(
    [agent({ id: existing.agentId, sandboxLifecycle: "ready" })],
    [existing]
  );

  const duplicate = await exact.store.startRun(principal, {
    agentId: existing.agentId,
    authVersion: 9,
    executionPermission: "workspace_read",
    id: existing.id,
    operationId: existing.operationId,
    requestHash: hashRunRequest(
      existing.agentId,
      existing.task,
      "workspace_read"
    ),
    task: existing.task,
  });
  const conflict = await changed.store.startRun(principal, {
    agentId: existing.agentId,
    authVersion: 9,
    executionPermission: "workspace_read",
    id: existing.id,
    operationId: existing.operationId,
    requestHash: hashRunRequest(
      existing.agentId,
      `${existing.task} changed`,
      "workspace_read"
    ),
    task: `${existing.task} changed`,
  });

  assert.equal(duplicate.kind, "duplicate");
  assert.equal(conflict.kind, "conflict");
});

test("new runs persist trusted authority and internal hydration preserves it", async () => {
  const inserted = { ...run(), authVersion: 8 } as RunnerRunRecord;
  const accepted = {
    createdAt: inserted.createdAt,
    event: {},
    eventId: 1,
    runId: inserted.id,
  };
  const advanced = {
    ...inserted,
    logCursor: 1,
    version: inserted.version + 1,
  };
  const creation = scripted(
    [agent({ id: inserted.agentId, sandboxLifecycle: "ready" })],
    [],
    [inserted],
    [accepted],
    [advanced]
  );

  const result = await creation.store.startRun(principal, {
    agentId: inserted.agentId,
    authVersion: 8,
    id: inserted.id,
    operationId: inserted.operationId,
    requestHash: inserted.requestHash,
    task: inserted.task,
  } as never);

  assert.equal(result.kind, "created");
  assert.equal(result.kind === "created" && "authVersion" in result.run, false);
  const insert = creation.statements.find(
    (statement) => statement.name === "insert-run"
  );
  assert.equal(insert?.args.authVersion, 8);
  assert.equal(insert?.args.executionPermission, "unrestricted");
  assert.match(queryText(insert as RunnerStoreStatement), /"authVersion"/);
  assert.match(
    queryText(insert as RunnerStoreStatement),
    /"executionPermission"/
  );

  const hydration = scripted([advanced]);
  const [hydrated] = await hydration.store.scanLiveRuns(operator, 1);
  assert.equal((hydrated as { authVersion?: number }).authVersion, 8);
  assert.equal(
    (hydrated as { executionPermission?: string }).executionPermission,
    "unrestricted"
  );
});

test("new restricted runs persist the exact execution permission", async () => {
  const inserted = run({ executionPermission: "workspace_read" });
  const accepted = {
    createdAt: inserted.createdAt,
    event: {},
    eventId: 1,
    runId: inserted.id,
  };
  const creation = scripted(
    [agent({ id: inserted.agentId, sandboxLifecycle: "ready" })],
    [],
    [],
    [inserted],
    [accepted],
    [{ ...inserted, logCursor: 1, version: inserted.version + 1 }]
  );

  const result = await creation.store.startRun(principal, {
    agentId: inserted.agentId,
    authVersion: 8,
    executionPermission: "workspace_read",
    id: inserted.id,
    operationId: inserted.operationId,
    requestHash: inserted.requestHash,
    task: inserted.task,
  });

  test("team child runs persist exact step linkage and immutable broker policy", async () => {
    const teamStepId = "10000000-0000-4000-8000-000000000001";
    const brokerPolicy = {
      actorUserId: "9c858901-8a57-4791-81fe-4c455b099bc9",
      allowedCapabilities: ["github.issues.read" as const],
      approvedCapabilities: [],
      authVersion: 8,
      connectionGeneration: 3,
      declaredCapabilities: ["github.issues.read" as const],
      maxCallCount: 32,
      repositories: [
        {
          accountId: "123",
          accountLogin: "OpenCoven",
          accountType: "Organization" as const,
          appContentsPermission: "write" as const,
          appIssuesPermission: "write" as const,
          appOrganizationProjectsPermission: "write" as const,
          appPullRequestsPermission: "write" as const,
          connectionId: "10000000-0000-4000-8000-000000000002",
          githubUserId: "112233",
          githubUserLogin: "BunsDev",
          installationId: "456",
          repository: "opencoven/coven-agents",
          repositoryId: "789",
          repositoryName: "coven-agents",
          repositoryNodeId: "R_kgDOExample",
          repositoryOwner: "OpenCoven",
          tenant: principal.tenant,
          userPermissionCeiling: "write" as const,
          userPermissionCurrent: "write" as const,
          userProjectAuthorityAuthVersion: null,
          userProjectAuthorityConnectionGeneration: null,
          userProjectAuthorityExpiresAt: null,
          userProjectAuthorityIssuedAt: null,
          userProjectIds: [],
          userProjectManagementCeiling: false,
          userProjectManagementCurrent: false,
        },
      ],
      teamRunId: "10000000-0000-4000-8000-000000000003",
      teamStepId,
      tenant: principal.tenant,
      version: 1 as const,
    };
    const inserted = run({
      authVersion: 8,
      executionPermission: "github_only",
      githubBrokerPolicy: brokerPolicy,
      teamStepId,
    });
    const accepted = {
      createdAt: inserted.createdAt,
      event: {},
      eventId: 1,
      runId: inserted.id,
    };
    const creation = scripted(
      [agent({ id: inserted.agentId, sandboxLifecycle: "ready" })],
      [],
      [],
      [inserted],
      [accepted],
      [{ ...inserted, logCursor: 1, version: inserted.version + 1 }]
    );

    const result = await creation.store.startRun(principal, {
      agentId: inserted.agentId,
      authVersion: 8,
      executionPermission: "github_only",
      githubBrokerPolicy: brokerPolicy,
      id: inserted.id,
      operationId: inserted.operationId,
      requestHash: inserted.requestHash,
      task: inserted.task,
      teamStepId,
    });

    assert.equal(result.kind, "created");
    const insert = creation.statements.find(
      (statement) => statement.name === "insert-run"
    );
    assert.equal(insert?.args.teamStepId, teamStepId);
    assert.deepEqual(insert?.args.githubBrokerPolicy, brokerPolicy);
    assert.match(
      queryText(insert as RunnerStoreStatement),
      /"teamStepId"[\s\S]*"githubBrokerPolicy"/u
    );

    const changedPolicy = {
      ...brokerPolicy,
      connectionGeneration: 4,
    };
    const duplicate = scripted(
      [agent({ id: inserted.agentId, sandboxLifecycle: "ready" })],
      [inserted]
    );
    assert.equal(
      (
        await duplicate.store.startRun(principal, {
          agentId: inserted.agentId,
          authVersion: 8,
          executionPermission: "github_only",
          githubBrokerPolicy: changedPolicy,
          id: inserted.id,
          operationId: inserted.operationId,
          requestHash: inserted.requestHash,
          task: inserted.task,
          teamStepId,
        })
      ).kind,
      "conflict"
    );
  });

  assert.equal(result.kind, "created");
  assert.equal(
    creation.statements.find((statement) => statement.name === "insert-run")
      ?.args.executionPermission,
    "workspace_read"
  );
});

test("new runs persist immutable agent execution snapshots", async () => {
  const suppliedSnapshot = {
    instructions: "Team run profile snapshot.",
    model: "snapshotted-model",
    runtime: "copilot" as const,
    workspace: "/workspace/snapshot",
  };
  const inserted = run({
    agentInstructions: suppliedSnapshot.instructions,
    agentModel: suppliedSnapshot.model,
    agentRuntime: suppliedSnapshot.runtime,
    agentWorkspace: suppliedSnapshot.workspace,
  });
  const accepted = {
    createdAt: inserted.createdAt,
    event: {},
    eventId: 1,
    runId: inserted.id,
  };
  const creation = scripted(
    [agent({ instructions: "Mutated live profile." })],
    [],
    [inserted],
    [accepted],
    [{ ...inserted, logCursor: 1, version: inserted.version + 1 }]
  );

  const result = await creation.store.startRun(principal, {
    agentId: inserted.agentId,
    agentSnapshot: suppliedSnapshot,
    authVersion: 8,
    id: inserted.id,
    operationId: inserted.operationId,
    requestHash: inserted.requestHash,
    task: inserted.task,
  });

  assert.equal(result.kind, "created");
  const insert = creation.statements.find(
    (statement) => statement.name === "insert-run"
  );
  assert.ok(insert);
  assert.equal(insert.args.agentInstructions, suppliedSnapshot.instructions);
  assert.equal(insert.args.agentModel, suppliedSnapshot.model);
  assert.equal(insert.args.agentRuntime, suppliedSnapshot.runtime);
  assert.equal(insert.args.agentWorkspace, suppliedSnapshot.workspace);
  assert.match(queryText(insert), /"agentInstructions"/u);
  assert.match(queryText(insert), /"agentRuntime"/u);
  assert.match(queryText(insert), /"agentWorkspace"/u);
});

test("reusing an operation with another request hash conflicts", async () => {
  const existing = run();
  const { store } = scripted(
    [agent({ id: existing.agentId, sandboxLifecycle: "ready" })],
    [existing]
  );

  const result = await store.startRun(principal, {
    agentId: existing.agentId,
    authVersion: 9,
    id: existing.id,
    operationId: existing.operationId,
    requestHash: "b".repeat(64),
    task: existing.task,
  });

  assert.equal(result.kind, "conflict");
  assert.equal(result.kind === "conflict" && result.run.id, existing.id);
});

test("operation retries win over reset or decommission lifecycle rejection", async () => {
  await Promise.all(
    (["resetting", "decommissioning"] as const).map(async (lifecycle) => {
      const existing = run();
      const matching = scripted(
        [agent({ id: existing.agentId, sandboxLifecycle: lifecycle })],
        [existing]
      );
      const conflicting = scripted(
        [agent({ id: existing.agentId, sandboxLifecycle: lifecycle })],
        [existing]
      );

      const [duplicate, conflict] = await Promise.all([
        matching.store.startRun(principal, {
          agentId: existing.agentId,
          authVersion: 1,
          id: existing.id,
          operationId: existing.operationId,
          requestHash: existing.requestHash,
          task: existing.task,
        }),
        conflicting.store.startRun(principal, {
          agentId: existing.agentId,
          authVersion: 2,
          id: existing.id,
          operationId: existing.operationId,
          requestHash: "b".repeat(64),
          task: existing.task,
        }),
      ]);

      assert.equal(duplicate.kind, "duplicate", lifecycle);
      assert.equal(conflict.kind, "conflict", lifecycle);
      assert.deepEqual(
        matching.statements.map((statement) => statement.name),
        ["lock-agent-for-run-start", "get-operation-run-before-admission"],
        lifecycle
      );
      assert.deepEqual(
        conflicting.statements.map((statement) => statement.name),
        ["lock-agent-for-run-start", "get-operation-run-before-admission"],
        lifecycle
      );
    })
  );
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
    /row_number\(\) OVER \(ORDER BY "eventId" DESC\)/
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

test("dispatch event appends advance the distinct Daytona byte cursor", async () => {
  const current = run({ daytonaLogCursor: 10 } as Partial<RunnerRunRecord>);
  const updated = run({
    ...current,
    daytonaLogCursor: 42,
    logCursor: current.logCursor + 1,
    version: current.version + 1,
  } as Partial<RunnerRunRecord>);
  const event = {
    createdAt: new Date(),
    event: {
      id: updated.logCursor,
      output: "progress",
      type: "output",
    } as const,
    eventId: updated.logCursor,
    runId: current.id,
  };
  const { statements, store } = scripted([current], [updated], [event], []);

  const result = await store.appendDispatchEvent(
    operator,
    {
      expectedVersion: current.version,
      leaseToken: current.dispatchLeaseToken as string,
      runId: current.id,
    } as RunnerDispatchAuthority,
    {
      daytonaLogCursor: 42,
      event: { output: "progress", type: "output" },
    }
  );

  assert.equal(result.kind, "appended");
  assert.equal(
    (statements[1] as RunnerStoreStatement).args.daytonaLogCursor,
    42
  );
});

test("dispatch event batches atomically advance one provider cursor", async () => {
  const current = run({
    daytonaLogCursor: 10,
    dispatchState: "running",
    logCursor: 3,
    startedAt: new Date("2026-01-01T00:00:01.000Z"),
    status: "running",
  });
  const updated = run({
    ...current,
    daytonaLogCursor: 42,
    logCursor: 5,
    output: "second",
    version: current.version + 1,
  });
  const events = [4, 5].map((eventId) => ({
    createdAt: new Date(),
    event: { id: eventId, output: `event-${eventId}`, type: "output" } as const,
    eventId,
    runId: current.id,
  }));
  const { statements, store } = scripted([current], [updated], events, []);

  const result = await store.appendDispatchEventBatch(
    operator,
    {
      expectedVersion: current.version,
      leaseToken: current.dispatchLeaseToken as string,
      runId: current.id,
    } as RunnerDispatchAuthority,
    {
      daytonaLogCursor: 42,
      events: [
        { output: "event-4", type: "output" },
        { output: "event-5", type: "output" },
      ],
      snapshot: { output: "second" },
    }
  );

  assert.equal(result.kind, "appended");
  assert.deepEqual(
    statements.map((statement) => statement.name),
    [
      "lock-live-dispatch-run",
      "update-run-after-dispatch-event-batch",
      "insert-dispatch-run-event-batch",
      "prune-run-events-after-dispatch-batch",
    ]
  );
  assert.equal(
    (statements[1] as RunnerStoreStatement).args.daytonaLogCursor,
    42
  );
  assert.equal((statements[1] as RunnerStoreStatement).args.eventCount, 2);
  assert.match(
    queryText(statements[2] as RunnerStoreStatement),
    /INSERT INTO "RunnerRunEvent"/u
  );
  assert.match(
    queryText(statements[2] as RunnerStoreStatement),
    /VALUES \(\$\d+, \$\d+, CAST\(\$\d+ AS jsonb\)\), \(\$\d+, \$\d+, CAST\(\$\d+ AS jsonb\)\)/u
  );
});

test("dispatch batches retain the newest events beyond the retention limit", async () => {
  const current = run({
    daytonaLogCursor: 10,
    dispatchState: "running",
    logCursor: 3,
    startedAt: new Date("2026-01-01T00:00:01.000Z"),
    status: "running",
  });
  const count = MAX_EVENTS_PER_RUN + 1;
  const updated = run({
    ...current,
    daytonaLogCursor: 42,
    logCursor: current.logCursor + count,
    version: current.version + 1,
  });
  const inserted = Array.from({ length: count }, (_, index) => {
    const eventId = current.logCursor + index + 1;
    return {
      createdAt: new Date(),
      event: {
        id: eventId,
        output: `event-${eventId}`,
        type: "output",
      } as const,
      eventId,
      runId: current.id,
    };
  });
  const { statements, store } = scripted([current], [updated], inserted, []);

  const result = await store.appendDispatchEventBatch(
    operator,
    {
      expectedVersion: current.version,
      leaseToken: current.dispatchLeaseToken as string,
      runId: current.id,
    } as RunnerDispatchAuthority,
    {
      daytonaLogCursor: 42,
      events: inserted.map(({ event }) => ({
        output: event.output,
        type: event.type,
      })),
    }
  );

  assert.equal(result.kind, "appended");
  const persistedEvents = (statements[2] as RunnerStoreStatement).args.events;
  assert.ok(Array.isArray(persistedEvents));
  assert.equal(persistedEvents.length, count);
  assert.equal(
    (statements[3] as RunnerStoreStatement).name,
    "prune-run-events-after-dispatch-batch"
  );
});

test("attempt redaction envelopes are fenced, server-only, and deletable by exact attempt", async () => {
  const attemptId =
    "53af1a29-4e98-43d6-ac5b-3b9dcba5e735" as RunnerDaytonaAttemptId;
  const current = run({ daytonaAttemptId: attemptId });
  const authority = {
    attemptId,
    expectedVersion: current.version,
    leaseToken: current.dispatchLeaseToken as string,
    runId: current.id,
  } as RunnerDispatchAuthority;
  const envelope = {
    aadVersion: 1,
    attemptId,
    ciphertext: "ciphertext",
    iv: "iv",
    kekVersion: "v1",
    wrappedKey: "wrapped-key",
  };
  const persisted = scripted([current], [{ runId: current.id }]);
  const loaded = scripted(
    [current],
    [
      {
        ...envelope,
        createdAt: new Date(),
        runId: current.id,
      },
    ]
  );
  const deleted = scripted([current], [{ runId: current.id }]);

  assert.equal(
    (
      await persisted.store.persistAttemptRedaction(
        operator,
        authority,
        envelope
      )
    ).kind,
    "persisted"
  );
  const read = await loaded.store.readAttemptRedaction(operator, authority);
  assert.equal(read.kind, "found");
  assert.equal(read.kind === "found" && read.value.ciphertext, "ciphertext");
  assert.equal(
    (await deleted.store.deleteAttemptRedaction(operator, authority)).kind,
    "deleted"
  );
  assert.match(
    queryText(persisted.statements[1] as RunnerStoreStatement),
    /"RunnerAttemptRedaction"/u
  );
  assert.match(
    queryText(deleted.statements[1] as RunnerStoreStatement),
    /"attemptId" = \$\d+/u
  );
});

test("a failed second batch event rolls back cursor and every event before retry", async () => {
  const current = run({
    daytonaLogCursor: 10,
    dispatchState: "running",
    logCursor: 3,
    startedAt: new Date("2026-01-01T00:00:01.000Z"),
    status: "running",
  });
  let failInsert = true;
  let state = {
    events: [] as { eventId: number; output: string }[],
    run: current,
  };
  const store = createRunnerStore({
    transaction: async (callback) => {
      const draft = {
        events: state.events.map((event) => ({ ...event })),
        run: { ...state.run },
      };
      const result = await callback({
        // biome-ignore lint/suspicious/useAwait: The transaction double implements the asynchronous store boundary.
        execute: async (statement) => {
          switch (statement.name) {
            case "lock-live-dispatch-run":
              return [draft.run] as never;
            case "update-run-after-dispatch-event-batch":
              draft.run = {
                ...draft.run,
                daytonaLogCursor: Number(statement.args.daytonaLogCursor),
                logCursor: Number(statement.args.nextEventId),
                version: draft.run.version + 1,
              };
              return [draft.run] as never;
            case "insert-dispatch-run-event-batch": {
              if (failInsert) {
                throw new Error("second provider event rejected");
              }
              const serialized = statement.args.events as string[];
              draft.events.push(
                ...serialized.map((event) => {
                  const parsed = JSON.parse(event) as {
                    id: number;
                    output: string;
                  };
                  return { eventId: parsed.id, output: parsed.output };
                })
              );
              return serialized.map((event) => {
                const parsed = JSON.parse(event) as {
                  id: number;
                  output: string;
                };
                return {
                  createdAt: new Date(),
                  event: {
                    id: parsed.id,
                    output: parsed.output,
                    type: "output",
                  },
                  eventId: parsed.id,
                  runId: current.id,
                };
              }) as never;
            }
            case "prune-run-events-after-dispatch-batch":
              return [] as never;
            default:
              throw new Error(`Unexpected statement ${statement.name}`);
          }
        },
      });
      state = draft;
      return result;
    },
  });
  const authority = {
    expectedVersion: current.version,
    leaseToken: current.dispatchLeaseToken as string,
    runId: current.id,
  } as RunnerDispatchAuthority;
  const input = {
    daytonaLogCursor: 42,
    events: [
      { output: "first", type: "output" as const },
      { output: "second", type: "output" as const },
    ],
  };

  await assert.rejects(
    () => store.appendDispatchEventBatch(operator, authority, input),
    /second provider event rejected/u
  );
  assert.equal(state.run.logCursor, current.logCursor);
  assert.equal(state.run.daytonaLogCursor, current.daytonaLogCursor);
  assert.deepEqual(state.events, []);

  failInsert = false;
  const retried = await store.appendDispatchEventBatch(
    operator,
    authority,
    input
  );
  assert.equal(retried.kind, "appended");
  assert.deepEqual(state.events, [
    { eventId: 4, output: "first" },
    { eventId: 5, output: "second" },
  ]);
  assert.equal(state.run.daytonaLogCursor, 42);
});

test("a log-only reconciliation advances Daytona cursor without inventing an event", async () => {
  const current = run({
    daytonaLogCursor: 10,
    dispatchState: "running",
    startedAt: new Date("2026-01-01T00:00:01.000Z"),
    status: "running",
  });
  const advanced = run({
    ...current,
    daytonaLogCursor: 42,
    version: current.version + 1,
  });
  const { statements, store } = scripted([current], [advanced]);

  const result = await store.advanceDaytonaLogCursor(
    operator,
    {
      expectedVersion: current.version,
      leaseToken: current.dispatchLeaseToken as string,
      runId: current.id,
    } as RunnerDispatchAuthority,
    42
  );

  assert.equal(result.kind, "updated");
  assert.equal(
    (statements[1] as RunnerStoreStatement).args.daytonaLogCursor,
    42
  );
  assert.match(
    queryText(statements[1] as RunnerStoreStatement),
    /GREATEST\("daytonaLogCursor", \$\d+\)/u
  );
});

test("event retention atomically prunes count and byte overflow while preserving the newest row", async () => {
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
  assert.equal(
    statements[3]?.args.maxEventBytes,
    MAX_PERSISTED_EVENT_BYTES_PER_RUN
  );
  assert.match(
    queryText(statements[3] as RunnerStoreStatement),
    /pg_column_size\("event"\)/
  );
  assert.match(
    queryText(statements[3] as RunnerStoreStatement),
    /"newestRank" > 1[\s\S]*"retainedBytes" > \$\d+/
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
      "finalize-agent-status",
      "insert-terminal-event",
      "prune-run-events-after-finalize",
      "prune-terminal-runs",
    ]
  );
  const terminalEvent = JSON.parse(
    String((statements[3] as RunnerStoreStatement).args.event)
  );
  const agentStatus = queryText(statements[2] as RunnerStoreStatement);
  assert.match(agentStatus, /"otherActive"\."agentId" = \$\d+/u);
  assert.match(agentStatus, /"otherActive"\."authorityRevalidation" = false/u);
  assert.match(agentStatus, /THEN 'running'/u);
  assert.equal(terminalEvent.id, MAX_EVENTS_PER_RUN + 1);
  assert.equal(terminalEvent.type, "completed");
  const prune = statements[4] as RunnerStoreStatement;
  assert.equal(prune.args.maxEvents, MAX_EVENTS_PER_RUN);
  assert.equal(prune.args.runId, current.id);
  assert.equal(prune.args.tenant, current.tenant);
  assert.match(queryText(prune), /DELETE FROM "RunnerRunEvent"/);
  assert.equal(prune.args.maxEventBytes, MAX_PERSISTED_EVENT_BYTES_PER_RUN);
  assert.match(queryText(prune), /"newestRank" > 1/);
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
  assert.equal(statements[0]?.args.maxEvents, MAX_EVENTS_PER_PAGE);
  assert.equal(statements[0]?.args.maxEventBytes, MAX_EVENT_PAGE_BYTES);
  assert.match(
    queryText(statements[0] as RunnerStoreStatement),
    /ORDER BY "RunnerRunEvent"\."eventId" ASC\s+LIMIT \$\d+/
  );
  assert.match(
    queryText(statements[0] as RunnerStoreStatement),
    /pg_column_size\("RunnerRunEvent"\."event"\)/
  );
  assert.match(
    queryText(statements[0] as RunnerStoreStatement),
    /"pageRank" = 1 OR "pageBytes" <= \$\d+/
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

test("dispatch transitions atomically maintain the agent status", async () => {
  const current = run();
  const running = run({
    dispatchState: "running",
    startedAt: new Date("2026-01-01T00:00:01.000Z"),
    status: "running",
    version: current.version + 1,
  });
  const { statements, store } = scripted([current], [running], []);

  assert.equal(
    (
      await store.markDispatchRunningForDispatch(operator, {
        expectedVersion: current.version,
        leaseToken: current.dispatchLeaseToken as string,
        runId: current.id,
      } as RunnerDispatchAuthority)
    ).kind,
    "updated"
  );
  assert.equal(statements[2]?.name, "mark-agent-running-for-dispatch");
  assert.match(
    queryText(statements[2] as RunnerStoreStatement),
    /"status" = 'running'/u
  );
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
  const { statements, store } = scripted(
    [current],
    [{ id: current.id }],
    [requeued]
  );

  const result = await store.requeueExpiredDispatch(operator, {
    expectedDispatchState: "dispatching",
    oldLeaseToken: current.dispatchLeaseToken as string,
    runId: current.id,
  });

  assert.equal(result.kind, "requeued");
  assert.equal(result.kind === "requeued" && result.value.version, 8);
  const update = statements[2] as RunnerStoreStatement;
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
  const attached = scripted(
    [run({ daytonaSessionId: "session" })],
    [{ id: current.id }]
  );
  const attemptId =
    "53af1a29-4e98-43d6-ac5b-3b9dcba5e734" as RunnerDaytonaAttemptId;
  const claimOnly = scripted(
    [run({ daytonaAttemptId: attemptId })],
    [{ id: current.id }]
  );

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
  assert.deepEqual(
    await claimOnly.store.requeueExpiredDispatch(operator, input),
    { attemptId, kind: "cleanup_required" }
  );
  assert.equal(stale.statements.length, 1);
  assert.equal(unexpired.statements.length, 2);
  assert.equal(attached.statements.length, 2);
  assert.equal(claimOnly.statements.length, 2);
});

test("expired dispatch recovery adopts only ownership-free runs", async () => {
  const current = run();
  const adopted = run({
    dispatchLeaseExpiresAt: new Date("2026-01-01T00:05:00.000Z"),
    dispatchLeaseToken: "replacement-lease",
    version: current.version + 1,
  });
  const { statements, store } = scripted(
    [current],
    [{ id: current.id }],
    [adopted]
  );
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
  const update = statements[2] as RunnerStoreStatement;
  assert.match(
    queryText(update),
    /"dispatchLeaseExpiresAt" <= clock_timestamp\(\)/
  );
  assert.match(queryText(update), /"dispatchState" = \$\d+/);
  assert.doesNotMatch(queryText(update), /"daytonaAttemptId" = NULL/);

  const stale = scripted([run({ dispatchLeaseToken: "newer-lease" })]);
  assert.deepEqual(
    await stale.store.adoptExpiredDispatchLease(operator, input),
    { kind: "lease_lost" }
  );
  assert.equal(stale.statements.length, 1);
});

test("expired dispatch adoption retains every unresolved Daytona ownership field", async () => {
  const attemptId =
    "53af1a29-4e98-43d6-ac5b-3b9dcba5e737" as RunnerDaytonaAttemptId;
  const current = run();
  const input = {
    expectedDispatchState: "dispatching" as const,
    leaseExpiresAt: new Date("2026-01-01T00:05:00.000Z"),
    newLeaseToken: "replacement-lease",
    oldLeaseToken: current.dispatchLeaseToken as string,
    runId: current.id,
  };
  const cases = [
    {
      expected: { attemptId, kind: "cleanup_required" },
      ownership: { daytonaAttemptId: attemptId },
    },
    {
      expected: { kind: "provider_identifiers_attached" },
      ownership: { daytonaSessionId: "legacy-session" },
    },
    {
      expected: { kind: "provider_identifiers_attached" },
      ownership: { daytonaCommandId: "legacy-command" },
    },
  ] as const;

  await Promise.all(
    cases.map(async ({ expected, ownership }) => {
      const recovery = scripted([run(ownership)], [{ id: current.id }]);
      assert.deepEqual(
        await recovery.store.adoptExpiredDispatchLease(operator, input),
        expected
      );
      assert.equal(recovery.statements.length, 2);
    })
  );
});

test("expired attempt recovery requires exact cleanup before requeue", async () => {
  const attemptA =
    "53af1a29-4e98-43d6-ac5b-3b9dcba5e735" as RunnerDaytonaAttemptId;
  const current = run({
    daytonaAttemptId: attemptA,
    daytonaCommandId: "command-a",
    daytonaSessionId: daytonaRunSessionName(run().id, attemptA),
  });
  const input = {
    attemptId: attemptA,
    expectedDispatchState: "dispatching" as const,
    oldLeaseToken: current.dispatchLeaseToken as string,
    runId: current.id,
  };
  const blocked = scripted([current], [{ id: current.id }]);
  assert.deepEqual(
    await blocked.store.requeueExpiredDispatch(operator, input),
    { attemptId: attemptA, kind: "cleanup_required" }
  );
  assert.equal(blocked.statements.length, 2);

  const releasedRun = run({
    ...current,
    daytonaAttemptId: null,
    daytonaCommandId: null,
    daytonaSessionId: null,
    version: current.version + 1,
  });
  const release = scripted([current], [releasedRun]);
  assert.deepEqual(
    await release.store.releaseExpiredDaytonaAttempt(operator, input),
    { kind: "released", value: releasedRun }
  );
  const releaseQuery = queryText(release.statements[1] as RunnerStoreStatement);
  assert.match(releaseQuery, /"daytonaAttemptId" = NULL/);
  assert.match(releaseQuery, /"daytonaSessionId" = NULL/);
  assert.match(releaseQuery, /"daytonaCommandId" = NULL/);
  assert.match(releaseQuery, /"executionProvenance" = NULL/);
  assert.match(releaseQuery, /"daytonaAttemptId" = \$\d+/);
  assert.match(
    releaseQuery,
    /"daytonaSessionId" IS NULL OR "daytonaSessionId" = \$/
  );
  assert.match(
    releaseQuery,
    /"daytonaCommandId" IS NULL OR "daytonaSessionId" = \$/
  );
  assert.match(releaseQuery, /"dispatchLeaseExpiresAt" <= clock_timestamp\(\)/);

  const requeued = run({
    ...releasedRun,
    dispatchLeaseExpiresAt: null,
    dispatchLeaseToken: null,
    dispatchState: "queued",
    version: releasedRun.version + 1,
  });
  const requeue = scripted([releasedRun], [{ id: current.id }], [requeued]);
  assert.deepEqual(
    await requeue.store.requeueExpiredDispatch(operator, {
      expectedDispatchState: "dispatching",
      oldLeaseToken: current.dispatchLeaseToken as string,
      runId: current.id,
    }),
    { kind: "requeued", value: requeued }
  );
  const requeueQuery = queryText(requeue.statements[2] as RunnerStoreStatement);
  assert.match(requeueQuery, /"daytonaAttemptId" IS NULL/);
  assert.match(requeueQuery, /"daytonaSessionId" IS NULL/);
  assert.match(requeueQuery, /"daytonaCommandId" IS NULL/);
  assert.match(requeueQuery, /"executionProvenance" = NULL/);
});

test("expired attempt cleanup rotates durable ownership before provider cleanup", async () => {
  const attemptId =
    "53af1a29-4e98-43d6-ac5b-3b9dcba5e736" as RunnerDaytonaAttemptId;
  const current = run({ daytonaAttemptId: attemptId });
  const claimed = run({
    ...current,
    dispatchLeaseExpiresAt: new Date("2026-01-01T00:05:00.000Z"),
    dispatchLeaseToken: "cleanup-lease",
    version: current.version + 1,
  });
  const { statements, store } = scripted(
    [current],
    [{ id: current.id }],
    [claimed]
  );

  const result = await store.claimExpiredDaytonaAttemptCleanup(operator, {
    attemptId,
    expectedDispatchState: "dispatching",
    leaseExpiresAt: claimed.dispatchLeaseExpiresAt as Date,
    newLeaseToken: claimed.dispatchLeaseToken as string,
    oldLeaseToken: current.dispatchLeaseToken as string,
    runId: current.id,
  });

  assert.equal(result.kind, "claimed");
  assert.equal(
    result.kind === "claimed" && result.authority.attemptId,
    attemptId
  );
  const update = statements[2] as RunnerStoreStatement;
  assert.match(
    queryText(update),
    /"dispatchLeaseExpiresAt" <= clock_timestamp\(\)/u
  );
  assert.match(queryText(update), /"daytonaAttemptId" = \$\d+/u);
});

test("an expired attached command is adopted before its logs are reconciled", async () => {
  const attemptId =
    "53af1a29-4e98-43d6-ac5b-3b9dcba5e738" as RunnerDaytonaAttemptId;
  const current = run({
    daytonaAttemptId: attemptId,
    daytonaCommandId: "command",
    daytonaSessionId: daytonaRunSessionName(run().id, attemptId),
    dispatchState: "running",
    startedAt: new Date("2026-01-01T00:00:01.000Z"),
    status: "running",
  });
  const adopted = run({
    ...current,
    dispatchLeaseExpiresAt: new Date("2026-01-01T00:05:00.000Z"),
    dispatchLeaseToken: "reconcile-lease",
    version: current.version + 1,
  });
  const { statements, store } = scripted(
    [current],
    [{ id: current.id }],
    [adopted]
  );

  const result = await store.adoptExpiredDaytonaProcess(operator, {
    attemptId,
    expectedDispatchState: "running",
    leaseExpiresAt: adopted.dispatchLeaseExpiresAt as Date,
    newLeaseToken: adopted.dispatchLeaseToken as string,
    oldLeaseToken: current.dispatchLeaseToken as string,
    runId: current.id,
  });

  assert.equal(result.kind, "adopted");
  assert.equal(
    result.kind === "adopted" && result.authority.attemptId,
    attemptId
  );
  assert.match(
    queryText(statements[2] as RunnerStoreStatement),
    /"daytonaCommandId" IS NOT NULL/u
  );
});

test("confirmed attempt cleanup releases ownership and requeues atomically", async () => {
  const attemptId =
    "53af1a29-4e98-43d6-ac5b-3b9dcba5e737" as RunnerDaytonaAttemptId;
  const current = run({
    daytonaAttemptId: attemptId,
    daytonaLogCursor: 42,
    dispatchLeaseExpiresAt: new Date("2026-01-01T00:05:00.000Z"),
    dispatchLeaseToken: "cleanup-lease",
    version: 8,
  });
  const requeued = run({
    ...current,
    daytonaAttemptId: null,
    daytonaLogCursor: 0,
    dispatchLeaseExpiresAt: null,
    dispatchLeaseToken: null,
    dispatchState: "queued",
    version: 9,
  });
  const authority = {
    attemptId,
    expectedVersion: current.version,
    leaseToken: current.dispatchLeaseToken as string,
    runId: current.id,
  } as RunnerDispatchAuthority;
  const { statements, store } = scripted([current], [requeued], []);

  assert.deepEqual(
    await store.requeueAfterDaytonaAttemptCleanup(operator, authority),
    { kind: "requeued", value: requeued }
  );
  const update = statements[1] as RunnerStoreStatement;
  assert.match(queryText(update), /"daytonaAttemptId" = NULL/u);
  assert.match(queryText(update), /"executionProvenance" = NULL/u);
  assert.match(queryText(update), /"daytonaLogCursor" = 0/u);
  assert.match(queryText(update), /"dispatchState" = 'queued'/u);
  assert.match(
    queryText(update),
    /"dispatchLeaseExpiresAt" > clock_timestamp\(\)/u
  );
});

test("expired attempt release leaves replacement and unowned resources untouched", async () => {
  const attemptA =
    "53af1a29-4e98-43d6-ac5b-3b9dcba5e735" as RunnerDaytonaAttemptId;
  const attemptB =
    "53af1a29-4e98-43d6-ac5b-3b9dcba5e736" as RunnerDaytonaAttemptId;
  const current = run();
  const input = {
    attemptId: attemptA,
    expectedDispatchState: "dispatching" as const,
    oldLeaseToken: current.dispatchLeaseToken as string,
    runId: current.id,
  };
  const replacement = scripted([
    run({
      daytonaAttemptId: attemptB,
      daytonaCommandId: "command-b",
      daytonaSessionId: daytonaRunSessionName(current.id, attemptB),
    }),
  ]);
  const unowned = scripted([
    run({
      daytonaAttemptId: attemptA,
      daytonaCommandId: "legacy-command",
      daytonaSessionId: "legacy-session",
    }),
  ]);

  assert.deepEqual(
    await replacement.store.releaseExpiredDaytonaAttempt(operator, input),
    { kind: "not_live" }
  );
  assert.deepEqual(
    await unowned.store.releaseExpiredDaytonaAttempt(operator, input),
    { kind: "not_live" }
  );
  assert.equal(replacement.statements.length, 1);
  assert.equal(unowned.statements.length, 1);
});

test("terminal cleanup retains ownership until the exact attempt is released", async () => {
  const attemptId =
    "53af1a29-4e98-43d6-ac5b-3b9dcba5e736" as RunnerDaytonaAttemptId;
  const terminal = run({
    completedAt: new Date("2026-01-01T00:00:01.000Z"),
    daytonaAttemptId: attemptId,
    daytonaCommandId: "command",
    daytonaSessionId: daytonaRunSessionName(run().id, attemptId),
    dispatchState: "terminal",
    executionProvenance,
    status: "completed",
  });
  const authority = {
    attemptId,
    expectedVersion: terminal.version,
    leaseToken: terminal.dispatchLeaseToken as string,
    runId: terminal.id,
  } as RunnerDispatchAuthority;
  const blocked = scripted([terminal]);
  assert.deepEqual(
    await blocked.store.cleanupTerminalLease(operator, authority),
    { kind: "not_live" }
  );

  const released = run({
    ...terminal,
    daytonaAttemptId: null,
    daytonaCommandId: null,
    daytonaSessionId: null,
    version: terminal.version + 1,
  });
  const release = scripted([terminal], [released]);
  assert.equal(
    (
      await release.store.releaseTerminalDaytonaAttempt(operator, authority, {
        attemptId,
      })
    ).kind,
    "released"
  );
  const releaseQuery = queryText(release.statements[1] as RunnerStoreStatement);
  assert.match(releaseQuery, /"daytonaAttemptId" = NULL/);
  assert.match(releaseQuery, /"daytonaSessionId" = NULL/);
  assert.match(releaseQuery, /"daytonaCommandId" = NULL/);
  assert.doesNotMatch(releaseQuery, /"executionProvenance" = NULL/);
  assert.deepEqual(released.executionProvenance, executionProvenance);
});

test("terminal lease cleanup refuses unresolved provider ownership", async () => {
  const attemptId =
    "53af1a29-4e98-43d6-ac5b-3b9dcba5e738" as RunnerDaytonaAttemptId;
  const terminal = run({
    completedAt: new Date("2026-01-01T00:00:01.000Z"),
    dispatchState: "terminal",
    status: "cancelled",
  });
  const authority = {
    expectedVersion: terminal.version,
    leaseToken: terminal.dispatchLeaseToken as string,
    runId: terminal.id,
  } as RunnerDispatchAuthority;

  await Promise.all(
    [
      run({ ...terminal, daytonaAttemptId: attemptId }),
      run({ ...terminal, daytonaCommandId: "command" }),
      run({ ...terminal, daytonaSessionId: "session" }),
    ].map(async (unresolved) => {
      const blocked = scripted([unresolved]);
      assert.deepEqual(
        await blocked.store.cleanupTerminalLease(operator, authority),
        { kind: "not_live" }
      );
      assert.equal(blocked.statements.length, 1);
    })
  );
});

test("terminal lease cleanup clears only its exact provider-free lease fence", async () => {
  const terminal = run({
    completedAt: new Date("2026-01-01T00:00:01.000Z"),
    dispatchState: "terminal",
    status: "cancelled",
  });
  const cleaned = run({
    ...terminal,
    dispatchLeaseExpiresAt: null,
    dispatchLeaseToken: null,
    version: terminal.version + 1,
  });
  const authority = {
    expectedVersion: terminal.version,
    leaseToken: terminal.dispatchLeaseToken as string,
    runId: terminal.id,
  } as RunnerDispatchAuthority;
  const exact = scripted([terminal], [cleaned]);

  assert.deepEqual(
    await exact.store.cleanupTerminalLease(operator, authority),
    { kind: "updated", value: cleaned }
  );
  const update = queryText(exact.statements[1] as RunnerStoreStatement);
  assert.match(update, /"version" = \$\d+/u);
  assert.match(update, /"dispatchLeaseToken" = \$\d+/u);
  assert.match(update, /"dispatchState" = 'terminal'/u);
  assert.match(update, /"daytonaAttemptId" IS NULL/u);
  assert.match(update, /"daytonaCommandId" IS NULL/u);
  assert.match(update, /"daytonaSessionId" IS NULL/u);

  const replaced = scripted([
    run({
      ...terminal,
      dispatchLeaseToken: "replacement-lease",
      version: terminal.version + 1,
    }),
  ]);
  assert.deepEqual(
    await replaced.store.cleanupTerminalLease(operator, authority),
    { kind: "stale_version" }
  );
  assert.equal(replaced.statements.length, 1);

  const displaced = scripted([
    run({ ...terminal, dispatchLeaseToken: "replacement-lease" }),
  ]);
  assert.deepEqual(
    await displaced.store.cleanupTerminalLease(operator, authority),
    { kind: "lease_lost" }
  );
  assert.equal(displaced.statements.length, 1);
});

test("terminal cleanup reacquires an expired exact attempt before retrying provider cleanup", async () => {
  const attemptId =
    "53af1a29-4e98-43d6-ac5b-3b9dcba5e739" as RunnerDaytonaAttemptId;
  const terminal = run({
    completedAt: new Date("2026-01-01T00:00:01.000Z"),
    daytonaAttemptId: attemptId,
    daytonaCommandId: "command",
    daytonaSessionId: daytonaRunSessionName(run().id, attemptId),
    dispatchState: "terminal",
    status: "failed",
    version: 8,
  });
  const claimed = run({
    ...terminal,
    dispatchLeaseExpiresAt: new Date("2026-01-01T00:05:00.000Z"),
    dispatchLeaseToken: "terminal-cleanup-lease",
    version: 9,
  });
  const { statements, store } = scripted(
    [terminal],
    [{ id: terminal.id }],
    [claimed]
  );

  const result = await store.claimTerminalDaytonaAttemptCleanup(operator, {
    attemptId,
    expectedVersion: terminal.version,
    leaseExpiresAt: claimed.dispatchLeaseExpiresAt as Date,
    newLeaseToken: claimed.dispatchLeaseToken as string,
    oldLeaseToken: terminal.dispatchLeaseToken as string,
    runId: terminal.id,
  });

  assert.equal(result.kind, "claimed");
  assert.match(
    queryText(statements[2] as RunnerStoreStatement),
    /"dispatchState" = 'terminal'/u
  );
  assert.match(
    queryText(statements[2] as RunnerStoreStatement),
    /"dispatchLeaseExpiresAt" <= clock_timestamp\(\)/u
  );
});

test("terminal retention at capacity retains unresolved attempts", async () => {
  const { statements, store } = scripted();
  const deleted = await store.pruneTerminalRuns(principal, "agent");

  assert.deepEqual(deleted, []);
  const [pruneStatement] = statements;
  assert.ok(pruneStatement);
  const query = queryText(pruneStatement);
  assert.match(query, /"daytonaAttemptId" IS NULL/);
  assert.match(query, /"daytonaSessionId" IS NULL/);
  assert.match(query, /"daytonaCommandId" IS NULL/);
  assert.match(query, /OFFSET 20/);
});

test("terminal retention prunes cleanup-free runs beyond capacity", async () => {
  const { statements, store } = scripted([{ id: "old-run" }]);
  const deleted = await store.pruneTerminalRuns(principal, "agent");

  assert.deepEqual(deleted, ["old-run"]);
  const [pruneStatement] = statements;
  assert.ok(pruneStatement);
  const query = queryText(pruneStatement);
  assert.match(query, /"status" IN \('completed', 'failed', 'cancelled'\)/);
  assert.match(query, /"daytonaAttemptId" IS NULL/);
  assert.match(query, /"daytonaSessionId" IS NULL/);
  assert.match(query, /"daytonaCommandId" IS NULL/);
  assert.match(query, /OFFSET 20/);
  assert.match(query, /"tenant"\s*=\s*\$\d+/);
  assert.match(
    query,
    /NOT EXISTS \([\s\S]*FROM "RunnerTeamStep"[\s\S]*"runnerRunId" = "RunnerRun"\."id"/u
  );
  assert.match(
    query,
    /"plannedRunnerRunId" = "RunnerRun"\."id"/u,
    "a reserved team child must remain retained before durable attachment"
  );
});

test("global scans require the operator authority and do not manufacture tenant scope", async () => {
  const { statements, store } = scripted([], [], []);
  await store.scanLiveRuns(operator, 10);
  await store.scanExpiredDispatchLeases(operator, new Date(), 10);
  await store.scanTerminalLeaseCleanups(operator, 10);

  for (const statement of statements) {
    assert.equal("tenant" in statement.args, false);
    assert.doesNotMatch(queryText(statement), /"tenant"\s*=\s*\$\d+/);
  }
});

test("terminal residual lease scans are bounded, database-timed, and skip locked", async () => {
  const { statements, store } = scripted([]);
  await store.scanTerminalLeaseCleanups(operator, 10);

  const [scan] = statements;
  assert.ok(scan);
  assert.equal(scan.name, "scan-terminal-lease-cleanups");
  const query = queryText(scan);
  assert.match(query, /"dispatchState" = 'terminal'/u);
  assert.match(query, /"daytonaAttemptId" IS NULL/u);
  assert.match(query, /"daytonaCommandId" IS NULL/u);
  assert.match(query, /"daytonaSessionId" IS NULL/u);
  assert.match(query, /"dispatchLeaseToken" IS NOT NULL/u);
  assert.match(query, /"dispatchLeaseExpiresAt" <= clock_timestamp\(\)/u);
  assert.match(query, /LIMIT \$\d+/u);
  assert.match(query, /FOR UPDATE SKIP LOCKED/u);
  assert.equal(scan.args.limit, 10);
});

test("terminal cleanup scans are bounded and skip locked rows", async () => {
  const { statements, store } = scripted([]);
  await store.scanTerminalDaytonaAttemptCleanups(operator, 10);

  const [scan] = statements;
  assert.ok(scan);
  assert.equal(scan.name, "scan-terminal-daytona-attempt-cleanups");
  assert.match(queryText(scan), /"dispatchState" = 'terminal'/u);
  assert.match(queryText(scan), /"daytonaAttemptId" IS NOT NULL/u);
  assert.match(queryText(scan), /FOR UPDATE SKIP LOCKED/u);
  assert.equal(scan.args.limit, 10);
});

test("sandbox recovery scans durable ambiguous lifecycle rows with skip locking", async () => {
  const { statements, store } = scripted([]);
  await store.scanDaytonaSandboxRecoveries(operator, 10);

  const [scan] = statements;
  assert.ok(scan);
  assert.equal(scan.name, "scan-daytona-sandbox-recoveries");
  assert.match(queryText(scan), /'provisioning_ambiguous'/u);
  assert.match(queryText(scan), /'decommissioning'/u);
  assert.doesNotMatch(queryText(scan), /"warmStatus"/u);
  assert.match(queryText(scan), /FOR UPDATE SKIP LOCKED/u);
});

test("operator inventory scans only bounded durable lifecycle mappings in stable order", async () => {
  const { statements, store } = scripted([]);
  await store.scanDaytonaSandboxInventory(operator, 10);

  const [scan] = statements;
  assert.ok(scan);
  assert.equal(scan.name, "scan-daytona-sandbox-inventory");
  const query = queryText(scan);
  assert.match(query, /"daytonaSandboxId" IS NOT NULL/u);
  assert.match(query, /'provisioning_ambiguous'/u);
  assert.match(query, /'decommission_failed'/u);
  assert.match(query, /ORDER BY "sandboxUpdatedAt" ASC, "id" ASC/u);
  assert.match(query, /LIMIT \$\d+/u);
  assert.doesNotMatch(query, /FOR UPDATE|SKIP LOCKED/u);
  assert.deepEqual(scan.args, { limit: 10 });

  for (const invalidLimit of [0, 101, 1.5]) {
    assert.throws(
      () => store.scanDaytonaSandboxInventory(operator, invalidLimit),
      /Resource inventory limit/u
    );
  }
});

test("operator repair candidates prioritize durable resize recovery and count duplicate mappings", async () => {
  const candidate = agent({
    daytonaSandboxId: "sandbox-repair-candidate",
    sandboxLifecycle: "resizing",
  });
  const { statements, store } = scripted([
    {
      ...candidate,
      appOwnedMappings: "6",
      providerMappingCount: "1",
    },
  ]);

  assert.deepEqual(
    await store.scanDaytonaSandboxRepairCandidates(operator, 5),
    [
      {
        appOwnedMappings: 6,
        mapping: candidate,
        providerMappingCount: 1,
      },
    ]
  );
  const [scan] = statements;
  assert.ok(scan);
  assert.equal(scan.name, "scan-daytona-sandbox-repair-candidates");
  const query = queryText(scan);
  assert.match(query, /count\(\*\) OVER \(\)/u);
  assert.match(query, /PARTITION BY "daytonaSandboxId"/u);
  assert.match(query, /"sandboxLifecycle" IN \('ready', 'resizing'\)/u);
  assert.match(query, /"status" = 'idle'/u);
  assert.match(query, /"warmStatus" <> 'provisioning'/u);
  assert.match(query, /"liveRun"\."status" IN \('queued', 'running'\)/u);
  assert.match(
    query,
    /CASE WHEN "providerMappingCount" = 1 THEN 0 ELSE 1 END/u
  );
  assert.match(
    query,
    /CASE WHEN "sandboxLifecycle" = 'resizing' THEN 0 ELSE 1 END/u
  );
  assert.match(query, /LIMIT \$\d+/u);
});

test("warm recovery has an independent bounded oldest-first scan", async () => {
  const { statements, store } = scripted([]);
  const staleBefore = new Date("2026-08-28T15:00:00.000Z");
  await store.scanDaytonaWarmRecoveries(operator, staleBefore, 10);

  const [scan] = statements;
  assert.ok(scan);
  assert.equal(scan.name, "scan-daytona-warm-recoveries");
  const query = queryText(scan);
  assert.match(query, /"sandboxLifecycle" = 'ready'/u);
  assert.match(query, /"warmStatus" = 'provisioning'/u);
  assert.match(query, /"warmUpdatedAt" <= \$/u);
  assert.match(query, /ORDER BY "warmUpdatedAt" ASC, "id" ASC/u);
  assert.match(query, /LIMIT \$\d+/u);
  assert.match(query, /FOR UPDATE SKIP LOCKED/u);
  assert.deepEqual(scan.args, { limit: 10, staleBefore });
});

test("operator warm recovery fails only its exact fenced warm attempt", async () => {
  const current = agent({
    sandboxGeneration: 2,
    sandboxLifecycle: "ready",
    version: 4,
    warmAttemptVersion: 2,
    warmStatus: "provisioning",
  });
  const failed = agent({
    ...current,
    version: 5,
    warmStatus: "failed",
  });
  const updated = scripted([failed]);

  const result = await updated.store.finishDaytonaSandboxWarmForRecovery(
    operator,
    {
      agentId: current.id,
      expectedGeneration: current.sandboxGeneration,
      expectedVersion: current.version,
    }
  );

  assert.equal(result.kind, "updated");
  const query = queryText(updated.statements[0] as RunnerStoreStatement);
  assert.match(query, /"warmStatus" = 'failed'/u);
  assert.match(query, /"version" = \$\d+/u);
  assert.match(query, /"sandboxGeneration" = \$\d+/u);
  assert.match(query, /"warmStatus" = 'provisioning'/u);
});

test("operator sandbox recovery attaches or resets only its fenced generation", async () => {
  const current = agent({
    sandboxGeneration: 2,
    sandboxLifecycle: "provisioning_ambiguous",
    version: 4,
  });
  const attached = agent({
    ...current,
    daytonaSandboxId: "recovered-sandbox",
    sandboxLifecycle: "ready",
    version: 5,
  });
  const reset = agent({
    ...current,
    sandboxLifecycle: "unprovisioned",
    version: 5,
  });
  const attachStore = scripted([attached]);
  const resetStore = scripted([reset]);
  const fence = {
    agentId: current.id,
    expectedGeneration: current.sandboxGeneration,
    expectedVersion: current.version,
  };

  assert.equal(
    (
      await attachStore.store.attachDaytonaSandboxForRecovery(operator, {
        ...fence,
        sandboxId: attached.daytonaSandboxId as string,
      })
    ).kind,
    "updated"
  );
  assert.equal(
    (await resetStore.store.resetDaytonaSandboxRecovery(operator, fence)).kind,
    "updated"
  );
  assert.match(
    queryText(attachStore.statements[0] as RunnerStoreStatement),
    /"sandboxLifecycle" IN \('provisioning', 'provisioning_ambiguous'\)/u
  );
  assert.match(
    queryText(resetStore.statements[0] as RunnerStoreStatement),
    /"sandboxLifecycle" = 'unprovisioned'/u
  );
});

test("operator sandbox recovery deletes only a fenced decommissioning agent", async () => {
  const current = agent({
    daytonaSandboxId: "sandbox",
    sandboxGeneration: 2,
    sandboxLifecycle: "decommissioning",
    version: 4,
  });
  const { statements, store } = scripted([{ id: current.id }]);

  assert.deepEqual(
    await store.deleteDecommissionedAgentForRecovery(operator, {
      agentId: current.id,
      expectedGeneration: current.sandboxGeneration,
      expectedVersion: current.version,
    }),
    { kind: "deleted" }
  );
  assert.match(
    queryText(statements[0] as RunnerStoreStatement),
    /"sandboxLifecycle" = 'decommissioning'/u
  );
  assert.match(
    queryText(statements[0] as RunnerStoreStatement),
    /"version" = \$/u
  );
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
  const start = scripted(
    [agent({ id: current.agentId, sandboxLifecycle: "ready" })],
    [],
    [],
    [current]
  );

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
    runtime: "copilot",
  });
  await update.store.updateAgent(principal, {
    description: "",
    expectedVersion: 0,
    id: current.agentId,
    instructions: "test instructions",
    model: "test-model",
    name: "test",
    runtime: "copilot",
    workspace: null,
  });
  await remove.store.deleteAgent(principal, current.agentId);
  await start.store.startRun(principal, {
    agentId: current.agentId,
    authVersion: 1,
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

test("Daytona process attachment has no arbitrary legacy store API", () => {
  const { store } = scripted();

  assert.equal(Object.hasOwn(store, "attachDaytonaIdentifiers"), false);
  assert.equal(Object.hasOwn(store, "attachDaytonaProcessForDispatch"), false);
});

test("dispatch authority derives agent ownership from its live leased run", async () => {
  const dispatching = run();
  const authority = await claimedAuthority(dispatching);
  const associated = agent({
    id: dispatching.agentId,
    tenant: dispatching.tenant,
  });
  const { statements, store } = scripted([dispatching], [associated]);

  const result = await store.getDispatchAgent(operator, authority);

  assert.equal(result.kind, "found");
  assert.equal(result.kind === "found" && result.agent.id, dispatching.agentId);
  assert.deepEqual(
    statements.map((statement) => statement.name),
    ["lock-live-dispatch-run", "lock-agent-for-live-dispatch"]
  );
  assert.equal(statements[1]?.args.agentId, dispatching.agentId);
  assert.equal(statements[1]?.args.tenant, dispatching.tenant);
  assert.match(
    queryText(statements[0] as RunnerStoreStatement),
    /"dispatchLeaseExpiresAt" > clock_timestamp\(\)/
  );
});

test("fair dispatch selection locks scheduler and enforces tenant and agent capacity", async () => {
  const queued = run({
    dispatchLeaseExpiresAt: null,
    dispatchLeaseToken: null,
    dispatchState: "queued",
    version: 1,
  });
  const claimed = run({
    ...queued,
    dispatchLeaseExpiresAt: new Date("2026-01-01T00:01:00.000Z"),
    dispatchLeaseToken: "lease-a",
    dispatchState: "dispatching",
    version: 2,
  });
  const { statements, store } = scripted(
    [{ consecutiveDispatchCount: 2, lastDispatchedTenantHash: "hash-a" }],
    [{ activeCount: 1 }],
    [queued],
    [claimed],
    []
  );

  const result = await store.claimNextDispatch(operator, {
    leaseExpiresAt: claimed.dispatchLeaseExpiresAt as Date,
    leaseToken: claimed.dispatchLeaseToken as string,
    limits: {
      consecutiveDispatches: 2,
      deploymentActiveRuns: 25,
      tenantActiveRuns: 2,
      tenantQueuedRuns: 10,
    },
  });

  assert.equal(result?.run.id, queued.id);
  assert.deepEqual(
    statements.map((entry) => entry.name),
    [
      "lock-runner-scheduler",
      "count-active-runs-for-admission",
      "lock-next-eligible-dispatch",
      "claim-next-dispatch",
      "advance-runner-scheduler",
    ]
  );
  const activeCount = queryText(statements[1] as RunnerStoreStatement);
  const candidate = queryText(statements[2] as RunnerStoreStatement);
  assert.match(activeCount, /"dispatchState" = 'terminal'/u);
  assert.match(activeCount, /"authorityRevalidation" = false/u);
  assert.match(activeCount, /"daytonaAttemptId" IS NOT NULL/u);
  assert.match(activeCount, /"daytonaCommandId" IS NOT NULL/u);
  assert.match(activeCount, /"daytonaSessionId" IS NOT NULL/u);
  assert.match(candidate, /FOR UPDATE OF "queued" SKIP LOCKED/u);
  assert.match(candidate, /"agentActive"/u);
  assert.match(candidate, /"tenantActive"/u);
  assert.match(candidate, /"agentActive"\."authorityRevalidation" = false/u);
  assert.match(candidate, /"tenantActive"\."authorityRevalidation" = false/u);
  assert.match(
    candidate,
    /"agentActive"\."dispatchState" = 'terminal'[\s\S]*"agentActive"\."daytonaAttemptId" IS NOT NULL/u
  );
  assert.match(
    candidate,
    /"tenantActive"\."dispatchState" = 'terminal'[\s\S]*"tenantActive"\."daytonaAttemptId" IS NOT NULL/u
  );
  assert.equal(statements[2]?.args.consecutiveDispatches, 2);
  assert.equal(statements[2]?.args.lastDispatchedTenantHash, "hash-a");
  assert.match(candidate, /md5\("queued"\."tenant"\)/u);
});

test("queue selection stays globally FIFO until the consecutive tenant cap requires a switch", async () => {
  const queued = run({
    dispatchLeaseExpiresAt: null,
    dispatchLeaseToken: null,
    dispatchState: "queued",
  });
  const claimed = run({
    ...queued,
    dispatchLeaseExpiresAt: new Date("2026-01-01T00:01:00.000Z"),
    dispatchLeaseToken: "lease-b",
  });
  const { statements, store } = scripted(
    [{ consecutiveDispatchCount: 1, lastDispatchedTenantHash: "tenant-a" }],
    [{ activeCount: 0 }],
    [queued],
    [claimed],
    []
  );

  await store.claimNextDispatch(operator, {
    leaseExpiresAt: claimed.dispatchLeaseExpiresAt as Date,
    leaseToken: claimed.dispatchLeaseToken as string,
    limits: {
      consecutiveDispatches: 2,
      deploymentActiveRuns: 25,
      tenantActiveRuns: 2,
      tenantQueuedRuns: 10,
    },
  });

  const selection = queryText(statements[2] as RunnerStoreStatement);
  assert.match(selection, /ORDER BY "queued"\."queueSequence" ASC\s+LIMIT 1/u);
  assert.match(selection, /\$\d+ >= \$\d+[\s\S]*"tenantHash" = \$/u);
  assert.equal(statements[2]?.args.consecutiveDispatches, 2);
  assert.match(selection, /FROM eligible_tenants AS "otherTenant"/u);
  assert.doesNotMatch(selection, /lastTenantEligible|lastHeadSequence/u);
});

test("authority revalidation claims queued work without scheduler capacity", async () => {
  const queued = run({
    dispatchLeaseExpiresAt: null,
    dispatchLeaseToken: null,
    dispatchState: "queued",
    version: 1,
  });
  const claimed = run({
    ...queued,
    dispatchLeaseExpiresAt: new Date("2026-01-01T00:01:00.000Z"),
    dispatchLeaseToken: "lease-revalidation",
    dispatchState: "dispatching",
    version: 2,
  });
  const { statements, store } = scripted([queued], [claimed]);

  const result = await store.claimQueuedDispatchForRevalidation(operator, {
    leaseExpiresAt: claimed.dispatchLeaseExpiresAt as Date,
    leaseToken: claimed.dispatchLeaseToken as string,
  });

  assert.equal(result?.run.id, queued.id);
  assert.deepEqual(
    statements.map((entry) => entry.name),
    ["lock-queued-dispatch-for-revalidation", "claim-next-dispatch"]
  );
  assert.equal(statements[1]?.args.authorityRevalidation, true);
  const selection = queryText(statements[0] as RunnerStoreStatement);
  assert.match(selection, /"dispatchState" = 'queued'/u);
  assert.match(selection, /FOR UPDATE SKIP LOCKED/u);
  assert.match(selection, /ORDER BY "updatedAt" ASC, "queueSequence" ASC/u);
  assert.doesNotMatch(selection, /"RunnerScheduler"|tenantActive|agentActive/u);
  await store.claimQueuedDispatchForRevalidation(operator, {
    excludedRunIds: [
      "00000000-0000-4000-8000-000000000010",
      "00000000-0000-4000-8000-000000000011",
    ],
    leaseExpiresAt: claimed.dispatchLeaseExpiresAt as Date,
    leaseToken: claimed.dispatchLeaseToken as string,
  });
  const exclusions = statements[2] as RunnerStoreStatement;
  assert.match(queryText(exclusions), /"id" NOT IN \(\$1, \$2\)/u);
  assert.deepEqual(queryParams(exclusions), [
    "00000000-0000-4000-8000-000000000010",
    "00000000-0000-4000-8000-000000000011",
  ]);
});

test("dispatch authority cannot access unleased, expired, or another run", async () => {
  const authority = await claimedAuthority(run());
  const denied = await Promise.all(
    ["unleased", "expired", "other"].map(async (label) => {
      const { statements, store } = scripted([]);
      const result = await store.getDispatchAgent(operator, authority);

      return { label, result, statements };
    })
  );
  for (const { label, result, statements } of denied) {
    assert.deepEqual(result, { kind: "not_live" }, label);
    assert.equal(statements.length, 1, label);
    assert.match(
      queryText(statements[0] as RunnerStoreStatement),
      /"dispatchLeaseToken" = \$\d+/
    );
  }
});

test("dispatch sandbox and event mutations are fenced and derive their agent", async () => {
  const running = run({
    dispatchState: "running",
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    status: "running",
  });
  const authority = await claimedAuthority(running);
  const provisioning = agent({
    id: running.agentId,
    sandboxGeneration: 2,
    sandboxLifecycle: "provisioning",
    tenant: running.tenant,
    version: 4,
  });
  const attached = agent({
    ...provisioning,
    daytonaSandboxId: "sandbox",
    sandboxLifecycle: "ready",
    version: 5,
  });
  const sandboxStore = scripted([running], [provisioning], [attached]);
  const attachedResult =
    await sandboxStore.store.attachDaytonaSandboxForDispatch(
      operator,
      authority,
      {
        expectedGeneration: provisioning.sandboxGeneration,
        expectedVersion: provisioning.version,
        sandboxId: "sandbox",
      }
    );
  assert.equal(attachedResult.kind, "updated");
  assert.equal(sandboxStore.statements[2]?.args.agentId, running.agentId);
  assert.equal("agentId" in (sandboxStore.statements[0]?.args ?? {}), false);

  const updated = run({ ...running, logCursor: 4, version: 8 });
  const event = {
    createdAt: new Date(),
    event: { id: 4, output: "progress", type: "output" },
    eventId: 4,
    runId: running.id,
  };
  const eventStore = scripted([running], [updated], [event], []);
  const appended = await eventStore.store.appendDispatchEvent(
    operator,
    authority,
    { event: { output: "progress", type: "output" } }
  );
  assert.equal(appended.kind, "appended");
  assert.equal(eventStore.statements[1]?.args.tenant, running.tenant);
  assert.equal("userId" in (eventStore.statements[1]?.args ?? {}), false);
});

test("dispatch store methods fence preparation, attachment, and release", async () => {
  const dispatching = run();
  const authority = await claimedAuthority(dispatching);
  const preparedRun = run({ version: dispatching.version + 1 });
  const preparation = scripted([dispatching], [preparedRun]);

  const claim = await preparation.store.authorizeDaytonaPreparation(
    operator,
    authority,
    { executionProvenance }
  );
  assert.equal(claim.kind, "authorized");
  assert.match(
    String(claim.kind === "authorized" && claim.attemptId),
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
  );
  assert.match(
    queryText(preparation.statements[1] as RunnerStoreStatement),
    /"daytonaAttemptId" IS NULL/
  );
  assert.match(
    queryText(preparation.statements[1] as RunnerStoreStatement),
    /"daytonaSessionId" IS NULL/
  );
  assert.match(
    queryText(preparation.statements[1] as RunnerStoreStatement),
    /"version" = "version" \+ 1/
  );
  assert.deepEqual(
    (preparation.statements[1] as RunnerStoreStatement).args
      .executionProvenance,
    executionProvenance
  );
  assert.equal(claim.kind, "authorized");
  if (claim.kind !== "authorized") {
    throw new Error("Preparation unexpectedly lost its dispatch.");
  }
  const sessionId = daytonaRunSessionName(dispatching.id, claim.attemptId);

  const launchCurrent = run({
    daytonaAttemptId: claim.attemptId,
    version: preparedRun.version,
  });
  const launchUpdated = run({
    daytonaAttemptId: claim.attemptId,
    daytonaCommandId: "command",
    daytonaSessionId: sessionId,
    version: launchCurrent.version + 1,
  });
  const launch = scripted([launchCurrent], [launchUpdated]);
  const launched = await launch.store.authorizeDaytonaLaunch(
    operator,
    claim.authority,
    {
      attemptId: claim.attemptId,
      commandId: "command",
      sessionId,
    }
  );
  assert.equal(launched.kind, "authorized");
  assert.equal(
    launched.kind === "authorized" && launched.value.daytonaSessionId,
    sessionId
  );
  assert.equal(
    launched.kind === "authorized" && launched.value.daytonaAttemptId,
    claim.attemptId
  );
  assert.match(
    queryText(launch.statements[1] as RunnerStoreStatement),
    /"dispatchLeaseExpiresAt" > clock_timestamp\(\)/
  );
  assert.doesNotMatch(
    queryText(launch.statements[1] as RunnerStoreStatement),
    /"daytonaAttemptId" = NULL/
  );

  const trust = scripted([launchCurrent], [{ id: launchCurrent.agentId }]);
  assert.deepEqual(
    await trust.store.authorizeUnrestrictedExecution(operator, claim.authority),
    { kind: "authorized" }
  );
  assert.match(
    queryText(trust.statements[1] as RunnerStoreStatement),
    /"sandboxTrust" = 'unrestricted'[\s\S]*"version" = "version" \+ 1/u
  );

  const releaseCurrent = run({
    daytonaAttemptId: claim.attemptId,
    version: preparedRun.version,
  });
  const releaseUpdated = run({
    daytonaAttemptId: null,
    version: releaseCurrent.version + 1,
  });
  const release = scripted([releaseCurrent], [releaseUpdated]);
  const released = await release.store.releaseDaytonaPreparation(
    operator,
    claim.authority,
    { attemptId: claim.attemptId }
  );
  assert.equal(released.kind, "released");
  assert.equal(
    released.kind === "released" && released.authority.expectedVersion,
    releaseUpdated.version
  );
  assert.match(
    queryText(release.statements[1] as RunnerStoreStatement),
    /"daytonaAttemptId" = \$\d+/
  );
  assert.match(
    queryText(release.statements[1] as RunnerStoreStatement),
    /"dispatchLeaseExpiresAt" > clock_timestamp\(\)/
  );
  assert.match(
    queryText(release.statements[1] as RunnerStoreStatement),
    /"executionProvenance" = NULL/
  );

  const retryCurrent = run({
    executionProvenance: null,
    version: releaseUpdated.version,
  });
  const retryUpdated = run({
    daytonaAttemptId: claim.attemptId,
    executionProvenance: retryExecutionProvenance,
    version: retryCurrent.version + 1,
  });
  const retry = scripted([retryCurrent], [retryUpdated]);
  assert.equal(
    (
      await retry.store.authorizeDaytonaPreparation(operator, authority, {
        executionProvenance: retryExecutionProvenance,
      })
    ).kind,
    "authorized"
  );
  assert.deepEqual(
    (retry.statements[1] as RunnerStoreStatement).args.executionProvenance,
    retryExecutionProvenance
  );

  let callbackLaunched = false;
  const callbacks = daytonaDispatchAuthorizers(
    {
      authorizeDaytonaLaunch: (_operator, prepared, input) => {
        callbackLaunched =
          prepared.attemptId === claim.attemptId &&
          input.attemptId === claim.attemptId &&
          input.sessionId === sessionId;
        return Promise.resolve({
          authority:
            launched.kind === "authorized" ? launched.authority : authority,
          kind: "authorized" as const,
          value: launchUpdated,
        });
      },
      authorizeDaytonaPreparation: () => Promise.resolve(claim),
      authorizeUnrestrictedExecution: () =>
        Promise.resolve({ kind: "authorized" as const }),
      releaseDaytonaPreparation: () =>
        Promise.resolve({ authority, kind: "released" as const }),
    },
    operator,
    authority,
    executionProvenance
  );
  const callbackClaim = await callbacks.authorizePreparation({
    runId: dispatching.id,
  });
  assert.equal(callbackClaim, claim.attemptId);
  assert.equal(
    await callbacks.authorizeUnrestrictedExecution({
      attemptId: claim.attemptId,
      runId: dispatching.id,
    }),
    true
  );
  assert.equal(
    await callbacks.authorizeLaunch({
      attemptId: claim.attemptId,
      commandId: "command",
      runId: dispatching.id,
      sessionId,
    }),
    launched.kind === "authorized" ? launched.authority : null
  );
  assert.equal(callbackLaunched, true);
  assert.equal(
    callbacks.currentAuthority().expectedVersion,
    launched.kind === "authorized"
      ? launched.authority.expectedVersion
      : authority.expectedVersion
  );
});

test("attempt ownership excludes parallel attempts and stale releases", async () => {
  const dispatching = run();
  const authority = await claimedAuthority(dispatching);
  const existingClaim =
    "53af1a29-4e98-43d6-ac5b-3b9dcba5e732" as RunnerDaytonaAttemptId;
  const parallel = scripted([
    run({
      daytonaAttemptId: existingClaim,
      executionProvenance,
      version: authority.expectedVersion,
    }),
  ]);

  assert.deepEqual(
    await parallel.store.authorizeDaytonaPreparation(operator, authority, {
      executionProvenance: retryExecutionProvenance,
    }),
    { kind: "not_live" }
  );
  assert.equal(parallel.statements.length, 1);
  assert.equal(
    "executionProvenance" in
      (parallel.statements[0] as RunnerStoreStatement).args,
    false,
    "a claimed attempt cannot be overwritten with a different descriptor"
  );

  const staleProvenance = scripted([
    run({
      daytonaAttemptId: null,
      executionProvenance,
      version: authority.expectedVersion,
    }),
  ]);
  assert.deepEqual(
    await staleProvenance.store.authorizeDaytonaPreparation(
      operator,
      authority,
      { executionProvenance: retryExecutionProvenance }
    ),
    { kind: "not_live" }
  );
  assert.equal(
    staleProvenance.statements.length,
    1,
    "stale provenance must fence a new attempt before an attachment write"
  );

  const staleAuthority = {
    ...authority,
    attemptId: "53af1a29-4e98-43d6-ac5b-3b9dcba5e733" as RunnerDaytonaAttemptId,
  } as RunnerDispatchAuthority;
  const staleRelease = scripted([
    run({
      daytonaAttemptId: existingClaim,
      version: authority.expectedVersion,
    }),
  ]);

  assert.deepEqual(
    await staleRelease.store.releaseDaytonaPreparation(
      operator,
      staleAuthority,
      {
        attemptId: staleAuthority.attemptId as RunnerDaytonaAttemptId,
      }
    ),
    { kind: "not_live" }
  );
  assert.equal(staleRelease.statements.length, 1);
});

test("dispatch callbacks deny a run with durable cancellation intent", async () => {
  const authority = {
    expectedVersion: 7,
    leaseToken: "lease-a",
    runId: run().id,
  } as RunnerDispatchAuthority;
  const { statements, store } = scripted([
    run({ cancellationRequestedAt: new Date("2026-01-01T00:00:00.000Z") }),
  ]);

  assert.deepEqual(
    await store.authorizeDaytonaPreparation(operator, authority, {
      executionProvenance,
    }),
    { kind: "not_live" }
  );
  assert.equal(statements.length, 1);
  assert.match(
    queryText(statements[0] as RunnerStoreStatement),
    /"cancellationRequestedAt" IS NULL/u
  );
});

test("cancellation intent fences the old dispatcher before remote cleanup", async () => {
  const attemptId =
    "53af1a29-4e98-43d6-ac5b-3b9dcba5e739" as RunnerDaytonaAttemptId;
  const current = run({ daytonaAttemptId: attemptId });
  const requested = run({
    ...current,
    cancellationRequestedAt: new Date("2026-01-01T00:00:01.000Z"),
    dispatchLeaseExpiresAt: new Date("2026-01-01T00:02:00.000Z"),
    dispatchLeaseToken: "cancel-lease",
    version: current.version + 1,
  });

  const { statements, store } = scripted([current], [requested]);

  const result = await store.requestRunCancellation(operator, {
    leaseExpiresAt: requested.dispatchLeaseExpiresAt as Date,
    leaseToken: requested.dispatchLeaseToken as string,
    runId: current.id,
  });

  assert.equal(result.kind, "requested");
  assert.equal(
    result.kind === "requested" && result.authority.attemptId,
    attemptId
  );
  const update = statements[1] as RunnerStoreStatement;
  assert.match(
    queryText(update),
    /"cancellationRequestedAt" = clock_timestamp\(\)/u
  );
  assert.match(queryText(update), /"dispatchLeaseToken" = \$\d+/u);
});

test("cancellation cleanup stores preserve exact stale version and lease fences", async () => {
  const current = run();
  const staleAuthority = {
    expectedVersion: current.version - 1,
    leaseToken: current.dispatchLeaseToken as string,
    runId: current.id,
  } as RunnerDispatchAuthority;
  const stale = scripted([current]);
  assert.deepEqual(
    await stale.store.deleteAttemptRedaction(operator, staleAuthority),
    { kind: "stale_version" }
  );

  const displacedAuthority = {
    expectedVersion: current.version,
    leaseToken: "displaced-lease",
    runId: current.id,
  } as RunnerDispatchAuthority;
  const displaced = scripted([current]);
  assert.deepEqual(
    await displaced.store.beginDaytonaSandboxResetForCancellation(
      operator,
      displacedAuthority
    ),
    { kind: "lease_lost" }
  );
});

test("queued cancellation enters a schema-valid leased cleanup state", async () => {
  const queued = run({
    dispatchLeaseExpiresAt: null,
    dispatchLeaseToken: null,
    dispatchState: "queued",
  });
  const requested = run({
    ...queued,
    cancellationRequestedAt: new Date("2026-01-01T00:00:01.000Z"),
    dispatchLeaseExpiresAt: new Date("2026-01-01T00:01:00.000Z"),
    dispatchLeaseToken: "cancel-lease",
    dispatchState: "dispatching",
    version: queued.version + 1,
  });
  const { statements, store } = scripted([queued], [requested]);

  const result = await store.requestRunCancellation(operator, {
    leaseExpiresAt: requested.dispatchLeaseExpiresAt as Date,
    leaseToken: requested.dispatchLeaseToken as string,
    runId: queued.id,
  });

  assert.equal(result.kind, "requested");
  assert.equal(
    result.kind === "requested" && satisfiesDispatchLeaseConstraint(result.run),
    true
  );
  const update = queryText(statements[1] as RunnerStoreStatement);
  assert.match(update, /WHEN "dispatchState" = 'queued' THEN 'dispatching'/u);
  assert.match(update, /"cancellationRequestedAt" = clock_timestamp\(\)/u);
});

test("sandbox-reset-required cancellation records only a safe diagnostic", async () => {
  const current = run({
    cancellationRequestedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  const updated = run({ ...current, logCursor: 4, version: 8 });
  const event = {
    createdAt: new Date(),
    event: {
      id: 4,
      output: "Cancellation cleanup requires a sandbox reset.",
      type: "output",
    } as const,
    eventId: 4,
    runId: current.id,
  };
  const authority = {
    expectedVersion: current.version,
    leaseToken: current.dispatchLeaseToken as string,
    runId: current.id,
  } as RunnerDispatchAuthority;
  const { statements, store } = scripted([current], [updated], [event], []);

  const result = await store.appendCancellationDiagnostic(operator, authority);

  assert.equal(result.kind, "appended");
  const persisted = JSON.parse(
    String((statements[2] as RunnerStoreStatement).args.event)
  );
  assert.equal(
    persisted.output,
    "Cancellation cleanup requires a sandbox reset."
  );
  assert.doesNotMatch(JSON.stringify(persisted), /secret|token|cookie/u);
});

test("terminal reset requirements append a safe fenced diagnostic without clearing the attempt", async () => {
  const attemptId =
    "53af1a29-4e98-43d6-ac5b-3b9dcba5e738" as RunnerDaytonaAttemptId;
  const terminal = run({
    completedAt: new Date("2026-01-01T00:00:02.000Z"),
    daytonaAttemptId: attemptId,
    daytonaCommandId: "command",
    daytonaSessionId: daytonaRunSessionName(run().id, attemptId),
    dispatchState: "terminal",
    status: "failed",
  });
  const updated = run({ ...terminal, logCursor: 4, version: 8 });
  const event = {
    createdAt: new Date(),
    event: {
      id: 4,
      output: "Terminal cleanup requires a sandbox reset.",
      type: "output",
    } as const,
    eventId: 4,
    runId: terminal.id,
  };
  const authority = {
    attemptId,
    expectedVersion: terminal.version,
    leaseToken: terminal.dispatchLeaseToken as string,
    runId: terminal.id,
  } as RunnerDispatchAuthority;
  const { statements, store } = scripted([terminal], [updated], [event], []);

  const result = await store.appendTerminalCleanupDiagnostic(
    operator,
    authority
  );

  assert.equal(result.kind, "appended");
  assert.match(
    queryText(statements[1] as RunnerStoreStatement),
    /"dispatchState" = 'terminal'/u
  );
  assert.equal(
    JSON.stringify((statements[2] as RunnerStoreStatement).args).includes(
      "secret"
    ),
    false
  );
});

test("cancellation sandbox reset reserves and clears a fenced generation", async () => {
  const current = run({
    cancellationRequestedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  const currentAgent = agent({
    daytonaSandboxId: "sandbox",
    sandboxGeneration: 2,
    sandboxLifecycle: "ready",
    version: 4,
  });
  const resetting = agent({
    ...currentAgent,
    sandboxGeneration: 3,
    sandboxLifecycle: "resetting" as never,
    version: 5,
  });
  const cleared = agent({
    ...resetting,
    daytonaSandboxId: null,
    sandboxLifecycle: "unprovisioned",
    version: 6,
  });
  const authority = {
    expectedVersion: current.version,
    leaseToken: current.dispatchLeaseToken as string,
    runId: current.id,
  } as RunnerDispatchAuthority;
  const reserve = scripted([current], [currentAgent], [resetting]);
  const finish = scripted([cleared]);

  const reserved = await reserve.store.beginDaytonaSandboxResetForCancellation(
    operator,
    authority
  );
  assert.equal(reserved.kind, "resetting");
  assert.equal(
    (
      await finish.store.finishDaytonaSandboxResetForRecovery(operator, {
        agentId: resetting.id,
        expectedGeneration: resetting.sandboxGeneration,
        expectedVersion: resetting.version,
      })
    ).kind,
    "updated"
  );
  assert.match(
    queryText(reserve.statements[2] as RunnerStoreStatement),
    /"sandboxLifecycle" = 'resetting'/u
  );
  assert.match(
    queryText(finish.statements[0] as RunnerStoreStatement),
    /"daytonaSandboxId" = NULL/u
  );
  assert.match(
    queryText(finish.statements[0] as RunnerStoreStatement),
    /"sandboxTrust" = 'clean'/u
  );
});

test("terminal attempt cleanup can reserve a fenced sandbox reset", async () => {
  const attemptId =
    "53af1a29-4e98-43d6-ac5b-3b9dcba5e740" as RunnerDaytonaAttemptId;
  const terminal = run({
    completedAt: new Date("2026-01-01T00:00:02.000Z"),
    daytonaAttemptId: attemptId,
    daytonaCommandId: "command",
    daytonaSessionId: daytonaRunSessionName(run().id, attemptId),
    dispatchState: "terminal",
    status: "failed",
  });
  const currentAgent = agent({
    daytonaSandboxId: "sandbox",
    sandboxGeneration: 2,
    sandboxLifecycle: "ready",
    version: 4,
  });
  const resetting = agent({
    ...currentAgent,
    sandboxGeneration: 3,
    sandboxLifecycle: "resetting" as never,
    version: 5,
  });
  const authority = {
    attemptId,
    expectedVersion: terminal.version,
    leaseToken: terminal.dispatchLeaseToken as string,
    runId: terminal.id,
  } as RunnerDispatchAuthority;
  const { statements, store } = scripted(
    [terminal],
    [currentAgent],
    [resetting]
  );

  const reserved = await store.beginDaytonaSandboxResetForCancellation(
    operator,
    authority
  );

  assert.equal(reserved.kind, "resetting");
  const update = queryText(statements[2] as RunnerStoreStatement);
  assert.match(update, /"dispatchState" = 'terminal'/u);
  assert.match(update, /"daytonaAttemptId" = \$\d+/u);
  assert.match(update, /"activeRun"/u);
});

test("a proven unstarted dispatch releases its exact lease for the next queue claim", async () => {
  const current = run();
  const released = run({
    ...current,
    dispatchLeaseExpiresAt: null,
    dispatchLeaseToken: null,
    dispatchState: "queued",
    version: current.version + 1,
  });
  const authority = {
    expectedVersion: current.version,
    leaseToken: current.dispatchLeaseToken as string,
    runId: current.id,
  } as RunnerDispatchAuthority;
  const { statements, store } = scripted([current], [released]);

  assert.deepEqual(await store.releaseUnstartedDispatch(operator, authority), {
    kind: "released",
    value: released,
  });
  const update = statements[1] as RunnerStoreStatement;
  assert.match(queryText(update), /"daytonaAttemptId" IS NULL/u);
  assert.match(queryText(update), /"dispatchLeaseExpiresAt" = NULL/u);
  assert.match(
    queryText(update),
    /"dispatchLeaseExpiresAt" > clock_timestamp\(\)/u
  );
});

test("active queued, dispatching, running, and cancelling runs block agent updates without mutation", async () => {
  const current = agent({ runtime: "copilot", version: 4 });
  const activeRuns = [
    run({ dispatchState: "queued", status: "queued" }),
    run({ dispatchState: "dispatching", status: "queued" }),
    run({ dispatchState: "running", status: "running" }),
    run({
      cancellationRequestedAt: new Date("2026-01-01T00:00:01.000Z"),
      dispatchState: "running",
      status: "running",
    }),
  ];

  await Promise.all(
    activeRuns.map(async (activeRun) => {
      const blocked = scripted([current], [{ id: activeRun.id }]);
      assert.deepEqual(
        await blocked.store.updateAgent(principal, {
          description: "changed",
          expectedVersion: current.version,
          id: current.id,
          instructions: "changed",
          model: "changed",
          name: "changed",
          runtime: "copilot",
          workspace: "/changed",
        }),
        { kind: "busy" },
        activeRun.dispatchState
      );
      assert.deepEqual(
        blocked.statements.map((currentStatement) => currentStatement.name),
        ["lock-agent-for-update", "find-live-run-for-agent-update"]
      );
      assert.equal(current.version, 4);
      assert.equal(current.warmStatus, "not_started");
    })
  );
});

test("terminal runs do not block agent updates and versions use database time", async () => {
  const current = agent({ version: 4 });
  const updated = agent({ version: 5 });
  const update = scripted([current], [], [updated]);

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
  assert.deepEqual(
    update.statements.map((currentStatement) => currentStatement.name),
    ["lock-agent-for-update", "find-live-run-for-agent-update", "update-agent"]
  );
  const activeQuery = queryText(update.statements[1] as RunnerStoreStatement);
  assert.match(activeQuery, /"status" IN \('queued', 'running'\)/u);
  const query = queryText(update.statements[2] as RunnerStoreStatement);
  assert.match(query, /"version" = "version" \+ 1/);
  assert.match(query, /AND "version" = \$\d+/);
  assert.doesNotMatch(query, /"updatedAt" = \$\d+/);
});

test("agent update keeps stale and tenant-scoped not-found outcomes nondisclosing", async () => {
  const current = agent({ version: 5 });
  const stale = scripted([current]);
  const missing = scripted([]);
  const input = {
    description: current.description,
    expectedVersion: 4,
    id: current.id,
    instructions: current.instructions,
    model: current.model,
    name: current.name,
    runtime: current.runtime,
    workspace: current.workspace,
  };

  assert.deepEqual(await stale.store.updateAgent(principal, input), {
    kind: "stale_version",
  });
  assert.deepEqual(
    await missing.store.updateAgent(
      { ...principal, tenant: "tenant_b" },
      input
    ),
    { kind: "not_found" }
  );
  assert.deepEqual(
    stale.statements.map((currentStatement) => currentStatement.name),
    ["lock-agent-for-update"]
  );
  assert.deepEqual(
    missing.statements.map((currentStatement) => currentStatement.name),
    ["lock-agent-for-update"]
  );
  assert.match(
    queryText(missing.statements[0] as RunnerStoreStatement),
    /"tenant"\s*=\s*\$\d+/u
  );
});

test("agent starts and updates serialize so admission either follows the update or makes it busy", async () => {
  const updateInput = {
    description: "updated",
    expectedVersion: 4,
    id: agent().id,
    instructions: "updated instructions",
    model: "updated-model",
    name: "updated",
    runtime: "copilot" as const,
    workspace: null,
  };
  const startInput = {
    agentId: agent().id,
    authVersion: 1,
    id: run().id,
    operationId: run().operationId,
    requestHash: run().requestHash,
    task: run().task,
  };

  const updateFirst = serializedAgentStore();
  const [updated, admittedAfterUpdate] = await Promise.all([
    updateFirst.store.updateAgent(principal, updateInput),
    updateFirst.store.startRun(principal, startInput),
  ]);
  assert.equal(updated.kind, "updated");
  assert.equal(admittedAfterUpdate.kind, "created");
  assert.equal(updateFirst.agent().name, "updated");
  assert.equal(updateFirst.runs().length, 1);

  const startFirst = serializedAgentStore();
  const [admittedBeforeUpdate, blocked] = await Promise.all([
    startFirst.store.startRun(principal, startInput),
    startFirst.store.updateAgent(principal, updateInput),
  ]);
  assert.equal(admittedBeforeUpdate.kind, "created");
  assert.deepEqual(blocked, { kind: "busy" });
  assert.equal(startFirst.agent().name, "test");
  assert.equal(startFirst.agent().version, 4);
  assert.equal(startFirst.runs().length, 1);
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
    String((statements[3] as RunnerStoreStatement).args.event)
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
  const start = scripted(
    [agent({ id: current.agentId, sandboxLifecycle: "ready" })],
    [],
    [],
    [current]
  );

  assert.deepEqual(
    await deletion.store.deleteAgent(principal, current.agentId),
    { kind: "deleted" }
  );
  await start.store.startRun(principal, {
    agentId: current.agentId,
    authVersion: 1,
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
    start.statements.slice(0, 3).map((statement) => statement.name),
    [
      "lock-agent-for-run-start",
      "get-operation-run-before-admission",
      "insert-run",
    ]
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
    provisioningStaleBefore: new Date("2026-01-01T00:00:00.000Z"),
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

test("stale sandbox cleanup claims resetting before provider deletion and finishes the exact new generation", async () => {
  const current = agent({
    sandboxGeneration: 4,
    sandboxLifecycle: "provisioning_ambiguous",
    version: 8,
  });
  const resetting = agent({
    ...current,
    sandboxGeneration: 5,
    sandboxLifecycle: "resetting",
    version: 9,
  });
  const cleared = agent({
    ...resetting,
    sandboxLifecycle: "unprovisioned",
    version: 10,
  });
  const begin = scripted([resetting]);
  const finish = scripted([cleared]);

  assert.equal(
    (
      await begin.store.beginDaytonaSandboxReset(principal, {
        agentId: current.id,
        expectedGeneration: current.sandboxGeneration,
        expectedVersion: current.version,
      })
    ).kind,
    "updated"
  );
  assert.equal(
    (
      await finish.store.finishDaytonaSandboxReset(principal, {
        agentId: resetting.id,
        expectedGeneration: resetting.sandboxGeneration,
        expectedVersion: resetting.version,
      })
    ).kind,
    "updated"
  );
  const beginQuery = queryText(begin.statements[0] as RunnerStoreStatement);
  assert.match(beginQuery, /"sandboxGeneration" = "sandboxGeneration" \+ 1/u);
  assert.match(beginQuery, /"sandboxLifecycle" = 'resetting'/u);
  assert.match(beginQuery, /'provisioning_ambiguous'/u);
  assert.match(beginQuery, /"tenant" = \$/u);
  const finishQuery = queryText(finish.statements[0] as RunnerStoreStatement);
  assert.match(finishQuery, /"sandboxLifecycle" = 'unprovisioned'/u);
  assert.match(finishQuery, /"sandboxLifecycle" = 'resetting'/u);
  assert.match(finishQuery, /"sandboxGeneration" = \$/u);

  const recovery = scripted([resetting]);
  assert.equal(
    (
      await recovery.store.beginDaytonaSandboxResetForRecovery(operator, {
        agentId: current.id,
        expectedGeneration: current.sandboxGeneration,
        expectedVersion: current.version,
      })
    ).kind,
    "updated"
  );
  assert.match(
    queryText(recovery.statements[0] as RunnerStoreStatement),
    /"sandboxLifecycle" = 'resetting'/u
  );
});

test("warm and decommission transitions retain generation and version fences", async () => {
  const current = agent({
    daytonaSandboxId: "sandbox",
    sandboxGeneration: 2,
    sandboxLifecycle: "ready",
    version: 3,
  });
  const warming = agent({
    ...current,
    version: 4,
    warmAttemptVersion: current.warmAttemptVersion + 1,
    warmStatus: "provisioning",
  });
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
    (
      await store.beginDaytonaSandboxDecommission(principal, {
        agentId: current.id,
        provisioningStaleBefore: new Date("2026-01-01T00:00:00.000Z"),
      })
    ).kind,
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
  assert.match(warmQuery, /"warmAttemptVersion" = "warmAttemptVersion" \+ 1/u);
  assert.match(warmQuery, /"sandboxGeneration" = \$/u);
  assert.match(
    warmQuery,
    /NOT EXISTS \(\s*SELECT 1\s*FROM "RunnerRun" AS "activeRun"[\s\S]*"activeRun"\."dispatchState" IN \('dispatching', 'running'\)/u
  );
  assert.match(decommissionQuery, /"sandboxLifecycle" = 'decommissioning'/u);
  assert.match(deleteQuery, /"sandboxLifecycle" = 'decommissioning'/u);
  assert.match(deleteQuery, /"version" = \$/u);
});

test("resource resize acquires and releases an exact idle per-agent fence", async () => {
  const current = agent({
    daytonaSandboxId: "sandbox-resize",
    sandboxGeneration: 3,
    sandboxLifecycle: "ready",
    version: 7,
    warmStatus: "ready",
  });
  const resizing = agent({
    ...current,
    sandboxLifecycle: "resizing",
    version: 8,
  });
  const deferred = agent({
    ...resizing,
    version: 9,
  });
  const ready = agent({
    ...deferred,
    sandboxLifecycle: "ready",
    version: 10,
  });
  const { statements, store } = scripted(
    [current],
    [resizing],
    [deferred],
    [ready]
  );

  assert.deepEqual(
    await store.beginDaytonaSandboxResize(operator, {
      agentId: current.id,
      expectedGeneration: current.sandboxGeneration,
      expectedVersion: current.version,
      sandboxId: current.daytonaSandboxId as string,
      tenant: current.tenant,
    }),
    { kind: "resizing", value: resizing }
  );
  assert.deepEqual(
    await store.deferDaytonaSandboxResize(operator, {
      agentId: resizing.id,
      expectedGeneration: resizing.sandboxGeneration,
      expectedVersion: resizing.version,
      sandboxId: resizing.daytonaSandboxId as string,
      tenant: resizing.tenant,
    }),
    { kind: "updated", value: deferred }
  );
  assert.deepEqual(
    await store.finishDaytonaSandboxResize(operator, {
      agentId: deferred.id,
      expectedGeneration: deferred.sandboxGeneration,
      expectedVersion: deferred.version,
      sandboxId: deferred.daytonaSandboxId as string,
      tenant: deferred.tenant,
    }),
    { kind: "updated", value: ready }
  );

  const beginQuery = queryText(statements[1] as RunnerStoreStatement);
  const deferQuery = queryText(statements[2] as RunnerStoreStatement);
  const finishQuery = queryText(statements[3] as RunnerStoreStatement);
  assert.match(beginQuery, /"sandboxLifecycle" = 'resizing'/u);
  assert.match(beginQuery, /"daytonaSandboxId" = \$/u);
  assert.match(beginQuery, /"status" = 'idle'/u);
  assert.match(beginQuery, /"warmStatus" <> 'provisioning'/u);
  assert.match(
    beginQuery,
    /NOT EXISTS \([\s\S]*"liveRun"\."status" IN \('queued', 'running'\)/u
  );
  assert.match(deferQuery, /"sandboxUpdatedAt" = clock_timestamp\(\)/u);
  assert.match(deferQuery, /"sandboxLifecycle" = 'resizing'/u);
  assert.match(finishQuery, /"sandboxLifecycle" = 'ready'/u);
  assert.match(finishQuery, /"sandboxLifecycle" = 'resizing'/u);
  assert.match(finishQuery, /"version" = \$/u);
});

test("durable decommissioning resumes with its current generation and provider ID", async () => {
  const decommissioning = agent({
    daytonaSandboxId: "sandbox-after-crash",
    sandboxGeneration: 8,
    sandboxLifecycle: "decommissioning",
    version: 13,
  });
  const { statements, store } = scripted([decommissioning]);

  const result = await store.beginDaytonaSandboxDecommission(principal, {
    agentId: decommissioning.id,
    provisioningStaleBefore: new Date("2026-01-01T00:00:00.000Z"),
  });

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

test("stale provisioning reservations are taken over while live leases remain in progress", async () => {
  const cutoff = new Date("2026-01-01T00:00:00.000Z");
  const live = agent({
    sandboxGeneration: 2,
    sandboxLifecycle: "provisioning",
    sandboxUpdatedAt: new Date("2026-01-01T00:00:01.000Z"),
    version: 4,
  });
  const stale = agent({
    sandboxGeneration: 2,
    sandboxLifecycle: "provisioning",
    sandboxUpdatedAt: new Date("2025-12-31T23:59:59.000Z"),
    version: 4,
  });
  const taken = agent({
    ...stale,
    sandboxGeneration: 3,
    sandboxUpdatedAt: cutoff,
    version: 5,
  });
  const liveStore = scripted([live]);
  const staleStore = scripted([stale], [taken]);

  assert.deepEqual(
    await liveStore.store.reserveDaytonaSandbox(principal, {
      agentId: live.id,
      expectedGeneration: 0,
      expectedSandboxId: null,
      expectedVersion: 0,
      provisioningStaleBefore: cutoff,
    }),
    { kind: "in_progress", value: live }
  );
  assert.deepEqual(
    await staleStore.store.reserveDaytonaSandbox(principal, {
      agentId: stale.id,
      expectedGeneration: 0,
      expectedSandboxId: null,
      expectedVersion: 0,
      provisioningStaleBefore: cutoff,
    }),
    { kind: "reserved", value: taken }
  );
  const query = queryText(staleStore.statements[1] as RunnerStoreStatement);
  assert.match(query, /"sandboxUpdatedAt" <= \$/u);
  assert.match(query, /"sandboxGeneration" = "sandboxGeneration" \+ 1/u);
});

test("subscriber warming never reclaims a provisioning warm before cron cleanup", async () => {
  const live = agent({
    daytonaSandboxId: "sandbox",
    sandboxGeneration: 2,
    sandboxLifecycle: "ready",
    version: 4,
    warmStatus: "provisioning",
    warmUpdatedAt: new Date("2026-01-01T00:00:01.000Z"),
  });
  const stale = agent({
    ...live,
    warmUpdatedAt: new Date("2025-12-31T23:59:59.000Z"),
  });
  const liveStore = scripted([live]);
  const staleStore = scripted([stale]);
  const staleProbeSessionId = daytonaProbeSessionName(
    stale.id,
    stale.sandboxGeneration,
    stale.warmAttemptVersion,
    stale.warmUpdatedAt
  );

  assert.equal(
    (
      await liveStore.store.beginDaytonaSandboxWarm(principal, {
        agentId: live.id,
        expectedGeneration: live.sandboxGeneration,
        expectedVersion: 0,
      })
    ).kind,
    "in_progress"
  );
  const staleResult = await staleStore.store.beginDaytonaSandboxWarm(
    principal,
    {
      agentId: stale.id,
      expectedGeneration: stale.sandboxGeneration,
      expectedVersion: stale.version,
    }
  );
  assert.deepEqual(staleResult, { kind: "in_progress", value: stale });
  assert.equal(staleStore.statements.length, 1);
  assert.equal(stale.version, live.version);
  assert.equal(stale.warmUpdatedAt.toISOString(), "2025-12-31T23:59:59.000Z");
  assert.equal(
    staleResult.kind === "in_progress"
      ? daytonaProbeSessionName(
          staleResult.value.id,
          staleResult.value.sandboxGeneration,
          staleResult.value.warmAttemptVersion,
          staleResult.value.warmUpdatedAt
        )
      : undefined,
    staleProbeSessionId
  );

  const failed = agent({
    ...stale,
    version: stale.version + 1,
    warmStatus: "failed",
  });
  const restarted = agent({
    ...failed,
    version: failed.version + 1,
    warmAttemptVersion: failed.warmAttemptVersion + 1,
    warmStatus: "provisioning",
  });
  const restartedStore = scripted([failed], [restarted]);
  assert.deepEqual(
    await restartedStore.store.beginDaytonaSandboxWarm(principal, {
      agentId: failed.id,
      expectedGeneration: failed.sandboxGeneration,
      expectedVersion: failed.version,
    }),
    { kind: "started", value: restarted }
  );
  assert.notEqual(
    daytonaProbeSessionName(
      stale.id,
      stale.sandboxGeneration,
      stale.warmAttemptVersion,
      stale.warmUpdatedAt
    ),
    daytonaProbeSessionName(
      restarted.id,
      restarted.sandboxGeneration,
      restarted.warmAttemptVersion,
      restarted.warmUpdatedAt
    )
  );
});

test("decommission rejects live provisioning and fences a stale provisioning takeover", async () => {
  const cutoff = new Date("2026-01-01T00:00:00.000Z");
  const live = agent({
    sandboxGeneration: 2,
    sandboxLifecycle: "provisioning",
    sandboxUpdatedAt: new Date("2026-01-01T00:00:01.000Z"),
    version: 4,
  });
  const stale = agent({
    ...live,
    sandboxUpdatedAt: new Date("2025-12-31T23:59:59.000Z"),
  });
  const decommissioning = agent({
    ...stale,
    sandboxGeneration: 3,
    sandboxLifecycle: "decommissioning",
    version: 5,
  });
  const liveStore = scripted([live], []);
  const staleStore = scripted([stale], [], [decommissioning]);

  assert.deepEqual(
    await liveStore.store.beginDaytonaSandboxDecommission(principal, {
      agentId: live.id,
      provisioningStaleBefore: cutoff,
    }),
    { kind: "busy" }
  );
  assert.deepEqual(
    await staleStore.store.beginDaytonaSandboxDecommission(principal, {
      agentId: stale.id,
      provisioningStaleBefore: cutoff,
    }),
    { kind: "decommissioning", value: decommissioning }
  );
  const query = queryText(staleStore.statements[2] as RunnerStoreStatement);
  assert.match(query, /"sandboxUpdatedAt" <= \$/u);
  assert.match(query, /WHEN "sandboxLifecycle" = 'provisioning'/u);
});

test("a new operation is rejected only after lifecycle idempotency lookup", async () => {
  await Promise.all(
    (
      [
        "resizing",
        "resetting",
        "decommissioning",
        "decommission_failed",
      ] as const
    ).map(async (lifecycle) => {
      const current = agent({ sandboxLifecycle: lifecycle });
      const { statements, store } = scripted(
        [{ id: current.id, sandboxLifecycle: lifecycle }],
        []
      );
      const result = await store.startRun(principal, {
        agentId: current.id,
        authVersion: 1,
        id: "00000000-0000-4000-8000-000000000099",
        operationId: "00000000-0000-4000-8000-000000000098",
        requestHash: "a".repeat(64),
        task: "test",
      });
      assert.deepEqual(result, { kind: "sandbox_unavailable", lifecycle });
      assert.deepEqual(
        statements.map((statement) => statement.name),
        ["lock-agent-for-run-start", "get-operation-run-before-admission"]
      );
    })
  );
});

test("normal, unprovisioned, and provisioning agents remain eligible for run admission", async () => {
  await Promise.all(
    (["unprovisioned", "provisioning", "ready"] as const).map(
      async (sandboxLifecycle) => {
        const current = run();
        const { statements, store } = scripted(
          [agent({ id: current.agentId, sandboxLifecycle })],
          [],
          [current],
          [{}],
          [current]
        );
        const result = await store.startRun(principal, {
          agentId: current.agentId,
          authVersion: 1,
          id: current.id,
          operationId: current.operationId,
          requestHash: current.requestHash,
          task: current.task,
        });
        assert.equal(result.kind, "created");
        assert.deepEqual(
          statements.map((statement) => statement.name),
          [
            "lock-agent-for-run-start",
            "get-operation-run-before-admission",
            "insert-run",
            "insert-accepted-event",
            "advance-run-after-acceptance",
          ]
        );
      }
    )
  );
});

test("admission-aware starts serialize tenant depth and preserve queue refusal", async () => {
  const current = run();
  const { statements, store } = scripted(
    [agent({ id: current.agentId, sandboxLifecycle: "ready" })],
    [],
    [
      {
        consecutiveDispatchCount: 0,
        lastDispatchedTenantHash: null,
        singleton: true,
      },
    ],
    [{ activeCount: 0 }],
    [{ queuedCount: 10 }]
  );

  const result = await store.startRun(principal, {
    admission: {
      consecutiveDispatches: 2,
      deploymentActiveRuns: 25,
      tenantActiveRuns: 2,
      tenantQueuedRuns: 10,
    },
    agentId: current.agentId,
    authVersion: 1,
    id: current.id,
    operationId: current.operationId,
    requestHash: current.requestHash,
    task: current.task,
  });

  assert.deepEqual(result, { kind: "refused", reason: "tenant_queue_full" });
  assert.deepEqual(
    statements.map((entry) => entry.name),
    [
      "lock-agent-for-run-start",
      "get-operation-run-before-admission",
      "lock-runner-scheduler",
      "count-active-runs-for-admission",
      "count-queued-runs-for-tenant-admission",
    ]
  );
  assert.match(
    queryText(statements[2] as RunnerStoreStatement),
    /ON CONFLICT .* DO UPDATE/u
  );
  assert.match(queryText(statements[1] as RunnerStoreStatement), /FOR UPDATE/u);
  const queuedCapacity = queryText(statements[4] as RunnerStoreStatement);
  assert.match(queuedCapacity, /"dispatchState" = 'queued'/u);
  assert.match(
    queuedCapacity,
    /"dispatchState" = 'dispatching'[\s\S]*"authorityRevalidation" = true/u
  );
});

test("zero queue capacity atomically claims an immediately eligible run", async () => {
  const current = run({
    dispatchLeaseExpiresAt: null,
    dispatchLeaseToken: null,
    dispatchState: "queued",
    version: 0,
  });
  const accepted = run({
    ...current,
    logCursor: 1,
    version: 1,
  });
  const claimed = run({
    ...accepted,
    dispatchLeaseExpiresAt: new Date("2026-01-01T00:01:00.000Z"),
    dispatchLeaseToken: "lease-a",
    dispatchState: "dispatching",
    version: 2,
  });
  const { statements, store } = scripted(
    [agent({ id: current.agentId, sandboxLifecycle: "ready" })],
    [],
    [
      {
        consecutiveDispatchCount: 0,
        lastDispatchedTenantHash: null,
      },
    ],
    [{ activeCount: 0 }],
    [current],
    [{}],
    [accepted],
    [accepted],
    [claimed],
    []
  );

  const result = await store.startRun(principal, {
    admission: {
      consecutiveDispatches: 2,
      deploymentActiveRuns: 25,
      tenantActiveRuns: 2,
      tenantQueuedRuns: 0,
    },
    agentId: current.agentId,
    authVersion: 1,
    id: current.id,
    initialDispatch: {
      leaseExpiresAt: claimed.dispatchLeaseExpiresAt as Date,
      leaseToken: claimed.dispatchLeaseToken as string,
    },
    operationId: current.operationId,
    requestHash: current.requestHash,
    task: current.task,
  });

  assert.equal(result.kind, "claimed");
  assert.equal(
    result.kind === "claimed" && result.claimed.authority.runId,
    current.id
  );
  assert.deepEqual(
    statements.map((entry) => entry.name),
    [
      "lock-agent-for-run-start",
      "get-operation-run-before-admission",
      "lock-runner-scheduler",
      "count-active-runs-for-admission",
      "insert-run",
      "insert-accepted-event",
      "advance-run-after-acceptance",
      "lock-next-eligible-dispatch",
      "claim-next-dispatch",
      "advance-runner-scheduler",
    ]
  );
});

test("zero queue rejection restores sandbox trust when its run is discarded", async () => {
  const current = run({
    dispatchLeaseExpiresAt: null,
    dispatchLeaseToken: null,
    dispatchState: "queued",
    executionPermission: "unrestricted",
    version: 0,
  });
  const accepted = run({ ...current, logCursor: 1, version: 1 });
  const other = run({
    ...accepted,
    id: "00000000-0000-4000-8000-000000000099",
  });
  const { statements, store } = scripted(
    [
      agent({
        id: current.agentId,
        sandboxLifecycle: "ready",
        sandboxTrust: "restricted",
      }),
    ],
    [],
    [
      {
        consecutiveDispatchCount: 0,
        lastDispatchedTenantHash: null,
      },
    ],
    [{ activeCount: 0 }],
    [current],
    [{}],
    [accepted],
    [other],
    [],
    [{}]
  );

  const result = await store.startRun(principal, {
    admission: {
      consecutiveDispatches: 2,
      deploymentActiveRuns: 25,
      tenantActiveRuns: 2,
      tenantQueuedRuns: 0,
    },
    agentId: current.agentId,
    authVersion: 1,
    id: current.id,
    initialDispatch: {
      leaseExpiresAt: new Date("2026-01-01T00:01:00.000Z"),
      leaseToken: "lease-a",
    },
    operationId: current.operationId,
    requestHash: current.requestHash,
    task: current.task,
  });

  assert.deepEqual(result, { kind: "refused", reason: "tenant_queue_full" });
  assert.deepEqual(
    statements.slice(-2).map((statement) => statement.name),
    ["discard-zero-capacity-run", "restore-discarded-run-sandbox-trust"]
  );
  const restored = statements.at(-1) as RunnerStoreStatement;
  assert.equal(restored.args.sandboxTrust, "restricted");
  assert.match(queryText(restored), /"sandboxTrust" = \$/u);
});

test("the production statement shape remains Drizzle-safe", () => {
  const statement: RunnerStoreStatement = {
    args: {},
    name: "shape",
    query: sql`SELECT 1`,
  };
  assert.equal(queryText(statement), "SELECT 1");
});
