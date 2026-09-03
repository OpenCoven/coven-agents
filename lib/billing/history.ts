import { asc, count, eq, sql } from "drizzle-orm";
import { usageWhere } from "@/lib/billing/usage";
import type { databaseFor } from "@/lib/db/access";
import { runReservation, runUsage } from "@/lib/db/schema";

type Database = ReturnType<typeof databaseFor>;

export type DayCount = { day: string; minutes: number; runs: number };

const MS_PER_DAY = 86_400_000;

/**
 * Run volume and settled minutes per day, for one tenant.
 *
 * `RunUsage` is the per-run receipt this side of the runner: one row per
 * counted run, carrying a tenant, a run id and the instant it was counted. Its
 * reservation carries the minutes the cap was charged — the runner's time
 * limit while the run is live, settled to the whole minutes it held once it
 * ends. Neither has an outcome or a mission, so volume and minutes over time
 * are the only series that can honestly be drawn. Anything richer would have
 * to be invented, and an invented number on a page headed "read off run
 * receipts" is worse than an empty panel.
 *
 * Minutes come from the reservation the cap is enforced against, joined by
 * run id, so this series and the usage meter cannot disagree. Only consumed
 * reservations count: a released one never launched.
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

  const minutes = sql<number>`coalesce(sum(case when ${runReservation.state} = 'consumed' then ${runReservation.costUnits} else 0 end), 0)`;

  const rows = await db
    .select({ day, minutes, runs: count(runUsage.id) })
    .from(runUsage)
    .leftJoin(runReservation, eq(runReservation.runId, runUsage.runId))
    .where(usageWhere(tenant, since))
    .groupBy(day)
    .orderBy(asc(day));

  return rows.map((row) => ({
    day: row.day,
    minutes: Number(row.minutes),
    runs: Number(row.runs),
  }));
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
  const counts = new Map(rows.map((row) => [row.day, row]));
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
    const entry = counts.get(day);
    filled.push({
      day,
      minutes: entry?.minutes ?? 0,
      runs: entry?.runs ?? 0,
    });
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
