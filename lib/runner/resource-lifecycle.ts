import "server-only";

import type {
  RunnerAgentRecord,
  RunnerDispatchAuthority,
  RunnerPrincipal,
  RunnerRunRecord,
} from "./types";

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
