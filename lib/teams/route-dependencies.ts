import "server-only";

import { ipAddress } from "@vercel/functions";
import { after } from "next/server";
import { enforceAbusePolicy } from "@/lib/abuse/enforce";
import type { IdempotencyStore } from "@/lib/abuse/idempotency";
import { configuredApplicationOrigin } from "@/lib/auth/application-origin";
import type { SessionLike } from "@/lib/auth/subscriber-access";
import { createRunnerAuth } from "@/lib/runner/auth";
import { createTeamHttpHandlers, type TeamHttpHandlers } from "./http";

async function databaseIdempotencyStore(): Promise<IdempotencyStore> {
  const queries = await import("@/lib/db/queries");
  return queries.databaseIdempotencyStore;
}

const lazyDatabaseIdempotencyStore: IdempotencyStore = {
  async claim(input) {
    return (await databaseIdempotencyStore()).claim(input);
  },
  async cleanupExpired(input) {
    return (await databaseIdempotencyStore()).cleanupExpired(input);
  },
  async complete(input) {
    return (await databaseIdempotencyStore()).complete(input);
  },
  async release(input) {
    return (await databaseIdempotencyStore()).release(input);
  },
};

async function authenticate() {
  const authentication = await import("@/app/(auth)/auth");
  return authentication.auth();
}

async function authorizeSubscriberAccess(session: SessionLike) {
  const authorization = await import(
    "@/lib/auth/subscriber-authorization.server"
  );
  return authorization.authorizeSubscriberAccess(session);
}

async function draftMission(
  input: Parameters<
    NonNullable<Parameters<typeof createTeamHttpHandlers>[0]["draftMission"]>
  >[0]
): Promise<string> {
  const mission = await import("@/lib/ai/mission");
  return mission.draftTeamMission(input);
}

export function productionTeamHttpHandlers(): TeamHttpHandlers {
  return createTeamHttpHandlers({
    after,
    appOrigin: () => configuredApplicationOrigin(process.env),
    auth: createRunnerAuth({
      authenticate,
      authorizeSubscriberAccess,
    }),
    createService: async (subscriber) => {
      const [access, service, store] = await Promise.all([
        import("@/lib/db/access"),
        import("./service"),
        import("./store"),
      ]);
      return service.createTeamService({
        cancelChild: async (principal, runId) => {
          const runtime = await import("@/lib/runner/runtime");
          const runner = await runtime.createProductionRunnerService(
            subscriber.session
          );
          return runner.stopRun(principal, runId);
        },
        store: store.createTeamStore(
          store.drizzleTeamStoreDatabase(access.databaseFor(subscriber.session))
        ),
      });
    },
    draftMission,
    enforceAbuse: enforceAbusePolicy,
    idempotencyStore: lazyDatabaseIdempotencyStore,
    ipAddress: (request) => ipAddress(request) ?? null,
    reconcile: async () => {
      const runtime = await import("@/lib/runner/runtime");
      const service = await runtime.createProductionRunnerOperatorService();
      await service.reconcileAndDispatch();
    },
  });
}
