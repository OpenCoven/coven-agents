import {
  CheckoutSessionCleanupError,
  type CheckoutSessionExpiration,
  type CheckoutSessionSnapshot,
  isAppOwnedCheckoutSession,
} from "./checkout";
import {
  type CheckoutAttemptState,
  checkoutAttemptResumeState,
} from "./checkout-lease";

export function createCheckoutSessionExpirationGuard(options: {
  checkpoint: (state: CheckoutAttemptState) => Promise<void>;
  expirationIdempotencyKey: (sessionId: string) => string;
  initialState: CheckoutAttemptState;
  provider: {
    expireCheckoutSession: (
      sessionId: string,
      options: { idempotencyKey: string }
    ) => Promise<void>;
    retrieveCheckoutSession: (
      sessionId: string
    ) => Promise<CheckoutSessionSnapshot>;
  };
}): {
  checkpoint: (state: CheckoutAttemptState) => Promise<void>;
  currentAttemptState: () => CheckoutAttemptState;
  expireSession: CheckoutSessionExpiration;
  resumeState: ReturnType<typeof checkoutAttemptResumeState>;
} {
  let durableAttemptState = options.initialState;

  const checkpointAttemptState = async (state: CheckoutAttemptState) => {
    await options.checkpoint(state);
    durableAttemptState = state;
  };

  const expireSession: CheckoutSessionExpiration = async (input) => {
    const pendingExpiration =
      durableAttemptState.kind === "expiration_in_flight"
        ? durableAttemptState
        : null;
    if (
      pendingExpiration &&
      !matchesExpirationAttempt(pendingExpiration, input)
    ) {
      throw new CheckoutSessionCleanupError(
        "A pending Checkout Session expiration must be reconciled first."
      );
    }

    let session: CheckoutSessionSnapshot;
    try {
      session = await options.provider.retrieveCheckoutSession(input.sessionId);
    } catch (error) {
      throw new CheckoutSessionCleanupError(
        "A Checkout Session could not be retrieved before expiration.",
        { cause: error }
      );
    }
    if (!isAppOwnedCheckoutSession(session, input)) {
      throw new CheckoutSessionCleanupError(
        "A Checkout Session is not safely app-owned."
      );
    }

    const confirmedExpiration =
      durableAttemptState.kind === "expiration_confirmed" &&
      matchesExpirationAttempt(durableAttemptState, input)
        ? durableAttemptState
        : null;
    if (confirmedExpiration) {
      if (session.status !== confirmedExpiration.terminalStatus) {
        throw new CheckoutSessionCleanupError(
          "A confirmed Checkout Session expiration changed state."
        );
      }
      return session;
    }

    if (session.status === "complete" || session.status === "expired") {
      if (pendingExpiration) {
        await checkpointAttemptState({
          ...pendingExpiration,
          kind: "expiration_confirmed",
          terminalStatus: session.status,
        });
      }
      return session;
    }
    if (session.status !== "open") {
      throw new CheckoutSessionCleanupError(
        "A Checkout Session is no longer safely expirable."
      );
    }

    const expirationState = pendingExpiration ?? {
      cleanupKind: input.cleanupKind,
      customerId: input.customerId,
      expirationIdempotencyKey: options.expirationIdempotencyKey(
        input.sessionId
      ),
      kind: "expiration_in_flight" as const,
      resumeState: checkoutAttemptResumeState(durableAttemptState),
      sessionId: input.sessionId,
    };
    await checkpointAttemptState(expirationState);

    let expirationError: unknown;
    try {
      await options.provider.expireCheckoutSession(input.sessionId, {
        idempotencyKey: expirationState.expirationIdempotencyKey,
      });
    } catch (error) {
      expirationError = error;
    }

    let reconciled: CheckoutSessionSnapshot;
    try {
      reconciled = await options.provider.retrieveCheckoutSession(
        input.sessionId
      );
    } catch (error) {
      throw new CheckoutSessionCleanupError(
        "A Checkout Session could not be reconciled after expiration.",
        { cause: error }
      );
    }
    if (!isAppOwnedCheckoutSession(reconciled, input)) {
      throw new CheckoutSessionCleanupError(
        "A Checkout Session is not safely app-owned.",
        { cause: expirationError }
      );
    }
    if (reconciled.status === "complete" || reconciled.status === "expired") {
      await checkpointAttemptState({
        ...expirationState,
        kind: "expiration_confirmed",
        terminalStatus: reconciled.status,
      });
      return reconciled;
    }
    throw new CheckoutSessionCleanupError(
      "A Checkout Session could not be safely closed.",
      { cause: expirationError }
    );
  };

  return {
    checkpoint: checkpointAttemptState,
    currentAttemptState: () => durableAttemptState,
    expireSession,
    resumeState: checkoutAttemptResumeState(options.initialState),
  };
}

function matchesExpirationAttempt(
  state: Extract<
    CheckoutAttemptState,
    { kind: "expiration_confirmed" | "expiration_in_flight" }
  >,
  input: Parameters<CheckoutSessionExpiration>[0]
): boolean {
  return (
    state.cleanupKind === input.cleanupKind &&
    state.customerId === input.customerId &&
    state.sessionId === input.sessionId
  );
}
