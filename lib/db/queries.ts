import "server-only";

import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  lte,
  ne,
  type SQL,
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { ArtifactKind } from "@/components/chat/artifact";
import type { VisibilityType } from "@/components/chat/visibility-selector";
import { adminAccounts, adminOverview } from "@/lib/admin/directory";
import type {
  IdempotencyClaimHandle,
  IdempotencyStore,
} from "../abuse/idempotency";
import { parseStoredIdempotencyResponseEnvelope } from "../abuse/idempotency-response";
import {
  CHECKOUT_ATTEMPT_KEY_HASH,
  CHECKOUT_ATTEMPT_OPERATION,
  type CheckoutAttemptLease,
  type CheckoutAttemptLeaseStore,
  parseCheckoutAttemptState,
  serializeCheckoutAttemptLeaseOwner,
  serializeCheckoutAttemptState,
} from "../billing/checkout-lease";
import type { DayCount } from "../billing/history";
import { fillDays, runsByDay } from "../billing/history";
import {
  drizzleRunReservationDatabase,
  reservationUsage,
} from "../billing/run-reservations";
import type {
  SubscriptionOverrideStore,
  SubscriptionOverrideUserUpdate,
} from "../billing/subscription-override";
import { countRun, usageFor } from "../billing/usage";
import {
  type MinutePackCreditInput,
  type MinutePackCreditResult,
  type StripeEventUpdateInput,
  type StripeEventWriteResult,
  type StripeManualReconciliationWriteResult,
  type StripeUserMutation,
  type StripeWebhookManualReconciliationRecord,
  stripeEventMutation,
} from "../billing/webhook";
import type { CredentialDevicePollStore } from "../credentials/device-poll";
import { commitCredentialDevicePollAuthorized } from "../credentials/device-poll-commit";
import type { PreparedCredentialWrite } from "../credentials/store";
import { ChatbotError } from "../errors";
import { drizzleCredentialDevicePollDatabase } from "./credential-device-poll";
import {
  type Chat,
  chat,
  type DBMessage,
  document,
  idempotencyRecord,
  message,
  minutePack,
  type Suggestion,
  stream,
  stripeEvent,
  stripeReconciliation,
  subscriptionOverrideAudit,
  suggestion,
  type User,
  user,
  vote,
} from "./schema";
import {
  checkoutAttemptProvenanceWhere,
  stripeEventOwnerWhere,
} from "./stripe-event";
import {
  subscriptionOverrideOwnerWhere,
  subscriptionOverrideWriteFenceWhere,
} from "./subscription-override";

const client = postgres(process.env.POSTGRES_URL ?? "");
export const db = drizzle(client);

export const databaseSubscriptionOverrideStore: SubscriptionOverrideStore = {
  transaction: async (callback) =>
    await db.transaction(async (transaction) =>
      callback({
        findUserForUpdate: async (userId) => {
          const [owner] = await transaction
            .select({
              authVersion: user.authVersion,
              billingPeriodStart: user.billingPeriodStart,
              id: user.id,
              subscribedUntil: user.subscribedUntil,
              subscriptionOverrideAction: user.subscriptionOverrideAction,
              subscriptionOverrideAt: user.subscriptionOverrideAt,
            })
            .from(user)
            .where(subscriptionOverrideOwnerWhere(userId))
            .for("update")
            .limit(1);
          return owner ?? null;
        },
        insertAudit: async (record) => {
          await transaction.insert(subscriptionOverrideAudit).values(record);
        },
        now: () => new Date(),
        updateUser: async (input: SubscriptionOverrideUserUpdate) => {
          const updated = await transaction
            .update(user)
            .set({
              authVersion: sql`${user.authVersion} + 1`,
              billingPeriodStart: input.billingPeriodStart,
              subscribedUntil: input.subscribedUntil,
              subscriptionOverrideAction: input.subscriptionOverrideAction,
              subscriptionOverrideAt: input.subscriptionOverrideAt,
            })
            .where(subscriptionOverrideWriteFenceWhere(input))
            .returning({ authVersion: user.authVersion });
          return (
            updated.length === 1 &&
            updated[0]?.authVersion === input.newAuthVersion
          );
        },
      })
    ),
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function emailMatches(normalizedEmail: string): SQL {
  return sql`lower(${user.email}) = lower(${normalizedEmail})`;
}

export async function getUser(email: string): Promise<User[]> {
  try {
    return await db
      .select()
      .from(user)
      .where(emailMatches(normalizeEmail(email)));
  } catch (error) {
    throw new ChatbotError("bad_request:database", { cause: error });
  }
}

export async function findSubscriptionOverrideUserByEmail(
  email: string
): Promise<{
  authVersion: number;
  billingPeriodStart: Date | null;
  id: string;
  subscribedUntil: Date | null;
  subscriptionOverrideAction: "grant" | "revoke" | null;
  subscriptionOverrideAt: Date | null;
} | null> {
  try {
    const matches = await db
      .select({
        authVersion: user.authVersion,
        billingPeriodStart: user.billingPeriodStart,
        id: user.id,
        subscribedUntil: user.subscribedUntil,
        subscriptionOverrideAction: user.subscriptionOverrideAction,
        subscriptionOverrideAt: user.subscriptionOverrideAt,
      })
      .from(user)
      .where(emailMatches(normalizeEmail(email)))
      .limit(2);
    return matches.length === 1 ? (matches[0] ?? null) : null;
  } catch (error) {
    throw new ChatbotError("bad_request:database", { cause: error });
  }
}

/**
 * Finds the account for a federated sign-in, creating it on first use.
 *
 * OAuth accounts carry no password: `User.password` is nullable, and
 * `authorize` already refuses any row without one, so a GitHub-only account
 * cannot be signed into with the credentials form.
 *
 * Matching is by email because that is what identifies a person across both
 * providers -- signing in with GitHub adopts an existing password account
 * rather than creating a duplicate. The caller must only ever pass an address
 * the provider has *verified*; see `selectPrimaryEmail`.
 */
export async function findOrCreateFederatedUser(email: string): Promise<User> {
  try {
    const normalizedEmail = normalizeEmail(email);
    const matches = await db
      .select()
      .from(user)
      .where(emailMatches(normalizedEmail))
      .limit(2);

    if (matches.length > 1) {
      throw new ChatbotError("bad_request:database");
    }
    if (matches[0]) {
      return matches[0];
    }

    const [created] = await db
      .insert(user)
      .values({ email: normalizedEmail, emailVerified: true })
      .returning();

    if (!created) {
      throw new ChatbotError("bad_request:database");
    }
    return created;
  } catch (error) {
    if (error instanceof ChatbotError) {
      throw error;
    }
    throw new ChatbotError("bad_request:database", { cause: error });
  }
}

export async function findVerifiedUserByEmail(
  email: string
): Promise<User | null> {
  try {
    const matches = await db
      .select()
      .from(user)
      .where(
        and(eq(user.emailVerified, true), emailMatches(normalizeEmail(email)))
      )
      .limit(2);
    return matches.length === 1 ? (matches[0] ?? null) : null;
  } catch (error) {
    throw new ChatbotError("bad_request:database", { cause: error });
  }
}

/**
 * Billing reads and writes.
 *
 * These live here rather than in the route handlers because `db` is
 * deliberately restricted to this module. Billing cannot go through
 * `databaseFor`: that function takes a `SubscriberSession`, and the entire
 * point of checkout is that the caller is *not* subscribed yet. Adding three
 * more names to the lint exemption list would have punched three more holes in
 * a rule whose comment says each one is a hole.
 */
export async function findUserById(id: string): Promise<User | null> {
  try {
    const [row] = await db.select().from(user).where(eq(user.id, id)).limit(1);
    return row ?? null;
  } catch (error) {
    throw new ChatbotError("bad_request:database", { cause: error });
  }
}

/**
 * Atomically advances the account's session authority. PostgreSQL evaluates
 * the increment while holding the row lock, so concurrent operators cannot
 * overwrite one another's revocation.
 */
export async function revokeSessionsByEmail(
  email: string
): Promise<{ authVersion: number; id: string } | null> {
  try {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
      return null;
    }

    const [row] = await db
      .update(user)
      .set({ authVersion: sql`${user.authVersion} + 1` })
      .where(
        and(
          emailMatches(normalizedEmail),
          sql`(select count(*) from ${user} where ${emailMatches(normalizedEmail)}) = 1`
        )
      )
      .returning({ authVersion: user.authVersion, id: user.id });
    return row ?? null;
  } catch (error) {
    throw new ChatbotError("bad_request:database", { cause: error });
  }
}

export async function findUserByStripeCustomerId(
  customerId: string
): Promise<User | null> {
  try {
    const [row] = await db
      .select()
      .from(user)
      .where(eq(user.stripeCustomerId, customerId))
      .limit(1);
    return row ?? null;
  } catch (error) {
    throw new ChatbotError("bad_request:database", { cause: error });
  }
}

export async function attachStripeCustomer(
  userId: string,
  customerId: string
): Promise<string> {
  try {
    const [owner] = await db
      .update(user)
      .set({
        stripeCustomerId: sql<string>`coalesce(${user.stripeCustomerId}, ${customerId})`,
      })
      .where(eq(user.id, userId))
      .returning({ stripeCustomerId: user.stripeCustomerId });

    if (!owner?.stripeCustomerId) {
      throw new Error("Stripe Customer owner does not exist.");
    }
    return owner.stripeCustomerId;
  } catch (error) {
    throw new ChatbotError("bad_request:database", { cause: error });
  }
}

export async function findCheckoutAttemptState(input: {
  attemptId: string;
  ownerId: string;
}) {
  try {
    const [record] = await db
      .select({ requestHash: idempotencyRecord.requestHash })
      .from(idempotencyRecord)
      .where(checkoutAttemptProvenanceWhere(input))
      .limit(1);
    return record ? parseCheckoutAttemptState(record.requestHash) : null;
  } catch (error) {
    throw new ChatbotError("bad_request:database", { cause: error });
  }
}

export async function recordStripeReconciliation(
  record: StripeWebhookManualReconciliationRecord
): Promise<StripeManualReconciliationWriteResult> {
  try {
    return await db.transaction(async (transaction) => {
      const claimed = await transaction
        .insert(stripeEvent)
        .values({ id: record.eventId })
        .onConflictDoNothing()
        .returning({ id: stripeEvent.id });
      if (claimed.length === 0) {
        return "duplicate";
      }

      await transaction.insert(stripeReconciliation).values({
        eventId: record.eventId,
        eventType: record.eventType,
        reason: record.reason,
        status: "pending",
      });
      return {
        kind: "manual_reconciliation",
        record: { ...record, status: "pending" },
      };
    });
  } catch (error) {
    throw new ChatbotError("bad_request:database", { cause: error });
  }
}

export async function applyStripeEventUpdate(
  input: StripeEventUpdateInput
): Promise<StripeEventWriteResult> {
  try {
    return await db.transaction(async (transaction) => {
      const claimed = await transaction
        .insert(stripeEvent)
        .values({ id: input.eventId })
        .onConflictDoNothing()
        .returning({ id: stripeEvent.id });
      if (claimed.length === 0) {
        return "duplicate";
      }

      const [owner] = await transaction
        .select()
        .from(user)
        .where(stripeEventOwnerWhere(input))
        .for("update")
        .limit(1);
      if (!owner) {
        throw new Error("Stripe webhook owner does not exist.");
      }

      const decision = stripeEventMutation(owner, input);
      if (
        decision &&
        "kind" in decision &&
        decision.kind === "manual_reconciliation"
      ) {
        const record: StripeWebhookManualReconciliationRecord = {
          eventId: input.eventId,
          eventType:
            input.eventType === "invoice_paid"
              ? "invoice.paid"
              : "invoice.payment_failed",
          reason: decision.reason,
          status: "pending",
        };
        await transaction.insert(stripeReconciliation).values(record);
        return { kind: "manual_reconciliation", record };
      }
      const mutation = decision as StripeUserMutation | null;
      if (!mutation) {
        return "applied";
      }

      const updated = await transaction
        .update(user)
        .set(mutation)
        .where(eq(user.id, owner.id))
        .returning({ id: user.id });

      if (updated.length !== 1) {
        throw new Error("Stripe webhook owner update failed.");
      }
      return "applied";
    });
  } catch (error) {
    throw new ChatbotError("bad_request:database", { cause: error });
  }
}

/**
 * Credits a paid top-up exactly once. The event claim and the unique session
 * index are both idempotency guards: a redelivery with a fresh event id still
 * finds the session already credited.
 */
export async function creditMinutePack(
  input: MinutePackCreditInput
): Promise<MinutePackCreditResult> {
  try {
    return await db.transaction(async (transaction) => {
      /**
       * Whether these minutes already landed is asked of the checkout
       * session, not of the event marker. The marker is written by any
       * handler that records evidence about an event — a manual
       * reconciliation row needs one for its foreign key — so treating its
       * presence as "already credited" would let an evidence write consume a
       * payment that was never credited. The session is unique per purchase
       * and is what the credit is keyed on.
       */
      const [credited] = await transaction
        .select({ id: minutePack.id })
        .from(minutePack)
        .where(eq(minutePack.stripeCheckoutSessionId, input.sessionId))
        .limit(1);
      if (credited) {
        return "duplicate";
      }

      /**
       * Ownership is checked before the event is claimed. Claiming first
       * would consume the only key Stripe has for this payment: the mismatch
       * returns normally, so the claim commits, and a redelivery after the
       * customer id is repaired reads as a duplicate and credits nothing. The
       * account can be wrong transiently — a customer id being backfilled or
       * corrected — so the event must stay redeliverable.
       */
      const [owner] = await transaction
        .select({ stripeCustomerId: user.stripeCustomerId })
        .from(user)
        .where(eq(user.id, input.userId))
        .for("update")
        .limit(1);
      if (!owner || owner.stripeCustomerId !== input.customerId) {
        return "owner_mismatch";
      }

      // Recording that the event was seen is idempotent: an earlier evidence
      // write may already hold the marker, and that must not stop the credit.
      await transaction
        .insert(stripeEvent)
        .values({ id: input.eventId })
        .onConflictDoNothing();

      const inserted = await transaction
        .insert(minutePack)
        .values({
          minutes: input.minutes,
          priceId: input.priceId,
          stripeCheckoutSessionId: input.sessionId,
          stripePaymentIntentId: input.paymentIntentId,
          userId: input.userId,
        })
        .onConflictDoNothing({ target: minutePack.stripeCheckoutSessionId })
        .returning({ id: minutePack.id });
      return inserted.length === 1 ? "applied" : "duplicate";
    });
  } catch (error) {
    throw new ChatbotError("bad_request:database", { cause: error });
  }
}

export const databaseCheckoutAttemptLeaseStore: CheckoutAttemptLeaseStore = {
  async checkpoint(input) {
    try {
      const [checkpointed] = await db
        .update(idempotencyRecord)
        .set({
          expiresAt: input.leaseExpiresAt,
          requestHash: serializeCheckoutAttemptLeaseOwner(
            input.lease.ownerToken,
            input.state
          ),
          updatedAt: input.updatedAt,
        })
        .where(
          and(
            checkoutAttemptLeaseScope(input.lease.ownerId),
            eq(idempotencyRecord.id, input.lease.attemptId),
            eq(
              idempotencyRecord.requestHash,
              serializeCheckoutAttemptLeaseOwner(
                input.lease.ownerToken,
                input.lease.attemptState
              )
            ),
            eq(idempotencyRecord.state, "in_progress"),
            gt(idempotencyRecord.expiresAt, input.updatedAt)
          )
        )
        .returning({ id: idempotencyRecord.id });
      if (!checkpointed) {
        return { kind: "lost" };
      }
      return {
        kind: "checkpointed",
        lease: {
          ...input.lease,
          attemptState: input.state,
          expiresAt: input.leaseExpiresAt,
        },
      };
    } catch (error) {
      throw new ChatbotError("bad_request:database", { cause: error });
    }
  },
  async claim(input) {
    try {
      return await db.transaction(async (transaction) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          // biome-ignore lint/performance/noAwaitInLoops: retries must observe the prior transactional write.
          const [inserted] = await transaction
            .insert(idempotencyRecord)
            .values({
              createdAt: input.now,
              expiresAt: input.leaseExpiresAt,
              keyHash: CHECKOUT_ATTEMPT_KEY_HASH,
              operation: CHECKOUT_ATTEMPT_OPERATION,
              ownerId: input.ownerId,
              requestHash: serializeCheckoutAttemptLeaseOwner(
                input.ownerToken,
                { kind: "fresh" }
              ),
              state: "in_progress",
              updatedAt: input.now,
            })
            .onConflictDoNothing()
            .returning({ attemptId: idempotencyRecord.id });

          if (inserted) {
            return {
              kind: "claimed",
              lease: checkoutAttemptLease(input, inserted.attemptId, {
                kind: "fresh",
              }),
            } as const;
          }

          const [existing] = await transaction
            .select({
              attemptId: idempotencyRecord.id,
              expiresAt: idempotencyRecord.expiresAt,
              requestHash: idempotencyRecord.requestHash,
              state: idempotencyRecord.state,
            })
            .from(idempotencyRecord)
            .where(checkoutAttemptLeaseScope(input.ownerId))
            .limit(1);
          if (!existing) {
            continue;
          }
          if (existing.state !== "in_progress") {
            throw new Error("Checkout lease entered an invalid state.");
          }
          if (existing.expiresAt.getTime() > input.now.getTime()) {
            return { kind: "in_progress" } as const;
          }

          const attemptState = parseCheckoutAttemptState(existing.requestHash);
          const [reclaimed] = await transaction
            .update(idempotencyRecord)
            .set({
              expiresAt: input.leaseExpiresAt,
              requestHash: serializeCheckoutAttemptLeaseOwner(
                input.ownerToken,
                attemptState
              ),
              updatedAt: input.now,
            })
            .where(
              and(
                checkoutAttemptLeaseScope(input.ownerId),
                eq(idempotencyRecord.id, existing.attemptId),
                eq(idempotencyRecord.requestHash, existing.requestHash),
                eq(idempotencyRecord.state, "in_progress"),
                eq(idempotencyRecord.expiresAt, existing.expiresAt),
                lte(idempotencyRecord.expiresAt, input.now)
              )
            )
            .returning({ attemptId: idempotencyRecord.id });

          if (reclaimed) {
            return {
              kind: "claimed",
              lease: checkoutAttemptLease(
                input,
                reclaimed.attemptId,
                attemptState
              ),
            } as const;
          }
        }

        throw new Error("Checkout lease changed during acquisition.");
      });
    } catch (error) {
      throw new ChatbotError("bad_request:database", { cause: error });
    }
  },

  async release(input) {
    try {
      const fence = and(
        checkoutAttemptLeaseScope(input.lease.ownerId),
        eq(idempotencyRecord.id, input.lease.attemptId),
        eq(
          idempotencyRecord.requestHash,
          serializeCheckoutAttemptLeaseOwner(
            input.lease.ownerToken,
            input.lease.attemptState
          )
        ),
        eq(idempotencyRecord.state, "in_progress"),
        gt(idempotencyRecord.expiresAt, input.releasedAt)
      );
      const released =
        input.disposition.kind === "retire_attempt"
          ? await db
              .delete(idempotencyRecord)
              .where(fence)
              .returning({ id: idempotencyRecord.id })
          : await db
              .update(idempotencyRecord)
              .set({
                expiresAt: input.releasedAt,
                requestHash: serializeCheckoutAttemptState(
                  input.disposition.state
                ),
                updatedAt: input.releasedAt,
              })
              .where(fence)
              .returning({ id: idempotencyRecord.id });
      return released.length === 1 ? "released" : "lost";
    } catch (error) {
      throw new ChatbotError("bad_request:database", { cause: error });
    }
  },

  async renew(input) {
    try {
      const [renewed] = await db
        .update(idempotencyRecord)
        .set({
          expiresAt: input.leaseExpiresAt,
          updatedAt: input.now,
        })
        .where(
          and(
            checkoutAttemptLeaseScope(input.lease.ownerId),
            eq(idempotencyRecord.id, input.lease.attemptId),
            eq(
              idempotencyRecord.requestHash,
              serializeCheckoutAttemptLeaseOwner(
                input.lease.ownerToken,
                input.lease.attemptState
              )
            ),
            eq(idempotencyRecord.state, "in_progress"),
            gt(idempotencyRecord.expiresAt, input.now)
          )
        )
        .returning({ id: idempotencyRecord.id });
      if (!renewed) {
        return { kind: "lost" };
      }
      return {
        kind: "renewed",
        lease: {
          ...input.lease,
          expiresAt: input.leaseExpiresAt,
        },
      };
    } catch (error) {
      throw new ChatbotError("bad_request:database", { cause: error });
    }
  },
};

export const databaseIdempotencyStore: IdempotencyStore = {
  async claim(input) {
    try {
      return await db.transaction(async (transaction) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          // biome-ignore lint/performance/noAwaitInLoops: retries must observe the prior transactional write.
          const [inserted] = await transaction
            .insert(idempotencyRecord)
            .values({
              createdAt: input.now,
              expiresAt: input.claimExpiresAt,
              keyHash: input.keyHash,
              operation: input.operation,
              ownerId: input.ownerId,
              requestHash: storedIdempotencyClaimHash(input),
              state: "in_progress",
              updatedAt: input.now,
            })
            .onConflictDoNothing()
            .returning({ id: idempotencyRecord.id });

          if (inserted) {
            return {
              claim: claimHandle(input, inserted.id),
              kind: "claimed",
            } as const;
          }

          if (input.reclaimCompleted) {
            const [reclaimedCompleted] = await transaction
              .update(idempotencyRecord)
              .set({
                expiresAt: input.claimExpiresAt,
                requestHash: storedIdempotencyClaimHash(input),
                responseJson: null,
                responseStatus: null,
                state: "in_progress",
                updatedAt: input.now,
              })
              .where(
                and(
                  idempotencyScope(input),
                  eq(idempotencyRecord.state, "completed"),
                  sql`left(${idempotencyRecord.requestHash}, 64) = ${input.requestHash}`
                )
              )
              .returning({ id: idempotencyRecord.id });

            if (reclaimedCompleted) {
              return {
                claim: claimHandle(input, reclaimedCompleted.id),
                kind: "claimed",
              } as const;
            }
          }

          const [reclaimed] = await transaction
            .update(idempotencyRecord)
            .set({
              expiresAt: input.claimExpiresAt,
              requestHash: storedIdempotencyClaimHash(input),
              responseJson: null,
              responseStatus: null,
              state: "in_progress",
              updatedAt: input.now,
            })
            .where(
              and(
                idempotencyScope(input),
                lte(idempotencyRecord.expiresAt, input.now)
              )
            )
            .returning({ id: idempotencyRecord.id });

          if (reclaimed) {
            return {
              claim: claimHandle(input, reclaimed.id),
              kind: "claimed",
            } as const;
          }

          const [existing] = await transaction
            .select({
              requestHash: idempotencyRecord.requestHash,
              responseJson: idempotencyRecord.responseJson,
              responseStatus: idempotencyRecord.responseStatus,
              state: idempotencyRecord.state,
            })
            .from(idempotencyRecord)
            .where(idempotencyScope(input))
            .limit(1);

          if (!existing) {
            continue;
          }
          if (
            idempotencyRequestHash(existing.requestHash) !== input.requestHash
          ) {
            return { kind: "conflict" } as const;
          }
          if (existing.state === "in_progress") {
            return { kind: "in_progress" } as const;
          }
          if (
            existing.responseJson === null ||
            existing.responseStatus === null
          ) {
            throw new Error("Completed idempotency record has no response.");
          }
          return {
            kind: "completed",
            response: {
              envelope: parseStoredIdempotencyResponseEnvelope(
                existing.responseJson
              ),
              status: existing.responseStatus,
            },
          } as const;
        }

        throw new Error("Idempotency claim changed during acquisition.");
      });
    } catch (error) {
      throw new ChatbotError("bad_request:database", { cause: error });
    }
  },
  async cleanupExpired(input) {
    try {
      const expired = db
        .select({ id: idempotencyRecord.id })
        .from(idempotencyRecord)
        .where(
          and(
            lte(idempotencyRecord.expiresAt, input.before),
            ne(idempotencyRecord.operation, CHECKOUT_ATTEMPT_OPERATION)
          )
        )
        .orderBy(asc(idempotencyRecord.expiresAt))
        .limit(input.limit);

      await db
        .delete(idempotencyRecord)
        .where(
          and(
            inArray(idempotencyRecord.id, expired),
            lte(idempotencyRecord.expiresAt, input.before),
            ne(idempotencyRecord.operation, CHECKOUT_ATTEMPT_OPERATION)
          )
        );
    } catch (error) {
      throw new ChatbotError("bad_request:database", { cause: error });
    }
  },

  async complete(input) {
    try {
      const completed = await db
        .update(idempotencyRecord)
        .set({
          expiresAt: input.expiresAt,
          responseJson: input.response.envelope,
          responseStatus: input.response.status,
          state: "completed",
          updatedAt: input.completedAt,
        })
        .where(
          and(
            idempotencyScope(input.claim),
            eq(
              idempotencyRecord.requestHash,
              storedIdempotencyClaimHash(input.claim)
            ),
            eq(idempotencyRecord.state, "in_progress"),
            eq(idempotencyRecord.expiresAt, input.claim.claimExpiresAt)
          )
        )
        .returning({ id: idempotencyRecord.id });

      if (completed.length !== 1) {
        return "lost";
      }
      return "completed";
    } catch (error) {
      throw new ChatbotError("bad_request:database", { cause: error });
    }
  },

  async release(input) {
    try {
      const released = await db
        .delete(idempotencyRecord)
        .where(
          and(
            idempotencyScope(input.claim),
            eq(
              idempotencyRecord.requestHash,
              storedIdempotencyClaimHash(input.claim)
            ),
            eq(idempotencyRecord.state, "in_progress"),
            eq(idempotencyRecord.expiresAt, input.claim.claimExpiresAt)
          )
        )
        .returning({ id: idempotencyRecord.id });
      return released.length === 1 ? "released" : "lost";
    } catch (error) {
      throw new ChatbotError("bad_request:database", { cause: error });
    }
  },

  async renew(input) {
    try {
      const [renewed] = await db
        .update(idempotencyRecord)
        .set({
          expiresAt: input.claimExpiresAt,
          updatedAt: input.now,
        })
        .where(
          and(
            idempotencyScope(input.claim),
            eq(
              idempotencyRecord.requestHash,
              storedIdempotencyClaimHash(input.claim)
            ),
            eq(idempotencyRecord.state, "in_progress"),
            eq(idempotencyRecord.expiresAt, input.claim.claimExpiresAt),
            gt(idempotencyRecord.expiresAt, input.now)
          )
        )
        .returning({ id: idempotencyRecord.id });
      if (!renewed) {
        return { kind: "lost" };
      }
      return {
        claim: {
          ...input.claim,
          claimExpiresAt: input.claimExpiresAt,
        },
        kind: "renewed",
      };
    } catch (error) {
      throw new ChatbotError("bad_request:database", { cause: error });
    }
  },

  async replaceCompleted(input) {
    try {
      if (!input.claim.recordId) {
        return "lost";
      }
      const replaced = await db
        .update(idempotencyRecord)
        .set({
          expiresAt: input.expiresAt,
          responseJson: input.response.envelope,
          responseStatus: input.response.status,
          updatedAt: input.completedAt,
        })
        .where(
          and(
            eq(idempotencyRecord.id, input.claim.recordId),
            eq(idempotencyRecord.ownerId, input.claim.ownerId),
            eq(idempotencyRecord.operation, input.claim.operation),
            eq(idempotencyRecord.keyHash, input.claim.keyHash),
            eq(
              idempotencyRecord.requestHash,
              storedIdempotencyClaimHash(input.claim)
            ),
            eq(idempotencyRecord.state, "completed")
          )
        )
        .returning({ id: idempotencyRecord.id });
      return replaced.length === 1 ? "replaced" : "lost";
    } catch (error) {
      throw new ChatbotError("bad_request:database", { cause: error });
    }
  },
};

export const databaseCredentialDevicePollStore: CredentialDevicePollStore<PreparedCredentialWrite> =
  {
    ...databaseIdempotencyStore,
    commitAuthorized: (input) =>
      commitCredentialDevicePollAuthorized(
        drizzleCredentialDevicePollDatabase(db),
        input
      ),
    renew: databaseIdempotencyStore.renew as NonNullable<
      IdempotencyStore["renew"]
    >,
  };

function checkoutAttemptLease(
  input: {
    leaseExpiresAt: Date;
    ownerId: string;
    ownerToken: string;
  },
  attemptId: string,
  attemptState: CheckoutAttemptLease["attemptState"]
): CheckoutAttemptLease {
  return {
    attemptId,
    attemptState,
    expiresAt: input.leaseExpiresAt,
    ownerId: input.ownerId,
    ownerToken: input.ownerToken,
  };
}

function checkoutAttemptLeaseScope(ownerId: string) {
  return and(
    eq(idempotencyRecord.ownerId, ownerId),
    eq(idempotencyRecord.operation, CHECKOUT_ATTEMPT_OPERATION),
    eq(idempotencyRecord.keyHash, CHECKOUT_ATTEMPT_KEY_HASH)
  );
}

function idempotencyScope(input: {
  keyHash: string;
  operation: string;
  ownerId: string;
}) {
  return and(
    eq(idempotencyRecord.ownerId, input.ownerId),
    eq(idempotencyRecord.operation, input.operation),
    eq(idempotencyRecord.keyHash, input.keyHash)
  );
}

function claimHandle(
  input: {
    claimExpiresAt: Date;
    keyHash: string;
    operation: string;
    ownerToken?: string;
    ownerId: string;
    requestHash: string;
  },
  recordId: string
): IdempotencyClaimHandle {
  return {
    claimExpiresAt: input.claimExpiresAt,
    keyHash: input.keyHash,
    operation: input.operation,
    ...(input.ownerToken ? { ownerToken: input.ownerToken } : {}),
    ownerId: input.ownerId,
    recordId,
    requestHash: input.requestHash,
  };
}

function storedIdempotencyClaimHash(input: {
  ownerToken?: string;
  requestHash: string;
}): string {
  return input.ownerToken
    ? `${input.requestHash}:${input.ownerToken}`
    : input.requestHash;
}

function idempotencyRequestHash(storedRequestHash: string): string {
  return storedRequestHash.length > 64 && storedRequestHash[64] === ":"
    ? storedRequestHash.slice(0, 64)
    : storedRequestHash;
}

/** Runs counted for a tenant since the start of the current period. */
export async function countRunsInPeriod(
  tenant: string,
  since: Date
): Promise<number> {
  return await usageFor(db, tenant, since);
}

export async function runReservationUsageForTenant(
  input: Parameters<typeof reservationUsage>[1]
) {
  return await reservationUsage(drizzleRunReservationDatabase(db), input);
}

/** Run volume per day for a tenant, oldest first, gaps filled with zeroes. */
export async function runHistory(
  tenant: string,
  since: Date,
  through: Date
): Promise<DayCount[]> {
  return fillDays(await runsByDay(db, tenant, since), since, through);
}

/** Records a run against a tenant, ignoring a repeat of the same run id. */
export async function recordRun(
  tenant: string,
  runId: string
): Promise<boolean> {
  return await countRun(db, tenant, runId);
}

export async function saveChat({
  id,
  userId,
  title,
  visibility,
}: {
  id: string;
  userId: string;
  title: string;
  visibility: VisibilityType;
}) {
  try {
    return await db.insert(chat).values({
      createdAt: new Date(),
      id,
      title,
      userId,
      visibility,
    });
  } catch (error) {
    throw new ChatbotError("bad_request:database", {
      cause: error,
    });
  }
}

export async function deleteChatById({ id }: { id: string }) {
  try {
    await db.delete(vote).where(eq(vote.chatId, id));
    await db.delete(message).where(eq(message.chatId, id));
    await db.delete(stream).where(eq(stream.chatId, id));

    const [chatsDeleted] = await db
      .delete(chat)
      .where(eq(chat.id, id))
      .returning();
    return chatsDeleted;
  } catch (error) {
    throw new ChatbotError("bad_request:database", { cause: error });
  }
}

export async function deleteAllChatsByUserId({ userId }: { userId: string }) {
  try {
    const userChats = await db
      .select({ id: chat.id })
      .from(chat)
      .where(eq(chat.userId, userId));

    if (userChats.length === 0) {
      return { deletedCount: 0 };
    }

    const chatIds = userChats.map((c) => c.id);

    await db.delete(vote).where(inArray(vote.chatId, chatIds));
    await db.delete(message).where(inArray(message.chatId, chatIds));
    await db.delete(stream).where(inArray(stream.chatId, chatIds));

    const deletedChats = await db
      .delete(chat)
      .where(eq(chat.userId, userId))
      .returning();

    return { deletedCount: deletedChats.length };
  } catch (error) {
    throw new ChatbotError("bad_request:database", { cause: error });
  }
}

export async function getChatsByUserId({
  id,
  limit,
  startingAfter,
  endingBefore,
}: {
  id: string;
  limit: number;
  startingAfter: string | null;
  endingBefore: string | null;
}) {
  try {
    const extendedLimit = limit + 1;

    const query = (whereCondition?: SQL<unknown>) =>
      db
        .select()
        .from(chat)
        .where(
          whereCondition
            ? and(whereCondition, eq(chat.userId, id))
            : eq(chat.userId, id)
        )
        .orderBy(desc(chat.createdAt))
        .limit(extendedLimit);

    let filteredChats: Chat[] = [];

    if (startingAfter) {
      const [selectedChat] = await db
        .select()
        .from(chat)
        .where(eq(chat.id, startingAfter))
        .limit(1);

      if (!selectedChat) {
        throw new ChatbotError(
          "not_found:database",
          `Chat with id ${startingAfter} not found`
        );
      }

      filteredChats = await query(gt(chat.createdAt, selectedChat.createdAt));
    } else if (endingBefore) {
      const [selectedChat] = await db
        .select()
        .from(chat)
        .where(eq(chat.id, endingBefore))
        .limit(1);

      if (!selectedChat) {
        throw new ChatbotError(
          "not_found:database",
          `Chat with id ${endingBefore} not found`
        );
      }

      filteredChats = await query(lt(chat.createdAt, selectedChat.createdAt));
    } else {
      filteredChats = await query();
    }

    const hasMore = filteredChats.length > limit;

    return {
      chats: hasMore ? filteredChats.slice(0, limit) : filteredChats,
      hasMore,
    };
  } catch (error) {
    throw new ChatbotError("bad_request:database", { cause: error });
  }
}

export async function getChatById({ id }: { id: string }) {
  try {
    const [selectedChat] = await db.select().from(chat).where(eq(chat.id, id));
    if (!selectedChat) {
      return null;
    }

    return selectedChat;
  } catch (error) {
    throw new ChatbotError("bad_request:database", {
      cause: error,
    });
  }
}

export async function saveMessages({ messages }: { messages: DBMessage[] }) {
  try {
    return await db.insert(message).values(messages);
  } catch (error) {
    throw new ChatbotError("bad_request:database", {
      cause: error,
    });
  }
}

export async function updateMessage({
  id,
  parts,
}: {
  id: string;
  parts: DBMessage["parts"];
}) {
  try {
    return await db.update(message).set({ parts }).where(eq(message.id, id));
  } catch (error) {
    throw new ChatbotError("bad_request:database", {
      cause: error,
    });
  }
}

export async function getMessagesByChatId({ id }: { id: string }) {
  try {
    return await db
      .select()
      .from(message)
      .where(eq(message.chatId, id))
      .orderBy(asc(message.createdAt));
  } catch (error) {
    throw new ChatbotError("bad_request:database", { cause: error });
  }
}

export async function voteMessage({
  chatId,
  messageId,
  type,
}: {
  chatId: string;
  messageId: string;
  type: "up" | "down";
}) {
  try {
    const [existingVote] = await db
      .select()
      .from(vote)
      .where(and(eq(vote.messageId, messageId)));

    if (existingVote) {
      return await db
        .update(vote)
        .set({ isUpvoted: type === "up" })
        .where(and(eq(vote.messageId, messageId), eq(vote.chatId, chatId)));
    }
    return await db.insert(vote).values({
      chatId,
      isUpvoted: type === "up",
      messageId,
    });
  } catch (error) {
    throw new ChatbotError("bad_request:database", {
      cause: error,
    });
  }
}

export async function getVotesByChatId({ id }: { id: string }) {
  try {
    return await db.select().from(vote).where(eq(vote.chatId, id));
  } catch (error) {
    throw new ChatbotError("bad_request:database", { cause: error });
  }
}

export async function saveDocument({
  id,
  title,
  kind,
  content,
  userId,
}: {
  id: string;
  title: string;
  kind: ArtifactKind;
  content: string;
  userId: string;
}) {
  try {
    return await db
      .insert(document)
      .values({
        content,
        createdAt: new Date(),
        id,
        kind,
        title,
        userId,
      })
      .returning();
  } catch (error) {
    throw new ChatbotError("bad_request:database", {
      cause: error,
    });
  }
}

export async function updateDocumentContent({
  id,
  content,
}: {
  id: string;
  content: string;
}) {
  try {
    const docs = await db
      .select()
      .from(document)
      .where(eq(document.id, id))
      .orderBy(desc(document.createdAt))
      .limit(1);

    const [latest] = docs;
    if (!latest) {
      throw new ChatbotError("not_found:database", "Document not found");
    }

    return await db
      .update(document)
      .set({ content })
      .where(and(eq(document.id, id), eq(document.createdAt, latest.createdAt)))
      .returning();
  } catch (error) {
    if (error instanceof ChatbotError) {
      throw error;
    }
    throw new ChatbotError("bad_request:database", {
      cause: error,
    });
  }
}

export async function getDocumentsById({ id }: { id: string }) {
  try {
    const documents = await db
      .select()
      .from(document)
      .where(eq(document.id, id))
      .orderBy(asc(document.createdAt));

    return documents;
  } catch (error) {
    throw new ChatbotError("bad_request:database", { cause: error });
  }
}

export async function getDocumentById({ id }: { id: string }) {
  try {
    const [selectedDocument] = await db
      .select()
      .from(document)
      .where(eq(document.id, id))
      .orderBy(desc(document.createdAt));

    return selectedDocument;
  } catch (error) {
    throw new ChatbotError("bad_request:database", { cause: error });
  }
}

export async function deleteDocumentsByIdAfterTimestamp({
  id,
  timestamp,
}: {
  id: string;
  timestamp: Date;
}) {
  try {
    await db
      .delete(suggestion)
      .where(
        and(
          eq(suggestion.documentId, id),
          gt(suggestion.documentCreatedAt, timestamp)
        )
      );

    return await db
      .delete(document)
      .where(and(eq(document.id, id), gt(document.createdAt, timestamp)))
      .returning();
  } catch (error) {
    throw new ChatbotError("bad_request:database", { cause: error });
  }
}

export async function saveSuggestions({
  suggestions,
}: {
  suggestions: Suggestion[];
}) {
  try {
    return await db.insert(suggestion).values(suggestions);
  } catch (error) {
    throw new ChatbotError("bad_request:database", { cause: error });
  }
}

export async function getSuggestionsByDocumentId({
  documentId,
}: {
  documentId: string;
}) {
  try {
    return await db
      .select()
      .from(suggestion)
      .where(eq(suggestion.documentId, documentId));
  } catch (error) {
    throw new ChatbotError("bad_request:database", { cause: error });
  }
}

export async function getMessageById({ id }: { id: string }) {
  try {
    return await db.select().from(message).where(eq(message.id, id));
  } catch (error) {
    throw new ChatbotError("bad_request:database", { cause: error });
  }
}

export async function deleteMessagesByChatIdAfterTimestamp({
  chatId,
  timestamp,
}: {
  chatId: string;
  timestamp: Date;
}) {
  try {
    const messagesToDelete = await db
      .select({ id: message.id })
      .from(message)
      .where(
        and(eq(message.chatId, chatId), gte(message.createdAt, timestamp))
      );

    const messageIds = messagesToDelete.map(
      (currentMessage) => currentMessage.id
    );

    if (messageIds.length > 0) {
      await db
        .delete(vote)
        .where(
          and(eq(vote.chatId, chatId), inArray(vote.messageId, messageIds))
        );

      return await db
        .delete(message)
        .where(
          and(eq(message.chatId, chatId), inArray(message.id, messageIds))
        );
    }
  } catch (error) {
    throw new ChatbotError("bad_request:database", { cause: error });
  }
}

export async function updateChatVisibilityById({
  chatId,
  visibility,
}: {
  chatId: string;
  visibility: "private" | "public";
}) {
  try {
    return await db.update(chat).set({ visibility }).where(eq(chat.id, chatId));
  } catch (error) {
    throw new ChatbotError("bad_request:database", { cause: error });
  }
}

export async function updateChatTitleById({
  chatId,
  title,
}: {
  chatId: string;
  title: string;
}) {
  try {
    return await db.update(chat).set({ title }).where(eq(chat.id, chatId));
  } catch {
    // Best effort title update.
  }
}

export async function getMessageCountByUserId({
  id,
  differenceInHours,
}: {
  id: string;
  differenceInHours: number;
}) {
  try {
    const cutoffTime = new Date(
      Date.now() - differenceInHours * 60 * 60 * 1000
    );

    const [stats] = await db
      .select({ count: count(message.id) })
      .from(message)
      .innerJoin(chat, eq(message.chatId, chat.id))
      .where(
        and(
          eq(chat.userId, id),
          gte(message.createdAt, cutoffTime),
          eq(message.role, "user")
        )
      )
      .execute();

    return stats?.count ?? 0;
  } catch (error) {
    throw new ChatbotError("bad_request:database", { cause: error });
  }
}

export async function createStreamId({
  streamId,
  chatId,
}: {
  streamId: string;
  chatId: string;
}) {
  try {
    await db
      .insert(stream)
      .values({ chatId, createdAt: new Date(), id: streamId });
  } catch (error) {
    throw new ChatbotError("bad_request:database", { cause: error });
  }
}

export async function getStreamIdsByChatId({ chatId }: { chatId: string }) {
  try {
    const streamIds = await db
      .select({ id: stream.id })
      .from(stream)
      .where(eq(stream.chatId, chatId))
      .orderBy(asc(stream.createdAt))
      .execute();

    return streamIds.map(({ id }) => id);
  } catch (error) {
    throw new ChatbotError("bad_request:database", { cause: error });
  }
}

/** The Warden's fleet overview and account directory, owner-gated upstream. */
export async function adminDirectory(days: number) {
  const [overview, accounts] = await Promise.all([
    adminOverview(db, days),
    adminAccounts(db, days),
  ]);
  return { accounts, overview };
}
