import {
  abuseAdmissionResponse,
  type enforceAbusePolicy,
} from "@/lib/abuse/enforce";
import type { SessionLike } from "@/lib/auth/subscriber-access";
import { subscriberAccessResponse } from "@/lib/auth/subscriber-access";
import type { authorizeSubscriberAccess } from "@/lib/auth/subscriber-authorization.server";
import { windowStart } from "@/lib/billing/history";
import { MONTHLY_MINUTE_CAP } from "@/lib/billing/limits";
import type { runDurationSummary, runHistory } from "@/lib/db/queries";
import { tenantForUser } from "@/lib/session";

const RANGES = [7, 30, 90] as const;
const DEFAULT_RANGE = 30;

export type AnalyticsDependencies = {
  authorize: typeof authorizeSubscriberAccess;
  authenticate: () => Promise<SessionLike>;
  enforceAbuse: typeof enforceAbusePolicy;
  readDurations: typeof runDurationSummary;
  readHistory: typeof runHistory;
};

export async function analyticsResponse(
  request: Request,
  dependencies: AnalyticsDependencies,
  sourceIp: string | null
) {
  const session = await dependencies.authenticate();

  if (!session?.user?.id) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const access = await dependencies.authorize(session);
  if (access.kind !== "allowed") {
    return subscriberAccessResponse(access);
  }

  const admission = await dependencies.enforceAbuse({
    ip: sourceIp,
    route: "analytics_read",
    userId: access.userId,
  });
  if (admission.kind !== "allowed") {
    return abuseAdmissionResponse(admission);
  }

  const requested = Number(new URL(request.url).searchParams.get("days"));
  const days = RANGES.includes(requested as (typeof RANGES)[number])
    ? requested
    : DEFAULT_RANGE;

  const now = new Date();
  const since = windowStart(now, days);
  const tenant = tenantForUser(access.userId);
  const [series, durations] = await Promise.all([
    dependencies.readHistory(tenant, since, now),
    dependencies.readDurations(tenant, since),
  ]);

  return Response.json(
    {
      cap: MONTHLY_MINUTE_CAP,
      days: series,
      durations,
      minutes: series.reduce((sum, entry) => sum + entry.minutes, 0),
      range: days,
      total: series.reduce((sum, entry) => sum + entry.runs, 0),
      unit: "minutes",
    },
    { headers: { "cache-control": "no-store" } }
  );
}
