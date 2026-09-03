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
 * the provider refused. These are the provider's own wire fields — a status
 * code, its machine-readable error code, and which service answered — so they
 * survive the minification that renames error classes in a production build.
 * Provider messages and bodies stay out because they carry sandbox names,
 * tenants, and occasionally credentials.
 */
export type RunnerResourceProviderSignal = Readonly<{
  providerCode?: string;
  providerSource?: string;
  providerStatus?: number;
}>;

export type RunnerResourceOperationObservation = Readonly<{
  operation: RunnerResourceOperation;
  outcome: RunnerResourceOperationOutcome;
}> &
  RunnerResourceProviderSignal;

const PROVIDER_WIRE_VALUE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;

function wireToken(value: unknown): string | undefined {
  return typeof value === "string" && PROVIDER_WIRE_VALUE.test(value)
    ? value
    : undefined;
}

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
  const provider = error as {
    code?: unknown;
    source?: unknown;
    statusCode?: unknown;
  };
  const code = wireToken(provider.code);
  const source = wireToken(provider.source);
  const status = provider.statusCode;
  return {
    ...(code === undefined ? {} : { providerCode: code }),
    ...(source === undefined ? {} : { providerSource: source }),
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
    ...(observation.providerCode === undefined
      ? {}
      : { providerCode: observation.providerCode }),
    ...(observation.providerSource === undefined
      ? {}
      : { providerSource: observation.providerSource }),
    ...(observation.providerStatus === undefined
      ? {}
      : { providerStatus: observation.providerStatus }),
  });
}
