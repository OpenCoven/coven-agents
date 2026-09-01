import "server-only";

import type {
  RunnerPersistentResourceLifecycle,
  RunnerResourceRecoveryResult,
} from "../resource-lifecycle";
import type { RunnerStore } from "../store";
import { deleteHermeticSandbox, warmHermeticSandbox } from "./sandbox";

const NO_RESOURCE_RECOVERY: RunnerResourceRecoveryResult = Object.freeze({
  deferred: 0,
  failures: 0,
  recovered: 0,
});

/**
 * Hermetic certification has no hosted provider resource. It retains the
 * durable per-agent fence while implementing the same product boundary.
 */
export function hermeticPersistentResourceLifecycle(
  store: RunnerStore
): RunnerPersistentResourceLifecycle {
  return {
    decommission: (principal, agentId) =>
      deleteHermeticSandbox(principal, agentId, store),
    prewarm: (principal, agent) => warmHermeticSandbox(principal, agent, store),
    recover: async () => NO_RESOURCE_RECOVERY,
    reset: async () => ({ kind: "provider_not_found" }),
  };
}
