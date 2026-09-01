import "server-only";

import {
  and,
  asc,
  eq,
  gt,
  isNotNull,
  isNull,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type {
  StripeReconciliationLease,
  StripeReconciliationStore,
  StripeReconciliationUser,
} from "@/lib/billing/stripe-reconciliation";
import { ChatbotError } from "../errors";
import { db } from "./queries";
import { stripeReconciliationRun, user } from "./schema";

const RECONCILIATION_RUN_ID = 1;

class LeaseLostError extends Error {}

/**
 * The exact entitlement tuple that a provider observation was based on.
 * PostgreSQL's `IS NOT DISTINCT FROM` makes nullable columns part of the
 * fence, rather than treating two nulls as an unknown comparison.
 */
export function stripeReconciliationSnapshotWhere(
  snapshot: StripeReconciliationUser
): SQL<unknown> {
  return and(
    eq(user.id, snapshot.id),
    eq(user.authVersion, snapshot.authVersion),
    sql`${user.billingPeriodStart} is not distinct from ${snapshot.billingPeriodStart}`,
    sql`${user.subscribedUntil} is not distinct from ${snapshot.subscribedUntil}`,
    sql`${user.stripeCustomerId} is not distinct from ${snapshot.stripeCustomerId}`,
    sql`${user.stripeSubscriptionId} is not distinct from ${snapshot.stripeSubscriptionId}`,
    sql`${user.subscriptionOverrideAction} is not distinct from ${snapshot.subscriptionOverrideAction ?? null}`,
    sql`${user.subscriptionOverrideAt} is not distinct from ${snapshot.subscriptionOverrideAt ?? null}`
  ) as SQL<unknown>;
}

function leaseScope(lease: StripeReconciliationLease): SQL<unknown> {
  return and(
    eq(stripeReconciliationRun.id, RECONCILIATION_RUN_ID),
    eq(stripeReconciliationRun.leaseOwner, lease.owner),
    eq(stripeReconciliationRun.leaseFence, lease.fence),
    isNotNull(stripeReconciliationRun.leaseExpiresAt),
    gt(stripeReconciliationRun.leaseExpiresAt, sql`clock_timestamp()`)
  ) as SQL<unknown>;
}

function leaseExpiry(leaseTtlMs: number) {
  return sql`clock_timestamp() + (${leaseTtlMs} * interval '1 millisecond')`;
}

export const databaseStripeReconciliationStore: StripeReconciliationStore = {
  async acquire(input) {
    try {
      await db
        .insert(stripeReconciliationRun)
        .values({ id: RECONCILIATION_RUN_ID })
        .onConflictDoNothing();
      const [claimed] = await db
        .update(stripeReconciliationRun)
        .set({
          leaseExpiresAt: leaseExpiry(input.leaseTtlMs),
          leaseFence: sql`${stripeReconciliationRun.leaseFence} + 1`,
          leaseOwner: input.owner,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(stripeReconciliationRun.id, RECONCILIATION_RUN_ID),
            or(
              isNull(stripeReconciliationRun.leaseOwner),
              lte(
                stripeReconciliationRun.leaseExpiresAt,
                sql`clock_timestamp()`
              )
            )
          )
        )
        .returning({
          cursor: stripeReconciliationRun.cursor,
          fence: stripeReconciliationRun.leaseFence,
          owner: stripeReconciliationRun.leaseOwner,
        });
      return claimed?.owner === input.owner
        ? {
            kind: "acquired",
            lease: {
              cursor: claimed.cursor,
              fence: claimed.fence,
              owner: claimed.owner,
            },
          }
        : { kind: "held" };
    } catch (error) {
      throw new ChatbotError("bad_request:database", { cause: error });
    }
  },

  async commit(input) {
    try {
      return await db.transaction(async (transaction) => {
        const [lease] = await transaction
          .select({ id: stripeReconciliationRun.id })
          .from(stripeReconciliationRun)
          .where(leaseScope(input.lease))
          .for("update")
          .limit(1);
        if (!lease) {
          return "lost";
        }

        const [owner] = await transaction
          .select({ id: user.id })
          .from(user)
          .where(stripeReconciliationSnapshotWhere(input.snapshot))
          .for("update")
          .limit(1);
        if (!owner) {
          return "conflict";
        }

        if (input.mutation) {
          const updated = await transaction
            .update(user)
            .set(input.mutation)
            .where(stripeReconciliationSnapshotWhere(input.snapshot))
            .returning({ id: user.id });
          if (!updated[0]) {
            return "conflict";
          }
        }

        const [advanced] = await transaction
          .update(stripeReconciliationRun)
          .set({
            cursor: input.nextCursor,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(leaseScope(input.lease))
          .returning({ id: stripeReconciliationRun.id });
        if (!advanced) {
          throw new LeaseLostError();
        }
        return "committed";
      });
    } catch (error) {
      if (error instanceof LeaseLostError) {
        return "lost";
      }
      throw new ChatbotError("bad_request:database", { cause: error });
    }
  },

  async release(lease) {
    try {
      const released = await db
        .update(stripeReconciliationRun)
        .set({
          leaseExpiresAt: null,
          leaseOwner: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(stripeReconciliationRun.id, RECONCILIATION_RUN_ID),
            eq(stripeReconciliationRun.leaseOwner, lease.owner),
            eq(stripeReconciliationRun.leaseFence, lease.fence)
          )
        )
        .returning({ id: stripeReconciliationRun.id });
      return released.length === 1 ? "released" : "lost";
    } catch (error) {
      throw new ChatbotError("bad_request:database", { cause: error });
    }
  },

  async renew(input) {
    try {
      const [renewed] = await db
        .update(stripeReconciliationRun)
        .set({
          leaseExpiresAt: leaseExpiry(input.leaseTtlMs),
          updatedAt: sql`clock_timestamp()`,
        })
        .where(leaseScope(input.lease))
        .returning({ cursor: stripeReconciliationRun.cursor });
      return renewed
        ? {
            kind: "renewed",
            lease: { ...input.lease, cursor: renewed.cursor },
          }
        : { kind: "lost" };
    } catch (error) {
      throw new ChatbotError("bad_request:database", { cause: error });
    }
  },

  async scanUsers(input) {
    try {
      return await db
        .select({
          authVersion: user.authVersion,
          billingPeriodStart: user.billingPeriodStart,
          id: user.id,
          stripeCustomerId: user.stripeCustomerId,
          stripeSubscriptionId: user.stripeSubscriptionId,
          subscribedUntil: user.subscribedUntil,
          subscriptionOverrideAction: user.subscriptionOverrideAction,
          subscriptionOverrideAt: user.subscriptionOverrideAt,
        })
        .from(user)
        .where(
          and(
            or(
              isNotNull(user.stripeCustomerId),
              isNotNull(user.stripeSubscriptionId)
            ),
            ...(input.after ? [gt(user.id, input.after)] : [])
          )
        )
        .orderBy(asc(user.id))
        .limit(input.limit);
    } catch (error) {
      throw new ChatbotError("bad_request:database", { cause: error });
    }
  },

  async wrapCursor(lease) {
    try {
      const [wrapped] = await db
        .update(stripeReconciliationRun)
        .set({ cursor: null, updatedAt: sql`clock_timestamp()` })
        .where(leaseScope(lease))
        .returning({ id: stripeReconciliationRun.id });
      return wrapped
        ? { kind: "wrapped", lease: { ...lease, cursor: null } }
        : { kind: "lost" };
    } catch (error) {
      throw new ChatbotError("bad_request:database", { cause: error });
    }
  },
};
