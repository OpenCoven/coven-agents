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
  isBlockingSubscriptionStatus,
  isValidCheckoutSessionUrl,
  reconcileBlockingCheckoutSessions,
  reconcileCheckoutSessions,
  stableIntegrationIdentifier,
} from "@/lib/billing/checkout";
import { createCheckoutSessionExpirationGuard } from "@/lib/billing/checkout-expiration";
import {
  type CheckoutAttemptLeaseStore,
  type CheckoutAttemptState,
  type CheckoutLeaseTimers,
  isCheckoutAttemptCleanupQueueState,
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
        | "subscriptionId"
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
  retrieveSubscription: (
    subscriptionId: string
  ) => Promise<Pick<Stripe.Subscription, "id" | "status">>;
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
    cacheSuccessfulResponse: false,
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
            checkpoint,
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

            const expiration = createCheckoutSessionExpirationGuard({
              checkpoint,
              expirationIdempotencyKey,
              initialState: attemptState,
              provider,
            });
            const resumeAttemptState = expiration.resumeState;

            if (attemptState.kind === "invalid") {
              return {
                disposition: "preserve_attempt",
                state: attemptState,
                value: checkoutSessionConflict(),
              };
            }

            const inspectCompletedSubscription = async (input: {
              customerId: string;
              sessionId: string;
              subscriptionId: string | null;
            }): Promise<
              | {
                  kind: "failure";
                  result: CheckoutAttemptResult;
                }
              | {
                  kind: "blocking" | "terminal";
                  state: Extract<
                    CheckoutAttemptState,
                    { kind: "session_created" }
                  >;
                }
            > => {
              const state = {
                customerId: input.customerId,
                kind: "session_created",
                sessionId: input.sessionId,
              } as const;
              if (!input.subscriptionId) {
                return {
                  kind: "failure",
                  result: {
                    disposition: "preserve_attempt",
                    state,
                    value: checkoutFailure(),
                  },
                };
              }

              let subscription: Pick<Stripe.Subscription, "id" | "status">;
              try {
                subscription = await provider.retrieveSubscription(
                  input.subscriptionId
                );
              } catch {
                return {
                  kind: "failure",
                  result: {
                    disposition: "preserve_attempt",
                    state,
                    value: checkoutFailure(),
                  },
                };
              }

              if (isBlockingSubscriptionStatus(subscription.status)) {
                return { kind: "blocking", state };
              }
              if (
                subscription.status === "canceled" ||
                subscription.status === "incomplete_expired"
              ) {
                return { kind: "terminal", state };
              }
              return {
                kind: "failure",
                result: {
                  disposition: "preserve_attempt",
                  state,
                  value: checkoutFailure(),
                },
              };
            };

            const blockingSubscriptionResult = async (
              candidateCustomerId: string,
              retainedState: CheckoutAttemptState | null = null,
              knownSessionIds: readonly string[] = []
            ): Promise<CheckoutAttemptResult> => {
              let stateToRetain = retainedState;
              let blockingState: Extract<
                CheckoutAttemptState,
                { kind: "session_created" }
              > | null = null;
              let completedSessions: Awaited<
                ReturnType<typeof reconcileBlockingCheckoutSessions>
              >;
              try {
                completedSessions = await reconcileBlockingCheckoutSessions({
                  cleanupSessions: expiration.cleanupSessions,
                  customerId: candidateCustomerId,
                  knownSessionIds,
                  listPage: provider.listCheckoutSessions,
                  userId: decision.userId,
                });
              } catch (error) {
                if (error instanceof CheckoutSessionCleanupError) {
                  return {
                    disposition: "preserve_attempt",
                    state: expiration.currentAttemptState(),
                    value: checkoutSessionConflict(),
                  };
                }
                throw error;
              }

              const inspections = await Promise.all(
                completedSessions.map((completedSession) =>
                  inspectCompletedSubscription({
                    ...completedSession,
                    customerId: candidateCustomerId,
                  })
                )
              );
              for (const inspection of inspections) {
                if (inspection.kind === "failure") {
                  const currentState = expiration.currentAttemptState();
                  if (isCheckoutAttemptCleanupQueueState(currentState)) {
                    return {
                      disposition: "preserve_attempt",
                      state: currentState,
                      value: inspection.result.value,
                    };
                  }
                  return inspection.result;
                }
                if (inspection.kind === "blocking") {
                  blockingState ??= inspection.state;
                }
                stateToRetain ??= inspection.state;
              }

              const finalState = blockingState ?? stateToRetain;
              return finalState
                ? {
                    disposition: "preserve_attempt",
                    state: finalState,
                    value: alreadySubscribed(),
                  }
                : {
                    disposition: "retire_attempt",
                    value: alreadySubscribed(),
                  };
            };

            const completedSessionsResult = async (input: {
              candidateCustomerId: string;
              sessions: Array<{
                sessionId: string;
                subscriptionId: string | null;
              }>;
            }): Promise<CheckoutAttemptResult> => {
              let retainedState: Extract<
                CheckoutAttemptState,
                { kind: "session_created" }
              > | null = null;
              let blockingState: Extract<
                CheckoutAttemptState,
                { kind: "session_created" }
              > | null = null;
              let foundBlocking = false;
              for (const completedSession of input.sessions) {
                const inspection =
                  // biome-ignore lint/performance/noAwaitInLoops: every durably completed Session must be reconciled before the queue outcome is released.
                  await inspectCompletedSubscription({
                    ...completedSession,
                    customerId: input.candidateCustomerId,
                  });
                if (inspection.kind === "failure") {
                  const currentState = expiration.currentAttemptState();
                  if (isCheckoutAttemptCleanupQueueState(currentState)) {
                    return {
                      disposition: "preserve_attempt",
                      state: currentState,
                      value: inspection.result.value,
                    };
                  }
                  return inspection.result;
                }
                retainedState ??= inspection.state;
                if (inspection.kind === "blocking") {
                  blockingState ??= inspection.state;
                  foundBlocking = true;
                }
              }
              const state = blockingState ??
                retainedState ?? { kind: "create_uncertain" };
              if (
                foundBlocking ||
                (await provider.hasBlockingSubscription(
                  input.candidateCustomerId
                ))
              ) {
                if (
                  isCheckoutAttemptCleanupQueueState(
                    expiration.currentAttemptState()
                  )
                ) {
                  await expiration.checkpoint(state);
                }
                return blockingSubscriptionResult(
                  input.candidateCustomerId,
                  state
                );
              }
              return {
                disposition: "retire_attempt",
                value: requestInProgress(),
              };
            };

            const completedSessionResult = (input: {
              candidateCustomerId: string;
              sessionId: string;
              subscriptionId: string | null;
            }) =>
              completedSessionsResult({
                candidateCustomerId: input.candidateCustomerId,
                sessions: [input],
              });

            if (isCheckoutAttemptCleanupQueueState(attemptState)) {
              let recoveredCleanup: Awaited<
                ReturnType<typeof expiration.drainPendingQueue>
              >;
              try {
                recoveredCleanup = await expiration.drainPendingQueue({
                  userId: decision.userId,
                });
              } catch (error) {
                if (error instanceof CheckoutSessionCleanupError) {
                  return {
                    disposition: "preserve_attempt",
                    state: expiration.currentAttemptState(),
                    value: checkoutSessionConflict(),
                  };
                }
                throw error;
              }
              const recoveredCompleted = recoveredCleanup.filter(
                ({ status }) => status === "complete"
              );
              if (recoveredCompleted.length > 0) {
                return completedSessionsResult({
                  candidateCustomerId: attemptState.customerId,
                  sessions: recoveredCompleted,
                });
              }
            }

            const inspectCustomer = async (
              candidateCustomerId: string
            ): Promise<CheckoutAttemptResult | null> => {
              let reconciliation: Awaited<
                ReturnType<typeof reconcileCheckoutSessions>
              >;
              try {
                reconciliation = await reconcileCheckoutSessions({
                  attemptId,
                  attemptState: resumeAttemptState,
                  cleanupSessions: expiration.cleanupSessions,
                  customerId: candidateCustomerId,
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
                    state: expiration.currentAttemptState(),
                    value: {
                      body: { error: "checkout_session_conflict" },
                      status: 409,
                    },
                  } as const;
                }
                throw error;
              }
              if (reconciliation.kind === "complete") {
                return completedSessionsResult({
                  candidateCustomerId,
                  sessions: reconciliation.completedSessions ?? [
                    {
                      sessionId: reconciliation.sessionId,
                      subscriptionId: reconciliation.subscriptionId,
                    },
                  ],
                });
              }
              if (await provider.hasBlockingSubscription(candidateCustomerId)) {
                const knownSessionIds =
                  reconciliation.kind === "reused" ||
                  reconciliation.kind === "invalid_url"
                    ? [reconciliation.sessionId]
                    : resumeAttemptState.kind === "session_created"
                      ? [resumeAttemptState.sessionId]
                      : [];
                return blockingSubscriptionResult(
                  candidateCustomerId,
                  resumeAttemptState.kind === "create_uncertain"
                    ? resumeAttemptState
                    : null,
                  knownSessionIds
                );
              }
              if (reconciliation.kind === "retry_required") {
                return {
                  disposition: "preserve_attempt",
                  state: expiration.currentAttemptState(),
                  value: requestInProgress(),
                } as const;
              }
              if (reconciliation.kind === "reused") {
                return {
                  disposition: "preserve_attempt",
                  state: {
                    customerId: candidateCustomerId,
                    kind: "session_created",
                    sessionId: reconciliation.sessionId,
                  },
                  value: {
                    body: { url: reconciliation.url },
                    status: 200,
                  },
                } as const;
              }
              if (reconciliation.kind === "invalid_url") {
                return {
                  disposition: "preserve_attempt",
                  state: {
                    customerId: candidateCustomerId,
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
            let customerId =
              row?.stripeCustomerId ??
              (resumeAttemptState.kind === "customer_created"
                ? resumeAttemptState.customerId
                : null);

            if (!customerId) {
              try {
                customerId = (
                  await provider.createCustomer(
                    {
                      metadata: {
                        [CHECKOUT_ATTEMPT_METADATA_KEY]: attemptId,
                        checkoutFlowVersion: CHECKOUT_FLOW_VERSION,
                        userId: decision.userId,
                      },
                    },
                    { idempotencyKey: customerIdempotencyKey }
                  )
                ).id;
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
              await expiration.checkpoint({
                customerId,
                kind: "customer_created",
              });
            }

            if (!row?.stripeCustomerId) {
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
              await expiration.checkpoint({ kind: "create_uncertain" });
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

            const createdState = createdAttemptState(customerId, checkout.id);
            if (checkout.status === "expired") {
              return {
                disposition: "retire_attempt",
                value: requestInProgress(),
              };
            }
            if (checkout.status === "complete") {
              if (!checkout.id) {
                return {
                  disposition: "preserve_attempt",
                  state: createdState,
                  value: checkoutFailure(),
                };
              }
              return completedSessionResult({
                candidateCustomerId: customerId,
                sessionId: checkout.id,
                subscriptionId: checkout.subscriptionId ?? null,
              });
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

function alreadySubscribed() {
  return { body: { error: "already_subscribed" }, status: 409 } as const;
}

function checkoutSessionConflict() {
  return {
    body: { error: "checkout_session_conflict" },
    status: 409,
  } as const;
}

function createdAttemptState(
  customerId: string,
  sessionId: string | undefined
): CheckoutAttemptState {
  return sessionId
    ? { customerId, kind: "session_created", sessionId }
    : { kind: "fresh" };
}

function isPreRequestProviderFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "requestOutcome" in error &&
    error.requestOutcome === "pre_request"
  );
}
