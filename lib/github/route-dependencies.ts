import "server-only";

import { auth } from "@/app/(auth)/auth";
import { configuredApplicationBasePath } from "@/lib/application-path";
import { configuredApplicationOrigin } from "@/lib/auth/application-origin";
import { authorizeSubscriberAccess } from "@/lib/auth/subscriber-authorization.server";
import { databaseFor } from "@/lib/db/access";
import { databaseIdempotencyStore } from "@/lib/db/queries";
import { createRunnerAuth } from "@/lib/runner/auth";
import { createTeamStore, drizzleTeamStoreDatabase } from "@/lib/teams/store";
import { createGitHubAppClient } from "./app-auth";
import { validateGitHubEnvironment } from "./config";
import {
  createGitHubConnectionHandlers,
  type GitHubConnectionHandlers,
} from "./connection";

export function productionGitHubConnectionHandlers(): GitHubConnectionHandlers {
  return createGitHubConnectionHandlers({
    appBasePath: () => configuredApplicationBasePath(process.env),
    appOrigin: () => configuredApplicationOrigin(process.env),
    auth: createRunnerAuth({
      authenticate: auth,
      authorizeSubscriberAccess,
    }),
    createProvider: (config) =>
      createGitHubAppClient({
        appId: config.appId,
        appSlug: config.appSlug,
        privateKey: config.privateKey,
      }),
    createStore: (subscriber) =>
      createTeamStore(
        drizzleTeamStoreDatabase(databaseFor(subscriber.session))
      ),
    enforceAbuse: async (input) => {
      const abuse = await import("@/lib/abuse/enforce");
      return abuse.enforceAbusePolicy(input);
    },
    getConfig: () => validateGitHubEnvironment(process.env),
    idempotencyStore: databaseIdempotencyStore,
  });
}
