import "server-only";

import type { RunnerStore } from "../store";
import type { RunnerDispatchAuthority, RunnerOperator } from "../types";
import type {
  DaytonaLaunchAuthorizer,
  DaytonaPreparationAuthorizer,
  DaytonaPreparationRelease,
} from "./process";

export type DaytonaDispatchAuthorizers = Readonly<{
  authorizeLaunch: DaytonaLaunchAuthorizer;
  authorizePreparation: DaytonaPreparationAuthorizer;
  currentAuthority: () => RunnerDispatchAuthority;
  releasePreparation: DaytonaPreparationRelease;
}>;

/**
 * Adapts a single operator dispatch authority to Daytona's process callbacks.
 * The attempt stays closure-local and every callback carries it exactly.
 */
export function daytonaDispatchAuthorizers(
  store: Pick<
    RunnerStore,
    | "authorizeDaytonaLaunch"
    | "authorizeDaytonaPreparation"
    | "releaseDaytonaPreparation"
  >,
  operator: RunnerOperator,
  authority: RunnerDispatchAuthority
): DaytonaDispatchAuthorizers {
  let prepared: RunnerDispatchAuthority | undefined;
  let latest = authority;

  return {
    authorizeLaunch: (launch) => {
      if (
        launch.runId !== authority.runId ||
        !prepared ||
        launch.attemptId !== prepared.attemptId
      ) {
        return Promise.resolve(null);
      }
      return store
        .authorizeDaytonaLaunch(operator, prepared, {
          attemptId: launch.attemptId,
          commandId: launch.commandId,
          sessionId: launch.sessionId,
        })
        .then((result) => {
          if (result.kind !== "authorized") {
            return null;
          }
          prepared = result.authority;
          latest = result.authority;
          return result.authority;
        });
    },
    authorizePreparation: async (preparation) => {
      if (preparation.runId !== authority.runId) {
        return null;
      }
      const result = await store.authorizeDaytonaPreparation(
        operator,
        authority
      );
      if (result.kind !== "authorized") {
        return null;
      }
      prepared = result.authority;
      latest = result.authority;
      return result.attemptId;
    },
    currentAuthority: () => latest,
    releasePreparation: async (release) => {
      if (
        release.runId !== authority.runId ||
        !prepared ||
        release.attemptId !== prepared.attemptId
      ) {
        return null;
      }
      const result = await store.releaseDaytonaPreparation(operator, prepared, {
        attemptId: release.attemptId,
      });
      if (result.kind !== "released") {
        return null;
      }
      prepared = undefined;
      latest = result.authority;
      return result.authority;
    },
  };
}
