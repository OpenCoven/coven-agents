import { ipAddress } from "@vercel/functions";
import { auth } from "@/app/(auth)/auth";
import { enforceAbusePolicy } from "@/lib/abuse/enforce";
import { configuredApplicationBasePath } from "@/lib/application-path";
import { approvedApplicationOrigin } from "@/lib/auth/application-origin";
import { authorizeSubscriberAccess } from "@/lib/auth/subscriber-authorization.server";
import {
  type BillingPortalDependencies,
  billingPortalResponse,
} from "@/lib/billing/portal";
import { createStripeClient } from "@/lib/billing/stripe-client";
import { findUserById } from "@/lib/db/queries";

/**
 * The Stripe secret is read directly rather than through the Checkout
 * configuration, because the portal must stay reachable while new purchases
 * are paused.
 */
const dependencies: BillingPortalDependencies = {
  appBasePath: () => configuredApplicationBasePath(process.env),
  authenticate: auth,
  authorize: authorizeSubscriberAccess,
  async createPortalSession(apiKey, params) {
    const session =
      await createStripeClient(apiKey).billingPortal.sessions.create(params);
    return { url: session.url };
  },
  enforceAbuse: enforceAbusePolicy,
  findUser: findUserById,
  getApiKey: () => process.env.STRIPE_SECRET_KEY?.trim() || null,
  origin: () => approvedApplicationOrigin(process.env),
};

export function POST(request: Request): Promise<Response> {
  return billingPortalResponse(
    request,
    dependencies,
    ipAddress(request) ?? null
  );
}
