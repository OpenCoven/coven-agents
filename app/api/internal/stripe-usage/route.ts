import { ipAddress } from "@vercel/functions";
import { enforceAbusePolicy } from "@/lib/abuse/enforce";
import {
  meterSettledUsage,
  type UsageMeteringProvider,
} from "@/lib/billing/usage-metering";
import { createUsageMeteringProvider } from "@/lib/billing/usage-metering-provider";
import {
  type UsageMeteringRouteDependencies,
  usageMeteringResponse,
} from "@/lib/billing/usage-metering-route";
import { databaseUsageMeteringStore } from "@/lib/db/usage-metering-store";
import {
  cronReconcileSecretFromEnvironment,
  timingSafeSecretEqual,
} from "@/lib/runner/auth";

export const maxDuration = 300;

/**
 * Scheduled reporter of settled run minutes to the Stripe Billing Meter.
 * Same bearer secret and admission policy as Stripe reconciliation; it does
 * not depend on Checkout being enabled, because existing subscribers keep
 * accruing usage while new purchases are paused.
 */
const meteringDependencies: UsageMeteringRouteDependencies<UsageMeteringProvider> =
  {
    authorize(request) {
      const expected = cronReconcileSecretFromEnvironment();
      if (!expected) {
        return "unavailable";
      }
      const credential = bearerCredential(request);
      return credential && timingSafeSecretEqual(credential, expected)
        ? "allowed"
        : "unauthorized";
    },
    createProvider: createUsageMeteringProvider,
    enforceAbuse: enforceAbusePolicy,
    getConfig() {
      const apiKey = process.env.STRIPE_SECRET_KEY?.trim();
      const eventName = process.env.STRIPE_METER_EVENT_NAME?.trim();
      return apiKey && eventName ? { apiKey, eventName } : null;
    },
    meter: async ({ eventName, provider }) =>
      await meterSettledUsage({
        eventName,
        provider,
        store: databaseUsageMeteringStore,
      }),
  };

function bearerCredential(request: Request): string | null {
  const match = /^Bearer ([^\s]+)$/u.exec(
    request.headers.get("authorization") ?? ""
  );
  return match?.[1] ?? null;
}

export function GET(request: Request): Promise<Response> {
  return usageMeteringResponse(
    request,
    meteringDependencies,
    ipAddress(request) ?? null
  );
}
