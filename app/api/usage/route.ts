import { ipAddress } from "@vercel/functions";
import { auth } from "@/app/(auth)/auth";
import {
  abuseAdmissionResponse,
  enforceAbusePolicy,
} from "@/lib/abuse/enforce";
import { readCampaignPolicy } from "@/lib/billing/campaign";
import { runEntitlementFor } from "@/lib/billing/entitlement";
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
  const now = new Date();
  const entitlement = runEntitlementFor(
    owner,
    now,
    readCampaignPolicy(process.env)
  );
  /**
   * What the account is counting against, and when it stops. A subscriber's
   * bucket resets at renewal; a campaign grant expires and does not return, so
   * the date shown is the grant's expiry rather than a renewal that will never
   * happen.
   */
  const resetsAt =
    entitlement?.source === "campaign"
      ? (owner?.campaignExpiresAt ?? null)
      : (owner?.subscribedUntil ?? null);
  const since = entitlement?.periodStart ?? null;

  if (!(entitlement && resetsAt && since)) {
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
      // Not the default. `reservationUsage` falls back to the 300-minute
      // subscriber bucket, which would report a campaign account's remainder
      // against an allowance it does not have.
      tenantMonthlyCap: entitlement.tenantMonthlyCap,
    });

    return Response.json(
      usageResponsePayload({
        ...usage,
        cap: entitlement.tenantMonthlyCap,
        resetsAt,
        source: entitlement.source,
      }),
      {
        headers: { "cache-control": "no-store" },
      }
    );
  } catch {
    return Response.json(
      { error: "capacity_unavailable" },
      { headers: { "cache-control": "no-store" }, status: 503 }
    );
  }
}
