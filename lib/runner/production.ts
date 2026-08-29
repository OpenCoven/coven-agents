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
import { periodStart } from "@/lib/billing/period";
import { drizzleRunnerCredentialDependencies } from "@/lib/credentials/runner-credential";
import { databaseFor } from "@/lib/db/access";
import { findUserById } from "@/lib/db/queries";
import type { SubscriberSession } from "@/lib/session";
import { isSubscribedAt } from "@/lib/subscription";
import {
  admissionLimitsFromEnvironment,
  DEFAULT_DISPATCH_LEASE_MS,
  daytonaRunnerDispatchDependencies,
  dispatchRunnerClaim,
  type RunnerDispatchResult,
} from "./admission";
import { daytonaClient } from "./daytona/client";
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

async function credentialContextForTenant(
  tenant: string
): Promise<CredentialContext | null> {
  const userId = userIdForTenant(tenant);
  if (!userId) {
    return null;
  }
  const account = await findUserById(userId);
  const now = new Date();
  if (!account || !isSubscribedAt(account, now)) {
    return null;
  }
  const currentPeriod = periodStart(
    account.subscribedUntil,
    account.billingPeriodStart
  );
  if (!currentPeriod) {
    return null;
  }
  try {
    return {
      globalDailyCap: globalDailyRunCapFromEnv(
        process.env.GLOBAL_DAILY_RUN_CAP
      ),
      keySecret: requireNonemptyAbuseKeySecret(process.env.ABUSE_KEY_SECRET),
      periodStart: currentPeriod,
    };
  } catch {
    return null;
  }
}

async function releaseUnstartedClaim(
  store: RunnerStore,
  claimed: RunnerClaimedDispatch
): Promise<RunnerDispatchResult> {
  try {
    const released = await store.releaseUnstartedDispatch(
      OPERATOR,
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

    let context: CredentialContext | null;
    try {
      context = await credentialContextForTenant(claimed.run.tenant);
    } catch {
      return releaseUnstartedClaim(store, claimed);
    }
    if (!context) {
      return releaseUnstartedClaim(store, claimed);
    }

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
    return dispatchRunnerClaim(claimed, dependencies);
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
    listHarnesses: async () => registryHarnesses(),
    reconcileAndDispatch: productionReconcile(database, store),
    store,
    warmSandbox: async (principal, agent): Promise<RunnerWarmSandboxResult> => {
      try {
        const result = await warmDaytonaSandbox(
          principal,
          agent,
          daytonaSandboxConfiguration(),
          {
            daytona: daytonaClient(),
            probe: async (sandbox) => {
              await probeDaytonaHarnesses(sandbox);
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
