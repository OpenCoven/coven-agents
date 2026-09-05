import { ipAddress } from "@vercel/functions";
import { auth } from "@/app/(auth)/auth";
import { enforceAbusePolicy } from "@/lib/abuse/enforce";
import {
  type AnalyticsDependencies,
  analyticsResponse as analyticsResponseWithAuthority,
} from "@/lib/analytics/response";
import { authorizeSubscriberAccess } from "@/lib/auth/subscriber-authorization.server";
import { runDurationSummary, runHistory } from "@/lib/db/queries";

/**
 * Run volume over time, for one tenant.
 *
 * Reads `RunUsage` and the reservation each run was admitted against. Between
 * them they carry a tenant, a run id, the instant the run was counted, the
 * minutes charged, and, once terminal cleanup has measured it, how long the
 * run actually held. So this answers how many runs happened, when, how long
 * they took, and what they cost. Outcome and mission are still not recorded,
 * and a page headed "read off run receipts" must not invent them.
 */

const analyticsDependencies: AnalyticsDependencies = {
  authenticate: auth,
  authorize: authorizeSubscriberAccess,
  enforceAbuse: enforceAbusePolicy,
  readDurations: runDurationSummary,
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
