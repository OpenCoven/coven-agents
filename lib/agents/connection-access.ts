export type ConnectionDecision =
  | { endpoint: string; kind: "allowed"; token: string }
  | { kind: "forbidden" }
  | { kind: "unauthorized" }
  | { kind: "unconfigured" };

/**
 * Decides whether this caller may be handed the cloud runner connection.
 *
 * The console used to require the operator to paste the deployment token by
 * hand, which meant every rotation silently broke every browser and the only
 * symptom was "Runner token was rejected". Serving it to an authenticated
 * subscriber removes that step without widening anything: the value already
 * lived in their browser, and it is explicitly a coarse deployment gate from
 * which no tenant may ever be derived. Identity remains the Ed25519 signature,
 * whose private key never leaves the server.
 *
 * Refused for demo sessions. They cannot start a run regardless, so handing
 * them the gate would add exposure without adding capability.
 *
 * Refused when unconfigured, rather than serving an empty token. A worker
 * whose own `AGENT_CONTROL_TOKEN` is unset compares against `""` and would
 * accept it — so auto-configuring a console with a blank token is how the
 * deployment gate quietly stops existing.
 */
export function connectionDecision(input: {
  controlToken: string | undefined;
  endpoint: string | undefined;
  plan: "demo" | "subscriber" | null;
}): ConnectionDecision {
  if (!input.plan) {
    return { kind: "unauthorized" };
  }

  if (input.plan !== "subscriber") {
    return { kind: "forbidden" };
  }

  // Trimmed because a value pasted into a dashboard field commonly carries a
  // trailing newline, and the worker compares the header exactly.
  const token = input.controlToken?.trim() ?? "";
  const endpoint = input.endpoint?.trim() ?? "";

  if (!(token && endpoint)) {
    return { kind: "unconfigured" };
  }

  return { endpoint, kind: "allowed", token };
}
