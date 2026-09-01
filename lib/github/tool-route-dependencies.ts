import "server-only";

import { databaseFor } from "@/lib/db/access";
import type { RunnerOperator } from "@/lib/runner/types";
import { drizzleTeamStoreDatabase } from "@/lib/teams/store";
import { createGitHubAppClient } from "./app-auth";
import { createGitHubGatewayStore } from "./capability";
import { validateGitHubEnvironment } from "./config";
import {
  createGitHubOperationProvider,
  createGitHubToolGateway,
  createGitHubToolHttpHandler,
  GitHubToolGatewayError,
} from "./http";

const GITHUB_TOOL_OPERATOR: RunnerOperator = { kind: "runner-operator" };

export function productionGitHubToolHandler() {
  return createGitHubToolHttpHandler({
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
      return createGitHubToolGateway({
        operator: GITHUB_TOOL_OPERATOR,
        provider: createGitHubOperationProvider({
          withInstallationAuthorization:
            app.withInstallationAuthorization.bind(app),
        }),
        store,
      }).execute(request);
    },
  });
}
