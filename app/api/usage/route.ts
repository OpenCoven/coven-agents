import { ipAddress } from "@vercel/functions";
import { auth } from "@/app/(auth)/auth";
import {
  abuseAdmissionResponse,
  enforceAbusePolicy,
} from "@/lib/abuse/enforce";
import { periodStart } from "@/lib/billing/period";
import {
  globalDailyRunCapFromEnv,
  TENANT_DAILY_MINUTE_CAP,
} from "@/lib/billing/run-reservations";
import { findUserById, runReservationUsageForTenant } from "@/lib/db/queries";
import { tenantForUser } from "@/lib/session";
import { usageResponsePayload } from "./payload";

/**
 * What this user can still admit in the current day and billing period.
 *
 * Global state is deliberately reduced to a boolean. Publishing deployment
 * capacity would turn an operational control into an attacker planning aid.
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
  const since = periodStart(resetsAt, owner?.billingPeriodStart ?? null);

  if (!(resetsAt && since)) {
    return Response.json(
      usageResponsePayload({
        globalAdmissionClosed: true,
        resetsAt,
        tenantDailyRemaining: 0,
        tenantMonthlyRemaining: 0,
      }),
      { headers: { "cache-control": "no-store" } }
    );
  }

  try {
    const usage = await runReservationUsageForTenant({
      globalDailyCap: globalDailyRunCapFromEnv(
        process.env.GLOBAL_DAILY_RUN_CAP
      ),
      keySecret: process.env.ABUSE_KEY_SECRET ?? "",
      periodStart: since,
      tenant: tenantForUser(session.user.id),
      tenantDailyCap: TENANT_DAILY_MINUTE_CAP,
    });

    return Response.json(usageResponsePayload({ ...usage, resetsAt }), {
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: "capacity_unavailable" },
      { headers: { "cache-control": "no-store" }, status: 503 }
    );
  }
}
