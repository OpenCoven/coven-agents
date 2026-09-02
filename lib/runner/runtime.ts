import "server-only";

import { randomBytes, randomUUID } from "node:crypto";
import type { Daytona } from "@daytona/sdk";
import {
  HARNESS_SPECS,
  type HarnessStatus,
  harnessStatus,
} from "@opencoven/harness";
import {
  globalDailyRunCapFromEnv,
  requireNonemptyAbuseKeySecret,
} from "@/lib/abuse/config";
import { configuredApplicationBasePath } from "@/lib/application-path";
import { configuredApplicationOrigin } from "@/lib/auth/application-origin";
import { sessionAuthorityMatches } from "@/lib/auth/session-revocation";
import { periodStart } from "@/lib/billing/period";
import type { databaseFor } from "@/lib/db/access";
import type { SubscriberSession } from "@/lib/session";
import type { RunnerAdmissionLimits, RunnerDispatchResult } from "./admission";
import { COPILOT_CLI_VERSION } from "./daytona/image";
import type {
  RunnerReconciliationExecutionResult,
  RunnerReconciliationResult,
} from "./reconcile";
import type {
  RunnerDeleteAgentResult,
  RunnerPrewarmOptions,
  RunnerService,
  RunnerWarmSandboxResult,
} from "./service";
import type { RunnerStore } from "./store";
import type {
  RunnerClaimedDispatch,
  RunnerOperator,
  RunnerRunRecord,
} from "./types";

const OPERATOR: RunnerOperator = { kind: "runner-operator" };
const RECONCILIATION_LEASE_TTL_SECONDS = 360;
const EMPTY_RECONCILIATION_COUNTS: RunnerReconciliationResult = {
  adopted: 0,
  deferred: 0,
  dispatched: 0,
  expiredScanned: 0,
  failures: 0,
  logEvents: 0,
  requeued: 0,
  sandboxRecovered: 0,
  terminalCleaned: 0,
  terminalized: 0,
  terminalLeaseCleaned: 0,
};

type ProductionDatabase = ReturnType<typeof databaseFor>;

type CredentialContext = Readonly<{
  globalDailyCap: number;
  keySecret: string;
  periodStart: Date;
}>;

type CredentialContextDecision =
  | Readonly<{ context: CredentialContext; kind: "allowed" }>
  | Readonly<{ kind: "authority_revoked" }>
  | Readonly<{ kind: "unavailable" }>;

type ProductionDispatchAccount = Readonly<{
  authVersion: number;
  billingPeriodStart: Date | null;
  subscribedUntil: Date | null;
}>;

type ProductionDatabasePrincipal = SubscriberSession | RunnerOperator;
type ProductionDatabaseFactory = (
  principal: ProductionDatabasePrincipal
) => ProductionDatabase | Promise<ProductionDatabase>;
type ProductionAccountFinder = (
  userId: string
) => Promise<ProductionDispatchAccount | null>;

export type ProductionClaimDependencies = Readonly<{
  clock?: () => Date;
  dispatch: (
    claimed: RunnerClaimedDispatch,
    context: CredentialContext
  ) => Promise<RunnerDispatchResult>;
  environment?: Readonly<Record<string, string | undefined>>;
  findAccount?: ProductionAccountFinder;
  operator: RunnerOperator;
  store: Pick<
    RunnerStore,
    "cleanupTerminalLease" | "finalizeRun" | "releaseUnstartedDispatch"
  >;
}>;

export type ProductionRunnerRuntimeDependencies = Readonly<{
  databaseFor?: ProductionDatabaseFactory;
  findAccount?: ProductionAccountFinder;
  reportReconciliationFailure?: (failure: RunnerReconciliationFailure) => void;
}>;

export type RunnerReconciliationFailure = Readonly<{
  category: "runner" | "unknown";
  code?: string;
  name?: "DrizzleError" | "Error" | "PostgresError" | "TypeError";
  stage: "composition" | "lease" | "reconcile";
}>;

export type ProductionRunnerRuntime = Readonly<{
  createOperatorService: () => Promise<RunnerService>;
  createSubscriberService: (
    session: SubscriberSession
  ) => Promise<RunnerService>;
}>;

export type LeasedReconciliationDependencies = Readonly<{
  ownerToken?: () => string;
  reconcile: () => Promise<RunnerReconciliationResult>;
  store: Pick<
    RunnerStore,
    "acquireReconciliationLease" | "releaseReconciliationLease"
  >;
  ttlSeconds?: number;
}>;

/**
 * Vercel cron delivery can overlap or be skipped and is not retried. This
 * database-time lease makes each cron/manual recovery attempt singleton while
 * allowing a crashed holder to be reclaimed after the bounded expiry.
 */
export async function runLeasedReconciliation(
  dependencies: LeasedReconciliationDependencies
): Promise<RunnerReconciliationExecutionResult> {
  const ownerToken =
    dependencies.ownerToken?.() ?? randomBytes(32).toString("base64url");
  const acquired = await dependencies.store.acquireReconciliationLease(
    OPERATOR,
    {
      ownerToken,
      ttlSeconds: dependencies.ttlSeconds ?? RECONCILIATION_LEASE_TTL_SECONDS,
    }
  );
  if (acquired.kind === "held") {
    return {
      ...EMPTY_RECONCILIATION_COUNTS,
      execution: "skipped",
      reason: "overlap",
    };
  }

  try {
    return {
      ...(await dependencies.reconcile()),
      execution: "executed",
    };
  } finally {
    try {
      await dependencies.store.releaseReconciliationLease(
        OPERATOR,
        acquired.lease
      );
    } catch {
      // A failed release leaves the fenced lease to expire; it cannot clear a
      // newer owner.
    }
  }
}

async function productionDatabase(
  principal: ProductionDatabasePrincipal
): Promise<ProductionDatabase> {
  const access = await import("@/lib/db/access");
  return access.databaseFor(principal);
}

async function findProductionAccount(
  userId: string
): Promise<ProductionDispatchAccount | null> {
  const queries = await import("@/lib/db/queries");
  return queries.findUserById(userId);
}

function userIdForTenant(tenant: string): string | null {
  const match = /^u_([0-9a-f]{32})$/iu.exec(tenant);
  if (!match) {
    return null;
  }
  const packed = match[1].toLowerCase();
  return [
    packed.slice(0, 8),
    packed.slice(8, 12),
    packed.slice(12, 16),
    packed.slice(16, 20),
    packed.slice(20),
  ].join("-");
}

async function credentialContextForRun(
  run: RunnerRunRecord,
  dependencies: Pick<
    ProductionClaimDependencies,
    "clock" | "environment" | "findAccount"
  >
): Promise<CredentialContextDecision> {
  const userId = userIdForTenant(run.tenant);
  if (!userId) {
    return { kind: "authority_revoked" };
  }
  const account = await (dependencies.findAccount ?? findProductionAccount)(
    userId
  );
  const now = (dependencies.clock ?? (() => new Date()))();
  if (
    run.authVersion === null ||
    !account ||
    !sessionAuthorityMatches({
      database: account,
      now,
      tokenAuthVersion: run.authVersion,
    })
  ) {
    return { kind: "authority_revoked" };
  }
  const currentPeriod = periodStart(
    account.subscribedUntil,
    account.billingPeriodStart
  );
  if (!currentPeriod) {
    return { kind: "authority_revoked" };
  }
  const environment = dependencies.environment ?? process.env;
  try {
    return {
      context: {
        globalDailyCap: globalDailyRunCapFromEnv(
          environment.GLOBAL_DAILY_RUN_CAP
        ),
        keySecret: requireNonemptyAbuseKeySecret(environment.ABUSE_KEY_SECRET),
        periodStart: currentPeriod,
      },
      kind: "allowed",
    };
  } catch {
    return { kind: "unavailable" };
  }
}

async function releaseUnstartedClaim(
  store: Pick<RunnerStore, "releaseUnstartedDispatch">,
  claimed: RunnerClaimedDispatch,
  operator: RunnerOperator = OPERATOR
): Promise<RunnerDispatchResult> {
  try {
    const released = await store.releaseUnstartedDispatch(
      operator,
      claimed.authority
    );
    return released.kind === "released"
      ? {
          kind: "retryable",
          reason: "credential_unavailable",
          runId: claimed.run.id,
        }
      : { kind: "retained", reason: "cleanup_pending", runId: claimed.run.id };
  } catch {
    return {
      kind: "retained",
      reason: "cleanup_pending",
      runId: claimed.run.id,
    };
  }
}

export async function dispatchProductionClaim(
  claimed: RunnerClaimedDispatch,
  dependencies: ProductionClaimDependencies
): Promise<RunnerDispatchResult> {
  let decision: CredentialContextDecision;
  try {
    decision = await credentialContextForRun(claimed.run, dependencies);
  } catch {
    return releaseUnstartedClaim(
      dependencies.store,
      claimed,
      dependencies.operator
    );
  }
  if (decision.kind === "authority_revoked") {
    const { terminalizeUnstartedDispatchFailure } = await import("./admission");
    const terminalized = await terminalizeUnstartedDispatchFailure(
      dependencies,
      claimed.authority,
      claimed.run,
      "authority_revoked",
      "Run authority is no longer valid.",
      false
    );
    return terminalized
      ? { kind: "refused", reason: "authority", runId: claimed.run.id }
      : {
          kind: "retained",
          reason: "cleanup_pending",
          runId: claimed.run.id,
        };
  }
  if (decision.kind === "unavailable") {
    return releaseUnstartedClaim(
      dependencies.store,
      claimed,
      dependencies.operator
    );
  }
  return dependencies.dispatch(claimed, decision.context);
}

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
    const admission = await import("./admission");
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
    const [
      admission,
      credentials,
      githubApp,
      githubCapability,
      githubConfig,
      githubConnection,
      sandbox,
      teamStore,
    ] = await Promise.all([
      import("./admission"),
      import("@/lib/credentials/runner-credential"),
      import("@/lib/github/app-auth"),
      import("@/lib/github/capability"),
      import("@/lib/github/config"),
      import("@/lib/github/connection"),
      import("./daytona/sandbox"),
      import("@/lib/teams/store"),
    ]);
    const resolvedLimits = limits ?? admission.admissionLimitsFromEnvironment();
    return dispatchProductionClaim(claimed, {
      dispatch: (authorized, context) => {
        const credentialDependencies =
          credentials.drizzleRunnerCredentialDependencies(database);
        const dependencies = admission.daytonaRunnerDispatchDependencies({
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
          ...(githubToolEndpoint()
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
                  url: githubToolEndpoint() as string,
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

function registryHarnesses(): readonly HarnessStatus[] {
  return HARNESS_SPECS.map((spec) =>
    harnessStatus(spec, {
      installed: spec.id === "copilot",
      version: spec.id === "copilot" ? COPILOT_CLI_VERSION : null,
    })
  );
}

function reconciliationFailure(
  error: unknown,
  stage: RunnerReconciliationFailure["stage"],
  runnerError: boolean
): RunnerReconciliationFailure {
  const safeNames = new Set<RunnerReconciliationFailure["name"]>([
    "DrizzleError",
    "Error",
    "PostgresError",
    "TypeError",
  ]);
  let candidate = error;
  let code: string | undefined;
  let name: RunnerReconciliationFailure["name"];
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof candidate !== "object" || candidate === null) {
      break;
    }
    const current = candidate as Readonly<{
      cause?: unknown;
      code?: unknown;
      name?: unknown;
    }>;
    const { cause, code: currentCode, name: currentName } = current;
    if (typeof currentCode === "string" && /^[0-9A-Z]{5}$/u.test(currentCode)) {
      code = currentCode;
    }
    if (
      typeof currentName === "string" &&
      safeNames.has(currentName as RunnerReconciliationFailure["name"])
    ) {
      name = currentName as RunnerReconciliationFailure["name"];
    }
    if (cause === candidate) {
      break;
    }
    candidate = cause;
  }
  return {
    category: runnerError ? "runner" : "unknown",
    ...(code ? { code } : {}),
    ...(name ? { name } : {}),
    stage,
  };
}

function productionReconcile(
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
            sandbox,
            teamOrchestration,
            teamStoreModule,
          ] = await Promise.all([
            import("./admission"),
            import("./daytona/client"),
            import("@/lib/credentials/runner-credential"),
            import("./errors"),
            import("./reconcile"),
            import("./daytona/sandbox"),
            import("@/lib/teams/orchestrate"),
            import("@/lib/teams/store"),
          ]);
          const daytona = client.daytonaClient();
          const credentialDependencies =
            credentials.drizzleRunnerCredentialDependencies(database);
          const composition =
            reconciliation.daytonaRunnerReconciliationDependencies({
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
              sandboxConfiguration: sandbox.daytonaSandboxConfiguration(),
              store,
            });
          const teams = teamOrchestration.createTeamOrchestrator({
            admit: (input) => admission.admitRunnerRun(input, { store }),
            cancelRun: (_principal, runId) =>
              reconciliation.cancelRunnerRun(
                runId,
                reconciliation.daytonaRunnerCancellationDependencies({
                  credentialDependencies,
                  daytona,
                  operator: OPERATOR,
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
        "./errors"
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

async function createProductionRunnerServiceForPrincipal(
  databasePrincipal: ProductionDatabasePrincipal,
  dependencies: ProductionRunnerRuntimeDependencies
) {
  const database = await (dependencies.databaseFor ?? productionDatabase)(
    databasePrincipal
  );
  const [
    client,
    credentials,
    process,
    reconciliation,
    sandbox,
    service,
    storeModule,
  ] = await Promise.all([
    import("./daytona/client"),
    import("@/lib/credentials/runner-credential"),
    import("./daytona/process"),
    import("./reconcile"),
    import("./daytona/sandbox"),
    import("./service"),
    import("./store"),
  ]);
  const store = storeModule.createRunnerStore(
    storeModule.drizzleRunnerStoreDatabase(database)
  );
  const credentialDependencies =
    credentials.drizzleRunnerCredentialDependencies(database);

  return service.createRunnerService({
    cancelRun: (runId) =>
      reconciliation.cancelRunnerRun(
        runId,
        reconciliation.daytonaRunnerCancellationDependencies({
          credentialDependencies,
          daytona: client.daytonaClient(),
          operator: OPERATOR,
          store,
        })
      ),
    deleteSandbox: async (
      principal,
      agentId
    ): Promise<RunnerDeleteAgentResult> => {
      try {
        const result = await sandbox.deleteDaytonaSandbox(principal, agentId, {
          daytona: client.daytonaClient(),
          store,
        });
        if (result.kind === "failed") {
          return result.error === "non_retryable"
            ? { kind: "provider_rejected" }
            : { kind: "unavailable", source: "provider" };
        }
        return result;
      } catch {
        return { kind: "unavailable", source: "database" };
      }
    },
    dispatchClaim: (claimed) => {
      const daytona = client.daytonaClient();
      return configuredClaimDispatcher(
        database,
        store,
        daytona,
        undefined,
        dependencies.findAccount
      )(claimed);
    },
    listHarnesses: async () => registryHarnesses(),
    reconcileAndDispatch: productionReconcile(
      database,
      store,
      dependencies.findAccount,
      dependencies.reportReconciliationFailure
    ),
    store,
    warmSandbox: async (
      principal,
      agent,
      options?: RunnerPrewarmOptions
    ): Promise<RunnerWarmSandboxResult> => {
      try {
        const daytona = options?.deadline
          ? client.daytonaClientForDeadline(options.deadline)
          : client.daytonaClient();
        const result = await sandbox.warmDaytonaSandbox(
          principal,
          agent,
          sandbox.daytonaSandboxConfiguration(),
          {
            daytona,
            lifecycle: {
              deadline: options?.deadline,
              signal: options?.signal,
            },
            probe: async (sandboxHandle, signal, timeoutSeconds, sessionId) => {
              await process.probeDaytonaHarnesses(sandboxHandle, {
                deadline: options?.deadline,
                sessionId,
                signal,
                timeoutSeconds,
              });
            },
            store,
          }
        );
        if (result.kind === "failed") {
          return result.error === "non_retryable"
            ? { kind: "provider_rejected" }
            : { kind: "unavailable", source: "provider" };
        }
        return result;
      } catch {
        return { kind: "unavailable", source: "database" };
      }
    },
  });
}

export function createProductionRunnerRuntime(
  dependencies: ProductionRunnerRuntimeDependencies = {}
): ProductionRunnerRuntime {
  return {
    createOperatorService: () =>
      createProductionRunnerServiceForPrincipal(OPERATOR, dependencies),
    createSubscriberService: (session) =>
      createProductionRunnerServiceForPrincipal(session, dependencies),
  };
}

const productionRunnerRuntime = createProductionRunnerRuntime({
  reportReconciliationFailure: (failure) => {
    console.error("Runner reconciliation failed.", failure);
  },
});

export function createProductionRunnerService(session: SubscriberSession) {
  return productionRunnerRuntime.createSubscriberService(session);
}

export function createProductionRunnerOperatorService() {
  return productionRunnerRuntime.createOperatorService();
}
