import { ipAddress } from "@vercel/functions";
import { auth } from "@/app/(auth)/auth";
import {
  abuseAdmissionResponse,
  enforceAbusePolicy,
} from "@/lib/abuse/enforce";
import { isAdminEmail } from "@/lib/admin/access";
import { adminDirectory } from "@/lib/db/queries";

/**
 * The Warden data route: fleet overview and the account directory in one
 * answer, because the caller is one screen and there is exactly one caller.
 *
 * A non-admin gets 404, not 403 — the surface's existence is itself
 * information. Shares the analytics read budget: the admin is one person and
 * a separate abuse class for them would be a policy entry nobody spends.
 */

const RANGES = [7, 30, 90] as const;
const DEFAULT_RANGE = 30;

export async function GET(request: Request) {
  const session = await auth();
  if (!isAdminEmail(session?.user?.email)) {
    return Response.json(
      { error: "not_found" },
      { headers: { "cache-control": "no-store" }, status: 404 }
    );
  }

  const admission = await enforceAbusePolicy({
    ip: ipAddress(request) ?? null,
    route: "analytics_read",
    userId: session?.user?.id,
  });
  if (admission.kind !== "allowed") {
    return abuseAdmissionResponse(admission);
  }

  const requested = Number(new URL(request.url).searchParams.get("days"));
  const days = RANGES.includes(requested as (typeof RANGES)[number])
    ? requested
    : DEFAULT_RANGE;

  return Response.json(await adminDirectory(days), {
    headers: { "cache-control": "no-store" },
  });
}
