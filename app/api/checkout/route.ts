import { ipAddress } from "@vercel/functions";
import { auth } from "@/app/(auth)/auth";
import { enforceAbusePolicy } from "@/lib/abuse/enforce";
import { hasBlockingSubscription } from "@/lib/billing/checkout";
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
      async findOpenCheckoutSession(customerId, userId) {
        for await (const session of stripe.checkout.sessions.list({
          customer: customerId,
          limit: 100,
          status: "open",
        })) {
          if (
            session.client_reference_id === userId &&
            session.metadata?.userId === userId &&
            session.mode === "subscription"
          ) {
            return { url: session.url };
          }
        }
        return null;
      },
      hasBlockingSubscription(customerId) {
        return hasBlockingSubscription(customerId, async (input) => {
          const subscriptions = await stripe.subscriptions.list(input);
          return {
            data: subscriptions.data.map(({ id, status }) => ({ id, status })),
            hasMore: subscriptions.has_more,
          };
        });
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
