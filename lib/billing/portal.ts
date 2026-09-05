import type Stripe from "stripe";
import {
  abuseAdmissionResponse,
  type enforceAbusePolicy,
} from "@/lib/abuse/enforce";
import { applicationPath } from "@/lib/application-path";
import { parseCanonicalApplicationOrigin } from "@/lib/auth/application-origin";
import {
  type SessionLike,
  type SubscriberAccessDecision,
  subscriberAccessResponse,
} from "@/lib/auth/subscriber-access";

export type BillingPortalDependencies = {
  appBasePath: () => string;
  authenticate: () => Promise<SessionLike>;
  authorize: (session: SessionLike) => Promise<SubscriberAccessDecision>;
  createPortalSession: (
    apiKey: string,
    params: Stripe.BillingPortal.SessionCreateParams
  ) => Promise<{ url: string | null }>;
  enforceAbuse: typeof enforceAbusePolicy;
  findUser: (
    userId: string
  ) => Promise<{ stripeCustomerId: string | null } | null>;
  getApiKey: () => string | null;
  origin: () => string;
};

/**
 * Opens Stripe's hosted billing portal for the signed-in subscriber.
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
  _request: Request,
  dependencies: BillingPortalDependencies,
  sourceIp: string | null
): Promise<Response> {
  const session = await dependencies.authenticate();
  if (!session?.user?.id) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const admission = await dependencies.enforceAbuse({
    ip: sourceIp,
    route: "billing_portal",
    userId: session.user.id,
  });
  if (admission.kind !== "allowed") {
    return abuseAdmissionResponse(admission);
  }

  const access = await dependencies.authorize(session);
  if (access.kind !== "allowed") {
    return subscriberAccessResponse(access);
  }

  const apiKey = dependencies.getApiKey();
  if (!apiKey) {
    return Response.json({ error: "billing_unavailable" }, { status: 503 });
  }

  let owner: { stripeCustomerId: string | null } | null;
  try {
    owner = await dependencies.findUser(access.userId);
  } catch {
    return Response.json({ error: "billing_unavailable" }, { status: 503 });
  }
  if (!owner?.stripeCustomerId) {
    /**
     * A complimentary grant has no Stripe Customer, so there is nothing for
     * the portal to manage. Saying so is better than opening an empty portal
     * or implying the account is billed when it is not.
     */
    return Response.json({ error: "customer_required" }, { status: 409 });
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
  return Response.json(
    { url: portal.url },
    { headers: { "cache-control": "no-store" } }
  );
}
