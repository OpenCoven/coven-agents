import "server-only";

import { randomBytes, randomUUID } from "node:crypto";
import type { Daytona } from "@daytona/sdk";
import { configuredApplicationBasePath } from "@/lib/application-path";
import { configuredApplicationOrigin } from "@/lib/auth/application-origin";
import type { RunnerAdmissionLimits, RunnerDispatchResult } from "../admission";
import type { RunnerPersistentResourceLifecycle } from "../resource-lifecycle";
import type { RunnerResourceOperationObserver } from "../resource-observability";
import {
  dispatchProductionClaim,
  type ProductionAccountFinder,
  type ProductionDatabase,
  type ProductionDatabasePrincipal,
  type ProductionRunnerRuntimeDependencies,
  preflightQueuedProductionDispatch,
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
  findAccount?: ProductionAccountFinder,
  observe?: RunnerResourceOperationObserver
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
      findAccount,
      observe
    )(claimed);
  };
}

function configuredClaimDispatcher(
  database: ProductionDatabase,
  store: RunnerStore,
  daytona: Daytona,
  limits?: RunnerAdmissionLimits,
  findAccount?: ProductionAccountFinder,
  observe?: RunnerResourceOperationObserver
): (claimed: RunnerClaimedDispatch) => Promise<RunnerDispatchResult> {
  return async (claimed) => {
    const [
      admission,
      credentials,
      executor,
      githubApp,
      githubCapability,
      githubConfig,
      githubConnection,
      sandbox,
      teamStore,
    ] = await Promise.all([
      import("../admission"),
      import("@/lib/credentials/runner-credential"),
      import("./executor"),
      import("@/lib/github/app-auth"),
      import("@/lib/github/capability"),
      import("@/lib/github/config"),
      import("@/lib/github/connection"),
      import("./sandbox"),
      import("@/lib/teams/store"),
    ]);
    const resolvedLimits = limits ?? admission.admissionLimitsFromEnvironment();
    return dispatchProductionClaim(claimed, {
      dispatch: (authorized, context, revalidateCredentialContext) => {
        let currentContext = context;
        const credentialDependencies =
          credentials.drizzleRunnerCredentialDependencies(database);
        const toolEndpoint = githubToolEndpoint();
        const dependencies = executor.daytonaRunnerDispatchDependencies({
          credentialDependencies,
          credentialInput: (run, _agent) => ({
            ...currentContext,
            harnessId: run.agentRuntime,
            operationId: run.operationId,
            runId: run.id,
            tenant: run.tenant,
          }),
          limits: resolvedLimits,
          operator: OPERATOR,
          revalidateCredentialAuthority: async () => {
            const decision = await revalidateCredentialContext();
            if (decision.kind === "allowed") {
              currentContext = decision.context;
            }
            return decision.kind;
          },
          sandboxConfiguration: sandbox.daytonaSandboxConfiguration(),
          sandboxDependencies: { daytona, observe },
          store,
          ...(toolEndpoint
            ? {
                githubTool: {
                  issueCapability: async ({ attemptId, run }) => {
                    const policy = run.githubBrokerPolicy;
                    if (!policy) {
                      throw new Error(
                        "GitHub capability issuance requires persisted policy."
                      );
                    }
                    const now = new Date();
                    const dispatchDeadline =
                      run.dispatchLeaseExpiresAt?.getTime();
                    if (
                      !dispatchDeadline ||
                      dispatchDeadline - now.getTime() <= 5000
                    ) {
                      throw new Error(
                        "GitHub capability issuance requires a live dispatch lease."
                      );
                    }
                    const deadlineAt = Math.min(
                      dispatchDeadline - 5000,
                      now.getTime() +
                        githubCapability.MAX_GITHUB_CAPABILITY_ISSUANCE_MS
                    );
                    const authorityStore = teamStore.createTeamStore(
                      teamStore.drizzleTeamStoreDatabase(database)
                    );
                    const issued =
                      await githubCapability.issueGitHubStepCapability(
                        {
                          attemptId,
                          capabilityId: randomUUID(),
                          deadlineAt,
                          expiresAt: new Date(
                            now.getTime() +
                              githubCapability.MAX_GITHUB_CAPABILITY_LIFETIME_MS
                          ),
                          now,
                          policy,
                          runnerRunId: run.id,
                          tenant: run.tenant,
                          userId: policy.actorUserId,
                        },
                        {
                          refreshAuthority: async ({
                            abortSignal,
                            deadlineAt: authorityDeadlineAt,
                          }) => {
                            const config = githubConfig.githubAppConfig();
                            const refreshed =
                              await githubConnection.refreshGitHubConnectionAuthority(
                                {
                                  abortSignal,
                                  config,
                                  deadlineAt: authorityDeadlineAt,
                                  principal: {
                                    kind: "subscriber",
                                    tenant: run.tenant,
                                    userId: policy.actorUserId,
                                  },
                                  provider: githubApp.createGitHubAppClient({
                                    appId: config.appId,
                                    appSlug: config.appSlug,
                                    privateKey: config.privateKey,
                                  }),
                                  store: authorityStore,
                                }
                              );
                            if (refreshed.kind !== "current") {
                              throw new Error(
                                "GitHub connection authority changed before capability issuance."
                              );
                            }
                            return refreshed.snapshot;
                          },
                          replaceCapability: (input) =>
                            githubCapability
                              .createGitHubGatewayStore(
                                teamStore.drizzleTeamStoreDatabase(database)
                              )
                              .replaceCapability(OPERATOR, input),
                        }
                      );
                    return { rawCapability: issued.rawToken };
                  },
                  revokeCapability: async ({ attemptId, run }) => {
                    const revoked = await githubCapability
                      .createGitHubGatewayStore(
                        teamStore.drizzleTeamStoreDatabase(database)
                      )
                      .revokeCapability(OPERATOR, {
                        attemptId,
                        runnerRunId: run.id,
                      });
                    return (
                      revoked.kind === "revoked" || revoked.kind === "not_found"
                    );
                  },
                  url: toolEndpoint,
                },
              }
            : {}),
        });
        return admission.dispatchRunnerClaim(authorized, dependencies);
      },
      findAccount,
      operator: OPERATOR,
      store,
    });
  };
}

function githubToolEndpoint(): string | null {
  try {
    const origin = configuredApplicationOrigin(process.env);
    if (!origin) {
      return null;
    }
    const basePath = configuredApplicationBasePath(process.env);
    return new URL(
      `${basePath}/api/internal/github-tool`.replace(/\/+/gu, "/"),
      origin
    ).toString();
  } catch {
    return null;
  }
}

function persistentResourceLifecycle(
  store: RunnerStore,
  options: Readonly<{
    batchSize?: number;
    observe?: RunnerResourceOperationObserver;
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
      inventoryDaytona: () => client.daytonaClient(),
      observe: options.observe,
      operator: OPERATOR,
      providerConcurrency: options.providerConcurrency,
      repairDaytona: (repairOptions) =>
        client.daytonaClientForDeadline(
          Math.min(
            repairOptions?.deadline ?? Number.POSITIVE_INFINITY,
            Date.now() + 15_000
          )
        ),
      store,
    })
  );
}

function daytonaProductionReconcile(
  database: ProductionDatabase,
  store: RunnerStore,
  findAccount?: ProductionAccountFinder,
  reportFailure?: (failure: RunnerReconciliationFailure) => void,
  observe?: RunnerResourceOperationObserver
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
          const resourceLifecycle = await persistentResourceLifecycle(store, {
            observe,
          });
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
            findAccount,
            observe
          );
          stage = "reconcile";
          return reconciliation.reconcileAndDispatch({
            ...composition,
            claimTeamRuns: teams.claimReadySteps,
            dispatch: configuredDispatcher(
              database,
              store,
              daytona,
              findAccount,
              observe
            ),
            dispatchClaim,
            preflightQueuedDispatch: () =>
              preflightQueuedProductionDispatch({
                dispatchLeaseMs: admission.DEFAULT_DISPATCH_LEASE_MS,
                findAccount,
                operator: OPERATOR,
                store,
              }),
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
      inventoryDaytona: () => client.daytonaClient(),
      observe: dependencies.reportResourceOperation,
      operator: OPERATOR,
      repairDaytona: (repairOptions) =>
        client.daytonaClientForDeadline(
          Math.min(
            repairOptions?.deadline ?? Number.POSITIVE_INFINITY,
            Date.now() + 15_000
          )
        ),
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
        dependencies.findAccount,
        dependencies.reportResourceOperation
      )(claimed),
    listHarnesses: async () => registryHarnesses(),
    reconcileAndDispatch: daytonaProductionReconcile(
      database,
      store,
      dependencies.findAccount,
      dependencies.reportReconciliationFailure,
      dependencies.reportResourceOperation
    ),
    resourceLifecycle,
    store,
  });
}
