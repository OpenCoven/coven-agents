import "server-only";

import type { Sandbox } from "@daytona/sdk";
import type {
  RunnerPersistentResourceLifecycle,
  RunnerResourcePrewarmOptions,
} from "../resource-lifecycle";
import type { RunnerStore } from "../store";
import type { RunnerOperator } from "../types";
import { probeDaytonaHarnesses } from "./process";
import { reconcileDaytonaSandboxes } from "./resource-recovery";
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
  lifecycle?: DaytonaSandboxLifecycleDependencies;
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
      try {
        const result = await deleteDaytonaSandbox(principal, agentId, {
          daytona: dependencies.daytona(),
          store: dependencies.store,
        });
        if (result.kind !== "failed") {
          return result;
        }
        return result.error === "non_retryable"
          ? { kind: "provider_rejected" as const }
          : { kind: "unavailable" as const, source: "provider" as const };
      } catch {
        return { kind: "unavailable", source: "database" };
      }
    },
    prewarm: async (principal, agent, options) => {
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
        if (result.kind !== "failed") {
          return result;
        }
        return result.error === "non_retryable"
          ? { kind: "provider_rejected" as const }
          : { kind: "unavailable" as const, source: "provider" as const };
      } catch {
        return { kind: "unavailable", source: "database" };
      }
    },
    recover: (clock) =>
      reconcileDaytonaSandboxes({
        batchSize: dependencies.batchSize,
        clock,
        daytona: dependencies.daytona(),
        operator: dependencies.operator,
        providerConcurrency: dependencies.providerConcurrency,
        store: dependencies.store,
      }),
    reset: (_run, authority) =>
      resetDaytonaSandboxForCancellation(dependencies.operator, authority, {
        daytona: dependencies.daytona(),
        lifecycle: dependencies.lifecycle,
        store: dependencies.store,
      }),
  };
}
