import "server-only";

import type { Sandbox } from "@daytona/sdk";
import type { RunnerStore } from "../store";
import type { RunnerAgentRecord, RunnerOperator } from "../types";
import { daytonaProbeSessionName, daytonaSandboxName } from "./names";
import {
  cleanupDaytonaProbeSession,
  type DaytonaProcessSandbox,
} from "./process";
import {
  assertReplacementSnapshotReady,
  classifyDaytonaProviderError,
  type DaytonaSandboxConfiguration,
  type DaytonaSandboxService,
  daytonaSandboxProvisioningIdentityMatches,
  SANDBOX_PROVISIONING_TIMEOUT_MS,
  SANDBOX_WARM_TIMEOUT_MS,
} from "./sandbox";

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_PROVIDER_CONCURRENCY = 4;

/**
 * Deferred provider-specific scope: warm, provision, and decommission sandbox
 * recovery remains Daytona-owned here. Attempt reconciliation is in
 * attempt-reconcile.ts and has no Daytona dependency.
 */

type SandboxRecoveryStore = Pick<
  RunnerStore,
  | "attachDaytonaSandboxForRecovery"
  | "beginDaytonaSandboxResetForRecovery"
  | "deleteDecommissionedAgentForRecovery"
  | "finishDaytonaSandboxWarmForRecovery"
  | "finishDaytonaSandboxResetForRecovery"
  | "resetDaytonaSandboxRecovery"
  | "scanDaytonaSandboxRecoveries"
  | "scanDaytonaWarmRecoveries"
>;

export type ReconcileDaytonaSandboxesDependencies = Readonly<{
  batchSize?: number;
  clock?: () => Date;
  daytona: DaytonaSandboxService;
  operator: RunnerOperator;
  providerConcurrency?: number;
  provisioningStaleBefore?: Date;
  sandboxConfiguration: DaytonaSandboxConfiguration;
  store: SandboxRecoveryStore;
  warmStaleBefore?: Date;
}>;

export type DaytonaSandboxReconciliationResult = Readonly<{
  deferred: number;
  failures: number;
  recovered: number;
}>;

function boundedInteger(
  value: number | undefined,
  fallback: number,
  name: string,
  maximum = 100
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return selected;
}

async function mapBounded<T, Result>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<Result>
): Promise<Result[]> {
  const results: Result[] = [];
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      // biome-ignore lint/performance/noAwaitInLoops: Each bounded worker serializes its assigned provider operation.
      results[index] = await operation(values[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker())
  );
  return results;
}

type SandboxRecoveryOutcome = "deferred" | "failed" | "recovered";

function classifySandboxRecoveryFailure(
  error: unknown
): SandboxRecoveryOutcome {
  return classifyDaytonaProviderError(error) === "non_retryable"
    ? "failed"
    : "deferred";
}

async function findSandboxForRecovery(
  agent: RunnerAgentRecord,
  daytona: DaytonaSandboxService
): Promise<Sandbox | null> {
  const identifiers = [
    ...(agent.daytonaSandboxId ? [agent.daytonaSandboxId] : []),
    daytonaSandboxName(agent.tenant, agent.id),
  ];
  for (const identifier of new Set(identifiers)) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Deterministic IDs are checked in priority order.
      return await daytona.get(identifier);
    } catch (error) {
      if (classifyDaytonaProviderError(error) !== "not_found") {
        throw error;
      }
    }
  }
  return null;
}

async function recoverSandbox(
  agent: RunnerAgentRecord,
  dependencies: ReconcileDaytonaSandboxesDependencies,
  provisioningStaleBefore: Date,
  warmStaleBefore: Date
): Promise<SandboxRecoveryOutcome> {
  const fence = {
    agentId: agent.id,
    expectedGeneration: agent.sandboxGeneration,
    expectedVersion: agent.version,
  };
  if (
    agent.sandboxLifecycle === "ready" &&
    agent.warmStatus === "provisioning"
  ) {
    if (agent.warmUpdatedAt > warmStaleBefore) {
      return "deferred";
    }
    let sandbox: Sandbox | null;
    try {
      sandbox = await findSandboxForRecovery(agent, dependencies.daytona);
      if (sandbox) {
        await cleanupDaytonaProbeSession(
          sandbox as unknown as DaytonaProcessSandbox,
          daytonaProbeSessionName(
            agent.id,
            agent.sandboxGeneration,
            agent.warmAttemptVersion,
            agent.warmUpdatedAt
          )
        );
      }
    } catch {
      return "deferred";
    }
    try {
      const finished =
        await dependencies.store.finishDaytonaSandboxWarmForRecovery(
          dependencies.operator,
          fence
        );
      return finished.kind === "updated" ? "recovered" : "deferred";
    } catch {
      return "deferred";
    }
  }
  if (
    agent.sandboxLifecycle === "provisioning" &&
    agent.sandboxUpdatedAt > provisioningStaleBefore
  ) {
    return "deferred";
  }
  if (
    agent.sandboxLifecycle === "provisioning" ||
    agent.sandboxLifecycle === "provisioning_ambiguous"
  ) {
    let sandbox: Sandbox | null;
    try {
      sandbox = await findSandboxForRecovery(agent, dependencies.daytona);
    } catch (error) {
      return classifySandboxRecoveryFailure(error);
    }
    if (
      sandbox &&
      !daytonaSandboxProvisioningIdentityMatches(
        sandbox,
        agent,
        dependencies.sandboxConfiguration
      )
    ) {
      // This branch replaces a workspace whose provisioning identity no longer
      // matches, which after a configurationId change is every sandbox in the
      // fleet. It deletes before recreating, so it needs the same proof the
      // foreground reprovision needs: guarding only the `resetting` branch
      // left the identical defect live one branch over.
      try {
        await assertReplacementSnapshotReady(
          dependencies.sandboxConfiguration,
          { daytona: dependencies.daytona }
        );
      } catch (error) {
        return classifySandboxRecoveryFailure(error);
      }
      const resetting =
        await dependencies.store.beginDaytonaSandboxResetForRecovery(
          dependencies.operator,
          fence
        );
      if (resetting.kind !== "updated") {
        return "deferred";
      }
      try {
        await sandbox.delete(60, true);
      } catch (error) {
        if (classifyDaytonaProviderError(error) !== "not_found") {
          return classifySandboxRecoveryFailure(error);
        }
      }
      const reset =
        await dependencies.store.finishDaytonaSandboxResetForRecovery(
          dependencies.operator,
          {
            agentId: resetting.value.id,
            expectedGeneration: resetting.value.sandboxGeneration,
            expectedVersion: resetting.value.version,
          }
        );
      return reset.kind === "updated" ? "recovered" : "deferred";
    }
    const persisted = sandbox
      ? await dependencies.store.attachDaytonaSandboxForRecovery(
          dependencies.operator,
          { ...fence, sandboxId: sandbox.id }
        )
      : await dependencies.store.resetDaytonaSandboxRecovery(
          dependencies.operator,
          fence
        );
    return persisted.kind === "updated" ? "recovered" : "deferred";
  }
  if (agent.sandboxLifecycle === "resetting") {
    // A row reaches `resetting` because a reprovision decided to replace the
    // workspace, but this scanner finishes that decision on a later tick and
    // in a different process. Re-prove the replacement here rather than trust
    // the earlier decision: the snapshot can be deleted, fail its build, or
    // be repointed between the two. Deferring leaves the row stuck and
    // visible, which is strictly better than deleting a workspace that
    // nothing can rebuild.
    try {
      await assertReplacementSnapshotReady(dependencies.sandboxConfiguration, {
        daytona: dependencies.daytona,
      });
    } catch (error) {
      // Same reasoning as the identity-mismatch branch: "deferred" cannot be
      // told apart from "not yet stale", and the batch summary reports
      // "recovered" whenever any other row succeeds, so a fleet wedged behind
      // an unbuildable snapshot would look healthy on every tick.
      return classifySandboxRecoveryFailure(error);
    }
    let sandbox: Sandbox | null;
    try {
      sandbox = await findSandboxForRecovery(agent, dependencies.daytona);
    } catch (error) {
      return classifySandboxRecoveryFailure(error);
    }
    if (sandbox) {
      try {
        await sandbox.delete(60, true);
      } catch (error) {
        if (classifyDaytonaProviderError(error) !== "not_found") {
          return classifySandboxRecoveryFailure(error);
        }
      }
    }
    const reset = await dependencies.store.finishDaytonaSandboxResetForRecovery(
      dependencies.operator,
      fence
    );
    return reset.kind === "updated" ? "recovered" : "deferred";
  }
  if (agent.sandboxLifecycle !== "decommissioning") {
    return "deferred";
  }
  let sandbox: Sandbox | null;
  try {
    sandbox = await findSandboxForRecovery(agent, dependencies.daytona);
  } catch (error) {
    return classifySandboxRecoveryFailure(error);
  }
  if (sandbox) {
    try {
      await sandbox.delete(60, true);
    } catch (error) {
      if (classifyDaytonaProviderError(error) !== "not_found") {
        return classifySandboxRecoveryFailure(error);
      }
    }
  }
  const deleted = await dependencies.store.deleteDecommissionedAgentForRecovery(
    dependencies.operator,
    fence
  );
  return deleted.kind === "deleted" ? "recovered" : "deferred";
}

/**
 * Reconciles stale/ambiguous persistent sandbox lifecycle rows without
 * creating resources speculatively. All persistence is version/generation
 * fenced, so another lifecycle actor can safely win a race.
 */
export async function reconcileDaytonaSandboxes(
  dependencies: ReconcileDaytonaSandboxesDependencies
): Promise<DaytonaSandboxReconciliationResult> {
  const batchSize = boundedInteger(
    dependencies.batchSize,
    DEFAULT_BATCH_SIZE,
    "Sandbox reconciliation batch size"
  );
  const providerConcurrency = boundedInteger(
    dependencies.providerConcurrency,
    DEFAULT_PROVIDER_CONCURRENCY,
    "Sandbox provider concurrency",
    16
  );
  const clock = dependencies.clock ?? (() => new Date());
  const provisioningStaleBefore =
    dependencies.provisioningStaleBefore ??
    new Date(clock().getTime() - SANDBOX_PROVISIONING_TIMEOUT_MS);
  const warmStaleBefore =
    dependencies.warmStaleBefore ??
    new Date(clock().getTime() - SANDBOX_WARM_TIMEOUT_MS);
  let failures = 0;
  let agents: RunnerAgentRecord[] = [];
  try {
    agents = await dependencies.store.scanDaytonaSandboxRecoveries(
      dependencies.operator,
      batchSize
    );
  } catch {
    failures += 1;
  }
  let warmAgents: RunnerAgentRecord[] = [];
  try {
    warmAgents = await dependencies.store.scanDaytonaWarmRecoveries(
      dependencies.operator,
      warmStaleBefore,
      batchSize
    );
  } catch {
    failures += 1;
  }
  const recover = async (agent: RunnerAgentRecord) => {
    try {
      return await recoverSandbox(
        agent,
        dependencies,
        provisioningStaleBefore,
        warmStaleBefore
      );
    } catch {
      return "failed" as const;
    }
  };
  const [lifecycleOutcomes, warmOutcomes] = await Promise.all([
    mapBounded(agents, providerConcurrency, recover),
    mapBounded(warmAgents, providerConcurrency, recover),
  ]);
  const outcomes = [...lifecycleOutcomes, ...warmOutcomes];
  return outcomes.reduce<DaytonaSandboxReconciliationResult>(
    (result, outcome) => ({
      deferred: result.deferred + (outcome === "deferred" ? 1 : 0),
      failures: result.failures + (outcome === "failed" ? 1 : 0),
      recovered: result.recovered + (outcome === "recovered" ? 1 : 0),
    }),
    { deferred: 0, failures, recovered: 0 }
  );
}
