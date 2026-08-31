import {
  type CheckoutSessionCleanup,
  CheckoutSessionCleanupError,
  type CheckoutSessionCleanupResult,
  type CheckoutSessionSnapshot,
  isAppOwnedCheckoutSession,
} from "./checkout";
import {
  type CheckoutAttemptState,
  type CheckoutCleanupQueueState,
  checkoutAttemptResumeState,
  createCheckoutCleanupQueueState,
  isCheckoutAttemptCleanupQueueState,
  serializeCheckoutAttemptState,
} from "./checkout-lease";
import { classifyStripeExpirationOutcome } from "./stripe-error";

export function createCheckoutSessionExpirationGuard(options: {
  checkpoint: (state: CheckoutAttemptState) => Promise<void>;
  expirationIdempotencyKey: (sessionId: string, generation?: number) => string;
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
  cleanupSessions: CheckoutSessionCleanup;
  currentAttemptState: () => CheckoutAttemptState;
  drainPendingQueue: (input: {
    userId: string;
  }) => Promise<CheckoutSessionCleanupResult[]>;
  resumeState: ReturnType<typeof checkoutAttemptResumeState>;
} {
  let durableAttemptState = options.initialState;

  const checkpointAttemptState = async (state: CheckoutAttemptState) => {
    serializeCheckoutAttemptState(state);
    await options.checkpoint(state);
    durableAttemptState = state;
  };

  const currentQueue = () => {
    if (!isCheckoutAttemptCleanupQueueState(durableAttemptState)) {
      throw new CheckoutSessionCleanupError(
        "Checkout Session cleanup queue is missing."
      );
    }
    return durableAttemptState;
  };

  const advanceQueue = async (
    state: CheckoutCleanupQueueState,
    session: CheckoutSessionSnapshot
  ) => {
    if (session.status !== "complete" && session.status !== "expired") {
      throw new CheckoutSessionCleanupError(
        "A Checkout Session is not terminal."
      );
    }
    const items = state.items.map((item, index) =>
      index === state.currentIndex
        ? {
            sessionId: item.sessionId,
            subscriptionId:
              session.status === "complete" ? session.subscriptionId : null,
            terminalStatus: session.status,
          }
        : item
    );
    await checkpointAttemptState({
      ...state,
      currentIndex: state.currentIndex + 1,
      expiration: null,
      items,
    });
  };

  const retrieveOwnedSession = async (
    state: CheckoutCleanupQueueState,
    userId: string,
    sessionId: string,
    message: string,
    cause?: unknown
  ) => {
    let session: CheckoutSessionSnapshot;
    try {
      session = await options.provider.retrieveCheckoutSession(sessionId);
    } catch (error) {
      throw new CheckoutSessionCleanupError(message, { cause: error });
    }
    if (
      !isAppOwnedCheckoutSession(session, {
        customerId: state.customerId,
        userId,
      })
    ) {
      throw new CheckoutSessionCleanupError(
        "A Checkout Session is not safely app-owned.",
        { cause }
      );
    }
    return session;
  };

  const drainPendingQueue = async (input: {
    userId: string;
  }): Promise<CheckoutSessionCleanupResult[]> => {
    if (!isCheckoutAttemptCleanupQueueState(durableAttemptState)) {
      return [];
    }

    while (
      isCheckoutAttemptCleanupQueueState(durableAttemptState) &&
      durableAttemptState.currentIndex < durableAttemptState.items.length
    ) {
      const queue = durableAttemptState;
      const item = queue.items[queue.currentIndex];
      if (!item) {
        throw new CheckoutSessionCleanupError(
          "Checkout Session cleanup queue is invalid."
        );
      }
      // biome-ignore lint/performance/noAwaitInLoops: each terminal checkpoint must fence the next irreversible expiration.
      const session = await retrieveOwnedSession(
        queue,
        input.userId,
        item.sessionId,
        "A Checkout Session could not be retrieved before expiration."
      );
      if (session.status === "complete" || session.status === "expired") {
        await advanceQueue(queue, session);
        continue;
      }
      if (session.status !== "open") {
        throw new CheckoutSessionCleanupError(
          "A Checkout Session is no longer safely expirable."
        );
      }
      if (queue.expiration?.status === "rejected") {
        throw new CheckoutSessionCleanupError(
          "Stripe deterministically rejected Checkout Session expiration."
        );
      }

      const expiration =
        queue.expiration ??
        ({
          generation: 0,
          idempotencyKey: options.expirationIdempotencyKey(item.sessionId, 0),
          status: "in_flight",
        } as const);
      await checkpointAttemptState({ ...queue, expiration });
      const activeQueue = currentQueue();

      let expirationError: unknown;
      try {
        await options.provider.expireCheckoutSession(item.sessionId, {
          idempotencyKey: expiration.idempotencyKey,
        });
      } catch (error) {
        expirationError = error;
      }

      const reconciled = await retrieveOwnedSession(
        activeQueue,
        input.userId,
        item.sessionId,
        "A Checkout Session could not be reconciled after expiration.",
        expirationError
      );
      if (reconciled.status === "complete" || reconciled.status === "expired") {
        await advanceQueue(activeQueue, reconciled);
        continue;
      }
      if (reconciled.status !== "open") {
        throw new CheckoutSessionCleanupError(
          "A Checkout Session could not be safely closed.",
          { cause: expirationError }
        );
      }

      const outcome =
        expirationError === undefined
          ? "uncertain"
          : classifyStripeExpirationOutcome(expirationError);
      if (outcome === "cacheable_server_error") {
        if (expiration.generation === Number.MAX_SAFE_INTEGER) {
          await checkpointAttemptState({
            ...activeQueue,
            expiration: { ...expiration, status: "rejected" },
          });
        } else {
          const generation = expiration.generation + 1;
          await checkpointAttemptState({
            ...activeQueue,
            expiration: {
              generation,
              idempotencyKey: options.expirationIdempotencyKey(
                item.sessionId,
                generation
              ),
              status: "in_flight",
            },
          });
        }
      } else if (outcome === "definite_rejection") {
        await checkpointAttemptState({
          ...activeQueue,
          expiration: { ...expiration, status: "rejected" },
        });
      }
      throw new CheckoutSessionCleanupError(
        "A Checkout Session could not be safely closed.",
        { cause: expirationError }
      );
    }

    if (!isCheckoutAttemptCleanupQueueState(durableAttemptState)) {
      return [];
    }
    let completedQueue = durableAttemptState;
    for (const [index, item] of completedQueue.items.entries()) {
      if (
        !("terminalStatus" in item) ||
        item.terminalStatus !== "complete" ||
        item.subscriptionId !== null
      ) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: missing subscription references must be refreshed from each exact durable Session id.
      const refreshed = await retrieveOwnedSession(
        completedQueue,
        input.userId,
        item.sessionId,
        "A completed Checkout Session could not be refreshed."
      );
      if (refreshed.status !== "complete") {
        throw new CheckoutSessionCleanupError(
          "A completed Checkout Session changed state."
        );
      }
      if (!refreshed.subscriptionId) {
        continue;
      }
      const items = completedQueue.items.map((queueItem, itemIndex) =>
        itemIndex === index
          ? { ...item, subscriptionId: refreshed.subscriptionId }
          : queueItem
      );
      await checkpointAttemptState({ ...completedQueue, items });
      completedQueue = currentQueue();
    }
    const terminal = completedQueue.items.map((item) => {
      if (!("terminalStatus" in item)) {
        throw new CheckoutSessionCleanupError(
          "Checkout Session cleanup queue is incomplete."
        );
      }
      return {
        sessionId: item.sessionId,
        status: item.terminalStatus,
        subscriptionId: item.subscriptionId,
      };
    });
    if (terminal.every(({ status }) => status === "expired")) {
      await checkpointAttemptState(completedQueue.resumeState);
    }
    return terminal;
  };

  const cleanupSessions: CheckoutSessionCleanup = async (input) => {
    if (input.sessionIds.length === 0) {
      return [];
    }
    if (durableAttemptState.kind === "invalid") {
      throw new CheckoutSessionCleanupError(
        "Checkout Session cleanup state is invalid."
      );
    }
    if (isCheckoutAttemptCleanupQueueState(durableAttemptState)) {
      if (!matchesCleanupQueue(durableAttemptState, input)) {
        throw new CheckoutSessionCleanupError(
          "A pending Checkout Session cleanup queue must be reconciled first."
        );
      }
      return drainPendingQueue({ userId: input.userId });
    }

    let queue: CheckoutCleanupQueueState;
    try {
      queue = createCheckoutCleanupQueueState({
        cleanupKind: input.cleanupKind,
        customerId: input.customerId,
        resumeState: checkoutAttemptResumeState(durableAttemptState),
        sessionIds: input.sessionIds,
      });
    } catch (error) {
      throw new CheckoutSessionCleanupError(
        "Checkout Session cleanup queue is invalid.",
        { cause: error }
      );
    }
    await checkpointAttemptState(queue);
    return drainPendingQueue({ userId: input.userId });
  };

  return {
    checkpoint: checkpointAttemptState,
    cleanupSessions,
    currentAttemptState: () => durableAttemptState,
    drainPendingQueue,
    resumeState: checkoutAttemptResumeState(options.initialState),
  };
}

function matchesCleanupQueue(
  state: CheckoutCleanupQueueState,
  input: Parameters<CheckoutSessionCleanup>[0]
): boolean {
  const sessionIds = [...new Set(input.sessionIds)].sort();
  return (
    state.cleanupKind === input.cleanupKind &&
    state.customerId === input.customerId &&
    state.items.length === sessionIds.length &&
    state.items.every(({ sessionId }, index) => sessionId === sessionIds[index])
  );
}
