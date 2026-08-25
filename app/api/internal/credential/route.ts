import "server-only";

// Service-to-service exemption from the `databaseFor` rule: this route has
// no session to gate on, because its caller is the worker, not a browser.
// The gate that replaces `databaseFor`'s session check is the service token
// verified in `authorizeInternalRequest` below, checked before any database
// access happens. This is the one place in the codebase permitted to import
// `db` directly.
import { importVerifyKey, verifyRunnerToken } from "@opencoven/agent-contracts";
import { eq } from "drizzle-orm";
import { periodStart } from "@/lib/billing/period";
import { countRun, usageFor } from "@/lib/billing/usage";
import { readCredentialForTenant } from "@/lib/credentials/store";
import { db } from "@/lib/db/queries";
import { user } from "@/lib/db/schema";
import { resolveBoundTenant } from "./binding";
import { capVerdict } from "./cap";

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

  // A malformed body is a deterministic 400, not an unhandled throw surfacing
  // as a 500. The caller is the worker, and it can only tell "I asked wrongly"
  // from "the app is broken" if those are different statuses.
  let body: { harnessId?: unknown; tenant?: unknown } | null;
  try {
    body = (await request.json()) as {
      harnessId?: unknown;
      tenant?: unknown;
    } | null;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const { harnessId } = body ?? {};

  if (typeof harnessId !== "string") {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  // The service token proves the caller may reach this endpoint. It does not
  // say who they are acting for — and it used to, because the tenant was read
  // straight from the body. That made one shared token a master key over every
  // tenant's credential. Identity now comes from the signed claim the worker
  // was handed when the run started, forwarded on.
  const verifyKey = process.env.RUNNER_VERIFY_KEY;
  if (!verifyKey) {
    return Response.json({ error: "identity_unavailable" }, { status: 503 });
  }

  const authorization = request.headers.get("authorization");
  const claims = authorization?.startsWith("Bearer ")
    ? await verifyRunnerToken(
        authorization.slice(7),
        await importVerifyKey(verifyKey)
      )
    : null;

  let tenant: string | null;
  try {
    tenant = resolveBoundTenant(claims, body ?? {}, { strict: true });
  } catch {
    // A body naming a different tenant than the claim is a caller doing
    // something it should not, not a malformed request.
    return Response.json({ error: "tenant_mismatch" }, { status: 403 });
  }

  if (!tenant) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { runId } = (body ?? {}) as { runId?: unknown };

  if (typeof runId !== "string" || !runId) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  // The cap is enforced here because this is the moment the credential is
  // lent — the one point every run must pass through, and the only one where
  // refusing costs nothing already spent.
  const [owner] = await db
    .select()
    .from(user)
    .where(eq(user.id, claims?.sub ?? ""))
    .limit(1);

  const resetsAt = owner?.subscribedUntil ?? null;
  const since = periodStart(resetsAt);

  const verdict = capVerdict({
    resetsAt,
    used: since ? await usageFor(db, tenant, since) : 0,
  });

  if (verdict.kind === "refused") {
    return Response.json(
      {
        cap: verdict.cap,
        error: "cap_reached",
        resetsAt: verdict.resetsAt,
        used: verdict.used,
      },
      { status: 429 }
    );
  }

  // Counted before the credential is handed over, so a run that starts is a
  // run that was paid for. Counting afterwards would let a crash between the
  // two produce free runs.
  await countRun(db, tenant, runId);

  const credential = await readCredentialForTenant(tenant, harnessId, db);

  if (credential === null) {
    return Response.json({ error: "no_credential" }, { status: 404 });
  }

  return Response.json({ credential }, { status: 200 });
}
