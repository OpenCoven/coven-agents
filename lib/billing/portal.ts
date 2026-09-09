import type Stripe from "stripe";
import {
  abuseAdmissionResponse,
  type enforceAbusePolicy,
} from "@/lib/abuse/enforce";
import { applicationPath } from "@/lib/application-path";
import { parseCanonicalApplicationOrigin } from "@/lib/auth/application-origin";
import {
  authVersionMatches,
  validAuthVersion,
} from "@/lib/auth/session-revocation";
import type { VerifiedJwtIdentity } from "@/lib/auth/verified-jwt";
import { isCanonicalUuid } from "@/lib/session";

export type BillingPortalDependencies = {
  appBasePath: () => string;
  authenticate: (request: Request) => Promise<VerifiedJwtIdentity | null>;
  createPortalSession: (
    apiKey: string,
    params: Stripe.BillingPortal.SessionCreateParams
  ) => Promise<{ url: string | null }>;
  enforceAbuse: typeof enforceAbusePolicy;
  findUser: (
    userId: string
  ) => Promise<{ authVersion: number; stripeCustomerId: string | null } | null>;
  getApiKey: () => string | null;
  origin: () => string;
};

/**
 * Opens Stripe's hosted billing portal for a current authenticated account.
 *
 * Deliberately not gated on `SUBSCRIPTION_CHECKOUT_ENABLED`. That flag pauses
 * new purchases; someone who already pays must still be able to cancel or
 * replace a card while it is off. A product that can be joined and not left
 * is the asymmetry this endpoint exists to remove.
 *
 * Stripe owns the portal: cancellation, payment method, and invoice history
 * all happen there, so this app never handles a card and never has to
 * reimplement those flows. Entitlement still changes only through the
 * signature-verified webhook, so a cancellation taken in the portal reaches
 * this database the same way a purchase does.
 */
export async function billingPortalResponse(
  request: Request,
  dependencies: BillingPortalDependencies,
  sourceIp: string | null
): Promise<Response> {
  const identity = await dependencies.authenticate(request);
  if (
    !identity ||
    !isCanonicalUuid(identity.userId) ||
    !validAuthVersion(identity.authVersion)
  ) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const admission = await dependencies.enforceAbuse({
    ip: sourceIp,
    route: "billing_portal",
    userId: identity.userId,
  });
  if (admission.kind !== "allowed") {
    return abuseAdmissionResponse(admission);
  }

  let owner: { authVersion: number; stripeCustomerId: string | null } | null;
  try {
    owner = await dependencies.findUser(identity.userId);
  } catch {
    return Response.json({ error: "billing_unavailable" }, { status: 503 });
  }
  if (!owner || !authVersionMatches(owner.authVersion, identity.authVersion)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!owner.stripeCustomerId) {
    /**
     * A complimentary grant has no Stripe Customer, so there is nothing for
     * the portal to manage. Saying so is better than opening an empty portal
     * or implying the account is billed when it is not.
     */
    return Response.json({ error: "customer_required" }, { status: 409 });
  }

  const apiKey = dependencies.getApiKey();
  if (!apiKey) {
    return Response.json({ error: "billing_unavailable" }, { status: 503 });
  }

  let origin: string;
  try {
    origin = parseCanonicalApplicationOrigin(
      "Billing portal origin",
      dependencies.origin(),
      { allowTrailingSlash: true }
    );
  } catch {
    return Response.json({ error: "billing_unavailable" }, { status: 503 });
  }

  let portal: { url: string | null };
  try {
    portal = await dependencies.createPortalSession(apiKey, {
      customer: owner.stripeCustomerId,
      return_url: new URL(
        applicationPath("/account?billing=managed", dependencies.appBasePath()),
        `${origin}/`
      ).href,
    });
  } catch {
    // Includes the case where no portal configuration exists in Stripe yet.
    // The operator sees that in Stripe; the subscriber sees a retryable state
    // rather than a provider error.
    return Response.json({ error: "billing_unavailable" }, { status: 503 });
  }
  if (!portal.url) {
    return Response.json({ error: "billing_unavailable" }, { status: 503 });
  }
  let currentOwner: Awaited<ReturnType<BillingPortalDependencies["findUser"]>>;
  try {
    currentOwner = await dependencies.findUser(identity.userId);
  } catch {
    return Response.json({ error: "billing_unavailable" }, { status: 503 });
  }
  if (
    !currentOwner ||
    !authVersionMatches(currentOwner.authVersion, identity.authVersion) ||
    currentOwner.stripeCustomerId !== owner.stripeCustomerId
  ) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return Response.json(
    { url: portal.url },
    { headers: { "cache-control": "no-store" } }
  );
}
