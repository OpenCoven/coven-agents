import type { RunnerClaims } from "@opencoven/agent-contracts";

/**
 * Decides which tenant a credential request is actually for.
 *
 * The route used to authenticate the shared service token and then trust the
 * `tenant` named in the request body. That made the service token a master
 * key: anything holding it could ask for any tenant's credential, which is not
 * the isolation the rest of the system claims.
 *
 * The tenant now comes from a verified identity claim — the same signed token
 * the worker was given when the run was started, forwarded on. The body is
 * never the source of truth.
 *
 * A pure function rather than logic inside the handler, because this is the
 * decision that says whose secret gets handed out, and route-handler logic is
 * unreachable by a unit test.
 */
export function resolveBoundTenant(
  claims: Pick<RunnerClaims, "tenant"> | null,
  body: { tenant?: unknown },
  options: { strict?: boolean } = {}
): string | null {
  const tenant = claims?.tenant?.trim();
  if (!tenant) {
    return null;
  }

  // A body naming a different tenant is refused rather than quietly overruled.
  // Silently substituting the claim would let a caller probe indefinitely
  // without ever learning it was being ignored; a mismatch is a signal worth
  // surfacing, not smoothing over.
  if (
    options.strict &&
    typeof body.tenant === "string" &&
    body.tenant !== tenant
  ) {
    throw new Error(
      `Credential requested for tenant ${body.tenant} under a claim for ${tenant}.`
    );
  }

  return tenant;
}
