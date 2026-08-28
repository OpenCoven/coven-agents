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
  releasePreparation: DaytonaPreparationRelease;
}>;

/**
 * Adapts a single operator dispatch authority to Daytona's process callbacks.
 * The preparation claim stays closure-local until it is presented to launch.
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

  return {
    authorizeLaunch: (launch) => {
      if (
        launch.runId !== authority.runId ||
        !prepared ||
        launch.preparationClaim !== prepared.preparationClaim
      ) {
        return Promise.resolve(null);
      }
      return store
        .authorizeDaytonaLaunch(operator, prepared, {
          commandId: launch.commandId,
          preparationClaim: launch.preparationClaim,
          sessionId: launch.sessionId,
        })
        .then((result) => {
          if (result.kind !== "authorized") {
            return null;
          }
          prepared = undefined;
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
      return result.claim;
    },
    releasePreparation: async (release) => {
      if (
        release.runId !== authority.runId ||
        !prepared ||
        release.preparationClaim !== prepared.preparationClaim
      ) {
        return null;
      }
      const result = await store.releaseDaytonaPreparation(operator, prepared, {
        preparationClaim: release.preparationClaim,
      });
      if (result.kind !== "released") {
        return null;
      }
      prepared = undefined;
      return result.authority;
    },
  };
}
