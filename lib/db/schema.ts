import { type InferSelectModel, sql } from "drizzle-orm";
import {
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
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { StoredIdempotencyResponseEnvelope } from "../abuse/idempotency-response";

export const user = pgTable(
  "User",
  {
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
    ciphertext: text("ciphertext").notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    harnessId: varchar("harnessId", { length: 32 }).notNull(),
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    iv: text("iv").notNull(),
    tenant: varchar("tenant", { length: 64 }).notNull(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
    wrappedKey: text("wrappedKey").notNull(),
  },
  (table) => [
    uniqueIndex("TenantCredential_tenant_harness_idx").on(
      table.tenant,
      table.harnessId
    ),
  ]
);

export type TenantCredential = InferSelectModel<typeof tenantCredential>;

/**
 * One row per counted run.
 *
 * The unique index is the counter's correctness, not an optimisation. The
 * worker may fetch a credential more than once for one run -- a retried start,
 * a resumed stream -- and counting per fetch would bill a customer for the
 * runner's internal behaviour.
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
