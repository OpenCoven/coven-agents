import "server-only";

import { randomBytes } from "node:crypto";
import type { Daytona } from "@daytona/sdk";
import type { RunnerAdmissionLimits, RunnerDispatchResult } from "../admission";
import type { RunnerPersistentResourceLifecycle } from "../resource-lifecycle";
import {
  dispatchProductionClaim,
  type ProductionAccountFinder,
  type ProductionDatabase,
  type ProductionDatabasePrincipal,
  type ProductionRunnerRuntimeDependencies,
  productionDatabase,
  type RunnerReconciliationFailure,
  reconciliationFailure,
  registryHarnesses,
  runLeasedReconciliation,
} from "../runtime";
import type { RunnerService } from "../service";
import type { RunnerStore } from "../store";
import type { RunnerClaimedDispatch, RunnerOperator } from "../types";

const OPERATOR: RunnerOperator = { kind: "runner-operator" };

function nextDispatchLease(leaseMilliseconds: number): Readonly<{
  leaseExpiresAt: Date;
  leaseToken: string;
}> {
  return {
    leaseExpiresAt: new Date(Date.now() + leaseMilliseconds),
    leaseToken: randomBytes(32).toString("base64url"),
  };
}

function configuredDispatcher(
  database: ProductionDatabase,
  store: RunnerStore,
  daytona: Daytona,
  findAccount?: ProductionAccountFinder
): () => Promise<RunnerDispatchResult> {
  return async () => {
    const admission = await import("../admission");
    let claimed: RunnerClaimedDispatch | null;
    let limits: RunnerAdmissionLimits;
    try {
      limits = admission.admissionLimitsFromEnvironment();
      claimed = await store.claimNextDispatch(OPERATOR, {
        ...nextDispatchLease(admission.DEFAULT_DISPATCH_LEASE_MS),
        limits,
      });
    } catch {
      return { kind: "unavailable", reason: "admission_unavailable" };
    }
    if (!claimed) {
      return { kind: "idle" };
    }
    return configuredClaimDispatcher(
      database,
      store,
      daytona,
      limits,
      findAccount
    )(claimed);
  };
}

function configuredClaimDispatcher(
  database: ProductionDatabase,
  store: RunnerStore,
  daytona: Daytona,
  limits?: RunnerAdmissionLimits,
  findAccount?: ProductionAccountFinder
): (claimed: RunnerClaimedDispatch) => Promise<RunnerDispatchResult> {
  return async (claimed) => {
    const [admission, credentials, executor, sandbox] = await Promise.all([
      import("../admission"),
      import("@/lib/credentials/runner-credential"),
      import("./executor"),
      import("./sandbox"),
    ]);
    const resolvedLimits = limits ?? admission.admissionLimitsFromEnvironment();
    return dispatchProductionClaim(claimed, {
      dispatch: (authorized, context) => {
        const credentialDependencies =
          credentials.drizzleRunnerCredentialDependencies(database);
        const dependencies = executor.daytonaRunnerDispatchDependencies({
          credentialDependencies,
          credentialInput: (run, _agent) => ({
            ...context,
            harnessId: run.agentRuntime,
            operationId: run.operationId,
            runId: run.id,
            tenant: run.tenant,
          }),
          limits: resolvedLimits,
          operator: OPERATOR,
          sandboxConfiguration: sandbox.daytonaSandboxConfiguration(),
          sandboxDependencies: { daytona },
          store,
        });
        return admission.dispatchRunnerClaim(authorized, dependencies);
      },
      findAccount,
      operator: OPERATOR,
      store,
    });
  };
}

function persistentResourceLifecycle(
  store: RunnerStore,
  options: Readonly<{
    batchSize?: number;
    providerConcurrency?: number;
  }> = {}
): Promise<RunnerPersistentResourceLifecycle> {
  return Promise.all([
    import("./client"),
    import("./resource-lifecycle"),
    import("./sandbox"),
  ]).then(([client, lifecycle, sandbox]) =>
    lifecycle.daytonaPersistentResourceLifecycle({
      batchSize: options.batchSize,
      configuration: () => sandbox.daytonaSandboxConfiguration(),
      daytona: (prewarmOptions) =>
        prewarmOptions?.deadline
          ? client.daytonaClientForDeadline(prewarmOptions.deadline)
          : client.daytonaClient(),
      operator: OPERATOR,
      providerConcurrency: options.providerConcurrency,
      store,
    })
  );
}

function daytonaProductionReconcile(
  database: ProductionDatabase,
  store: RunnerStore,
  findAccount?: ProductionAccountFinder,
  reportFailure?: (failure: RunnerReconciliationFailure) => void
): RunnerService["reconcileAndDispatch"] {
  return async () => {
    let stage: RunnerReconciliationFailure["stage"] = "lease";
    try {
      return await runLeasedReconciliation({
        reconcile: async () => {
          stage = "composition";
          const [
            admission,
            client,
            credentials,
            errors,
            reconciliation,
            daytonaReconciliation,
            sandbox,
            teamOrchestration,
            teamStoreModule,
          ] = await Promise.all([
            import("../admission"),
            import("./client"),
            import("@/lib/credentials/runner-credential"),
            import("../errors"),
            import("../attempt-reconcile"),
            import("./reconcile"),
            import("./sandbox"),
            import("@/lib/teams/orchestrate"),
            import("@/lib/teams/store"),
          ]);
          const daytona = client.daytonaClient();
          const credentialDependencies =
            credentials.drizzleRunnerCredentialDependencies(database);
          const resourceLifecycle = await persistentResourceLifecycle(store);
          const composition =
            daytonaReconciliation.daytonaRunnerReconciliationDependencies({
              credentialDependencies,
              credentialInput: () => {
                throw new errors.RunnerServiceError(
                  "reconcile_unavailable",
                  "Reconciliation dispatch must resolve account credentials first."
                );
              },
              daytona,
              limits: admission.admissionLimitsFromEnvironment(),
              operator: OPERATOR,
              resourceLifecycle,
              sandboxConfiguration: sandbox.daytonaSandboxConfiguration(),
              store,
            });
          const teams = teamOrchestration.createTeamOrchestrator({
            admit: (input) => admission.admitRunnerRun(input, { store }),
            cancelRun: (_principal, runId) =>
              reconciliation.cancelRunnerRun(
                runId,
                daytonaReconciliation.daytonaRunnerCancellationDependencies({
                  credentialDependencies,
                  operator: OPERATOR,
                  provider: daytonaReconciliation.daytonaReconciliationProvider(
                    {
                      daytona,
                    }
                  ),
                  resourceLifecycle,
                  store,
                })
              ),
            operator: OPERATOR,
            store: teamStoreModule.createTeamStore(
              teamStoreModule.drizzleTeamStoreDatabase(database)
            ),
          });
          const dispatchClaim = configuredClaimDispatcher(
            database,
            store,
            daytona,
            undefined,
            findAccount
          );
          stage = "reconcile";
          return reconciliation.reconcileAndDispatch({
            ...composition,
            claimTeamRuns: teams.claimReadySteps,
            dispatch: configuredDispatcher(
              database,
              store,
              daytona,
              findAccount
            ),
            dispatchClaim,
            projectTeamRuns: teams.projectTerminalSteps,
          });
        },
        store,
      });
    } catch (error) {
      const { RunnerServiceError: RuntimeServiceError } = await import(
        "../errors"
      );
      const runnerError = error instanceof RuntimeServiceError;
      reportFailure?.(reconciliationFailure(error, stage, runnerError));
      if (runnerError) {
        throw error;
      }
      // biome-ignore lint/style/useErrorCause: The custom error preserves the sanitized cause through its options.
      throw new RuntimeServiceError(
        "reconcile_unavailable",
        "Runner reconciliation is unavailable.",
        true,
        { cause: error }
      );
    }
  };
}

export async function createDaytonaRunnerServiceForPrincipal(
  databasePrincipal: ProductionDatabasePrincipal,
  dependencies: ProductionRunnerRuntimeDependencies
): Promise<RunnerService> {
  const database = await (dependencies.databaseFor ?? productionDatabase)(
    databasePrincipal
  );
  const [
    client,
    credentials,
    reconciliation,
    resourceLifecycleModule,
    service,
    daytonaReconciliation,
    sandbox,
    storeModule,
  ] = await Promise.all([
    import("./client"),
    import("@/lib/credentials/runner-credential"),
    import("../attempt-reconcile"),
    import("./resource-lifecycle"),
    import("../service"),
    import("./reconcile"),
    import("./sandbox"),
    import("../store"),
  ]);
  const store = storeModule.createRunnerStore(
    storeModule.drizzleRunnerStoreDatabase(database)
  );
  const credentialDependencies =
    credentials.drizzleRunnerCredentialDependencies(database);
  const resourceLifecycle =
    resourceLifecycleModule.daytonaPersistentResourceLifecycle({
      configuration: () => sandbox.daytonaSandboxConfiguration(),
      daytona: (options) =>
        options?.deadline
          ? client.daytonaClientForDeadline(options.deadline)
          : client.daytonaClient(),
      operator: OPERATOR,
      store,
    });
  const provider = () =>
    daytonaReconciliation.daytonaReconciliationProvider({
      daytona: client.daytonaClient(),
    });

  return service.createRunnerService({
    cancelRun: (runId) =>
      reconciliation.cancelRunnerRun(
        runId,
        daytonaReconciliation.daytonaRunnerCancellationDependencies({
          credentialDependencies,
          operator: OPERATOR,
          provider: provider(),
          resourceLifecycle,
          store,
        })
      ),
    dispatchClaim: (claimed) =>
      configuredClaimDispatcher(
        database,
        store,
        client.daytonaClient(),
        undefined,
        dependencies.findAccount
      )(claimed),
    listHarnesses: async () => registryHarnesses(),
    reconcileAndDispatch: daytonaProductionReconcile(
      database,
      store,
      dependencies.findAccount,
      dependencies.reportReconciliationFailure
    ),
    resourceLifecycle,
    store,
  });
}
