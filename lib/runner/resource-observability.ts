import "server-only";

/**
 * Operation labels and outcomes are intentionally finite and identifier-free
 * so they are safe for application telemetry and logs.
 */
export type RunnerResourceOperation =
  | "create"
  | "delete"
  | "inventory"
  | "repair"
  | "recover"
  | "reset"
  | "warm";

export type RunnerResourceOperationOutcome =
  | "ambiguous"
  | "busy"
  | "created"
  | "deferred"
  | "deleted"
  | "failed"
  | "in_progress"
  | "not_found"
  | "provider_rejected"
  | "ready"
  | "recovered"
  | "repaired"
  | "reset"
  | "stale_version"
  | "unavailable";

export type RunnerResourceOperationObservation = Readonly<{
  operation: RunnerResourceOperation;
  outcome: RunnerResourceOperationOutcome;
}>;

export type RunnerResourceOperationObserver = (
  observation: RunnerResourceOperationObservation
) => void;

export function observeRunnerResourceOperation(
  observer: RunnerResourceOperationObserver | undefined,
  observation: RunnerResourceOperationObservation
): void {
  observer?.({
    operation: observation.operation,
    outcome: observation.outcome,
  });
}
