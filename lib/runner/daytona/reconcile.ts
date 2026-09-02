import "server-only";

import {
  consumeRunnerCredentialReservation,
  releaseRunnerCredentialResources,
  rollbackRunnerCredentialResources,
} from "@/lib/credentials/runner-credential";
import { dispatchNextRunnerRun } from "../admission";
import type {
  CancelRunnerRunDependencies,
  ReconcileAndDispatchDependencies,
  RunnerReconciliationContext,
  RunnerReconciliationProvider,
} from "../attempt-reconcile";
import { openRunnerAttemptRedactionFromEnvironment } from "../attempt-redaction";
import type { RunnerPersistentResourceLifecycle } from "../resource-lifecycle";
import type { RunnerStore } from "../store";
import type { RunnerOperator } from "../types";
import type { DaytonaRunnerDispatchDependencies } from "./executor";
import { daytonaRunnerDispatchDependencies } from "./executor";
import { daytonaSandboxName } from "./names";
import {
  type DaytonaProcessSandbox,
  snapshotDaytonaProcess,
  stopDaytonaProcess,
} from "./process";
import {
  classifyDaytonaProviderError,
  type DaytonaSandboxLifecycleDependencies,
  type DaytonaSandboxService,
} from "./sandbox";

function runnerReconciliationContext(
  sandbox: DaytonaProcessSandbox
): RunnerReconciliationContext {
  return sandbox as unknown as RunnerReconciliationContext;
}

function daytonaProcessSandbox(
  context: RunnerReconciliationContext
): DaytonaProcessSandbox {
  return context as unknown as DaytonaProcessSandbox;
}

export type DaytonaReconciliationProviderDependencies = Readonly<{
  daytona: DaytonaSandboxService;
}>;

/**
 * Concrete adapter with the only reconciliation-context casts. Not-found is
 * confirmed absence; transport and unknown failures deliberately propagate.
 */
export function daytonaReconciliationProvider(
  dependencies: DaytonaReconciliationProviderDependencies
): RunnerReconciliationProvider {
  return {
    resolveExecutionContext: async (run) => {
      try {
        return runnerReconciliationContext(
          (await dependencies.daytona.get(
            daytonaSandboxName(run.tenant, run.agentId)
          )) as unknown as DaytonaProcessSandbox
        );
      } catch (error) {
        if (classifyDaytonaProviderError(error) === "not_found") {
          return null;
        }
        throw error;
      }
    },
    snapshot: async (input) =>
      await snapshotDaytonaProcess({
        ...input,
        sandbox: daytonaProcessSandbox(input.context),
      }),
    stop: async (context, input) => {
      const stopped = await stopDaytonaProcess(
        daytonaProcessSandbox(context),
        input
      );
      return { kind: stopped.kind };
    },
  };
}

export type DaytonaRunnerReconciliationDependencies = Omit<
  DaytonaRunnerDispatchDependencies,
  "acquireCredential" | "ensureSandbox" | "sandboxDependencies"
> &
  Readonly<{
    batchSize?: number;
    daytona: DaytonaSandboxService;
    lifecycle?: DaytonaSandboxLifecycleDependencies;
    providerConcurrency?: number;
    resourceLifecycle: Pick<
      RunnerPersistentResourceLifecycle,
      "recover" | "reset"
    >;
  }>;

/** Composes Daytona-only attempt recovery, cancellation, and sandbox recovery. */
export function daytonaRunnerReconciliationDependencies(
  dependencies: DaytonaRunnerReconciliationDependencies
): ReconcileAndDispatchDependencies {
  const dispatch = daytonaRunnerDispatchDependencies({
    ...dependencies,
    credentialDependencies: dependencies.credentialDependencies,
    sandboxDependencies: {
      daytona: dependencies.daytona,
      lifecycle: dependencies.lifecycle,
    },
  });
  return {
    batchSize: dependencies.batchSize,
    clock: dependencies.clock,
    consumeCredentialReservation: (run) =>
      consumeRunnerCredentialReservation(
        { runId: run.id, tenant: run.tenant },
        dependencies.credentialDependencies
      ),
    dispatch: () => dispatchNextRunnerRun(dispatch),
    openAttemptRedaction: (scope, envelope) =>
      openRunnerAttemptRedactionFromEnvironment(scope, envelope),
    operator: dependencies.operator,
    provider: daytonaReconciliationProvider({ daytona: dependencies.daytona }),
    providerConcurrency: dependencies.providerConcurrency,
    randomToken: dependencies.randomToken,
    releaseCredentialResources: (run) =>
      releaseRunnerCredentialResources(
        run,
        dependencies.credentialDependencies
      ),
    resourceLifecycle: dependencies.resourceLifecycle,
    rollbackCredentialResources: (run) =>
      rollbackRunnerCredentialResources(
        { runId: run.id, tenant: run.tenant },
        dependencies.credentialDependencies
      ),
    store: dependencies.store,
  };
}

export type DaytonaRunnerCancellationDependencies = Readonly<{
  clock?: () => Date;
  credentialDependencies: DaytonaRunnerDispatchDependencies["credentialDependencies"];
  operator: RunnerOperator;
  provider: RunnerReconciliationProvider;
  randomToken?: () => string;
  resourceLifecycle: Pick<RunnerPersistentResourceLifecycle, "reset">;
  store: RunnerStore;
}>;

/** Concrete cancellation composition with credential cleanup and reset fencing. */
export function daytonaRunnerCancellationDependencies(
  dependencies: DaytonaRunnerCancellationDependencies
): CancelRunnerRunDependencies {
  return {
    clock: dependencies.clock,
    operator: dependencies.operator,
    provider: dependencies.provider,
    randomToken: dependencies.randomToken,
    releaseCredentialResources: (run) =>
      releaseRunnerCredentialResources(
        run,
        dependencies.credentialDependencies
      ),
    resourceLifecycle: dependencies.resourceLifecycle,
    rollbackCredentialResources: (run) =>
      rollbackRunnerCredentialResources(
        { runId: run.id, tenant: run.tenant },
        dependencies.credentialDependencies
      ),
    store: dependencies.store,
  };
}
