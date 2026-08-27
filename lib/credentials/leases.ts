import "server-only";

import { createHmac } from "node:crypto";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { tenantHashForReservation } from "@/lib/billing/run-reservations";
import type { databaseFor } from "@/lib/db/access";
import {
  type CredentialLease,
  credentialLease,
  type RunReservation,
  runReservation,
  runUsage,
} from "@/lib/db/schema";
import type { CredentialStoreDatabase } from "./store-core";

export const CREDENTIAL_LEASE_TTL_MS = 2 * 60 * 1000;
export const CREDENTIAL_LEASE_RETENTION_MS = 24 * 60 * 60 * 1000;

export type CredentialLeaseRecord = CredentialLease;
export type CredentialLeaseDeniedReason =
  | "expired"
  | "harness_mismatch"
  | "missing_lease"
  | "missing_reservation"
  | "operation_mismatch"
  | "operation_already_leased"
  | "replayed"
  | "reservation_unavailable"
  | "run_already_leased"
  | "run_mismatch"
  | "tenant_mismatch";

export class CredentialLeaseDeniedError extends Error {
  readonly reason: CredentialLeaseDeniedReason;

  constructor(reason: CredentialLeaseDeniedReason) {
    super(`Credential lease denied: ${reason}.`);
    this.name = "CredentialLeaseDeniedError";
    this.reason = reason;
  }
}

export type CredentialLeaseAuditEvent = {
  at: string;
  event: "credential_lease";
  harnessId: string;
  operation: "consume" | "issue";
  outcome: CredentialLeaseDeniedReason | "consumed" | "failed" | "issued";
  runId: string;
  tenantHash: string;
};

export type CredentialLeaseAuditSink = (
  event: CredentialLeaseAuditEvent
) => Promise<void> | void;

export interface CredentialLeaseTransaction {
  consumeReservation: (
    runId: string,
    tenant: string,
    consumedAt: Date
  ) => Promise<RunReservation | null>;
  credentialStore: CredentialStoreDatabase;
  findByOperationIdHash: (
    operationIdHash: string
  ) => Promise<CredentialLeaseRecord | null>;
  findByRequestIdHash: (
    requestIdHash: string
  ) => Promise<CredentialLeaseRecord | null>;
  findByRunId: (runId: string) => Promise<CredentialLeaseRecord | null>;
  findReservationForUpdate: (runId: string) => Promise<RunReservation | null>;
  insert: (lease: CredentialLeaseRecord) => Promise<void>;
  markConsumed: (
    requestIdHash: string,
    consumedAt: Date
  ) => Promise<CredentialLeaseRecord | null>;
}

export interface CredentialLeaseDatabase {
  cleanupExpiredBefore: (cutoff: Date) => Promise<void>;
  transaction: <T>(
    callback: (tx: CredentialLeaseTransaction) => Promise<T>
  ) => Promise<T>;
}

type ProductionDatabase = ReturnType<typeof databaseFor>;

export function drizzleCredentialLeaseDatabase(
  database: ProductionDatabase
): CredentialLeaseDatabase {
  return {
    cleanupExpiredBefore: async (cutoff) => {
      await database
        .delete(credentialLease)
        .where(lt(credentialLease.expiresAt, cutoff));
    },
    transaction: (callback) =>
      database.transaction(async (tx) =>
        callback({
          consumeReservation: async (runId, tenant, consumedAt) => {
            const [reservation] = await tx
              .update(runReservation)
              .set({ consumedAt, state: "consumed" })
              .where(
                and(
                  eq(runReservation.runId, runId),
                  eq(runReservation.state, "reserved"),
                  gt(runReservation.expiresAt, consumedAt)
                )
              )
              .returning();
            if (!reservation) {
              return null;
            }
            await tx
              .insert(runUsage)
              .values({ runId, tenant })
              .onConflictDoNothing();
            return reservation;
          },
          credentialStore: tx,
          findByOperationIdHash: async (operationIdHash) => {
            const [row] = await tx
              .select()
              .from(credentialLease)
              .where(eq(credentialLease.operationIdHash, operationIdHash))
              .limit(1);
            return row ?? null;
          },
          findByRequestIdHash: async (requestIdHash) => {
            const [row] = await tx
              .select()
              .from(credentialLease)
              .where(eq(credentialLease.requestIdHash, requestIdHash))
              .limit(1);
            return row ?? null;
          },
          findByRunId: async (runId) => {
            const [row] = await tx
              .select()
              .from(credentialLease)
              .where(eq(credentialLease.runId, runId))
              .limit(1);
            return row ?? null;
          },
          findReservationForUpdate: async (runId) => {
            const [row] = await tx
              .select()
              .from(runReservation)
              .where(eq(runReservation.runId, runId))
              .for("update")
              .limit(1);
            return row ?? null;
          },
          insert: async (lease) => {
            await tx.insert(credentialLease).values(lease);
          },
          markConsumed: async (requestIdHash, consumedAt) => {
            const [row] = await tx
              .update(credentialLease)
              .set({ consumedAt })
              .where(
                and(
                  eq(credentialLease.requestIdHash, requestIdHash),
                  gt(credentialLease.expiresAt, consumedAt),
                  isNull(credentialLease.consumedAt)
                )
              )
              .returning();
            return row ?? null;
          },
        })
      ),
  };
}

export async function issueCredentialLease(
  database: CredentialLeaseDatabase,
  input: {
    harnessId: string;
    keySecret: string;
    now?: Date;
    operationId: string;
    requestId: string;
    runId: string;
    tenant: string;
  },
  audit: CredentialLeaseAuditSink = defaultCredentialLeaseAudit
): Promise<void> {
  validateInput(input);
  const now = input.now ?? new Date();
  const tenantHash = tenantHashForReservation(input.tenant, input.keySecret);
  const operationIdHash = hashOperationId(input.operationId, input.keySecret);
  const requestIdHash = hashRequestId(input.requestId, input.keySecret);

  try {
    await database.cleanupExpiredBefore(
      new Date(now.getTime() - CREDENTIAL_LEASE_RETENTION_MS)
    );
    await database.transaction(async (tx) => {
      const existingRequest = await tx.findByRequestIdHash(requestIdHash);
      if (existingRequest) {
        assertBinding(existingRequest, {
          harnessId: input.harnessId,
          operationIdHash,
          runId: input.runId,
          tenantHash,
        });
      }

      const reservation = await tx.findReservationForUpdate(input.runId);
      assertReservationAvailable(reservation, tenantHash, now);
      if (existingRequest) {
        assertLeaseUsable(existingRequest, now);
        return;
      }

      const racedRequest = await tx.findByRequestIdHash(requestIdHash);
      if (racedRequest) {
        assertBinding(racedRequest, {
          harnessId: input.harnessId,
          operationIdHash,
          runId: input.runId,
          tenantHash,
        });
        assertLeaseUsable(racedRequest, now);
        return;
      }

      if (await tx.findByRunId(input.runId)) {
        throw new CredentialLeaseDeniedError("run_already_leased");
      }
      if (await tx.findByOperationIdHash(operationIdHash)) {
        throw new CredentialLeaseDeniedError("operation_already_leased");
      }

      await tx.insert({
        consumedAt: null,
        expiresAt: new Date(now.getTime() + CREDENTIAL_LEASE_TTL_MS),
        harnessId: input.harnessId,
        issuedAt: now,
        operationIdHash,
        requestIdHash,
        runId: input.runId,
        tenantHash,
      });
    });
    await audit({
      at: now.toISOString(),
      event: "credential_lease",
      harnessId: input.harnessId,
      operation: "issue",
      outcome: "issued",
      runId: input.runId,
      tenantHash,
    });
  } catch (error) {
    await audit({
      at: now.toISOString(),
      event: "credential_lease",
      harnessId: input.harnessId,
      operation: "issue",
      outcome:
        error instanceof CredentialLeaseDeniedError ? error.reason : "failed",
      runId: input.runId,
      tenantHash,
    });
    throw error;
  }
}

export async function consumeCredentialLease<T>(
  database: CredentialLeaseDatabase,
  input: {
    clock?: () => Date;
    harnessId: string;
    keySecret: string;
    now?: Date;
    operationId: string;
    requestId: string;
    runId: string;
    tenant: string;
  },
  prepare: () => Promise<void>,
  operation: (database: CredentialStoreDatabase) => Promise<T>,
  audit: CredentialLeaseAuditSink = defaultCredentialLeaseAudit
): Promise<T> {
  validateInput(input);
  const now = input.now ?? new Date();
  const tenantHash = tenantHashForReservation(input.tenant, input.keySecret);
  const operationIdHash = hashOperationId(input.operationId, input.keySecret);
  const requestIdHash = hashRequestId(input.requestId, input.keySecret);

  try {
    await database.transaction(async (tx) => {
      const existingRequest = await tx.findByRequestIdHash(requestIdHash);
      if (!existingRequest) {
        throw new CredentialLeaseDeniedError("missing_lease");
      }
      assertBinding(existingRequest, {
        harnessId: input.harnessId,
        operationIdHash,
        runId: input.runId,
        tenantHash,
      });
      assertLeaseUsable(existingRequest, now);

      const reservation = await tx.findReservationForUpdate(input.runId);
      assertReservationAvailable(reservation, tenantHash, now);

      const racedRequest = await tx.findByRequestIdHash(requestIdHash);
      if (!racedRequest) {
        throw new CredentialLeaseDeniedError("missing_lease");
      }
      assertBinding(racedRequest, {
        harnessId: input.harnessId,
        operationIdHash,
        runId: input.runId,
        tenantHash,
      });
      assertLeaseUsable(racedRequest, now);

      if (!(await tx.markConsumed(requestIdHash, now))) {
        throw new CredentialLeaseDeniedError("replayed");
      }
    });

    await prepare();

    const result = await database.transaction(async (tx) => {
      const finalNow = input.clock?.() ?? input.now ?? new Date();
      const claimed = await tx.findByRequestIdHash(requestIdHash);
      if (!claimed) {
        throw new CredentialLeaseDeniedError("missing_lease");
      }
      assertBinding(claimed, {
        harnessId: input.harnessId,
        operationIdHash,
        runId: input.runId,
        tenantHash,
      });
      if (!claimed.consumedAt) {
        throw new CredentialLeaseDeniedError("missing_lease");
      }
      const reservation = await tx.findReservationForUpdate(input.runId);
      assertReservationAvailable(reservation, tenantHash, finalNow);
      const consumed = await tx.consumeReservation(
        input.runId,
        input.tenant,
        finalNow
      );
      if (consumed?.state !== "consumed") {
        throw new CredentialLeaseDeniedError("reservation_unavailable");
      }
      return await operation(tx.credentialStore);
    });
    await audit({
      at: now.toISOString(),
      event: "credential_lease",
      harnessId: input.harnessId,
      operation: "consume",
      outcome: "consumed",
      runId: input.runId,
      tenantHash,
    });
    return result;
  } catch (error) {
    await audit({
      at: now.toISOString(),
      event: "credential_lease",
      harnessId: input.harnessId,
      operation: "consume",
      outcome:
        error instanceof CredentialLeaseDeniedError ? error.reason : "failed",
      runId: input.runId,
      tenantHash,
    });
    throw error;
  }
}

function assertBinding(
  lease: CredentialLeaseRecord,
  expected: {
    harnessId: string;
    operationIdHash: string;
    runId: string;
    tenantHash: string;
  }
): void {
  if (lease.tenantHash !== expected.tenantHash) {
    throw new CredentialLeaseDeniedError("tenant_mismatch");
  }
  if (lease.harnessId !== expected.harnessId) {
    throw new CredentialLeaseDeniedError("harness_mismatch");
  }
  if (lease.operationIdHash !== expected.operationIdHash) {
    throw new CredentialLeaseDeniedError("operation_mismatch");
  }
  if (lease.runId !== expected.runId) {
    throw new CredentialLeaseDeniedError("run_mismatch");
  }
}

function assertLeaseUsable(lease: CredentialLeaseRecord, now: Date): void {
  if (lease.expiresAt <= now) {
    throw new CredentialLeaseDeniedError("expired");
  }
  if (lease.consumedAt) {
    throw new CredentialLeaseDeniedError("replayed");
  }
}

function assertReservationAvailable(
  reservation: RunReservation | null,
  tenantHash: string,
  now: Date
): void {
  if (!reservation) {
    throw new CredentialLeaseDeniedError("missing_reservation");
  }
  if (reservation.tenantHash !== tenantHash) {
    throw new CredentialLeaseDeniedError("tenant_mismatch");
  }
  if (reservation.state !== "reserved" || reservation.expiresAt <= now) {
    throw new CredentialLeaseDeniedError("reservation_unavailable");
  }
}

function hashRequestId(requestId: string, keySecret: string): string {
  return createHmac("sha256", keySecret)
    .update("credential-lease-request\0", "utf8")
    .update(requestId, "utf8")
    .digest("hex");
}

function hashOperationId(operationId: string, keySecret: string): string {
  return createHmac("sha256", keySecret)
    .update("credential-lease-operation\0", "utf8")
    .update(operationId, "utf8")
    .digest("hex");
}

function validateInput(input: {
  harnessId: string;
  keySecret: string;
  operationId: string;
  requestId: string;
  runId: string;
  tenant: string;
}): void {
  validateIdentifier(input.harnessId, 64, "harnessId");
  validateIdentifier(input.operationId, 64, "operationId");
  validateIdentifier(input.requestId, 128, "requestId");
  validateIdentifier(input.runId, 64, "runId");
  validateIdentifier(input.tenant, 128, "tenant");
  if (!input.keySecret.trim()) {
    throw new Error("keySecret is invalid.");
  }
}

function validateIdentifier(
  value: string,
  maximumLength: number,
  name: string
): void {
  if (!value || value.length > maximumLength) {
    throw new Error(`${name} is invalid.`);
  }
}

function defaultCredentialLeaseAudit(event: CredentialLeaseAuditEvent): void {
  console.info(JSON.stringify(event));
}
