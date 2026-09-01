import "server-only";

import {
  acquireRunnerCredential,
  consumeRunnerCredentialReservation,
  type RunnerCredentialAcquireInput,
  type RunnerCredentialAcquireResult,
  type RunnerCredentialDependencies,
  releaseRunnerCredentialResources,
  rollbackRunnerCredentialResources,
} from "@/lib/credentials/runner-credential";
import type { RunnerDispatchDependencies } from "../admission";
import { dispatchNextRunnerRun } from "../admission";
import type {
  CancelRunnerRunDependencies,
  ReconcileAndDispatchDependencies,
} from "../attempt-reconcile";
import type { RunnerStore } from "../store";
import type { RunnerOperator } from "../types";
import { hermeticRunnerExecutor } from "./executor";
import { hermeticReconciliationProvider } from "./reconcile";

export type HermeticRunnerDispatchDependencies = Omit<
  RunnerDispatchDependencies,
  "acquireCredential" | "executor" | "store"
> &
  Readonly<{
    credentialDependencies: RunnerCredentialDependencies;
    store: RunnerStore;
  }>;

export function hermeticRunnerDispatchDependencies(
  dependencies: HermeticRunnerDispatchDependencies
): RunnerDispatchDependencies {
  return {
    ...dependencies,
    acquireCredential: (
      input: RunnerCredentialAcquireInput
    ): Promise<RunnerCredentialAcquireResult> =>
      acquireRunnerCredential(input, dependencies.credentialDependencies),
    executor: hermeticRunnerExecutor({
      operator: dependencies.operator,
      store: dependencies.store,
    }),
  };
}

export type HermeticRunnerReconciliationDependencies = Omit<
  HermeticRunnerDispatchDependencies,
  "acquireCredential" | "executor"
> &
  Readonly<{
    batchSize?: number;
    providerConcurrency?: number;
  }>;

/**
 * Composes the production credential/accounting boundary with the hermetic
 * provider. No Daytona module or client is reachable from this composition.
 */
export function hermeticRunnerReconciliationDependencies(
  dependencies: HermeticRunnerReconciliationDependencies
): ReconcileAndDispatchDependencies {
  const dispatch = hermeticRunnerDispatchDependencies(dependencies);
  return {
    batchSize: dependencies.batchSize,
    clock: dependencies.clock,
    consumeCredentialReservation: (run) =>
      consumeRunnerCredentialReservation(
        { runId: run.id, tenant: run.tenant },
        dependencies.credentialDependencies
      ),
    dispatch: () => dispatchNextRunnerRun(dispatch),
    operator: dependencies.operator,
    provider: hermeticReconciliationProvider(),
    providerConcurrency: dependencies.providerConcurrency,
    randomToken: dependencies.randomToken,
    releaseCredentialResources: (run) =>
      releaseRunnerCredentialResources(
        run.id,
        dependencies.credentialDependencies
      ),
    rollbackCredentialResources: (run) =>
      rollbackRunnerCredentialResources(
        { runId: run.id, tenant: run.tenant },
        dependencies.credentialDependencies
      ),
    sandboxRecovery: async () => ({
      deferred: 0,
      failures: 0,
      recovered: 0,
    }),
    store: dependencies.store,
  };
}

export type HermeticRunnerCancellationDependencies = Readonly<{
  clock?: () => Date;
  credentialDependencies: RunnerCredentialDependencies;
  operator: RunnerOperator;
  randomToken?: () => string;
  store: RunnerStore;
}>;

export function hermeticRunnerCancellationDependencies(
  dependencies: HermeticRunnerCancellationDependencies
): CancelRunnerRunDependencies {
  return {
    clock: dependencies.clock,
    operator: dependencies.operator,
    provider: hermeticReconciliationProvider(),
    randomToken: dependencies.randomToken,
    releaseCredentialResources: (run) =>
      releaseRunnerCredentialResources(
        run.id,
        dependencies.credentialDependencies
      ),
    rollbackCredentialResources: (run) =>
      rollbackRunnerCredentialResources(
        { runId: run.id, tenant: run.tenant },
        dependencies.credentialDependencies
      ),
    store: dependencies.store,
  };
}
