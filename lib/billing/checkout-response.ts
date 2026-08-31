import type Stripe from "stripe";
import {
  abuseAdmissionResponse,
  type enforceAbusePolicy,
} from "@/lib/abuse/enforce";
import {
  type IdempotencyResponse,
  type IdempotencyStore,
  type IdempotencyTimers,
  idempotencyResultResponse,
  runIdempotentOperation,
} from "@/lib/abuse/idempotency";
import { plaintextIdempotencyResponseStorage } from "@/lib/abuse/idempotency-response";
import type { SessionLike } from "@/lib/auth/subscriber-access";
import {
  CHECKOUT_ATTEMPT_METADATA_KEY,
  CHECKOUT_FLOW_VERSION,
  CheckoutSessionCleanupError,
  type CheckoutSessionPage,
  type CheckoutSessionSnapshot,
  checkoutDecision,
  isValidCheckoutSessionUrl,
  reconcileCheckoutSessions,
  stableIntegrationIdentifier,
} from "@/lib/billing/checkout";
import {
  type CheckoutAttemptLeaseStore,
  type CheckoutAttemptState,
  type CheckoutLeaseTimers,
  runWithCheckoutAttemptLease,
} from "@/lib/billing/checkout-lease";
import type { SubscriptionCheckoutConfig } from "@/lib/billing/config";

const CHECKOUT_RESULT_RETENTION_MS = 24 * 60 * 60_000;

type ProviderRequestOptions = {
  idempotencyKey: string;
};

type CheckoutAttemptResult =
  | {
      disposition: "preserve_attempt";
      state: CheckoutAttemptState;
      value: IdempotencyResponse;
    }
  | {
      disposition: "retire_attempt";
      value: IdempotencyResponse;
    };

export class CheckoutProviderRequestError extends Error {
  readonly requestOutcome: "pre_request" | "uncertain";

  constructor(
    requestOutcome: "pre_request" | "uncertain",
    options?: ErrorOptions
  ) {
    super("Checkout provider request failed.", options);
    this.name = "CheckoutProviderRequestError";
    this.requestOutcome = requestOutcome;
  }
}

export type CheckoutProvider = {
  createCheckoutSession: (
    input: Stripe.Checkout.SessionCreateParams,
    options: ProviderRequestOptions
  ) => Promise<
    Partial<
      Pick<
        CheckoutSessionSnapshot,
        | "clientReferenceId"
        | "customerId"
        | "id"
        | "integrationIdentifier"
        | "metadata"
        | "mode"
        | "status"
      >
    > & { url: string | null }
  >;
  createCustomer: (
    input: Stripe.CustomerCreateParams,
    options: ProviderRequestOptions
  ) => Promise<{ id: string }>;
  expireCheckoutSession: (
    sessionId: string,
    options: ProviderRequestOptions
  ) => Promise<void>;
  hasBlockingSubscription: (customerId: string) => Promise<boolean>;
  listCheckoutSessions: (
    input: Stripe.Checkout.SessionListParams
  ) => Promise<CheckoutSessionPage>;
  retrieveCheckoutSession: (
    sessionId: string
  ) => Promise<CheckoutSessionSnapshot>;
};

export type CheckoutDependencies = {
  attachCustomer: (userId: string, customerId: string) => Promise<string>;
  authenticate: () => Promise<SessionLike>;
  checkoutLeaseStore: CheckoutAttemptLeaseStore;
  checkoutLeaseTimers?: CheckoutLeaseTimers;
  checkoutEnabled: () => boolean;
  createProvider: (apiKey: string) => CheckoutProvider;
  enforceAbuse: typeof enforceAbusePolicy;
  findUser: (
    userId: string
  ) => Promise<{ stripeCustomerId: string | null } | null>;
  getCheckoutConfig: () => SubscriptionCheckoutConfig;
  idempotencyStore: IdempotencyStore;
  idempotencyTimers?: IdempotencyTimers;
  now?: () => Date;
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
    claimLease: { timers: dependencies.idempotencyTimers },
    idempotencyKey: request.headers.get("idempotency-key"),
    now: dependencies.now,
    operation: "checkout",
    ownerId: userId,
    perform: async (): Promise<IdempotencyResponse> => {
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
        const attempt = await runWithCheckoutAttemptLease<IdempotencyResponse>({
          now: dependencies.now,
          ownerId: userId,
          perform: async ({
            attemptId,
            attemptState,
            expirationIdempotencyKey,
            providerIdempotencyKey,
          }): Promise<CheckoutAttemptResult> => {
            const row = await dependencies.findUser(userId);
            const provider = dependencies.createProvider(enabledConfig.apiKey);
            const decision = checkoutDecision({
              hasBlockingSubscription: false,
              userId,
            });
            if (decision.kind !== "allowed") {
              return {
                disposition: "retire_attempt",
                value:
                  decision.kind === "unauthorized"
                    ? { body: { error: "unauthorized" }, status: 401 }
                    : {
                        body: { error: "already_subscribed" },
                        status: 409,
                      },
              };
            }

            const inspectCustomer = async (
              candidateCustomerId: string
            ): Promise<CheckoutAttemptResult | null> => {
              if (await provider.hasBlockingSubscription(candidateCustomerId)) {
                return {
                  disposition: "retire_attempt",
                  value: {
                    body: { error: "already_subscribed" },
                    status: 409,
                  },
                } as const;
              }

              let reconciliation: Awaited<
                ReturnType<typeof reconcileCheckoutSessions>
              >;
              try {
                reconciliation = await reconcileCheckoutSessions({
                  attemptId,
                  attemptState,
                  customerId: candidateCustomerId,
                  expirationIdempotencyKey,
                  expire: provider.expireCheckoutSession,
                  listPage: provider.listCheckoutSessions,
                  priceId: enabledConfig.priceId,
                  providerIdempotencyKey,
                  retrieve: provider.retrieveCheckoutSession,
                  userId: decision.userId,
                });
              } catch (error) {
                if (error instanceof CheckoutSessionCleanupError) {
                  return {
                    disposition: "preserve_attempt",
                    state: attemptState,
                    value: {
                      body: { error: "checkout_session_conflict" },
                      status: 409,
                    },
                  } as const;
                }
                throw error;
              }
              if (reconciliation.kind === "reused") {
                return {
                  disposition: "preserve_attempt",
                  state: {
                    kind: "session_created",
                    sessionId: reconciliation.sessionId,
                  },
                  value: {
                    body: { url: reconciliation.url },
                    status: 200,
                  },
                } as const;
              }
              if (reconciliation.kind === "complete") {
                return {
                  disposition: "preserve_attempt",
                  state: {
                    kind: "session_created",
                    sessionId: reconciliation.sessionId,
                  },
                  value: requestInProgress(),
                } as const;
              }
              if (reconciliation.kind === "invalid_url") {
                return {
                  disposition: "preserve_attempt",
                  state: {
                    kind: "session_created",
                    sessionId: reconciliation.sessionId,
                  },
                  value: checkoutFailure(),
                } as const;
              }
              if (reconciliation.kind === "retire_attempt") {
                return {
                  disposition: "retire_attempt",
                  value: requestInProgress(),
                } as const;
              }
              if (reconciliation.kind === "retry_required") {
                return {
                  disposition: "preserve_attempt",
                  state: attemptState,
                  value: {
                    body: { error: "request_in_progress" },
                    status: 409,
                  },
                } as const;
              }
              return null;
            };

            const inspectedCustomerId = row?.stripeCustomerId ?? null;
            if (inspectedCustomerId) {
              const existingCustomer =
                await inspectCustomer(inspectedCustomerId);
              if (existingCustomer) {
                return existingCustomer;
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

            if (customerId !== inspectedCustomerId) {
              const attachedCustomer = await inspectCustomer(customerId);
              if (attachedCustomer) {
                return attachedCustomer;
              }
            }

            const origin = dependencies.origin();
            let checkout: Awaited<
              ReturnType<CheckoutProvider["createCheckoutSession"]>
            >;
            try {
              checkout = await provider.createCheckoutSession(
                {
                  cancel_url: `${origin}/account?checkout=cancelled`,
                  client_reference_id: decision.userId,
                  customer: customerId,
                  integration_identifier: stableIntegrationIdentifier(
                    providerIdempotencyKey
                  ),
                  line_items: [{ price: enabledConfig.priceId, quantity: 1 }],
                  metadata: {
                    [CHECKOUT_ATTEMPT_METADATA_KEY]: attemptId,
                    checkoutFlowVersion: CHECKOUT_FLOW_VERSION,
                    priceId: enabledConfig.priceId,
                    userId: decision.userId,
                  },
                  mode: "subscription",
                  subscription_data: { metadata: { userId: decision.userId } },
                  success_url: `${origin}/account?checkout=success`,
                },
                { idempotencyKey: sessionIdempotencyKey }
              );
            } catch (error) {
              return isPreRequestProviderFailure(error)
                ? {
                    disposition: "retire_attempt",
                    value: checkoutFailure(),
                  }
                : {
                    disposition: "preserve_attempt",
                    state: { kind: "create_uncertain" },
                    value: checkoutFailure(),
                  };
            }

            const createdState = createdAttemptState(checkout.id);
            if (checkout.status === "expired") {
              return {
                disposition: "retire_attempt",
                value: requestInProgress(),
              };
            }
            if (checkout.status === "complete") {
              return {
                disposition: "preserve_attempt",
                state: createdState,
                value: requestInProgress(),
              };
            }
            if (!isValidCheckoutSessionUrl(checkout.url)) {
              return {
                disposition: "preserve_attempt",
                state: createdState,
                value: checkoutFailure(),
              } as const;
            }

            return {
              disposition: "preserve_attempt",
              state: createdState,
              value: { body: { url: checkout.url }, status: 200 },
            } as const;
          },
          store: dependencies.checkoutLeaseStore,
          timers: dependencies.checkoutLeaseTimers,
        });
        if (attempt.kind === "in_progress" || attempt.kind === "lease_lost") {
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

function requestInProgress() {
  return { body: { error: "request_in_progress" }, status: 409 } as const;
}

function createdAttemptState(
  sessionId: string | undefined
): CheckoutAttemptState {
  return sessionId ? { kind: "session_created", sessionId } : { kind: "fresh" };
}

function isPreRequestProviderFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "requestOutcome" in error &&
    error.requestOutcome === "pre_request"
  );
}
