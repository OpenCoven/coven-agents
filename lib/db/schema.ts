import {
  AGENT_RUNNER_LIMITS,
  type CommandEvidence,
  type FileEvidence,
  type RunError,
  type RunEvent,
} from "@opencoven/agent-contracts";
import { type InferSelectModel, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  json,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { StoredIdempotencyResponseEnvelope } from "../abuse/idempotency-response";

const runnerMaxCommandResultsSql = sql.raw(
  String(AGENT_RUNNER_LIMITS.maxCommandResults)
);
const runnerMaxDetailsLengthSql = sql.raw(
  String(AGENT_RUNNER_LIMITS.maxDetailsLength)
);
const runnerMaxEventOutputLengthSql = sql.raw(
  String(AGENT_RUNNER_LIMITS.maxEventOutputLength)
);
const runnerMaxFileOperationsSql = sql.raw(
  String(AGENT_RUNNER_LIMITS.maxFileOperations)
);
const runnerMaxMessageLengthSql = sql.raw(
  String(AGENT_RUNNER_LIMITS.maxMessageLength)
);

export const user = pgTable(
  "User",
  {
    authVersion: integer("authVersion").notNull().default(0),
    billingPeriodStart: timestamp("billingPeriodStart"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    email: varchar("email", { length: 64 }).notNull(),
    emailVerified: boolean("emailVerified").notNull().default(false),
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    image: text("image"),
    isAnonymous: boolean("isAnonymous").notNull().default(false),
    name: text("name"),
    password: varchar("password", { length: 64 }),
    /**
     * The Stripe Customer this user owns, created at first checkout and reused
     * afterwards. Unique: one Customer belongs to one user.
     *
     * This does NOT forbid a second subscription -- a cancel-then-resubscribe
     * reuses the same Customer, so a constraint here would reject exactly the
     * returning customer worth not breaking. "At most one active subscription"
     * is asked of Stripe instead.
     */
    stripeCustomerId: varchar("stripeCustomerId", { length: 64 }),
    stripeSubscriptionId: varchar("stripeSubscriptionId", { length: 64 }),
    /**
     * When this user's subscription lapses. Null means never subscribed.
     *
     * A timestamp rather than a boolean because a cancelled subscription runs to
     * the end of its paid period, which a boolean cannot express. Billing will
     * set this; until then it is set by `pnpm subscription`.
     */
    subscribedUntil: timestamp("subscribedUntil"),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("User_stripeCustomerId_idx").on(table.stripeCustomerId),
  ]
);

export type User = InferSelectModel<typeof user>;

export const chat = pgTable("Chat", {
  createdAt: timestamp("createdAt").notNull(),
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  title: text("title").notNull(),
  userId: uuid("userId")
    .notNull()
    .references(() => user.id),
  visibility: varchar("visibility", { enum: ["public", "private"] })
    .notNull()
    .default("private"),
});

export type Chat = InferSelectModel<typeof chat>;

export const message = pgTable("Message_v2", {
  attachments: json("attachments").notNull(),
  chatId: uuid("chatId")
    .notNull()
    .references(() => chat.id),
  createdAt: timestamp("createdAt").notNull(),
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  parts: json("parts").notNull(),
  role: varchar("role").notNull(),
});

export type DBMessage = InferSelectModel<typeof message>;

export const vote = pgTable(
  "Vote_v2",
  {
    chatId: uuid("chatId")
      .notNull()
      .references(() => chat.id),
    isUpvoted: boolean("isUpvoted").notNull(),
    messageId: uuid("messageId")
      .notNull()
      .references(() => message.id),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.chatId, table.messageId] }),
  })
);

export type Vote = InferSelectModel<typeof vote>;

export const document = pgTable(
  "Document",
  {
    content: text("content"),
    createdAt: timestamp("createdAt").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    kind: varchar("text", { enum: ["text", "code", "image", "sheet"] })
      .notNull()
      .default("text"),
    title: text("title").notNull(),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id, table.createdAt] }),
  })
);

export type Document = InferSelectModel<typeof document>;

export const suggestion = pgTable(
  "Suggestion",
  {
    createdAt: timestamp("createdAt").notNull(),
    description: text("description"),
    documentCreatedAt: timestamp("documentCreatedAt").notNull(),
    documentId: uuid("documentId").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    isResolved: boolean("isResolved").notNull().default(false),
    originalText: text("originalText").notNull(),
    suggestedText: text("suggestedText").notNull(),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id),
  },
  (table) => ({
    documentRef: foreignKey({
      columns: [table.documentId, table.documentCreatedAt],
      foreignColumns: [document.id, document.createdAt],
    }),
    pk: primaryKey({ columns: [table.id] }),
  })
);

export type Suggestion = InferSelectModel<typeof suggestion>;

export const stream = pgTable(
  "Stream",
  {
    chatId: uuid("chatId").notNull(),
    createdAt: timestamp("createdAt").notNull(),
    id: uuid("id").notNull().defaultRandom(),
  },
  (table) => ({
    chatRef: foreignKey({
      columns: [table.chatId],
      foreignColumns: [chat.id],
    }),
    pk: primaryKey({ columns: [table.id] }),
  })
);

export type Stream = InferSelectModel<typeof stream>;

/**
 * One encrypted credential per tenant per harness.
 *
 * Only the ciphertext, its IV and the wrapped data key are stored — the
 * plaintext never reaches a column. `wrappedKey` is this credential's own data
 * key sealed under the deployment KEK, so rotating the KEK rewraps small
 * values instead of re-encrypting every credential, and revoking one tenant is
 * deleting one row.
 *
 * The unique index is load-bearing, not decorative: writes upsert on
 * (tenant, harnessId), which Postgres can only resolve against a unique
 * constraint. Without it a re-submitted credential would silently insert a
 * second row and reads would start returning whichever one came back first.
 */
export const tenantCredential = pgTable(
  "TenantCredential",
  {
    aadVersion: integer("aadVersion").notNull().default(0),
    ciphertext: text("ciphertext").notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    credentialRevision: uuid("credentialRevision").notNull().defaultRandom(),
    envelopeRevision: uuid("envelopeRevision").notNull().defaultRandom(),
    harnessId: varchar("harnessId", { length: 32 }).notNull(),
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    iv: text("iv").notNull(),
    kekVersion: varchar("kekVersion", { length: 32 }).notNull().default("v1"),
    tenant: varchar("tenant", { length: 64 }).notNull(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
    wrappedKey: text("wrappedKey").notNull(),
  },
  (table) => [
    uniqueIndex("TenantCredential_tenant_harness_idx").on(
      table.tenant,
      table.harnessId
    ),
    check(
      "TenantCredential_kekVersion_valid",
      sql`${table.kekVersion} ~ '^[A-Za-z0-9_-]{1,32}$'`
    ),
    check(
      "TenantCredential_aadVersion_valid",
      sql`${table.aadVersion} in (0, 1)`
    ),
  ]
);

export type TenantCredential = InferSelectModel<typeof tenantCredential>;

/**
 * One row per counted run.
 *
 * The unique index is the counter's correctness, not an optimisation. The
 * runner may prepare a credential more than once for one run during retry or
 * recovery, and counting per preparation would bill a customer for internal
 * behavior.
 */
export const runUsage = pgTable(
  "RunUsage",
  {
    countedAt: timestamp("countedAt").notNull().defaultNow(),
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    runId: varchar("runId", { length: 64 }).notNull(),
    tenant: varchar("tenant", { length: 64 }).notNull(),
  },
  (table) => [
    uniqueIndex("RunUsage_tenant_run_idx").on(table.tenant, table.runId),
    index("RunUsage_countedAt_idx").on(table.countedAt),
    index("RunUsage_tenant_countedAt_idx").on(table.tenant, table.countedAt),
  ]
);

export type RunUsage = InferSelectModel<typeof runUsage>;

/**
 * One atomic admission claim for a run before a credential is decrypted.
 *
 * `tenantHash` is an HMAC pseudonym, never the raw tenant identifier.
 * `periodMonth` retains the historical name from the budget design, but its
 * value is the subscriber's billing-period start rather than a calendar month.
 */
export const runReservation = pgTable(
  "RunReservation",
  {
    consumedAt: timestamp("consumedAt"),
    costUnits: integer("costUnits").notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    periodDay: date("periodDay").notNull(),
    periodMonth: timestamp("periodMonth").notNull(),
    releasedAt: timestamp("releasedAt"),
    reservedAt: timestamp("reservedAt").notNull().defaultNow(),
    runId: varchar("runId", { length: 64 }).primaryKey().notNull(),
    state: varchar("state", {
      enum: ["reserved", "consumed", "released"],
      length: 16,
    })
      .notNull()
      .default("reserved"),
    tenantHash: varchar("tenantHash", { length: 64 }).notNull(),
  },
  (table) => [
    index("RunReservation_tenant_day_state_idx").on(
      table.tenantHash,
      table.periodDay,
      table.state
    ),
    index("RunReservation_day_state_idx").on(table.periodDay, table.state),
    index("RunReservation_tenant_period_state_idx").on(
      table.tenantHash,
      table.periodMonth,
      table.state
    ),
    index("RunReservation_reserved_expiry_idx")
      .on(table.expiresAt)
      .where(sql`${table.state} = 'reserved'`),
    check("RunReservation_costUnits_positive", sql`${table.costUnits} > 0`),
    check(
      "RunReservation_state_valid",
      sql`${table.state} in ('reserved', 'consumed', 'released')`
    ),
    check(
      "RunReservation_state_timestamps_valid",
      sql`(${table.state} = 'reserved' and ${table.consumedAt} is null and ${table.releasedAt} is null) or (${table.state} = 'consumed' and ${table.consumedAt} is not null and ${table.releasedAt} is null) or (${table.state} = 'released' and ${table.consumedAt} is null and ${table.releasedAt} is not null)`
    ),
    check(
      "RunReservation_expiry_valid",
      sql`${table.expiresAt} > ${table.reservedAt}`
    ),
  ]
);

export type RunReservation = InferSelectModel<typeof runReservation>;

/**
 * One short-lived, one-use capability to decrypt a credential for one run.
 *
 * Raw tenant and request identifiers are never stored. `runId` is unique so a
 * caller cannot mint fresh request ids to borrow the same credential twice.
 */
export const credentialLease = pgTable(
  "CredentialLease",
  {
    consumedAt: timestamp("consumedAt"),
    expiresAt: timestamp("expiresAt").notNull(),
    harnessId: varchar("harnessId", { length: 64 }).notNull(),
    issuedAt: timestamp("issuedAt").notNull().defaultNow(),
    operationIdHash: varchar("operationIdHash", { length: 64 })
      .notNull()
      .unique(),
    requestIdHash: varchar("requestIdHash", { length: 64 })
      .primaryKey()
      .notNull(),
    runId: varchar("runId", { length: 64 }).notNull(),
    tenantHash: varchar("tenantHash", { length: 64 }).notNull(),
  },
  (table) => [
    uniqueIndex("CredentialLease_run_idx").on(table.runId),
    index("CredentialLease_expiry_idx").on(table.expiresAt),
    check(
      "CredentialLease_expiry_valid",
      sql`${table.expiresAt} > ${table.issuedAt}`
    ),
    check(
      "CredentialLease_consumption_valid",
      sql`${table.consumedAt} is null or (${table.consumedAt} >= ${table.issuedAt} and ${table.consumedAt} < ${table.expiresAt})`
    ),
  ]
);

export type CredentialLease = InferSelectModel<typeof credentialLease>;

/**
 * Stripe event ids already processed.
 *
 * Stripe retries delivery, so a replayed `invoice.paid` would otherwise extend
 * a subscription twice. The primary key is the event id: inserting IS the
 * idempotency check, rather than a lookup that races a second delivery.
 */
export const stripeEvent = pgTable("StripeEvent", {
  id: varchar("id", { length: 64 }).primaryKey().notNull(),
  processedAt: timestamp("processedAt").notNull().defaultNow(),
});

export type StripeEvent = InferSelectModel<typeof stripeEvent>;

/**
 * One durable claim for a costly request.
 *
 * The scoped unique index is the concurrency boundary: only one request for
 * an owner, operation, and hashed browser key may reach its provider. The
 * expiry is also the claim lease while work is in progress, so a dead process
 * can be reclaimed without allowing a stale completion to overwrite its
 * replacement.
 */
export const idempotencyRecord = pgTable(
  "IdempotencyRecord",
  {
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    expiresAt: timestamp("expiresAt").notNull(),
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    keyHash: text("keyHash").notNull(),
    operation: varchar("operation", { length: 64 }).notNull(),
    ownerId: uuid("ownerId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    requestHash: text("requestHash").notNull(),
    responseJson:
      jsonb("responseJson").$type<StoredIdempotencyResponseEnvelope>(),
    responseStatus: integer("responseStatus"),
    state: varchar("state", {
      enum: ["in_progress", "completed"],
      length: 16,
    })
      .notNull()
      .default("in_progress"),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("IdempotencyRecord_owner_operation_key_idx").on(
      table.ownerId,
      table.operation,
      table.keyHash
    ),
    index("IdempotencyRecord_expiresAt_idx").on(table.expiresAt),
    check(
      "IdempotencyRecord_state_check",
      sql`${table.state} in ('in_progress', 'completed')`
    ),
    check(
      "IdempotencyRecord_response_state_check",
      sql`(${table.state} = 'in_progress' and ${table.responseJson} is null and ${table.responseStatus} is null) or (${table.state} = 'completed' and ${table.responseJson} is not null and jsonb_typeof(${table.responseJson}) = 'object' and ${table.responseJson}->>'kind' in ('plain_json', 'encrypted_json') and ${table.responseStatus} is not null and ${table.responseStatus} between 200 and 299)`
    ),
  ]
);

export type IdempotencyRecord = InferSelectModel<typeof idempotencyRecord>;

export const runnerAgent = pgTable(
  "RunnerAgent",
  {
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    daytonaSandboxId: text("daytonaSandboxId"),
    description: varchar("description", { length: 240 }).notNull().default(""),
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    instructions: varchar("instructions", {
      length: AGENT_RUNNER_LIMITS.maxInstructionsLength,
    }).notNull(),
    lastRunAt: timestamp("lastRunAt"),
    model: varchar("model", {
      length: AGENT_RUNNER_LIMITS.maxModelLength,
    }).notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    runtime: varchar("runtime", {
      enum: ["codex", "claude", "copilot"],
      length: 16,
    }).notNull(),
    sandboxGeneration: integer("sandboxGeneration").notNull().default(0),
    sandboxLifecycle: varchar("sandboxLifecycle", {
      enum: [
        "unprovisioned",
        "provisioning",
        "provisioning_ambiguous",
        "ready",
        "resetting",
        "decommissioning",
        "decommission_failed",
      ],
      length: 24,
    })
      .notNull()
      .default("unprovisioned"),
    sandboxUpdatedAt: timestamp("sandboxUpdatedAt").notNull().defaultNow(),
    status: varchar("status", {
      enum: ["idle", "running", "error"],
      length: 16,
    })
      .notNull()
      .default("idle"),
    tenant: varchar("tenant", { length: 64 }).notNull(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
    version: integer("version").notNull().default(0),
    warmAttemptVersion: integer("warmAttemptVersion").notNull().default(0),
    warmStatus: varchar("warmStatus", {
      enum: ["not_started", "provisioning", "ready", "failed"],
      length: 16,
    })
      .notNull()
      .default("not_started"),
    warmUpdatedAt: timestamp("warmUpdatedAt").notNull().defaultNow(),
    workspace: varchar("workspace", {
      length: AGENT_RUNNER_LIMITS.maxWorkspaceLength,
    }),
  },
  (table) => [
    unique("RunnerAgent_id_tenant_key").on(table.id, table.tenant),
    index("RunnerAgent_tenant_updatedAt_idx").on(table.tenant, table.updatedAt),
    index("RunnerAgent_sandbox_recovery_idx")
      .on(table.sandboxLifecycle, table.sandboxUpdatedAt)
      .where(
        sql`${table.sandboxLifecycle} in ('provisioning', 'provisioning_ambiguous', 'resetting', 'decommissioning')`
      ),
    index("RunnerAgent_warm_recovery_idx")
      .on(table.warmUpdatedAt, table.id)
      .where(
        sql`${table.sandboxLifecycle} = 'ready' and ${table.warmStatus} = 'provisioning'`
      ),
    check(
      "RunnerAgent_tenant_valid",
      sql`${table.tenant} ~ '^[A-Za-z0-9_]{1,64}$'`
    ),
    check(
      "RunnerAgent_runtime_valid",
      sql`${table.runtime} in ('codex', 'claude', 'copilot')`
    ),
    check(
      "RunnerAgent_status_valid",
      sql`${table.status} in ('idle', 'running', 'error')`
    ),
    check(
      "RunnerAgent_sandboxLifecycle_valid",
      sql`${table.sandboxLifecycle} in ('unprovisioned', 'provisioning', 'provisioning_ambiguous', 'ready', 'resetting', 'decommissioning', 'decommission_failed')`
    ),
    check(
      "RunnerAgent_warmStatus_valid",
      sql`${table.warmStatus} in ('not_started', 'provisioning', 'ready', 'failed')`
    ),
    check(
      "RunnerAgent_sandboxGeneration_nonnegative",
      sql`${table.sandboxGeneration} >= 0`
    ),
    check("RunnerAgent_version_nonnegative", sql`${table.version} >= 0`),
    check(
      "RunnerAgent_warmAttemptVersion_nonnegative",
      sql`${table.warmAttemptVersion} >= 0`
    ),
  ]
);

export type RunnerAgent = InferSelectModel<typeof runnerAgent>;

export const runnerRun = pgTable(
  "RunnerRun",
  {
    agentId: uuid("agentId").notNull(),
    authVersion: integer("authVersion"),
    cancellationRequestedAt: timestamp("cancellationRequestedAt"),
    commandEvidence: jsonb("commandEvidence")
      .$type<CommandEvidence[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    daytonaAttemptId: varchar("daytonaAttemptId", {
      length: 36,
    }),
    daytonaCommandId: text("daytonaCommandId"),
    daytonaLogCursor: integer("daytonaLogCursor").notNull().default(0),
    daytonaSessionId: text("daytonaSessionId"),
    dispatchLeaseExpiresAt: timestamp("dispatchLeaseExpiresAt"),
    dispatchLeaseToken: varchar("dispatchLeaseToken", { length: 80 }),
    dispatchState: varchar("dispatchState", {
      enum: ["queued", "dispatching", "running", "terminal"],
      length: 16,
    })
      .notNull()
      .default("queued"),
    error: jsonb("error").$type<RunError>(),
    fileEvidence: jsonb("fileEvidence")
      .$type<FileEvidence[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    logCursor: integer("logCursor").notNull().default(0),
    operationId: uuid("operationId").notNull(),
    output: text("output").notNull().default(""),
    queueSequence: integer("queueSequence")
      .generatedAlwaysAsIdentity()
      .notNull(),
    requestHash: varchar("requestHash", { length: 64 }).notNull(),
    startedAt: timestamp("startedAt"),
    status: varchar("status", {
      enum: ["queued", "running", "completed", "failed", "cancelled"],
      length: 16,
    })
      .notNull()
      .default("queued"),
    task: varchar("task", {
      length: AGENT_RUNNER_LIMITS.maxTaskLength,
    }).notNull(),
    tenant: varchar("tenant", { length: 64 }).notNull(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
    version: integer("version").notNull().default(0),
  },
  (table) => [
    foreignKey({
      columns: [table.agentId, table.tenant],
      foreignColumns: [runnerAgent.id, runnerAgent.tenant],
      name: "RunnerRun_agentId_tenant_RunnerAgent_id_tenant_fk",
    }).onDelete("cascade"),
    index("RunnerRun_agent_createdAt_idx").on(table.agentId, table.createdAt),
    index("RunnerRun_queued_sequence_idx")
      .on(table.queueSequence)
      .where(sql`${table.dispatchState} = 'queued'`),
    uniqueIndex("RunnerRun_queueSequence_unique_idx").on(table.queueSequence),
    index("RunnerRun_active_tenant_idx")
      .on(table.tenant, table.status)
      .where(sql`${table.status} in ('queued', 'running')`),
    index("RunnerRun_expired_dispatch_lease_idx")
      .on(table.dispatchLeaseExpiresAt)
      .where(
        sql`${table.dispatchLeaseToken} is not null and ${table.dispatchState} in ('dispatching', 'running')`
      ),
    index("RunnerRun_terminal_retention_idx")
      .on(table.agentId, table.completedAt)
      .where(sql`${table.status} in ('completed', 'failed', 'cancelled')`),
    index("RunnerRun_terminal_attempt_cleanup_idx")
      .on(table.dispatchLeaseExpiresAt)
      .where(
        sql`${table.dispatchState} = 'terminal' and ${table.daytonaAttemptId} is not null and ${table.dispatchLeaseToken} is not null`
      ),
    uniqueIndex("RunnerRun_agent_operation_idx").on(
      table.agentId,
      table.operationId
    ),
    uniqueIndex("RunnerRun_daytonaSessionId_live_idx")
      .on(table.daytonaSessionId)
      .where(
        sql`${table.daytonaSessionId} is not null and ${table.status} in ('queued', 'running')`
      ),
    uniqueIndex("RunnerRun_daytonaCommandId_live_idx")
      .on(table.daytonaCommandId)
      .where(
        sql`${table.daytonaCommandId} is not null and ${table.status} in ('queued', 'running')`
      ),
    check(
      "RunnerRun_tenant_valid",
      sql`${table.tenant} ~ '^[A-Za-z0-9_]{1,64}$'`
    ),
    check(
      "RunnerRun_status_valid",
      sql`${table.status} in ('queued', 'running', 'completed', 'failed', 'cancelled')`
    ),
    check(
      "RunnerRun_dispatchState_valid",
      sql`${table.dispatchState} in ('queued', 'dispatching', 'running', 'terminal')`
    ),
    check("RunnerRun_queueSequence_positive", sql`${table.queueSequence} > 0`),
    check("RunnerRun_logCursor_nonnegative", sql`${table.logCursor} >= 0`),
    check(
      "RunnerRun_daytonaLogCursor_nonnegative",
      sql`${table.daytonaLogCursor} >= 0`
    ),
    check("RunnerRun_version_nonnegative", sql`${table.version} >= 0`),
    check(
      "RunnerRun_authVersion_valid",
      sql`${table.authVersion} is null or ${table.authVersion} >= 0`
    ),
    check(
      "RunnerRun_timestamps_valid",
      sql`(${table.status} = 'queued' and ${table.startedAt} is null and ${table.completedAt} is null) or (${table.status} = 'running' and ${table.startedAt} is not null and ${table.completedAt} is null and ${table.startedAt} >= ${table.createdAt}) or (${table.status} in ('completed', 'failed', 'cancelled') and ${table.completedAt} is not null and ${table.completedAt} >= ${table.createdAt} and (${table.startedAt} is null or (${table.startedAt} >= ${table.createdAt} and ${table.completedAt} >= ${table.startedAt})))`
    ),
    check(
      "RunnerRun_dispatchLease_valid",
      sql`(${table.dispatchState} = 'queued' and ${table.status} = 'queued' and ${table.dispatchLeaseToken} is null and ${table.dispatchLeaseExpiresAt} is null) or (${table.dispatchState} = 'dispatching' and ${table.status} = 'queued' and ${table.dispatchLeaseToken} is not null and ${table.dispatchLeaseExpiresAt} is not null and ${table.dispatchLeaseExpiresAt} > ${table.createdAt}) or (${table.dispatchState} = 'running' and ${table.status} = 'running' and ${table.dispatchLeaseToken} is not null and ${table.dispatchLeaseExpiresAt} is not null and ${table.dispatchLeaseExpiresAt} > ${table.createdAt}) or (${table.dispatchState} = 'terminal' and ${table.status} in ('completed', 'failed', 'cancelled') and ((${table.dispatchLeaseToken} is null and ${table.dispatchLeaseExpiresAt} is null) or (${table.dispatchLeaseToken} is not null and ${table.dispatchLeaseExpiresAt} is not null)))`
    ),
    check(
      "RunnerRun_output_bounded",
      sql`char_length(${table.output}) <= ${runnerMaxEventOutputLengthSql}`
    ),
    check(
      "RunnerRun_error_bounded",
      sql`${table.error} is null or (jsonb_typeof(${table.error}) = 'object' and ${table.error} ?& array['code', 'message', 'retryable'] and (${table.error} - 'code' - 'message' - 'retryable' - 'details') = '{}'::jsonb and jsonb_typeof(${table.error}->'code') = 'string' and (${table.error}->>'code') = btrim(${table.error}->>'code') and char_length(${table.error}->>'code') between 1 and 64 and jsonb_typeof(${table.error}->'message') = 'string' and (${table.error}->>'message') = btrim(${table.error}->>'message') and char_length(${table.error}->>'message') between 1 and ${runnerMaxMessageLengthSql} and jsonb_typeof(${table.error}->'retryable') = 'boolean' and (not (${table.error} ? 'details') or (jsonb_typeof(${table.error}->'details') = 'string' and (${table.error}->>'details') = btrim(${table.error}->>'details') and char_length(${table.error}->>'details') between 1 and ${runnerMaxDetailsLengthSql})))`
    ),
    check(
      "RunnerRun_commandEvidence_bounded",
      sql`jsonb_typeof(${table.commandEvidence}) = 'array' and jsonb_array_length(${table.commandEvidence}) <= ${runnerMaxCommandResultsSql}`
    ),
    check(
      "RunnerRun_fileEvidence_bounded",
      sql`jsonb_typeof(${table.fileEvidence}) = 'array' and jsonb_array_length(${table.fileEvidence}) <= ${runnerMaxFileOperationsSql}`
    ),
    check(
      "RunnerRun_daytonaCommand_requires_session",
      sql`${table.daytonaCommandId} is null or ${table.daytonaSessionId} is not null`
    ),
    check(
      "RunnerRun_daytonaSession_requires_attempt",
      sql`${table.daytonaSessionId} is null or ${table.daytonaAttemptId} is not null`
    ),
    check(
      "RunnerRun_daytonaAttempt_valid",
      sql`${table.daytonaAttemptId} is null or ${table.daytonaAttemptId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`
    ),
  ]
);

export type RunnerRun = InferSelectModel<typeof runnerRun>;

/**
 * Attempt-scoped encrypted material used solely to redact later Daytona logs.
 * It intentionally has no plaintext or public runner-record projection.
 */
export const runnerAttemptRedaction = pgTable(
  "RunnerAttemptRedaction",
  {
    aadVersion: integer("aadVersion").notNull(),
    attemptId: varchar("attemptId", { length: 36 }).notNull().unique(),
    ciphertext: text("ciphertext").notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    iv: varchar("iv", { length: 64 }).notNull(),
    kekVersion: varchar("kekVersion", { length: 32 }).notNull(),
    runId: uuid("runId")
      .primaryKey()
      .notNull()
      .references(() => runnerRun.id, { onDelete: "cascade" }),
    wrappedKey: varchar("wrappedKey", { length: 128 }).notNull(),
  },
  (table) => [
    check(
      "RunnerAttemptRedaction_aadVersion_valid",
      sql`${table.aadVersion} = 1`
    ),
    check(
      "RunnerAttemptRedaction_attemptId_valid",
      sql`${table.attemptId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`
    ),
    check(
      "RunnerAttemptRedaction_envelope_nonempty",
      sql`char_length(${table.ciphertext}) > 0 and char_length(${table.iv}) > 0 and char_length(${table.kekVersion}) > 0 and char_length(${table.wrappedKey}) > 0`
    ),
  ]
);

export type RunnerAttemptRedaction = InferSelectModel<
  typeof runnerAttemptRedaction
>;

export const runnerRunEvent = pgTable(
  "RunnerRunEvent",
  {
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    event: jsonb("event").$type<RunEvent>().notNull(),
    eventId: integer("eventId").notNull(),
    runId: uuid("runId")
      .notNull()
      .references(() => runnerRun.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.eventId] }),
    check("RunnerRunEvent_eventId_nonnegative", sql`${table.eventId} >= 0`),
    check(
      "RunnerRunEvent_event_object",
      sql`jsonb_typeof(${table.event}) = 'object'`
    ),
  ]
);

export type RunnerRunEvent = InferSelectModel<typeof runnerRunEvent>;

export const runnerScheduler = pgTable(
  "RunnerScheduler",
  {
    consecutiveDispatchCount: integer("consecutiveDispatchCount")
      .notNull()
      .default(0),
    lastDispatchedTenantHash: varchar("lastDispatchedTenantHash", {
      length: 67,
    }),
    reconciliationLeaseExpiresAt: timestamp("reconciliationLeaseExpiresAt"),
    reconciliationLeaseFence: bigint("reconciliationLeaseFence", {
      mode: "number",
    })
      .notNull()
      .default(0),
    reconciliationLeaseOwner: varchar("reconciliationLeaseOwner", {
      length: 128,
    }),
    singleton: boolean("singleton").primaryKey().notNull().default(true),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (table) => [
    check("RunnerScheduler_singleton", sql`${table.singleton} = true`),
    check(
      "RunnerScheduler_consecutiveDispatchCount_nonnegative",
      sql`${table.consecutiveDispatchCount} >= 0`
    ),
    check(
      "RunnerScheduler_reconciliationLeaseFence_nonnegative",
      sql`${table.reconciliationLeaseFence} >= 0`
    ),
    check(
      "RunnerScheduler_reconciliationLease_pair",
      sql`(${table.reconciliationLeaseOwner} is null and ${table.reconciliationLeaseExpiresAt} is null) or (${table.reconciliationLeaseOwner} is not null and ${table.reconciliationLeaseExpiresAt} is not null)`
    ),
  ]
);

export type RunnerScheduler = InferSelectModel<typeof runnerScheduler>;
