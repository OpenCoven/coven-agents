export type ConnectionStatus =
  | { endpoint: string; kind: "provisioned"; token: string }
  | { kind: "rate_limited"; retryAfterSeconds: number }
  | { kind: "signed_out" }
  | { kind: "subscription_required" }
  | { kind: "unavailable" }
  | { kind: "unconfigured" };

export type ConnectionStatusKind = ConnectionStatus["kind"];

/**
 * Interprets a `/api/runner-connection` response.
 *
 * Exists because the console used to treat every non-OK response as "no
 * connection", fall back to whatever endpoint was in session storage, and let
 * the resulting request fail on its own terms. A demo session therefore learned
 * it lacked a subscription by being told `Runner request failed (404)` — a
 * message that named neither the cause nor the fix.
 *
 * A 200 is only provisioned when it actually carries both halves. An empty
 * token would be sent as `x-runner-token: ""`, which a worker whose own
 * `AGENT_CONTROL_TOKEN` is unset compares equal and accepts; an empty endpoint
 * makes the client build a same-origin URL, which is precisely how a runner
 * call became a 404 against the app itself.
 */
const DEFAULT_RETRY_AFTER_SECONDS = 60;

export function readConnectionResponse(
  status: number,
  body: Readonly<Record<string, unknown>> | null,
  retryAfterHeader?: string | null
): ConnectionStatus {
  if (status === 401) {
    return { kind: "signed_out" };
  }
  if (status === 403) {
    return { kind: "subscription_required" };
  }
  /**
   * The admission layer's refusal, not the runner's absence.
   *
   * Before this branch existed, a 429 fell through to `unavailable` and the
   * console answered a rate limit with "use Connect to set one manually" — a
   * prompt for a deployment token that could not have helped, on a refusal
   * that expires on its own. The one number that makes the state actionable
   * travels in the `retry-after` header, so it is carried into the status.
   */
  if (status === 429) {
    const parsed = Number(retryAfterHeader);
    return {
      kind: "rate_limited",
      retryAfterSeconds:
        Number.isFinite(parsed) && parsed > 0
          ? Math.ceil(parsed)
          : DEFAULT_RETRY_AFTER_SECONDS,
    };
  }
  if (status === 503) {
    /**
     * Two different 503s share this endpoint since the admission layer was
     * added in front of it. The route's own means "this deployment has no
     * runner" and is permanent until an operator acts; the admission layer's
     * means its backing store is having a moment and the right response is to
     * retry, not to paste a token. Only the route's own body may claim
     * unconfigured.
     */
    return body?.error === "runner_unconfigured"
      ? { kind: "unconfigured" }
      : { kind: "unavailable" };
  }

  if (status === 200) {
    const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
    const token = typeof body?.token === "string" ? body.token : "";

    if (endpoint && token) {
      return { endpoint, kind: "provisioned", token };
    }
  }

  return { kind: "unavailable" };
}

const MESSAGES: Record<Exclude<ConnectionStatusKind, "provisioned">, string> = {
  rate_limited:
    "Rate limited — the connection will be retried automatically. No token is needed.",
  signed_out: "Sign in to connect a cloud runner.",
  subscription_required:
    "A subscription is required to run agents on the cloud runner.",
  unavailable:
    "The cloud runner connection could not be loaded. Use Connect to set one manually.",
  unconfigured:
    "This deployment has no cloud runner configured. Use Connect to set one manually.",
};

export function connectionMessage(
  kind: Exclude<ConnectionStatusKind, "provisioned">
): string {
  return MESSAGES[kind];
}
