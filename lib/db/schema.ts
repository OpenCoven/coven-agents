import {
  AGENT_RUNNER_LIMITS,
  type CommandEvidence,
  type FileEvidence,
  GITHUB_NODE_ID_CHARACTERS,
  GITHUB_NODE_ID_MAX_LENGTH,
  GITHUB_NODE_ID_MIN_LENGTH,
  type GitHubOperationKind,
  type GitHubToolResult,
  type RunError,
  type RunEvent,
  TEAM_LIMITS,
  type TeamCapability,
  type TeamHandoff,
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
import {
  STRIPE_RECONCILIATION_EVENT_TYPES,
  STRIPE_RECONCILIATION_REASONS,
  STRIPE_RECONCILIATION_STATUSES,
} from "../billing/stripe-reconciliation";
import type {
  GitHubAppRepositoryPermission,
  GitHubUserRepositoryPermission,
} from "../github/authority-types";
import type { GitHubBrokerPolicy } from "../github/capability";
import type { RunnerExecutionProvenance } from "../runner/execution-provenance";

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
const teamMaxPersistedHandoffLengthSql = sql.raw("24576");
const teamMaxMembersSql = sql.raw(String(TEAM_LIMITS.maxMembers));
const teamMaxSkillsPerMemberSql = sql.raw(
  String(TEAM_LIMITS.maxSkillsPerMember)
);
const githubNodeIdMinSql = sql.raw(String(GITHUB_NODE_ID_MIN_LENGTH));
const githubNodeIdMaxSql = sql.raw(String(GITHUB_NODE_ID_MAX_LENGTH));
const githubNodeIdCharactersSql = sql.raw(`'^${GITHUB_NODE_ID_CHARACTERS}+$'`);
// PostgreSQL caps a repetition count at 255: 1..255 plus one optional
// character accepts exactly 1..256, matching the shared TypeScript limit.
const githubProjectIdsPathSql = sql.raw(
  `'strict $[*] ? (@.type() != "string" || !(@ like_regex "^${GITHUB_NODE_ID_CHARACTERS}{${GITHUB_NODE_ID_MIN_LENGTH},${GITHUB_NODE_ID_MAX_LENGTH - 1}}${GITHUB_NODE_ID_CHARACTERS}?$"))'`
);

type RunnerTeamSkillSnapshot = {
  description: string;
  id: string;
  instructions: string;
  name: string;
  requiredCapabilities: TeamCapability[];
};

export const user = pgTable(
  "User",
  {
    authVersion: integer("authVersion").notNull().default(0),
    billingPeriodStart: timestamp("billingPeriodStart"),
    /**
     * When this user's open-beta campaign minutes stop being spendable, and
     * when they were granted. Both null means never enrolled.
     *
     * Deliberately not `subscribedUntil`. A campaign participant is entitled
     * but has paid nothing, and reusing the subscription column would make
     * them indistinguishable from a payer in `subscription-status`,
     * `admin/directory` and Stripe reconciliation -- which would eventually
     * find a subscription date with no Stripe subscription behind it and have
     * to guess which of the two was wrong.
     *
     * `campaignGrantedAt` is kept rather than derived from the expiry because
     * it is what the enrollment cap counts, and it survives a policy change to
     * `BETA_CAMPAIGN_GRANT_DAYS` that would otherwise rewrite history.
     */
    campaignExpiresAt: timestamp("campaignExpiresAt"),
    campaignGrantedAt: timestamp("campaignGrantedAt"),
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
    subscriptionOverrideAction: varchar("subscriptionOverrideAction", {
      enum: ["grant", "revoke"],
      length: 6,
    }),
    subscriptionOverrideAt: timestamp("subscriptionOverrideAt"),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("User_stripeCustomerId_idx").on(table.stripeCustomerId),
    check(
      "User_subscriptionOverride_shape",
      sql`(${table.subscriptionOverrideAction} is null and ${table.subscriptionOverrideAt} is null) or (${table.subscriptionOverrideAction} in ('grant', 'revoke') and ${table.subscriptionOverrideAt} is not null and isfinite(${table.subscriptionOverrideAt}))`
    ),
    /**
     * Half a grant is not a grant. Enrollment counts rows where
     * `campaignGrantedAt` is set and entitlement reads `campaignExpiresAt`, so
     * a row carrying one without the other would be counted against the global
     * cap while granting nothing, or grant minutes nothing is counting.
     */
    check(
      "User_campaignGrant_shape",
      sql`(${table.campaignGrantedAt} is null and ${table.campaignExpiresAt} is null) or (${table.campaignGrantedAt} is not null and ${table.campaignExpiresAt} is not null and isfinite(${table.campaignGrantedAt}) and isfinite(${table.campaignExpiresAt}) and ${table.campaignExpiresAt} > ${table.campaignGrantedAt})`
    ),
    /**
     * Partial: the global enrollment cap counts only enrolled rows, and the
     * index stays the size of the campaign rather than the size of the user
     * table.
     */
    index("User_campaignGrantedAt_idx")
      .on(table.campaignGrantedAt)
      .where(sql`${table.campaignGrantedAt} is not null`),
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
 *
 * Units are minutes of run time. `reservedUnits` is what admission held, the
 * runner's execution time limit; `costUnits` is what the tenant is charged,
 * which starts equal and is settled down to the whole minutes the run used
 * once terminal cleanup knows when it started and ended. Settlement can only
 * lower the charge — the check constraint makes that a database invariant.
 */
export const runReservation = pgTable(
  "RunReservation",
  {
    consumedAt: timestamp("consumedAt"),
    costUnits: integer("costUnits").notNull(),
    durationSeconds: integer("durationSeconds"),
    expiresAt: timestamp("expiresAt").notNull(),
    /**
     * The monthly bucket admission judged this run against, retained for audit.
     * Pack accounting uses RunPackDraw, never this cap or a later policy.
     * Null on rows admitted before the cap was recorded.
     */
    monthlyCap: integer("monthlyCap"),
    periodDay: date("periodDay").notNull(),
    periodMonth: timestamp("periodMonth").notNull(),
    releasedAt: timestamp("releasedAt"),
    reservedAt: timestamp("reservedAt").notNull().defaultNow(),
    reservedUnits: integer("reservedUnits").notNull(),
    runId: varchar("runId", { length: 64 }).primaryKey().notNull(),
    settledAt: timestamp("settledAt"),
    state: varchar("state", {
      enum: ["reserved", "consumed", "released"],
      length: 16,
    })
      .notNull()
      .default("reserved"),
    tenantHash: varchar("tenantHash", { length: 64 }).notNull(),
    /**
     * The account whose packs this run may draw on. Packs are bought per
     * account, so consumption is keyed the same way; `tenantHash` is an HMAC
     * that changes with the abuse key and only bounds abuse buckets. Null
     * for demo tenants, which own no account, and on rows admitted before
     * the account was recorded.
     */
    userId: uuid("userId").references(() => user.id, { onDelete: "set null" }),
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
    index("RunReservation_user_period_state_idx").on(
      table.userId,
      table.periodMonth,
      table.state
    ),
    check(
      "RunReservation_monthlyCap_positive",
      sql`${table.monthlyCap} is null or ${table.monthlyCap} > 0`
    ),
    index("RunReservation_reserved_expiry_idx")
      .on(table.expiresAt)
      .where(sql`${table.state} = 'reserved'`),
    check("RunReservation_costUnits_positive", sql`${table.costUnits} > 0`),
    check(
      "RunReservation_costUnits_within_reserved",
      sql`${table.costUnits} <= ${table.reservedUnits}`
    ),
    check(
      "RunReservation_settlement_valid",
      sql`(${table.settledAt} is null and ${table.durationSeconds} is null) or (${table.settledAt} is not null and ${table.durationSeconds} is not null and ${table.durationSeconds} >= 0)`
    ),
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

/** An account-keyed pack allocation, held by a reservation and charged on consumption. */
export const runPackDraw = pgTable(
  "RunPackDraw",
  {
    minutes: integer("minutes").notNull(),
    reservedMinutes: integer("reservedMinutes").notNull(),
    runId: varchar("runId", { length: 64 })
      .primaryKey()
      .references(() => runReservation.runId, { onDelete: "cascade" }),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("RunPackDraw_user_idx").on(table.userId),
    check(
      "RunPackDraw_minutes_valid",
      sql`${table.minutes} >= 0 and ${table.minutes} <= ${table.reservedMinutes}`
    ),
    check(
      "RunPackDraw_reservedMinutes_valid",
      sql`${table.reservedMinutes} >= 0`
    ),
  ]
);

/**
 * One paid top-up of minutes.
 *
 * The Checkout Session id is unique so a redelivered `checkout.session.completed`
 * credits once, independently of the `StripeEvent` claim. Minutes are copied
 * from the pack configuration at credit time, never from Stripe metadata, so a
 * later change to the configured packs cannot re-price a past purchase.
 */
export const minutePack = pgTable(
  "MinutePack",
  {
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    minutes: integer("minutes").notNull(),
    // "price_" plus the 60 characters every validator accepts.
    priceId: varchar("priceId", { length: 66 }).notNull(),
    purchasedAt: timestamp("purchasedAt").notNull().defaultNow(),
    stripeCheckoutSessionId: varchar("stripeCheckoutSessionId", {
      length: 128,
    }).notNull(),
    stripePaymentIntentId: varchar("stripePaymentIntentId", { length: 64 }),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("MinutePack_session_idx").on(table.stripeCheckoutSessionId),
    index("MinutePack_user_idx").on(table.userId),
    check("MinutePack_minutes_positive", sql`${table.minutes} > 0`),
  ]
);

export type MinutePack = InferSelectModel<typeof minutePack>;

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
 * Sanitized operator evidence for Stripe events that cannot be applied
 * automatically.
 *
 * The event id is both the primary key and the only provider identifier
 * retained here. User, Customer, Subscription, payload, and free-form fields
 * are deliberately absent.
 */
export const stripeReconciliation = pgTable(
  "StripeReconciliation",
  {
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    eventId: varchar("eventId", { length: 64 })
      .primaryKey()
      .notNull()
      .references(() => stripeEvent.id, { onDelete: "restrict" }),
    eventType: varchar("eventType", {
      enum: STRIPE_RECONCILIATION_EVENT_TYPES,
      // "checkout.session.async_payment_succeeded" is 40 characters.
      length: 48,
    }).notNull(),
    reason: varchar("reason", {
      enum: STRIPE_RECONCILIATION_REASONS,
      length: 64,
    }).notNull(),
    status: varchar("status", {
      enum: STRIPE_RECONCILIATION_STATUSES,
      length: 16,
    })
      .notNull()
      .default("pending"),
  },
  (table) => [
    check(
      "StripeReconciliation_eventType_check",
      sql`${table.eventType} in ('checkout.session.async_payment_succeeded', 'checkout.session.completed', 'invoice.paid', 'invoice.payment_failed')`
    ),
    check(
      "StripeReconciliation_reason_check",
      sql`${table.reason} in ('invoice_ambiguous_entitlement', 'invoice_conflicting_paid_interval', 'invoice_contradictory_subscription', 'invoice_invalid_period', 'invoice_invalid_reference', 'minute_pack_minutes_mismatch', 'minute_pack_owner_mismatch', 'minute_pack_unconfigured')`
    ),
    check(
      "StripeReconciliation_status_check",
      sql`${table.status} in ('pending', 'acknowledged', 'resolved')`
    ),
  ]
);

export type StripeReconciliation = InferSelectModel<
  typeof stripeReconciliation
>;

/**
 * Singleton lease and cursor for bounded automatic Stripe reconciliation.
 *
 * This contains coordination metadata only. In particular, it deliberately
 * retains no provider payloads or identifiers beyond the local User cursor.
 */
export const stripeReconciliationRun = pgTable(
  "StripeReconciliationRun",
  {
    cursor: uuid("cursor"),
    id: integer("id").primaryKey().notNull(),
    leaseExpiresAt: timestamp("leaseExpiresAt"),
    leaseFence: integer("leaseFence").notNull().default(0),
    leaseOwner: varchar("leaseOwner", { length: 64 }),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (table) => [
    check("StripeReconciliationRun_singleton", sql`${table.id} = 1`),
    check(
      "StripeReconciliationRun_fence_nonnegative",
      sql`${table.leaseFence} >= 0`
    ),
    check(
      "StripeReconciliationRun_lease_shape",
      sql`(${table.leaseOwner} is null and ${table.leaseExpiresAt} is null) or (${table.leaseOwner} is not null and ${table.leaseExpiresAt} is not null)`
    ),
  ]
);

export type StripeReconciliationRun = InferSelectModel<
  typeof stripeReconciliationRun
>;

export const subscriptionOverrideAudit = pgTable(
  "SubscriptionOverrideAudit",
  {
    action: varchar("action", {
      enum: ["grant", "revoke"],
      length: 6,
    }).notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    newAuthVersion: integer("newAuthVersion").notNull(),
    newSubscribedUntil: timestamp("newSubscribedUntil"),
    previousAuthVersion: integer("previousAuthVersion").notNull(),
    previousSubscribedUntil: timestamp("previousSubscribedUntil"),
    referenceDigest: varchar("referenceDigest", { length: 64 }).notNull(),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
  },
  (table) => [
    index("SubscriptionOverrideAudit_user_createdAt_idx").on(
      table.userId,
      table.createdAt
    ),
    check(
      "SubscriptionOverrideAudit_action_check",
      sql`${table.action} in ('grant', 'revoke')`
    ),
    check(
      "SubscriptionOverrideAudit_referenceDigest_check",
      sql`${table.referenceDigest} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "SubscriptionOverrideAudit_authVersion_check",
      sql`${table.previousAuthVersion} >= 0 and ${table.newAuthVersion} = ${table.previousAuthVersion} + 1`
    ),
    check(
      "SubscriptionOverrideAudit_paidThrough_check",
      sql`(${table.action} = 'grant' and ${table.newSubscribedUntil} is not null) or (${table.action} = 'revoke' and ${table.newSubscribedUntil} is null)`
    ),
  ]
);

export type SubscriptionOverrideAudit = InferSelectModel<
  typeof subscriptionOverrideAudit
>;

/**
 * One durable claim for a costly request.
 *
 * The scoped unique index is the concurrency boundary: only one request for
 * an owner, operation, and hashed browser key may reach its provider. The
 * expiry is also the claim lease while work is in progress, so a dead process
 * can be reclaimed without allowing a stale completion to overwrite its
 * replacement. The checkout-attempt scope additionally keeps `id` stable as
 * the provider-attempt identity. While leased, `requestHash` carries the
 * ownership token plus the latest bounded provider-reconciliation checkpoint;
 * between leases it stores that reconciliation state alone.
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
    familiarId: varchar("familiarId", {
      enum: [
        "auto",
        "builder",
        "critic",
        "custom",
        "scout",
        "scribe",
        "tester",
      ],
      length: 16,
    })
      .notNull()
      .default("auto"),
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    instructions: varchar("instructions", {
      length: AGENT_RUNNER_LIMITS.maxInstructionsLength,
    }).notNull(),
    lastRunAt: timestamp("lastRunAt"),
    model: varchar("model", {
      length: AGENT_RUNNER_LIMITS.maxModelLength,
    }).notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    ownerWorkspaceRead: boolean("ownerWorkspaceRead").notNull().default(false),
    pinnedSandboxGeneration: integer("pinnedSandboxGeneration"),
    pinnedSandboxId: varchar("pinnedSandboxId", { length: 128 }),
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
        "resizing",
        "resetting",
        "decommissioning",
        "decommission_failed",
      ],
      length: 24,
    })
      .notNull()
      .default("unprovisioned"),
    sandboxTrust: varchar("sandboxTrust", {
      enum: ["clean", "restricted", "unrestricted"],
      length: 16,
    })
      .notNull()
      .default("clean"),
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
    unique("RunnerAgent_pinnedSandboxId_key").on(table.pinnedSandboxId),
    check(
      "RunnerAgent_pinnedSandbox_valid",
      sql`(${table.pinnedSandboxId} IS NULL AND ${table.pinnedSandboxGeneration} IS NULL) OR (${table.pinnedSandboxId} IS NOT NULL AND ${table.pinnedSandboxGeneration} IS NOT NULL AND ${table.pinnedSandboxGeneration} >= 0)`
    ),
    unique("RunnerAgent_id_tenant_key").on(table.id, table.tenant),
    index("RunnerAgent_tenant_updatedAt_idx").on(table.tenant, table.updatedAt),
    index("RunnerAgent_sandbox_recovery_idx")
      .on(table.sandboxLifecycle, table.sandboxUpdatedAt)
      .where(
        sql`${table.sandboxLifecycle} in ('provisioning', 'provisioning_ambiguous', 'resizing', 'resetting', 'decommissioning')`
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
      "RunnerAgent_familiarId_valid",
      sql`${table.familiarId} in ('auto', 'builder', 'critic', 'custom', 'scout', 'scribe', 'tester')`
    ),
    check(
      "RunnerAgent_status_valid",
      sql`${table.status} in ('idle', 'running', 'error')`
    ),
    check(
      "RunnerAgent_sandboxLifecycle_valid",
      sql`${table.sandboxLifecycle} in ('unprovisioned', 'provisioning', 'provisioning_ambiguous', 'ready', 'resizing', 'resetting', 'decommissioning', 'decommission_failed')`
    ),
    check(
      "RunnerAgent_sandboxTrust_valid",
      sql`${table.sandboxTrust} in ('clean', 'restricted', 'unrestricted')`
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

export const runnerOwnerCredential = pgTable(
  "RunnerOwnerCredential",
  {
    agentId: uuid("agentId").notNull(),
    authVersion: integer("authVersion").notNull(),
    digest: varchar("digest", { length: 64 }).notNull().unique(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    issuedAt: timestamp("issuedAt", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revokedAt", { withTimezone: true }),
    scopes: text("scopes").array().notNull(),
    tenant: varchar("tenant", { length: 64 }).notNull(),
    userId: uuid("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    foreignKey({
      columns: [table.agentId, table.tenant],
      foreignColumns: [runnerAgent.id, runnerAgent.tenant],
    }).onDelete("cascade"),
    check(
      "RunnerOwnerCredential_owner",
      sql`${table.tenant} = 'u_' || replace(${table.userId}::text, '-', '')`
    ),
    check(
      "RunnerOwnerCredential_digest",
      sql`${table.digest} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "RunnerOwnerCredential_lifetime",
      sql`${table.expiresAt} > ${table.issuedAt} and ${table.expiresAt} <= ${table.issuedAt} + interval '1 hour'`
    ),
    check(
      "RunnerOwnerCredential_scopes",
      sql`cardinality(${table.scopes}) between 1 and 5 and array_position(${table.scopes}, null) is null and ${table.scopes} <@ array['run:start','run:read','run:events','run:stop','sandbox:inspect']::text[]`
    ),
    index("RunnerOwnerCredential_owner_agent_idx").on(
      table.userId,
      table.agentId
    ),
  ]
);

export const runnerRun = pgTable(
  "RunnerRun",
  {
    agentId: uuid("agentId").notNull(),
    agentInstructions: varchar("agentInstructions", {
      length: AGENT_RUNNER_LIMITS.maxInstructionsLength,
    }).notNull(),
    agentModel: varchar("agentModel", {
      length: AGENT_RUNNER_LIMITS.maxModelLength,
    }).notNull(),
    agentRuntime: varchar("agentRuntime", {
      enum: ["codex", "claude", "copilot"],
      length: 16,
    }).notNull(),
    agentWorkspace: varchar("agentWorkspace", {
      length: AGENT_RUNNER_LIMITS.maxWorkspaceLength,
    }),
    authorityRevalidation: boolean("authorityRevalidation")
      .notNull()
      .default(false),
    authVersion: integer("authVersion"),
    /**
     * The sandbox a run was admitted against when its request carried a
     * binding. Both are set together or not at all. A bound run is dispatched
     * only to this recorded sandbox and never creates or changes one.
     */
    boundSandboxGeneration: integer("boundSandboxGeneration"),
    boundSandboxId: varchar("boundSandboxId", { length: 128 }),
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
    /**
     * Minutes this run was admitted with, which is also how long it may run.
     *
     * Written once at admission from the same number the reservation held, so
     * the run's time limit and its billing reservation are one fact rather
     * than two kept equal by a test. A campaign run admitted with 5 minutes is
     * stopped at 5 minutes; a subscriber run admitted with 15 is stopped at 15.
     *
     * Null on runs admitted before this column existed. The reconciler falls
     * back to the process-wide limit for those, which is exactly what bounded
     * them when they were admitted.
     */
    entitlementMinutes: integer("entitlementMinutes"),
    error: jsonb("error").$type<RunError>(),
    executionPermission: varchar("executionPermission", {
      enum: [
        "unrestricted",
        "workspace_read",
        "workspace_write",
        "github_only",
      ],
      length: 32,
    })
      .notNull()
      .default("unrestricted"),
    executionProvenance: jsonb(
      "executionProvenance"
    ).$type<RunnerExecutionProvenance>(),
    fileEvidence: jsonb("fileEvidence")
      .$type<FileEvidence[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    githubBrokerPolicy: jsonb("githubBrokerPolicy").$type<GitHubBrokerPolicy>(),
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    logCursor: integer("logCursor").notNull().default(0),
    operationId: uuid("operationId").notNull(),
    output: text("output").notNull().default(""),
    ownerCredentialId: uuid("ownerCredentialId"),
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
    teamStepId: uuid("teamStepId"),
    tenant: varchar("tenant", { length: 64 }).notNull(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
    version: integer("version").notNull().default(0),
  },
  (table) => [
    unique("RunnerRun_id_tenant_key").on(table.id, table.tenant),
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
    check(
      "RunnerRun_sandboxBinding_valid",
      sql`(${table.boundSandboxId} is null and ${table.boundSandboxGeneration} is null) or (${table.boundSandboxId} is not null and ${table.boundSandboxGeneration} is not null and ${table.boundSandboxId} ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' and ${table.boundSandboxGeneration} >= 0)`
    ),
    check(
      "RunnerRun_executionPermission_valid",
      sql`${table.executionPermission} in ('unrestricted', 'workspace_read', 'workspace_write', 'github_only')`
    ),
    check(
      "RunnerRun_githubBrokerPolicy_valid",
      sql`${table.githubBrokerPolicy} is null or (${table.teamStepId} is not null and jsonb_typeof(${table.githubBrokerPolicy}) = 'object' and ${table.githubBrokerPolicy}->>'version' = '1' and ${table.githubBrokerPolicy}->>'teamStepId' = ${table.teamStepId}::text and ${table.githubBrokerPolicy}->>'authVersion' = ${table.authVersion}::text and (${table.githubBrokerPolicy}->>'actorUserId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' and jsonb_typeof(${table.githubBrokerPolicy}->'allowedCapabilities') = 'array' and jsonb_array_length(${table.githubBrokerPolicy}->'allowedCapabilities') between 1 and ${teamMaxSkillsPerMemberSql} and jsonb_typeof(${table.githubBrokerPolicy}->'repositories') = 'array' and jsonb_array_length(${table.githubBrokerPolicy}->'repositories') between 1 and 16)`
    ),
    check(
      "RunnerRun_executionProvenance_valid",
      sql`${table.executionProvenance} is null or (
        jsonb_typeof(${table.executionProvenance}) = 'object'
        and ${table.executionProvenance} ?& array['productExecutionClass', 'provider', 'capabilityContractVersion', 'adapterVersion', 'pinnedSnapshot', 'target', 'lifecycle']
        and (${table.executionProvenance} - 'productExecutionClass' - 'provider' - 'capabilityContractVersion' - 'adapterVersion' - 'pinnedSnapshot' - 'target' - 'lifecycle') = '{}'::jsonb
        and ${table.executionProvenance}->>'productExecutionClass' = 'hosted'
        and ${table.executionProvenance}->>'provider' in ('daytona', 'hermetic')
        and jsonb_typeof(${table.executionProvenance}->'capabilityContractVersion') = 'string'
        and ${table.executionProvenance}->>'capabilityContractVersion' ~ '^hosted-v[1-9][0-9]{0,2}$'
        and jsonb_typeof(${table.executionProvenance}->'adapterVersion') = 'string'
        and (
          (${table.executionProvenance}->>'provider' = 'daytona'
            and ${table.executionProvenance}->>'adapterVersion' ~ '^daytona-adapter-v[1-9][0-9]{0,2}$'
            and ${table.executionProvenance}->>'pinnedSnapshot' ~ '^coven-agents-copilot-[0-9]{1,10}$'
            and ${table.executionProvenance}->>'target' in ('eu', 'us')
            and ${table.executionProvenance}->>'lifecycle' = 'persistent')
          or (${table.executionProvenance}->>'provider' = 'hermetic'
            and ${table.executionProvenance}->>'adapterVersion' ~ '^hermetic-adapter-v[1-9][0-9]{0,2}$'
            and ${table.executionProvenance}->>'pinnedSnapshot' = 'hermetic-e2e-v1'
            and ${table.executionProvenance}->>'target' = 'e2e'
            and ${table.executionProvenance}->>'lifecycle' = 'ephemeral')
        )
        and jsonb_typeof(${table.executionProvenance}->'pinnedSnapshot') = 'string'
      )`
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
      "RunnerRun_agentSnapshot_valid",
      sql`char_length(btrim(${table.agentInstructions})) between 1 and ${sql.raw(String(AGENT_RUNNER_LIMITS.maxInstructionsLength))} and char_length(btrim(${table.agentModel})) between 1 and ${sql.raw(String(AGENT_RUNNER_LIMITS.maxModelLength))} and ${table.agentRuntime} in ('codex', 'claude', 'copilot')`
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

export const runnerSkill = pgTable(
  "RunnerSkill",
  {
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    description: varchar("description", {
      length: TEAM_LIMITS.maxDescriptionLength,
    })
      .notNull()
      .default(""),
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    instructions: varchar("instructions", {
      length: TEAM_LIMITS.maxSkillInstructionsLength,
    }).notNull(),
    name: varchar("name", { length: TEAM_LIMITS.maxNameLength }).notNull(),
    requiredCapabilities: jsonb("requiredCapabilities")
      .$type<TeamCapability[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    tenant: varchar("tenant", { length: 64 }).notNull(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
    version: integer("version").notNull().default(0),
  },
  (table) => [
    unique("RSkill_id_tenant_uq").on(table.id, table.tenant),
    index("RSkill_tenant_updated_idx").on(table.tenant, table.updatedAt),
    check("RSkill_tenant_valid", sql`${table.tenant} ~ '^[A-Za-z0-9_]{1,64}$'`),
    check("RSkill_version_valid", sql`${table.version} >= 0`),
    check(
      "RSkill_caps_valid",
      sql`jsonb_typeof(${table.requiredCapabilities}) = 'array' and jsonb_array_length(${table.requiredCapabilities}) <= ${teamMaxSkillsPerMemberSql} and ${table.requiredCapabilities} <@ '["workspace.read","workspace.write","github.contents.write","github.issues.read","github.issues.write","github.pull_requests.read","github.pull_requests.write","github.projects.read","github.projects.write"]'::jsonb`
    ),
  ]
);

export type RunnerSkill = InferSelectModel<typeof runnerSkill>;

export const runnerTeam = pgTable(
  "RunnerTeam",
  {
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    description: varchar("description", {
      length: TEAM_LIMITS.maxDescriptionLength,
    })
      .notNull()
      .default(""),
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    name: varchar("name", { length: TEAM_LIMITS.maxNameLength }).notNull(),
    tenant: varchar("tenant", { length: 64 }).notNull(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
    version: integer("version").notNull().default(0),
  },
  (table) => [
    unique("RTeam_id_tenant_uq").on(table.id, table.tenant),
    index("RTeam_tenant_updated_idx").on(table.tenant, table.updatedAt),
    check("RTeam_tenant_valid", sql`${table.tenant} ~ '^[A-Za-z0-9_]{1,64}$'`),
    check("RTeam_version_valid", sql`${table.version} >= 0`),
  ]
);

export type RunnerTeam = InferSelectModel<typeof runnerTeam>;

export const runnerTeamMember = pgTable(
  "RunnerTeamMember",
  {
    agentId: uuid("agentId").notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    position: integer("position").notNull(),
    required: boolean("required").notNull().default(true),
    responsibility: varchar("responsibility", {
      length: AGENT_RUNNER_LIMITS.maxInstructionsLength,
    }).notNull(),
    teamId: uuid("teamId").notNull(),
    tenant: varchar("tenant", { length: 64 }).notNull(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (table) => [
    unique("RTMember_id_tenant_uq").on(table.id, table.tenant),
    unique("RTMember_team_pos_uq").on(
      table.teamId,
      table.tenant,
      table.position
    ),
    unique("RTMember_team_agent_uq").on(
      table.teamId,
      table.tenant,
      table.agentId
    ),
    foreignKey({
      columns: [table.teamId, table.tenant],
      foreignColumns: [runnerTeam.id, runnerTeam.tenant],
      name: "RTMember_team_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.agentId, table.tenant],
      foreignColumns: [runnerAgent.id, runnerAgent.tenant],
      name: "RTMember_agent_fk",
    }).onDelete("restrict"),
    check(
      "RTMember_tenant_valid",
      sql`${table.tenant} ~ '^[A-Za-z0-9_]{1,64}$'`
    ),
    check(
      "RTMember_position_valid",
      sql`${table.position} >= 0 and ${table.position} < ${teamMaxMembersSql}`
    ),
  ]
);

export type RunnerTeamMember = InferSelectModel<typeof runnerTeamMember>;

export const runnerTeamMemberSkill = pgTable(
  "RunnerTeamMemberSkill",
  {
    memberId: uuid("memberId").notNull(),
    skillId: uuid("skillId").notNull(),
    tenant: varchar("tenant", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.memberId, table.tenant, table.skillId],
      name: "RTMemberSkill_pk",
    }),
    foreignKey({
      columns: [table.memberId, table.tenant],
      foreignColumns: [runnerTeamMember.id, runnerTeamMember.tenant],
      name: "RTMemberSkill_member_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.skillId, table.tenant],
      foreignColumns: [runnerSkill.id, runnerSkill.tenant],
      name: "RTMemberSkill_skill_fk",
    }).onDelete("restrict"),
    index("RTMemberSkill_skill_idx").on(table.skillId, table.tenant),
    check(
      "RTMemberSkill_tenant_valid",
      sql`${table.tenant} ~ '^[A-Za-z0-9_]{1,64}$'`
    ),
  ]
);

export type RunnerTeamMemberSkill = InferSelectModel<
  typeof runnerTeamMemberSkill
>;

export const runnerTeamRun = pgTable(
  "RunnerTeamRun",
  {
    authVersion: integer("authVersion").notNull(),
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    createdByUserId: uuid("createdByUserId").notNull(),
    currentPosition: integer("currentPosition").notNull().default(0),
    error: jsonb("error").$type<RunError>(),
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    mission: varchar("mission", {
      length: TEAM_LIMITS.maxMissionLength,
    }).notNull(),
    operationId: uuid("operationId").notNull(),
    requestHash: varchar("requestHash", { length: 64 }).notNull(),
    startedAt: timestamp("startedAt"),
    status: varchar("status", {
      enum: [
        "queued",
        "running",
        "waiting_approval",
        "completed",
        "completed_with_warnings",
        "failed",
        "cancelled",
      ],
      length: 24,
    })
      .notNull()
      .default("queued"),
    teamId: uuid("teamId").notNull(),
    tenant: varchar("tenant", { length: 64 }).notNull(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
    version: integer("version").notNull().default(0),
  },
  (table) => [
    unique("RTRun_id_tenant_uq").on(table.id, table.tenant),
    unique("RTRun_team_operation_uq").on(
      table.teamId,
      table.tenant,
      table.operationId
    ),
    foreignKey({
      columns: [table.teamId, table.tenant],
      foreignColumns: [runnerTeam.id, runnerTeam.tenant],
      name: "RTRun_team_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.createdByUserId],
      foreignColumns: [user.id],
      name: "RTRun_createdByUser_fk",
    }).onDelete("restrict"),
    index("RTRun_tenant_created_idx").on(table.tenant, table.createdAt),
    index("RTRun_status_updated_idx").on(table.status, table.updatedAt),
    check("RTRun_tenant_valid", sql`${table.tenant} ~ '^[A-Za-z0-9_]{1,64}$'`),
    check(
      "RTRun_status_valid",
      sql`${table.status} in ('queued', 'running', 'waiting_approval', 'completed', 'completed_with_warnings', 'failed', 'cancelled')`
    ),
    check(
      "RTRun_position_valid",
      sql`${table.currentPosition} >= 0 and ${table.currentPosition} <= ${teamMaxMembersSql}`
    ),
    check("RTRun_version_valid", sql`${table.version} >= 0`),
    check("RTRun_authVersion_valid", sql`${table.authVersion} >= 0`),
    check(
      "RTRun_requestHash_valid",
      sql`${table.requestHash} ~ '^[a-f0-9]{64}$'`
    ),
    check(
      "RTRun_timestamps_valid",
      sql`(${table.startedAt} is null or ${table.startedAt} >= ${table.createdAt}) and (${table.completedAt} is null or (${table.completedAt} >= ${table.createdAt} and (${table.startedAt} is null or ${table.completedAt} >= ${table.startedAt})))`
    ),
    check(
      "RTRun_error_bounded",
      sql`${table.error} is null or (jsonb_typeof(${table.error}) = 'object' and ${table.error} ?& array['code', 'message', 'retryable'] and (${table.error} - 'code' - 'message' - 'retryable' - 'details') = '{}'::jsonb and jsonb_typeof(${table.error}->'code') = 'string' and char_length(${table.error}->>'code') between 1 and 64 and jsonb_typeof(${table.error}->'message') = 'string' and char_length(${table.error}->>'message') between 1 and ${runnerMaxMessageLengthSql} and jsonb_typeof(${table.error}->'retryable') = 'boolean' and (not (${table.error} ? 'details') or (jsonb_typeof(${table.error}->'details') = 'string' and char_length(${table.error}->>'details') between 1 and ${runnerMaxDetailsLengthSql})))`
    ),
  ]
);

export type RunnerTeamRun = InferSelectModel<typeof runnerTeamRun>;

export const runnerTeamStep = pgTable(
  "RunnerTeamStep",
  {
    agentId: uuid("agentId").notNull(),
    agentInstructions: varchar("agentInstructions", {
      length: AGENT_RUNNER_LIMITS.maxInstructionsLength,
    }).notNull(),
    agentModel: varchar("agentModel", {
      length: AGENT_RUNNER_LIMITS.maxModelLength,
    }).notNull(),
    agentRuntime: varchar("agentRuntime", {
      enum: ["codex", "claude", "copilot"],
      length: 16,
    }).notNull(),
    agentWorkspace: varchar("agentWorkspace", {
      length: AGENT_RUNNER_LIMITS.maxWorkspaceLength,
    }),
    approvalActorUserId: uuid("approvalActorUserId"),
    approvalDecidedAt: timestamp("approvalDecidedAt"),
    approvalStatus: varchar("approvalStatus", {
      enum: ["not_required", "pending", "approved", "rejected"],
      length: 16,
    })
      .notNull()
      .default("not_required"),
    approvedCapabilities: jsonb("approvedCapabilities")
      .$type<TeamCapability[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    completedAt: timestamp("completedAt"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    error: jsonb("error").$type<RunError>(),
    handoff: jsonb("handoff").$type<TeamHandoff>(),
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    memberId: uuid("memberId").notNull(),
    plannedOperationId: uuid("plannedOperationId"),
    plannedRunnerRunId: uuid("plannedRunnerRunId"),
    position: integer("position").notNull(),
    required: boolean("required").notNull(),
    responsibility: varchar("responsibility", {
      length: AGENT_RUNNER_LIMITS.maxInstructionsLength,
    }).notNull(),
    runnerRunId: uuid("runnerRunId"),
    skillIds: jsonb("skillIds")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    skillSnapshots: jsonb("skillSnapshots")
      .$type<RunnerTeamSkillSnapshot[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    startedAt: timestamp("startedAt"),
    status: varchar("status", {
      enum: [
        "pending",
        "queued",
        "running",
        "waiting_approval",
        "completed",
        "failed",
        "cancelled",
        "skipped",
      ],
      length: 24,
    })
      .notNull()
      .default("pending"),
    teamRunId: uuid("teamRunId").notNull(),
    tenant: varchar("tenant", { length: 64 }).notNull(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
    version: integer("version").notNull().default(0),
  },
  (table) => [
    unique("RTStep_id_tenant_uq").on(table.id, table.tenant),
    unique("RTStep_run_position_uq").on(
      table.teamRunId,
      table.tenant,
      table.position
    ),
    uniqueIndex("RTStep_runnerRun_uq").on(table.runnerRunId),
    uniqueIndex("RTStep_plannedOperation_uq").on(table.plannedOperationId),
    uniqueIndex("RTStep_plannedRunnerRun_uq").on(table.plannedRunnerRunId),
    foreignKey({
      columns: [table.teamRunId, table.tenant],
      foreignColumns: [runnerTeamRun.id, runnerTeamRun.tenant],
      name: "RTStep_teamRun_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.agentId, table.tenant],
      foreignColumns: [runnerAgent.id, runnerAgent.tenant],
      name: "RTStep_agent_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.runnerRunId, table.tenant],
      foreignColumns: [runnerRun.id, runnerRun.tenant],
      name: "RTStep_runnerRun_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.approvalActorUserId],
      foreignColumns: [user.id],
      name: "RTStep_approvalActorUser_fk",
    }).onDelete("restrict"),
    index("RTStep_status_updated_idx").on(table.status, table.updatedAt),
    check("RTStep_tenant_valid", sql`${table.tenant} ~ '^[A-Za-z0-9_]{1,64}$'`),
    check(
      "RTStep_position_valid",
      sql`${table.position} >= 0 and ${table.position} < ${teamMaxMembersSql}`
    ),
    check(
      "RTStep_status_valid",
      sql`${table.status} in ('pending', 'queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled', 'skipped')`
    ),
    check(
      "RTStep_approval_valid",
      sql`${table.approvalStatus} in ('not_required', 'pending', 'approved', 'rejected')`
    ),
    check(
      "RTStep_approvedCapabilities_valid",
      sql`jsonb_typeof(${table.approvedCapabilities}) = 'array' and jsonb_array_length(${table.approvedCapabilities}) <= ${teamMaxSkillsPerMemberSql} and ${table.approvedCapabilities} <@ '["github.contents.write","github.issues.read","github.issues.write","github.pull_requests.read","github.pull_requests.write","github.projects.read","github.projects.write"]'::jsonb`
    ),
    check(
      "RTStep_approval_audit_valid",
      sql`((${table.approvalStatus} in ('not_required', 'pending')) and ${table.approvalActorUserId} is null and ${table.approvalDecidedAt} is null and jsonb_array_length(${table.approvedCapabilities}) = 0) or (${table.approvalStatus} = 'approved' and ${table.approvalActorUserId} is not null and ${table.approvalDecidedAt} is not null and ${table.approvalDecidedAt} >= ${table.createdAt} and jsonb_array_length(${table.approvedCapabilities}) between 1 and ${teamMaxSkillsPerMemberSql}) or (${table.approvalStatus} = 'rejected' and ${table.approvalActorUserId} is not null and ${table.approvalDecidedAt} is not null and ${table.approvalDecidedAt} >= ${table.createdAt} and jsonb_array_length(${table.approvedCapabilities}) = 0)`
    ),
    check(
      "RTStep_childReservation_valid",
      sql`((${table.plannedOperationId} is null and ${table.plannedRunnerRunId} is null) or (${table.plannedOperationId} is not null and ${table.plannedRunnerRunId} is not null)) and (${table.runnerRunId} is null or ${table.runnerRunId} = ${table.plannedRunnerRunId})`
    ),
    check(
      "RTStep_agentSnapshot_valid",
      sql`char_length(btrim(${table.agentInstructions})) between 1 and ${sql.raw(String(AGENT_RUNNER_LIMITS.maxInstructionsLength))} and char_length(btrim(${table.agentModel})) between 1 and ${sql.raw(String(AGENT_RUNNER_LIMITS.maxModelLength))} and ${table.agentRuntime} in ('codex', 'claude', 'copilot')`
    ),
    check("RTStep_version_valid", sql`${table.version} >= 0`),
    check(
      "RTStep_skillIds_valid",
      sql`jsonb_typeof(${table.skillIds}) = 'array' and jsonb_array_length(${table.skillIds}) <= ${teamMaxSkillsPerMemberSql}`
    ),
    check(
      "RTStep_skillSnapshots_valid",
      sql`jsonb_typeof(${table.skillSnapshots}) = 'array' and jsonb_array_length(${table.skillSnapshots}) <= ${teamMaxSkillsPerMemberSql}`
    ),
    check(
      "RTStep_handoff_bounded",
      sql`${table.handoff} is null or (jsonb_typeof(${table.handoff}) = 'object' and ${table.handoff} ?& array['output', 'commandEvidence', 'fileEvidence'] and (${table.handoff} - 'output' - 'commandEvidence' - 'fileEvidence') = '{}'::jsonb and octet_length(${table.handoff}::text) <= ${teamMaxPersistedHandoffLengthSql} and jsonb_typeof(${table.handoff}->'output') = 'string' and jsonb_typeof(${table.handoff}->'commandEvidence') = 'array' and jsonb_array_length(${table.handoff}->'commandEvidence') <= ${runnerMaxCommandResultsSql} and jsonb_typeof(${table.handoff}->'fileEvidence') = 'array' and jsonb_array_length(${table.handoff}->'fileEvidence') <= ${runnerMaxFileOperationsSql})`
    ),
    check(
      "RTStep_error_bounded",
      sql`${table.error} is null or (jsonb_typeof(${table.error}) = 'object' and ${table.error} ?& array['code', 'message', 'retryable'] and (${table.error} - 'code' - 'message' - 'retryable' - 'details') = '{}'::jsonb and jsonb_typeof(${table.error}->'code') = 'string' and char_length(${table.error}->>'code') between 1 and 64 and jsonb_typeof(${table.error}->'message') = 'string' and char_length(${table.error}->>'message') between 1 and ${runnerMaxMessageLengthSql} and jsonb_typeof(${table.error}->'retryable') = 'boolean' and (not (${table.error} ? 'details') or (jsonb_typeof(${table.error}->'details') = 'string' and char_length(${table.error}->>'details') between 1 and ${runnerMaxDetailsLengthSql})))`
    ),
    check(
      "RTStep_timestamps_valid",
      sql`(${table.startedAt} is null or ${table.startedAt} >= ${table.createdAt}) and (${table.completedAt} is null or (${table.completedAt} >= ${table.createdAt} and (${table.startedAt} is null or ${table.completedAt} >= ${table.startedAt})))`
    ),
  ]
);

export type RunnerTeamStep = InferSelectModel<typeof runnerTeamStep>;

export const runnerGitHubConnectionFence = pgTable(
  "RunnerGitHubConnectionFence",
  {
    generation: bigint("generation", { mode: "number" }).notNull().default(0),
    tenant: varchar("tenant", { length: 64 }).primaryKey().notNull(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("RGHConnFence_tenant_generation_uq").on(
      table.tenant,
      table.generation
    ),
    check(
      "RGHConnFence_tenant_valid",
      sql`${table.tenant} ~ '^[A-Za-z0-9_]{1,64}$'`
    ),
    check("RGHConnFence_generation_nonnegative", sql`${table.generation} >= 0`),
  ]
);

export type RunnerGitHubConnectionFence = InferSelectModel<
  typeof runnerGitHubConnectionFence
>;

export const runnerGitHubConnection = pgTable(
  "RunnerGitHubConnection",
  {
    accountId: varchar("accountId", { length: 20 }).notNull(),
    accountLogin: varchar("accountLogin", { length: 100 }).notNull(),
    accountType: varchar("accountType", {
      enum: ["Organization", "User"],
      length: 16,
    }).notNull(),
    appContentsPermission: varchar("appContentsPermission", {
      enum: ["none", "read", "write"],
      length: 8,
    })
      .$type<GitHubAppRepositoryPermission>()
      .notNull(),
    appIssuesPermission: varchar("appIssuesPermission", {
      enum: ["none", "read", "write"],
      length: 8,
    })
      .$type<GitHubAppRepositoryPermission>()
      .notNull(),
    appOrganizationProjectsPermission: varchar(
      "appOrganizationProjectsPermission",
      {
        enum: ["none", "read", "write"],
        length: 8,
      }
    )
      .$type<GitHubAppRepositoryPermission>()
      .notNull(),
    appPullRequestsPermission: varchar("appPullRequestsPermission", {
      enum: ["none", "read", "write"],
      length: 8,
    })
      .$type<GitHubAppRepositoryPermission>()
      .notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    githubUserId: varchar("githubUserId", { length: 20 }).notNull(),
    githubUserLogin: varchar("githubUserLogin", { length: 100 }).notNull(),
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    installationId: varchar("installationId", { length: 20 }).notNull(),
    repositoryId: varchar("repositoryId", { length: 20 }).notNull(),
    repositoryName: varchar("repositoryName", { length: 100 }).notNull(),
    repositoryNodeId: varchar("repositoryNodeId", {
      length: GITHUB_NODE_ID_MAX_LENGTH,
    }).notNull(),
    repositoryOwner: varchar("repositoryOwner", { length: 100 }).notNull(),
    tenant: varchar("tenant", { length: 64 }).notNull(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
    userPermissionCeiling: varchar("userPermissionCeiling", {
      enum: ["read", "triage", "write", "maintain", "admin"],
      length: 16,
    })
      .$type<GitHubUserRepositoryPermission>()
      .notNull(),
    userPermissionCurrent: varchar("userPermissionCurrent", {
      enum: ["read", "triage", "write", "maintain", "admin"],
      length: 16,
    })
      .$type<GitHubUserRepositoryPermission>()
      .notNull(),
    userProjectAuthorityAuthVersion: integer("userProjectAuthorityAuthVersion"),
    userProjectAuthorityConnectionGeneration: bigint(
      "userProjectAuthorityConnectionGeneration",
      { mode: "number" }
    ),
    userProjectAuthorityExpiresAt: timestamp("userProjectAuthorityExpiresAt", {
      withTimezone: true,
    }),
    userProjectAuthorityIssuedAt: timestamp("userProjectAuthorityIssuedAt", {
      withTimezone: true,
    }),
    userProjectIds: jsonb("userProjectIds")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    userProjectManagementCeiling: boolean(
      "userProjectManagementCeiling"
    ).notNull(),
    userProjectManagementCurrent: boolean(
      "userProjectManagementCurrent"
    ).notNull(),
    version: integer("version").notNull().default(0),
  },
  (table) => [
    unique("RGHConn_id_tenant_uq").on(table.id, table.tenant),
    unique("RGHConn_tenant_repo_uq").on(table.tenant, table.repositoryId),
    index("RGHConn_installation_idx").on(table.installationId),
    check(
      "RGHConn_tenant_valid",
      sql`${table.tenant} ~ '^[A-Za-z0-9_]{1,64}$'`
    ),
    check(
      "RGHConn_decimal_ids",
      sql`${table.installationId} ~ '^(0|[1-9][0-9]{0,19})$' and ${table.accountId} ~ '^(0|[1-9][0-9]{0,19})$' and ${table.repositoryId} ~ '^(0|[1-9][0-9]{0,19})$' and ${table.githubUserId} ~ '^[1-9][0-9]{0,19}$'`
    ),
    check(
      "RGHConn_accountType_valid",
      sql`${table.accountType} in ('Organization', 'User')`
    ),
    check(
      "RGHConn_authority_valid",
      sql`(${table.appContentsPermission} in ('none','read','write') and ${table.appIssuesPermission} in ('none','read','write') and ${table.appPullRequestsPermission} in ('none','read','write') and ${table.appOrganizationProjectsPermission} in ('none','read','write') and ${table.userPermissionCeiling} in ('read','triage','write','maintain','admin') and ${table.userPermissionCurrent} in ('read','triage','write','maintain','admin') and CASE ${table.userPermissionCurrent} WHEN 'read' THEN 1 WHEN 'triage' THEN 2 WHEN 'write' THEN 3 WHEN 'maintain' THEN 4 WHEN 'admin' THEN 5 ELSE 0 END <= CASE ${table.userPermissionCeiling} WHEN 'read' THEN 1 WHEN 'triage' THEN 2 WHEN 'write' THEN 3 WHEN 'maintain' THEN 4 WHEN 'admin' THEN 5 ELSE 0 END and jsonb_typeof(${table.userProjectIds}) = 'array' and jsonb_array_length(${table.userProjectIds}) <= 100 and not jsonb_path_exists(${table.userProjectIds}, ${githubProjectIdsPathSql}) and (coalesce((${table.userProjectManagementCurrent} and ${table.userProjectManagementCeiling} and jsonb_array_length(${table.userProjectIds}) > 0 and ${table.userProjectAuthorityAuthVersion} >= 0 and ${table.userProjectAuthorityConnectionGeneration} >= 0 and ${table.userProjectAuthorityIssuedAt} is not null and ${table.userProjectAuthorityExpiresAt} > ${table.userProjectAuthorityIssuedAt} and ${table.userProjectAuthorityExpiresAt} <= ${table.userProjectAuthorityIssuedAt} + interval '15 minutes'), false) or (not ${table.userProjectManagementCurrent} and jsonb_array_length(${table.userProjectIds}) = 0 and ${table.userProjectAuthorityAuthVersion} is null and ${table.userProjectAuthorityConnectionGeneration} is null and ${table.userProjectAuthorityIssuedAt} is null and ${table.userProjectAuthorityExpiresAt} is null)) and char_length(${table.githubUserLogin}) between 1 and 100 and ${table.githubUserLogin} ~ '^[A-Za-z0-9_.-]+$') is true`
    ),
    check("RGHConn_version_valid", sql`${table.version} >= 0`),
  ]
);

export type RunnerGitHubConnection = InferSelectModel<
  typeof runnerGitHubConnection
>;

export const runnerGitHubCapability = pgTable(
  "RunnerGitHubCapability",
  {
    allowedCapabilities: jsonb("allowedCapabilities")
      .$type<TeamCapability[]>()
      .notNull(),
    approvedCapabilities: jsonb("approvedCapabilities")
      .$type<TeamCapability[]>()
      .notNull(),
    attemptId: uuid("attemptId").notNull(),
    authVersion: integer("authVersion").notNull(),
    connectionGeneration: bigint("connectionGeneration", {
      mode: "number",
    }).notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    declaredCapabilities: jsonb("declaredCapabilities")
      .$type<TeamCapability[]>()
      .notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    maxCallCount: integer("maxCallCount").notNull(),
    repositoryAllowlist: jsonb("repositoryAllowlist")
      .$type<string[]>()
      .notNull(),
    revokedAt: timestamp("revokedAt"),
    runnerRunId: uuid("runnerRunId").notNull(),
    teamRunId: uuid("teamRunId").notNull(),
    teamStepId: uuid("teamStepId").notNull(),
    tenant: varchar("tenant", { length: 64 }).notNull(),
    tokenHash: varchar("tokenHash", { length: 64 }).notNull(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
    usedCallCount: integer("usedCallCount").notNull().default(0),
    version: integer("version").notNull().default(0),
  },
  (table) => [
    unique("RGHCap_id_tenant_uq").on(table.id, table.tenant),
    unique("RGHCap_step_owner_uq").on(table.id, table.tenant, table.teamStepId),
    unique("RGHCap_tokenHash_uq").on(table.tokenHash),
    uniqueIndex("RGHCap_active_runnerRun_uq")
      .on(table.runnerRunId)
      .where(sql`${table.revokedAt} is null`),
    foreignKey({
      columns: [table.teamStepId, table.tenant],
      foreignColumns: [runnerTeamStep.id, runnerTeamStep.tenant],
      name: "RGHCap_step_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.runnerRunId, table.tenant],
      foreignColumns: [runnerRun.id, runnerRun.tenant],
      name: "RunnerGitHubCapability_runnerRun_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.teamRunId, table.tenant],
      foreignColumns: [runnerTeamRun.id, runnerTeamRun.tenant],
      name: "RunnerGitHubCapability_teamRun_fk",
    }).onDelete("cascade"),
    index("RGHCap_expiry_idx").on(table.expiresAt),
    check("RGHCap_tenant_valid", sql`${table.tenant} ~ '^[A-Za-z0-9_]{1,64}$'`),
    check("RGHCap_tokenHash_valid", sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`),
    check(
      "RGHCap_caps_valid",
      sql`jsonb_typeof(${table.declaredCapabilities}) = 'array' and jsonb_array_length(${table.declaredCapabilities}) between 1 and ${teamMaxSkillsPerMemberSql} and ${table.declaredCapabilities} <@ '["github.contents.write","github.issues.read","github.issues.write","github.pull_requests.read","github.pull_requests.write","github.projects.read","github.projects.write"]'::jsonb and jsonb_typeof(${table.approvedCapabilities}) = 'array' and jsonb_array_length(${table.approvedCapabilities}) <= ${teamMaxSkillsPerMemberSql} and ${table.approvedCapabilities} <@ ${table.declaredCapabilities} and jsonb_typeof(${table.allowedCapabilities}) = 'array' and jsonb_array_length(${table.allowedCapabilities}) between 1 and ${teamMaxSkillsPerMemberSql} and ${table.allowedCapabilities} <@ ${table.declaredCapabilities} and ${table.allowedCapabilities} <@ (jsonb_path_query_array(${table.declaredCapabilities}, '$[*] ? (@ like_regex "read$")') || ${table.approvedCapabilities})`
    ),
    check(
      "RGHCap_repos_valid",
      sql`jsonb_typeof(${table.repositoryAllowlist}) = 'array' and jsonb_array_length(${table.repositoryAllowlist}) between 1 and 16`
    ),
    check(
      "RGHCap_calls_valid",
      sql`${table.maxCallCount} between 1 and 32 and ${table.usedCallCount} between 0 and ${table.maxCallCount}`
    ),
    check(
      "RGHCap_binding_valid",
      sql`${table.authVersion} >= 0 and ${table.connectionGeneration} >= 0`
    ),
    check(
      "RGHCap_timestamps_valid",
      sql`${table.expiresAt} > ${table.createdAt} and ${table.expiresAt} <= ${table.createdAt} + interval '15 minutes' and (${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt})`
    ),
    check("RGHCap_version_valid", sql`${table.version} >= 0`),
  ]
);

export type RunnerGitHubCapability = InferSelectModel<
  typeof runnerGitHubCapability
>;

export const runnerGitHubOperation = pgTable(
  "RunnerGitHubOperation",
  {
    accountId: varchar("accountId", { length: 20 }).notNull(),
    accountLogin: varchar("accountLogin", { length: 100 }).notNull(),
    accountType: varchar("accountType", {
      enum: ["Organization", "User"],
      length: 16,
    }).notNull(),
    capabilityId: uuid("capabilityId").notNull(),
    completedAt: timestamp("completedAt"),
    connectionGeneration: bigint("connectionGeneration", {
      mode: "number",
    }).notNull(),
    connectionId: uuid("connectionId"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    error: jsonb("error").$type<RunError>(),
    executionLeaseExpiresAt: timestamp("executionLeaseExpiresAt").notNull(),
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    installationId: varchar("installationId", { length: 20 }).notNull(),
    kind: varchar("kind", {
      enum: [
        "repository.commit",
        "issue.get",
        "issue.search",
        "issue.create",
        "issue.comment",
        "pull.get",
        "pull.create",
        "pull.comment",
        "pull.review",
        "project.item.add",
        "project.item.field.update",
      ],
      length: 32,
    })
      .$type<GitHubOperationKind>()
      .notNull(),
    operationId: uuid("operationId").notNull(),
    operationMarker: varchar("operationMarker", { length: 80 }),
    projectAuthorityBound: boolean("projectAuthorityBound")
      .notNull()
      .default(false),
    projectId: varchar("projectId", { length: GITHUB_NODE_ID_MAX_LENGTH }),
    providerDispatchPhase: varchar("providerDispatchPhase", {
      enum: ["not_applicable", "pre_send", "sent"],
      length: 16,
    })
      .notNull()
      .default("not_applicable"),
    providerRequestId: varchar("providerRequestId", { length: 256 }),
    providerSentAt: timestamp("providerSentAt"),
    repository: varchar("repository", { length: 201 }).notNull(),
    repositoryId: varchar("repositoryId", { length: 20 }).notNull(),
    repositoryName: varchar("repositoryName", { length: 100 }).notNull(),
    repositoryNodeId: varchar("repositoryNodeId", {
      length: GITHUB_NODE_ID_MAX_LENGTH,
    }).notNull(),
    repositoryOwner: varchar("repositoryOwner", { length: 100 }).notNull(),
    requestHash: varchar("requestHash", { length: 64 }).notNull(),
    requiredCapability: varchar("requiredCapability", {
      enum: [
        "github.contents.write",
        "github.issues.read",
        "github.issues.write",
        "github.pull_requests.read",
        "github.pull_requests.write",
        "github.projects.read",
        "github.projects.write",
      ],
      length: 40,
    })
      .$type<TeamCapability>()
      .notNull(),
    resultJson: jsonb("resultJson").$type<GitHubToolResult>(),
    resultNodeId: varchar("resultNodeId", {
      length: GITHUB_NODE_ID_MAX_LENGTH,
    }),
    resultUrl: varchar("resultUrl", { length: 2048 }),
    startedAt: timestamp("startedAt"),
    status: varchar("status", {
      enum: ["pending", "running", "completed", "failed"],
      length: 16,
    })
      .notNull()
      .default("pending"),
    target: varchar("target", { length: 512 }).notNull(),
    teamStepId: uuid("teamStepId").notNull(),
    tenant: varchar("tenant", { length: 64 }).notNull(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
    version: integer("version").notNull().default(0),
    writeIntentActive: boolean("writeIntentActive").notNull().default(false),
  },
  (table) => [
    unique("RGHOp_id_tenant_uq").on(table.id, table.tenant),
    unique("RGHOp_step_operation_uq").on(
      table.teamStepId,
      table.tenant,
      table.operationId
    ),
    unique("RGHOp_tenant_operation_uq").on(table.tenant, table.operationId),
    uniqueIndex("RGHOp_step_write_intent_uq")
      .on(table.tenant, table.teamStepId, table.kind, table.requestHash)
      .where(sql`${table.writeIntentActive} = true`),
    foreignKey({
      columns: [table.teamStepId, table.tenant],
      foreignColumns: [runnerTeamStep.id, runnerTeamStep.tenant],
      name: "RGHOp_step_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.capabilityId, table.tenant, table.teamStepId],
      foreignColumns: [
        runnerGitHubCapability.id,
        runnerGitHubCapability.tenant,
        runnerGitHubCapability.teamStepId,
      ],
      name: "RGHOp_capability_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.connectionId],
      foreignColumns: [runnerGitHubConnection.id],
      name: "RunnerGitHubOperation_connection_fk",
    }).onDelete("set null"),
    index("RGHOp_status_updated_idx").on(table.status, table.updatedAt),
    check("RGHOp_tenant_valid", sql`${table.tenant} ~ '^[A-Za-z0-9_]{1,64}$'`),
    check(
      "RGHOp_kind_valid",
      sql`${table.kind} in ('repository.commit', 'issue.get', 'issue.search', 'issue.create', 'issue.comment', 'pull.get', 'pull.create', 'pull.comment', 'pull.review', 'project.item.add', 'project.item.field.update')`
    ),
    check(
      "RGHOp_status_valid",
      sql`${table.status} in ('pending', 'running', 'completed', 'failed')`
    ),
    check(
      "RGHOp_requestHash_valid",
      sql`${table.requestHash} ~ '^[a-f0-9]{64}$'`
    ),
    check(
      "RGHOp_binding_valid",
      sql`${table.connectionGeneration} >= 0 and ${table.repository} ~ '^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$' and ${table.requiredCapability} in ('github.contents.write','github.issues.read','github.issues.write','github.pull_requests.read','github.pull_requests.write','github.projects.read','github.projects.write')`
    ),
    check(
      "RGHOp_connectionSnapshot_valid",
      sql`(${table.installationId} ~ '^[1-9][0-9]{0,19}$' and ${table.accountId} ~ '^[1-9][0-9]{0,19}$' and ${table.repositoryId} ~ '^[1-9][0-9]{0,19}$' and ${table.accountType} in ('Organization','User') and char_length(${table.repositoryNodeId}) between ${githubNodeIdMinSql} and ${githubNodeIdMaxSql} and ${table.repositoryNodeId} ~ ${githubNodeIdCharactersSql} and ((${table.kind} in ('project.item.add','project.item.field.update') and ((${table.projectAuthorityBound} and ${table.projectId} is not null and char_length(${table.projectId}) between ${githubNodeIdMinSql} and ${githubNodeIdMaxSql} and ${table.projectId} ~ ${githubNodeIdCharactersSql}) or (not ${table.projectAuthorityBound} and ${table.projectId} is null))) or (${table.kind} not in ('project.item.add','project.item.field.update') and not ${table.projectAuthorityBound} and ${table.projectId} is null))) is true`
    ),
    check(
      "RGHOp_capability_mapping_valid",
      sql`${table.requiredCapability} = CASE WHEN ${table.kind} = 'repository.commit' THEN 'github.contents.write' WHEN ${table.kind} in ('issue.get','issue.search') THEN 'github.issues.read' WHEN ${table.kind} in ('issue.create','issue.comment') THEN 'github.issues.write' WHEN ${table.kind} = 'pull.get' THEN 'github.pull_requests.read' WHEN ${table.kind} in ('pull.create','pull.comment','pull.review') THEN 'github.pull_requests.write' WHEN ${table.kind} in ('project.item.add','project.item.field.update') THEN 'github.projects.write' ELSE '' END`
    ),
    check(
      "RGHOp_marker_valid",
      sql`(${table.kind} in ('issue.get','issue.search','pull.get') and ${table.operationMarker} is null) or (${table.kind} not in ('issue.get','issue.search','pull.get') and ${table.operationMarker} ~ '^<!-- coven-github:v1:[a-f0-9]{40} -->$')`
    ),
    check(
      "RGHOp_dispatch_phase_valid",
      sql`(${table.kind} in ('issue.get','issue.search','pull.get') and ${table.providerDispatchPhase} = 'not_applicable' and ${table.providerSentAt} is null and ${table.writeIntentActive} = false) or (${table.kind} not in ('issue.get','issue.search','pull.get') and ((${table.providerDispatchPhase} = 'pre_send' and ${table.providerSentAt} is null) or (${table.providerDispatchPhase} = 'sent' and ${table.providerSentAt} is not null)) and (${table.writeIntentActive} = true or (${table.providerDispatchPhase} = 'pre_send' and ${table.status} = 'pending' and (${table.error}->>'retryable')::boolean = true)))`
    ),
    check(
      "RGHOp_result_valid",
      sql`(${table.status} = 'completed' and ${table.resultJson} is not null and jsonb_typeof(${table.resultJson}) = 'object') or (${table.status} <> 'completed' and ${table.resultJson} is null)`
    ),
    check("RGHOp_version_valid", sql`${table.version} >= 0`),
    check(
      "RGHOp_resultUrl_valid",
      sql`${table.resultUrl} is null or ${table.resultUrl} ~ '^https://github\\.com/'`
    ),
    check(
      "RGHOp_timestamps_valid",
      sql`(${table.startedAt} is null or ${table.startedAt} >= ${table.createdAt}) and (${table.providerSentAt} is null or (${table.providerSentAt} >= ${table.createdAt} and (${table.startedAt} is null or ${table.providerSentAt} >= ${table.startedAt}))) and (${table.completedAt} is null or (${table.completedAt} >= ${table.createdAt} and (${table.startedAt} is null or ${table.completedAt} >= ${table.startedAt})))`
    ),
    check(
      "RGHOp_error_bounded",
      sql`${table.error} is null or (jsonb_typeof(${table.error}) = 'object' and ${table.error} ?& array['code', 'message', 'retryable'] and (${table.error} - 'code' - 'message' - 'retryable' - 'details') = '{}'::jsonb and jsonb_typeof(${table.error}->'code') = 'string' and char_length(${table.error}->>'code') between 1 and 64 and jsonb_typeof(${table.error}->'message') = 'string' and char_length(${table.error}->>'message') between 1 and ${runnerMaxMessageLengthSql} and jsonb_typeof(${table.error}->'retryable') = 'boolean' and (not (${table.error} ? 'details') or (jsonb_typeof(${table.error}->'details') = 'string' and char_length(${table.error}->>'details') between 1 and ${runnerMaxDetailsLengthSql})))`
    ),
  ]
);

export type RunnerGitHubOperation = InferSelectModel<
  typeof runnerGitHubOperation
>;

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
