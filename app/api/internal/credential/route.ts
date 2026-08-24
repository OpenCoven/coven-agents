import "server-only";

import { readCredentialForTenant } from "@/lib/credentials/store";
// Service-to-service exemption from the `databaseFor` rule: this route has
// no session to gate on, because its caller is the worker, not a browser.
// The gate that replaces `databaseFor`'s session check is the service token
// verified in `authorizeInternalRequest` below, checked before any database
// access happens. This is the one place in the codebase permitted to import
// `db` directly.
import { db } from "@/lib/db/queries";

/**
 * There is deliberately no session-authenticated path in this module. A
 * credential must never be reachable from a browser, so a valid user session
 * must never be sufficient to read one — only the shared service token that
 * the worker (and nothing else) holds.
 */

export function authorizeInternalRequest(
  request: Request,
  expected: string
): boolean {
  const supplied = request.headers.get("x-service-token");

  if (!supplied || !expected || supplied.length !== expected.length) {
    return false;
  }

  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  }

  return mismatch === 0;
}

export async function POST(request: Request): Promise<Response> {
  if (
    !authorizeInternalRequest(request, process.env.RUNNER_SERVICE_TOKEN ?? "")
  ) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { tenant, harnessId } = body ?? {};

  if (typeof tenant !== "string" || typeof harnessId !== "string") {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const credential = await readCredentialForTenant(tenant, harnessId, db);

  if (credential === null) {
    return Response.json({ error: "no_credential" }, { status: 404 });
  }

  return Response.json({ credential }, { status: 200 });
}
