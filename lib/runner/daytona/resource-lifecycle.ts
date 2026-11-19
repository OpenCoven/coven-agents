import "server-only";

import type { Sandbox } from "@daytona/sdk";
import type {
  RunnerPersistentResourceLifecycle,
  RunnerResourceDecommissionResult,
  RunnerResourcePrewarmOptions,
  RunnerResourcePrewarmResult,
  RunnerResourceRepairOptions,
  RunnerResourceRepairResult,
} from "../resource-lifecycle";
import {
  observeRunnerResourceOperation,
  type RunnerResourceOperationObserver,
} from "../resource-observability";
import type { RunnerStore } from "../store";
import type { RunnerOperator } from "../types";
import { probeDaytonaHarnesses } from "./process";
import { inspectDaytonaSandbox } from "./resource-inspection";
import {
  type DaytonaSandboxInventoryService,
  inventoryDaytonaSandboxes,
} from "./resource-inventory";
import { reconcileDaytonaSandboxes } from "./resource-recovery";
import {
  type DaytonaSandboxRepairService,
  repairDaytonaSandboxResourceFloors,
} from "./resource-repair";
import {
  type DaytonaSandboxConfiguration,
  type DaytonaSandboxLifecycleDependencies,
  type DaytonaSandboxService,
  deleteDaytonaSandbox,
  resetDaytonaSandboxForCancellation,
  warmDaytonaSandbox,
} from "./sandbox";

export type DaytonaPersistentResourceLifecycleDependencies = Readonly<{
  batchSize?: number;
  configuration: () => DaytonaSandboxConfiguration;
  daytona: (options?: RunnerResourcePrewarmOptions) => DaytonaSandboxService;
  inventoryDaytona: () => DaytonaSandboxInventoryService;
  repairDaytona: (
    options?: RunnerResourceRepairOptions
  ) => DaytonaSandboxRepairService;
  lifecycle?: DaytonaSandboxLifecycleDependencies;
  observe?: RunnerResourceOperationObserver;
  operator: RunnerOperator;
  probe?: (
    sandbox: Sandbox,
    signal?: AbortSignal,
    timeoutSeconds?: number,
    sessionId?: string
  ) => Promise<void>;
  providerConcurrency?: number;
  store: RunnerStore;
}>;

/**
 * Maps Daytona's persistent sandbox implementation to the product lifecycle.
 * The underlying provisioning, recovery, deletion, and reset algorithms stay
 * in their existing Daytona modules and preserve their durable fences.
 */
export function daytonaPersistentResourceLifecycle(
  dependencies: DaytonaPersistentResourceLifecycleDependencies
): RunnerPersistentResourceLifecycle {
  return {
    decommission: async (principal, agentId) => {
      let output: RunnerResourceDecommissionResult;
      try {
        const result = await deleteDaytonaSandbox(principal, agentId, {
          daytona: dependencies.daytona(),
          observe: dependencies.observe,
          store: dependencies.store,
        });
        output =
          result.kind === "failed"
            ? result.error === "non_retryable"
              ? { kind: "provider_rejected" as const }
              : {
                  kind: "unavailable" as const,
                  source: "provider" as const,
                }
            : result;
      } catch {
        output = { kind: "unavailable" as const, source: "database" as const };
      }
      observeRunnerResourceOperation(dependencies.observe, {
        operation: "delete",
        outcome: output.kind,
      });
      return output;
    },
    inspect: async (principal, agentId, expected) => {
      const result = await inspectDaytonaSandbox(principal, agentId, expected, {
        configuration: dependencies.configuration,
        // The read-only inventory client: inspection only ever calls `get`.
        daytona: dependencies.inventoryDaytona,
        store: dependencies.store,
      });
      observeRunnerResourceOperation(dependencies.observe, {
        operation: "inspect",
        outcome:
          result.outcome === "observed"
            ? "ready"
            : result.outcome === "not_found"
              ? "not_found"
              : result.outcome === "unavailable"
                ? "unavailable"
                : result.outcome === "ambiguous"
                  ? "ambiguous"
                  : "refused",
      });
      return result;
    },
    inventory: async () => {
      const result = await inventoryDaytonaSandboxes({
        configuration: dependencies.configuration(),
        daytona: dependencies.inventoryDaytona(),
        operator: dependencies.operator,
        store: dependencies.store,
      });
      observeRunnerResourceOperation(dependencies.observe, {
        operation: "inventory",
        outcome:
          result.kind === "unavailable"
            ? "unavailable"
            : result.status === "complete"
              ? "ready"
              : "deferred",
      });
      return result;
    },
    prewarm: async (principal, agent, options) => {
      let output: RunnerResourcePrewarmResult;
      try {
        const result = await warmDaytonaSandbox(
          principal,
          agent,
          dependencies.configuration(),
          {
            daytona: dependencies.daytona(options),
            lifecycle: {
              ...dependencies.lifecycle,
              deadline: options?.deadline,
              signal: options?.signal,
            },
            observe: dependencies.observe,
            probe:
              dependencies.probe ??
              ((sandbox, signal, timeoutSeconds, sessionId) =>
                probeDaytonaHarnesses(sandbox as never, {
                  deadline: options?.deadline,
                  sessionId,
                  signal,
                  timeoutSeconds,
                }).then(() => undefined)),
            store: dependencies.store,
          }
        );
        output =
          result.kind === "failed"
            ? result.error === "non_retryable"
              ? { kind: "provider_rejected" as const }
              : {
                  kind: "unavailable" as const,
                  source: "provider" as const,
                }
            : result;
      } catch {
        output = { kind: "unavailable" as const, source: "database" as const };
      }
      observeRunnerResourceOperation(dependencies.observe, {
        operation: "warm",
        outcome: output.kind,
      });
      return output;
    },
    recover: async (clock) => {
      const result = await reconcileDaytonaSandboxes({
        batchSize: dependencies.batchSize,
        clock,
        daytona: dependencies.daytona(),
        operator: dependencies.operator,
        providerConcurrency: dependencies.providerConcurrency,
        sandboxConfiguration: dependencies.configuration(),
        store: dependencies.store,
      });
      observeRunnerResourceOperation(dependencies.observe, {
        operation: "recover",
        outcome:
          result.failures > 0
            ? "failed"
            : result.recovered > 0
              ? "recovered"
              : result.deferred > 0
                ? "deferred"
                : "ready",
      });
      return result;
    },
    repair: async (options) => {
      const result: RunnerResourceRepairResult =
        await repairDaytonaSandboxResourceFloors({
          configuration: dependencies.configuration(),
          daytona: dependencies.repairDaytona(options),
          deadline: options?.deadline,
          operator: dependencies.operator,
          store: dependencies.store,
        });
      observeRunnerResourceOperation(dependencies.observe, {
        operation: "repair",
        outcome:
          result.kind === "unavailable"
            ? "unavailable"
            : result.failures > 0
              ? "failed"
              : result.deferred > 0
                ? "deferred"
                : result.repaired > 0
                  ? "repaired"
                  : "ready",
      });
      return result;
    },
    reset: async (_run, authority) => {
      const output = await resetDaytonaSandboxForCancellation(
        dependencies.operator,
        authority,
        dependencies.configuration(),
        {
          daytona: dependencies.daytona(),
          lifecycle: dependencies.lifecycle,
          observe: dependencies.observe,
          store: dependencies.store,
        }
      );
      observeRunnerResourceOperation(dependencies.observe, {
        operation: "reset",
        outcome:
          output.kind === "provider_not_found"
            ? "not_found"
            : output.kind === "sandbox_reset_required"
              ? "failed"
              : output.kind,
      });
      return output;
    },
  };
}
