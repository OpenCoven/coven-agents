import "server-only";

import type {
  RunnerPersistentResourceLifecycle,
  RunnerResourceInventoryResult,
  RunnerResourceRecoveryResult,
  RunnerResourceRepairResult,
} from "../resource-lifecycle";
import {
  observeRunnerResourceOperation,
  type RunnerResourceOperationObserver,
} from "../resource-observability";
import type { RunnerStore } from "../store";
import { deleteHermeticSandbox, warmHermeticSandbox } from "./sandbox";

const NO_RESOURCE_RECOVERY: RunnerResourceRecoveryResult = Object.freeze({
  deferred: 0,
  failures: 0,
  recovered: 0,
});
const NO_HOSTED_RESOURCE_STATES = Object.freeze({
  active: 0,
  archived: 0,
  other: 0,
  stopped: 0,
});
const NO_HOSTED_RESOURCE_INVENTORY: RunnerResourceInventoryResult =
  Object.freeze({
    ambiguityReasons: {
      configurationDrift: 0,
      databaseBounded: 0,
      duplicateIdentity: 0,
      duplicateProviderId: 0,
      multipleMappings: 0,
      pendingLifecycle: 0,
      unresolved: 0,
    },
    ambiguous: 0,
    appOwnedMappings: 0,
    configurationDrift: [],
    databaseCapped: false,
    examined: 0,
    kind: "available",
    matched: 0,
    providerCapped: false,
    states: NO_HOSTED_RESOURCE_STATES,
    status: "complete",
    unowned: 0,
    version: 1,
  });
const NO_HOSTED_RESOURCE_REPAIR: RunnerResourceRepairResult = Object.freeze({
  appOwnedMappings: 0,
  batchCapped: false,
  databaseCapped: false,
  deferred: 0,
  eligible: 0,
  examined: 0,
  failures: 0,
  kind: "available",
  providerCapped: false,
  refused: 0,
  repaired: 0,
  status: "complete",
  unchanged: 0,
  version: 1,
});

/**
 * Hermetic certification has no hosted provider resource. It retains the
 * durable per-agent fence while implementing the same product boundary.
 */
export function hermeticPersistentResourceLifecycle(
  store: RunnerStore,
  observe?: RunnerResourceOperationObserver
): RunnerPersistentResourceLifecycle {
  return {
    decommission: async (principal, agentId) => {
      const result = await deleteHermeticSandbox(principal, agentId, store);
      observeRunnerResourceOperation(observe, {
        operation: "delete",
        outcome: result.kind,
      });
      return result;
    },
    // Hermetic certification has no provider sandbox to observe.
    inspect: () => {
      observeRunnerResourceOperation(observe, {
        operation: "inspect",
        outcome: "unavailable",
      });
      return Promise.resolve({
        outcome: "unavailable" as const,
        source: "provider" as const,
        version: 1 as const,
      });
    },
    inventory: () => {
      observeRunnerResourceOperation(observe, {
        operation: "inventory",
        outcome: "ready",
      });
      return Promise.resolve(NO_HOSTED_RESOURCE_INVENTORY);
    },
    prewarm: async (principal, agent) => {
      const result = await warmHermeticSandbox(principal, agent, store);
      if (agent.daytonaSandboxId === null) {
        observeRunnerResourceOperation(observe, {
          operation: "create",
          outcome: result.kind,
        });
      }
      observeRunnerResourceOperation(observe, {
        operation: "warm",
        outcome: result.kind,
      });
      return result;
    },
    recover: () => {
      observeRunnerResourceOperation(observe, {
        operation: "recover",
        outcome: "ready",
      });
      return Promise.resolve(NO_RESOURCE_RECOVERY);
    },
    repair: () => {
      observeRunnerResourceOperation(observe, {
        operation: "repair",
        outcome: "ready",
      });
      return Promise.resolve(NO_HOSTED_RESOURCE_REPAIR);
    },
    reset: () => {
      observeRunnerResourceOperation(observe, {
        operation: "reset",
        outcome: "not_found",
      });
      return Promise.resolve({ kind: "provider_not_found" as const });
    },
  };
}
