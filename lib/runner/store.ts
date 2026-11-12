import "server-only";

import { randomUUID } from "node:crypto";
import type {
  CommandEvidence,
  FileEvidence,
  RunEvent,
  RunSnapshot,
} from "@opencoven/agent-contracts";
import { AGENT_RUNNER_API_VERSION } from "@opencoven/agent-contracts";
import { type SQL, sql } from "drizzle-orm";
import { canonicalJsonStringify } from "@/lib/canonical-json";
import type { databaseFor } from "@/lib/db/access";
import { daytonaRunSessionName } from "./daytona/names";
import {
  hashRunRequest,
  MAX_EVENT_PAGE_BYTES,
  MAX_EVENTS_PER_PAGE,
  MAX_EVENTS_PER_RUN,
  MAX_PERSISTED_EVENT_BYTES_PER_RUN,
} from "./evidence";
import { runnerResourceInventoryLimit } from "./resource-lifecycle";
import type {
  AcquireRunnerReconciliationLeaseInput,
  AcquireRunnerReconciliationLeaseResult,
  AdoptExpiredDaytonaProcessInput,
  AppendRunnerEventBatchInput,
  AppendRunnerEventInput,
  AuthorizeDaytonaPreparationInput,
  BeginDaytonaSandboxDecommissionInput,
  BeginDaytonaSandboxResizeInput,
  BeginDaytonaSandboxWarmInput,
  ClaimExpiredDaytonaAttemptCleanupInput,
  ClaimTerminalDaytonaAttemptCleanupInput,
  CreateRunnerAgentInput,
  DaytonaSandboxFence,
  DispatchClaimInput,
  DispatchFence,
  DispatchSandboxFence,
  ExpiredDaytonaAttemptCleanupClaim,
  ExpiredDaytonaProcessAdoption,
  ExpiredDispatchLeaseAdoptionInput,
  ExpiredDispatchRecoveryOutcome,
  ExpiredDispatchRequeueInput,
  FinalizeRunnerRunInput,
  PersistRunnerAttemptRedactionInput,
  ReleaseDaytonaAttemptInput,
  ReleaseExpiredDaytonaAttemptInput,
  ReleaseRunnerReconciliationLeaseResult,
  RequestRunnerCancellationInput,
  ReserveDaytonaSandboxInput,
  RunnerAdmissionLimits,
  RunnerAgentRecord,
  RunnerAttemptRedactionRecord,
  RunnerCancellationRequestOutcome,
  RunnerClaimedDispatch,
  RunnerDaytonaAttemptId,
  RunnerDispatchAuthority,
  RunnerMutationOutcome,
  RunnerOperator,
  RunnerPrincipal,
  RunnerReconciliationLease,
  RunnerRunEventRecord,
  RunnerRunRecord,
  RunnerSandboxBinding,
  StartRunnerRunInput,
  TerminalDaytonaAttemptCleanupClaim,
  UpdateRunnerAgentInput,
} from "./types";
import { DEFAULT_RUNNER_ADMISSION_LIMITS } from "./types";

const CANCELLATION_CLEANUP_DIAGNOSTIC =
  "Cancellation cleanup requires a sandbox reset.";
const TERMINAL_CLEANUP_RESET_DIAGNOSTIC =
  "Terminal cleanup requires a sandbox reset.";
const MAX_RECONCILIATION_LEASE_TTL_SECONDS = 600;
const MAX_RECONCILIATION_LEASE_OWNER_LENGTH = 128;

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

/**
 * A column the caller may legitimately not have selected, or that may not
 * exist yet on the row being read.
 *
 * `column` throws on a missing key so that a query which forgot to select
 * something fails loudly rather than silently reading undefined. That is the
 * right default, but it is wrong for a nullable column added after runs
 * already existed: those rows genuinely have nothing to report, and a run
 * admitted before the column existed must keep dispatching, not throw.
 */
function optionalColumn<T>(
  row: Record<string, unknown>,
  name: string
): T | null {
  const value = row[name];
  return value === undefined || value === null ? null : (value as T);
}

/**
 * Both columns or neither. A half-written binding must not read as unbound,
 * because an unbound run is allowed to create a sandbox.
 */
function sandboxBindingColumns(
  row: Record<string, unknown>
): RunnerSandboxBinding | null {
  const expectedSandboxId = optionalColumn<string>(row, "boundSandboxId");
  const expectedGeneration = optionalColumn<number>(
    row,
    "boundSandboxGeneration"
  );
  if (expectedSandboxId === null && expectedGeneration === null) {
    return null;
  }
  if (
    typeof expectedSandboxId !== "string" ||
    !expectedSandboxId ||
    typeof expectedGeneration !== "number" ||
    !Number.isSafeInteger(expectedGeneration) ||
    expectedGeneration < 0
  ) {
    throw new Error("Run sandbox binding could not be read.");
  }
  return { expectedGeneration, expectedSandboxId };
}

function sandboxBindingField(row: Record<string, unknown>): {
  sandboxBinding?: RunnerSandboxBinding;
} {
  const sandboxBinding = sandboxBindingColumns(row);
  return sandboxBinding ? { sandboxBinding } : {};
}

function sameSandboxBinding(
  left: RunnerSandboxBinding | null,
  right: RunnerSandboxBinding | null
): boolean {
  return left === null || right === null
    ? left === right
    : left.expectedGeneration === right.expectedGeneration &&
        left.expectedSandboxId === right.expectedSandboxId;
}

function asAgent(row: Record<string, unknown>): RunnerAgentRecord {
  return {
    createdAt: timestampColumn(row, "createdAt"),
    daytonaSandboxId: column(row, "daytonaSandboxId"),
    description: column(row, "description"),
    familiarId: column(row, "familiarId"),
    id: column(row, "id"),
    instructions: column(row, "instructions"),
    lastRunAt: nullableTimestampColumn(row, "lastRunAt"),
    model: column(row, "model"),
    name: column(row, "name"),
    runtime: column(row, "runtime"),
    sandboxGeneration: column(row, "sandboxGeneration"),
    sandboxLifecycle: column(row, "sandboxLifecycle"),
    sandboxTrust: column(row, "sandboxTrust"),
    sandboxUpdatedAt: timestampColumn(row, "sandboxUpdatedAt"),
    status: column(row, "status"),
    tenant: column(row, "tenant"),
    updatedAt: timestampColumn(row, "updatedAt"),
    version: column(row, "version"),
    warmAttemptVersion: column(row, "warmAttemptVersion"),
    warmStatus: column(row, "warmStatus"),
    warmUpdatedAt: timestampColumn(row, "warmUpdatedAt"),
    workspace: column(row, "workspace"),
  };
}

function asRun(row: Record<string, unknown>): RunnerRunRecord {
  return {
    agentId: column(row, "agentId"),
    agentInstructions: column(row, "agentInstructions"),
    agentModel: column(row, "agentModel"),
    agentRuntime: column(row, "agentRuntime"),
    agentWorkspace: column(row, "agentWorkspace"),
    authorityRevalidation:
      row.authorityRevalidation === undefined
        ? false
        : column(row, "authorityRevalidation"),
    authVersion: column(row, "authVersion"),
    cancellationRequestedAt: nullableTimestampColumn(
      row,
      "cancellationRequestedAt"
    ),
    commandEvidence: column(row, "commandEvidence"),
    completedAt: nullableTimestampColumn(row, "completedAt"),
    createdAt: timestampColumn(row, "createdAt"),
    daytonaAttemptId: column(row, "daytonaAttemptId"),
    daytonaCommandId: column(row, "daytonaCommandId"),
    daytonaLogCursor: column(row, "daytonaLogCursor"),
    daytonaSessionId: column(row, "daytonaSessionId"),
    dispatchLeaseExpiresAt: nullableTimestampColumn(
      row,
      "dispatchLeaseExpiresAt"
    ),
    dispatchLeaseToken: column(row, "dispatchLeaseToken"),
    dispatchState: column(row, "dispatchState"),
    entitlementMinutes: optionalColumn<number>(row, "entitlementMinutes"),
    error: column(row, "error"),
    executionPermission: column(row, "executionPermission"),
    executionProvenance: column(row, "executionProvenance"),
    fileEvidence: column(row, "fileEvidence"),
    githubBrokerPolicy: column(row, "githubBrokerPolicy"),
    id: column(row, "id"),
    logCursor: column(row, "logCursor"),
    operationId: column(row, "operationId"),
    output: column(row, "output"),
    queueSequence: column(row, "queueSequence"),
    requestHash: column(row, "requestHash"),
    // Absent, not null, on an unbound run: its record is unchanged.
    ...sandboxBindingField(row),
    startedAt: nullableTimestampColumn(row, "startedAt"),
    status: column(row, "status"),
    task: column(row, "task"),
    teamStepId: column(row, "teamStepId"),
    tenant: column(row, "tenant"),
    version: column(row, "version"),
  };
}

function asEvent(row: Record<string, unknown>): RunnerRunEventRecord {
  return {
    createdAt: timestampColumn(row, "createdAt"),
    event: column(row, "event"),
    eventId: column(row, "eventId"),
    runId: column(row, "runId"),
  };
}

function asAttemptRedaction(
  row: Record<string, unknown>
): RunnerAttemptRedactionRecord {
  return {
    aadVersion: column(row, "aadVersion"),
    attemptId: column(row, "attemptId"),
    ciphertext: column(row, "ciphertext"),
    createdAt: timestampColumn(row, "createdAt"),
    iv: column(row, "iv"),
    kekVersion: column(row, "kekVersion"),
    runId: column(row, "runId"),
    wrappedKey: column(row, "wrappedKey"),
  };
}

type RunnerSchedulerRecord = Readonly<{
  consecutiveDispatchCount: number;
  lastDispatchedTenantHash: string | null;
}>;

function numericColumn(row: Record<string, unknown>, name: string): number {
  const value = column<unknown>(row, name);
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(`Runner query returned an invalid "${name}".`);
  }
  return numeric;
}

function asScheduler(row: Record<string, unknown>): RunnerSchedulerRecord {
  const lastDispatchedTenantHash = column<unknown>(
    row,
    "lastDispatchedTenantHash"
  );
  if (
    lastDispatchedTenantHash !== null &&
    typeof lastDispatchedTenantHash !== "string"
  ) {
    throw new Error(
      'Runner query returned an invalid "lastDispatchedTenantHash".'
    );
  }

  return {
    consecutiveDispatchCount: numericColumn(row, "consecutiveDispatchCount"),
    lastDispatchedTenantHash,
  };
}

function postgresTimestamp(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/u.exec(
      value
    );
  if (!match) {
    return null;
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const milliseconds = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3));
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  parsed.setUTCHours(hour, minute, second, milliseconds);
  return year >= 1 &&
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day &&
    parsed.getUTCHours() === hour &&
    parsed.getUTCMinutes() === minute &&
    parsed.getUTCSeconds() === second &&
    parsed.getUTCMilliseconds() === milliseconds
    ? parsed
    : null;
}

function timestampColumn(row: Record<string, unknown>, name: string): Date {
  const value = postgresTimestamp(column(row, name));
  if (!value) {
    throw new Error(`Runner query returned an invalid "${name}".`);
  }
  return value;
}

function nullableTimestampColumn(
  row: Record<string, unknown>,
  name: string
): Date | null {
  const value = column<unknown>(row, name);
  if (value === null) {
    return null;
  }
  const timestamp = postgresTimestamp(value);
  if (!timestamp) {
    throw new Error(`Runner query returned an invalid "${name}".`);
  }
  return timestamp;
}

function timestampParameter(value: Date): string {
  if (Number.isNaN(value.getTime())) {
    throw new Error("Runner timestamp parameter is invalid.");
  }
  return value.toISOString();
}

function asReconciliationLease(
  row: Record<string, unknown>
): RunnerReconciliationLease {
  const expiresAt = timestampColumn(row, "reconciliationLeaseExpiresAt");
  const ownerToken = column<unknown>(row, "reconciliationLeaseOwner");
  if (
    typeof ownerToken !== "string" ||
    ownerToken.length === 0 ||
    ownerToken.length > MAX_RECONCILIATION_LEASE_OWNER_LENGTH
  ) {
    throw new Error(
      'Runner query returned an invalid "reconciliationLeaseOwner".'
    );
  }
  return {
    expiresAt,
    fence: numericColumn(row, "reconciliationLeaseFence"),
    ownerToken,
  };
}

function validateReconciliationLeaseInput(
  input: AcquireRunnerReconciliationLeaseInput
): void {
  if (
    !input.ownerToken ||
    input.ownerToken.length > MAX_RECONCILIATION_LEASE_OWNER_LENGTH
  ) {
    throw new Error(
      `Runner reconciliation lease owner must be between 1 and ${MAX_RECONCILIATION_LEASE_OWNER_LENGTH} characters.`
    );
  }
  if (
    !Number.isSafeInteger(input.ttlSeconds) ||
    input.ttlSeconds < 1 ||
    input.ttlSeconds > MAX_RECONCILIATION_LEASE_TTL_SECONDS
  ) {
    throw new Error(
      `Runner reconciliation lease TTL must be between 1 and ${MAX_RECONCILIATION_LEASE_TTL_SECONDS} seconds.`
    );
  }
}

function admissionLimits(
  configured: RunnerAdmissionLimits | undefined
): RunnerAdmissionLimits {
  const limits = configured ?? DEFAULT_RUNNER_ADMISSION_LIMITS;
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Runner admission limits must be non-negative integers.");
    }
  }
  return limits;
}

async function lockRunnerScheduler(
  transaction: RunnerStoreTransaction
): Promise<RunnerSchedulerRecord> {
  const [row] = await transaction.execute(
    statement(
      "lock-runner-scheduler",
      {},
      sql`INSERT INTO "RunnerScheduler" ("singleton")
        VALUES (true)
        ON CONFLICT ("singleton") DO UPDATE
          SET "singleton" = EXCLUDED."singleton"
        RETURNING "consecutiveDispatchCount", "lastDispatchedTenantHash"`
    )
  );
  if (!row) {
    throw new Error("Runner scheduler lock returned no row.");
  }
  return asScheduler(row);
}

async function lockedOperationRun(
  transaction: RunnerStoreTransaction,
  input: StartRunnerRunInput,
  tenant: string
): Promise<RunnerRunRecord | null> {
  const [row] = await transaction.execute(
    statement(
      "get-operation-run-before-admission",
      { agentId: input.agentId, operationId: input.operationId, tenant },
      sql`SELECT * FROM "RunnerRun"
        WHERE "agentId" = ${input.agentId}
          AND "operationId" = ${input.operationId}
          AND "tenant" = ${tenant}
        FOR UPDATE`
    )
  );
  return row ? asRun(row) : null;
}

async function activeDispatchCount(
  transaction: RunnerStoreTransaction
): Promise<number> {
  const [row] = await transaction.execute(
    statement(
      "count-active-runs-for-admission",
      {},
      sql`SELECT count(*)::integer AS "activeCount"
        FROM "RunnerRun"
        WHERE (
          (
            "dispatchState" IN ('dispatching', 'running')
            AND "authorityRevalidation" = false
          )
          OR (
            "dispatchState" = 'terminal'
            AND (
              "daytonaAttemptId" IS NOT NULL
              OR "daytonaCommandId" IS NOT NULL
              OR "daytonaSessionId" IS NOT NULL
            )
          )
        )`
    )
  );
  return row ? numericColumn(row, "activeCount") : 0;
}

async function queuedTenantCount(
  transaction: RunnerStoreTransaction,
  tenant: string
): Promise<number> {
  const [row] = await transaction.execute(
    statement(
      "count-queued-runs-for-tenant-admission",
      { tenant },
      sql`SELECT count(*)::integer AS "queuedCount"
        FROM "RunnerRun"
        WHERE "tenant" = ${tenant}
          AND "status" = 'queued'
          AND (
            "dispatchState" = 'queued'
            OR (
              "dispatchState" = 'dispatching'
              AND "authorityRevalidation" = true
            )
          )`
    )
  );
  return row ? numericColumn(row, "queuedCount") : 0;
}

/**
 * The scheduler row serializes selection state. `md5` is used only as an
 * opaque, database-local tenant discriminator; tenant identifiers never leave
 * the transaction through scheduler state or a runner result.
 */
async function selectEligibleDispatch(
  transaction: RunnerStoreTransaction,
  scheduler: RunnerSchedulerRecord,
  limits: RunnerAdmissionLimits
): Promise<RunnerRunRecord | null> {
  const [row] = await transaction.execute(
    statement(
      "lock-next-eligible-dispatch",
      {
        consecutiveDispatches: limits.consecutiveDispatches,
        lastDispatchedTenantHash: scheduler.lastDispatchedTenantHash,
        tenantActiveRuns: limits.tenantActiveRuns,
      },
      sql`WITH eligible_tenants AS (
          SELECT
            "queued"."tenant",
            md5("queued"."tenant") AS "tenantHash",
            min("queued"."queueSequence") AS "headSequence"
          FROM "RunnerRun" AS "queued"
          WHERE "queued"."dispatchState" = 'queued'
            AND "queued"."status" = 'queued'
            AND NOT EXISTS (
              SELECT 1
              FROM "RunnerRun" AS "revalidating"
              WHERE "revalidating"."dispatchState" = 'dispatching'
                AND "revalidating"."authorityRevalidation" = true
                AND "revalidating"."queueSequence" < "queued"."queueSequence"
            )
            AND NOT EXISTS (
              SELECT 1
              FROM "RunnerRun" AS "agentActive"
              WHERE "agentActive"."agentId" = "queued"."agentId"
                AND (
                  (
                    "agentActive"."dispatchState" IN ('dispatching', 'running')
                    AND "agentActive"."authorityRevalidation" = false
                  )
                  OR (
                    "agentActive"."dispatchState" = 'terminal'
                    AND (
                      "agentActive"."daytonaAttemptId" IS NOT NULL
                      OR "agentActive"."daytonaCommandId" IS NOT NULL
                      OR "agentActive"."daytonaSessionId" IS NOT NULL
                    )
                  )
                )
            )
            AND (
              SELECT count(*)
              FROM "RunnerRun" AS "tenantActive"
              WHERE "tenantActive"."tenant" = "queued"."tenant"
                AND (
                  (
                    "tenantActive"."dispatchState" IN ('dispatching', 'running')
                    AND "tenantActive"."authorityRevalidation" = false
                  )
                  OR (
                    "tenantActive"."dispatchState" = 'terminal'
                    AND (
                      "tenantActive"."daytonaAttemptId" IS NOT NULL
                      OR "tenantActive"."daytonaCommandId" IS NOT NULL
                      OR "tenantActive"."daytonaSessionId" IS NOT NULL
                    )
                  )
                )
            ) < ${limits.tenantActiveRuns}
          GROUP BY "queued"."tenant"
        ),
        fair_tenants AS (
          SELECT *
          FROM eligible_tenants
          WHERE NOT (
            ${scheduler.lastDispatchedTenantHash}::text IS NOT NULL
            AND ${scheduler.consecutiveDispatchCount} >= ${limits.consecutiveDispatches}
            AND "tenantHash" = ${scheduler.lastDispatchedTenantHash}
            AND EXISTS (
              SELECT 1
              FROM eligible_tenants AS "otherTenant"
              WHERE "otherTenant"."tenantHash" <> ${scheduler.lastDispatchedTenantHash}
            )
          )
        )
        SELECT "queued".*
        FROM "RunnerRun" AS "queued"
        INNER JOIN fair_tenants
          ON "fair_tenants"."tenant" = "queued"."tenant"
          AND "fair_tenants"."headSequence" = "queued"."queueSequence"
        WHERE "queued"."dispatchState" = 'queued'
          AND "queued"."status" = 'queued'
        ORDER BY "queued"."queueSequence" ASC
        LIMIT 1
        FOR UPDATE OF "queued" SKIP LOCKED`
    )
  );
  return row ? asRun(row) : null;
}

/**
 * An authority preflight claims no execution capacity. It deliberately skips
 * scheduler fairness and active-run filters so a revoked queued run is closed
 * even when other runs currently occupy the tenant's execution slots.
 */
async function selectQueuedDispatchForRevalidation(
  transaction: RunnerStoreTransaction,
  excludedRunIds: readonly string[]
): Promise<RunnerRunRecord | null> {
  const excluded = excludedRunIds.length
    ? sql`AND "id" NOT IN (${sql.join(
        excludedRunIds.map((runId) => sql`${runId}`),
        sql`, `
      )})`
    : sql``;
  const [row] = await transaction.execute(
    statement(
      "lock-queued-dispatch-for-revalidation",
      {},
      sql`SELECT *
        FROM "RunnerRun"
        WHERE "dispatchState" = 'queued'
          AND "status" = 'queued'
          ${excluded}
        ORDER BY "updatedAt" ASC, "queueSequence" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`
    )
  );
  return row ? asRun(row) : null;
}

type ClaimedDispatchInput = DispatchClaimInput &
  Readonly<{ authorityRevalidation?: boolean }>;

type RevalidationDispatchClaimInput = ClaimedDispatchInput &
  Readonly<{ excludedRunIds?: readonly string[] }>;

async function claimLockedDispatch(
  transaction: RunnerStoreTransaction,
  candidate: RunnerRunRecord,
  input: ClaimedDispatchInput
): Promise<RunnerRunRecord | null> {
  const [updated] = await transaction.execute(
    statement(
      "claim-next-dispatch",
      {
        authorityRevalidation: input.authorityRevalidation ?? false,
        leaseExpiresAt: input.leaseExpiresAt,
        leaseToken: input.leaseToken,
        runId: candidate.id,
      },
      sql`UPDATE "RunnerRun"
        SET "dispatchState" = 'dispatching',
            "authorityRevalidation" = ${input.authorityRevalidation ?? false},
            "dispatchLeaseToken" = ${input.leaseToken},
            "dispatchLeaseExpiresAt" = ${timestampParameter(input.leaseExpiresAt)},
            "updatedAt" = clock_timestamp(),
            "version" = "version" + 1
        WHERE "id" = ${candidate.id}
          AND "dispatchState" = 'queued'
          AND "status" = 'queued'
          AND "authorityRevalidation" = false
        RETURNING *`
    )
  );
  return updated ? asRun(updated) : null;
}

async function advanceRunnerScheduler(
  transaction: RunnerStoreTransaction,
  scheduler: RunnerSchedulerRecord,
  tenant: string
): Promise<void> {
  await transaction.execute(
    statement(
      "advance-runner-scheduler",
      {
        consecutiveDispatchCount: scheduler.consecutiveDispatchCount,
        lastDispatchedTenantHash: scheduler.lastDispatchedTenantHash,
        tenant,
      },
      sql`UPDATE "RunnerScheduler"
        SET "lastDispatchedTenantHash" = md5(${tenant}),
            "consecutiveDispatchCount" = CASE
              WHEN "lastDispatchedTenantHash" = md5(${tenant})
                THEN "consecutiveDispatchCount" + 1
              ELSE 1
            END,
            "updatedAt" = clock_timestamp()
        WHERE "singleton" = true`
    )
  );
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

function matchesRunRequest(
  run: RunnerRunRecord,
  input: StartRunnerRunInput,
  executionPermission: RunnerRunRecord["executionPermission"]
): boolean {
  if (run.executionPermission !== executionPermission) {
    return false;
  }
  if (
    !sameSandboxBinding(
      run.sandboxBinding ?? null,
      input.sandboxBinding ?? null
    )
  ) {
    return false;
  }
  if (
    run.teamStepId !== (input.teamStepId ?? null) ||
    canonicalJsonStringify(run.githubBrokerPolicy) !==
      canonicalJsonStringify(input.githubBrokerPolicy ?? null)
  ) {
    return false;
  }
  if (run.requestHash === input.requestHash) {
    return true;
  }
  return (
    executionPermission !== "unrestricted" &&
    run.task === input.task &&
    run.requestHash === hashRunRequest(input.agentId, input.task)
  );
}

async function restoreDiscardedRunSandboxTrust(
  transaction: RunnerStoreTransaction,
  agentId: string,
  tenant: string,
  sandboxTrust: RunnerAgentRecord["sandboxTrust"]
): Promise<void> {
  await transaction.execute(
    statement(
      "restore-discarded-run-sandbox-trust",
      { agentId, sandboxTrust, tenant },
      sql`UPDATE "RunnerAgent"
        SET "sandboxTrust" = ${sandboxTrust},
            "updatedAt" = clock_timestamp()
        WHERE "id" = ${agentId}
          AND "tenant" = ${tenant}`
    )
  );
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

function dispatchAuthority(run: RunnerRunRecord): RunnerDispatchAuthority {
  if (!run.dispatchLeaseToken) {
    throw new Error("Cannot mint dispatch authority without an active lease.");
  }
  return {
    expectedVersion: run.version,
    leaseToken: run.dispatchLeaseToken,
    runId: run.id,
    ...(run.daytonaAttemptId ? { attemptId: run.daytonaAttemptId } : {}),
  } as RunnerDispatchAuthority;
}

async function lockedLiveDispatchRun(
  transaction: RunnerStoreTransaction,
  authority: RunnerDispatchAuthority,
  states: readonly ("dispatching" | "running")[]
): Promise<RunnerRunRecord | null> {
  const [run] = await transaction.execute(
    statement(
      "lock-live-dispatch-run",
      {
        dispatchStates: states,
        expectedVersion: authority.expectedVersion,
        leaseToken: authority.leaseToken,
        runId: authority.runId,
      },
      sql`SELECT * FROM "RunnerRun"
        WHERE "id" = ${authority.runId}
          AND "version" = ${authority.expectedVersion}
          AND "dispatchLeaseToken" = ${authority.leaseToken}
          AND "dispatchLeaseExpiresAt" > clock_timestamp()
          AND "cancellationRequestedAt" IS NULL
          AND "dispatchState" IN (${sql.join(
            states.map((state) => sql`${state}`),
            sql`, `
          )})
          AND (
            ("dispatchState" = 'dispatching' AND "status" = 'queued')
            OR ("dispatchState" = 'running' AND "status" = 'running')
          )
        FOR UPDATE`
    )
  );
  if (!run) {
    return null;
  }
  const parsed = asRun(run);
  return parsed.cancellationRequestedAt ? null : parsed;
}

async function lockedDispatchAgent(
  transaction: RunnerStoreTransaction,
  run: RunnerRunRecord
): Promise<RunnerAgentRecord | null> {
  const [agent] = await transaction.execute(
    statement(
      "lock-agent-for-live-dispatch",
      { agentId: run.agentId, tenant: run.tenant },
      sql`SELECT * FROM "RunnerAgent"
        WHERE "id" = ${run.agentId} AND "tenant" = ${run.tenant}
        FOR UPDATE`
    )
  );
  return agent ? asAgent(agent) : null;
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
          AND "daytonaAttemptId" IS NULL
          AND "daytonaSessionId" IS NULL
          AND "daytonaCommandId" IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM "RunnerTeamStep" AS "teamStep"
            WHERE "teamStep"."runnerRunId" = "RunnerRun"."id"
              OR "teamStep"."plannedRunnerRunId" = "RunnerRun"."id"
          )
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

async function pruneRunEventsInTransaction(
  transaction: RunnerStoreTransaction,
  name: string,
  runId: string,
  tenant: string
): Promise<void> {
  await transaction.execute(
    statement(
      name,
      {
        maxEventBytes: MAX_PERSISTED_EVENT_BYTES_PER_RUN,
        maxEvents: MAX_EVENTS_PER_RUN,
        runId,
        tenant,
      },
      sql`WITH ranked AS (
          SELECT "eventId",
              row_number() OVER (ORDER BY "eventId" DESC) AS "newestRank",
              sum(pg_column_size("event")) OVER (
                ORDER BY "eventId" DESC
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
              ) AS "retainedBytes"
          FROM "RunnerRunEvent"
          WHERE "runId" = ${runId}
        ),
        prunable AS (
          SELECT "eventId"
          FROM ranked
          WHERE "newestRank" > ${MAX_EVENTS_PER_RUN}
            OR ("newestRank" > 1 AND "retainedBytes" > ${MAX_PERSISTED_EVENT_BYTES_PER_RUN})
        )
        DELETE FROM "RunnerRunEvent"
        WHERE "runId" = ${runId}
          AND EXISTS (
            SELECT 1 FROM "RunnerRun"
            WHERE "id" = ${runId}
              AND "tenant" = ${tenant}
          )
          AND "eventId" IN (SELECT "eventId" FROM prunable)`
    )
  );
}

export type RunnerStore = ReturnType<typeof createRunnerStore>;

/**
 * Server-side persistence boundary for Agent Runner. It deliberately stores
 * only normalized snapshots/events; provider logs, credentials, cookies, and
 * bearer tokens have no fields or inputs in this API.
 */
export function createRunnerStore(database: RunnerStoreDatabase) {
  return {
    acquireReconciliationLease: (
      _operator: RunnerOperator,
      input: AcquireRunnerReconciliationLeaseInput
    ): Promise<AcquireRunnerReconciliationLeaseResult> => {
      validateReconciliationLeaseInput(input);
      return database.transaction(async (transaction) => {
        const [row] = await transaction.execute(
          statement(
            "acquire-reconciliation-lease",
            {
              ownerToken: input.ownerToken,
              ttlSeconds: input.ttlSeconds,
            },
            sql`INSERT INTO "RunnerScheduler" (
                "singleton",
                "reconciliationLeaseOwner",
                "reconciliationLeaseFence",
                "reconciliationLeaseExpiresAt"
              )
              VALUES (
                true,
                ${input.ownerToken},
                1,
                clock_timestamp() + make_interval(secs => ${input.ttlSeconds})
              )
              ON CONFLICT ("singleton") DO UPDATE
                SET "reconciliationLeaseOwner" = EXCLUDED."reconciliationLeaseOwner",
                    "reconciliationLeaseFence" = "RunnerScheduler"."reconciliationLeaseFence" + 1,
                    "reconciliationLeaseExpiresAt" =
                      clock_timestamp() + make_interval(secs => ${input.ttlSeconds}),
                    "updatedAt" = clock_timestamp()
                WHERE "RunnerScheduler"."reconciliationLeaseOwner" IS NULL
                  OR "RunnerScheduler"."reconciliationLeaseExpiresAt" <= clock_timestamp()
              RETURNING
                "reconciliationLeaseOwner",
                "reconciliationLeaseFence",
                "reconciliationLeaseExpiresAt"`
          )
        );
        return row
          ? { kind: "acquired", lease: asReconciliationLease(row) }
          : { kind: "held" };
      });
    },

    /**
     * A command-bearing attempt is adopted, never requeued blindly. The
     * reconciler snapshots that exact session/command before deciding whether
     * it is still running or safe to terminalize.
     */
    adoptExpiredDaytonaProcess: (
      _operator: RunnerOperator,
      input: AdoptExpiredDaytonaProcessInput
    ): Promise<ExpiredDaytonaProcessAdoption> =>
      database.transaction(async (transaction) => {
        const run = await lockedOperatorRun(
          transaction,
          _operator,
          input.runId
        );
        if (!run) {
          return { kind: "not_found" };
        }
        if (run.dispatchLeaseToken !== input.oldLeaseToken) {
          return { kind: "lease_lost" };
        }
        if (
          !isExpectedLiveDispatch(run, input.expectedDispatchState) ||
          run.daytonaAttemptId !== input.attemptId ||
          !run.daytonaCommandId
        ) {
          return { kind: "not_live" };
        }
        const sessionId = daytonaRunSessionName(input.runId, input.attemptId);
        if (run.daytonaSessionId !== sessionId) {
          return { kind: "not_live" };
        }
        const [expired] = await transaction.execute(
          statement(
            "confirm-expired-daytona-process-adoption",
            input,
            sql`SELECT "id" FROM "RunnerRun"
              WHERE "id" = ${input.runId}
                AND "dispatchLeaseToken" = ${input.oldLeaseToken}
                AND "dispatchLeaseExpiresAt" <= clock_timestamp()
                AND "dispatchState" = ${input.expectedDispatchState}
                AND "daytonaAttemptId" = ${input.attemptId}
                AND "daytonaSessionId" = ${sessionId}
                AND "daytonaCommandId" IS NOT NULL`
          )
        );
        if (!expired) {
          return { kind: "not_expired" };
        }
        const [updated] = await transaction.execute(
          statement(
            "adopt-expired-daytona-process",
            input,
            sql`UPDATE "RunnerRun"
              SET "dispatchLeaseToken" = ${input.newLeaseToken},
                  "dispatchLeaseExpiresAt" = ${timestampParameter(input.leaseExpiresAt)},
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "id" = ${input.runId}
                AND "dispatchLeaseToken" = ${input.oldLeaseToken}
                AND "dispatchLeaseExpiresAt" <= clock_timestamp()
                AND "dispatchState" = ${input.expectedDispatchState}
                AND "daytonaAttemptId" = ${input.attemptId}
                AND "daytonaSessionId" = ${sessionId}
                AND "daytonaCommandId" IS NOT NULL
              RETURNING *`
          )
        );
        if (!updated) {
          return { kind: "not_expired" };
        }
        const value = asRun(updated);
        return {
          authority: {
            ...dispatchAuthority(value),
            attemptId: input.attemptId,
          } as RunnerDispatchAuthority,
          kind: "adopted",
          run: value,
        };
      }),
    adoptExpiredDispatchLease: (
      _operator: RunnerOperator,
      input: ExpiredDispatchLeaseAdoptionInput
    ): Promise<ExpiredDispatchRecoveryOutcome> =>
      database.transaction(async (transaction) => {
        const run = await lockedOperatorRun(
          transaction,
          _operator,
          input.runId
        );
        if (!run) {
          return { kind: "not_found" };
        }
        if (run.dispatchLeaseToken !== input.oldLeaseToken) {
          return { kind: "lease_lost" };
        }
        if (!isExpectedLiveDispatch(run, input.expectedDispatchState)) {
          return { kind: "not_live" };
        }
        const [expired] = await transaction.execute(
          statement(
            "confirm-expired-dispatch-adoption",
            input,
            sql`SELECT "id" FROM "RunnerRun"
              WHERE "id" = ${input.runId}
                AND "dispatchLeaseToken" = ${input.oldLeaseToken}
                AND "dispatchLeaseExpiresAt" <= clock_timestamp()
                AND "dispatchState" = ${input.expectedDispatchState}`
          )
        );
        if (!expired) {
          return { kind: "not_expired" };
        }
        if (run.daytonaAttemptId) {
          return { attemptId: run.daytonaAttemptId, kind: "cleanup_required" };
        }
        if (run.daytonaSessionId || run.daytonaCommandId) {
          return { kind: "provider_identifiers_attached" };
        }
        const [updated] = await transaction.execute(
          statement(
            "adopt-expired-dispatch-lease",
            input,
            sql`UPDATE "RunnerRun"
              SET "dispatchLeaseToken" = ${input.newLeaseToken},
                  "dispatchLeaseExpiresAt" = ${timestampParameter(input.leaseExpiresAt)},
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
    advanceDaytonaLogCursor: (
      _operator: RunnerOperator,
      authority: RunnerDispatchAuthority,
      daytonaLogCursor: number
    ): Promise<
      | {
          authority: RunnerDispatchAuthority;
          kind: "updated";
          value: RunnerRunRecord;
        }
      | { kind: "not_live" }
    > =>
      database.transaction(async (transaction) => {
        if (!Number.isSafeInteger(daytonaLogCursor) || daytonaLogCursor < 0) {
          return { kind: "not_live" };
        }
        const current = await lockedLiveDispatchRun(transaction, authority, [
          "running",
        ]);
        if (!current) {
          return { kind: "not_live" };
        }
        const [updated] = await transaction.execute(
          statement(
            "advance-daytona-log-cursor",
            {
              daytonaLogCursor,
              expectedVersion: authority.expectedVersion,
              leaseToken: authority.leaseToken,
              runId: current.id,
              tenant: current.tenant,
            },
            sql`UPDATE "RunnerRun"
              SET "daytonaLogCursor" = GREATEST("daytonaLogCursor", ${daytonaLogCursor}),
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "id" = ${current.id}
                AND "tenant" = ${current.tenant}
                AND "version" = ${authority.expectedVersion}
                AND "dispatchLeaseToken" = ${authority.leaseToken}
                AND "dispatchLeaseExpiresAt" > clock_timestamp()
                AND "dispatchState" = 'running'
                AND "status" = 'running'
                AND "cancellationRequestedAt" IS NULL
              RETURNING *`
          )
        );
        if (!updated) {
          return { kind: "not_live" };
        }
        const value = asRun(updated);
        return { authority: dispatchAuthority(value), kind: "updated", value };
      }),
    appendCancellationDiagnostic: (
      operator: RunnerOperator,
      authority: RunnerDispatchAuthority
    ): Promise<
      | {
          authority: RunnerDispatchAuthority;
          event: RunnerRunEventRecord;
          kind: "appended";
        }
      | { kind: "not_live" }
    > =>
      database.transaction(async (transaction) => {
        const run = await lockedOperatorRun(
          transaction,
          operator,
          authority.runId
        );
        if (
          !run ||
          fenceOutcome(run, authority) ||
          !run.cancellationRequestedAt ||
          (run.dispatchState !== "dispatching" &&
            run.dispatchState !== "running")
        ) {
          return { kind: "not_live" };
        }
        const eventId = run.logCursor + 1;
        const event: RunEvent = {
          id: eventId,
          output: CANCELLATION_CLEANUP_DIAGNOSTIC,
          type: "output",
        };
        const [updated] = await transaction.execute(
          statement(
            "append-cancellation-diagnostic",
            {
              eventId,
              expectedVersion: authority.expectedVersion,
              leaseToken: authority.leaseToken,
              runId: run.id,
              tenant: run.tenant,
            },
            sql`UPDATE "RunnerRun"
              SET "logCursor" = ${eventId},
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "id" = ${run.id}
                AND "tenant" = ${run.tenant}
                AND "version" = ${authority.expectedVersion}
                AND "dispatchLeaseToken" = ${authority.leaseToken}
                AND "dispatchLeaseExpiresAt" > clock_timestamp()
                AND "cancellationRequestedAt" IS NOT NULL
                AND "dispatchState" IN ('dispatching', 'running')
                AND "status" IN ('queued', 'running')
              RETURNING *`
          )
        );
        if (!updated) {
          return { kind: "not_live" };
        }
        const [inserted] = await transaction.execute(
          statement(
            "insert-cancellation-diagnostic",
            { event: eventJson(event), eventId, runId: run.id },
            sql`INSERT INTO "RunnerRunEvent" ("runId", "eventId", "event")
              VALUES (${run.id}, ${eventId}, CAST(${eventJson(event)} AS jsonb))
              RETURNING *`
          )
        );
        if (!inserted) {
          throw new Error(
            "Runner cancellation diagnostic insert returned no row."
          );
        }
        await pruneRunEventsInTransaction(
          transaction,
          "prune-run-events-after-cancellation-diagnostic",
          run.id,
          run.tenant
        );
        const value = asRun(updated);
        return {
          authority: {
            ...dispatchAuthority(value),
            ...(value.daytonaAttemptId
              ? { attemptId: value.daytonaAttemptId }
              : {}),
          } as RunnerDispatchAuthority,
          event: asEvent(inserted),
          kind: "appended",
        };
      }),

    appendDispatchEvent: (
      _operator: RunnerOperator,
      authority: RunnerDispatchAuthority,
      input: Omit<AppendRunnerEventInput, keyof DispatchFence>
    ): Promise<
      | {
          authority: RunnerDispatchAuthority;
          event: RunnerRunEventRecord;
          kind: "appended";
          run: RunSnapshot;
        }
      | { kind: "not_live" }
    > =>
      database.transaction(async (transaction) => {
        const current = await lockedLiveDispatchRun(transaction, authority, [
          "running",
        ]);
        if (!current) {
          return { kind: "not_live" };
        }
        const eventId = current.logCursor + 1;
        const event = { ...input.event, id: eventId } as RunEvent;
        const [updated] = await transaction.execute(
          statement(
            "update-run-after-dispatch-event",
            {
              commandEvidence: evidenceJson(input.snapshot?.commandEvidence),
              daytonaLogCursor: input.daytonaLogCursor ?? null,
              eventId,
              expectedVersion: authority.expectedVersion,
              fileEvidence: evidenceJson(input.snapshot?.fileEvidence),
              leaseToken: authority.leaseToken,
              output: input.snapshot?.output ?? null,
              runId: current.id,
              tenant: current.tenant,
            },
            sql`UPDATE "RunnerRun"
              SET "logCursor" = ${eventId},
                  "daytonaLogCursor" = COALESCE(${input.daytonaLogCursor ?? null}, "daytonaLogCursor"),
                  "output" = COALESCE(${input.snapshot?.output ?? null}, "output"),
                  "commandEvidence" = COALESCE(CAST(${evidenceJson(input.snapshot?.commandEvidence)} AS jsonb), "commandEvidence"),
                  "fileEvidence" = COALESCE(CAST(${evidenceJson(input.snapshot?.fileEvidence)} AS jsonb), "fileEvidence"),
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${current.id}
                AND "tenant" = ${current.tenant}
                AND "version" = ${authority.expectedVersion}
                AND "dispatchLeaseToken" = ${authority.leaseToken}
                AND "dispatchLeaseExpiresAt" > clock_timestamp()
                AND "dispatchState" = 'running'
                AND "status" = 'running'
              RETURNING *`
          )
        );
        if (!updated) {
          return { kind: "not_live" };
        }
        const [inserted] = await transaction.execute(
          statement(
            "insert-dispatch-run-event",
            {
              event: eventJson(event),
              eventId,
              runId: current.id,
              tenant: current.tenant,
            },
            sql`INSERT INTO "RunnerRunEvent" ("runId", "eventId", "event")
              SELECT ${current.id}, ${eventId}, CAST(${eventJson(event)} AS jsonb)
              FROM "RunnerRun"
              WHERE "id" = ${current.id} AND "tenant" = ${current.tenant}
              RETURNING *`
          )
        );
        if (!inserted) {
          throw new Error("Runner event insert returned no row.");
        }
        await pruneRunEventsInTransaction(
          transaction,
          "prune-run-events-after-dispatch-append",
          current.id,
          current.tenant
        );
        const run = asRun(updated);
        return {
          authority: dispatchAuthority(run),
          event: asEvent(inserted),
          kind: "appended",
          run: runSnapshot(run),
        };
      }),

    appendDispatchEventBatch: (
      _operator: RunnerOperator,
      authority: RunnerDispatchAuthority,
      input: Omit<AppendRunnerEventBatchInput, keyof DispatchFence>
    ): Promise<
      | {
          authority: RunnerDispatchAuthority;
          events: RunnerRunEventRecord[];
          kind: "appended";
          run: RunSnapshot;
        }
      | { kind: "not_live" }
    > =>
      database.transaction(async (transaction) => {
        if (
          !Number.isSafeInteger(input.daytonaLogCursor) ||
          input.daytonaLogCursor < 0
        ) {
          return { kind: "not_live" };
        }
        const current = await lockedLiveDispatchRun(transaction, authority, [
          "running",
        ]);
        if (!current) {
          return { kind: "not_live" };
        }
        if (
          input.daytonaLogCursor < current.daytonaLogCursor ||
          (input.events.length > 0 &&
            input.daytonaLogCursor === current.daytonaLogCursor)
        ) {
          return { kind: "not_live" };
        }
        const firstEventId = current.logCursor + 1;
        const events = input.events.map(
          (event, index) => ({ ...event, id: firstEventId + index }) as RunEvent
        );
        const nextEventId = current.logCursor + events.length;
        const [updated] = await transaction.execute(
          statement(
            "update-run-after-dispatch-event-batch",
            {
              commandEvidence: evidenceJson(input.snapshot?.commandEvidence),
              daytonaLogCursor: input.daytonaLogCursor,
              eventCount: events.length,
              expectedVersion: authority.expectedVersion,
              fileEvidence: evidenceJson(input.snapshot?.fileEvidence),
              firstEventId,
              leaseToken: authority.leaseToken,
              nextEventId,
              output: input.snapshot?.output ?? null,
              runId: current.id,
              tenant: current.tenant,
            },
            sql`UPDATE "RunnerRun"
              SET "logCursor" = ${nextEventId},
                  "daytonaLogCursor" = ${input.daytonaLogCursor},
                  "output" = COALESCE(${input.snapshot?.output ?? null}, "output"),
                  "commandEvidence" = COALESCE(CAST(${evidenceJson(input.snapshot?.commandEvidence)} AS jsonb), "commandEvidence"),
                  "fileEvidence" = COALESCE(CAST(${evidenceJson(input.snapshot?.fileEvidence)} AS jsonb), "fileEvidence"),
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "id" = ${current.id}
                AND "tenant" = ${current.tenant}
                AND "version" = ${authority.expectedVersion}
                AND "dispatchLeaseToken" = ${authority.leaseToken}
                AND "dispatchLeaseExpiresAt" > clock_timestamp()
                AND "dispatchState" = 'running'
                AND "status" = 'running'
                AND "cancellationRequestedAt" IS NULL
              RETURNING *`
          )
        );
        if (!updated) {
          return { kind: "not_live" };
        }
        const inserted =
          events.length === 0
            ? []
            : await transaction.execute(
                statement(
                  "insert-dispatch-run-event-batch",
                  {
                    events: events.map((event) => eventJson(event)),
                    firstEventId,
                    runId: current.id,
                    tenant: current.tenant,
                  },
                  sql`INSERT INTO "RunnerRunEvent" ("runId", "eventId", "event")
                    VALUES ${sql.join(
                      events.map(
                        (event) =>
                          sql`(${current.id}, ${event.id}, CAST(${eventJson(event)} AS jsonb))`
                      ),
                      sql`, `
                    )}
                    RETURNING *`
                )
              );
        if (inserted.length !== events.length) {
          throw new Error(
            "Runner event batch insert returned an incomplete row set."
          );
        }
        await pruneRunEventsInTransaction(
          transaction,
          "prune-run-events-after-dispatch-batch",
          current.id,
          current.tenant
        );
        const value = asRun(updated);
        return {
          authority: dispatchAuthority(value),
          events: inserted.map(asEvent),
          kind: "appended",
          run: runSnapshot(value),
        };
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
        await pruneRunEventsInTransaction(
          transaction,
          "prune-run-events-after-append",
          input.runId,
          principal.tenant
        );
        return {
          event: asEvent(inserted),
          kind: "appended",
          run: runSnapshot(asRun(updated)),
        };
      }),

    appendTerminalCleanupDiagnostic: (
      operator: RunnerOperator,
      authority: RunnerDispatchAuthority
    ): Promise<
      | {
          authority: RunnerDispatchAuthority;
          event: RunnerRunEventRecord;
          kind: "appended";
        }
      | { kind: "not_live" }
    > =>
      database.transaction(async (transaction) => {
        const run = await lockedOperatorRun(
          transaction,
          operator,
          authority.runId
        );
        if (
          !run ||
          fenceOutcome(run, authority) ||
          !authority.attemptId ||
          run.daytonaAttemptId !== authority.attemptId ||
          run.dispatchState !== "terminal"
        ) {
          return { kind: "not_live" };
        }
        const eventId = run.logCursor + 1;
        const event: RunEvent = {
          id: eventId,
          output: TERMINAL_CLEANUP_RESET_DIAGNOSTIC,
          type: "output",
        };
        const [updated] = await transaction.execute(
          statement(
            "append-terminal-cleanup-diagnostic",
            {
              attemptId: authority.attemptId,
              eventId,
              expectedVersion: authority.expectedVersion,
              leaseToken: authority.leaseToken,
              runId: run.id,
              tenant: run.tenant,
            },
            sql`UPDATE "RunnerRun"
              SET "logCursor" = ${eventId},
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "id" = ${run.id}
                AND "tenant" = ${run.tenant}
                AND "version" = ${authority.expectedVersion}
                AND "dispatchLeaseToken" = ${authority.leaseToken}
                AND "dispatchState" = 'terminal'
                AND "daytonaAttemptId" = ${authority.attemptId}
              RETURNING *`
          )
        );
        if (!updated) {
          return { kind: "not_live" };
        }
        const [inserted] = await transaction.execute(
          statement(
            "insert-terminal-cleanup-diagnostic",
            { event: eventJson(event), eventId, runId: run.id },
            sql`INSERT INTO "RunnerRunEvent" ("runId", "eventId", "event")
              VALUES (${run.id}, ${eventId}, CAST(${eventJson(event)} AS jsonb))
              RETURNING *`
          )
        );
        if (!inserted) {
          throw new Error(
            "Runner terminal cleanup diagnostic insert returned no row."
          );
        }
        await pruneRunEventsInTransaction(
          transaction,
          "prune-run-events-after-terminal-cleanup-diagnostic",
          run.id,
          run.tenant
        );
        const value = asRun(updated);
        return {
          authority: dispatchAuthority(value),
          event: asEvent(inserted),
          kind: "appended",
        };
      }),

    attachDaytonaSandbox: (
      principal: RunnerPrincipal,
      input: DaytonaSandboxFence & { sandboxId: string }
    ): Promise<
      | { kind: "updated"; value: RunnerAgentRecord }
      | { kind: "not_found" }
      | { current: RunnerAgentRecord; kind: "stale_version" }
    > =>
      database.transaction(async (transaction) => {
        const [updated] = await transaction.execute(
          statement(
            "attach-daytona-sandbox-generation",
            { ...input, tenant: principal.tenant },
            sql`UPDATE "RunnerAgent"
              SET "daytonaSandboxId" = ${input.sandboxId},
                  "sandboxLifecycle" = 'ready',
                  "sandboxUpdatedAt" = now(),
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${input.agentId}
                AND "tenant" = ${principal.tenant}
                AND "version" = ${input.expectedVersion}
                AND "sandboxGeneration" = ${input.expectedGeneration}
                AND "sandboxLifecycle" IN ('provisioning', 'provisioning_ambiguous')
              RETURNING *`
          )
        );
        if (updated) {
          return { kind: "updated", value: asAgent(updated) };
        }
        const [current] = await transaction.execute(
          statement(
            "get-agent-after-daytona-sandbox-attach",
            { agentId: input.agentId, tenant: principal.tenant },
            sql`SELECT * FROM "RunnerAgent"
              WHERE "id" = ${input.agentId}
                AND "tenant" = ${principal.tenant}
              LIMIT 1`
          )
        );
        return current
          ? { current: asAgent(current), kind: "stale_version" as const }
          : { kind: "not_found" as const };
      }),

    attachDaytonaSandboxForDispatch: (
      _operator: RunnerOperator,
      authority: RunnerDispatchAuthority,
      input: DispatchSandboxFence & { sandboxId: string }
    ): Promise<
      | { kind: "updated"; value: RunnerAgentRecord }
      | { kind: "not_found" }
      | { kind: "not_live" }
      | { kind: "stale_version" }
    > =>
      database.transaction(async (transaction) => {
        const run = await lockedLiveDispatchRun(transaction, authority, [
          "dispatching",
          "running",
        ]);
        if (!run) {
          return { kind: "not_live" };
        }
        const agent = await lockedDispatchAgent(transaction, run);
        if (!agent) {
          return { kind: "not_found" };
        }
        if (
          agent.version !== input.expectedVersion ||
          agent.sandboxGeneration !== input.expectedGeneration ||
          (agent.sandboxLifecycle !== "provisioning" &&
            agent.sandboxLifecycle !== "provisioning_ambiguous")
        ) {
          return { kind: "stale_version" };
        }
        const [updated] = await transaction.execute(
          statement(
            "attach-daytona-sandbox-for-dispatch",
            {
              agentId: run.agentId,
              expectedGeneration: input.expectedGeneration,
              expectedVersion: input.expectedVersion,
              sandboxId: input.sandboxId,
              tenant: run.tenant,
            },
            sql`UPDATE "RunnerAgent"
              SET "daytonaSandboxId" = ${input.sandboxId},
                  "sandboxLifecycle" = 'ready',
                  "sandboxUpdatedAt" = now(),
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${run.agentId}
                AND "tenant" = ${run.tenant}
                AND "version" = ${input.expectedVersion}
                AND "sandboxGeneration" = ${input.expectedGeneration}
                AND "sandboxLifecycle" IN ('provisioning', 'provisioning_ambiguous')
              RETURNING *`
          )
        );
        return updated
          ? { kind: "updated", value: asAgent(updated) }
          : { kind: "stale_version" };
      }),

    attachDaytonaSandboxForRecovery: (
      _operator: RunnerOperator,
      input: DaytonaSandboxFence & { sandboxId: string }
    ): Promise<
      | { kind: "updated"; value: RunnerAgentRecord }
      | { kind: "not_found" }
      | { kind: "stale_version" }
    > =>
      database.transaction(async (transaction) => {
        const [updated] = await transaction.execute(
          statement(
            "attach-daytona-sandbox-for-recovery",
            input,
            sql`UPDATE "RunnerAgent"
              SET "daytonaSandboxId" = ${input.sandboxId},
                  "sandboxLifecycle" = 'ready',
                  "sandboxUpdatedAt" = clock_timestamp(),
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "id" = ${input.agentId}
                AND "version" = ${input.expectedVersion}
                AND "sandboxGeneration" = ${input.expectedGeneration}
                AND "sandboxLifecycle" IN ('provisioning', 'provisioning_ambiguous')
              RETURNING *`
          )
        );
        if (updated) {
          return { kind: "updated", value: asAgent(updated) };
        }
        const [current] = await transaction.execute(
          statement(
            "get-agent-after-daytona-recovery-attach",
            { agentId: input.agentId },
            sql`SELECT "id" FROM "RunnerAgent"
              WHERE "id" = ${input.agentId}
              LIMIT 1`
          )
        );
        return current ? { kind: "stale_version" } : { kind: "not_found" };
      }),

    authorizeDaytonaLaunch: (
      _operator: RunnerOperator,
      authority: RunnerDispatchAuthority,
      input: {
        commandId?: string;
        attemptId: RunnerDaytonaAttemptId;
        sessionId: string;
      }
    ): Promise<
      | {
          authority: RunnerDispatchAuthority;
          kind: "authorized";
          value: RunnerRunRecord;
        }
      | { kind: "not_live" }
    > =>
      database.transaction(async (transaction) => {
        const run = await lockedLiveDispatchRun(transaction, authority, [
          "dispatching",
        ]);
        if (
          !run ||
          authority.attemptId !== input.attemptId ||
          run.daytonaAttemptId !== input.attemptId ||
          run.daytonaSessionId ||
          run.daytonaCommandId ||
          input.sessionId !== daytonaRunSessionName(run.id, input.attemptId)
        ) {
          return { kind: "not_live" };
        }
        const [updated] = await transaction.execute(
          statement(
            "authorize-daytona-launch",
            {
              attemptId: input.attemptId,
              commandId: input.commandId ?? null,
              expectedVersion: authority.expectedVersion,
              leaseToken: authority.leaseToken,
              runId: run.id,
              sessionId: input.sessionId,
              tenant: run.tenant,
            },
            sql`UPDATE "RunnerRun"
              SET "daytonaSessionId" = ${input.sessionId},
                  "daytonaCommandId" = ${input.commandId ?? null},
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${run.id}
                AND "tenant" = ${run.tenant}
                AND "version" = ${authority.expectedVersion}
                AND "dispatchLeaseToken" = ${authority.leaseToken}
                AND "dispatchLeaseExpiresAt" > clock_timestamp()
                AND "dispatchState" = 'dispatching'
                AND "status" = 'queued'
                AND "daytonaAttemptId" = ${input.attemptId}
                AND "daytonaSessionId" IS NULL
                AND "daytonaCommandId" IS NULL
              RETURNING *`
          )
        );
        if (!updated) {
          return { kind: "not_live" };
        }
        const value = asRun(updated);
        return {
          authority: {
            ...dispatchAuthority(value),
            attemptId: input.attemptId,
          } as RunnerDispatchAuthority,
          kind: "authorized",
          value,
        };
      }),

    authorizeDaytonaPreparation: (
      _operator: RunnerOperator,
      authority: RunnerDispatchAuthority,
      input: AuthorizeDaytonaPreparationInput
    ): Promise<
      | {
          authority: RunnerDispatchAuthority;
          attemptId: RunnerDaytonaAttemptId;
          kind: "authorized";
        }
      | { kind: "not_live" }
    > =>
      database.transaction(async (transaction) => {
        const run = await lockedLiveDispatchRun(transaction, authority, [
          "dispatching",
        ]);
        if (
          !run ||
          run.executionProvenance ||
          run.daytonaSessionId ||
          run.daytonaCommandId
        ) {
          return { kind: "not_live" };
        }
        if (run.daytonaAttemptId) {
          return { kind: "not_live" };
        }
        const attemptId =
          input.attemptId ?? (randomUUID() as RunnerDaytonaAttemptId);
        const [updated] = await transaction.execute(
          statement(
            "claim-daytona-process-preparation",
            {
              attemptId,
              executionProvenance: input.executionProvenance,
              expectedVersion: authority.expectedVersion,
              leaseToken: authority.leaseToken,
              runId: run.id,
              tenant: run.tenant,
            },
            sql`UPDATE "RunnerRun"
              SET "daytonaAttemptId" = ${attemptId},
                  "executionProvenance" = ${JSON.stringify(input.executionProvenance)}::jsonb,
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${run.id}
                AND "tenant" = ${run.tenant}
                AND "version" = ${authority.expectedVersion}
                AND "dispatchLeaseToken" = ${authority.leaseToken}
                AND "dispatchLeaseExpiresAt" > clock_timestamp()
                AND "dispatchState" = 'dispatching'
                AND "status" = 'queued'
                AND "daytonaAttemptId" IS NULL
                AND "executionProvenance" IS NULL
                AND "daytonaSessionId" IS NULL
                AND "daytonaCommandId" IS NULL
              RETURNING *`
          )
        );
        if (!updated) {
          return { kind: "not_live" };
        }
        const value = asRun(updated);
        return {
          attemptId,
          authority: {
            ...dispatchAuthority(value),
            attemptId,
          } as RunnerDispatchAuthority,
          kind: "authorized",
        };
      }),

    authorizeUnrestrictedExecution: (
      _operator: RunnerOperator,
      authority: RunnerDispatchAuthority
    ): Promise<{ kind: "authorized" | "not_live" }> =>
      database.transaction(async (transaction) => {
        const run = await lockedLiveDispatchRun(transaction, authority, [
          "dispatching",
        ]);
        if (
          run?.executionPermission !== "unrestricted" ||
          !authority.attemptId ||
          run.daytonaAttemptId !== authority.attemptId ||
          run.daytonaSessionId ||
          run.daytonaCommandId
        ) {
          return { kind: "not_live" };
        }
        const [updated] = await transaction.execute(
          statement(
            "authorize-unrestricted-execution",
            { agentId: run.agentId, tenant: run.tenant },
            sql`UPDATE "RunnerAgent"
              SET "sandboxTrust" = 'unrestricted',
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "id" = ${run.agentId}
                AND "tenant" = ${run.tenant}
              RETURNING "id"`
          )
        );
        return { kind: updated ? "authorized" : "not_live" };
      }),

    beginDaytonaSandboxDecommission: (
      principal: RunnerPrincipal,
      input: BeginDaytonaSandboxDecommissionInput
    ): Promise<
      | { kind: "decommissioning"; value: RunnerAgentRecord }
      | { kind: "cleanup_required"; value: RunnerAgentRecord }
      | { kind: "busy" }
      | { kind: "not_found" }
    > =>
      database.transaction(async (transaction) => {
        const [current] = await transaction.execute(
          statement(
            "lock-agent-for-daytona-decommission",
            { ...input, tenant: principal.tenant },
            sql`SELECT * FROM "RunnerAgent"
              WHERE "id" = ${input.agentId}
                AND "tenant" = ${principal.tenant}
              FOR UPDATE`
          )
        );
        if (!current) {
          return { kind: "not_found" };
        }
        const agent = asAgent(current);
        if (agent.sandboxLifecycle === "provisioning_ambiguous") {
          return { kind: "cleanup_required", value: agent };
        }
        if (agent.sandboxLifecycle === "decommissioning") {
          return { kind: "decommissioning", value: agent };
        }
        if (agent.sandboxLifecycle === "resizing") {
          return { kind: "busy" };
        }
        const [liveRun] = await transaction.execute(
          statement(
            "find-live-run-for-daytona-decommission",
            { agentId: input.agentId, tenant: principal.tenant },
            sql`SELECT "id" FROM "RunnerRun"
              WHERE "agentId" = ${input.agentId}
                AND "tenant" = ${principal.tenant}
                AND "status" IN ('queued', 'running')
              LIMIT 1`
          )
        );
        if (liveRun) {
          return { kind: "busy" };
        }
        if (
          agent.sandboxLifecycle === "provisioning" &&
          agent.sandboxUpdatedAt > input.provisioningStaleBefore
        ) {
          return { kind: "busy" };
        }
        const [updated] = await transaction.execute(
          statement(
            "begin-daytona-sandbox-decommission",
            {
              ...input,
              expectedVersion: agent.version,
              tenant: principal.tenant,
            },
            sql`UPDATE "RunnerAgent"
              SET "sandboxLifecycle" = 'decommissioning',
                  "sandboxGeneration" = CASE
                    WHEN "sandboxLifecycle" = 'provisioning'
                      THEN "sandboxGeneration" + 1
                    ELSE "sandboxGeneration"
                  END,
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${input.agentId}
                AND "tenant" = ${principal.tenant}
                AND "version" = ${agent.version}
                AND (
                  "sandboxLifecycle" IN ('unprovisioned', 'ready', 'decommission_failed')
                  OR (
                    "sandboxLifecycle" = 'provisioning'
                    AND "sandboxUpdatedAt" <= ${timestampParameter(input.provisioningStaleBefore)}
                  )
                )
              RETURNING *`
          )
        );
        if (!updated) {
          throw new Error(
            "Locked Runner agent changed before decommissioning."
          );
        }
        return { kind: "decommissioning", value: asAgent(updated) };
      }),

    /**
     * Subscriber-initiated reset, used when prewarming finds a sandbox whose
     * configuration no longer matches.
     *
     * Unlike the dispatch and cancellation resets, this one is not reached
     * through a run lease, so it carries its own liveness guard: a sandbox
     * holding a dispatching or running attempt is never reset here. Without
     * that clause a prewarm could delete the sandbox out from under a live
     * run, which is why this path previously refused to replace at all and
     * left a drifted agent retrying forever instead.
     */
    beginDaytonaSandboxReset: (
      principal: RunnerPrincipal,
      input: DaytonaSandboxFence
    ): Promise<
      | { kind: "updated"; value: RunnerAgentRecord }
      | { kind: "not_found" | "not_live" | "stale_version" }
    > =>
      database.transaction(async (transaction) => {
        const [updated] = await transaction.execute(
          statement(
            "begin-daytona-sandbox-reset",
            { ...input, tenant: principal.tenant },
            sql`UPDATE "RunnerAgent"
              SET "sandboxGeneration" = "sandboxGeneration" + 1,
                  "sandboxLifecycle" = 'resetting',
                  "sandboxUpdatedAt" = clock_timestamp(),
                  "warmStatus" = 'not_started',
                  "warmUpdatedAt" = clock_timestamp(),
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "id" = ${input.agentId}
                AND "tenant" = ${principal.tenant}
                AND "version" = ${input.expectedVersion}
                AND "sandboxGeneration" = ${input.expectedGeneration}
                AND "sandboxLifecycle" IN (
                  'provisioning',
                  'provisioning_ambiguous',
                  'ready'
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM "RunnerRun" AS "agentLive"
                  WHERE "agentLive"."agentId" = ${input.agentId}
                    AND "agentLive"."tenant" = ${principal.tenant}
                    AND "agentLive"."dispatchState" IN (
                      'dispatching',
                      'running'
                    )
                )
              RETURNING *`
          )
        );
        if (updated) {
          return { kind: "updated", value: asAgent(updated) };
        }
        const [current] = await transaction.execute(
          statement(
            "get-agent-after-daytona-sandbox-reset-begin",
            { agentId: input.agentId, tenant: principal.tenant },
            sql`SELECT
                "agent"."id",
                EXISTS (
                  SELECT 1
                  FROM "RunnerRun" AS "agentLive"
                  WHERE "agentLive"."agentId" = "agent"."id"
                    AND "agentLive"."tenant" = "agent"."tenant"
                    AND "agentLive"."dispatchState" IN (
                      'dispatching',
                      'running'
                    )
                ) AS "live"
              FROM "RunnerAgent" AS "agent"
              WHERE "agent"."id" = ${input.agentId}
                AND "agent"."tenant" = ${principal.tenant}
              LIMIT 1`
          )
        );
        if (!current) {
          return { kind: "not_found" };
        }
        // A live attempt is a wait, not a conflict: the caller retries once
        // the run finishes rather than treating the agent as stale.
        return (current as { live?: boolean }).live
          ? { kind: "not_live" }
          : { kind: "stale_version" };
      }),

    /**
     * Fences the persistent sandbox before an exact cancellation, terminal,
     * or command-free attempt cleanup can delete it. `resetting` blocks every
     * provisioning path until Daytona absence is confirmed and the next
     * sandbox generation is cleared. An explicit retry renews the same reset
     * generation under a fresh agent-version fence; the lifecycle state alone
     * is never deletion authority.
     */
    beginDaytonaSandboxResetForCancellation: (
      operator: RunnerOperator,
      authority: RunnerDispatchAuthority
    ): Promise<
      | { kind: "resetting"; value: RunnerAgentRecord }
      | { kind: "in_progress"; value: RunnerAgentRecord }
      | {
          kind: "lease_lost" | "not_found" | "not_live" | "stale_version";
        }
    > =>
      database.transaction(async (transaction) => {
        const run = await lockedOperatorRun(
          transaction,
          operator,
          authority.runId
        );
        if (!run) {
          return { kind: "not_found" };
        }
        const rejected = fenceOutcome(run, authority);
        if (rejected) {
          return rejected;
        }
        if ((run.daytonaAttemptId ?? null) !== (authority.attemptId ?? null)) {
          return { kind: "not_live" };
        }
        const liveCancellation =
          Boolean(run?.cancellationRequestedAt) &&
          (run?.dispatchState === "dispatching" ||
            run?.dispatchState === "running");
        const exactAttemptCleanup =
          Boolean(authority.attemptId) &&
          run?.daytonaAttemptId === authority.attemptId &&
          (run?.dispatchState === "terminal" ||
            ((run?.dispatchState === "dispatching" ||
              run?.dispatchState === "running") &&
              run.daytonaCommandId === null));
        if (!liveCancellation && !exactAttemptCleanup) {
          return { kind: "not_live" };
        }
        const agent = await lockedDispatchAgent(transaction, run);
        if (!agent) {
          return { kind: "not_found" };
        }
        const continuingReset = agent.sandboxLifecycle === "resetting";
        if (
          agent.sandboxLifecycle === "decommissioning" ||
          agent.sandboxLifecycle === "decommission_failed"
        ) {
          return { kind: "stale_version" };
        }
        const [updated] = await transaction.execute(
          statement(
            "begin-daytona-sandbox-reset-for-cancellation",
            {
              agentId: agent.id,
              attemptId: authority.attemptId ?? null,
              continuingReset,
              expectedGeneration: agent.sandboxGeneration,
              expectedVersion: agent.version,
              leaseToken: authority.leaseToken,
              runId: run.id,
              tenant: agent.tenant,
            },
            sql`UPDATE "RunnerAgent"
              SET "sandboxGeneration" = ${
                continuingReset
                  ? sql`"sandboxGeneration"`
                  : sql`"sandboxGeneration" + 1`
              },
                  "sandboxLifecycle" = 'resetting',
                  "sandboxUpdatedAt" = clock_timestamp(),
                  "warmStatus" = 'not_started',
                  "warmUpdatedAt" = clock_timestamp(),
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "id" = ${agent.id}
                AND "tenant" = ${agent.tenant}
                AND "version" = ${agent.version}
                AND "sandboxGeneration" = ${agent.sandboxGeneration}
                AND "sandboxLifecycle" IN (
                  'unprovisioned',
                  'provisioning',
                  'provisioning_ambiguous',
                  'ready',
                  'resetting'
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM "RunnerRun" AS "activeRun"
                  WHERE "activeRun"."agentId" = ${agent.id}
                    AND "activeRun"."id" <> ${run.id}
                    AND "activeRun"."dispatchState" IN ('dispatching', 'running')
                )
                AND EXISTS (
                  SELECT 1
                  FROM "RunnerRun"
                  WHERE "id" = ${run.id}
                    AND "version" = ${authority.expectedVersion}
                    AND "dispatchLeaseToken" = ${authority.leaseToken}
                    AND "dispatchLeaseExpiresAt" > clock_timestamp()
                    AND "daytonaAttemptId" IS NOT DISTINCT FROM ${authority.attemptId ?? null}
                    AND (
                      (
                        "cancellationRequestedAt" IS NOT NULL
                        AND "dispatchState" IN ('dispatching', 'running')
                      )
                      OR (
                        "daytonaAttemptId" = ${authority.attemptId ?? null}
                        AND (
                          "dispatchState" = 'terminal'
                          OR (
                            "dispatchState" IN ('dispatching', 'running')
                            AND "daytonaCommandId" IS NULL
                          )
                        )
                      )
                    )
                )
              RETURNING *`
          )
        );
        return updated
          ? { kind: "resetting", value: asAgent(updated) }
          : { kind: "stale_version" };
      }),

    beginDaytonaSandboxResetForDispatch: (
      _operator: RunnerOperator,
      authority: RunnerDispatchAuthority,
      input: DaytonaSandboxFence
    ): Promise<
      | { kind: "updated"; value: RunnerAgentRecord }
      | { kind: "not_found" | "not_live" | "stale_version" }
    > =>
      database.transaction(async (transaction) => {
        const run = await lockedLiveDispatchRun(transaction, authority, [
          "dispatching",
          "running",
        ]);
        if (!run) {
          return { kind: "not_live" };
        }
        const agent = await lockedDispatchAgent(transaction, run);
        if (!agent) {
          return { kind: "not_found" };
        }
        if (
          agent.id !== input.agentId ||
          agent.version !== input.expectedVersion ||
          agent.sandboxGeneration !== input.expectedGeneration ||
          (agent.sandboxLifecycle !== "provisioning" &&
            agent.sandboxLifecycle !== "provisioning_ambiguous" &&
            agent.sandboxLifecycle !== "ready")
        ) {
          return { kind: "stale_version" };
        }
        const [updated] = await transaction.execute(
          statement(
            "begin-daytona-sandbox-reset-for-dispatch",
            {
              agentId: agent.id,
              expectedGeneration: input.expectedGeneration,
              expectedVersion: input.expectedVersion,
              tenant: agent.tenant,
            },
            sql`UPDATE "RunnerAgent"
              SET "sandboxGeneration" = "sandboxGeneration" + 1,
                  "sandboxLifecycle" = 'resetting',
                  "sandboxUpdatedAt" = clock_timestamp(),
                  "warmStatus" = 'not_started',
                  "warmUpdatedAt" = clock_timestamp(),
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "id" = ${agent.id}
                AND "tenant" = ${agent.tenant}
                AND "version" = ${input.expectedVersion}
                AND "sandboxGeneration" = ${input.expectedGeneration}
                AND "sandboxLifecycle" IN (
                  'provisioning',
                  'provisioning_ambiguous',
                  'ready'
                )
              RETURNING *`
          )
        );
        return updated
          ? { kind: "updated", value: asAgent(updated) }
          : { kind: "stale_version" };
      }),

    beginDaytonaSandboxResetForRecovery: (
      _operator: RunnerOperator,
      input: DaytonaSandboxFence
    ): Promise<
      | { kind: "updated"; value: RunnerAgentRecord }
      | { kind: "not_found" | "stale_version" }
    > =>
      database.transaction(async (transaction) => {
        const [updated] = await transaction.execute(
          statement(
            "begin-daytona-sandbox-reset-for-recovery",
            input,
            sql`UPDATE "RunnerAgent"
              SET "sandboxGeneration" = "sandboxGeneration" + 1,
                  "sandboxLifecycle" = 'resetting',
                  "sandboxUpdatedAt" = clock_timestamp(),
                  "warmStatus" = 'not_started',
                  "warmUpdatedAt" = clock_timestamp(),
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "id" = ${input.agentId}
                AND "version" = ${input.expectedVersion}
                AND "sandboxGeneration" = ${input.expectedGeneration}
                AND "sandboxLifecycle" IN (
                  'provisioning',
                  'provisioning_ambiguous',
                  'ready'
                )
              RETURNING *`
          )
        );
        if (updated) {
          return { kind: "updated", value: asAgent(updated) };
        }
        const [current] = await transaction.execute(
          statement(
            "get-agent-after-daytona-recovery-reset-begin",
            { agentId: input.agentId },
            sql`SELECT "id" FROM "RunnerAgent"
              WHERE "id" = ${input.agentId}
              LIMIT 1`
          )
        );
        return current ? { kind: "stale_version" } : { kind: "not_found" };
      }),

    beginDaytonaSandboxResize: (
      _operator: RunnerOperator,
      input: BeginDaytonaSandboxResizeInput
    ): Promise<
      | { kind: "resizing"; value: RunnerAgentRecord }
      | { kind: "not_found" }
      | { kind: "stale_version" }
    > =>
      database.transaction(async (transaction) => {
        const [current] = await transaction.execute(
          statement(
            "lock-agent-for-daytona-resize",
            input,
            sql`SELECT * FROM "RunnerAgent"
              WHERE "id" = ${input.agentId}
                AND "tenant" = ${input.tenant}
              FOR UPDATE`
          )
        );
        if (!current) {
          return { kind: "not_found" };
        }
        const [updated] = await transaction.execute(
          statement(
            "begin-daytona-sandbox-resize",
            input,
            sql`UPDATE "RunnerAgent"
              SET "sandboxLifecycle" = 'resizing',
                  "sandboxUpdatedAt" = clock_timestamp(),
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "id" = ${input.agentId}
                AND "tenant" = ${input.tenant}
                AND "version" = ${input.expectedVersion}
                AND "sandboxGeneration" = ${input.expectedGeneration}
                AND "daytonaSandboxId" = ${input.sandboxId}
                AND "sandboxLifecycle" = 'ready'
                AND "status" = 'idle'
                AND "warmStatus" <> 'provisioning'
                AND NOT EXISTS (
                  SELECT 1
                  FROM "RunnerRun" AS "liveRun"
                  WHERE "liveRun"."agentId" = ${input.agentId}
                    AND "liveRun"."tenant" = ${input.tenant}
                    AND "liveRun"."status" IN ('queued', 'running')
                )
              RETURNING *`
          )
        );
        return updated
          ? { kind: "resizing", value: asAgent(updated) }
          : { kind: "stale_version" };
      }),

    beginDaytonaSandboxWarm: (
      principal: RunnerPrincipal,
      input: BeginDaytonaSandboxWarmInput
    ): Promise<
      | { kind: "started"; value: RunnerAgentRecord }
      | { kind: "in_progress"; value: RunnerAgentRecord }
      | { kind: "not_found" }
      | { kind: "stale_version" }
    > =>
      database.transaction(async (transaction) => {
        const [current] = await transaction.execute(
          statement(
            "lock-agent-for-daytona-warm",
            { ...input, tenant: principal.tenant },
            sql`SELECT * FROM "RunnerAgent"
              WHERE "id" = ${input.agentId}
                AND "tenant" = ${principal.tenant}
              FOR UPDATE`
          )
        );
        if (!current) {
          return { kind: "not_found" };
        }
        const agent = asAgent(current);
        if (
          agent.sandboxLifecycle === "ready" &&
          agent.warmStatus === "provisioning"
        ) {
          return { kind: "in_progress", value: agent };
        }
        if (
          agent.sandboxGeneration !== input.expectedGeneration ||
          agent.version !== input.expectedVersion ||
          agent.sandboxLifecycle !== "ready"
        ) {
          return { kind: "stale_version" };
        }
        const [updated] = await transaction.execute(
          statement(
            "begin-daytona-sandbox-warm",
            { ...input, tenant: principal.tenant },
            sql`UPDATE "RunnerAgent"
              SET "warmStatus" = 'provisioning',
                  "warmAttemptVersion" = "warmAttemptVersion" + 1,
                  "warmUpdatedAt" = now(),
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${input.agentId}
                AND "tenant" = ${principal.tenant}
                AND "version" = ${input.expectedVersion}
                AND "sandboxGeneration" = ${input.expectedGeneration}
                AND "sandboxLifecycle" = 'ready'
                AND "warmStatus" <> 'provisioning'
                AND NOT EXISTS (
                  SELECT 1
                  FROM "RunnerRun" AS "activeRun"
                  WHERE "activeRun"."agentId" = ${input.agentId}
                    AND "activeRun"."tenant" = ${principal.tenant}
                    AND "activeRun"."dispatchState" IN ('dispatching', 'running')
                )
              RETURNING *`
          )
        );
        return updated
          ? { kind: "started", value: asAgent(updated) }
          : { kind: "stale_version" };
      }),

    /**
     * Takes an expired, command-free attempt before any provider cleanup.
     * The replacement lease is the cross-process cleanup mutex; a second
     * reconciler cannot delete the same deterministic session concurrently.
     */
    claimExpiredDaytonaAttemptCleanup: (
      _operator: RunnerOperator,
      input: ClaimExpiredDaytonaAttemptCleanupInput
    ): Promise<ExpiredDaytonaAttemptCleanupClaim> =>
      database.transaction(async (transaction) => {
        const run = await lockedOperatorRun(
          transaction,
          _operator,
          input.runId
        );
        if (!run) {
          return { kind: "not_found" };
        }
        if (run.dispatchLeaseToken !== input.oldLeaseToken) {
          return { kind: "lease_lost" };
        }
        if (
          !isExpectedLiveDispatch(run, input.expectedDispatchState) ||
          run.daytonaAttemptId !== input.attemptId ||
          run.daytonaCommandId
        ) {
          return { kind: "not_live" };
        }
        const [expired] = await transaction.execute(
          statement(
            "confirm-expired-daytona-attempt-cleanup",
            input,
            sql`SELECT "id" FROM "RunnerRun"
              WHERE "id" = ${input.runId}
                AND "dispatchLeaseToken" = ${input.oldLeaseToken}
                AND "dispatchLeaseExpiresAt" <= clock_timestamp()
                AND "dispatchState" = ${input.expectedDispatchState}
                AND "daytonaAttemptId" = ${input.attemptId}
                AND "daytonaCommandId" IS NULL`
          )
        );
        if (!expired) {
          return { kind: "not_expired" };
        }
        const sessionId = daytonaRunSessionName(input.runId, input.attemptId);
        if (
          run.daytonaSessionId !== null &&
          run.daytonaSessionId !== sessionId
        ) {
          return { kind: "not_live" };
        }
        const [updated] = await transaction.execute(
          statement(
            "claim-expired-daytona-attempt-cleanup",
            input,
            sql`UPDATE "RunnerRun"
              SET "dispatchLeaseToken" = ${input.newLeaseToken},
                  "dispatchLeaseExpiresAt" = ${timestampParameter(input.leaseExpiresAt)},
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "id" = ${input.runId}
                AND "dispatchLeaseToken" = ${input.oldLeaseToken}
                AND "dispatchLeaseExpiresAt" <= clock_timestamp()
                AND "dispatchState" = ${input.expectedDispatchState}
                AND "daytonaAttemptId" = ${input.attemptId}
                AND "daytonaCommandId" IS NULL
                AND (
                  "daytonaSessionId" IS NULL
                  OR "daytonaSessionId" = ${sessionId}
                )
              RETURNING *`
          )
        );
        if (!updated) {
          return { kind: "not_expired" };
        }
        const value = asRun(updated);
        return {
          authority: {
            ...dispatchAuthority(value),
            attemptId: input.attemptId,
          } as RunnerDispatchAuthority,
          kind: "claimed",
          run: value,
        };
      }),

    claimNextDispatch: (_operator: RunnerOperator, input: DispatchClaimInput) =>
      database.transaction(async (transaction) => {
        const limits = admissionLimits(input.limits);
        const scheduler = await lockRunnerScheduler(transaction);
        if (
          (await activeDispatchCount(transaction)) >=
          limits.deploymentActiveRuns
        ) {
          return null;
        }
        const candidate = await selectEligibleDispatch(
          transaction,
          scheduler,
          limits
        );
        if (!candidate) {
          return null;
        }
        const claimed = await claimLockedDispatch(
          transaction,
          candidate,
          input
        );
        if (!claimed) {
          return null;
        }
        await advanceRunnerScheduler(transaction, scheduler, claimed.tenant);
        return {
          authority: dispatchAuthority(claimed),
          run: claimed,
        } satisfies RunnerClaimedDispatch;
      }),

    claimQueuedDispatchForRevalidation: (
      _operator: RunnerOperator,
      input: RevalidationDispatchClaimInput
    ) =>
      database.transaction(async (transaction) => {
        const candidate = await selectQueuedDispatchForRevalidation(
          transaction,
          input.excludedRunIds ?? []
        );
        if (!candidate) {
          return null;
        }
        const claimed = await claimLockedDispatch(transaction, candidate, {
          ...input,
          authorityRevalidation: true,
        });
        return claimed
          ? {
              authority: dispatchAuthority(claimed),
              run: claimed,
            }
          : null;
      }),

    /**
     * Terminal rows retain their attempt until the provider session and staged
     * credential are gone. An expired terminal lease can be safely claimed by
     * one reconciler to retry that exact cleanup.
     */
    claimTerminalDaytonaAttemptCleanup: (
      _operator: RunnerOperator,
      input: ClaimTerminalDaytonaAttemptCleanupInput
    ): Promise<TerminalDaytonaAttemptCleanupClaim> =>
      database.transaction(async (transaction) => {
        const run = await lockedOperatorRun(
          transaction,
          _operator,
          input.runId
        );
        if (!run) {
          return { kind: "not_found" };
        }
        if (
          run.version !== input.expectedVersion ||
          run.dispatchLeaseToken !== input.oldLeaseToken
        ) {
          return { kind: "lease_lost" };
        }
        if (
          run.dispatchState !== "terminal" ||
          run.daytonaAttemptId !== input.attemptId
        ) {
          return { kind: "not_live" };
        }
        const sessionId = daytonaRunSessionName(run.id, input.attemptId);
        if (
          (run.daytonaSessionId !== null &&
            run.daytonaSessionId !== sessionId) ||
          (run.daytonaCommandId !== null && run.daytonaSessionId !== sessionId)
        ) {
          return { kind: "not_live" };
        }
        const [expired] = await transaction.execute(
          statement(
            "confirm-expired-terminal-daytona-attempt-cleanup",
            input,
            sql`SELECT "id" FROM "RunnerRun"
              WHERE "id" = ${run.id}
                AND "version" = ${input.expectedVersion}
                AND "dispatchLeaseToken" = ${input.oldLeaseToken}
                AND "dispatchLeaseExpiresAt" <= clock_timestamp()
                AND "dispatchState" = 'terminal'
                AND "daytonaAttemptId" = ${input.attemptId}`
          )
        );
        if (!expired) {
          return { kind: "not_expired" };
        }
        const [updated] = await transaction.execute(
          statement(
            "claim-terminal-daytona-attempt-cleanup",
            input,
            sql`UPDATE "RunnerRun"
              SET "dispatchLeaseToken" = ${input.newLeaseToken},
                  "dispatchLeaseExpiresAt" = ${timestampParameter(input.leaseExpiresAt)},
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "id" = ${run.id}
                AND "version" = ${input.expectedVersion}
                AND "dispatchLeaseToken" = ${input.oldLeaseToken}
                AND "dispatchLeaseExpiresAt" <= clock_timestamp()
                AND "dispatchState" = 'terminal'
                AND "daytonaAttemptId" = ${input.attemptId}
              RETURNING *`
          )
        );
        if (!updated) {
          return { kind: "not_expired" };
        }
        const value = asRun(updated);
        return {
          authority: {
            ...dispatchAuthority(value),
            attemptId: input.attemptId,
          } as RunnerDispatchAuthority,
          kind: "claimed",
          run: value,
        };
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
        if (
          run.daytonaAttemptId !== null ||
          run.daytonaCommandId !== null ||
          run.daytonaSessionId !== null
        ) {
          return { kind: "not_live" };
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
                AND "daytonaAttemptId" IS NULL
                AND "daytonaCommandId" IS NULL
                AND "daytonaSessionId" IS NULL
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
              "id", "tenant", "name", "description", "familiarId", "instructions",
              "model", "runtime", "workspace"
            ) VALUES (
              ${input.id}, ${principal.tenant}, ${input.name}, ${input.description ?? ""},
              ${input.familiarId}, ${input.instructions}, ${input.model},
              ${input.runtime}, ${input.workspace ?? null}
            ) ON CONFLICT DO NOTHING
              RETURNING *`
          )
        );
        return agent
          ? { agent: asAgent(agent), kind: "created" as const }
          : { kind: "conflict" as const };
      }),

    deferDaytonaSandboxResize: (
      _operator: RunnerOperator,
      input: BeginDaytonaSandboxResizeInput
    ): Promise<
      | { kind: "updated"; value: RunnerAgentRecord }
      | { kind: "not_found" }
      | { kind: "stale_version" }
    > =>
      database.transaction(async (transaction) => {
        const [updated] = await transaction.execute(
          statement(
            "defer-daytona-sandbox-resize",
            input,
            sql`UPDATE "RunnerAgent"
              SET "sandboxUpdatedAt" = clock_timestamp(),
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "id" = ${input.agentId}
                AND "tenant" = ${input.tenant}
                AND "version" = ${input.expectedVersion}
                AND "sandboxGeneration" = ${input.expectedGeneration}
                AND "daytonaSandboxId" = ${input.sandboxId}
                AND "sandboxLifecycle" = 'resizing'
              RETURNING *`
          )
        );
        if (updated) {
          return { kind: "updated", value: asAgent(updated) };
        }
        const [current] = await transaction.execute(
          statement(
            "find-agent-after-deferred-daytona-resize",
            { agentId: input.agentId, tenant: input.tenant },
            sql`SELECT "id" FROM "RunnerAgent"
              WHERE "id" = ${input.agentId}
                AND "tenant" = ${input.tenant}
              LIMIT 1`
          )
        );
        return current ? { kind: "stale_version" } : { kind: "not_found" };
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
            sql`SELECT "id", "daytonaSandboxId", "sandboxLifecycle" FROM "RunnerAgent"
              WHERE "id" = ${agentId}
                AND "tenant" = ${principal.tenant}
              FOR UPDATE`
          )
        );
        if (!agent) {
          return { kind: "not_found" };
        }
        if (
          agent.daytonaSandboxId ||
          (agent.sandboxLifecycle !== undefined &&
            agent.sandboxLifecycle !== "unprovisioned")
        ) {
          return { kind: "busy" };
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
                AND "daytonaSandboxId" IS NULL
                AND "sandboxLifecycle" = 'unprovisioned'
              RETURNING "id"`
          )
        );
        if (!deleted) {
          throw new Error("Locked Runner agent disappeared before deletion.");
        }
        return { kind: "deleted" };
      }),

    deleteAttemptRedaction: (
      operator: RunnerOperator,
      authority: RunnerDispatchAuthority
    ): Promise<
      | { kind: "deleted" }
      | {
          kind: "lease_lost" | "not_found" | "not_live" | "stale_version";
        }
    > =>
      database.transaction(async (transaction) => {
        const run = await lockedOperatorRun(
          transaction,
          operator,
          authority.runId
        );
        if (!run) {
          return { kind: "not_found" };
        }
        const rejected = fenceOutcome(run, authority);
        if (rejected) {
          return rejected;
        }
        if (
          !authority.attemptId ||
          run.daytonaAttemptId !== authority.attemptId
        ) {
          return { kind: "not_live" };
        }
        await transaction.execute(
          statement(
            "delete-runner-attempt-redaction",
            { attemptId: authority.attemptId, runId: run.id },
            sql`DELETE FROM "RunnerAttemptRedaction"
              WHERE "runId" = ${run.id}
                AND "attemptId" = ${authority.attemptId}`
          )
        );
        return { kind: "deleted" };
      }),

    deleteDecommissionedAgent: (
      principal: RunnerPrincipal,
      input: DaytonaSandboxFence
    ): Promise<
      { kind: "deleted" } | { kind: "not_found" } | { kind: "stale_version" }
    > =>
      database.transaction(async (transaction) => {
        const [deleted] = await transaction.execute(
          statement(
            "delete-decommissioned-agent",
            { ...input, tenant: principal.tenant },
            sql`DELETE FROM "RunnerAgent"
              WHERE "id" = ${input.agentId}
                AND "tenant" = ${principal.tenant}
                AND "version" = ${input.expectedVersion}
                AND "sandboxGeneration" = ${input.expectedGeneration}
                AND "sandboxLifecycle" = 'decommissioning'
              RETURNING "id"`
          )
        );
        if (deleted) {
          return { kind: "deleted" };
        }
        const [current] = await transaction.execute(
          statement(
            "get-agent-after-daytona-decommission-delete",
            { agentId: input.agentId, tenant: principal.tenant },
            sql`SELECT "id" FROM "RunnerAgent"
              WHERE "id" = ${input.agentId}
                AND "tenant" = ${principal.tenant}
              LIMIT 1`
          )
        );
        return current ? { kind: "stale_version" } : { kind: "not_found" };
      }),

    deleteDecommissionedAgentForRecovery: (
      _operator: RunnerOperator,
      input: DaytonaSandboxFence
    ): Promise<
      { kind: "deleted" } | { kind: "not_found" } | { kind: "stale_version" }
    > =>
      database.transaction(async (transaction) => {
        const [deleted] = await transaction.execute(
          statement(
            "delete-decommissioned-agent-for-recovery",
            input,
            sql`DELETE FROM "RunnerAgent"
              WHERE "id" = ${input.agentId}
                AND "version" = ${input.expectedVersion}
                AND "sandboxGeneration" = ${input.expectedGeneration}
                AND "sandboxLifecycle" = 'decommissioning'
              RETURNING "id"`
          )
        );
        if (deleted) {
          return { kind: "deleted" };
        }
        const [current] = await transaction.execute(
          statement(
            "get-agent-after-daytona-recovery-decommission",
            { agentId: input.agentId },
            sql`SELECT "id" FROM "RunnerAgent"
              WHERE "id" = ${input.agentId}
              LIMIT 1`
          )
        );
        return current ? { kind: "stale_version" } : { kind: "not_found" };
      }),

    failDaytonaSandboxDecommission: (
      principal: RunnerPrincipal,
      input: DaytonaSandboxFence
    ): Promise<
      | { kind: "updated"; value: RunnerAgentRecord }
      | { kind: "not_found" }
      | { kind: "stale_version" }
    > =>
      database.transaction(async (transaction) => {
        const [updated] = await transaction.execute(
          statement(
            "fail-daytona-sandbox-decommission",
            { ...input, tenant: principal.tenant },
            sql`UPDATE "RunnerAgent"
              SET "sandboxLifecycle" = 'decommission_failed',
                  "status" = 'error',
                  "warmStatus" = 'failed',
                  "warmUpdatedAt" = now(),
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${input.agentId}
                AND "tenant" = ${principal.tenant}
                AND "version" = ${input.expectedVersion}
                AND "sandboxGeneration" = ${input.expectedGeneration}
                AND "sandboxLifecycle" = 'decommissioning'
              RETURNING *`
          )
        );
        if (updated) {
          return { kind: "updated", value: asAgent(updated) };
        }
        const [current] = await transaction.execute(
          statement(
            "get-agent-after-daytona-decommission-failure",
            { agentId: input.agentId, tenant: principal.tenant },
            sql`SELECT "id" FROM "RunnerAgent"
              WHERE "id" = ${input.agentId}
                AND "tenant" = ${principal.tenant}
              LIMIT 1`
          )
        );
        return current ? { kind: "stale_version" } : { kind: "not_found" };
      }),

    failDaytonaSandboxReservation: (
      principal: RunnerPrincipal,
      input: DaytonaSandboxFence
    ): Promise<
      | { kind: "updated"; value: RunnerAgentRecord }
      | { kind: "not_found" }
      | { kind: "stale_version" }
    > =>
      database.transaction(async (transaction) => {
        const [updated] = await transaction.execute(
          statement(
            "fail-daytona-sandbox-reservation",
            { ...input, tenant: principal.tenant },
            sql`UPDATE "RunnerAgent"
              SET "sandboxLifecycle" = 'unprovisioned',
                  "sandboxUpdatedAt" = now(),
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${input.agentId}
                AND "tenant" = ${principal.tenant}
                AND "version" = ${input.expectedVersion}
                AND "sandboxGeneration" = ${input.expectedGeneration}
                AND "sandboxLifecycle" IN ('provisioning', 'provisioning_ambiguous')
              RETURNING *`
          )
        );
        if (updated) {
          return { kind: "updated", value: asAgent(updated) };
        }
        const [current] = await transaction.execute(
          statement(
            "get-agent-after-daytona-sandbox-reservation-failure",
            { agentId: input.agentId, tenant: principal.tenant },
            sql`SELECT "id" FROM "RunnerAgent"
              WHERE "id" = ${input.agentId}
                AND "tenant" = ${principal.tenant}
              LIMIT 1`
          )
        );
        return current ? { kind: "stale_version" } : { kind: "not_found" };
      }),

    failDaytonaSandboxReservationForDispatch: (
      _operator: RunnerOperator,
      authority: RunnerDispatchAuthority,
      input: DispatchSandboxFence
    ): Promise<
      | { kind: "updated"; value: RunnerAgentRecord }
      | { kind: "not_found" }
      | { kind: "not_live" }
      | { kind: "stale_version" }
    > =>
      database.transaction(async (transaction) => {
        const run = await lockedLiveDispatchRun(transaction, authority, [
          "dispatching",
          "running",
        ]);
        if (!run) {
          return { kind: "not_live" };
        }
        const agent = await lockedDispatchAgent(transaction, run);
        if (!agent) {
          return { kind: "not_found" };
        }
        const [updated] = await transaction.execute(
          statement(
            "fail-daytona-sandbox-reservation-for-dispatch",
            {
              agentId: run.agentId,
              expectedGeneration: input.expectedGeneration,
              expectedVersion: input.expectedVersion,
              tenant: run.tenant,
            },
            sql`UPDATE "RunnerAgent"
              SET "sandboxLifecycle" = 'unprovisioned',
                  "sandboxUpdatedAt" = now(),
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${run.agentId}
                AND "tenant" = ${run.tenant}
                AND "version" = ${input.expectedVersion}
                AND "sandboxGeneration" = ${input.expectedGeneration}
                AND "sandboxLifecycle" IN ('provisioning', 'provisioning_ambiguous')
              RETURNING *`
          )
        );
        return updated
          ? { kind: "updated", value: asAgent(updated) }
          : { kind: "stale_version" };
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
                  "completedAt" = ${timestampParameter(input.completedAt)},
                  "dispatchState" = 'terminal',
                  "authorityRevalidation" = false,
                  "error" = CAST(${input.error ? JSON.stringify(input.error) : null} AS jsonb),
                  "fileEvidence" = CAST(${JSON.stringify(input.fileEvidence)} AS jsonb),
                  "logCursor" = ${eventId},
                  "output" = ${input.output},
                  "status" = ${input.status},
                  "updatedAt" = ${timestampParameter(input.completedAt)},
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
        await transaction.execute(
          statement(
            "finalize-agent-status",
            {
              agentId: finalized.agentId,
              completedAt: input.completedAt,
              status: input.status,
              tenant: finalized.tenant,
            },
            sql`UPDATE "RunnerAgent"
              SET "status" = CASE
                    WHEN EXISTS (
                      SELECT 1
                      FROM "RunnerRun" AS "otherActive"
                      WHERE "otherActive"."agentId" = ${finalized.agentId}
                        AND "otherActive"."tenant" = ${finalized.tenant}
                        AND "otherActive"."id" <> ${finalized.id}
                        AND "otherActive"."authorityRevalidation" = false
                        AND (
                          "otherActive"."dispatchState" IN ('dispatching', 'running')
                          OR (
                            "otherActive"."dispatchState" = 'terminal'
                            AND (
                              "otherActive"."daytonaAttemptId" IS NOT NULL
                              OR "otherActive"."daytonaCommandId" IS NOT NULL
                              OR "otherActive"."daytonaSessionId" IS NOT NULL
                            )
                          )
                        )
                    ) THEN 'running'
                    WHEN ${input.status} = 'failed' THEN 'error'
                    ELSE 'idle'
                  END,
                  "lastRunAt" = ${timestampParameter(input.completedAt)},
                  "updatedAt" = ${timestampParameter(input.completedAt)},
                  "version" = "version" + 1
              WHERE "id" = ${finalized.agentId}
                AND "tenant" = ${finalized.tenant}`
          )
        );
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
        await pruneRunEventsInTransaction(
          transaction,
          "prune-run-events-after-finalize",
          input.runId,
          finalized.tenant
        );
        const prunedRunIds = await pruneTerminalRunsInTransaction(
          transaction,
          finalized.tenant,
          finalized.agentId
        );
        return { kind: "finalized", prunedRunIds, run: finalized };
      }),

    finishDaytonaSandboxReset: (
      principal: RunnerPrincipal,
      input: DaytonaSandboxFence
    ): Promise<
      | { kind: "updated"; value: RunnerAgentRecord }
      | { kind: "not_found" | "stale_version" }
    > =>
      database.transaction(async (transaction) => {
        const [updated] = await transaction.execute(
          statement(
            "finish-daytona-sandbox-reset",
            { ...input, tenant: principal.tenant },
            sql`UPDATE "RunnerAgent"
              SET "daytonaSandboxId" = NULL,
                  "sandboxLifecycle" = 'unprovisioned',
                  "sandboxTrust" = 'clean',
                  "sandboxUpdatedAt" = clock_timestamp(),
                  "warmStatus" = 'not_started',
                  "warmUpdatedAt" = clock_timestamp(),
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "id" = ${input.agentId}
                AND "tenant" = ${principal.tenant}
                AND "version" = ${input.expectedVersion}
                AND "sandboxGeneration" = ${input.expectedGeneration}
                AND "sandboxLifecycle" = 'resetting'
              RETURNING *`
          )
        );
        if (updated) {
          return { kind: "updated", value: asAgent(updated) };
        }
        const [current] = await transaction.execute(
          statement(
            "get-agent-after-daytona-reset-finish",
            { agentId: input.agentId, tenant: principal.tenant },
            sql`SELECT "id" FROM "RunnerAgent"
              WHERE "id" = ${input.agentId}
                AND "tenant" = ${principal.tenant}
              LIMIT 1`
          )
        );
        return current ? { kind: "stale_version" } : { kind: "not_found" };
      }),

    finishDaytonaSandboxResetForDispatch: (
      _operator: RunnerOperator,
      authority: RunnerDispatchAuthority,
      input: DaytonaSandboxFence
    ): Promise<
      | { kind: "updated"; value: RunnerAgentRecord }
      | { kind: "not_found" | "not_live" | "stale_version" }
    > =>
      database.transaction(async (transaction) => {
        const run = await lockedLiveDispatchRun(transaction, authority, [
          "dispatching",
          "running",
        ]);
        if (!run) {
          return { kind: "not_live" };
        }
        const agent = await lockedDispatchAgent(transaction, run);
        if (!agent) {
          return { kind: "not_found" };
        }
        if (
          agent.id !== input.agentId ||
          agent.version !== input.expectedVersion ||
          agent.sandboxGeneration !== input.expectedGeneration ||
          agent.sandboxLifecycle !== "resetting"
        ) {
          return { kind: "stale_version" };
        }
        const [updated] = await transaction.execute(
          statement(
            "finish-daytona-sandbox-reset-for-dispatch",
            {
              agentId: agent.id,
              expectedGeneration: input.expectedGeneration,
              expectedVersion: input.expectedVersion,
              tenant: agent.tenant,
            },
            sql`UPDATE "RunnerAgent"
              SET "daytonaSandboxId" = NULL,
                  "sandboxLifecycle" = 'unprovisioned',
                  "sandboxTrust" = 'clean',
                  "sandboxUpdatedAt" = clock_timestamp(),
                  "warmStatus" = 'not_started',
                  "warmUpdatedAt" = clock_timestamp(),
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "id" = ${agent.id}
                AND "tenant" = ${agent.tenant}
                AND "version" = ${input.expectedVersion}
                AND "sandboxGeneration" = ${input.expectedGeneration}
                AND "sandboxLifecycle" = 'resetting'
              RETURNING *`
          )
        );
        return updated
          ? { kind: "updated", value: asAgent(updated) }
          : { kind: "stale_version" };
      }),

    finishDaytonaSandboxResetForRecovery: (
      _operator: RunnerOperator,
      input: DaytonaSandboxFence
    ): Promise<
      | { kind: "updated"; value: RunnerAgentRecord }
      | { kind: "not_found" }
      | { kind: "stale_version" }
    > =>
      database.transaction(async (transaction) => {
        const [updated] = await transaction.execute(
          statement(
            "finish-daytona-sandbox-reset-for-recovery",
            input,
            sql`UPDATE "RunnerAgent"
              SET "daytonaSandboxId" = NULL,
                  "sandboxLifecycle" = 'unprovisioned',
                  "sandboxTrust" = 'clean',
                  "sandboxUpdatedAt" = clock_timestamp(),
                  "warmStatus" = 'not_started',
                  "warmUpdatedAt" = clock_timestamp(),
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "id" = ${input.agentId}
                AND "version" = ${input.expectedVersion}
                AND "sandboxGeneration" = ${input.expectedGeneration}
                AND "sandboxLifecycle" = 'resetting'
              RETURNING *`
          )
        );
        if (updated) {
          return { kind: "updated", value: asAgent(updated) };
        }
        const [current] = await transaction.execute(
          statement(
            "get-agent-after-daytona-reset-recovery",
            { agentId: input.agentId },
            sql`SELECT "id" FROM "RunnerAgent"
              WHERE "id" = ${input.agentId}
              LIMIT 1`
          )
        );
        return current ? { kind: "stale_version" } : { kind: "not_found" };
      }),

    finishDaytonaSandboxResize: (
      _operator: RunnerOperator,
      input: BeginDaytonaSandboxResizeInput
    ): Promise<
      | { kind: "updated"; value: RunnerAgentRecord }
      | { kind: "not_found" }
      | { kind: "stale_version" }
    > =>
      database.transaction(async (transaction) => {
        const [updated] = await transaction.execute(
          statement(
            "finish-daytona-sandbox-resize",
            input,
            sql`UPDATE "RunnerAgent"
              SET "sandboxLifecycle" = 'ready',
                  "sandboxUpdatedAt" = clock_timestamp(),
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "id" = ${input.agentId}
                AND "tenant" = ${input.tenant}
                AND "version" = ${input.expectedVersion}
                AND "sandboxGeneration" = ${input.expectedGeneration}
                AND "daytonaSandboxId" = ${input.sandboxId}
                AND "sandboxLifecycle" = 'resizing'
              RETURNING *`
          )
        );
        if (updated) {
          return { kind: "updated", value: asAgent(updated) };
        }
        const [current] = await transaction.execute(
          statement(
            "find-agent-after-daytona-resize",
            { agentId: input.agentId, tenant: input.tenant },
            sql`SELECT "id" FROM "RunnerAgent"
              WHERE "id" = ${input.agentId}
                AND "tenant" = ${input.tenant}
              LIMIT 1`
          )
        );
        return current ? { kind: "stale_version" } : { kind: "not_found" };
      }),

    finishDaytonaSandboxWarm: (
      principal: RunnerPrincipal,
      input: DaytonaSandboxFence & { status: "failed" | "ready" }
    ): Promise<
      | { kind: "updated"; value: RunnerAgentRecord }
      | { kind: "not_found" }
      | { kind: "stale_version" }
    > =>
      database.transaction(async (transaction) => {
        const [updated] = await transaction.execute(
          statement(
            "finish-daytona-sandbox-warm",
            { ...input, tenant: principal.tenant },
            sql`UPDATE "RunnerAgent"
              SET "warmStatus" = ${input.status},
                  "warmUpdatedAt" = now(),
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${input.agentId}
                AND "tenant" = ${principal.tenant}
                AND "version" = ${input.expectedVersion}
                AND "sandboxGeneration" = ${input.expectedGeneration}
                AND "sandboxLifecycle" = 'ready'
                AND "warmStatus" = 'provisioning'
              RETURNING *`
          )
        );
        if (updated) {
          return { kind: "updated", value: asAgent(updated) };
        }
        const [current] = await transaction.execute(
          statement(
            "get-agent-after-daytona-warm",
            { agentId: input.agentId, tenant: principal.tenant },
            sql`SELECT "id" FROM "RunnerAgent"
              WHERE "id" = ${input.agentId}
                AND "tenant" = ${principal.tenant}
              LIMIT 1`
          )
        );
        return current ? { kind: "stale_version" } : { kind: "not_found" };
      }),

    finishDaytonaSandboxWarmForRecovery: (
      _operator: RunnerOperator,
      input: DaytonaSandboxFence
    ): Promise<
      | { kind: "updated"; value: RunnerAgentRecord }
      | { kind: "not_found" }
      | { kind: "stale_version" }
    > =>
      database.transaction(async (transaction) => {
        const [updated] = await transaction.execute(
          statement(
            "finish-daytona-sandbox-warm-for-recovery",
            input,
            sql`UPDATE "RunnerAgent"
              SET "warmStatus" = 'failed',
                  "warmUpdatedAt" = now(),
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${input.agentId}
                AND "version" = ${input.expectedVersion}
                AND "sandboxGeneration" = ${input.expectedGeneration}
                AND "sandboxLifecycle" = 'ready'
                AND "warmStatus" = 'provisioning'
              RETURNING *`
          )
        );
        if (updated) {
          return { kind: "updated", value: asAgent(updated) };
        }
        const [current] = await transaction.execute(
          statement(
            "get-agent-after-daytona-warm-recovery",
            { agentId: input.agentId },
            sql`SELECT "id" FROM "RunnerAgent"
              WHERE "id" = ${input.agentId}
              LIMIT 1`
          )
        );
        return current ? { kind: "stale_version" } : { kind: "not_found" };
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

    getDispatchAgent: (
      _operator: RunnerOperator,
      authority: RunnerDispatchAuthority
    ): Promise<
      | { agent: RunnerAgentRecord; kind: "found"; run: RunnerRunRecord }
      | { kind: "not_found" }
      | { kind: "not_live" }
    > =>
      database.transaction(async (transaction) => {
        const run = await lockedLiveDispatchRun(transaction, authority, [
          "dispatching",
          "running",
        ]);
        if (!run) {
          return { kind: "not_live" };
        }
        const agent = await lockedDispatchAgent(transaction, run);
        return agent ? { agent, kind: "found", run } : { kind: "not_found" };
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

    markDaytonaSandboxReservationAmbiguous: (
      principal: RunnerPrincipal,
      input: DaytonaSandboxFence
    ): Promise<
      | { kind: "updated"; value: RunnerAgentRecord }
      | { kind: "not_found" }
      | { kind: "stale_version" }
    > =>
      database.transaction(async (transaction) => {
        const [updated] = await transaction.execute(
          statement(
            "mark-daytona-sandbox-reservation-ambiguous",
            { ...input, tenant: principal.tenant },
            sql`UPDATE "RunnerAgent"
              SET "sandboxLifecycle" = 'provisioning_ambiguous',
                  "sandboxUpdatedAt" = now(),
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${input.agentId}
                AND "tenant" = ${principal.tenant}
                AND "version" = ${input.expectedVersion}
                AND "sandboxGeneration" = ${input.expectedGeneration}
                AND "sandboxLifecycle" = 'provisioning'
              RETURNING *`
          )
        );
        if (updated) {
          return { kind: "updated", value: asAgent(updated) };
        }
        const [current] = await transaction.execute(
          statement(
            "get-agent-after-daytona-sandbox-ambiguity",
            { agentId: input.agentId, tenant: principal.tenant },
            sql`SELECT "id" FROM "RunnerAgent"
              WHERE "id" = ${input.agentId}
                AND "tenant" = ${principal.tenant}
              LIMIT 1`
          )
        );
        return current ? { kind: "stale_version" } : { kind: "not_found" };
      }),

    markDaytonaSandboxReservationAmbiguousForDispatch: (
      _operator: RunnerOperator,
      authority: RunnerDispatchAuthority,
      input: DispatchSandboxFence
    ): Promise<
      | { kind: "updated"; value: RunnerAgentRecord }
      | { kind: "not_found" }
      | { kind: "not_live" }
      | { kind: "stale_version" }
    > =>
      database.transaction(async (transaction) => {
        const run = await lockedLiveDispatchRun(transaction, authority, [
          "dispatching",
          "running",
        ]);
        if (!run) {
          return { kind: "not_live" };
        }
        const agent = await lockedDispatchAgent(transaction, run);
        if (!agent) {
          return { kind: "not_found" };
        }
        const [updated] = await transaction.execute(
          statement(
            "mark-daytona-sandbox-reservation-ambiguous-for-dispatch",
            {
              agentId: run.agentId,
              expectedGeneration: input.expectedGeneration,
              expectedVersion: input.expectedVersion,
              tenant: run.tenant,
            },
            sql`UPDATE "RunnerAgent"
              SET "sandboxLifecycle" = 'provisioning_ambiguous',
                  "sandboxUpdatedAt" = now(),
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${run.agentId}
                AND "tenant" = ${run.tenant}
                AND "version" = ${input.expectedVersion}
                AND "sandboxGeneration" = ${input.expectedGeneration}
                AND "sandboxLifecycle" IN ('provisioning', 'provisioning_ambiguous')
              RETURNING *`
          )
        );
        return updated
          ? { kind: "updated", value: asAgent(updated) }
          : { kind: "stale_version" };
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

    /**
     * `entitlementMinutes` is stamped in the same statement that sets
     * `startedAt`, because the two are only meaningful together: the run's
     * deadline is `startedAt + entitlementMinutes`, and a row carrying one
     * without the other cannot be bounded.
     *
     * Optional because the reconciler also drives this transition when
     * admission launched a run and died before marking it running. It has no
     * credential context to supply, so those runs keep a null and fall back to
     * the process-wide limit -- which is exactly what bounded every run before
     * this column existed. Billing is unaffected either way: settlement clamps
     * the charge to the minutes the reservation actually held.
     */
    markDispatchRunningForDispatch: (
      _operator: RunnerOperator,
      authority: RunnerDispatchAuthority,
      entitlementMinutes?: number
    ): Promise<
      | {
          authority: RunnerDispatchAuthority;
          kind: "updated";
          value: RunnerRunRecord;
        }
      | { kind: "not_live" }
    > =>
      database.transaction(async (transaction) => {
        const run = await lockedLiveDispatchRun(transaction, authority, [
          "dispatching",
        ]);
        if (!run) {
          return { kind: "not_live" };
        }
        const [updated] = await transaction.execute(
          statement(
            "mark-dispatch-running-for-dispatch",
            {
              entitlementMinutes: entitlementMinutes ?? null,
              expectedVersion: authority.expectedVersion,
              leaseToken: authority.leaseToken,
              runId: run.id,
            },
            sql`UPDATE "RunnerRun"
              SET "dispatchState" = 'running',
                  "status" = 'running',
                  "startedAt" = clock_timestamp(),
                  "entitlementMinutes" = COALESCE(
                    ${entitlementMinutes ?? null},
                    "entitlementMinutes"
                  ),
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "id" = ${run.id}
                AND "version" = ${authority.expectedVersion}
                AND "dispatchLeaseToken" = ${authority.leaseToken}
                AND "dispatchLeaseExpiresAt" > clock_timestamp()
                AND "dispatchState" = 'dispatching'
                AND "status" = 'queued'
              RETURNING *`
          )
        );
        if (!updated) {
          return { kind: "not_live" };
        }
        const value = asRun(updated);
        await transaction.execute(
          statement(
            "mark-agent-running-for-dispatch",
            { agentId: value.agentId, tenant: value.tenant },
            sql`UPDATE "RunnerAgent"
              SET "status" = 'running',
                  "lastRunAt" = clock_timestamp(),
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "id" = ${value.agentId}
                AND "tenant" = ${value.tenant}`
          )
        );
        return { authority: dispatchAuthority(value), kind: "updated", value };
      }),

    persistAttemptRedaction: (
      _operator: RunnerOperator,
      authority: RunnerDispatchAuthority,
      input: PersistRunnerAttemptRedactionInput
    ): Promise<{ kind: "persisted" } | { kind: "not_live" }> =>
      database.transaction(async (transaction) => {
        const run = await lockedLiveDispatchRun(transaction, authority, [
          "dispatching",
        ]);
        if (
          !run ||
          authority.attemptId !== input.attemptId ||
          run.daytonaAttemptId !== input.attemptId
        ) {
          return { kind: "not_live" };
        }
        const [persisted] = await transaction.execute(
          statement(
            "persist-runner-attempt-redaction",
            {
              aadVersion: input.aadVersion,
              attemptId: input.attemptId,
              ciphertext: input.ciphertext,
              iv: input.iv,
              kekVersion: input.kekVersion,
              runId: run.id,
              wrappedKey: input.wrappedKey,
            },
            sql`INSERT INTO "RunnerAttemptRedaction" (
                "runId",
                "attemptId",
                "aadVersion",
                "ciphertext",
                "iv",
                "kekVersion",
                "wrappedKey"
              ) VALUES (
                ${run.id},
                ${input.attemptId},
                ${input.aadVersion},
                ${input.ciphertext},
                ${input.iv},
                ${input.kekVersion},
                ${input.wrappedKey}
              )
              ON CONFLICT ("runId") DO UPDATE
                SET "aadVersion" = EXCLUDED."aadVersion",
                    "ciphertext" = EXCLUDED."ciphertext",
                    "iv" = EXCLUDED."iv",
                    "kekVersion" = EXCLUDED."kekVersion",
                    "wrappedKey" = EXCLUDED."wrappedKey"
                WHERE "RunnerAttemptRedaction"."attemptId" = EXCLUDED."attemptId"
              RETURNING "runId"`
          )
        );
        return persisted ? { kind: "persisted" } : { kind: "not_live" };
      }),

    pruneTerminalRuns: (principal: RunnerPrincipal, agentId: string) =>
      database.transaction((transaction) =>
        pruneTerminalRunsInTransaction(transaction, principal.tenant, agentId)
      ),

    readAttemptRedaction: (
      _operator: RunnerOperator,
      authority: RunnerDispatchAuthority
    ): Promise<
      | { kind: "found"; value: RunnerAttemptRedactionRecord }
      | { kind: "missing" | "not_live" }
    > =>
      database.transaction(async (transaction) => {
        const run = await lockedLiveDispatchRun(transaction, authority, [
          "dispatching",
          "running",
        ]);
        if (
          !run ||
          !authority.attemptId ||
          run.daytonaAttemptId !== authority.attemptId
        ) {
          return { kind: "not_live" };
        }
        const [redaction] = await transaction.execute(
          statement(
            "read-runner-attempt-redaction",
            { attemptId: authority.attemptId, runId: run.id },
            sql`SELECT *
              FROM "RunnerAttemptRedaction"
              WHERE "runId" = ${run.id}
                AND "attemptId" = ${authority.attemptId}
              LIMIT 1`
          )
        );
        return redaction
          ? { kind: "found", value: asAttemptRedaction(redaction) }
          : { kind: "missing" };
      }),

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
              maxEventBytes: MAX_EVENT_PAGE_BYTES,
              maxEvents: MAX_EVENTS_PER_PAGE,
              runId,
              tenant: principal.tenant,
            },
            sql`WITH candidate AS (
                SELECT "RunnerRunEvent".*,
                    pg_column_size("RunnerRunEvent"."event") AS "eventBytes"
                FROM "RunnerRunEvent"
                INNER JOIN "RunnerRun" ON "RunnerRun"."id" = "RunnerRunEvent"."runId"
                WHERE "RunnerRunEvent"."runId" = ${runId}
                  AND "RunnerRun"."tenant" = ${principal.tenant}
                  AND "RunnerRunEvent"."eventId" > ${afterEventId}
                ORDER BY "RunnerRunEvent"."eventId" ASC
                LIMIT ${MAX_EVENTS_PER_PAGE}
              ),
              paged AS (
                SELECT *,
                    row_number() OVER (ORDER BY "eventId" ASC) AS "pageRank",
                    sum("eventBytes") OVER (
                      ORDER BY "eventId" ASC
                      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                    ) AS "pageBytes"
                FROM candidate
              )
              SELECT "createdAt", "event", "eventId", "runId"
              FROM paged
              WHERE "pageRank" = 1 OR "pageBytes" <= ${MAX_EVENT_PAGE_BYTES}
              ORDER BY "eventId" ASC`
          )
        );
        return rows.map(asEvent);
      }),

    releaseDaytonaPreparation: (
      _operator: RunnerOperator,
      authority: RunnerDispatchAuthority,
      input: ReleaseDaytonaAttemptInput
    ): Promise<
      | { authority: RunnerDispatchAuthority; kind: "released" }
      | { kind: "not_live" }
    > =>
      database.transaction(async (transaction) => {
        const run = await lockedLiveDispatchRun(transaction, authority, [
          "dispatching",
        ]);
        if (
          !run ||
          authority.attemptId !== input.attemptId ||
          run.daytonaAttemptId !== input.attemptId ||
          run.daytonaSessionId ||
          run.daytonaCommandId
        ) {
          return { kind: "not_live" };
        }
        const [updated] = await transaction.execute(
          statement(
            "release-daytona-process-preparation",
            {
              attemptId: input.attemptId,
              expectedVersion: authority.expectedVersion,
              leaseToken: authority.leaseToken,
              runId: run.id,
              tenant: run.tenant,
            },
            sql`UPDATE "RunnerRun"
              SET "daytonaAttemptId" = NULL,
                  "executionProvenance" = NULL,
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${run.id}
                AND "tenant" = ${run.tenant}
                AND "version" = ${authority.expectedVersion}
                AND "dispatchLeaseToken" = ${authority.leaseToken}
                AND "dispatchLeaseExpiresAt" > clock_timestamp()
                AND "dispatchState" = 'dispatching'
                AND "status" = 'queued'
                AND "daytonaAttemptId" = ${input.attemptId}
                AND "daytonaSessionId" IS NULL
                AND "daytonaCommandId" IS NULL
              RETURNING *`
          )
        );
        return updated
          ? { authority: dispatchAuthority(asRun(updated)), kind: "released" }
          : { kind: "not_live" };
      }),

    /**
     * This is the recovery fence used only after the caller has confirmed
     * deletion of the attempt-derived provider session and credential file.
     * It never receives a provider identifier, so stale recovery work can
     * target only the attempt it was handed.
     */
    releaseExpiredDaytonaAttempt: (
      _operator: RunnerOperator,
      input: ReleaseExpiredDaytonaAttemptInput
    ): Promise<
      | { kind: "released"; value: RunnerRunRecord }
      | { kind: "not_found" }
      | { kind: "lease_lost" }
      | { kind: "not_live" }
      | { kind: "not_expired" }
    > =>
      database.transaction(async (transaction) => {
        const run = await lockedOperatorRun(
          transaction,
          _operator,
          input.runId
        );
        if (!run) {
          return { kind: "not_found" };
        }
        if (run.dispatchLeaseToken !== input.oldLeaseToken) {
          return { kind: "lease_lost" };
        }
        if (!isExpectedLiveDispatch(run, input.expectedDispatchState)) {
          return { kind: "not_live" };
        }
        if (run.daytonaAttemptId !== input.attemptId) {
          return { kind: "not_live" };
        }
        const sessionId = daytonaRunSessionName(run.id, input.attemptId);
        if (
          (run.daytonaSessionId !== null &&
            run.daytonaSessionId !== sessionId) ||
          (run.daytonaCommandId !== null && run.daytonaSessionId !== sessionId)
        ) {
          return { kind: "not_live" };
        }
        const [updated] = await transaction.execute(
          statement(
            "release-expired-daytona-attempt",
            input,
            sql`UPDATE "RunnerRun"
              SET "daytonaAttemptId" = NULL,
                  "daytonaSessionId" = NULL,
                  "daytonaCommandId" = NULL,
                  "executionProvenance" = NULL,
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${input.runId}
                AND "dispatchLeaseToken" = ${input.oldLeaseToken}
                AND "dispatchLeaseExpiresAt" <= clock_timestamp()
                AND "dispatchState" = ${input.expectedDispatchState}
                AND "daytonaAttemptId" = ${input.attemptId}
                AND ("daytonaSessionId" IS NULL OR "daytonaSessionId" = ${sessionId})
                AND ("daytonaCommandId" IS NULL OR "daytonaSessionId" = ${sessionId})
              RETURNING *`
          )
        );
        return updated
          ? { kind: "released", value: asRun(updated) }
          : { kind: "not_expired" };
      }),

    releaseReconciliationLease: (
      _operator: RunnerOperator,
      lease: RunnerReconciliationLease
    ): Promise<ReleaseRunnerReconciliationLeaseResult> =>
      database.transaction(async (transaction) => {
        const [released] = await transaction.execute(
          statement(
            "release-reconciliation-lease",
            { fence: lease.fence, ownerToken: lease.ownerToken },
            sql`UPDATE "RunnerScheduler"
              SET "reconciliationLeaseOwner" = NULL,
                  "reconciliationLeaseExpiresAt" = NULL,
                  "updatedAt" = clock_timestamp()
              WHERE "singleton" = true
                AND "reconciliationLeaseOwner" = ${lease.ownerToken}
                AND "reconciliationLeaseFence" = ${lease.fence}
              RETURNING "singleton"`
          )
        );
        return released ? { kind: "released" } : { kind: "stale" };
      }),

    releaseTerminalDaytonaAttempt: (
      operator: RunnerOperator,
      authority: RunnerDispatchAuthority,
      input: ReleaseDaytonaAttemptInput
    ): Promise<
      | { authority: RunnerDispatchAuthority; kind: "released" }
      | { kind: "not_found" }
      | { kind: "not_live" }
      | { kind: "stale_version" }
      | { kind: "lease_lost" }
    > =>
      database.transaction(async (transaction) => {
        const run = await lockedOperatorRun(
          transaction,
          operator,
          authority.runId
        );
        if (!run) {
          return { kind: "not_found" };
        }
        const rejected = fenceOutcome(run, authority);
        if (rejected) {
          return rejected;
        }
        if (
          authority.attemptId !== input.attemptId ||
          run.daytonaAttemptId !== input.attemptId ||
          run.dispatchState !== "terminal"
        ) {
          return { kind: "not_live" };
        }
        const sessionId = daytonaRunSessionName(run.id, input.attemptId);
        if (
          (run.daytonaSessionId !== null &&
            run.daytonaSessionId !== sessionId) ||
          (run.daytonaCommandId !== null && run.daytonaSessionId !== sessionId)
        ) {
          return { kind: "not_live" };
        }
        const [updated] = await transaction.execute(
          statement(
            "release-terminal-daytona-attempt",
            {
              attemptId: input.attemptId,
              expectedVersion: authority.expectedVersion,
              leaseToken: authority.leaseToken,
              runId: run.id,
            },
            sql`UPDATE "RunnerRun"
              SET "daytonaAttemptId" = NULL,
                  "daytonaSessionId" = NULL,
                  "daytonaCommandId" = NULL,
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${run.id}
                AND "version" = ${authority.expectedVersion}
                AND "dispatchLeaseToken" = ${authority.leaseToken}
                AND "dispatchState" = 'terminal'
                AND "daytonaAttemptId" = ${input.attemptId}
                AND ("daytonaSessionId" IS NULL OR "daytonaSessionId" = ${sessionId})
                AND ("daytonaCommandId" IS NULL OR "daytonaSessionId" = ${sessionId})
              RETURNING *`
          )
        );
        return updated
          ? { authority: dispatchAuthority(asRun(updated)), kind: "released" }
          : { kind: "not_live" };
      }),

    releaseUnstartedDispatch: (
      _operator: RunnerOperator,
      authority: RunnerDispatchAuthority
    ): Promise<
      { kind: "released"; value: RunnerRunRecord } | { kind: "not_live" }
    > =>
      database.transaction(async (transaction) => {
        const run = await lockedLiveDispatchRun(transaction, authority, [
          "dispatching",
        ]);
        if (
          !run ||
          run.daytonaAttemptId ||
          run.daytonaSessionId ||
          run.daytonaCommandId
        ) {
          return { kind: "not_live" };
        }
        const [updated] = await transaction.execute(
          statement(
            "release-unstarted-dispatch",
            {
              expectedVersion: authority.expectedVersion,
              leaseToken: authority.leaseToken,
              runId: run.id,
            },
            sql`UPDATE "RunnerRun"
              SET "dispatchLeaseToken" = NULL,
                  "dispatchLeaseExpiresAt" = NULL,
                  "dispatchState" = 'queued',
                  "authorityRevalidation" = false,
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "id" = ${run.id}
                AND "version" = ${authority.expectedVersion}
                AND "dispatchLeaseToken" = ${authority.leaseToken}
                AND "dispatchLeaseExpiresAt" > clock_timestamp()
                AND "dispatchState" = 'dispatching'
                AND "status" = 'queued'
                AND "cancellationRequestedAt" IS NULL
                AND "daytonaAttemptId" IS NULL
                AND "daytonaSessionId" IS NULL
                AND "daytonaCommandId" IS NULL
              RETURNING *`
          )
        );
        return updated
          ? { kind: "released", value: asRun(updated) }
          : { kind: "not_live" };
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
              SET "dispatchLeaseExpiresAt" = ${timestampParameter(input.leaseExpiresAt)},
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

    /**
     * Cancelling rotates dispatch authority before the provider is touched.
     * A queued row becomes a leased dispatching cleanup state because queued
     * rows cannot carry lease fields under the database invariant.
     */
    requestRunCancellation: (
      operator: RunnerOperator,
      input: RequestRunnerCancellationInput
    ): Promise<RunnerCancellationRequestOutcome> =>
      database.transaction(async (transaction) => {
        const run = await lockedOperatorRun(transaction, operator, input.runId);
        if (!run) {
          return { kind: "not_found" };
        }
        if (run.dispatchState === "terminal") {
          return { kind: "already_terminal", run };
        }

        const [updated] = await transaction.execute(
          statement(
            "request-run-cancellation",
            {
              expectedVersion: run.version,
              leaseExpiresAt: input.leaseExpiresAt,
              leaseToken: input.leaseToken,
              runId: run.id,
            },
            sql`UPDATE "RunnerRun"
              SET "cancellationRequestedAt" = clock_timestamp(),
                  "dispatchState" = CASE
                    WHEN "dispatchState" = 'queued' THEN 'dispatching'
                    ELSE "dispatchState"
                  END,
                  "dispatchLeaseToken" = ${input.leaseToken},
                  "dispatchLeaseExpiresAt" = ${timestampParameter(input.leaseExpiresAt)},
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "id" = ${run.id}
                AND "version" = ${run.version}
                AND "dispatchState" IN ('queued', 'dispatching', 'running')
                AND "status" IN ('queued', 'running')
                AND (
                  "cancellationRequestedAt" IS NULL
                  OR "dispatchLeaseExpiresAt" <= clock_timestamp()
                )
              RETURNING *`
          )
        );
        if (!updated) {
          return { kind: "in_progress" };
        }
        const value = asRun(updated);
        return {
          authority: {
            ...dispatchAuthority(value),
            ...(value.daytonaAttemptId
              ? { attemptId: value.daytonaAttemptId }
              : {}),
          } as RunnerDispatchAuthority,
          kind: "requested",
          run: value,
        };
      }),

    /**
     * Called only after the exact deterministic session and credential path
     * are confirmed absent. Clearing ownership and the active lease together
     * makes the queue row eligible again without a blind requeue window.
     */
    requeueAfterDaytonaAttemptCleanup: (
      operator: RunnerOperator,
      authority: RunnerDispatchAuthority
    ): Promise<
      { kind: "requeued"; value: RunnerRunRecord } | { kind: "not_live" }
    > =>
      database.transaction(async (transaction) => {
        const run = await lockedOperatorRun(
          transaction,
          operator,
          authority.runId
        );
        if (
          !run ||
          fenceOutcome(run, authority) ||
          !authority.attemptId ||
          run.daytonaAttemptId !== authority.attemptId ||
          run.cancellationRequestedAt
        ) {
          return { kind: "not_live" };
        }
        if (
          run.dispatchState !== "dispatching" &&
          run.dispatchState !== "running"
        ) {
          return { kind: "not_live" };
        }
        if (!isExpectedLiveDispatch(run, run.dispatchState)) {
          return { kind: "not_live" };
        }
        const sessionId = daytonaRunSessionName(run.id, authority.attemptId);
        if (
          (run.daytonaSessionId !== null &&
            run.daytonaSessionId !== sessionId) ||
          (run.daytonaCommandId !== null && run.daytonaSessionId !== sessionId)
        ) {
          return { kind: "not_live" };
        }
        const [updated] = await transaction.execute(
          statement(
            "requeue-after-daytona-attempt-cleanup",
            {
              attemptId: authority.attemptId,
              expectedVersion: authority.expectedVersion,
              leaseToken: authority.leaseToken,
              runId: run.id,
            },
            sql`UPDATE "RunnerRun"
              SET "daytonaAttemptId" = NULL,
                  "daytonaSessionId" = NULL,
                  "daytonaCommandId" = NULL,
                  "daytonaLogCursor" = 0,
                  "authorityRevalidation" = false,
                  "executionProvenance" = NULL,
                  "dispatchLeaseToken" = NULL,
                  "dispatchLeaseExpiresAt" = NULL,
                  "dispatchState" = 'queued',
                  "startedAt" = NULL,
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "id" = ${run.id}
                AND "version" = ${authority.expectedVersion}
                AND "dispatchLeaseToken" = ${authority.leaseToken}
                AND "dispatchLeaseExpiresAt" > clock_timestamp()
                AND "dispatchState" IN ('dispatching', 'running')
                AND "status" IN ('queued', 'running')
                AND "cancellationRequestedAt" IS NULL
                AND "daytonaAttemptId" = ${authority.attemptId}
                AND (
                  "daytonaSessionId" IS NULL
                  OR "daytonaSessionId" = ${sessionId}
                )
                AND (
                  "daytonaCommandId" IS NULL
                  OR "daytonaSessionId" = ${sessionId}
                )
              RETURNING *`
          )
        );
        if (!updated) {
          return { kind: "not_live" };
        }
        const value = asRun(updated);
        await transaction.execute(
          statement(
            "mark-agent-idle-after-attempt-cleanup",
            { agentId: value.agentId, tenant: value.tenant },
            sql`UPDATE "RunnerAgent"
              SET "status" = 'idle',
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "id" = ${value.agentId}
                AND "tenant" = ${value.tenant}`
          )
        );
        return { kind: "requeued", value };
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
        const [expired] = await transaction.execute(
          statement(
            "confirm-expired-dispatch-requeue",
            input,
            sql`SELECT "id" FROM "RunnerRun"
              WHERE "id" = ${input.runId}
                AND "dispatchLeaseToken" = ${input.oldLeaseToken}
                AND "dispatchLeaseExpiresAt" <= clock_timestamp()
                AND "dispatchState" = ${input.expectedDispatchState}`
          )
        );
        if (!expired) {
          return { kind: "not_expired" };
        }
        if (run.daytonaAttemptId) {
          return { attemptId: run.daytonaAttemptId, kind: "cleanup_required" };
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
                  "authorityRevalidation" = false,
                  "executionProvenance" = NULL,
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${input.runId}
                AND "dispatchLeaseToken" = ${input.oldLeaseToken}
                AND "dispatchLeaseExpiresAt" <= clock_timestamp()
                AND "dispatchState" = ${input.expectedDispatchState}
                AND "cancellationRequestedAt" IS NULL
                AND "daytonaAttemptId" IS NULL
                AND "daytonaSessionId" IS NULL
                AND "daytonaCommandId" IS NULL
              RETURNING *`
          )
        );
        return updated
          ? { kind: "requeued", value: asRun(updated) }
          : { kind: "not_expired" };
      }),

    reserveDaytonaSandbox: (
      principal: RunnerPrincipal,
      input: ReserveDaytonaSandboxInput
    ): Promise<
      | { kind: "reserved"; value: RunnerAgentRecord }
      | { kind: "in_progress"; value: RunnerAgentRecord }
      | { kind: "not_found" }
      | { kind: "stale_version" }
    > =>
      database.transaction(async (transaction) => {
        const [current] = await transaction.execute(
          statement(
            "lock-agent-for-daytona-sandbox-reservation",
            { ...input, tenant: principal.tenant },
            sql`SELECT * FROM "RunnerAgent"
              WHERE "id" = ${input.agentId}
                AND "tenant" = ${principal.tenant}
              FOR UPDATE`
          )
        );
        if (!current) {
          return { kind: "not_found" };
        }
        const agent = asAgent(current);
        if (
          agent.sandboxLifecycle === "provisioning" &&
          agent.sandboxUpdatedAt > input.provisioningStaleBefore
        ) {
          return { kind: "in_progress", value: agent };
        }
        if (
          (agent.sandboxLifecycle !== "provisioning" &&
            (agent.version !== input.expectedVersion ||
              agent.sandboxGeneration !== input.expectedGeneration ||
              agent.daytonaSandboxId !== input.expectedSandboxId)) ||
          agent.sandboxLifecycle === "decommissioning" ||
          agent.sandboxLifecycle === "decommission_failed"
        ) {
          return { kind: "stale_version" };
        }
        const [reserved] = await transaction.execute(
          statement(
            "reserve-daytona-sandbox-generation",
            { ...input, tenant: principal.tenant },
            sql`UPDATE "RunnerAgent"
              SET "daytonaSandboxId" = NULL,
                  "sandboxGeneration" = "sandboxGeneration" + 1,
                  "sandboxLifecycle" = 'provisioning',
                  "sandboxUpdatedAt" = now(),
                  "warmStatus" = 'not_started',
                  "warmUpdatedAt" = now(),
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${input.agentId}
                AND "tenant" = ${principal.tenant}
                AND (
                  (
                    "version" = ${input.expectedVersion}
                    AND "sandboxGeneration" = ${input.expectedGeneration}
                    AND "daytonaSandboxId" IS NOT DISTINCT FROM ${input.expectedSandboxId}
                    AND "sandboxLifecycle" IN ('unprovisioned', 'ready')
                  )
                  OR (
                    "sandboxLifecycle" = 'provisioning'
                    AND "sandboxUpdatedAt" <= ${timestampParameter(input.provisioningStaleBefore)}
                  )
                )
              RETURNING *`
          )
        );
        return reserved
          ? { kind: "reserved", value: asAgent(reserved) }
          : { kind: "stale_version" };
      }),

    reserveDaytonaSandboxForDispatch: (
      _operator: RunnerOperator,
      authority: RunnerDispatchAuthority,
      input: Pick<ReserveDaytonaSandboxInput, "provisioningStaleBefore">
    ): Promise<
      | { kind: "reserved" | "in_progress"; value: RunnerAgentRecord }
      | { kind: "not_found" }
      | { kind: "not_live" }
      | { kind: "stale_version" }
    > =>
      database.transaction(async (transaction) => {
        const run = await lockedLiveDispatchRun(transaction, authority, [
          "dispatching",
          "running",
        ]);
        if (!run) {
          return { kind: "not_live" };
        }
        const agent = await lockedDispatchAgent(transaction, run);
        if (!agent) {
          return { kind: "not_found" };
        }
        if (
          agent.sandboxLifecycle === "provisioning" &&
          agent.sandboxUpdatedAt > input.provisioningStaleBefore
        ) {
          return { kind: "in_progress", value: agent };
        }
        if (
          agent.sandboxLifecycle === "decommissioning" ||
          agent.sandboxLifecycle === "decommission_failed"
        ) {
          return { kind: "stale_version" };
        }
        const [reserved] = await transaction.execute(
          statement(
            "reserve-daytona-sandbox-for-dispatch",
            {
              agentId: run.agentId,
              provisioningStaleBefore: input.provisioningStaleBefore,
              tenant: run.tenant,
            },
            sql`UPDATE "RunnerAgent"
              SET "daytonaSandboxId" = NULL,
                  "sandboxGeneration" = "sandboxGeneration" + 1,
                  "sandboxLifecycle" = 'provisioning',
                  "sandboxUpdatedAt" = now(),
                  "warmStatus" = 'not_started',
                  "warmUpdatedAt" = now(),
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${run.agentId}
                AND "tenant" = ${run.tenant}
                AND (
                  "sandboxLifecycle" IN ('unprovisioned', 'ready')
                  OR (
                    "sandboxLifecycle" = 'provisioning'
                    AND "sandboxUpdatedAt" <= ${timestampParameter(input.provisioningStaleBefore)}
                  )
                )
              RETURNING *`
          )
        );
        return reserved
          ? { kind: "reserved", value: asAgent(reserved) }
          : { kind: "stale_version" };
      }),

    resetDaytonaSandboxRecovery: (
      _operator: RunnerOperator,
      input: DaytonaSandboxFence
    ): Promise<
      | { kind: "updated"; value: RunnerAgentRecord }
      | { kind: "not_found" }
      | { kind: "stale_version" }
    > =>
      database.transaction(async (transaction) => {
        const [updated] = await transaction.execute(
          statement(
            "reset-daytona-sandbox-recovery",
            input,
            sql`UPDATE "RunnerAgent"
              SET "daytonaSandboxId" = NULL,
                  "sandboxLifecycle" = 'unprovisioned',
                  "sandboxTrust" = 'clean',
                  "sandboxUpdatedAt" = clock_timestamp(),
                  "warmStatus" = 'not_started',
                  "warmUpdatedAt" = clock_timestamp(),
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "id" = ${input.agentId}
                AND "version" = ${input.expectedVersion}
                AND "sandboxGeneration" = ${input.expectedGeneration}
                AND "sandboxLifecycle" IN ('provisioning', 'provisioning_ambiguous')
              RETURNING *`
          )
        );
        if (updated) {
          return { kind: "updated", value: asAgent(updated) };
        }
        const [current] = await transaction.execute(
          statement(
            "get-agent-after-daytona-recovery-reset",
            { agentId: input.agentId },
            sql`SELECT "id" FROM "RunnerAgent"
              WHERE "id" = ${input.agentId}
              LIMIT 1`
          )
        );
        return current ? { kind: "stale_version" } : { kind: "not_found" };
      }),

    scanDaytonaSandboxInventory: (
      _operator: RunnerOperator,
      requestedLimit: number
    ) => {
      const limit = runnerResourceInventoryLimit(requestedLimit);
      return database.transaction(async (transaction) => {
        const rows = await transaction.execute(
          statement(
            "scan-daytona-sandbox-inventory",
            { limit },
            sql`SELECT * FROM "RunnerAgent"
              WHERE "daytonaSandboxId" IS NOT NULL
                OR "sandboxLifecycle" IN (
                  'provisioning',
                  'provisioning_ambiguous',
                  'resetting',
                  'decommissioning',
                  'decommission_failed'
                )
              ORDER BY "sandboxUpdatedAt" ASC, "id" ASC
              LIMIT ${limit}`
          )
        );
        return rows.map(asAgent);
      });
    },

    scanDaytonaSandboxRecoveries: (_operator: RunnerOperator, limit: number) =>
      database.transaction(async (transaction) => {
        const rows = await transaction.execute(
          statement(
            "scan-daytona-sandbox-recoveries",
            { limit },
            sql`SELECT * FROM "RunnerAgent"
              WHERE "sandboxLifecycle" IN (
                'provisioning',
                'provisioning_ambiguous',
                'resetting',
                'decommissioning'
              )
              ORDER BY "sandboxUpdatedAt" ASC, "id" ASC
              LIMIT ${limit}
              FOR UPDATE SKIP LOCKED`
          )
        );
        return rows.map(asAgent);
      }),

    scanDaytonaSandboxRepairCandidates: (
      _operator: RunnerOperator,
      requestedLimit: number
    ) => {
      const limit = runnerResourceInventoryLimit(requestedLimit);
      return database.transaction(async (transaction) => {
        const rows = await transaction.execute(
          statement(
            "scan-daytona-sandbox-repair-candidates",
            { limit },
            sql`WITH "mapped" AS (
                SELECT *,
                  count(*) OVER () AS "appOwnedMappings",
                  count(*) OVER (
                    PARTITION BY "daytonaSandboxId"
                  ) AS "providerMappingCount"
                FROM "RunnerAgent"
                WHERE "daytonaSandboxId" IS NOT NULL
              )
              SELECT *
              FROM "mapped"
              WHERE "sandboxLifecycle" IN ('ready', 'resizing')
                AND "status" = 'idle'
                AND "warmStatus" <> 'provisioning'
                AND NOT EXISTS (
                  SELECT 1
                  FROM "RunnerRun" AS "liveRun"
                  WHERE "liveRun"."agentId" = "mapped"."id"
                    AND "liveRun"."tenant" = "mapped"."tenant"
                    AND "liveRun"."status" IN ('queued', 'running')
                )
              ORDER BY
                CASE WHEN "providerMappingCount" = 1 THEN 0 ELSE 1 END,
                CASE WHEN "sandboxLifecycle" = 'resizing' THEN 0 ELSE 1 END,
                "sandboxUpdatedAt" ASC,
                "id" ASC
              LIMIT ${limit}`
          )
        );
        return rows.map((row) => {
          const appOwnedMappings = Number(column(row, "appOwnedMappings"));
          const providerMappingCount = Number(
            column(row, "providerMappingCount")
          );
          if (
            !Number.isSafeInteger(appOwnedMappings) ||
            appOwnedMappings < 1 ||
            !Number.isSafeInteger(providerMappingCount) ||
            providerMappingCount < 1
          ) {
            throw new Error(
              "Runner repair candidate query returned invalid counts."
            );
          }
          return {
            appOwnedMappings,
            mapping: asAgent(row),
            providerMappingCount,
          };
        });
      });
    },

    scanDaytonaWarmRecoveries: (
      _operator: RunnerOperator,
      staleBefore: Date,
      limit: number
    ) =>
      database.transaction(async (transaction) => {
        const rows = await transaction.execute(
          statement(
            "scan-daytona-warm-recoveries",
            { limit, staleBefore },
            sql`SELECT * FROM "RunnerAgent"
              WHERE "sandboxLifecycle" = 'ready'
                AND "warmStatus" = 'provisioning'
                AND "warmUpdatedAt" <= ${timestampParameter(staleBefore)}
              ORDER BY "warmUpdatedAt" ASC, "id" ASC
              LIMIT ${limit}
              FOR UPDATE SKIP LOCKED`
          )
        );
        return rows.map(asAgent);
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
              WHERE "dispatchLeaseExpiresAt" <= ${timestampParameter(before)}
                AND "dispatchLeaseToken" IS NOT NULL
                AND "dispatchState" IN ('dispatching', 'running')
              ORDER BY "dispatchLeaseExpiresAt" ASC
              LIMIT ${limit}
              FOR UPDATE SKIP LOCKED`
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

    scanTerminalDaytonaAttemptCleanups: (
      _operator: RunnerOperator,
      limit: number
    ) =>
      database.transaction(async (transaction) => {
        const rows = await transaction.execute(
          statement(
            "scan-terminal-daytona-attempt-cleanups",
            { limit },
            sql`SELECT * FROM "RunnerRun"
              WHERE "dispatchState" = 'terminal'
                AND "daytonaAttemptId" IS NOT NULL
                AND "dispatchLeaseToken" IS NOT NULL
                AND "dispatchLeaseExpiresAt" <= clock_timestamp()
              ORDER BY "dispatchLeaseExpiresAt" ASC
              LIMIT ${limit}
              FOR UPDATE SKIP LOCKED`
          )
        );
        return rows.map(asRun);
      }),

    scanTerminalLeaseCleanups: (_operator: RunnerOperator, limit: number) =>
      database.transaction(async (transaction) => {
        const rows = await transaction.execute(
          statement(
            "scan-terminal-lease-cleanups",
            { limit },
            sql`SELECT * FROM "RunnerRun"
              WHERE "dispatchState" = 'terminal'
                AND "daytonaAttemptId" IS NULL
                AND "daytonaCommandId" IS NULL
                AND "daytonaSessionId" IS NULL
                AND "dispatchLeaseToken" IS NOT NULL
                AND "dispatchLeaseExpiresAt" <= clock_timestamp()
              ORDER BY "dispatchLeaseExpiresAt" ASC, "id" ASC
              LIMIT ${limit}
              FOR UPDATE SKIP LOCKED`
          )
        );
        return rows.map(asRun);
      }),

    startRun: (
      principal: RunnerPrincipal,
      input: StartRunnerRunInput
    ): Promise<
      | { kind: "created"; run: RunSnapshot }
      | { kind: "claimed"; claimed: RunnerClaimedDispatch; run: RunSnapshot }
      | { kind: "duplicate"; run: RunSnapshot }
      | { kind: "conflict"; run: RunSnapshot }
      | { kind: "sandbox_trust_conflict" }
      | {
          kind: "sandbox_binding_refused";
          reason:
            | "fence_outstanding"
            | "generation_mismatch"
            | "lifecycle_not_ready"
            | "no_recorded_sandbox"
            | "sandbox_id_mismatch";
        }
      | {
          kind: "refused";
          reason: "global_busy" | "tenant_queue_full";
        }
      | { kind: "not_found" }
      | {
          kind: "sandbox_unavailable";
          lifecycle: Exclude<
            RunnerAgentRecord["sandboxLifecycle"],
            "unprovisioned" | "provisioning" | "ready"
          >;
        }
    > => {
      const executionPermission = input.executionPermission ?? "unrestricted";
      const githubBrokerPolicy = input.githubBrokerPolicy ?? null;
      const teamStepId = input.teamStepId ?? null;
      const sandboxBinding = input.sandboxBinding ?? null;
      return database.transaction(async (transaction) => {
        const [agent] = await transaction.execute(
          statement(
            "lock-agent-for-run-start",
            { agentId: input.agentId, tenant: principal.tenant },
            sql`SELECT * FROM "RunnerAgent"
              WHERE "id" = ${input.agentId}
                AND "tenant" = ${principal.tenant}
              FOR UPDATE`
          )
        );
        if (!agent) {
          return { kind: "not_found" };
        }
        const existingOperation = await lockedOperationRun(
          transaction,
          input,
          principal.tenant
        );
        if (existingOperation) {
          return matchesRunRequest(
            existingOperation,
            input,
            executionPermission
          )
            ? { kind: "duplicate", run: runSnapshot(existingOperation) }
            : { kind: "conflict", run: runSnapshot(existingOperation) };
        }
        if (sandboxBinding) {
          // The request's two values are compared with the locked agent row
          // and can only refuse. Nothing here records, adopts, or selects a
          // sandbox, and a refusal inserts no run, so no lease, reservation,
          // or provider call can follow from it.
          const recordedSandboxId = optionalColumn<string>(
            agent,
            "daytonaSandboxId"
          );
          if (!recordedSandboxId) {
            return {
              kind: "sandbox_binding_refused",
              reason: "no_recorded_sandbox",
            };
          }
          if (recordedSandboxId !== sandboxBinding.expectedSandboxId) {
            return {
              kind: "sandbox_binding_refused",
              reason: "sandbox_id_mismatch",
            };
          }
          if (
            column<number>(agent, "sandboxGeneration") !==
            sandboxBinding.expectedGeneration
          ) {
            return {
              kind: "sandbox_binding_refused",
              reason: "generation_mismatch",
            };
          }
          if (agent.sandboxLifecycle !== "ready") {
            return {
              kind: "sandbox_binding_refused",
              reason: "lifecycle_not_ready",
            };
          }
          const [fence] = await transaction.execute(
            statement(
              "get-run-sandbox-binding-fence",
              { agentId: input.agentId, tenant: principal.tenant },
              sql`SELECT COALESCE(bool_or(
                  (
                    "dispatchState" IN ('dispatching', 'running')
                    AND "authorityRevalidation" = false
                  )
                  OR (
                    "dispatchState" = 'terminal'
                    AND (
                      "daytonaAttemptId" IS NOT NULL
                      OR "daytonaCommandId" IS NOT NULL
                      OR "daytonaSessionId" IS NOT NULL
                    )
                  )
                ), false) AS "outstanding"
                FROM "RunnerRun"
                WHERE "agentId" = ${input.agentId}
                  AND "tenant" = ${principal.tenant}`
            )
          );
          // A missing or malformed fence row must not read as "no fence".
          if (fence?.outstanding !== false) {
            return {
              kind: "sandbox_binding_refused",
              reason: "fence_outstanding",
            };
          }
        }
        if (
          executionPermission !== "unrestricted" &&
          column(agent, "sandboxTrust") === "unrestricted"
        ) {
          return { kind: "sandbox_trust_conflict" };
        }
        if (executionPermission !== "unrestricted") {
          const [pendingUnrestrictedRun] = await transaction.execute(
            statement(
              "find-pending-unrestricted-run",
              { agentId: input.agentId, tenant: principal.tenant },
              sql`SELECT "id"
                FROM "RunnerRun"
                WHERE "agentId" = ${input.agentId}
                  AND "tenant" = ${principal.tenant}
                  AND "status" IN ('queued', 'running')
                  AND "cancellationRequestedAt" IS NULL
                  AND "executionPermission" = 'unrestricted'
                LIMIT 1`
            )
          );
          if (pendingUnrestrictedRun) {
            return { kind: "sandbox_trust_conflict" };
          }
        }
        if (
          agent.sandboxLifecycle !== "unprovisioned" &&
          agent.sandboxLifecycle !== "provisioning" &&
          agent.sandboxLifecycle !== "provisioning_ambiguous" &&
          agent.sandboxLifecycle !== "ready"
        ) {
          return {
            kind: "sandbox_unavailable",
            lifecycle: agent.sandboxLifecycle as Exclude<
              RunnerAgentRecord["sandboxLifecycle"],
              "unprovisioned" | "provisioning" | "ready"
            >,
          };
        }
        let admission:
          | {
              limits: RunnerAdmissionLimits;
              scheduler: RunnerSchedulerRecord;
            }
          | undefined;
        if (input.admission) {
          const limits = admissionLimits(input.admission);
          const scheduler = await lockRunnerScheduler(transaction);
          if (
            (await activeDispatchCount(transaction)) >=
            limits.deploymentActiveRuns
          ) {
            return { kind: "refused", reason: "global_busy" };
          }
          if (limits.tenantQueuedRuns === 0 && !input.initialDispatch) {
            return { kind: "refused", reason: "tenant_queue_full" };
          }
          if (
            limits.tenantQueuedRuns > 0 &&
            (await queuedTenantCount(transaction, principal.tenant)) >=
              limits.tenantQueuedRuns
          ) {
            return { kind: "refused", reason: "tenant_queue_full" };
          }
          admission = { limits, scheduler };
        }
        const agentSnapshot = input.agentSnapshot ?? {
          instructions: column<string>(agent, "instructions"),
          model: column<string>(agent, "model"),
          runtime: column<RunnerAgentRecord["runtime"]>(agent, "runtime"),
          workspace: column<string | null>(agent, "workspace"),
        };
        // An absent policy must be SQL NULL: `'null'::jsonb IS NOT NULL`, and
        // the RunnerRun insert trigger refuses any ordinary run that carries
        // a non-NULL "githubBrokerPolicy".
        const [inserted] = await transaction.execute(
          statement(
            "insert-run",
            {
              agentId: input.agentId,
              agentInstructions: agentSnapshot.instructions,
              agentModel: agentSnapshot.model,
              agentRuntime: agentSnapshot.runtime,
              agentWorkspace: agentSnapshot.workspace,
              authVersion: input.authVersion,
              executionPermission,
              githubBrokerPolicy,
              id: input.id,
              operationId: input.operationId,
              requestHash: input.requestHash,
              sandboxBinding,
              task: input.task,
              teamStepId,
              tenant: principal.tenant,
            },
            sql`INSERT INTO "RunnerRun" (
              "id", "agentId", "tenant", "agentInstructions", "agentModel",
              "agentRuntime", "agentWorkspace", "authVersion", "operationId",
              "requestHash", "task", "executionPermission", "teamStepId",
              "boundSandboxId", "boundSandboxGeneration", "githubBrokerPolicy"
            ) VALUES (
              ${input.id}, ${input.agentId}, ${principal.tenant},
              ${agentSnapshot.instructions}, ${agentSnapshot.model},
              ${agentSnapshot.runtime}, ${agentSnapshot.workspace},
              ${input.authVersion}, ${input.operationId}, ${input.requestHash},
              ${input.task}, ${executionPermission}, ${teamStepId},
              ${sandboxBinding?.expectedSandboxId ?? null},
              ${sandboxBinding?.expectedGeneration ?? null},
              CAST(${githubBrokerPolicy === null ? null : JSON.stringify(githubBrokerPolicy)} AS jsonb)
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
          const acceptedRun = asRun(run);
          if (
            admission &&
            admission.limits.tenantQueuedRuns === 0 &&
            input.initialDispatch
          ) {
            const candidate = await selectEligibleDispatch(
              transaction,
              admission.scheduler,
              admission.limits
            );
            if (candidate?.id !== acceptedRun.id) {
              await transaction.execute(
                statement(
                  "discard-zero-capacity-run",
                  { runId: acceptedRun.id, tenant: acceptedRun.tenant },
                  sql`DELETE FROM "RunnerRun"
                    WHERE "id" = ${acceptedRun.id}
                      AND "tenant" = ${acceptedRun.tenant}
                      AND "dispatchState" = 'queued'
                      AND "status" = 'queued'`
                )
              );
              await restoreDiscardedRunSandboxTrust(
                transaction,
                input.agentId,
                principal.tenant,
                column(agent, "sandboxTrust")
              );
              return { kind: "refused", reason: "tenant_queue_full" };
            }
            const claimed = await claimLockedDispatch(transaction, candidate, {
              ...input.initialDispatch,
              limits: admission.limits,
            });
            if (!claimed) {
              await transaction.execute(
                statement(
                  "discard-zero-capacity-run",
                  { runId: acceptedRun.id, tenant: acceptedRun.tenant },
                  sql`DELETE FROM "RunnerRun"
                    WHERE "id" = ${acceptedRun.id}
                      AND "tenant" = ${acceptedRun.tenant}
                      AND "dispatchState" = 'queued'
                      AND "status" = 'queued'`
                )
              );
              await restoreDiscardedRunSandboxTrust(
                transaction,
                input.agentId,
                principal.tenant,
                column(agent, "sandboxTrust")
              );
              return { kind: "refused", reason: "tenant_queue_full" };
            }
            await advanceRunnerScheduler(
              transaction,
              admission.scheduler,
              claimed.tenant
            );
            return {
              claimed: {
                authority: dispatchAuthority(claimed),
                run: claimed,
              },
              kind: "claimed",
              run: runSnapshot(claimed),
            };
          }
          return { kind: "created", run: runSnapshot(acceptedRun) };
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
        return matchesRunRequest(run, input, executionPermission)
          ? { kind: "duplicate", run: runSnapshot(run) }
          : { kind: "conflict", run: runSnapshot(run) };
      });
    },

    updateAgent: (
      principal: RunnerPrincipal,
      input: UpdateRunnerAgentInput
    ): Promise<
      | { kind: "updated"; value: RunnerAgentRecord }
      | { kind: "busy" }
      | { kind: "not_found" }
      | { kind: "stale_version" }
    > =>
      database.transaction(async (transaction) => {
        const [current] = await transaction.execute(
          statement(
            "lock-agent-for-update",
            { agentId: input.id, tenant: principal.tenant },
            sql`SELECT * FROM "RunnerAgent"
              WHERE "id" = ${input.id}
                AND "tenant" = ${principal.tenant}
              FOR UPDATE`
          )
        );
        if (!current) {
          return { kind: "not_found" };
        }
        const agent = asAgent(current);
        if (agent.version !== input.expectedVersion) {
          return { kind: "stale_version" };
        }
        const [liveRun] = await transaction.execute(
          statement(
            "find-live-run-for-agent-update",
            { agentId: input.id, tenant: principal.tenant },
            sql`SELECT "id" FROM "RunnerRun"
              WHERE "agentId" = ${input.id}
                AND "tenant" = ${principal.tenant}
                AND "status" IN ('queued', 'running')
              LIMIT 1`
          )
        );
        if (liveRun) {
          return { kind: "busy" };
        }
        const [updated] = await transaction.execute(
          statement(
            "update-agent",
            { ...input, tenant: principal.tenant },
            sql`UPDATE "RunnerAgent"
              SET "name" = ${input.name},
                  "description" = ${input.description},
                  "familiarId" = ${input.familiarId},
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
        if (!updated) {
          throw new Error("Locked Runner agent changed before update.");
        }
        return { kind: "updated", value: asAgent(updated) };
      }),
  };
}
