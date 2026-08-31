import type Stripe from "stripe";
import {
  abuseAdmissionResponse,
  type enforceAbusePolicy,
} from "@/lib/abuse/enforce";
import {
  type IdempotencyResponse,
  type IdempotencyStore,
  idempotencyResultResponse,
  runIdempotentOperation,
  runWithIdempotencyLease,
} from "@/lib/abuse/idempotency";
import { plaintextIdempotencyResponseStorage } from "@/lib/abuse/idempotency-response";
import type { SessionLike } from "@/lib/auth/subscriber-access";
import {
  checkoutDecision,
  stableIntegrationIdentifier,
} from "@/lib/billing/checkout";
import type { SubscriptionCheckoutConfig } from "@/lib/billing/config";

const CHECKOUT_RESULT_RETENTION_MS = 24 * 60 * 60_000;
const CHECKOUT_ATTEMPT_LEASE_KEY = "checkout-attempt-lease";
const CHECKOUT_ATTEMPT_OPERATION = "checkout-attempt";

type ProviderRequestOptions = {
  idempotencyKey: string;
};

export type CheckoutProvider = {
  createCheckoutSession: (
    input: Stripe.Checkout.SessionCreateParams,
    options: ProviderRequestOptions
  ) => Promise<{ url: string | null }>;
  createCustomer: (
    input: Stripe.CustomerCreateParams,
    options: ProviderRequestOptions
  ) => Promise<{ id: string }>;
  findOpenCheckoutSession: (
    customerId: string,
    userId: string
  ) => Promise<{ url: string | null } | null>;
  hasBlockingSubscription: (customerId: string) => Promise<boolean>;
};

export type CheckoutDependencies = {
  attachCustomer: (userId: string, customerId: string) => Promise<string>;
  authenticate: () => Promise<SessionLike>;
  checkoutEnabled: () => boolean;
  createProvider: (apiKey: string) => CheckoutProvider;
  enforceAbuse: typeof enforceAbusePolicy;
  findUser: (
    userId: string
  ) => Promise<{ stripeCustomerId: string | null } | null>;
  getCheckoutConfig: () => SubscriptionCheckoutConfig;
  idempotencyStore: IdempotencyStore;
  origin: () => string;
};

export async function checkoutResponse(
  request: Request,
  dependencies: CheckoutDependencies,
  sourceIp: string | null
): Promise<Response> {
  const session = await dependencies.authenticate();
  const userId = session?.user?.id ?? null;

  if (!userId) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!dependencies.checkoutEnabled()) {
    return Response.json(
      { error: "subscriptions_unavailable" },
      { status: 404 }
    );
  }

  const admission = await dependencies.enforceAbuse({
    ip: sourceIp,
    route: "checkout",
    userId,
  });
  if (admission.kind !== "allowed") {
    return abuseAdmissionResponse(admission);
  }

  const result = await runIdempotentOperation({
    idempotencyKey: request.headers.get("idempotency-key"),
    operation: "checkout",
    ownerId: userId,
    perform: async ({
      providerIdempotencyKey,
    }): Promise<IdempotencyResponse> => {
      let config: SubscriptionCheckoutConfig;
      try {
        config = dependencies.getCheckoutConfig();
      } catch {
        return { body: { error: "billing_unavailable" }, status: 503 };
      }

      if (!config.enabled) {
        return {
          body: { error: "subscriptions_unavailable" },
          status: 404,
        };
      }
      const enabledConfig = config;

      try {
        const attempt = await runWithIdempotencyLease({
          idempotencyKey: CHECKOUT_ATTEMPT_LEASE_KEY,
          operation: CHECKOUT_ATTEMPT_OPERATION,
          ownerId: userId,
          perform: async (): Promise<IdempotencyResponse> => {
            const row = await dependencies.findUser(userId);
            const provider = dependencies.createProvider(enabledConfig.apiKey);
            const hasBlockingSubscription = row?.stripeCustomerId
              ? await provider.hasBlockingSubscription(row.stripeCustomerId)
              : false;

            const decision = checkoutDecision({
              hasBlockingSubscription,
              userId,
            });
            if (decision.kind === "already_subscribed") {
              return {
                body: { error: "already_subscribed" },
                status: 409,
              };
            }
            if (decision.kind === "unauthorized") {
              return { body: { error: "unauthorized" }, status: 401 };
            }

            if (row?.stripeCustomerId) {
              const openCheckout = await provider.findOpenCheckoutSession(
                row.stripeCustomerId,
                decision.userId
              );
              if (openCheckout) {
                return openCheckout.url
                  ? { body: { url: openCheckout.url }, status: 200 }
                  : checkoutFailure();
              }
            }

            const customerIdempotencyKey = `${providerIdempotencyKey}:customer`;
            const sessionIdempotencyKey = `${providerIdempotencyKey}:session`;
            let customerId = row?.stripeCustomerId ?? null;

            if (!customerId) {
              customerId = (
                await provider.createCustomer(
                  { metadata: { userId: decision.userId } },
                  { idempotencyKey: customerIdempotencyKey }
                )
              ).id;
              customerId = await dependencies.attachCustomer(
                decision.userId,
                customerId
              );
            }

            const origin = dependencies.origin();
            const checkout = await provider.createCheckoutSession(
              {
                cancel_url: `${origin}/account?checkout=cancelled`,
                client_reference_id: decision.userId,
                customer: customerId,
                integration_identifier: stableIntegrationIdentifier(
                  providerIdempotencyKey
                ),
                line_items: [{ price: enabledConfig.priceId, quantity: 1 }],
                metadata: { userId: decision.userId },
                mode: "subscription",
                subscription_data: { metadata: { userId: decision.userId } },
                success_url: `${origin}/account?checkout=success`,
              },
              { idempotencyKey: sessionIdempotencyKey }
            );

            if (!checkout.url) {
              return checkoutFailure();
            }

            return { body: { url: checkout.url }, status: 200 };
          },
          store: dependencies.idempotencyStore,
        });
        if (attempt.kind === "in_progress") {
          return {
            body: { error: "request_in_progress" },
            status: 409,
          };
        }
        return attempt.value;
      } catch {
        return checkoutFailure();
      }
    },
    request: {},
    responseStorage: plaintextIdempotencyResponseStorage,
    retentionMs: CHECKOUT_RESULT_RETENTION_MS,
    store: dependencies.idempotencyStore,
  });

  return idempotencyResultResponse(result);
}

function checkoutFailure() {
  return { body: { error: "checkout_failed" }, status: 502 } as const;
}
