import { ipAddress } from "@vercel/functions";
import { auth } from "@/app/(auth)/auth";
import {
  abuseAdmissionResponse,
  enforceAbusePolicy,
} from "@/lib/abuse/enforce";
import { windowStart } from "@/lib/billing/history";
import { MONTHLY_RUN_CAP } from "@/lib/billing/limits";
import { runHistory } from "@/lib/db/queries";
import { tenantForUser } from "@/lib/session";

/**
 * Run volume over time, for one tenant.
 *
 * Reads `RunUsage`, which is the only per-run record this side of the runner.
 * It carries a tenant, a run id and the instant the run was counted — so this
 * answers how many runs happened and when, and deliberately answers nothing
 * about how they went. Outcome, duration and mission are not recorded, and a
 * page headed "read off run receipts" must not invent them.
 */

const RANGES = [7, 30, 90] as const;
const DEFAULT_RANGE = 30;

export async function GET(request: Request) {
  const session = await auth();

  if (!session?.user?.id) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const admission = await enforceAbusePolicy({
    ip: ipAddress(request) ?? null,
    route: "analytics_read",
    userId: session.user.id,
  });
  if (admission.kind !== "allowed") {
    return abuseAdmissionResponse(admission);
  }

  const requested = Number(new URL(request.url).searchParams.get("days"));
  // Clamped to the three ranges the console offers rather than trusting the
  // query string: an arbitrary value is a scan over an unbounded window.
  const days = RANGES.includes(requested as (typeof RANGES)[number])
    ? requested
    : DEFAULT_RANGE;

  const now = new Date();
  const since = windowStart(now, days);
  const series = await runHistory(tenantForUser(session.user.id), since, now);

  return Response.json(
    {
      cap: MONTHLY_RUN_CAP,
      days: series,
      range: days,
      total: series.reduce((sum, entry) => sum + entry.runs, 0),
    },
    { headers: { "cache-control": "no-store" } }
  );
}
