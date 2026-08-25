import { asc, count, sql } from "drizzle-orm";
import { usageWhere } from "@/lib/billing/usage";
import type { databaseFor } from "@/lib/db/access";
import { runUsage } from "@/lib/db/schema";

type Database = ReturnType<typeof databaseFor>;

export type DayCount = { day: string; runs: number };

const MS_PER_DAY = 86_400_000;

/**
 * Run volume per day, for one tenant.
 *
 * `RunUsage` is the only per-run record this side of the runner: one row per
 * counted run, carrying a tenant, a run id and the instant it was counted. It
 * has no outcome, no duration and no mission, so volume over time is the only
 * series that can honestly be drawn from it. Anything richer would have to be
 * invented, and an invented number on a page headed "read off run receipts" is
 * worse than an empty panel.
 *
 * Grouped in the database rather than by reading every row and bucketing here,
 * because a busy tenant over ninety days is thousands of rows to move for a
 * number that is a `count(*)`.
 */
export async function runsByDay(
  db: Database,
  tenant: string,
  since: Date
): Promise<DayCount[]> {
  // Truncated in UTC so the bucket a run lands in does not depend on where the
  // server happens to be, which would silently shift the whole series.
  const day = sql<string>`to_char(date_trunc('day', ${runUsage.countedAt} at time zone 'UTC'), 'YYYY-MM-DD')`;

  const rows = await db
    .select({ day, runs: count() })
    .from(runUsage)
    .where(usageWhere(tenant, since))
    .groupBy(day)
    .orderBy(asc(day));

  return rows.map((row) => ({ day: row.day, runs: Number(row.runs) }));
}

/** The UTC calendar day an instant falls in, as `YYYY-MM-DD`. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Fills a sparse series so every day in the window is present.
 *
 * The database returns only days that had a run. Charting that directly draws
 * a quiet week as a short, dense series rather than as the gap it was — the
 * shape would say "steady use" when the truth is "nothing happened". Zero-runs
 * days have to be zeroes, not absences.
 */
export function fillDays(
  rows: readonly DayCount[],
  from: Date,
  through: Date
): DayCount[] {
  const counts = new Map(rows.map((row) => [row.day, row.runs]));
  const filled: DayCount[] = [];

  const cursor = Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth(),
    from.getUTCDate()
  );
  const end = Date.UTC(
    through.getUTCFullYear(),
    through.getUTCMonth(),
    through.getUTCDate()
  );

  for (let at = cursor; at <= end; at += MS_PER_DAY) {
    const day = utcDay(new Date(at));
    filled.push({ day, runs: counts.get(day) ?? 0 });
  }

  return filled;
}

/** The instant `days` calendar days back from `now`, at UTC midnight. */
export function windowStart(now: Date, days: number): Date {
  const start = new Date(now.getTime() - (days - 1) * MS_PER_DAY);
  return new Date(
    Date.UTC(
      start.getUTCFullYear(),
      start.getUTCMonth(),
      start.getUTCDate(),
      0,
      0,
      0,
      0
    )
  );
}
