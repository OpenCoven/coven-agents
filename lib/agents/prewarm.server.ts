import "server-only";

import { type SubscriberSession, tenantForUser } from "@/lib/session";
import { isSubscribedAt } from "@/lib/subscription";

const PREWARM_TIMEOUT_MS = 5000;

type PrewarmService = {
  prewarmMostRecent: (
    principal: SubscriberSession,
    options: Readonly<{ deadline: number; signal: AbortSignal }>
  ) => Promise<unknown>;
};

type RunnerModule = {
  createProductionRunnerService: (session: SubscriberSession) => PrewarmService;
};

export type PrewarmDependencies = {
  loadRunner?: (signal: AbortSignal) => Promise<RunnerModule>;
  timeoutMs?: number;
};

async function loadProductionRunner(
  signal: AbortSignal
): Promise<RunnerModule> {
  if (signal.aborted) {
    throw signal.reason;
  }
  const runner = await import("@/lib/runner/production");
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
 * dependency is loaded after subscription gating so importing auth does not
 * initialize the database, Daytona SDK, or tenant credentials.
 */
export async function prewarmTenantSandbox(
  user: {
    authVersion: number;
    id: string;
    subscribedUntil: Date | null;
  },
  dependencies: PrewarmDependencies = {}
): Promise<void> {
  if (!isSubscribedAt(user, new Date())) {
    return;
  }

  const timeoutMs = dependencies.timeoutMs ?? PREWARM_TIMEOUT_MS;
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(() => {
    controller.abort(new Error("Sandbox prewarm exceeded its deadline."));
  }, timeoutMs);

  try {
    const session: SubscriberSession = {
      kind: "subscriber",
      tenant: tenantForUser(user.id),
      userId: user.id,
    };
    const runner = await (dependencies.loadRunner ?? loadProductionRunner)(
      controller.signal
    );
    const service = runner.createProductionRunnerService(session);
    await service.prewarmMostRecent(session, {
      deadline,
      signal: controller.signal,
    });
  } catch {
    // The next run pays the cold start it would have paid anyway.
  } finally {
    clearTimeout(timer);
  }
}
