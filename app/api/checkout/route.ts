import { ipAddress } from "@vercel/functions";
import type Stripe from "stripe";
import { auth } from "@/app/(auth)/auth";
import { enforceAbusePolicy } from "@/lib/abuse/enforce";
import { configuredApplicationBasePath } from "@/lib/application-path";
import { approvedApplicationOrigin } from "@/lib/auth/application-origin";
import {
  type CheckoutSessionSnapshot,
  checkoutSessionSubscriptionId,
  hasBlockingSubscription,
} from "@/lib/billing/checkout";
import {
  type CheckoutDependencies,
  CheckoutProviderRequestError,
  checkoutResponse as checkoutResponseWithDependencies,
} from "@/lib/billing/checkout-response";
import {
  subscriptionCheckoutConfig,
  subscriptionCheckoutEnabled,
} from "@/lib/billing/config";
import { createStripeClient } from "@/lib/billing/stripe-client";
import { classifyStripeRequestOutcome } from "@/lib/billing/stripe-error";
import {
  attachStripeCustomer,
  databaseCheckoutAttemptLeaseStore,
  databaseIdempotencyStore,
  findUserById,
} from "@/lib/db/queries";

const checkoutDependencies: CheckoutDependencies = {
  appBasePath: () => configuredApplicationBasePath(process.env),
  attachCustomer: attachStripeCustomer,
  authenticate: auth,
  checkoutEnabled: () =>
    subscriptionCheckoutEnabled({
      SUBSCRIPTION_CHECKOUT_ENABLED: process.env.SUBSCRIPTION_CHECKOUT_ENABLED,
    }),
  checkoutLeaseStore: databaseCheckoutAttemptLeaseStore,
  createProvider(apiKey) {
    const stripe = createStripeClient(apiKey);
    return {
      async createCheckoutSession(input, options) {
        let session: Stripe.Checkout.Session;
        try {
          session = await stripe.checkout.sessions.create(input, options);
        } catch (error) {
          throw new CheckoutProviderRequestError(
            classifyStripeRequestOutcome(error),
            { cause: error }
          );
        }
        return checkoutSessionSnapshot(session);
      },
      async createCustomer(input, options) {
        let customer: Stripe.Customer;
        try {
          customer = await stripe.customers.create(input, options);
        } catch (error) {
          throw new CheckoutProviderRequestError(
            classifyStripeRequestOutcome(error),
            { cause: error }
          );
        }
        return { id: customer.id };
      },
      async expireCheckoutSession(sessionId, options) {
        await stripe.checkout.sessions.expire(sessionId, {}, options);
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
      async listCheckoutSessions(input) {
        const sessions = await stripe.checkout.sessions.list(input);
        return {
          data: sessions.data.map(checkoutSessionSnapshot),
          hasMore: sessions.has_more,
        };
      },
      async listCustomers(input) {
        const customers = await stripe.customers.list(input);
        return {
          data: customers.data.map(({ id, metadata }) => ({ id, metadata })),
          hasMore: customers.has_more,
        };
      },
      async retrieveCheckoutSession(sessionId) {
        return checkoutSessionSnapshot(
          await stripe.checkout.sessions.retrieve(sessionId)
        );
      },
      async retrieveSubscription(subscriptionId) {
        const subscription =
          await stripe.subscriptions.retrieve(subscriptionId);
        return { id: subscription.id, status: subscription.status };
      },
    };
  },
  enforceAbuse: enforceAbusePolicy,
  findUser: findUserById,
  getCheckoutConfig: () => subscriptionCheckoutConfig(process.env),
  idempotencyStore: databaseIdempotencyStore,
  origin: () => approvedApplicationOrigin(process.env),
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

function checkoutSessionSnapshot(
  session: Stripe.Checkout.Session
): CheckoutSessionSnapshot {
  return {
    clientReferenceId: session.client_reference_id,
    customerId:
      typeof session.customer === "string"
        ? session.customer
        : (session.customer?.id ?? null),
    id: session.id,
    integrationIdentifier: session.integration_identifier,
    metadata: session.metadata ?? {},
    mode: session.mode,
    status: session.status,
    subscriptionId: checkoutSessionSubscriptionId(session.subscription),
    url: session.url,
  };
}
