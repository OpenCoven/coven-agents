import "server-only";

// Service-to-service exemption from the `databaseFor` rule: this route has
// no session to gate on, because its caller is the worker, not a browser.
// The gate that replaces `databaseFor`'s session check is the service token
// verified in `authorizeInternalRequest` below, checked before any database
// access happens. This is the one place in the codebase permitted to import
// `db` directly.
import {
  MAX_RUNNER_TOKEN_BYTES,
  type RunnerClaims,
  type RunnerVerificationKeyRing,
  verifyRunnerToken,
} from "@opencoven/agent-contracts";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { readBoundedJson } from "@/lib/abuse/body";
import { requireNonemptyAbuseKeySecret } from "@/lib/abuse/config";
import { runnerVerificationKeyRingFromEnvironment } from "@/lib/agents/key-ring";
import { authorizeInternalRequest } from "@/lib/auth/internal-service";
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
import {
  CredentialLeaseDeniedError,
  consumeCredentialLease,
  drizzleCredentialLeaseDatabase,
  issueCredentialLease,
} from "@/lib/credentials/leases";
import {
  prepareCredentialForTenant,
  readCredentialForTenant,
  readCredentialForTenantWithoutRefresh,
} from "@/lib/credentials/store";
import type { CredentialStoreDatabase } from "@/lib/credentials/store-core";
import { db } from "@/lib/db/queries";
import { user } from "@/lib/db/schema";
import { resolveBoundTenant } from "./binding";

/**
 * There is deliberately no session-authenticated path in this module. A
 * credential must never be reachable from a browser, so a valid user session
 * must never be sufficient to read one — only the shared service token that
 * the worker (and nothing else) holds.
 */

export { authorizeInternalRequest } from "@/lib/auth/internal-service";

const MAX_CREDENTIAL_BODY_BYTES = 8192;
const MAX_CREDENTIAL_RUN_ID_LENGTH = 64;
const MAX_CREDENTIAL_REQUEST_ID_LENGTH = 128;
const MAX_CREDENTIAL_OPERATION_ID_LENGTH = 64;
const MAX_CREDENTIAL_HARNESS_ID_LENGTH = 64;
const MAX_CREDENTIAL_TENANT_LENGTH = 128;
const credentialRequestSchema = z
  .object({
    agentId: z.string().uuid().optional(),
    harnessId: z.string().trim().min(1).max(MAX_CREDENTIAL_HARNESS_ID_LENGTH),
    operationId: z
      .string()
      .trim()
      .min(1)
      .max(MAX_CREDENTIAL_OPERATION_ID_LENGTH)
      .optional(),
    requestId: z
      .string()
      .trim()
      .min(1)
      .max(MAX_CREDENTIAL_REQUEST_ID_LENGTH)
      .optional(),
    runId: z.string().trim().min(1).max(MAX_CREDENTIAL_RUN_ID_LENGTH),
    tenant: z.string().trim().min(1).max(MAX_CREDENTIAL_TENANT_LENGTH),
  })
  .strict();
const runnerTokenSchema = z.string().min(1).max(MAX_RUNNER_TOKEN_BYTES);

export function credentialRunScopeMatches(
  scope: RunnerClaims["run"],
  input: {
    agentId?: string;
    harnessId: string;
    operationId?: string;
    requestId?: string;
    runId: string;
  }
): input is {
  agentId: string;
  harnessId: string;
  operationId: string;
  requestId: string;
  runId: string;
} {
  return Boolean(
    scope &&
      input.agentId &&
      input.operationId &&
      input.requestId &&
      scope.agentId === input.agentId &&
      scope.harnessId === input.harnessId &&
      scope.operationId === input.operationId &&
      scope.operationId === input.runId
  );
}

export function legacyCredentialLendingEnabled(value: string | undefined) {
  return value === "true";
}

export interface CredentialLendingDependencies {
  consumeLegacy: (
    input: Parameters<typeof consumeRunReservation>[1]
  ) => ReturnType<typeof consumeRunReservation>;
  issue: (input: Parameters<typeof issueCredentialLease>[1]) => Promise<void>;
  lease: (
    input: Parameters<typeof consumeCredentialLease>[1],
    prepare: () => Promise<void>,
    operation: (database: CredentialStoreDatabase) => Promise<string | null>
  ) => Promise<string | null>;
  prepareCredential: (tenant: string, harnessId: string) => Promise<boolean>;
  readCredential: (
    tenant: string,
    harnessId: string,
    database: CredentialStoreDatabase
  ) => Promise<string | null>;
  readCredentialLegacy: (
    tenant: string,
    harnessId: string
  ) => Promise<string | null>;
  release: (
    input: Parameters<typeof releaseRunReservation>[1]
  ) => ReturnType<typeof releaseRunReservation>;
  reserve: (
    input: Parameters<typeof reserveRun>[1]
  ) => ReturnType<typeof reserveRun>;
}

class CredentialNotConfiguredError extends Error {}

/**
 * Phase one reserves capacity and persists the immutable lease binding. It
 * never reads credential material.
 */
export async function lendCredentialWithReservation(
  input: {
    globalDailyCap: string | undefined;
    harnessId: string;
    keySecret: string | undefined;
    now?: Date;
    operationId: string;
    periodStart: Date;
    requestId: string;
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
  if (decision.kind === "conflict") {
    return Response.json({ error: "reservation_unavailable" }, { status: 409 });
  }

  if (
    decision.reservation.state !== "reserved" ||
    decision.reservation.expiresAt <= now ||
    decision.reservation.tenantHash !== expectedTenantHash
  ) {
    return Response.json({ error: "reservation_unavailable" }, { status: 409 });
  }

  try {
    await dependencies.issue({
      harnessId: input.harnessId,
      keySecret,
      now,
      operationId: input.operationId,
      requestId: input.requestId,
      runId: input.runId,
      tenant: input.tenant,
    });
  } catch (error) {
    if (error instanceof CredentialLeaseDeniedError) {
      return Response.json(
        { error: "credential_lease_unavailable" },
        { status: 409 }
      );
    }
    if (decision.kind === "reserved") {
      await releaseAfterLendingFailure(dependencies, input.runId);
    }
    return Response.json({ error: "credential_unavailable" }, { status: 503 });
  }

  return Response.json({ lease: "issued" }, { status: 201 });
}

export async function lendCredentialWithLease(
  input: {
    harnessId: string;
    keySecret: string | undefined;
    now?: Date;
    operationId: string;
    requestId: string;
    runId: string;
    tenant: string;
  },
  dependencies: CredentialLendingDependencies
): Promise<Response> {
  let keySecret: string;
  try {
    keySecret = requireNonemptyAbuseKeySecret(input.keySecret);
  } catch {
    return Response.json({ error: "credential_unavailable" }, { status: 503 });
  }

  const requestedNow = input.now;
  try {
    const credential = await dependencies.lease(
      {
        harnessId: input.harnessId,
        keySecret,
        operationId: input.operationId,
        requestId: input.requestId,
        runId: input.runId,
        tenant: input.tenant,
        ...(requestedNow
          ? { clock: () => requestedNow, now: requestedNow }
          : {}),
      },
      async () => {
        if (
          !(await dependencies.prepareCredential(input.tenant, input.harnessId))
        ) {
          throw new CredentialNotConfiguredError();
        }
      },
      async (database) => {
        const stored = await dependencies.readCredential(
          input.tenant,
          input.harnessId,
          database
        );
        if (stored === null) {
          throw new CredentialNotConfiguredError();
        }
        return stored;
      }
    );
    if (credential === null) {
      throw new CredentialNotConfiguredError();
    }
    return Response.json({ credential }, { status: 200 });
  } catch (error) {
    if (error instanceof CredentialLeaseDeniedError) {
      return Response.json(
        { error: "credential_lease_unavailable" },
        { status: 409 }
      );
    }
    await releaseAfterLendingFailure(dependencies, input.runId);
    if (error instanceof CredentialNotConfiguredError) {
      return Response.json({ error: "no_credential" }, { status: 404 });
    }
    return Response.json({ error: "credential_unavailable" }, { status: 503 });
  }
}

async function lendCredentialLegacyWithReservation(
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
  try {
    globalDailyCap = globalDailyRunCapFromEnv(input.globalDailyCap);
    keySecret = requireNonemptyAbuseKeySecret(input.keySecret);
  } catch {
    return Response.json({ error: "capacity_unavailable" }, { status: 503 });
  }

  const now = input.now ?? new Date();
  const decision = await dependencies
    .reserve({
      globalDailyCap,
      keySecret,
      now,
      periodStart: input.periodStart,
      runId: input.runId,
      tenant: input.tenant,
    })
    .catch(() => null);
  if (!decision) {
    return Response.json({ error: "capacity_unavailable" }, { status: 503 });
  }
  if (decision.kind === "refused") {
    if (decision.reason === "global_daily_cap") {
      return Response.json({ error: "capacity_unavailable" }, { status: 503 });
    }
    return Response.json(
      {
        cap: decision.cap,
        error: "cap_reached",
        reason: decision.reason,
        resetsAt:
          decision.reason === "tenant_daily_cap"
            ? nextUtcDay(now).toISOString()
            : input.resetsAt.toISOString(),
        used: decision.used,
      },
      { status: 429 }
    );
  }
  if (decision.kind === "conflict") {
    return Response.json({ error: "reservation_unavailable" }, { status: 409 });
  }
  if (
    decision.reservation.state !== "reserved" ||
    decision.reservation.expiresAt <= now ||
    decision.reservation.tenantHash !==
      tenantHashForReservation(input.tenant, keySecret)
  ) {
    return Response.json({ error: "reservation_unavailable" }, { status: 409 });
  }

  let credential: string | null;
  try {
    credential = await dependencies.readCredentialLegacy(
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

  const consumed = await dependencies
    .consumeLegacy({ runId: input.runId, tenant: input.tenant })
    .catch(() => null);
  if (consumed?.kind !== "consumed") {
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

  const body = await readBoundedJson(
    request,
    MAX_CREDENTIAL_BODY_BYTES,
    credentialRequestSchema
  );
  if (body.kind === "too_large") {
    return Response.json({ error: "request_too_large" }, { status: 413 });
  }
  if (body.kind === "invalid") {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const phase = new URL(request.url).searchParams.get("phase");
  if (phase !== null && phase !== "issue") {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const authorization = request.headers.get("authorization");
  const identityToken = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : null;
  if (!identityToken || !runnerTokenSchema.safeParse(identityToken).success) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
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

  const claims = await verifyRunnerToken(identityToken, verifyKeyRing);

  let tenant: string | null;
  try {
    tenant = resolveBoundTenant(claims, body.value, { strict: true });
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

  const { agentId, harnessId, operationId, requestId, runId } = body.value;
  const runScope = claims.run;
  if (
    runScope &&
    !credentialRunScopeMatches(runScope, {
      agentId,
      harnessId,
      operationId,
      requestId,
      runId,
    })
  ) {
    return Response.json({ error: "run_identity_mismatch" }, { status: 403 });
  }
  if (
    !runScope &&
    !legacyCredentialLendingEnabled(
      process.env.CREDENTIAL_LEGACY_LENDING_ENABLED
    )
  ) {
    return Response.json({ error: "run_identity_required" }, { status: 403 });
  }

  // The cap is enforced during issuance, before the follow-up request can
  // decrypt credential material.
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

  const reservationDatabase = drizzleRunReservationDatabase(db);
  const leaseDatabase = drizzleCredentialLeaseDatabase(db);
  const dependencies: CredentialLendingDependencies = {
    consumeLegacy: (input) => consumeRunReservation(reservationDatabase, input),
    issue: (input) => issueCredentialLease(leaseDatabase, input),
    lease: (input, prepare, operation) =>
      consumeCredentialLease(leaseDatabase, input, prepare, operation),
    prepareCredential: (boundTenant, boundHarnessId) =>
      db.transaction((tx) =>
        prepareCredentialForTenant(boundTenant, boundHarnessId, tx)
      ),
    readCredential: (boundTenant, boundHarnessId, database) =>
      readCredentialForTenantWithoutRefresh(
        boundTenant,
        boundHarnessId,
        database
      ),
    readCredentialLegacy: (boundTenant, boundHarnessId) =>
      readCredentialForTenant(boundTenant, boundHarnessId, db),
    release: (input) => releaseRunReservation(reservationDatabase, input),
    reserve: (input) => reserveRun(reservationDatabase, input),
  };
  if (!runScope) {
    const resetsAt = owner.subscribedUntil;
    const since = periodStart(resetsAt, owner.billingPeriodStart);
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
    return await lendCredentialLegacyWithReservation(
      {
        globalDailyCap: process.env.GLOBAL_DAILY_RUN_CAP,
        harnessId,
        keySecret: process.env.ABUSE_KEY_SECRET,
        periodStart: since,
        resetsAt,
        runId,
        tenant,
      },
      dependencies
    );
  }
  if (!(agentId && operationId && requestId)) {
    return Response.json({ error: "run_identity_mismatch" }, { status: 403 });
  }
  if (phase === "issue") {
    const resetsAt = owner.subscribedUntil;
    const since = periodStart(resetsAt, owner.billingPeriodStart);
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
    return await lendCredentialWithReservation(
      {
        globalDailyCap: process.env.GLOBAL_DAILY_RUN_CAP,
        harnessId,
        keySecret: process.env.ABUSE_KEY_SECRET,
        operationId,
        periodStart: since,
        requestId,
        resetsAt,
        runId,
        tenant,
      },
      dependencies
    );
  }
  return await lendCredentialWithLease(
    {
      harnessId,
      keySecret: process.env.ABUSE_KEY_SECRET,
      operationId,
      requestId,
      runId,
      tenant,
    },
    dependencies
  );
}
