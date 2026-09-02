import "server-only";

import { enforceAbusePolicy } from "@/lib/abuse/enforce";
import { databaseFor } from "@/lib/db/access";
import type { RunnerOperator } from "@/lib/runner/types";
import { createTeamStore, drizzleTeamStoreDatabase } from "@/lib/teams/store";
import { createGitHubAppClient } from "./app-auth";
import { createGitHubGatewayStore } from "./capability";
import { validateGitHubEnvironment } from "./config";
import { refreshGitHubConnectionAuthority } from "./connection";
import {
  createGitHubOperationProvider,
  createGitHubToolGateway,
  createGitHubToolHttpHandler,
  GitHubToolGatewayError,
  GitHubToolProviderError,
} from "./http";

const GITHUB_TOOL_OPERATOR: RunnerOperator = { kind: "runner-operator" };

export function productionGitHubToolHandler() {
  return createGitHubToolHttpHandler({
    enforceAbuse: enforceAbusePolicy,
    execute: (request) => {
      const config = validateGitHubEnvironment(process.env);
      if (!config.enabled) {
        throw new GitHubToolGatewayError(
          "github_feature_disabled",
          "GitHub tool execution is unavailable.",
          { retryable: false, status: 404 }
        );
      }
      const app = createGitHubAppClient({
        appId: config.appId,
        appSlug: config.appSlug,
        privateKey: config.privateKey,
      });
      const store = createGitHubGatewayStore(
        drizzleTeamStoreDatabase(databaseFor(GITHUB_TOOL_OPERATOR))
      );
      const authorityStore = createTeamStore(
        drizzleTeamStoreDatabase(databaseFor(GITHUB_TOOL_OPERATOR))
      );
      return createGitHubToolGateway({
        operator: GITHUB_TOOL_OPERATOR,
        provider: createGitHubOperationProvider({
          withInstallationAuthorization:
            app.withInstallationAuthorization.bind(app),
        }),
        refreshAuthority: async ({ abortSignal, context, deadlineAt }) => {
          const refreshed = await refreshGitHubConnectionAuthority({
            abortSignal,
            authVersion: context.capability.authVersion,
            config,
            deadlineAt,
            now: new Date(),
            principal: {
              kind: "subscriber",
              tenant: context.capability.tenant,
              userId: context.actorUserId,
            },
            provider: app,
            store: authorityStore,
          });
          if (
            refreshed.kind !== "current" ||
            refreshed.snapshot.generation !==
              context.capability.connectionGeneration ||
            !refreshed.snapshot.connections.some(
              (connection) =>
                connection.id === context.connectionId &&
                connection.repositoryId === context.repositoryId
            )
          ) {
            throw new GitHubToolProviderError(
              "github_operation_authority_changed",
              { retryable: false, status: 409 }
            );
          }
        },
        store,
      }).execute(request);
    },
  });
}
