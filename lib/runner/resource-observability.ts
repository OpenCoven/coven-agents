import "server-only";

/**
 * Operation labels and outcomes are intentionally finite and identifier-free
 * so they are safe for application telemetry and logs.
 */
export type RunnerResourceOperation =
  | "adopt"
  | "create"
  | "delete"
  | "inspect"
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
  | "refused"
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

/**
 * A machine-readable provider code, which the SDK sends in upper snake case.
 * Anything hyphenated or lower case is prose or an identifier rather than a
 * code, and this module promises to carry neither.
 */
const PROVIDER_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

/** The services the SDK stamps on a wire envelope. */
const PROVIDER_SOURCES = new Set([
  "DAYTONA_API",
  "DAYTONA_DAEMON",
  "DAYTONA_PROXY",
]);

function readProviderCode(value: unknown): string | undefined {
  return typeof value === "string" && PROVIDER_CODE.test(value)
    ? value
    : undefined;
}

function readProviderSource(value: unknown): string | undefined {
  return typeof value === "string" && PROVIDER_SOURCES.has(value)
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
  const code = readProviderCode(provider.code);
  const source = readProviderSource(provider.source);
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
