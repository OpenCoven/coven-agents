import "server-only";

import { type SubscriberSession, tenantForUser } from "@/lib/session";
import { isSubscribedAt } from "@/lib/subscription";

const PREWARM_TIMEOUT_MS = 5000;

type PrewarmService = {
  prewarmMostRecent: (
    principal: SubscriberSession
  ) => Promise<Readonly<{ kind: string }>>;
};

type RunnerModule = {
  createProductionRunnerService: (session: SubscriberSession) => PrewarmService;
};

export type PrewarmDependencies = {
  loadRunner?: () => Promise<RunnerModule>;
  timeoutMs?: number;
};

function loadProductionRunner(): Promise<RunnerModule> {
  return import("@/lib/runner/production");
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
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const session: SubscriberSession = {
      kind: "subscriber",
      tenant: tenantForUser(user.id),
      userId: user.id,
    };
    const attempt = (async () => {
      const runner = await (dependencies.loadRunner ?? loadProductionRunner)();
      const service = runner.createProductionRunnerService(session);
      await service.prewarmMostRecent(session);
    })();
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });

    await Promise.race([attempt, timeout]);
  } catch {
    // The next run pays the cold start it would have paid anyway.
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
