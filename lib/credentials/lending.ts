import "server-only";

import { requireNonemptyAbuseKeySecret } from "@/lib/abuse/config";
import {
  type consumeRunReservation,
  globalDailyRunCapFromEnv,
  type RunReservationRecord,
  type releaseRunReservation,
  type reserveRun,
  tenantHashForReservation,
} from "@/lib/billing/run-reservations";
import {
  CredentialLeaseDeniedError,
  type consumeCredentialLease,
  type issueCredentialLease,
} from "./leases";
import type { CredentialStoreDatabase } from "./store-core";

export interface CredentialLendingDependencies {
  consumeLegacy: (
    input: Parameters<typeof consumeRunReservation>[1]
  ) => ReturnType<typeof consumeRunReservation>;
  issue: (
    input: Parameters<typeof issueCredentialLease>[1]
  ) => ReturnType<typeof issueCredentialLease>;
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

export async function lendCredentialLegacyWithReservation(
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
