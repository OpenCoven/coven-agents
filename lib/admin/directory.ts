import { count, eq, gte, max, sql } from "drizzle-orm";
import type { DayCount } from "@/lib/billing/history";
import { fillDays, utcDay, windowStart } from "@/lib/billing/history";
import type { databaseFor } from "@/lib/db/access";
import { runReservation, runUsage, user } from "@/lib/db/schema";
import { tenantForUser } from "@/lib/session";
import { isSubscribedAt } from "@/lib/subscription";

/**
 * The Warden directory: every figure here is read off a real column.
 *
 * `RunUsage` records a tenant, a run id and the instant a run was counted,
 * and its reservation the minutes settled against the cap — so fleet volume,
 * per-account run counts, minutes and last-seen are real. Outcome and cost
 * have no column behind them and are deliberately absent; the screen names
 * those gaps instead of inventing numbers for them.
 */

export type AdminAccountRow = {
  /** Full uuid, for drill-down and copy. */
  id: string;
  /** Masked server-side; the raw address never reaches the browser. */
  email: string;
  plan: "subscriber" | "guest";
  /** `lapsed` is a subscriber row whose date is behind now. */
  status: "active" | "lapsed" | "guest";
  signupDay: string;
  lastRunDay: string | null;
  runs: number;
};

export type AdminOverview = {
  accountsTotal: number;
  activeAccounts: number;
  days: DayCount[];
  newAccounts: number;
  range: number;
  runsPrevious: number;
  runsTotal: number;
};

/**
 * `val@opencoven.ai` → `v··@o··.ai`. The mask keeps just enough shape to
 * tell rows apart while the address itself stays on the server; support
 * lookups go through the account id, which is exactly why search is id-only.
 */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${local.slice(0, 1)}··@${host.slice(0, 1)}··${tld}`;
}

type Database = ReturnType<typeof databaseFor>;

export async function adminOverview(
  db: Database,
  days: number
): Promise<AdminOverview> {
  const now = new Date();
  const since = windowStart(now, days);
  const previousSince = windowStart(now, days * 2);
  const day = sql<string>`to_char(date_trunc('day', ${runUsage.countedAt} at time zone 'UTC'), 'YYYY-MM-DD')`;

  const [byDay, previous, accounts, fresh, active] = await Promise.all([
    db
      .select({
        day,
        minutes: sql<number>`coalesce(sum(case when ${runReservation.state} = 'consumed' then ${runReservation.costUnits} else 0 end), 0)`,
        runs: count(runUsage.id),
      })
      .from(runUsage)
      .leftJoin(runReservation, eq(runReservation.runId, runUsage.runId))
      .where(gte(runUsage.countedAt, since))
      .groupBy(day),
    db
      .select({ runs: count() })
      .from(runUsage)
      .where(gte(runUsage.countedAt, previousSince)),
    db.select({ total: count() }).from(user),
    db.select({ total: count() }).from(user).where(gte(user.createdAt, since)),
    db
      .select({
        tenants: sql<number>`count(distinct ${runUsage.tenant})`,
      })
      .from(runUsage)
      .where(gte(runUsage.countedAt, since)),
  ]);

  const series = fillDays(
    byDay.map((row) => ({
      day: row.day,
      minutes: Number(row.minutes),
      runs: Number(row.runs),
    })),
    since,
    now
  );
  const runsTotal = series.reduce((sum, entry) => sum + entry.runs, 0);

  return {
    accountsTotal: Number(accounts[0]?.total ?? 0),
    activeAccounts: Number(active[0]?.tenants ?? 0),
    days: series,
    newAccounts: Number(fresh[0]?.total ?? 0),
    range: days,
    // The previous window is the double-window total minus this window's.
    runsPrevious: Number(previous[0]?.runs ?? 0) - runsTotal,
    runsTotal,
  };
}

export async function adminAccounts(
  db: Database,
  days: number
): Promise<AdminAccountRow[]> {
  const since = windowStart(new Date(), days);

  const [rows, usage] = await Promise.all([
    db
      .select({
        createdAt: user.createdAt,
        email: user.email,
        id: user.id,
        subscribedUntil: user.subscribedUntil,
      })
      .from(user),
    db
      .select({
        lastAt: max(runUsage.countedAt),
        runs: count(),
        tenant: runUsage.tenant,
      })
      .from(runUsage)
      .where(gte(runUsage.countedAt, since))
      .groupBy(runUsage.tenant),
  ]);

  const byTenant = new Map(
    usage.map((entry) => [
      entry.tenant,
      { lastAt: entry.lastAt, runs: Number(entry.runs) },
    ])
  );

  const now = new Date();
  return rows.map((row) => {
    const used = byTenant.get(tenantForUser(row.id));
    const subscriber = isSubscribedAt(row, now);
    return {
      email: maskEmail(row.email),
      id: row.id,
      lastRunDay: used?.lastAt ? utcDay(used.lastAt) : null,
      plan: row.subscribedUntil ? "subscriber" : "guest",
      runs: used?.runs ?? 0,
      signupDay: utcDay(row.createdAt),
      status: subscriber ? "active" : row.subscribedUntil ? "lapsed" : "guest",
    };
  });
}
