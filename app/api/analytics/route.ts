import { ipAddress } from "@vercel/functions";
import { auth } from "@/app/(auth)/auth";
import { enforceAbusePolicy } from "@/lib/abuse/enforce";
import {
  type AnalyticsDependencies,
  analyticsResponse as analyticsResponseWithAuthority,
} from "@/lib/analytics/response";
import { authorizeSubscriberAccess } from "@/lib/auth/subscriber-authorization.server";
import { runHistory } from "@/lib/db/queries";

/**
 * Run volume over time, for one tenant.
 *
 * Reads `RunUsage`, which is the only per-run record this side of the runner.
 * It carries a tenant, a run id and the instant the run was counted — so this
 * answers how many runs happened and when, and deliberately answers nothing
 * about how they went. Outcome, duration and mission are not recorded, and a
 * page headed "read off run receipts" must not invent them.
 */

const analyticsDependencies: AnalyticsDependencies = {
  authenticate: auth,
  authorize: authorizeSubscriberAccess,
  enforceAbuse: enforceAbusePolicy,
  readHistory: runHistory,
};

export function analyticsResponse(
  request: Request,
  dependencies: AnalyticsDependencies = analyticsDependencies
) {
  return analyticsResponseWithAuthority(
    request,
    dependencies,
    ipAddress(request) ?? null
  );
}

export function GET(request: Request) {
  return analyticsResponse(request);
}
