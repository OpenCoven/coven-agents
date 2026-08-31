import { ipAddress } from "@vercel/functions";
import { auth } from "@/app/(auth)/auth";
import { enforceAbusePolicy } from "@/lib/abuse/enforce";
import {
  type CheckoutDependencies,
  checkoutResponse as checkoutResponseWithDependencies,
} from "@/lib/billing/checkout-response";
import {
  subscriptionCheckoutConfig,
  subscriptionCheckoutEnabled,
} from "@/lib/billing/config";
import { createStripeClient } from "@/lib/billing/stripe-client";
import {
  attachStripeCustomer,
  databaseIdempotencyStore,
  findUserById,
} from "@/lib/db/queries";

const checkoutDependencies: CheckoutDependencies = {
  attachCustomer: attachStripeCustomer,
  authenticate: auth,
  checkoutEnabled: () =>
    subscriptionCheckoutEnabled({
      SUBSCRIPTION_CHECKOUT_ENABLED: process.env.SUBSCRIPTION_CHECKOUT_ENABLED,
    }),
  createProvider(apiKey) {
    const stripe = createStripeClient(apiKey);
    return {
      async createCheckoutSession(input, options) {
        const session = await stripe.checkout.sessions.create(input, options);
        return { url: session.url };
      },
      async createCustomer(input, options) {
        const customer = await stripe.customers.create(input, options);
        return { id: customer.id };
      },
      async listSubscriptions(input) {
        const subscriptions = await stripe.subscriptions.list(input);
        return {
          data: subscriptions.data.map(({ status }) => ({ status })),
        };
      },
    };
  },
  enforceAbuse: enforceAbusePolicy,
  findUser: findUserById,
  getCheckoutConfig: () => subscriptionCheckoutConfig(process.env),
  idempotencyStore: databaseIdempotencyStore,
  origin: () => process.env.APP_ORIGIN ?? "",
};

export function checkoutResponse(
  request: Request,
  dependencies: CheckoutDependencies = checkoutDependencies
) {
  return checkoutResponseWithDependencies(
    request,
    dependencies,
    ipAddress(request) ?? null
  );
}

export function POST(request: Request) {
  return checkoutResponse(request);
}
