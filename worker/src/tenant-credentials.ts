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
  harnessId: string;
  tenant: string;
};

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
};

export async function fetchTenantCredential(
  request: CredentialRequest,
  transport: CredentialTransport
): Promise<string | null> {
  // A rejected fetch (network failure, DNS failure, etc.) propagates
  // unchanged — that is "we could not ask", not "there is none".
  const response = await transport.fetchImpl(
    new URL("/api/internal/credential", transport.endpoint).toString(),
    {
      body: JSON.stringify({
        harnessId: request.harnessId,
        tenant: request.tenant,
      }),
      headers: {
        authorization: `Bearer ${transport.identityToken}`,
        "content-type": "application/json",
        "x-service-token": transport.serviceToken,
      },
      method: "POST",
    }
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch tenant credential: ${response.status}`);
  }

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
