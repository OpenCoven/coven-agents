import "server-only";

import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import type {
  UnmeteredRun,
  UsageMeteringStore,
} from "@/lib/billing/usage-metering";
import { db } from "./queries";
import { runReservation, runUsage, user } from "./schema";

/**
 * Locks only the reservation side of the join: the usage receipt is read for
 * its raw tenant and never changes here. `SKIP LOCKED` lets two overlapping
 * schedules share the backlog instead of one waiting on the other.
 */
export const databaseUsageMeteringStore: UsageMeteringStore = {
  transaction: (callback) =>
    db.transaction((transaction) =>
      callback({
        lockUnmetered: async (limit) => {
          const rows = await transaction
            .select({
              costUnits: runReservation.costUnits,
              runId: runReservation.runId,
              settledAt: runReservation.settledAt,
              tenant: runUsage.tenant,
            })
            .from(runReservation)
            .leftJoin(runUsage, eq(runUsage.runId, runReservation.runId))
            .where(
              and(
                eq(runReservation.state, "consumed"),
                isNotNull(runReservation.settledAt),
                isNull(runReservation.meteredAt)
              )
            )
            .orderBy(asc(runReservation.settledAt), asc(runReservation.runId))
            .limit(limit)
            .for("update", { of: runReservation, skipLocked: true });
          const unmetered: UnmeteredRun[] = [];
          for (const row of rows) {
            if (row.settledAt) {
              unmetered.push({
                costUnits: row.costUnits,
                runId: row.runId,
                settledAt: row.settledAt,
                tenant: row.tenant ?? null,
              });
            }
          }
          return unmetered;
        },
        markMetered: async (runId, outcome, meteredAt) => {
          const updated = await transaction
            .update(runReservation)
            .set({ meteredAt, meteringOutcome: outcome })
            .where(
              and(
                eq(runReservation.runId, runId),
                eq(runReservation.state, "consumed"),
                isNotNull(runReservation.settledAt),
                isNull(runReservation.meteredAt)
              )
            )
            .returning({ runId: runReservation.runId });
          return updated.length === 1;
        },
        stripeCustomerIdForUser: async (userId) => {
          const [row] = await transaction
            .select({ stripeCustomerId: user.stripeCustomerId })
            .from(user)
            .where(eq(user.id, userId))
            .limit(1);
          return row?.stripeCustomerId ?? null;
        },
      })
    ),
};
