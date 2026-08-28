import "server-only";

import type { RunnerStore } from "../store";
import type { RunnerDispatchAuthority, RunnerOperator } from "../types";
import type {
  DaytonaLaunchAuthorizer,
  DaytonaPreparationAuthorizer,
} from "./process";

export type DaytonaDispatchAuthorizers = Readonly<{
  authorizeLaunch: DaytonaLaunchAuthorizer;
  authorizePreparation: DaytonaPreparationAuthorizer;
}>;

/**
 * Adapts a single operator dispatch authority to Daytona's process callbacks.
 * The preparation claim stays closure-local until it is presented to launch.
 */
export function daytonaDispatchAuthorizers(
  store: Pick<
    RunnerStore,
    "authorizeDaytonaLaunch" | "authorizeDaytonaPreparation"
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
        return Promise.resolve(false);
      }
      return store.authorizeDaytonaLaunch(operator, prepared, {
        preparationClaim: launch.preparationClaim,
        sessionId: launch.sessionId,
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
  };
}
