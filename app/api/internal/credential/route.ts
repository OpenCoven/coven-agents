import "server-only";

// Service-to-service exemption from the `databaseFor` rule: this route has
// no session to gate on, because its caller is the worker, not a browser.
// The gate that replaces `databaseFor`'s session check is the service token
// verified in `authorizeInternalRequest` below, checked before any database
// access happens. This is the one place in the codebase permitted to import
// `db` directly.
import {
  type RunnerVerificationKeyRing,
  verifyRunnerToken,
} from "@opencoven/agent-contracts";
import { eq } from "drizzle-orm";
import { requireNonemptyAbuseKeySecret } from "@/lib/abuse/config";
import { runnerVerificationKeyRingFromEnvironment } from "@/lib/agents/key-ring";
import { sessionAuthorityMatches } from "@/lib/auth/session-revocation";
import { MONTHLY_RUN_CAP } from "@/lib/billing/limits";
import { periodStart } from "@/lib/billing/period";
import {
  consumeRunReservation,
  drizzleRunReservationDatabase,
  globalDailyRunCapFromEnv,
  type RunReservationRecord,
  releaseRunReservation,
  reserveRun,
  tenantHashForReservation,
} from "@/lib/billing/run-reservations";
import { readCredentialForTenant } from "@/lib/credentials/store";
import { db } from "@/lib/db/queries";
import { user } from "@/lib/db/schema";
import { resolveBoundTenant } from "./binding";

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

export interface CredentialLendingDependencies {
  consume: (
    input: Parameters<typeof consumeRunReservation>[1]
  ) => ReturnType<typeof consumeRunReservation>;
  readCredential: (tenant: string, harnessId: string) => Promise<string | null>;
  release: (
    input: Parameters<typeof releaseRunReservation>[1]
  ) => ReturnType<typeof releaseRunReservation>;
  reserve: (
    input: Parameters<typeof reserveRun>[1]
  ) => ReturnType<typeof reserveRun>;
}

export async function lendCredentialWithReservation(
  input: {
    globalDailyCap: string | undefined;
    harnessId: string;
    keySecret: string | undefined;
    now?: Date;
    periodStart: Date;
    resetsAt: Date;
    runId: string;
    tenant: string;
  },
  dependencies: CredentialLendingDependencies
): Promise<Response> {
  let globalDailyCap: number;
  let keySecret: string;
  let expectedTenantHash: string;
  try {
    globalDailyCap = globalDailyRunCapFromEnv(input.globalDailyCap);
    keySecret = requireNonemptyAbuseKeySecret(input.keySecret);
    expectedTenantHash = tenantHashForReservation(input.tenant, keySecret);
  } catch {
    return Response.json({ error: "capacity_unavailable" }, { status: 503 });
  }

  const now = input.now ?? new Date();
  let decision: Awaited<ReturnType<typeof dependencies.reserve>>;
  try {
    decision = await dependencies.reserve({
      globalDailyCap,
      keySecret,
      now,
      periodStart: input.periodStart,
      runId: input.runId,
      tenant: input.tenant,
    });
  } catch {
    return Response.json({ error: "capacity_unavailable" }, { status: 503 });
  }

  if (decision.kind === "refused") {
    if (decision.reason === "global_daily_cap") {
      return Response.json({ error: "capacity_unavailable" }, { status: 503 });
    }

    const resetsAt =
      decision.reason === "tenant_daily_cap"
        ? nextUtcDay(now).toISOString()
        : input.resetsAt.toISOString();
    return Response.json(
      {
        cap: decision.cap,
        error: "cap_reached",
        reason: decision.reason,
        resetsAt,
        used: decision.used,
      },
      { status: 429 }
    );
  }

  if (
    (decision.kind === "existing" &&
      decision.reservation.state === "released") ||
    decision.reservation.tenantHash !== expectedTenantHash
  ) {
    return Response.json({ error: "reservation_unavailable" }, { status: 409 });
  }

  let credential: string | null;
  try {
    credential = await dependencies.readCredential(
      input.tenant,
      input.harnessId
    );
  } catch {
    await releaseAfterLendingFailure(dependencies, input.runId);
    return Response.json({ error: "credential_unavailable" }, { status: 503 });
  }

  if (credential === null) {
    await releaseAfterLendingFailure(dependencies, input.runId);
    return Response.json({ error: "no_credential" }, { status: 404 });
  }

  try {
    const consumed = await dependencies.consume({
      runId: input.runId,
      tenant: input.tenant,
    });
    if (consumed.kind !== "consumed") {
      await releaseAfterLendingFailure(dependencies, input.runId);
      return Response.json(
        { error: "credential_unavailable" },
        { status: 503 }
      );
    }
  } catch {
    await releaseAfterLendingFailure(dependencies, input.runId);
    return Response.json({ error: "credential_unavailable" }, { status: 503 });
  }

  return Response.json({ credential }, { status: 200 });
}

function nextUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  );
}

async function releaseAfterLendingFailure(
  dependencies: Pick<CredentialLendingDependencies, "release">,
  runId: string
): Promise<RunReservationRecord | null> {
  try {
    return await dependencies.release({ runId });
  } catch {
    return null;
  }
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
  let body: {
    harnessId?: unknown;
    runId?: unknown;
    tenant?: unknown;
  } | null;
  try {
    body = (await request.json()) as {
      harnessId?: unknown;
      runId?: unknown;
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
  let verifyKeyRing: RunnerVerificationKeyRing;
  try {
    verifyKeyRing = await runnerVerificationKeyRingFromEnvironment();
  } catch {
    return Response.json({ error: "identity_unavailable" }, { status: 503 });
  }

  const authorization = request.headers.get("authorization");
  const claims = authorization?.startsWith("Bearer ")
    ? await verifyRunnerToken(authorization.slice(7), verifyKeyRing)
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
  if (!claims) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { runId } = body ?? {};

  if (typeof runId !== "string" || !runId) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  // The cap is enforced here because this is the moment the credential is
  // lent — the one point every run must pass through, and the only one where
  // refusing costs nothing already spent.
  let owner: typeof user.$inferSelect | undefined;
  try {
    [owner] = await db
      .select()
      .from(user)
      .where(eq(user.id, claims.sub))
      .limit(1);
  } catch {
    return Response.json({ error: "identity_unavailable" }, { status: 503 });
  }

  if (
    !owner ||
    !sessionAuthorityMatches({
      database: owner,
      now: new Date(),
      tokenAuthVersion: claims.authVersion,
    })
  ) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const resetsAt = owner?.subscribedUntil ?? null;
  const since = periodStart(resetsAt, owner?.billingPeriodStart ?? null);
  if (!(resetsAt && since)) {
    return Response.json(
      {
        cap: MONTHLY_RUN_CAP,
        error: "cap_reached",
        reason: "tenant_monthly_cap",
        resetsAt: null,
        used: MONTHLY_RUN_CAP,
      },
      { status: 429 }
    );
  }

  const reservationDatabase = drizzleRunReservationDatabase(db);
  return await lendCredentialWithReservation(
    {
      globalDailyCap: process.env.GLOBAL_DAILY_RUN_CAP,
      harnessId,
      keySecret: process.env.ABUSE_KEY_SECRET,
      periodStart: since,
      resetsAt,
      runId,
      tenant,
    },
    {
      consume: (input) => consumeRunReservation(reservationDatabase, input),
      readCredential: (boundTenant, boundHarnessId) =>
        readCredentialForTenant(boundTenant, boundHarnessId, db),
      release: (input) => releaseRunReservation(reservationDatabase, input),
      reserve: (input) => reserveRun(reservationDatabase, input),
    }
  );
}
