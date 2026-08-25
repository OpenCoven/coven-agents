import { auth } from "@/app/(auth)/auth";
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
export async function GET() {
  const session = await auth();

  if (!session?.user?.id) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
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
