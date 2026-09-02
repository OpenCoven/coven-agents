import { randomUUID } from "node:crypto";
import { ipAddress } from "@vercel/functions";
import { enforceAbusePolicy } from "@/lib/abuse/enforce";
import {
  reconcileStripeSubscriptions,
  type StripeReconciliationProvider,
} from "@/lib/billing/stripe-reconciliation";
import { createStripeReconciliationProvider } from "@/lib/billing/stripe-reconciliation-provider";
import {
  type StripeReconciliationRouteDependencies,
  stripeReconciliationResponse,
} from "@/lib/billing/stripe-reconciliation-route";
import { databaseStripeReconciliationStore } from "@/lib/db/stripe-reconciliation-store";
import {
  cronReconcileSecretFromEnvironment,
  timingSafeSecretEqual,
} from "@/lib/runner/auth";

export const maxDuration = 300;

const reconciliationDependencies: StripeReconciliationRouteDependencies<StripeReconciliationProvider> =
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
    createProvider: createStripeReconciliationProvider,
    enforceAbuse: enforceAbusePolicy,
    getConfig() {
      const apiKey = process.env.STRIPE_SECRET_KEY?.trim();
      const priceId = process.env.STRIPE_PRICE_ID?.trim();
      return apiKey && validPriceId(priceId) ? { apiKey, priceId } : null;
    },
    reconcile: async ({ priceId, provider }) =>
      await reconcileStripeSubscriptions({
        owner: randomUUID(),
        priceId,
        provider,
        store: databaseStripeReconciliationStore,
      }),
  };

function bearerCredential(request: Request): string | null {
  const match = /^Bearer ([^\s]+)$/u.exec(
    request.headers.get("authorization") ?? ""
  );
  return match?.[1] ?? null;
}

function validPriceId(value: string | undefined): value is string {
  return Boolean(
    value?.startsWith("price_") &&
      value.length > "price_".length &&
      value.length <= 64
  );
}

export function GET(request: Request): Promise<Response> {
  return stripeReconciliationResponse(
    request,
    reconciliationDependencies,
    ipAddress(request) ?? null
  );
}
