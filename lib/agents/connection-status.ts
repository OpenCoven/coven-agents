export type ConnectionStatus =
  | { endpoint: string; kind: "provisioned"; token: string }
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
export function readConnectionResponse(
  status: number,
  body: Readonly<Record<string, unknown>> | null
): ConnectionStatus {
  if (status === 401) {
    return { kind: "signed_out" };
  }
  if (status === 403) {
    return { kind: "subscription_required" };
  }
  if (status === 503) {
    return { kind: "unconfigured" };
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
