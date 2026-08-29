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
import { sessionAuthorityMatches } from "@/lib/auth/session-revocation";
import { periodStart } from "@/lib/billing/period";
import { drizzleRunnerCredentialDependencies } from "@/lib/credentials/runner-credential";
import { databaseFor } from "@/lib/db/access";
import { findUserById } from "@/lib/db/queries";
import type { SubscriberSession } from "@/lib/session";
import {
  admissionLimitsFromEnvironment,
  DEFAULT_DISPATCH_LEASE_MS,
  daytonaRunnerDispatchDependencies,
  dispatchRunnerClaim,
  type RunnerDispatchResult,
  terminalizeUnstartedDispatchFailure,
} from "./admission";
import { daytonaClient, daytonaClientForDeadline } from "./daytona/client";
import { COPILOT_CLI_VERSION } from "./daytona/image";
import { probeDaytonaHarnesses } from "./daytona/process";
import {
  daytonaSandboxConfiguration,
  deleteDaytonaSandbox,
  warmDaytonaSandbox,
} from "./daytona/sandbox";
import {
  cancelRunnerRun,
  daytonaRunnerCancellationDependencies,
  daytonaRunnerReconciliationDependencies,
  reconcileAndDispatch,
} from "./reconcile";
import {
  createRunnerService,
  type RunnerDeleteAgentResult,
  type RunnerDiagnosticResult,
  type RunnerPrewarmOptions,
  RunnerServiceError,
  type RunnerWarmSandboxResult,
} from "./service";
import {
  createRunnerStore,
  drizzleRunnerStoreDatabase,
  type RunnerStore,
} from "./store";
import type {
  RunnerClaimedDispatch,
  RunnerOperator,
  RunnerRunRecord,
} from "./types";

const OPERATOR: RunnerOperator = { kind: "runner-operator" };
const DIAGNOSTIC_TIMEOUT_SECONDS = 60;
const DIAGNOSTIC_EXECUTION_TIMEOUT_SECONDS = 30;

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

export type ProductionClaimDependencies = Readonly<{
  clock?: () => Date;
  dispatch: (
    claimed: RunnerClaimedDispatch,
    context: CredentialContext
  ) => Promise<RunnerDispatchResult>;
  environment?: Readonly<Record<string, string | undefined>>;
  findAccount?: (userId: string) => Promise<ProductionDispatchAccount | null>;
  operator: RunnerOperator;
  store: Pick<
    RunnerStore,
    "cleanupTerminalLease" | "finalizeRun" | "releaseUnstartedDispatch"
  >;
}>;

export type RunnerDiagnosticSandbox = Readonly<{
  delete: () => Promise<void>;
  execute: () => Promise<Readonly<{ exitCode: number; result: string | null }>>;
}>;

export type EphemeralDiagnosticDependencies = Readonly<{
  create: () => Promise<RunnerDiagnosticSandbox>;
}>;

function retryableServiceError(
  code: RunnerServiceError["code"],
  message: string,
  cause: unknown
): RunnerServiceError {
  return new RunnerServiceError(code, message, true, { cause });
}

function productionDatabase(
  principal: SubscriberSession | RunnerOperator
): ProductionDatabase {
  // Subscriber requests obtain the database only through their authenticated
  // session. Cron has a distinct secret-authenticated operator boundary.
  return databaseFor(principal);
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
  const account = await (dependencies.findAccount ?? findUserById)(userId);
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

function nextDispatchLease(): Readonly<{
  leaseExpiresAt: Date;
  leaseToken: string;
}> {
  return {
    leaseExpiresAt: new Date(Date.now() + DEFAULT_DISPATCH_LEASE_MS),
    leaseToken: randomBytes(32).toString("base64url"),
  };
}

function configuredDispatcher(
  database: ProductionDatabase,
  store: RunnerStore,
  daytona: Daytona
): () => Promise<RunnerDispatchResult> {
  return async () => {
    let claimed: RunnerClaimedDispatch | null;
    let limits: ReturnType<typeof admissionLimitsFromEnvironment>;
    try {
      limits = admissionLimitsFromEnvironment();
      claimed = await store.claimNextDispatch(OPERATOR, {
        ...nextDispatchLease(),
        limits,
      });
    } catch {
      return { kind: "unavailable", reason: "admission_unavailable" };
    }
    if (!claimed) {
      return { kind: "idle" };
    }

    return configuredClaimDispatcher(database, store, daytona, limits)(claimed);
  };
}

function configuredClaimDispatcher(
  database: ProductionDatabase,
  store: RunnerStore,
  daytona: Daytona,
  limits = admissionLimitsFromEnvironment()
): (claimed: RunnerClaimedDispatch) => Promise<RunnerDispatchResult> {
  return (claimed) =>
    dispatchProductionClaim(claimed, {
      dispatch: (authorized, context) => {
        const credentialDependencies =
          drizzleRunnerCredentialDependencies(database);
        const dependencies = daytonaRunnerDispatchDependencies({
          credentialDependencies,
          credentialInput: (run, agent) => ({
            ...context,
            harnessId: agent.runtime,
            operationId: run.operationId,
            runId: run.id,
            tenant: run.tenant,
          }),
          limits,
          operator: OPERATOR,
          sandboxConfiguration: daytonaSandboxConfiguration(),
          sandboxDependencies: { daytona },
          store,
        });
        return dispatchRunnerClaim(authorized, dependencies);
      },
      operator: OPERATOR,
      store,
    });
}

function registryHarnesses(): readonly HarnessStatus[] {
  return HARNESS_SPECS.map((spec) =>
    harnessStatus(spec, {
      installed: spec.id === "copilot",
      version: spec.id === "copilot" ? COPILOT_CLI_VERSION : null,
    })
  );
}

async function deleteDiagnosticSandbox(
  sandbox: RunnerDiagnosticSandbox
): Promise<void> {
  try {
    await sandbox.delete();
  } catch (error) {
    throw retryableServiceError(
      "diagnostic_unavailable",
      "Daytona diagnostic cleanup is unavailable.",
      error
    );
  }
}

function safeDiagnosticExitCode(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 && value <= 255 ? value : 1;
}

/**
 * Runs a fixed command in a disposable sandbox and guarantees an attempted
 * deletion after the sandbox was created. The provider boundary is injected so
 * cleanup behavior can be verified without a Daytona client.
 */
export async function runEphemeralDiagnostic(
  dependencies: EphemeralDiagnosticDependencies
): Promise<RunnerDiagnosticResult> {
  let sandbox: RunnerDiagnosticSandbox | undefined;
  let result: RunnerDiagnosticResult | undefined;

  try {
    sandbox = await dependencies.create();
    const command = await sandbox.execute();
    const exitCode = safeDiagnosticExitCode(command.exitCode);
    const output = command.result === "coven-agents" ? "coven-agents" : "";
    result = {
      exitCode,
      ok: exitCode === 0 && output === "coven-agents",
      output,
    };
  } catch (error) {
    if (sandbox) {
      await deleteDiagnosticSandbox(sandbox);
    }
    throw retryableServiceError(
      "diagnostic_unavailable",
      "Daytona diagnostic is unavailable.",
      error
    );
  }

  if (!sandbox || !result) {
    throw new RunnerServiceError(
      "diagnostic_unavailable",
      "Daytona diagnostic is unavailable."
    );
  }
  await deleteDiagnosticSandbox(sandbox);
  return result;
}

async function diagnoseDaytonaSandbox(): Promise<RunnerDiagnosticResult> {
  try {
    const configuration = daytonaSandboxConfiguration();
    return await runEphemeralDiagnostic({
      create: async () => {
        const sandbox = await daytonaClient().create(
          {
            autoArchiveInterval: 0,
            autoStopInterval: 0,
            ephemeral: true,
            name: `coven-diagnostic-${randomUUID().replaceAll("-", "")}`,
            networkBlockAll: true,
            public: false,
            snapshot: configuration.snapshotName,
            ttlMinutes: 5,
          },
          { timeout: DIAGNOSTIC_TIMEOUT_SECONDS }
        );
        return {
          delete: () => sandbox.delete(DIAGNOSTIC_TIMEOUT_SECONDS, true),
          execute: async () => {
            const command = await sandbox.process.executeCommand(
              "printf coven-agents",
              undefined,
              undefined,
              DIAGNOSTIC_EXECUTION_TIMEOUT_SECONDS
            );
            return {
              exitCode: command.exitCode,
              result: command.result ?? null,
            };
          },
        };
      },
    });
  } catch (error) {
    if (error instanceof RunnerServiceError) {
      throw error;
    }
    throw retryableServiceError(
      "diagnostic_unavailable",
      "Daytona diagnostic is unavailable.",
      error
    );
  }
}

function unreachableCredentialInput(_run: RunnerRunRecord): never {
  throw new RunnerServiceError(
    "reconcile_unavailable",
    "Reconciliation dispatch must resolve account credentials first."
  );
}

function productionReconcile(
  database: ProductionDatabase,
  store: RunnerStore
): () => Promise<Awaited<ReturnType<typeof reconcileAndDispatch>>> {
  return async () => {
    try {
      const daytona = daytonaClient();
      const credentialDependencies =
        drizzleRunnerCredentialDependencies(database);
      const composition = daytonaRunnerReconciliationDependencies({
        credentialDependencies,
        credentialInput: unreachableCredentialInput,
        daytona,
        limits: admissionLimitsFromEnvironment(),
        operator: OPERATOR,
        sandboxConfiguration: daytonaSandboxConfiguration(),
        store,
      });
      return await reconcileAndDispatch({
        ...composition,
        dispatch: configuredDispatcher(database, store, daytona),
      });
    } catch (error) {
      if (error instanceof RunnerServiceError) {
        throw error;
      }
      throw retryableServiceError(
        "reconcile_unavailable",
        "Runner reconciliation is unavailable.",
        error
      );
    }
  };
}

/**
 * Constructs request-scoped service adapters without calling the database or
 * Daytona. Provider/configuration resolution happens only in invoked methods.
 */
function createProductionRunnerServiceForPrincipal(
  databasePrincipal: SubscriberSession | RunnerOperator
) {
  const database = productionDatabase(databasePrincipal);
  const store = createRunnerStore(drizzleRunnerStoreDatabase(database));
  const credentialDependencies = drizzleRunnerCredentialDependencies(database);

  return createRunnerService({
    cancelRun: (runId) =>
      cancelRunnerRun(
        runId,
        daytonaRunnerCancellationDependencies({
          credentialDependencies,
          daytona: daytonaClient(),
          operator: OPERATOR,
          store,
        })
      ),
    deleteSandbox: async (
      principal,
      agentId
    ): Promise<RunnerDeleteAgentResult> => {
      try {
        const result = await deleteDaytonaSandbox(principal, agentId, {
          daytona: daytonaClient(),
          store,
        });
        if (result.kind === "failed") {
          return {
            error:
              result.error === "non_retryable" ? "non_retryable" : "retryable",
            kind: "failed",
          };
        }
        return result;
      } catch {
        return { error: "retryable", kind: "failed" };
      }
    },
    diagnoseSandbox: diagnoseDaytonaSandbox,
    dispatchClaim: (claimed) => {
      const daytona = daytonaClient();
      return configuredClaimDispatcher(database, store, daytona)(claimed);
    },
    listHarnesses: async () => registryHarnesses(),
    reconcileAndDispatch: productionReconcile(database, store),
    store,
    warmSandbox: async (
      principal,
      agent,
      options?: RunnerPrewarmOptions
    ): Promise<RunnerWarmSandboxResult> => {
      try {
        const daytona = options?.deadline
          ? daytonaClientForDeadline(options.deadline)
          : daytonaClient();
        const result = await warmDaytonaSandbox(
          principal,
          agent,
          daytonaSandboxConfiguration(),
          {
            daytona,
            lifecycle: {
              deadline: options?.deadline,
              signal: options?.signal,
            },
            probe: async (sandbox, signal, timeoutSeconds) => {
              await probeDaytonaHarnesses(sandbox, {
                deadline: options?.deadline,
                signal,
                sweepStaleSessions: true,
                timeoutSeconds,
              });
            },
            store,
          }
        );
        if (result.kind === "failed") {
          return {
            error:
              result.error === "non_retryable" ? "non_retryable" : "retryable",
            kind: "failed",
          };
        }
        return result;
      } catch {
        return { error: "retryable", kind: "failed" };
      }
    },
  });
}

export function createProductionRunnerService(session: SubscriberSession) {
  return createProductionRunnerServiceForPrincipal(session);
}

export function createProductionRunnerOperatorService() {
  return createProductionRunnerServiceForPrincipal(OPERATOR);
}
