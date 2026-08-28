import "server-only";

import { inspect } from "node:util";
import { and, eq } from "drizzle-orm";
import {
  consumeRunReservation,
  drizzleRunReservationDatabase,
  type ReserveRunResult,
  reserveRun,
} from "@/lib/billing/run-reservations";
import type { databaseFor } from "@/lib/db/access";
import {
  type CredentialLease,
  credentialLease,
  type RunReservation,
  runReservation,
  runUsage,
} from "@/lib/db/schema";
import type { HarnessCredential } from "@/lib/runner/harness";
import {
  CredentialLeaseDeniedError,
  consumeCredentialLease,
  drizzleCredentialLeaseDatabase,
  issueCredentialLease,
} from "./leases";
import {
  prepareCredentialForTenant,
  readCredentialForTenantWithoutRefresh,
} from "./store";
import type { CredentialStoreDatabase } from "./store-core";

type ProductionDatabase = ReturnType<typeof databaseFor>;
type ReservationInput = Parameters<typeof reserveRun>[1];
type LeaseInput = Parameters<typeof issueCredentialLease>[1];
const SERIALIZABLE = { isolationLevel: "serializable" } as const;

export type RunnerCredentialCleanupInput =
  | Readonly<{ mode: "prelaunch"; runId: string; tenant: string }>
  | Readonly<{ mode: "terminal"; runId: string }>;

export type RunnerCredentialCleanupResult =
  | Readonly<{ kind: "cleaned" }>
  | Readonly<{ kind: "cleanup_pending"; retryable: true }>;

export interface RunnerCredentialCleanupTransaction {
  deleteLeaseForRun: (runId: string) => Promise<CredentialLease | null>;
  deleteReservation: (runId: string) => Promise<RunReservation | null>;
  deleteUsageForRun: (runId: string, tenant: string) => Promise<void>;
  lockReservation: (runId: string) => Promise<RunReservation | null>;
}

export interface RunnerCredentialCleanupDatabase {
  transaction: <T>(
    callback: (transaction: RunnerCredentialCleanupTransaction) => Promise<T>
  ) => Promise<T>;
}

export type RunnerCredentialAcquireInput = Omit<
  ReservationInput,
  "now" | "runId" | "tenant"
> &
  Readonly<{
    harnessId: string;
    now?: Date;
    operationId: string;
    requestId?: string;
    runId: string;
    tenant: string;
  }>;

export interface RunnerCredentialDependencies {
  cleanupResources: (
    input: RunnerCredentialCleanupInput
  ) => Promise<RunnerCredentialCleanupResult>;
  consumeReservation: (
    input: Parameters<typeof consumeRunReservation>[1]
  ) => ReturnType<typeof consumeRunReservation>;
  issueLease: (input: LeaseInput) => ReturnType<typeof issueCredentialLease>;
  leaseCredential: (
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
  reserveRun: (input: ReservationInput) => Promise<ReserveRunResult>;
}

export type RunnerCredentialFailureCode =
  | "capacity_unavailable"
  | "credential_lease_unavailable"
  | "credential_unavailable"
  | "cleanup_pending"
  | "no_credential"
  | "reservation_unavailable";

/**
 * Sanitized orchestration failure. It intentionally has no provider/database
 * cause because those errors can contain encrypted credential metadata.
 */
export class RunnerCredentialServiceError extends Error {
  readonly code: RunnerCredentialFailureCode;
  readonly retryable: boolean;

  constructor(
    code: RunnerCredentialFailureCode,
    message: string,
    retryable: boolean
  ) {
    super(message);
    this.name = "RunnerCredentialServiceError";
    this.code = code;
    this.retryable = retryable;
  }
}

function cleanupPendingError(): RunnerCredentialServiceError {
  return new RunnerCredentialServiceError(
    "cleanup_pending",
    "Runner credential cleanup could not be confirmed.",
    true
  );
}

export function drizzleRunnerCredentialCleanupDatabase(
  database: ProductionDatabase
): RunnerCredentialCleanupDatabase {
  return {
    transaction: (callback) =>
      database.transaction(
        async (transaction) =>
          callback({
            deleteLeaseForRun: async (runId) => {
              const [deleted] = await transaction
                .delete(credentialLease)
                .where(eq(credentialLease.runId, runId))
                .returning();
              return deleted ?? null;
            },
            deleteReservation: async (runId) => {
              const [deleted] = await transaction
                .delete(runReservation)
                .where(eq(runReservation.runId, runId))
                .returning();
              return deleted ?? null;
            },
            deleteUsageForRun: async (runId, tenant) => {
              await transaction
                .delete(runUsage)
                .where(
                  and(eq(runUsage.runId, runId), eq(runUsage.tenant, tenant))
                );
            },
            lockReservation: async (runId) => {
              const [reservation] = await transaction
                .select()
                .from(runReservation)
                .where(eq(runReservation.runId, runId))
                .for("update")
                .limit(1);
              return reservation ?? null;
            },
          }),
        SERIALIZABLE
      ),
  };
}

/**
 * Locks the reservation before deleting its credential lease. A concurrent
 * consumer must wait for this transaction, then finds no lease/reservation and
 * cannot launch using accounting that is being rolled back.
 */
export async function cleanupRunnerCredentialResourcesAtomically(
  database: RunnerCredentialCleanupDatabase,
  input: RunnerCredentialCleanupInput
): Promise<RunnerCredentialCleanupResult> {
  try {
    await database.transaction(async (transaction) => {
      const reservation = await transaction.lockReservation(input.runId);
      await transaction.deleteLeaseForRun(input.runId);
      if (input.mode === "prelaunch") {
        await transaction.deleteUsageForRun(input.runId, input.tenant);
      }
      if (
        reservation &&
        (input.mode === "prelaunch" || reservation.state !== "consumed") &&
        !(await transaction.deleteReservation(input.runId))
      ) {
        throw new Error("Runner reservation cleanup was rejected.");
      }
    });
    return { kind: "cleaned" };
  } catch {
    return { kind: "cleanup_pending", retryable: true };
  }
}

async function completeCredentialCleanup(
  input: RunnerCredentialCleanupInput,
  dependencies: Pick<RunnerCredentialDependencies, "cleanupResources">
): Promise<void> {
  let result: RunnerCredentialCleanupResult;
  try {
    result = await dependencies.cleanupResources(input);
  } catch {
    // biome-ignore lint/style/useErrorCause: Cleanup adapters can expose database metadata.
    throw cleanupPendingError();
  }
  if (result.kind !== "cleaned") {
    throw cleanupPendingError();
  }
}

/**
 * Removes the exact one-use lease, reservation, and any counted usage after
 * confirmed provider absence. The atomic cleanup makes the same run eligible
 * for a fresh reservation on redispatch.
 */
export async function compensateRunnerCredentialReservation(
  input: Readonly<{ runId: string; tenant: string }>,
  dependencies: Pick<RunnerCredentialDependencies, "cleanupResources">
): Promise<void> {
  await completeCredentialCleanup(
    { mode: "prelaunch", runId: input.runId, tenant: input.tenant },
    dependencies
  );
}

export type RunnerCredentialAcquireResult =
  | { acquisition: RunnerCredentialAcquisition; kind: "acquired" }
  | { kind: "already_consumed" | "released" | "reservation_pending" }
  | {
      cap?: number;
      kind: "refused";
      reason: "global_daily_cap" | "tenant_daily_cap" | "tenant_monthly_cap";
      used?: number;
    }
  | { error: RunnerCredentialServiceError; kind: "unavailable" };

/**
 * The plaintext is intentionally available only as an argument to one start
 * boundary. Private fields plus safe serializers prevent accidental logging.
 */
class OneUseRunnerCredential {
  #plaintext: string | undefined;
  #used = false;

  constructor(plaintext: string) {
    this.#plaintext = plaintext;
  }

  async use<T>(
    boundary: (credential: HarnessCredential) => Promise<T> | T
  ): Promise<T> {
    if (this.#used || this.#plaintext === undefined) {
      throw new RunnerCredentialServiceError(
        "credential_unavailable",
        "The runner credential has already been used.",
        false
      );
    }
    this.#used = true;
    const plaintext = this.#plaintext;
    try {
      return await boundary({ credential: plaintext });
    } finally {
      this.#plaintext = undefined;
    }
  }

  toJSON(): string {
    return "[runner credential redacted]";
  }

  [inspect.custom](): string {
    return "OneUseRunnerCredential { [redacted] }";
  }
}

type AcquisitionState = "available" | "aborted" | "committed" | "compensated";

export class RunnerCredentialAcquisition {
  readonly #credential: OneUseRunnerCredential;
  readonly #dependencies: Pick<
    RunnerCredentialDependencies,
    "cleanupResources" | "consumeReservation"
  >;
  readonly #leaseInput: LeaseInput;
  #state: AcquisitionState = "available";

  constructor(
    plaintext: string,
    leaseInput: LeaseInput,
    dependencies: Pick<
      RunnerCredentialDependencies,
      "cleanupResources" | "consumeReservation"
    >
  ) {
    this.#credential = new OneUseRunnerCredential(plaintext);
    this.#leaseInput = leaseInput;
    this.#dependencies = dependencies;
  }

  async use<T>(
    boundary: (credential: HarnessCredential) => Promise<T> | T
  ): Promise<T> {
    if (this.#state !== "committed") {
      throw new RunnerCredentialServiceError(
        "reservation_unavailable",
        "The runner reservation must be committed before provider launch.",
        false
      );
    }
    return await this.#credential.use(boundary);
  }

  /**
   * Establish billing before Daytona can attach a command. A proven
   * pre-launch failure must compensate this transition; this ordering keeps
   * a command from becoming durably attached without capacity accounting.
   * Repeated calls are harmless, which makes recovery safe.
   */
  async commit(): Promise<void> {
    if (this.#state === "committed") {
      return;
    }
    if (this.#state === "aborted" || this.#state === "compensated") {
      throw new RunnerCredentialServiceError(
        "reservation_unavailable",
        "The runner reservation was released before launch.",
        false
      );
    }
    let consumed: Awaited<
      ReturnType<RunnerCredentialDependencies["consumeReservation"]>
    >;
    try {
      consumed = await this.#dependencies.consumeReservation({
        runId: this.#leaseInput.runId,
        tenant: this.#leaseInput.tenant,
      });
    } catch {
      // biome-ignore lint/style/useErrorCause: Database errors can contain credential metadata.
      throw new RunnerCredentialServiceError(
        "reservation_unavailable",
        "Run capacity could not be committed before provider launch.",
        true
      );
    }
    if (consumed.kind !== "consumed") {
      throw new RunnerCredentialServiceError(
        "reservation_unavailable",
        "Run capacity was no longer available before provider launch.",
        true
      );
    }
    this.#state = "committed";
  }

  /**
   * Releases both exact resources if a command never became durably attached.
   * A cleanup failure is surfaced rather than hidden so reconciliation can
   * retain/retry the run safely.
   */
  async abort(): Promise<void> {
    if (
      this.#state === "aborted" ||
      this.#state === "committed" ||
      this.#state === "compensated"
    ) {
      return;
    }
    await compensateRunnerCredentialReservation(
      { runId: this.#leaseInput.runId, tenant: this.#leaseInput.tenant },
      this.#dependencies
    );
    this.#state = "aborted";
  }

  /**
   * Reverses an accounting transition only after process startup proved no
   * command became authoritative. It is safe to retry after an ambiguous
   * billing commit because compensation atomically removes the usage row.
   */
  async compensate(): Promise<void> {
    if (this.#state === "compensated") {
      return;
    }
    if (this.#state === "aborted") {
      return;
    }
    await compensateRunnerCredentialReservation(
      { runId: this.#leaseInput.runId, tenant: this.#leaseInput.tenant },
      this.#dependencies
    );
    this.#state = "compensated";
  }

  toJSON(): string {
    return "[runner credential acquisition redacted]";
  }

  [inspect.custom](): string {
    return "RunnerCredentialAcquisition { [redacted] }";
  }
}

function reservationOutcome(
  decision: ReserveRunResult
): Exclude<RunnerCredentialAcquireResult, { acquisition: unknown }> | null {
  if (decision.kind === "reserved") {
    return null;
  }
  if (decision.kind === "existing") {
    return decision.reservation.state === "consumed"
      ? { kind: "already_consumed" }
      : decision.reservation.state === "released"
        ? { kind: "released" }
        : { kind: "reservation_pending" };
  }
  if (decision.kind === "conflict") {
    return { kind: "already_consumed" };
  }
  return {
    cap: "cap" in decision ? decision.cap : undefined,
    kind: "refused",
    reason: decision.reason,
    used: "used" in decision ? decision.used : undefined,
  };
}

function leaseDeniedError(error: unknown): RunnerCredentialServiceError {
  if (error instanceof CredentialLeaseDeniedError) {
    return new RunnerCredentialServiceError(
      "credential_lease_unavailable",
      "Runner credential lease could not be acquired.",
      error.reason === "missing_reservation" ||
        error.reason === "reservation_unavailable" ||
        error.reason === "expired"
    );
  }
  return new RunnerCredentialServiceError(
    "credential_unavailable",
    "Runner credential could not be prepared.",
    true
  );
}

async function releasePreLaunchResources(
  dependencies: Pick<RunnerCredentialDependencies, "cleanupResources">,
  leaseInput: LeaseInput
): Promise<RunnerCredentialServiceError | null> {
  try {
    await compensateRunnerCredentialReservation(
      { runId: leaseInput.runId, tenant: leaseInput.tenant },
      dependencies
    );
    return null;
  } catch (error) {
    return error instanceof RunnerCredentialServiceError
      ? error
      : cleanupPendingError();
  }
}

/**
 * Reserves billing capacity before decrypting. The returned opaque handle
 * owns the exact one-use lease and must be committed before Daytona can
 * launch, then compensated on every proven pre-launch failure.
 */
export async function acquireRunnerCredential(
  input: RunnerCredentialAcquireInput,
  dependencies: RunnerCredentialDependencies
): Promise<RunnerCredentialAcquireResult> {
  let reservation: ReserveRunResult;
  try {
    reservation = await dependencies.reserveRun({
      costUnits: input.costUnits,
      globalDailyCap: input.globalDailyCap,
      keySecret: input.keySecret,
      now: input.now,
      periodStart: input.periodStart,
      reservationTtlMs: input.reservationTtlMs,
      runId: input.runId,
      tenant: input.tenant,
      tenantDailyCap: input.tenantDailyCap,
      tenantMonthlyCap: input.tenantMonthlyCap,
    });
  } catch {
    return {
      error: new RunnerCredentialServiceError(
        "capacity_unavailable",
        "Run capacity could not be reserved.",
        true
      ),
      kind: "unavailable",
    };
  }
  const outcome = reservationOutcome(reservation);
  if (outcome) {
    return outcome;
  }

  const leaseInput: LeaseInput = {
    harnessId: input.harnessId,
    keySecret: input.keySecret,
    now: input.now,
    operationId: input.operationId,
    requestId: input.requestId ?? input.runId,
    runId: input.runId,
    tenant: input.tenant,
  };
  try {
    const issued = await dependencies.issueLease(leaseInput);
    if (issued.kind !== "issued") {
      return { kind: "reservation_pending" };
    }
    const plaintext = await dependencies.leaseCredential(
      leaseInput,
      async () => {
        if (
          !(await dependencies.prepareCredential(
            leaseInput.tenant,
            leaseInput.harnessId
          ))
        ) {
          throw new RunnerCredentialServiceError(
            "no_credential",
            "No credential is configured for this runner.",
            false
          );
        }
      },
      (database) =>
        dependencies.readCredential(
          leaseInput.tenant,
          leaseInput.harnessId,
          database
        )
    );
    if (plaintext === null || !plaintext.trim()) {
      throw new RunnerCredentialServiceError(
        "no_credential",
        "No credential is configured for this runner.",
        false
      );
    }
    return {
      acquisition: new RunnerCredentialAcquisition(
        plaintext,
        leaseInput,
        dependencies
      ),
      kind: "acquired",
    };
  } catch (error) {
    const cleanup = await releasePreLaunchResources(dependencies, leaseInput);
    return {
      error: cleanup ?? leaseDeniedError(error),
      kind: "unavailable",
    };
  }
}

/**
 * Releases transient credential state after terminal cleanup while preserving
 * the consumed reservation for a command that did launch. Failures are
 * surfaced so callers retain their recovery ownership instead of silently
 * completing cleanup.
 */
export async function releaseRunnerCredentialResources(
  runId: string,
  dependencies: Pick<RunnerCredentialDependencies, "cleanupResources">
): Promise<void> {
  await completeCredentialCleanup({ mode: "terminal", runId }, dependencies);
}

/**
 * Removes capacity accounting only after caller-confirmed provider absence.
 * It is intentionally distinct from terminal cleanup: a command that did
 * launch remains consumed even when its credential lease is retired.
 */
export async function rollbackRunnerCredentialResources(
  input: Readonly<{ runId: string; tenant: string }>,
  dependencies: Pick<RunnerCredentialDependencies, "cleanupResources">
): Promise<void> {
  await compensateRunnerCredentialReservation(input, dependencies);
}

/**
 * Replays the idempotent billing transition for a durably attached command
 * after a dispatcher crashed between process attachment and accounting.
 */
export async function consumeRunnerCredentialReservation(
  input: Readonly<{ runId: string; tenant: string }>,
  dependencies: Pick<RunnerCredentialDependencies, "consumeReservation">
): Promise<void> {
  let consumed: Awaited<
    ReturnType<RunnerCredentialDependencies["consumeReservation"]>
  >;
  try {
    consumed = await dependencies.consumeReservation(input);
  } catch {
    // biome-ignore lint/style/useErrorCause: Database errors can contain credential metadata.
    throw new RunnerCredentialServiceError(
      "reservation_unavailable",
      "Run capacity could not be consumed.",
      true
    );
  }
  if (consumed.kind !== "consumed") {
    throw new RunnerCredentialServiceError(
      "reservation_unavailable",
      "Run capacity was no longer available.",
      true
    );
  }
}

/** Builds the server-only adapters used by Route Handlers and orchestration. */
export function drizzleRunnerCredentialDependencies(
  database: ProductionDatabase
): RunnerCredentialDependencies {
  const cleanup = drizzleRunnerCredentialCleanupDatabase(database);
  const reservations = drizzleRunReservationDatabase(database);
  const leases = drizzleCredentialLeaseDatabase(database);
  return {
    cleanupResources: (input) =>
      cleanupRunnerCredentialResourcesAtomically(cleanup, input),
    consumeReservation: (input) => consumeRunReservation(reservations, input),
    issueLease: (input) => issueCredentialLease(leases, input),
    leaseCredential: (input, prepare, operation) =>
      consumeCredentialLease(leases, input, prepare, operation, undefined, {
        consumeReservation: false,
      }),
    prepareCredential: (tenant, harnessId) =>
      database.transaction((transaction) =>
        prepareCredentialForTenant(tenant, harnessId, transaction)
      ),
    readCredential: (tenant, harnessId, credentialDatabase) =>
      readCredentialForTenantWithoutRefresh(
        tenant,
        harnessId,
        credentialDatabase
      ),
    reserveRun: (input) => reserveRun(reservations, input),
  };
}
