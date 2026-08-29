import "server-only";

import { randomBytes } from "node:crypto";
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
import { sessionAuthorityMatches } from "@/lib/auth/session-revocation";
import { periodStart } from "@/lib/billing/period";
import type { databaseFor } from "@/lib/db/access";
import type { SubscriberSession } from "@/lib/session";
import type { RunnerAdmissionLimits, RunnerDispatchResult } from "./admission";
import { COPILOT_CLI_VERSION } from "./daytona/image";
import type {
  RunnerDeleteAgentResult,
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
}>;

export type ProductionRunnerRuntime = Readonly<{
  createOperatorService: () => Promise<RunnerService>;
  createSubscriberService: (
    session: SubscriberSession
  ) => Promise<RunnerService>;
}>;

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
    const [admission, credentials, sandbox] = await Promise.all([
      import("./admission"),
      import("@/lib/credentials/runner-credential"),
      import("./daytona/sandbox"),
    ]);
    const resolvedLimits = limits ?? admission.admissionLimitsFromEnvironment();
    return dispatchProductionClaim(claimed, {
      dispatch: (authorized, context) => {
        const credentialDependencies =
          credentials.drizzleRunnerCredentialDependencies(database);
        const dependencies = admission.daytonaRunnerDispatchDependencies({
          credentialDependencies,
          credentialInput: (run, agent) => ({
            ...context,
            harnessId: agent.runtime,
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

function registryHarnesses(): readonly HarnessStatus[] {
  return HARNESS_SPECS.map((spec) =>
    harnessStatus(spec, {
      installed: spec.id === "copilot",
      version: spec.id === "copilot" ? COPILOT_CLI_VERSION : null,
    })
  );
}

function productionReconcile(
  database: ProductionDatabase,
  store: RunnerStore,
  findAccount?: ProductionAccountFinder
): RunnerService["reconcileAndDispatch"] {
  return async () => {
    try {
      const [admission, client, credentials, errors, reconciliation, sandbox] =
        await Promise.all([
          import("./admission"),
          import("./daytona/client"),
          import("@/lib/credentials/runner-credential"),
          import("./errors"),
          import("./reconcile"),
          import("./daytona/sandbox"),
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
      return await reconciliation.reconcileAndDispatch({
        ...composition,
        dispatch: configuredDispatcher(database, store, daytona, findAccount),
      });
    } catch (error) {
      const { RunnerServiceError: RuntimeServiceError } = await import(
        "./errors"
      );
      if (error instanceof RuntimeServiceError) {
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
      dependencies.findAccount
    ),
    store,
    warmSandbox: async (principal, agent): Promise<RunnerWarmSandboxResult> => {
      try {
        const result = await sandbox.warmDaytonaSandbox(
          principal,
          agent,
          sandbox.daytonaSandboxConfiguration(),
          {
            daytona: client.daytonaClient(),
            probe: async (sandboxHandle) => {
              await process.probeDaytonaHarnesses(sandboxHandle);
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

const productionRunnerRuntime = createProductionRunnerRuntime();

export function createProductionRunnerService(session: SubscriberSession) {
  return productionRunnerRuntime.createSubscriberService(session);
}

export function createProductionRunnerOperatorService() {
  return productionRunnerRuntime.createOperatorService();
}
