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
  serviceToken: string;
};

export async function fetchTenantCredential(
  request: CredentialRequest,
  transport: CredentialTransport
): Promise<string | null> {
  // A rejected fetch (network failure, DNS failure, etc.) propagates
  // unchanged — that is "we could not ask", not "there is none".
  const response = await transport.fetchImpl(
    `${transport.endpoint}/api/internal/credential`,
    {
      body: JSON.stringify({
        harnessId: request.harnessId,
        tenant: request.tenant,
      }),
      headers: {
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
  return typeof body.credential === "string" ? body.credential : null;
}
