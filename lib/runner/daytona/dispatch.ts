import "server-only";

import { runnerDispatchAuthorizers } from "../executor";
import type { RunnerStore } from "../store";
import type { RunnerDispatchAuthority, RunnerOperator } from "../types";
import type {
  DaytonaLaunchAuthorizer,
  DaytonaPreparationAuthorizer,
  DaytonaPreparationRelease,
  DaytonaUnrestrictedExecutionAuthorizer,
} from "./process";

export type DaytonaDispatchAuthorizers = Readonly<{
  authorizeLaunch: DaytonaLaunchAuthorizer;
  authorizePreparation: DaytonaPreparationAuthorizer;
  authorizeUnrestrictedExecution: DaytonaUnrestrictedExecutionAuthorizer;
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
    | "authorizeUnrestrictedExecution"
    | "releaseDaytonaPreparation"
  >,
  operator: RunnerOperator,
  authority: RunnerDispatchAuthority
): DaytonaDispatchAuthorizers {
  return runnerDispatchAuthorizers(store, operator, authority);
}
