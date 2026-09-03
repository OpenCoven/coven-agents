import { ipAddress } from "@vercel/functions";
import { auth } from "@/app/(auth)/auth";
import { enforceAbusePolicy } from "@/lib/abuse/enforce";
import { configuredApplicationBasePath } from "@/lib/application-path";
import { approvedApplicationOrigin } from "@/lib/auth/application-origin";
import { authorizeSubscriberAccess } from "@/lib/auth/subscriber-authorization.server";
import {
  subscriptionCheckoutConfig,
  subscriptionCheckoutEnabled,
} from "@/lib/billing/config";
import {
  type MinutePackCheckoutDependencies,
  minutePackCheckoutResponse,
} from "@/lib/billing/minute-pack-checkout";
import { minutePacksFromEnv } from "@/lib/billing/minute-packs";
import { createStripeClient } from "@/lib/billing/stripe-client";
import { findUserById } from "@/lib/db/queries";

const dependencies: MinutePackCheckoutDependencies = {
  appBasePath: () => configuredApplicationBasePath(process.env),
  authenticate: auth,
  authorize: authorizeSubscriberAccess,
  checkoutEnabled: () =>
    subscriptionCheckoutEnabled({
      SUBSCRIPTION_CHECKOUT_ENABLED: process.env.SUBSCRIPTION_CHECKOUT_ENABLED,
    }),
  async createCheckoutSession(apiKey, params) {
    const session =
      await createStripeClient(apiKey).checkout.sessions.create(params);
    return { url: session.url };
  },
  enforceAbuse: enforceAbusePolicy,
  findUser: findUserById,
  getCheckoutConfig: () => subscriptionCheckoutConfig(process.env),
  minutePacks: () => minutePacksFromEnv(process.env),
  origin: () => approvedApplicationOrigin(process.env),
};

export function POST(request: Request): Promise<Response> {
  return minutePackCheckoutResponse(
    request,
    dependencies,
    ipAddress(request) ?? null
  );
}
