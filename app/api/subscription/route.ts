import { ipAddress } from "@vercel/functions";
import { enforceAbusePolicy } from "@/lib/abuse/enforce";
import { verifiedJwtIdentity } from "@/lib/auth/verified-jwt";
import { subscriptionCheckoutEnabled } from "@/lib/billing/config";
import { minutePacksFromEnv } from "@/lib/billing/minute-packs";
import {
  type SubscriptionStatusDependencies,
  subscriptionResponse as subscriptionResponseWithDependencies,
} from "@/lib/billing/subscription-status";
import { findUserById } from "@/lib/db/queries";

const subscriptionStatusDependencies: SubscriptionStatusDependencies = {
  authenticate: verifiedJwtIdentity,
  checkoutEnabled: () =>
    subscriptionCheckoutEnabled(
      process.env as unknown as Pick<
        NodeJS.ProcessEnv,
        "SUBSCRIPTION_CHECKOUT_ENABLED"
      >
    ),
  enforceAbuse: enforceAbusePolicy,
  findUser: findUserById,
  minutePacks: () => minutePacksFromEnv(process.env),
  now: () => new Date(),
};

export function subscriptionResponse(
  request: Request,
  dependencies: SubscriptionStatusDependencies = subscriptionStatusDependencies
): Promise<Response> {
  return subscriptionResponseWithDependencies(
    request,
    dependencies,
    ipAddress(request) ?? null
  );
}

export function GET(request: Request) {
  return subscriptionResponse(request);
}
