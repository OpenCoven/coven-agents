import "server-only";

import { randomBytes } from "node:crypto";
import {
  HARNESS_SPECS,
  type HarnessStatus,
  harnessStatus,
} from "@opencoven/harness";
import {
  globalDailyRunCapFromEnv,
  requireNonemptyAbuseKeySecret,
} from "@/lib/abuse/config";
import { sessionAuthorityMatches } from "@/lib/auth/session-revocation";
import { periodStart } from "@/lib/billing/period";
import type { databaseFor } from "@/lib/db/access";
import type { SubscriberSession } from "@/lib/session";
import type { RunnerAdmissionLimits, RunnerDispatchResult } from "./admission";
import type { RunnerAdmissionFailure } from "./admission-observability";
import type {
  RunnerReconciliationExecutionResult,
  RunnerReconciliationResult,
} from "./attempt-reconcile";
import type { RunnerResourceOperationObservation } from "./resource-observability";
import type { RunnerService } from "./service";
import type { RunnerStore } from "./store";
import type {
  RunnerClaimedDispatch,
  RunnerOperator,
  RunnerRunRecord,
} from "./types";

const OPERATOR: RunnerOperator = { kind: "runner-operator" };
const RECONCILIATION_LEASE_TTL_SECONDS = 360;
const HERMETIC_DISPATCH_LEASE_MS = 1000;
const QUEUED_AUTHORITY_PREFLIGHT_BATCH_SIZE = 20;
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

export type ProductionDatabase = ReturnType<typeof databaseFor>;

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

export type ProductionDatabasePrincipal = SubscriberSession | RunnerOperator;
export type ProductionDatabaseFactory = (
  principal: ProductionDatabasePrincipal
) => ProductionDatabase | Promise<ProductionDatabase>;
export type ProductionAccountFinder = (
  userId: string
) => Promise<ProductionDispatchAccount | null>;

export type ProductionClaimDependencies = Readonly<{
  clock?: () => Date;
  dispatch: (
    claimed: RunnerClaimedDispatch,
    context: CredentialContext,
    revalidateCredentialContext: () => Promise<CredentialContextDecision>
  ) => Promise<RunnerDispatchResult>;
  environment?: Readonly<Record<string, string | undefined>>;
  findAccount?: ProductionAccountFinder;
  operator: RunnerOperator;
  /**
   * Reports that credential context could not be built because the runner is
   * misconfigured, as distinct from the tenant being out of capacity. Both
   * release the claim, so without this the two are indistinguishable from
   * outside and a bad deployment looks like ordinary backpressure.
   */
  reportCredentialMisconfiguration?: (
    misconfiguration: RunnerCredentialMisconfiguration
  ) => void;
  store: Pick<
    RunnerStore,
    "cleanupTerminalLease" | "finalizeRun" | "releaseUnstartedDispatch"
  >;
}>;

export type RunnerCredentialMisconfiguration = Readonly<{
  detail: string;
  runId: string;
}>;

type ProductionQueuedAuthorityPreflightDependencies = Pick<
  ProductionClaimDependencies,
  | "clock"
  | "environment"
  | "findAccount"
  | "operator"
  | "reportCredentialMisconfiguration"
  | "store"
>;

export type ProductionRunnerRuntimeDependencies = Readonly<{
  databaseFor?: ProductionDatabaseFactory;
  findAccount?: ProductionAccountFinder;
  reportAdmissionFailure?: (failure: RunnerAdmissionFailure) => void;
  reportResourceOperation?: (
    observation: RunnerResourceOperationObservation
  ) => void;
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

export async function productionDatabase(
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
    "clock" | "environment" | "findAccount" | "reportCredentialMisconfiguration"
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
  } catch (error) {
    /**
     * Only the two configuration reads above can throw here, and both raise a
     * fixed message naming the variable at fault, so the detail carries no
     * credential material. Capacity exhaustion never reaches this branch — it
     * is decided by admission and reported as admission_unavailable.
     */
    dependencies.reportCredentialMisconfiguration?.({
      detail:
        error instanceof Error
          ? error.message
          : "Runner credential configuration is invalid.",
      runId: run.id,
    });
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

async function terminalizeRevokedProductionClaim(
  claimed: RunnerClaimedDispatch,
  dependencies: ProductionQueuedAuthorityPreflightDependencies
): Promise<RunnerDispatchResult> {
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

/**
 * Revalidates a claimed queued run without obtaining credentials or reaching
 * the executor. Eligible work is put back exactly where the scheduler found
 * it; revoked work is terminalized before capacity can defer that decision.
 */
export async function preflightQueuedProductionClaim(
  claimed: RunnerClaimedDispatch,
  dependencies: ProductionQueuedAuthorityPreflightDependencies
): Promise<"released" | "retained" | "terminalized"> {
  let decision: CredentialContextDecision;
  try {
    decision = await credentialContextForRun(claimed.run, dependencies);
  } catch {
    decision = { kind: "unavailable" };
  }
  if (decision.kind === "authority_revoked") {
    return (await terminalizeRevokedProductionClaim(claimed, dependencies))
      .kind === "refused"
      ? "terminalized"
      : "retained";
  }
  return (
    await releaseUnstartedClaim(
      dependencies.store,
      claimed,
      dependencies.operator
    )
  ).kind === "retained"
    ? "retained"
    : "released";
}

/**
 * Performs bounded capacity-independent queued authority checks per
 * reconciliation. The normal scheduler still owns all execution admission.
 */
export async function preflightQueuedProductionDispatch(
  dependencies: ProductionQueuedAuthorityPreflightDependencies &
    Readonly<{
      dispatchLeaseMs: number;
      store: Pick<
        RunnerStore,
        | "claimQueuedDispatchForRevalidation"
        | "cleanupTerminalLease"
        | "finalizeRun"
        | "releaseUnstartedDispatch"
      >;
    }>
): Promise<void> {
  const excludedRunIds: string[] = [];
  for (
    let index = 0;
    index < QUEUED_AUTHORITY_PREFLIGHT_BATCH_SIZE;
    index += 1
  ) {
    // biome-ignore lint/performance/noAwaitInLoops: Claims must stay sequential so each revalidation lease is fenced.
    const claimed = await dependencies.store.claimQueuedDispatchForRevalidation(
      dependencies.operator,
      {
        ...nextDispatchLease(dependencies.dispatchLeaseMs),
        excludedRunIds,
      }
    );
    if (!claimed) {
      return;
    }
    excludedRunIds.push(claimed.run.id);
    if (
      (await preflightQueuedProductionClaim(claimed, dependencies)) ===
      "retained"
    ) {
      throw new Error("Queued authority preflight cleanup is pending.");
    }
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
    return terminalizeRevokedProductionClaim(claimed, dependencies);
  }
  if (decision.kind === "unavailable") {
    return releaseUnstartedClaim(
      dependencies.store,
      claimed,
      dependencies.operator
    );
  }
  return dependencies.dispatch(claimed, decision.context, () =>
    credentialContextForRun(claimed.run, dependencies)
  );
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

/**
 * The image installs exactly the supported harnesses, at exactly their
 * registry pins, so discovery reports the same pin rather than a separately
 * maintained constant that could disagree with what was baked in.
 */
export function registryHarnesses(): readonly HarnessStatus[] {
  return HARNESS_SPECS.map((spec) =>
    harnessStatus(spec, {
      installed: spec.supported,
      version: spec.supported ? spec.installVersion : null,
    })
  );
}

export function reconciliationFailure(
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

function hermeticConfiguredDispatcher(
  database: ProductionDatabase,
  store: RunnerStore,
  findAccount?: ProductionAccountFinder
): () => Promise<RunnerDispatchResult> {
  return async () => {
    const admission = await import("./admission");
    let claimed: RunnerClaimedDispatch | null;
    let limits: RunnerAdmissionLimits;
    try {
      limits = admission.admissionLimitsFromEnvironment();
      claimed = await store.claimNextDispatch(OPERATOR, {
        ...nextDispatchLease(HERMETIC_DISPATCH_LEASE_MS),
        limits,
      });
    } catch {
      return { kind: "unavailable", reason: "admission_unavailable" };
    }
    if (!claimed) {
      return { kind: "idle" };
    }
    return hermeticConfiguredClaimDispatcher(
      database,
      store,
      limits,
      findAccount
    )(claimed);
  };
}

function hermeticConfiguredClaimDispatcher(
  database: ProductionDatabase,
  store: RunnerStore,
  limits?: RunnerAdmissionLimits,
  findAccount?: ProductionAccountFinder
): (claimed: RunnerClaimedDispatch) => Promise<RunnerDispatchResult> {
  return async (claimed) => {
    const [admission, credentials, composition] = await Promise.all([
      import("./admission"),
      import("@/lib/credentials/runner-credential"),
      import("./hermetic/composition"),
    ]);
    const resolvedLimits = limits ?? admission.admissionLimitsFromEnvironment();
    return dispatchProductionClaim(claimed, {
      dispatch: (authorized, context, revalidateCredentialContext) => {
        let currentContext = context;
        return admission.dispatchRunnerClaim(
          authorized,
          composition.hermeticRunnerDispatchDependencies({
            credentialDependencies:
              credentials.drizzleRunnerCredentialDependencies(database),
            credentialInput: (run) => ({
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
            store,
          })
        );
      },
      findAccount,
      operator: OPERATOR,
      store,
    });
  };
}

function hermeticProductionReconcile(
  database: ProductionDatabase,
  store: RunnerStore,
  findAccount?: ProductionAccountFinder,
  reportFailure?: (failure: RunnerReconciliationFailure) => void,
  reportResourceOperation?: (
    observation: RunnerResourceOperationObservation
  ) => void
): RunnerService["reconcileAndDispatch"] {
  return async () => {
    let stage: RunnerReconciliationFailure["stage"] = "lease";
    try {
      return await runLeasedReconciliation({
        reconcile: async () => {
          stage = "composition";
          const [
            admission,
            credentials,
            reconciliation,
            composition,
            resourceLifecycleModule,
            teamOrchestration,
            teamStoreModule,
          ] = await Promise.all([
            import("./admission"),
            import("@/lib/credentials/runner-credential"),
            import("./attempt-reconcile"),
            import("./hermetic/composition"),
            import("./hermetic/resource-lifecycle"),
            import("@/lib/teams/orchestrate"),
            import("@/lib/teams/store"),
          ]);
          const credentialDependencies =
            credentials.drizzleRunnerCredentialDependencies(database);
          const resourceLifecycle =
            resourceLifecycleModule.hermeticPersistentResourceLifecycle(
              store,
              reportResourceOperation
            );
          const dependencies =
            composition.hermeticRunnerReconciliationDependencies({
              credentialDependencies,
              credentialInput: () => {
                throw new Error(
                  "Reconciliation dispatch must resolve account credentials first."
                );
              },
              limits: admission.admissionLimitsFromEnvironment(),
              operator: OPERATOR,
              resourceLifecycle,
              store,
            });
          const teams = teamOrchestration.createTeamOrchestrator({
            admit: (input) => admission.admitRunnerRun(input, { store }),
            cancelRun: (_principal, runId) =>
              reconciliation.cancelRunnerRun(
                runId,
                composition.hermeticRunnerCancellationDependencies({
                  credentialDependencies,
                  operator: OPERATOR,
                  resourceLifecycle,
                  store,
                })
              ),
            operator: OPERATOR,
            store: teamStoreModule.createTeamStore(
              teamStoreModule.drizzleTeamStoreDatabase(database)
            ),
          });
          stage = "reconcile";
          return reconciliation.reconcileAndDispatch({
            ...dependencies,
            claimTeamRuns: teams.claimReadySteps,
            dispatch: hermeticConfiguredDispatcher(
              database,
              store,
              findAccount
            ),
            dispatchClaim: hermeticConfiguredClaimDispatcher(
              database,
              store,
              undefined,
              findAccount
            ),
            preflightQueuedDispatch: () =>
              preflightQueuedProductionDispatch({
                dispatchLeaseMs: HERMETIC_DISPATCH_LEASE_MS,
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

async function createHermeticRunnerServiceForPrincipal(
  databasePrincipal: ProductionDatabasePrincipal,
  dependencies: ProductionRunnerRuntimeDependencies
) {
  const database = await (dependencies.databaseFor ?? productionDatabase)(
    databasePrincipal
  );
  const [
    credentials,
    reconciliation,
    composition,
    resourceLifecycleModule,
    service,
    storeModule,
  ] = await Promise.all([
    import("@/lib/credentials/runner-credential"),
    import("./attempt-reconcile"),
    import("./hermetic/composition"),
    import("./hermetic/resource-lifecycle"),
    import("./service"),
    import("./store"),
  ]);
  const store = storeModule.createRunnerStore(
    storeModule.drizzleRunnerStoreDatabase(database)
  );
  const credentialDependencies =
    credentials.drizzleRunnerCredentialDependencies(database);
  const resourceLifecycle =
    resourceLifecycleModule.hermeticPersistentResourceLifecycle(
      store,
      dependencies.reportResourceOperation
    );

  return service.createRunnerService({
    cancelRun: (runId) =>
      reconciliation.cancelRunnerRun(
        runId,
        composition.hermeticRunnerCancellationDependencies({
          credentialDependencies,
          operator: OPERATOR,
          resourceLifecycle,
          store,
        })
      ),
    dispatchClaim: hermeticConfiguredClaimDispatcher(
      database,
      store,
      undefined,
      dependencies.findAccount
    ),
    listHarnesses: async () => registryHarnesses(),
    reconcileAndDispatch: hermeticProductionReconcile(
      database,
      store,
      dependencies.findAccount,
      dependencies.reportReconciliationFailure,
      dependencies.reportResourceOperation
    ),
    reportAdmissionFailure: dependencies.reportAdmissionFailure,
    resourceLifecycle,
    store,
  });
}

async function createProductionRunnerServiceForPrincipal(
  databasePrincipal: ProductionDatabasePrincipal,
  dependencies: ProductionRunnerRuntimeDependencies
) {
  const { hermeticRunnerMode } = await import("./hermetic/mode");
  if (hermeticRunnerMode() === "hermetic") {
    return createHermeticRunnerServiceForPrincipal(
      databasePrincipal,
      dependencies
    );
  }
  const provider = await import("./provider-composition");
  return provider.createHostedRunnerService(databasePrincipal, dependencies);
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
  reportAdmissionFailure: (failure) => {
    console.error("Runner admission failed.", failure);
  },
  reportReconciliationFailure: (failure) => {
    console.error("Runner reconciliation failed.", failure);
  },
  reportResourceOperation: (observation) => {
    console.info("Runner resource operation.", observation);
  },
});

export function createProductionRunnerService(session: SubscriberSession) {
  return productionRunnerRuntime.createSubscriberService(session);
}

export function createProductionRunnerOperatorService() {
  return productionRunnerRuntime.createOperatorService();
}
