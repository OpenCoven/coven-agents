import "server-only";

import type {
  RunnerAgentRecord,
  RunnerDispatchAuthority,
  RunnerPrincipal,
  RunnerRunRecord,
} from "./types";

export const DEFAULT_RUNNER_RESOURCE_INVENTORY_LIMIT = 50;
export const MAX_RUNNER_RESOURCE_INVENTORY_LIMIT = 100;

export type RunnerResourceConfigurationDriftField =
  | "autoArchiveInterval"
  | "autoDeleteInterval"
  | "autoDestroyAt"
  | "autoPauseInterval"
  | "autoStopInterval"
  | "cpu"
  | "disk"
  | "domainAllowList"
  | "labels"
  | "linkedSandbox"
  | "memory"
  | "name"
  | "public"
  | "snapshot"
  | "target"
  | "volumes"
  | "warmPool";
export type RunnerResourceConfigurationDriftRelation =
  | "above"
  | "below"
  | "different";

export type RunnerResourceInventoryResult =
  | Readonly<{
      appOwnedMappings: number;
      ambiguityReasons: Readonly<{
        configurationDrift: number;
        databaseBounded: number;
        duplicateIdentity: number;
        duplicateProviderId: number;
        multipleMappings: number;
        pendingLifecycle: number;
        unresolved: number;
      }>;
      configurationDrift: readonly Readonly<{
        count: number;
        field: RunnerResourceConfigurationDriftField;
        relation: RunnerResourceConfigurationDriftRelation;
      }>[];
      databaseCapped: boolean;
      examined: number;
      kind: "available";
      matched: number;
      providerCapped: boolean;
      status: "bounded" | "complete";
      states: Readonly<{
        active: number;
        archived: number;
        other: number;
        stopped: number;
      }>;
      unowned: number;
      ambiguous: number;
      version: 1;
    }>
  | Readonly<{
      kind: "unavailable";
      source: "database" | "provider";
      version: 1;
    }>;

export function runnerResourceInventoryLimit(limit?: number): number {
  const selected = limit ?? DEFAULT_RUNNER_RESOURCE_INVENTORY_LIMIT;
  if (
    !Number.isSafeInteger(selected) ||
    selected < 1 ||
    selected > MAX_RUNNER_RESOURCE_INVENTORY_LIMIT
  ) {
    throw new Error(
      `Resource inventory limit must be an integer between 1 and ${MAX_RUNNER_RESOURCE_INVENTORY_LIMIT}.`
    );
  }
  return selected;
}

/**
 * Server-only contract for the persistent resource owned by one agent. The
 * provider keeps its resource identifiers, SDK handles, and configuration
 * behind this boundary.
 */
export type RunnerPersistentResourceLifecycle = Readonly<{
  decommission: (
    principal: RunnerPrincipal,
    agentId: string
  ) => Promise<RunnerResourceDecommissionResult>;
  inventory: () => Promise<RunnerResourceInventoryResult>;
  prewarm: (
    principal: RunnerPrincipal,
    agent: RunnerAgentRecord,
    options?: RunnerResourcePrewarmOptions
  ) => Promise<RunnerResourcePrewarmResult>;
  recover: (clock: () => Date) => Promise<RunnerResourceRecoveryResult>;
  reset: (
    run: RunnerRunRecord,
    authority: RunnerDispatchAuthority
  ) => Promise<RunnerResourceResetResult>;
}>;

export type RunnerResourcePrewarmOptions = Readonly<{
  deadline?: number;
  signal?: AbortSignal;
}>;

export type RunnerResourceDecommissionResult =
  | Readonly<{ kind: "deleted" }>
  | Readonly<{ kind: "busy" }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "stale_version" }>
  | Readonly<{
      kind: "unavailable";
      source: "database" | "provider";
    }>
  | Readonly<{ kind: "provider_rejected" }>;

export type RunnerResourcePrewarmResult =
  | Readonly<{ agent: RunnerAgentRecord; kind: "ready" }>
  | Readonly<{ agent: RunnerAgentRecord; kind: "in_progress" }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "stale_version" }>
  | Readonly<{
      kind: "unavailable";
      source: "database" | "provider";
    }>
  | Readonly<{ kind: "provider_rejected" }>;

export type RunnerResourceRecoveryResult = Readonly<{
  deferred: number;
  failures: number;
  recovered: number;
}>;

export type RunnerResourceResetResult =
  | Readonly<{ kind: "provider_not_found" | "reset" }>
  | Readonly<{
      kind:
        | "in_progress"
        | "not_found"
        | "sandbox_reset_required"
        | "stale_version";
    }>
  | Readonly<{
      kind: "unavailable";
      source: "database" | "provider";
    }>;
