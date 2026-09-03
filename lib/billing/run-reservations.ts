import "server-only";

import { createHmac } from "node:crypto";
import {
  and,
  count,
  eq,
  gt,
  gte,
  inArray,
  lt,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { requireNonemptyAbuseKeySecret } from "@/lib/abuse/config";
import type { databaseFor } from "@/lib/db/access";
import { type RunReservation, runReservation, runUsage } from "@/lib/db/schema";
import { MONTHLY_MINUTE_CAP, RUN_MINUTE_RESERVATION } from "./limits";

export { globalDailyRunCapFromEnv } from "@/lib/abuse/config";

/**
 * Minutes one tenant may hold across a UTC day. It bounds how fast a single
 * account can burn through its bucket and how many full-length runs it can
 * have reserved at once, without being so tight that a busy day of ordinary
 * use hits it: a third of the monthly bucket, ten times its daily average.
 */
export const TENANT_DAILY_MINUTE_CAP = 100;
export const RUN_RESERVATION_TTL_MS = 5 * 60 * 1000;

const SERIALIZABLE = { isolationLevel: "serializable" } as const;
const SERIALIZATION_RETRIES = 5;
const ERROR_CAUSE_DEPTH_LIMIT = 5;
const RETRYABLE_POSTGRES_CODES = new Set(["23505", "40001", "40P01"]);

export type RunReservationRecord = RunReservation;
export type ReservationCapReason =
  | "global_daily_cap"
  | "tenant_daily_cap"
  | "tenant_monthly_cap";

export type ReserveRunResult =
  | { kind: "conflict"; reason: "run_already_counted" }
  | { kind: "existing"; reservation: RunReservationRecord }
  | {
      cap: number;
      kind: "refused";
      reason: "tenant_daily_cap" | "tenant_monthly_cap";
      used: number;
    }
  | { kind: "refused"; reason: "global_daily_cap" }
  | { kind: "reserved"; reservation: RunReservationRecord };

export interface RunReservationTransaction {
  activeUnits: (input: {
    now: Date;
    periodDay?: string;
    periodMonth?: Date;
    tenant?: string;
    tenantHash?: string;
  }) => Promise<number>;
  compensateConsumed: (
    runId: string,
    tenant: string,
    compensatedAt: Date
  ) => Promise<RunReservationRecord | null>;
  discardReserved: (runId: string) => Promise<RunReservationRecord | null>;
  findByRunId: (runId: string) => Promise<RunReservationRecord | null>;
  hasUsageRunId: (runId: string) => Promise<boolean>;
  insert: (reservation: RunReservationRecord) => Promise<void>;
  markConsumed: (
    runId: string,
    tenant: string,
    consumedAt: Date
  ) => Promise<RunReservationRecord | null>;
  markReleased: (
    runId: string,
    releasedAt: Date
  ) => Promise<RunReservationRecord | null>;
  releaseExpired: (now: Date) => Promise<void>;
}

export interface RunReservationDatabase {
  transaction: <T>(
    callback: (tx: RunReservationTransaction) => Promise<T>,
    config: typeof SERIALIZABLE
  ) => Promise<T>;
}

type ProductionDatabase = ReturnType<typeof databaseFor>;

export function drizzleRunReservationDatabase(
  database: ProductionDatabase
): RunReservationDatabase {
  return {
    transaction: (callback, config) =>
      database.transaction(
        async (tx) =>
          callback({
            activeUnits: async (input) => {
              const conditions = [
                inArray(runReservation.state, ["reserved", "consumed"]),
                or(
                  eq(runReservation.state, "consumed"),
                  gt(runReservation.expiresAt, input.now)
                ),
              ];

              if (input.tenantHash !== undefined) {
                conditions.push(
                  eq(runReservation.tenantHash, input.tenantHash)
                );
              }
              if (input.periodDay !== undefined) {
                conditions.push(eq(runReservation.periodDay, input.periodDay));
              }
              if (input.periodMonth !== undefined) {
                conditions.push(
                  eq(runReservation.periodMonth, input.periodMonth)
                );
              }

              const [reservationRow] = await tx
                .select({
                  units:
                    sql<number>`coalesce(sum(${runReservation.costUnits}), 0)`.mapWith(
                      Number
                    ),
                })
                .from(runReservation)
                .where(and(...conditions));

              if (
                input.tenantHash !== undefined &&
                input.tenant === undefined
              ) {
                return reservationRow?.units ?? 0;
              }

              const legacyConditions = [
                notExists(
                  tx
                    .select({ runId: runReservation.runId })
                    .from(runReservation)
                    .where(
                      and(
                        eq(runReservation.runId, runUsage.runId),
                        inArray(runReservation.state, ["reserved", "consumed"])
                      )
                    )
                ),
              ];
              if (input.tenant !== undefined) {
                legacyConditions.push(eq(runUsage.tenant, input.tenant));
              }
              if (input.periodDay !== undefined) {
                const dayStart = new Date(`${input.periodDay}T00:00:00.000Z`);
                const nextDay = new Date(dayStart.getTime() + 86_400_000);
                legacyConditions.push(gte(runUsage.countedAt, dayStart));
                legacyConditions.push(lt(runUsage.countedAt, nextDay));
              }
              if (input.periodMonth !== undefined) {
                legacyConditions.push(
                  gte(runUsage.countedAt, input.periodMonth)
                );
              }

              const [legacyRow] = await tx
                .select({ units: count() })
                .from(runUsage)
                .where(and(...legacyConditions));

              return (reservationRow?.units ?? 0) + (legacyRow?.units ?? 0);
            },
            compensateConsumed: async (runId, tenant, compensatedAt) => {
              const [updated] = await tx
                .update(runReservation)
                .set({
                  consumedAt: null,
                  releasedAt: compensatedAt,
                  state: "released",
                })
                .where(
                  and(
                    eq(runReservation.runId, runId),
                    eq(runReservation.state, "consumed")
                  )
                )
                .returning();
              if (updated) {
                await tx
                  .delete(runUsage)
                  .where(
                    and(eq(runUsage.runId, runId), eq(runUsage.tenant, tenant))
                  );
                return updated;
              }
              const [reservation] = await tx
                .select()
                .from(runReservation)
                .where(eq(runReservation.runId, runId))
                .limit(1);
              return reservation ?? null;
            },
            discardReserved: async (runId) => {
              const [discarded] = await tx
                .delete(runReservation)
                .where(
                  and(
                    eq(runReservation.runId, runId),
                    eq(runReservation.state, "reserved")
                  )
                )
                .returning();
              return discarded ?? null;
            },
            findByRunId: async (runId) => {
              const [reservation] = await tx
                .select()
                .from(runReservation)
                .where(eq(runReservation.runId, runId))
                .limit(1);
              return reservation ?? null;
            },
            hasUsageRunId: async (runId) => {
              const [usage] = await tx
                .select({ runId: runUsage.runId })
                .from(runUsage)
                .where(eq(runUsage.runId, runId))
                .limit(1);
              return Boolean(usage);
            },
            insert: async (reservation) => {
              await tx.insert(runReservation).values(reservation);
            },
            markConsumed: async (runId, tenant, consumedAt) => {
              const [updated] = await tx
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

              const reservation =
                updated ??
                (
                  await tx
                    .select()
                    .from(runReservation)
                    .where(eq(runReservation.runId, runId))
                    .limit(1)
                )[0] ??
                null;

              if (!reservation || reservation.state === "released") {
                return reservation;
              }

              await tx
                .insert(runUsage)
                .values({ runId, tenant })
                .onConflictDoNothing();
              return reservation;
            },
            markReleased: async (runId, releasedAt) => {
              const [updated] = await tx
                .update(runReservation)
                .set({ releasedAt, state: "released" })
                .where(
                  and(
                    eq(runReservation.runId, runId),
                    eq(runReservation.state, "reserved")
                  )
                )
                .returning();

              if (updated) {
                return updated;
              }

              const [reservation] = await tx
                .select()
                .from(runReservation)
                .where(eq(runReservation.runId, runId))
                .limit(1);
              return reservation ?? null;
            },
            releaseExpired: async (now) => {
              await tx
                .update(runReservation)
                .set({ releasedAt: now, state: "released" })
                .where(
                  and(
                    eq(runReservation.state, "reserved"),
                    lte(runReservation.expiresAt, now)
                  )
                );
            },
          }),
        config
      ),
  };
}

export async function reserveRun(
  database: RunReservationDatabase,
  input: {
    costUnits?: number;
    globalDailyCap: number;
    keySecret: string;
    now?: Date;
    periodStart: Date;
    reservationTtlMs?: number;
    runId: string;
    tenant: string;
    tenantDailyCap?: number;
    tenantMonthlyCap?: number;
  }
): Promise<ReserveRunResult> {
  const now = input.now ?? new Date();
  const costUnits = input.costUnits ?? RUN_MINUTE_RESERVATION;
  const tenantDailyCap = input.tenantDailyCap ?? TENANT_DAILY_MINUTE_CAP;
  const tenantMonthlyCap = input.tenantMonthlyCap ?? MONTHLY_MINUTE_CAP;
  const reservationTtlMs = input.reservationTtlMs ?? RUN_RESERVATION_TTL_MS;

  validateReservationInput({
    costUnits,
    globalDailyCap: input.globalDailyCap,
    now,
    periodStart: input.periodStart,
    reservationTtlMs,
    runId: input.runId,
    tenant: input.tenant,
    tenantDailyCap,
    tenantMonthlyCap,
  });

  const periodDay = dayKey(now);
  const tenantHash = tenantHashForReservation(input.tenant, input.keySecret);

  return await withSerializableRetry(database, async (tx) => {
    await tx.releaseExpired(now);

    const existing = await tx.findByRunId(input.runId);
    if (existing) {
      return { kind: "existing", reservation: existing };
    }
    if (await tx.hasUsageRunId(input.runId)) {
      return { kind: "conflict", reason: "run_already_counted" };
    }

    const tenantDailyUnits = await tx.activeUnits({
      now,
      periodDay,
      tenant: input.tenant,
      tenantHash,
    });
    if (tenantDailyUnits + costUnits > tenantDailyCap) {
      return {
        cap: tenantDailyCap,
        kind: "refused",
        reason: "tenant_daily_cap",
        used: tenantDailyUnits,
      };
    }

    const tenantMonthlyUnits = await tx.activeUnits({
      now,
      periodMonth: input.periodStart,
      tenant: input.tenant,
      tenantHash,
    });
    if (tenantMonthlyUnits + costUnits > tenantMonthlyCap) {
      return {
        cap: tenantMonthlyCap,
        kind: "refused",
        reason: "tenant_monthly_cap",
        used: tenantMonthlyUnits,
      };
    }

    const globalDailyUnits = await tx.activeUnits({ now, periodDay });
    if (globalDailyUnits + costUnits > input.globalDailyCap) {
      return { kind: "refused", reason: "global_daily_cap" };
    }

    const reservation: RunReservationRecord = {
      consumedAt: null,
      costUnits,
      durationSeconds: null,
      expiresAt: new Date(now.getTime() + reservationTtlMs),
      periodDay,
      periodMonth: input.periodStart,
      releasedAt: null,
      reservedAt: now,
      reservedUnits: costUnits,
      runId: input.runId,
      settledAt: null,
      state: "reserved",
      tenantHash,
    };
    await tx.insert(reservation);

    return { kind: "reserved", reservation };
  });
}

export async function consumeRunReservation(
  database: RunReservationDatabase,
  input: { consumedAt?: Date; runId: string; tenant: string }
): Promise<
  | { kind: "consumed"; reservation: RunReservationRecord }
  | { kind: "missing" }
  | { kind: "released"; reservation: RunReservationRecord }
> {
  const consumedAt = input.consumedAt ?? new Date();
  return await withSerializableRetry(database, async (tx) => {
    await tx.releaseExpired(consumedAt);
    const reservation = await tx.markConsumed(
      input.runId,
      input.tenant,
      consumedAt
    );
    if (!reservation) {
      return { kind: "missing" };
    }

    if (reservation.state === "released") {
      return { kind: "released", reservation };
    }
    return { kind: "consumed", reservation };
  });
}

/**
 * Deletes only an unconsumed reservation. It is used when credential
 * preparation failed before a command could become authoritative, allowing a
 * retry to reserve the same durable run identifier without consuming capacity.
 */
export async function discardRunReservation(
  database: RunReservationDatabase,
  input: { runId: string }
): Promise<RunReservationRecord | null> {
  return await withSerializableRetry(database, (tx) =>
    tx.discardReserved(input.runId)
  );
}

/**
 * Reverses a just-consumed reservation only after provider cleanup proves no
 * command launched. The usage row and reservation state change in the same
 * serializable transaction, preventing an unlaunched run from being billed.
 */
export async function compensateRunReservation(
  database: RunReservationDatabase,
  input: { compensatedAt?: Date; runId: string; tenant: string }
): Promise<
  | { kind: "compensated"; reservation: RunReservationRecord }
  | { kind: "missing" }
  | { kind: "not_consumed"; reservation: RunReservationRecord }
> {
  const reservation = await withSerializableRetry(database, (tx) =>
    tx.compensateConsumed(
      input.runId,
      input.tenant,
      input.compensatedAt ?? new Date()
    )
  );
  if (!reservation) {
    return { kind: "missing" };
  }
  return reservation.state === "released"
    ? { kind: "compensated", reservation }
    : { kind: "not_consumed", reservation };
}

export async function releaseRunReservation(
  database: RunReservationDatabase,
  input: { releasedAt?: Date; runId: string }
): Promise<RunReservationRecord | null> {
  const releasedAt = input.releasedAt ?? new Date();
  return await withSerializableRetry(database, (tx) =>
    tx.markReleased(input.runId, releasedAt)
  );
}

export async function reservationUsage(
  database: RunReservationDatabase,
  input: {
    globalDailyCap: number;
    keySecret: string;
    now?: Date;
    periodStart: Date;
    tenant: string;
    tenantDailyCap?: number;
    tenantMonthlyCap?: number;
  }
): Promise<{
  globalAdmissionClosed: boolean;
  tenantDailyRemaining: number;
  tenantMonthlyRemaining: number;
}> {
  const now = input.now ?? new Date();
  const tenantDailyCap = input.tenantDailyCap ?? TENANT_DAILY_MINUTE_CAP;
  const tenantMonthlyCap = input.tenantMonthlyCap ?? MONTHLY_MINUTE_CAP;
  validatePositiveInteger(input.globalDailyCap, "globalDailyCap");
  validatePositiveInteger(tenantDailyCap, "tenantDailyCap");
  validatePositiveInteger(tenantMonthlyCap, "tenantMonthlyCap");

  const periodDay = dayKey(now);
  const tenantHash = tenantHashForReservation(input.tenant, input.keySecret);

  return await withSerializableRetry(database, async (tx) => {
    await tx.releaseExpired(now);
    const [tenantDailyUnits, tenantMonthlyUnits, globalDailyUnits] =
      await Promise.all([
        tx.activeUnits({
          now,
          periodDay,
          tenant: input.tenant,
          tenantHash,
        }),
        tx.activeUnits({
          now,
          periodMonth: input.periodStart,
          tenant: input.tenant,
          tenantHash,
        }),
        tx.activeUnits({ now, periodDay }),
      ]);

    return {
      globalAdmissionClosed: globalDailyUnits >= input.globalDailyCap,
      tenantDailyRemaining: Math.max(0, tenantDailyCap - tenantDailyUnits),
      tenantMonthlyRemaining: Math.max(
        0,
        tenantMonthlyCap - tenantMonthlyUnits
      ),
    };
  });
}

export type RunReservationSettlement = Readonly<{
  costUnits: number;
  durationSeconds: number;
}>;

/**
 * What a finished run should be charged, in whole minutes.
 *
 * Rounds up: a run that used any part of a minute pays for that minute, which
 * is how the sandbox provider bills too. Never below one minute, because the
 * run did launch, and never above what admission reserved, because a charge
 * above the reservation could push a tenant past a cap that admission had
 * already checked.
 *
 * Returns null when the timestamps cannot describe a duration. The caller
 * leaves the reservation at its full reserved amount in that case: an
 * unmeasurable run is charged as the longest run it could have been, which
 * fails closed rather than handing out free minutes on a bookkeeping gap.
 */
export function settledRunMinutes(input: {
  completedAt: Date | null | undefined;
  reservedUnits: number;
  startedAt: Date | null | undefined;
}): RunReservationSettlement | null {
  const { completedAt, reservedUnits, startedAt } = input;
  if (
    !(startedAt instanceof Date && completedAt instanceof Date) ||
    Number.isNaN(startedAt.getTime()) ||
    Number.isNaN(completedAt.getTime()) ||
    completedAt.getTime() < startedAt.getTime() ||
    !Number.isSafeInteger(reservedUnits) ||
    reservedUnits <= 0
  ) {
    return null;
  }
  const durationSeconds = Math.ceil(
    (completedAt.getTime() - startedAt.getTime()) / 1000
  );
  const minutes = Math.ceil(durationSeconds / 60);
  return {
    costUnits: Math.min(reservedUnits, Math.max(1, minutes)),
    durationSeconds,
  };
}

export function tenantHashForReservation(
  tenant: string,
  keySecret: string
): string {
  if (!tenant.trim()) {
    throw new Error("tenant is required for a run reservation");
  }
  return createHmac("sha256", requireNonemptyAbuseKeySecret(keySecret))
    .update(tenant)
    .digest("hex");
}

function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

async function withSerializableRetry<T>(
  database: RunReservationDatabase,
  callback: (tx: RunReservationTransaction) => Promise<T>,
  attemptsRemaining = SERIALIZATION_RETRIES
): Promise<T> {
  try {
    return await database.transaction(callback, SERIALIZABLE);
  } catch (error) {
    if (!isRetryableTransactionFailure(error) || attemptsRemaining <= 1) {
      throw error;
    }
    return await withSerializableRetry(
      database,
      callback,
      attemptsRemaining - 1
    );
  }
}

function isRetryableTransactionFailure(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;

  for (let depth = 0; depth < ERROR_CAUSE_DEPTH_LIMIT; depth += 1) {
    if (typeof current !== "object" || current === null || seen.has(current)) {
      return false;
    }
    seen.add(current);

    if (
      "code" in current &&
      typeof current.code === "string" &&
      RETRYABLE_POSTGRES_CODES.has(current.code)
    ) {
      return true;
    }

    current = "cause" in current ? current.cause : undefined;
  }

  return false;
}

function validateReservationInput(input: {
  costUnits: number;
  globalDailyCap: number;
  now: Date;
  periodStart: Date;
  reservationTtlMs: number;
  runId: string;
  tenant: string;
  tenantDailyCap: number;
  tenantMonthlyCap: number;
}): void {
  if (!input.runId || input.runId.length > 64) {
    throw new Error("runId must contain between 1 and 64 characters");
  }
  if (!input.tenant.trim()) {
    throw new Error("tenant is required for a run reservation");
  }
  if (
    Number.isNaN(input.now.getTime()) ||
    Number.isNaN(input.periodStart.getTime())
  ) {
    throw new Error("reservation timestamps must be valid dates");
  }

  validatePositiveInteger(input.costUnits, "costUnits");
  validatePositiveInteger(input.globalDailyCap, "globalDailyCap");
  validatePositiveInteger(input.reservationTtlMs, "reservationTtlMs");
  validatePositiveInteger(input.tenantDailyCap, "tenantDailyCap");
  validatePositiveInteger(input.tenantMonthlyCap, "tenantMonthlyCap");
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}
