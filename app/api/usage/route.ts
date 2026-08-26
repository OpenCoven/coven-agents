import { ipAddress } from "@vercel/functions";
import { auth } from "@/app/(auth)/auth";
import {
  abuseAdmissionResponse,
  enforceAbusePolicy,
} from "@/lib/abuse/enforce";
import { MONTHLY_RUN_CAP } from "@/lib/billing/limits";
import { periodStart } from "@/lib/billing/period";
import { countRunsInPeriod, findUserById } from "@/lib/db/queries";
import { tenantForUser } from "@/lib/session";

/**
 * What this user has spent in the current period.
 *
 * Reads the same counter and the same constant the enforcement point uses, so
 * the number shown and the number enforced cannot drift. A cap you cannot see
 * is indistinguishable from a bug, and two caps that disagree are worse.
 */
export async function GET(request: Request) {
  const session = await auth();

  if (!session?.user?.id) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const admission = await enforceAbusePolicy({
    ip: ipAddress(request) ?? null,
    route: "usage_read",
    userId: session.user.id,
  });
  if (admission.kind !== "allowed") {
    return abuseAdmissionResponse(admission);
  }

  const owner = await findUserById(session.user.id);
  const resetsAt = owner?.subscribedUntil ?? null;
  const since = periodStart(resetsAt);

  return Response.json(
    {
      cap: MONTHLY_RUN_CAP,
      resetsAt: resetsAt?.toISOString() ?? null,
      used: since
        ? await countRunsInPeriod(tenantForUser(session.user.id), since)
        : 0,
    },
    { headers: { "cache-control": "no-store" } }
  );
}
