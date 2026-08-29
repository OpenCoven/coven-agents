import "server-only";

import type {
  SessionLike,
  SubscriberAccessDecision,
} from "@/lib/auth/subscriber-access";
import type { SubscriberSession } from "@/lib/session";
import { isSubscribedAt } from "@/lib/subscription";

const PREWARM_TIMEOUT_MS = 5000;

type PrewarmService = {
  prewarmMostRecent: (
    principal: SubscriberSession,
    options: Readonly<{ deadline: number; signal: AbortSignal }>
  ) => Promise<unknown>;
};

type RunnerModule = {
  createProductionRunnerService: (
    session: SubscriberSession
  ) => PrewarmService | Promise<PrewarmService>;
};

export type PrewarmDependencies = {
  authorizeCurrent?: (
    session: SessionLike,
    signal: AbortSignal
  ) => Promise<SubscriberAccessDecision>;
  loadRunner?: (signal: AbortSignal) => Promise<RunnerModule>;
  now?: () => number;
  timeoutMs?: number;
};

function awaitUntilAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

async function authorizeCurrentSubscriber(
  session: SessionLike,
  signal: AbortSignal
): Promise<SubscriberAccessDecision> {
  if (signal.aborted) {
    throw signal.reason;
  }
  const { authorizeSubscriberAccess } = await import(
    "@/lib/auth/subscriber-authorization.server"
  );
  if (signal.aborted) {
    throw signal.reason;
  }
  return authorizeSubscriberAccess(session);
}

async function loadProductionRunner(
  signal: AbortSignal
): Promise<RunnerModule> {
  if (signal.aborted) {
    throw signal.reason;
  }
  const runner = await import("@/lib/runner/runtime");
  if (signal.aborted) {
    throw signal.reason;
  }
  return runner;
}

/**
 * Starts warming the returning subscriber's most recently used agent.
 *
 * The sign-in callback invokes this through Next.js `after()`. Every failure
 * remains silent because warming is only a latency optimization. The runner
 * dependency is loaded only after the scheduled OAuth snapshot is revalidated
 * against current subscriber authority, so importing auth does not initialize
 * the database, Daytona SDK, or tenant credentials.
 */
export async function prewarmTenantSandbox(
  user: {
    authVersion: number;
    id: string;
    subscribedUntil: Date | null;
  },
  dependencies: PrewarmDependencies = {}
): Promise<void> {
  const now = dependencies.now ?? Date.now;
  if (!isSubscribedAt(user, new Date(now()))) {
    return;
  }

  const timeoutMs = dependencies.timeoutMs ?? PREWARM_TIMEOUT_MS;
  const controller = new AbortController();
  const deadlineAt = now() + timeoutMs;
  const abortIfExpired = () => {
    if (controller.signal.aborted || now() >= deadlineAt) {
      if (!controller.signal.aborted) {
        controller.abort(new Error("Sandbox prewarm exceeded its deadline."));
      }
      return true;
    }
    return false;
  };
  const timer = setTimeout(
    () => {
      controller.abort(new Error("Sandbox prewarm exceeded its deadline."));
    },
    Math.max(0, deadlineAt - now())
  );

  try {
    const snapshot: SessionLike = {
      user: {
        authVersion: user.authVersion,
        id: user.id,
        type: "subscriber",
      },
    };
    const access = await awaitUntilAbort(
      (dependencies.authorizeCurrent ?? authorizeCurrentSubscriber)(
        snapshot,
        controller.signal
      ),
      controller.signal
    );
    if (
      abortIfExpired() ||
      access.kind !== "allowed" ||
      access.authVersion !== user.authVersion ||
      access.userId !== user.id
    ) {
      return;
    }
    const { session } = access;
    const runner = await awaitUntilAbort(
      (dependencies.loadRunner ?? loadProductionRunner)(controller.signal),
      controller.signal
    );
    if (
      abortIfExpired() ||
      access.authVersion !== user.authVersion ||
      access.userId !== user.id
    ) {
      return;
    }
    if (abortIfExpired()) {
      return;
    }
    const service = await awaitUntilAbort(
      Promise.resolve(runner.createProductionRunnerService(session)),
      controller.signal
    );
    if (
      abortIfExpired() ||
      access.authVersion !== user.authVersion ||
      access.userId !== user.id
    ) {
      return;
    }
    await awaitUntilAbort(
      service.prewarmMostRecent(session, {
        deadline: deadlineAt,
        signal: controller.signal,
      }),
      controller.signal
    );
  } catch {
    // The next run pays the cold start it would have paid anyway.
  } finally {
    clearTimeout(timer);
  }
}
