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

/**
 * A provider rejection is only actionable if the operator can tell which call
 * the provider refused. The status code and the provider error class are
 * finite, identifier-free signals; provider messages and bodies stay out
 * because they carry sandbox names, tenants, and occasionally credentials.
 */
export type RunnerResourceProviderSignal = Readonly<{
  providerErrorName?: string;
  providerStatus?: number;
}>;

export type RunnerResourceOperationObservation = Readonly<{
  operation: RunnerResourceOperation;
  outcome: RunnerResourceOperationOutcome;
}> &
  RunnerResourceProviderSignal;

const PROVIDER_ERROR_NAME = /^[A-Za-z]{1,64}$/u;

/**
 * Reads the bounded provider signal from an unknown thrown value. Anything
 * unrecognized reports nothing rather than guessing.
 */
export function runnerResourceProviderSignal(
  error: unknown
): RunnerResourceProviderSignal {
  if (!(error instanceof Error)) {
    return {};
  }
  const name = PROVIDER_ERROR_NAME.test(error.name) ? error.name : undefined;
  const status = (error as { statusCode?: unknown }).statusCode;
  return {
    ...(name === undefined ? {} : { providerErrorName: name }),
    ...(typeof status === "number" && Number.isInteger(status)
      ? { providerStatus: status }
      : {}),
  };
}

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
    ...(observation.providerErrorName === undefined
      ? {}
      : { providerErrorName: observation.providerErrorName }),
    ...(observation.providerStatus === undefined
      ? {}
      : { providerStatus: observation.providerStatus }),
  });
}
