import { and, count, eq, gte } from "drizzle-orm";
import type { databaseFor } from "@/lib/db/access";
import { runUsage } from "@/lib/db/schema";

type Database = ReturnType<typeof databaseFor>;

/**
 * Scopes a usage count to one tenant and one billing period.
 *
 * Extracted so the scoping can be asserted without a database. Dropping either
 * condition still returns a number — the wrong one — which no outcome-based
 * test would notice.
 *
 * The lower bound is inclusive: a run recorded at the instant the period
 * begins belongs to that period.
 */
export function usageWhere(tenant: string, since: Date) {
  return and(eq(runUsage.tenant, tenant), gte(runUsage.countedAt, since));
}

/**
 * Records a run, returning whether it was newly counted.
 *
 * The unique index does the deduplication. `onConflictDoNothing` means a
 * repeated fetch for the same run is a no-op rather than a second charge, and
 * the returned row count says which happened without a second query.
 */
export async function countRun(
  db: Database,
  tenant: string,
  runId: string
): Promise<boolean> {
  const inserted = await db
    .insert(runUsage)
    .values({ runId, tenant })
    .onConflictDoNothing()
    .returning({ id: runUsage.id });

  return inserted.length > 0;
}

export async function usageFor(
  db: Database,
  tenant: string,
  since: Date
): Promise<number> {
  const [row] = await db
    .select({ used: count() })
    .from(runUsage)
    .where(usageWhere(tenant, since));

  return row?.used ?? 0;
}
