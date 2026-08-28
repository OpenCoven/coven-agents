/**
 * The worker holds no key material and stores nothing. For the duration of a
 * single run it borrows exactly one tenant's credential from the Next app —
 * the sole custodian — over this internal endpoint, and the credential lives
 * only in memory for that run. Compromising the worker at rest therefore
 * yields nothing: there is no secret to find between runs.
 *
 * The return value has exactly two shapes, and they must never be conflated:
 *
 *   - `null`  — "this tenant has no credential configured." A legitimate,
 *     expected configuration state. The caller refuses to start a run.
 *   - throws  — "we could not ask." A transport failure, an unreachable app,
 *     an unauthorized service token, or any other non-404 error status. This
 *     is an outage or a misconfiguration, not an answer.
 *
 * If a throw were ever downgraded to `null`, an outage would be
 * indistinguishable from a tenant who simply hasn't set up a credential, and
 * a caller deciding whether to fall back to some other behavior would make
 * that decision on false information.
 */

export type CredentialRequest = {
  agentId: string;
  harnessId: string;
  operationId: string;
  requestId: string;
  runId: string;
  tenant: string;
};

/**
 * The tenant is out of included runs.
 *
 * A distinct type because the caller must tell this from an outage: one is the
 * customer's to resolve and carries a reset date, the other is ours and must
 * not be reported as "you have run out".
 */
export class CapReachedError extends Error {
  readonly cap: number;
  readonly resetsAt: string | null;
  readonly used: number;

  constructor(cap: number, used: number, resetsAt: string | null) {
    super(
      `Run cap reached: ${used} of ${cap} used${
        resetsAt ? `, resets ${resetsAt}` : ""
      }.`
    );
    this.cap = cap;
    this.name = "CapReachedError";
    this.resetsAt = resetsAt;
    this.used = used;
  }
}

export type CredentialTransport = {
  endpoint: string;
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  /**
   * The signed identity claim this run was started with, forwarded on.
   *
   * The service token proves the worker may reach the endpoint; it does not
   * say which tenant it is acting for. Without this the app had to trust the
   * tenant named in the body, which made one shared token a master key over
   * every tenant's credential.
   */
  identityToken: string;
  serviceToken: string;
  signal?: AbortSignal;
};

export async function fetchTenantCredential(
  request: CredentialRequest,
  transport: CredentialTransport
): Promise<string | null> {
  const endpoint = new URL("/api/internal/credential", transport.endpoint);
  const issueEndpoint = new URL(endpoint);
  issueEndpoint.searchParams.set("phase", "issue");
  const issued = await postCredentialRequest(
    issueEndpoint.toString(),
    request,
    transport
  );
  if (issued.status === 429) {
    throw await capReachedError(issued);
  }
  if (issued.status === 404) {
    return null;
  }
  if (issued.status === 200) {
    return await credentialFromResponse(issued);
  }
  if (issued.status !== 201) {
    throw new Error(`Failed to issue credential lease: ${issued.status}`);
  }

  // A rejected fetch (network failure, DNS failure, etc.) propagates
  // unchanged — that is "we could not ask", not "there is none".
  const response = await postCredentialRequest(
    endpoint.toString(),
    request,
    transport
  );

  if (response.status === 404) {
    return null;
  }

  // Parsed before the general failure, because the body carries the only
  // numbers that can explain the refusal. Discarding it here is what turned
  // "you are out of runs" into a bare status code.
  if (response.status === 429) {
    throw await capReachedError(response);
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch tenant credential: ${response.status}`);
  }

  return await credentialFromResponse(response);
}

async function credentialFromResponse(response: Response): Promise<string> {
  const body = (await response.json()) as { credential?: unknown };
  if (typeof body.credential !== "string" || !body.credential) {
    // A 200 means the app found a credential, so an unusable body is a bug in
    // the app — not a tenant who has configured none. Returning null here
    // would let that bug masquerade as a configuration state, which is the
    // exact conflation this function exists to prevent.
    throw new Error(
      "Credential endpoint returned 200 with no usable credential."
    );
  }
  return body.credential;
}

function postCredentialRequest(
  endpoint: string,
  request: CredentialRequest,
  transport: CredentialTransport
): Promise<Response> {
  return transport.fetchImpl(endpoint, {
    body: JSON.stringify({
      agentId: request.agentId,
      harnessId: request.harnessId,
      operationId: request.operationId,
      requestId: request.requestId,
      runId: request.runId,
      tenant: request.tenant,
    }),
    headers: {
      authorization: `Bearer ${transport.identityToken}`,
      "content-type": "application/json",
      "x-service-token": transport.serviceToken,
    },
    method: "POST",
    signal: transport.signal,
  });
}

async function capReachedError(response: Response): Promise<CapReachedError> {
  const body = (await response.json().catch(() => null)) as {
    cap?: unknown;
    resetsAt?: unknown;
    used?: unknown;
  } | null;

  return new CapReachedError(
    typeof body?.cap === "number" ? body.cap : 0,
    typeof body?.used === "number" ? body.used : 0,
    typeof body?.resetsAt === "string" ? body.resetsAt : null
  );
}

/**
 * Normalises a fetched credential so its two consumers agree on the bytes.
 *
 * `requireHarness` trims before injecting into the sandbox, and the same value
 * is handed to evidence redaction. Trim in only one of them and the harness
 * uses one string while redaction searches for another — a credential stored
 * with stray whitespace would then be used and leaked.
 */
export function normalizeCredential(value: string | null): string | null {
  return value?.trim() || null;
}
