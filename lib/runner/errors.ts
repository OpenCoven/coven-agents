import "server-only";

export type RunnerServiceErrorCode =
  | "diagnostic_unavailable"
  | "reconcile_unavailable"
  | "service_unavailable";

/**
 * A deliberately message-safe error for adapters whose original failure can
 * contain a provider URL, credential, or database detail.
 */
export class RunnerServiceError extends Error {
  readonly code: RunnerServiceErrorCode;
  readonly retryable: boolean;

  constructor(
    code: RunnerServiceErrorCode,
    message: string,
    retryable = true,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.code = code;
    this.name = "RunnerServiceError";
    this.retryable = retryable;
  }
}
