import "server-only";

import type {
  CommandEvidence,
  FileEvidence,
  RunEvent,
  RunSnapshot,
} from "@opencoven/agent-contracts";
import { AGENT_RUNNER_API_VERSION } from "@opencoven/agent-contracts";
import { type SQL, sql } from "drizzle-orm";
import type { databaseFor } from "@/lib/db/access";
import { MAX_EVENTS_PER_RUN } from "./evidence";
import type {
  AppendRunnerEventInput,
  AttachDaytonaIdentifiersInput,
  CreateRunnerAgentInput,
  DispatchClaimInput,
  DispatchFence,
  ExpiredDispatchLeaseAdoptionInput,
  ExpiredDispatchRecoveryOutcome,
  ExpiredDispatchRequeueInput,
  FinalizeRunnerRunInput,
  RunnerAgentRecord,
  RunnerMutationOutcome,
  RunnerOperator,
  RunnerPrincipal,
  RunnerRunEventRecord,
  RunnerRunRecord,
  StartRunnerRunInput,
  UpdateRunnerAgentInput,
} from "./types";

export type RunnerStoreStatement = {
  args: Readonly<Record<string, unknown>>;
  name: string;
  query: SQL;
};

export type RunnerStoreTransaction = {
  execute: <Row extends Record<string, unknown>>(
    statement: RunnerStoreStatement
  ) => Promise<Row[]>;
};

export type RunnerStoreDatabase = {
  transaction: <T>(
    callback: (transaction: RunnerStoreTransaction) => Promise<T>
  ) => Promise<T>;
};

type ProductionDatabase = ReturnType<typeof databaseFor>;

/**
 * Adapts the application's existing Drizzle handle. Tests inject
 * RunnerStoreDatabase directly, keeping this store free of a test database.
 */
export function drizzleRunnerStoreDatabase(
  database: ProductionDatabase
): RunnerStoreDatabase {
  return {
    transaction: (callback) =>
      database.transaction((transaction) =>
        callback({
          execute: async <Row extends Record<string, unknown>>(
            queryStatement: RunnerStoreStatement
          ) =>
            (await transaction.execute(
              queryStatement.query
            )) as unknown as Row[],
        })
      ),
  };
}

function statement(
  name: string,
  args: Readonly<Record<string, unknown>>,
  query: SQL
): RunnerStoreStatement {
  return { args, name, query };
}

function column<T>(row: Record<string, unknown>, name: string): T {
  const value = row[name];
  if (value === undefined) {
    throw new Error(`Runner query did not return "${name}".`);
  }
  return value as T;
}

function asAgent(row: Record<string, unknown>): RunnerAgentRecord {
  return {
    createdAt: column(row, "createdAt"),
    daytonaSandboxId: column(row, "daytonaSandboxId"),
    description: column(row, "description"),
    id: column(row, "id"),
    instructions: column(row, "instructions"),
    lastRunAt: column(row, "lastRunAt"),
    model: column(row, "model"),
    name: column(row, "name"),
    runtime: column(row, "runtime"),
    sandboxGeneration: column(row, "sandboxGeneration"),
    status: column(row, "status"),
    tenant: column(row, "tenant"),
    updatedAt: column(row, "updatedAt"),
    version: column(row, "version"),
    warmStatus: column(row, "warmStatus"),
    warmUpdatedAt: column(row, "warmUpdatedAt"),
    workspace: column(row, "workspace"),
  };
}

function asRun(row: Record<string, unknown>): RunnerRunRecord {
  return {
    agentId: column(row, "agentId"),
    commandEvidence: column(row, "commandEvidence"),
    completedAt: column(row, "completedAt"),
    createdAt: column(row, "createdAt"),
    daytonaCommandId: column(row, "daytonaCommandId"),
    daytonaSessionId: column(row, "daytonaSessionId"),
    dispatchLeaseExpiresAt: column(row, "dispatchLeaseExpiresAt"),
    dispatchLeaseToken: column(row, "dispatchLeaseToken"),
    dispatchState: column(row, "dispatchState"),
    error: column(row, "error"),
    fileEvidence: column(row, "fileEvidence"),
    id: column(row, "id"),
    logCursor: column(row, "logCursor"),
    operationId: column(row, "operationId"),
    output: column(row, "output"),
    queueSequence: column(row, "queueSequence"),
    requestHash: column(row, "requestHash"),
    startedAt: column(row, "startedAt"),
    status: column(row, "status"),
    task: column(row, "task"),
    tenant: column(row, "tenant"),
    version: column(row, "version"),
  };
}

function asEvent(row: Record<string, unknown>): RunnerRunEventRecord {
  return {
    createdAt: column(row, "createdAt"),
    event: column(row, "event"),
    eventId: column(row, "eventId"),
    runId: column(row, "runId"),
  };
}

function eventJson(event: RunEvent): string {
  return JSON.stringify(event);
}

function evidenceJson(
  evidence: CommandEvidence[] | FileEvidence[] | undefined
): string | null {
  return evidence === undefined ? null : JSON.stringify(evidence);
}

function runSnapshot(run: RunnerRunRecord): RunSnapshot {
  return {
    agentId: run.agentId,
    apiVersion: AGENT_RUNNER_API_VERSION,
    commandEvidence: run.commandEvidence,
    completedAt: run.completedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    error: run.error,
    fileEvidence: run.fileEvidence,
    id: run.id,
    operationId: run.operationId,
    output: run.output,
    startedAt: run.startedAt?.toISOString() ?? null,
    status: run.status,
    task: run.task,
  };
}

async function lockedPrincipalRun(
  transaction: RunnerStoreTransaction,
  principal: RunnerPrincipal,
  runId: string
): Promise<RunnerRunRecord | null> {
  const [run] = await transaction.execute(
    statement(
      "lock-principal-run",
      { runId, tenant: principal.tenant },
      sql`SELECT * FROM "RunnerRun" WHERE "id" = ${runId} AND "tenant" = ${principal.tenant} FOR UPDATE`
    )
  );
  return run ? asRun(run) : null;
}

async function lockedOperatorRun(
  transaction: RunnerStoreTransaction,
  _operator: RunnerOperator,
  runId: string
): Promise<RunnerRunRecord | null> {
  const [run] = await transaction.execute(
    statement(
      "lock-operator-run",
      { runId },
      sql`SELECT * FROM "RunnerRun" WHERE "id" = ${runId} FOR UPDATE`
    )
  );
  return run ? asRun(run) : null;
}

function fenceOutcome(
  run: RunnerRunRecord,
  input: DispatchFence
): { kind: "stale_version" } | { kind: "lease_lost" } | null {
  if (run.version !== input.expectedVersion) {
    return { kind: "stale_version" };
  }
  if (run.dispatchLeaseToken !== input.leaseToken) {
    return { kind: "lease_lost" };
  }
  return null;
}

function dispatchingFenceOutcome(
  run: RunnerRunRecord,
  input: DispatchFence
):
  | { kind: "stale_version" }
  | { kind: "lease_lost" }
  | { kind: "not_live" }
  | null {
  const rejected = fenceOutcome(run, input);
  if (rejected) {
    return rejected;
  }
  return run.dispatchState === "dispatching" && run.status === "queued"
    ? null
    : { kind: "not_live" };
}

function runningFenceOutcome(
  run: RunnerRunRecord,
  input: DispatchFence
):
  | { kind: "stale_version" }
  | { kind: "lease_lost" }
  | { kind: "not_live" }
  | null {
  const rejected = fenceOutcome(run, input);
  if (rejected) {
    return rejected;
  }
  return run.dispatchState === "running" && run.status === "running"
    ? null
    : { kind: "not_live" };
}

function isExpectedLiveDispatch(
  run: RunnerRunRecord,
  expectedDispatchState: "dispatching" | "running"
): boolean {
  return (
    run.dispatchState === expectedDispatchState &&
    ((expectedDispatchState === "dispatching" && run.status === "queued") ||
      (expectedDispatchState === "running" && run.status === "running"))
  );
}

async function pruneTerminalRunsInTransaction(
  transaction: RunnerStoreTransaction,
  tenant: string,
  agentId: string
): Promise<string[]> {
  const rows = await transaction.execute(
    statement(
      "prune-terminal-runs",
      { agentId, tenant },
      sql`WITH prunable AS (
        SELECT "id"
        FROM "RunnerRun"
        WHERE "agentId" = ${agentId}
          AND "tenant" = ${tenant}
          AND "status" IN ('completed', 'failed', 'cancelled')
        ORDER BY "completedAt" DESC NULLS LAST, "id" DESC
        OFFSET 20
      )
      DELETE FROM "RunnerRun"
      WHERE "id" IN (SELECT "id" FROM prunable)
      RETURNING "id"`
    )
  );
  return rows.map((row) => String(row.id));
}

export type RunnerStore = ReturnType<typeof createRunnerStore>;

/**
 * Server-side persistence boundary for Agent Runner. It deliberately stores
 * only normalized snapshots/events; provider logs, credentials, cookies, and
 * bearer tokens have no fields or inputs in this API.
 */
export function createRunnerStore(database: RunnerStoreDatabase) {
  return {
    adoptExpiredDispatchLease: (
      operator: RunnerOperator,
      input: ExpiredDispatchLeaseAdoptionInput
    ): Promise<ExpiredDispatchRecoveryOutcome> =>
      database.transaction(async (transaction) => {
        const run = await lockedOperatorRun(transaction, operator, input.runId);
        if (!run) {
          return { kind: "not_found" };
        }
        if (run.dispatchLeaseToken !== input.oldLeaseToken) {
          return { kind: "lease_lost" };
        }
        if (!isExpectedLiveDispatch(run, input.expectedDispatchState)) {
          return { kind: "not_live" };
        }
        const [updated] = await transaction.execute(
          statement(
            "adopt-expired-dispatch-lease",
            input,
            sql`UPDATE "RunnerRun"
              SET "dispatchLeaseToken" = ${input.newLeaseToken},
                  "dispatchLeaseExpiresAt" = ${input.leaseExpiresAt},
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${input.runId}
                AND "dispatchLeaseToken" = ${input.oldLeaseToken}
                AND "dispatchLeaseExpiresAt" <= clock_timestamp()
                AND "dispatchState" = ${input.expectedDispatchState}
              RETURNING *`
          )
        );
        return updated
          ? { kind: "adopted", value: asRun(updated) }
          : { kind: "not_expired" };
      }),
    appendEvent: (
      principal: RunnerPrincipal,
      input: AppendRunnerEventInput
    ): Promise<
      | { kind: "appended"; event: RunnerRunEventRecord; run: RunSnapshot }
      | { kind: "not_found" }
      | { kind: "stale_version" }
      | { kind: "lease_lost" }
      | { kind: "not_live" }
    > =>
      database.transaction(async (transaction) => {
        const run = await lockedPrincipalRun(
          transaction,
          principal,
          input.runId
        );
        if (!run) {
          return { kind: "not_found" };
        }
        const rejected = runningFenceOutcome(run, input);
        if (rejected) {
          return rejected;
        }
        const eventId = run.logCursor + 1;
        const event = { ...input.event, id: eventId } as RunEvent;
        const [updated] = await transaction.execute(
          statement(
            "update-run-after-event",
            {
              commandEvidence: evidenceJson(input.snapshot?.commandEvidence),
              eventId,
              expectedVersion: input.expectedVersion,
              fileEvidence: evidenceJson(input.snapshot?.fileEvidence),
              leaseToken: input.leaseToken,
              output: input.snapshot?.output ?? null,
              runId: input.runId,
              tenant: principal.tenant,
            },
            sql`UPDATE "RunnerRun"
              SET "logCursor" = ${eventId},
                  "output" = COALESCE(${input.snapshot?.output ?? null}, "output"),
                  "commandEvidence" = COALESCE(CAST(${evidenceJson(input.snapshot?.commandEvidence)} AS jsonb), "commandEvidence"),
                  "fileEvidence" = COALESCE(CAST(${evidenceJson(input.snapshot?.fileEvidence)} AS jsonb), "fileEvidence"),
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${input.runId}
                AND "tenant" = ${principal.tenant}
                AND "version" = ${input.expectedVersion}
                AND "dispatchLeaseToken" = ${input.leaseToken}
                AND "dispatchLeaseExpiresAt" > clock_timestamp()
                AND "dispatchState" = 'running'
                AND "status" = 'running'
              RETURNING *`
          )
        );
        if (!updated) {
          return { kind: "lease_lost" };
        }
        const [inserted] = await transaction.execute(
          statement(
            "insert-run-event",
            {
              event: eventJson(event),
              eventId,
              runId: input.runId,
              tenant: principal.tenant,
            },
            sql`INSERT INTO "RunnerRunEvent" ("runId", "eventId", "event")
              SELECT ${input.runId}, ${eventId}, CAST(${eventJson(event)} AS jsonb)
              FROM "RunnerRun"
              WHERE "id" = ${input.runId} AND "tenant" = ${principal.tenant}
              RETURNING *`
          )
        );
        if (!inserted) {
          throw new Error("Runner event insert returned no row.");
        }
        await transaction.execute(
          statement(
            "prune-run-events-after-append",
            {
              maxEvents: MAX_EVENTS_PER_RUN,
              runId: input.runId,
              tenant: principal.tenant,
            },
            sql`DELETE FROM "RunnerRunEvent"
              WHERE "runId" = ${input.runId}
                AND EXISTS (
                  SELECT 1 FROM "RunnerRun"
                  WHERE "id" = ${input.runId}
                    AND "tenant" = ${principal.tenant}
                )
                AND "eventId" IN (
                  SELECT "eventId"
                  FROM "RunnerRunEvent"
                  WHERE "runId" = ${input.runId}
                  ORDER BY "eventId" DESC
                  OFFSET ${MAX_EVENTS_PER_RUN}
                )`
          )
        );
        return {
          event: asEvent(inserted),
          kind: "appended",
          run: runSnapshot(asRun(updated)),
        };
      }),

    attachDaytonaIdentifiers: (
      operator: RunnerOperator,
      input: AttachDaytonaIdentifiersInput
    ): Promise<RunnerMutationOutcome<RunnerRunRecord>> =>
      database.transaction(async (transaction) => {
        const run = await lockedOperatorRun(transaction, operator, input.runId);
        if (!run) {
          return { kind: "not_found" };
        }
        const rejected = dispatchingFenceOutcome(run, input);
        if (rejected) {
          return rejected;
        }
        if (
          (run.daytonaSessionId !== null &&
            run.daytonaSessionId !== (input.sessionId ?? null)) ||
          (run.daytonaCommandId !== null &&
            run.daytonaCommandId !== (input.commandId ?? null))
        ) {
          return { kind: "stale_version" };
        }
        const [agent] = await transaction.execute(
          statement(
            "lock-agent-for-daytona-attach",
            {
              agentId: run.agentId,
              sandboxGeneration: input.sandboxGeneration,
              tenant: run.tenant,
            },
            sql`SELECT * FROM "RunnerAgent"
              WHERE "id" = ${run.agentId}
                AND "tenant" = ${run.tenant}
              FOR UPDATE`
          )
        );
        if (
          !agent ||
          Number(agent.sandboxGeneration) !== input.sandboxGeneration
        ) {
          return { kind: "generation_mismatch" };
        }
        const [updated] = await transaction.execute(
          statement(
            "attach-daytona-run-identifiers",
            { ...input, tenant: run.tenant },
            sql`UPDATE "RunnerRun"
              SET "daytonaSessionId" = COALESCE(${input.sessionId ?? null}, "daytonaSessionId"),
                  "daytonaCommandId" = COALESCE(${input.commandId ?? null}, "daytonaCommandId"),
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${input.runId}
                AND "tenant" = ${run.tenant}
                AND "version" = ${input.expectedVersion}
                AND "dispatchLeaseToken" = ${input.leaseToken}
                AND "dispatchLeaseExpiresAt" > clock_timestamp()
                AND "dispatchState" = 'dispatching'
                AND "status" = 'queued'
                AND ("daytonaSessionId" IS NULL OR "daytonaSessionId" = ${input.sessionId ?? null})
                AND ("daytonaCommandId" IS NULL OR "daytonaCommandId" = ${input.commandId ?? null})
              RETURNING *`
          )
        );
        if (!updated) {
          return { kind: "lease_lost" };
        }
        if (input.sandboxId !== undefined) {
          const updatedAgent = await transaction.execute(
            statement(
              "attach-daytona-sandbox",
              {
                agentId: run.agentId,
                sandboxGeneration: input.sandboxGeneration,
                sandboxId: input.sandboxId,
                tenant: run.tenant,
              },
              sql`UPDATE "RunnerAgent"
                SET "daytonaSandboxId" = ${input.sandboxId},
                    "updatedAt" = now(),
                    "version" = "version" + 1
                WHERE "id" = ${run.agentId}
                  AND "tenant" = ${run.tenant}
                  AND "sandboxGeneration" = ${input.sandboxGeneration}
                RETURNING "id"`
            )
          );
          if (!updatedAgent[0]) {
            throw new Error("Runner Daytona sandbox generation changed.");
          }
        }
        return { kind: "updated", value: asRun(updated) };
      }),

    claimNextDispatch: (_operator: RunnerOperator, input: DispatchClaimInput) =>
      database.transaction(async (transaction) => {
        const [run] = await transaction.execute(
          statement(
            "claim-next-dispatch",
            input,
            sql`WITH candidate AS (
              SELECT "id"
              FROM "RunnerRun"
              WHERE "dispatchState" = 'queued' AND "status" = 'queued'
              ORDER BY "queueSequence" ASC
              FOR UPDATE SKIP LOCKED
              LIMIT 1
            )
            UPDATE "RunnerRun"
            SET "dispatchState" = 'dispatching',
                "dispatchLeaseToken" = ${input.leaseToken},
                "dispatchLeaseExpiresAt" = ${input.leaseExpiresAt},
                "updatedAt" = now(),
                "version" = "version" + 1
            WHERE "id" IN (SELECT "id" FROM candidate)
            RETURNING *`
          )
        );
        return run ? asRun(run) : null;
      }),

    cleanupTerminalLease: (
      operator: RunnerOperator,
      input: DispatchFence
    ): Promise<RunnerMutationOutcome<RunnerRunRecord>> =>
      database.transaction(async (transaction) => {
        const run = await lockedOperatorRun(transaction, operator, input.runId);
        if (!run) {
          return { kind: "not_found" };
        }
        const rejected = fenceOutcome(run, input);
        if (rejected) {
          return rejected;
        }
        const [updated] = await transaction.execute(
          statement(
            "cleanup-terminal-lease",
            input,
            sql`UPDATE "RunnerRun"
              SET "dispatchLeaseToken" = NULL,
                  "dispatchLeaseExpiresAt" = NULL,
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${input.runId}
                AND "version" = ${input.expectedVersion}
                AND "dispatchLeaseToken" = ${input.leaseToken}
                AND "dispatchState" = 'terminal'
              RETURNING *`
          )
        );
        return updated
          ? { kind: "updated", value: asRun(updated) }
          : { kind: "stale_version" };
      }),

    createAgent: (principal: RunnerPrincipal, input: CreateRunnerAgentInput) =>
      database.transaction(async (transaction) => {
        const [agent] = await transaction.execute(
          statement(
            "create-agent",
            { ...input, tenant: principal.tenant },
            sql`INSERT INTO "RunnerAgent" (
              "id", "tenant", "name", "description", "instructions", "model",
              "runtime", "workspace"
            ) VALUES (
              ${input.id}, ${principal.tenant}, ${input.name}, ${input.description ?? ""},
              ${input.instructions}, ${input.model}, ${input.runtime}, ${input.workspace ?? null}
            ) ON CONFLICT DO NOTHING
              RETURNING *`
          )
        );
        return agent
          ? { agent: asAgent(agent), kind: "created" as const }
          : { kind: "conflict" as const };
      }),

    deleteAgent: (
      principal: RunnerPrincipal,
      agentId: string
    ): Promise<
      { kind: "deleted" } | { kind: "not_found" } | { kind: "busy" }
    > =>
      database.transaction(async (transaction) => {
        const [agent] = await transaction.execute(
          statement(
            "lock-agent-for-delete",
            { agentId, tenant: principal.tenant },
            sql`SELECT "id" FROM "RunnerAgent"
              WHERE "id" = ${agentId}
                AND "tenant" = ${principal.tenant}
              FOR UPDATE`
          )
        );
        if (!agent) {
          return { kind: "not_found" };
        }
        const [liveRun] = await transaction.execute(
          statement(
            "find-live-run-for-agent",
            { agentId, tenant: principal.tenant },
            sql`SELECT "id" FROM "RunnerRun"
              WHERE "agentId" = ${agentId}
                AND "tenant" = ${principal.tenant}
                AND "status" IN ('queued', 'running')
              LIMIT 1`
          )
        );
        if (liveRun) {
          return { kind: "busy" };
        }
        const [deleted] = await transaction.execute(
          statement(
            "delete-idle-agent",
            { agentId, tenant: principal.tenant },
            sql`DELETE FROM "RunnerAgent"
              WHERE "id" = ${agentId}
                AND "tenant" = ${principal.tenant}
              RETURNING "id"`
          )
        );
        if (!deleted) {
          throw new Error("Locked Runner agent disappeared before deletion.");
        }
        return { kind: "deleted" };
      }),

    finalizeRun: (
      operator: RunnerOperator,
      input: FinalizeRunnerRunInput
    ): Promise<
      | { kind: "finalized"; run: RunnerRunRecord; prunedRunIds: string[] }
      | { kind: "not_found" }
      | { kind: "stale_version" }
      | { kind: "lease_lost" }
    > =>
      database.transaction(async (transaction) => {
        const run = await lockedOperatorRun(transaction, operator, input.runId);
        if (!run) {
          return { kind: "not_found" };
        }
        const rejected = fenceOutcome(run, input);
        if (rejected) {
          return rejected;
        }
        const eventId = run.logCursor + 1;
        const [updated] = await transaction.execute(
          statement(
            "finalize-run",
            { ...input, eventId },
            sql`UPDATE "RunnerRun"
              SET "commandEvidence" = CAST(${JSON.stringify(input.commandEvidence)} AS jsonb),
                  "completedAt" = ${input.completedAt},
                  "dispatchState" = 'terminal',
                  "error" = CAST(${input.error ? JSON.stringify(input.error) : null} AS jsonb),
                  "fileEvidence" = CAST(${JSON.stringify(input.fileEvidence)} AS jsonb),
                  "logCursor" = ${eventId},
                  "output" = ${input.output},
                  "status" = ${input.status},
                  "updatedAt" = ${input.completedAt},
                  "version" = "version" + 1
              WHERE "id" = ${input.runId}
                AND "version" = ${input.expectedVersion}
                AND "dispatchLeaseToken" = ${input.leaseToken}
                AND "dispatchLeaseExpiresAt" > clock_timestamp()
                AND "status" IN ('queued', 'running')
              RETURNING *`
          )
        );
        if (!updated) {
          return { kind: "lease_lost" };
        }
        const finalized = asRun(updated);
        const event: RunEvent =
          input.status === "completed"
            ? { id: eventId, run: runSnapshot(finalized), type: "completed" }
            : input.error
              ? { error: input.error, id: eventId, type: "failed" }
              : { id: eventId, status: input.status, type: "status" };
        await transaction.execute(
          statement(
            "insert-terminal-event",
            { event: eventJson(event), eventId, runId: input.runId },
            sql`INSERT INTO "RunnerRunEvent" ("runId", "eventId", "event")
              VALUES (${input.runId}, ${eventId}, CAST(${eventJson(event)} AS jsonb))`
          )
        );
        const prunedRunIds = await pruneTerminalRunsInTransaction(
          transaction,
          finalized.tenant,
          finalized.agentId
        );
        return { kind: "finalized", prunedRunIds, run: finalized };
      }),

    getAgent: (principal: RunnerPrincipal, agentId: string) =>
      database.transaction(async (transaction) => {
        const [agent] = await transaction.execute(
          statement(
            "get-agent",
            { agentId, tenant: principal.tenant },
            sql`SELECT * FROM "RunnerAgent" WHERE "id" = ${agentId} AND "tenant" = ${principal.tenant} LIMIT 1`
          )
        );
        return agent ? asAgent(agent) : null;
      }),

    getRun: (principal: RunnerPrincipal, runId: string) =>
      database.transaction(async (transaction) => {
        const [run] = await transaction.execute(
          statement(
            "get-run",
            { runId, tenant: principal.tenant },
            sql`SELECT * FROM "RunnerRun" WHERE "id" = ${runId} AND "tenant" = ${principal.tenant} LIMIT 1`
          )
        );
        return run ? runSnapshot(asRun(run)) : null;
      }),

    listAgentRuns: (principal: RunnerPrincipal, agentId: string) =>
      database.transaction(async (transaction) => {
        const rows = await transaction.execute(
          statement(
            "list-agent-runs",
            { agentId, tenant: principal.tenant },
            sql`SELECT * FROM "RunnerRun"
              WHERE "agentId" = ${agentId} AND "tenant" = ${principal.tenant}
              ORDER BY "createdAt" DESC, "id" DESC`
          )
        );
        return rows.map((row) => runSnapshot(asRun(row)));
      }),

    listAgents: (principal: RunnerPrincipal) =>
      database.transaction(async (transaction) => {
        const rows = await transaction.execute(
          statement(
            "list-agents",
            { tenant: principal.tenant },
            sql`SELECT * FROM "RunnerAgent" WHERE "tenant" = ${principal.tenant} ORDER BY "updatedAt" DESC, "id" DESC`
          )
        );
        return rows.map(asAgent);
      }),

    markDispatchRunning: (
      operator: RunnerOperator,
      input: DispatchFence
    ): Promise<RunnerMutationOutcome<RunnerRunRecord>> =>
      database.transaction(async (transaction) => {
        const run = await lockedOperatorRun(transaction, operator, input.runId);
        if (!run) {
          return { kind: "not_found" };
        }
        const rejected = fenceOutcome(run, input);
        if (rejected) {
          return rejected;
        }
        const [updated] = await transaction.execute(
          statement(
            "mark-dispatch-running",
            input,
            sql`UPDATE "RunnerRun"
              SET "dispatchState" = 'running',
                  "status" = 'running',
                  "startedAt" = clock_timestamp(),
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "id" = ${input.runId}
                AND "version" = ${input.expectedVersion}
                AND "dispatchLeaseToken" = ${input.leaseToken}
                AND "dispatchLeaseExpiresAt" > clock_timestamp()
                AND "dispatchState" = 'dispatching'
                AND "status" = 'queued'
              RETURNING *`
          )
        );
        return updated
          ? { kind: "updated", value: asRun(updated) }
          : { kind: "lease_lost" };
      }),

    pruneTerminalRuns: (principal: RunnerPrincipal, agentId: string) =>
      database.transaction((transaction) =>
        pruneTerminalRunsInTransaction(transaction, principal.tenant, agentId)
      ),

    readEventsAfter: (
      principal: RunnerPrincipal,
      runId: string,
      afterEventId: number
    ) =>
      database.transaction(async (transaction) => {
        const rows = await transaction.execute(
          statement(
            "read-events-after",
            {
              afterEventId,
              maxEvents: MAX_EVENTS_PER_RUN,
              runId,
              tenant: principal.tenant,
            },
            sql`SELECT "RunnerRunEvent".*
              FROM "RunnerRunEvent"
              INNER JOIN "RunnerRun" ON "RunnerRun"."id" = "RunnerRunEvent"."runId"
              WHERE "RunnerRunEvent"."runId" = ${runId}
                AND "RunnerRun"."tenant" = ${principal.tenant}
                AND "RunnerRunEvent"."eventId" > ${afterEventId}
              ORDER BY "RunnerRunEvent"."eventId" ASC
              LIMIT ${MAX_EVENTS_PER_RUN}`
          )
        );
        return rows.map(asEvent);
      }),

    renewDispatchLease: (
      operator: RunnerOperator,
      input: DispatchFence & { leaseExpiresAt: Date }
    ): Promise<RunnerMutationOutcome<RunnerRunRecord>> =>
      database.transaction(async (transaction) => {
        const run = await lockedOperatorRun(transaction, operator, input.runId);
        if (!run) {
          return { kind: "not_found" };
        }
        const rejected = fenceOutcome(run, input);
        if (rejected) {
          return rejected;
        }
        const [updated] = await transaction.execute(
          statement(
            "renew-dispatch-lease",
            input,
            sql`UPDATE "RunnerRun"
              SET "dispatchLeaseExpiresAt" = ${input.leaseExpiresAt},
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${input.runId}
                AND "version" = ${input.expectedVersion}
                AND "dispatchLeaseToken" = ${input.leaseToken}
                AND "dispatchLeaseExpiresAt" > clock_timestamp()
                AND "dispatchState" IN ('dispatching', 'running')
              RETURNING *`
          )
        );
        return updated
          ? { kind: "updated", value: asRun(updated) }
          : { kind: "lease_lost" };
      }),

    requeueExpiredDispatch: (
      operator: RunnerOperator,
      input: ExpiredDispatchRequeueInput
    ): Promise<ExpiredDispatchRecoveryOutcome> =>
      database.transaction(async (transaction) => {
        const run = await lockedOperatorRun(transaction, operator, input.runId);
        if (!run) {
          return { kind: "not_found" };
        }
        if (run.dispatchLeaseToken !== input.oldLeaseToken) {
          return { kind: "lease_lost" };
        }
        if (!isExpectedLiveDispatch(run, input.expectedDispatchState)) {
          return { kind: "not_live" };
        }
        if (run.daytonaSessionId || run.daytonaCommandId) {
          return { kind: "provider_identifiers_attached" };
        }
        const [updated] = await transaction.execute(
          statement(
            "requeue-expired-dispatch",
            input,
            sql`UPDATE "RunnerRun"
              SET "dispatchLeaseToken" = NULL,
                  "dispatchLeaseExpiresAt" = NULL,
                  "dispatchState" = 'queued',
                  "status" = 'queued',
                  "startedAt" = NULL,
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${input.runId}
                AND "dispatchLeaseToken" = ${input.oldLeaseToken}
                AND "dispatchLeaseExpiresAt" <= clock_timestamp()
                AND "dispatchState" = ${input.expectedDispatchState}
                AND "daytonaSessionId" IS NULL
                AND "daytonaCommandId" IS NULL
              RETURNING *`
          )
        );
        return updated
          ? { kind: "requeued", value: asRun(updated) }
          : { kind: "not_expired" };
      }),

    scanExpiredDispatchLeases: (
      _operator: RunnerOperator,
      before: Date,
      limit: number
    ) =>
      database.transaction(async (transaction) => {
        const rows = await transaction.execute(
          statement(
            "scan-expired-dispatch-leases",
            { before, limit },
            sql`SELECT * FROM "RunnerRun"
              WHERE "dispatchLeaseExpiresAt" <= ${before}
                AND "dispatchLeaseToken" IS NOT NULL
                AND "dispatchState" IN ('dispatching', 'running')
              ORDER BY "dispatchLeaseExpiresAt" ASC
              LIMIT ${limit}`
          )
        );
        return rows.map(asRun);
      }),

    scanLiveRuns: (_operator: RunnerOperator, limit: number) =>
      database.transaction(async (transaction) => {
        const rows = await transaction.execute(
          statement(
            "scan-live-runs",
            { limit },
            sql`SELECT * FROM "RunnerRun"
              WHERE "status" IN ('queued', 'running')
              ORDER BY "queueSequence" ASC
              LIMIT ${limit}`
          )
        );
        return rows.map(asRun);
      }),

    startRun: (
      principal: RunnerPrincipal,
      input: StartRunnerRunInput
    ): Promise<
      | { kind: "created"; run: RunSnapshot }
      | { kind: "duplicate"; run: RunSnapshot }
      | { kind: "conflict"; run: RunSnapshot }
      | { kind: "not_found" }
    > =>
      database.transaction(async (transaction) => {
        const [agent] = await transaction.execute(
          statement(
            "lock-agent-for-run-start",
            { agentId: input.agentId, tenant: principal.tenant },
            sql`SELECT "id" FROM "RunnerAgent" WHERE "id" = ${input.agentId} AND "tenant" = ${principal.tenant} FOR UPDATE`
          )
        );
        if (!agent) {
          return { kind: "not_found" };
        }
        const [inserted] = await transaction.execute(
          statement(
            "insert-run",
            { ...input, tenant: principal.tenant },
            sql`INSERT INTO "RunnerRun" (
              "id", "agentId", "tenant", "operationId", "requestHash", "task"
            ) VALUES (
              ${input.id}, ${input.agentId}, ${principal.tenant}, ${input.operationId},
              ${input.requestHash}, ${input.task}
            ) ON CONFLICT ("agentId", "operationId") DO NOTHING RETURNING *`
          )
        );
        if (inserted) {
          const created = asRun(inserted);
          const acceptedEvent: RunEvent = {
            at: created.createdAt.toISOString(),
            id: 1,
            operationId: created.operationId,
            runId: created.id,
            type: "accepted",
          };
          const [accepted] = await transaction.execute(
            statement(
              "insert-accepted-event",
              {
                event: eventJson(acceptedEvent),
                runId: created.id,
                tenant: principal.tenant,
              },
              sql`INSERT INTO "RunnerRunEvent" ("runId", "eventId", "event")
                SELECT ${created.id}, 1, CAST(${eventJson(acceptedEvent)} AS jsonb)
                FROM "RunnerRun"
                WHERE "id" = ${created.id} AND "tenant" = ${principal.tenant}
                RETURNING *`
            )
          );
          if (!accepted) {
            throw new Error("Runner accepted event insert returned no row.");
          }
          const [run] = await transaction.execute(
            statement(
              "advance-run-after-acceptance",
              { runId: created.id, tenant: principal.tenant },
              sql`UPDATE "RunnerRun"
                SET "logCursor" = 1, "updatedAt" = now(), "version" = "version" + 1
                WHERE "id" = ${created.id} AND "tenant" = ${principal.tenant}
                RETURNING *`
            )
          );
          if (!run) {
            throw new Error(
              "Runner accepted event cursor update returned no row."
            );
          }
          return { kind: "created", run: runSnapshot(asRun(run)) };
        }
        const [existing] = await transaction.execute(
          statement(
            "get-operation-run",
            {
              agentId: input.agentId,
              operationId: input.operationId,
              tenant: principal.tenant,
            },
            sql`SELECT * FROM "RunnerRun"
              WHERE "agentId" = ${input.agentId}
                AND "operationId" = ${input.operationId}
                AND "tenant" = ${principal.tenant}
              FOR UPDATE`
          )
        );
        if (!existing) {
          throw new Error(
            "Runner operation conflict had no matching tenant row."
          );
        }
        const run = asRun(existing);
        return run.requestHash === input.requestHash
          ? { kind: "duplicate", run: runSnapshot(run) }
          : { kind: "conflict", run: runSnapshot(run) };
      }),

    updateAgent: (
      principal: RunnerPrincipal,
      input: UpdateRunnerAgentInput
    ): Promise<
      | { kind: "updated"; value: RunnerAgentRecord }
      | { kind: "not_found" }
      | { kind: "stale_version" }
    > =>
      database.transaction(async (transaction) => {
        const [updated] = await transaction.execute(
          statement(
            "update-agent",
            { ...input, tenant: principal.tenant },
            sql`UPDATE "RunnerAgent"
              SET "name" = ${input.name},
                  "description" = ${input.description},
                  "instructions" = ${input.instructions},
                  "model" = ${input.model},
                  "runtime" = ${input.runtime},
                  "workspace" = ${input.workspace},
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${input.id}
                AND "tenant" = ${principal.tenant}
                AND "version" = ${input.expectedVersion}
              RETURNING *`
          )
        );
        if (updated) {
          return { kind: "updated", value: asAgent(updated) };
        }
        const [current] = await transaction.execute(
          statement(
            "get-agent-after-update",
            { agentId: input.id, tenant: principal.tenant },
            sql`SELECT "id" FROM "RunnerAgent" WHERE "id" = ${input.id} AND "tenant" = ${principal.tenant} LIMIT 1`
          )
        );
        return current ? { kind: "stale_version" } : { kind: "not_found" };
      }),
  };
}
