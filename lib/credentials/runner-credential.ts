import "server-only";

import { inspect } from "node:util";
import {
  compensateRunReservation,
  consumeRunReservation,
  discardRunReservation,
  drizzleRunReservationDatabase,
  type ReserveRunResult,
  reserveRun,
} from "@/lib/billing/run-reservations";
import type { databaseFor } from "@/lib/db/access";
import type { HarnessCredential } from "@/lib/runner/harness";
import {
  CredentialLeaseDeniedError,
  consumeCredentialLease,
  drizzleCredentialLeaseDatabase,
  issueCredentialLease,
  releaseCredentialLease,
  releaseCredentialLeaseForRun,
} from "./leases";
import {
  prepareCredentialForTenant,
  readCredentialForTenantWithoutRefresh,
} from "./store";
import type { CredentialStoreDatabase } from "./store-core";

type ProductionDatabase = ReturnType<typeof databaseFor>;
type ReservationInput = Parameters<typeof reserveRun>[1];
type LeaseInput = Parameters<typeof issueCredentialLease>[1];

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
  compensateReservation: (
    input: Parameters<typeof compensateRunReservation>[1]
  ) => ReturnType<typeof compensateRunReservation>;
  consumeReservation: (
    input: Parameters<typeof consumeRunReservation>[1]
  ) => ReturnType<typeof consumeRunReservation>;
  discardReservation: (
    input: Parameters<typeof discardRunReservation>[1]
  ) => ReturnType<typeof discardRunReservation>;
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
  releaseLease: (input: LeaseInput) => Promise<boolean>;
  releaseLeaseForRun: (runId: string) => Promise<boolean>;
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
    | "compensateReservation"
    | "consumeReservation"
    | "discardReservation"
    | "releaseLease"
  >;
  readonly #leaseInput: LeaseInput;
  #state: AcquisitionState = "available";

  constructor(
    plaintext: string,
    leaseInput: LeaseInput,
    dependencies: Pick<
      RunnerCredentialDependencies,
      | "compensateReservation"
      | "consumeReservation"
      | "discardReservation"
      | "releaseLease"
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
    const [lease, reservation] = await Promise.allSettled([
      this.#dependencies.releaseLease(this.#leaseInput),
      this.#dependencies.discardReservation({
        runId: this.#leaseInput.runId,
      }),
    ]);
    if (
      lease.status !== "fulfilled" ||
      lease.value !== true ||
      reservation.status !== "fulfilled" ||
      reservation.value === null
    ) {
      throw new RunnerCredentialServiceError(
        "cleanup_pending",
        "Runner credential cleanup could not be confirmed.",
        true
      );
    }
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
    try {
      if (!(await this.#dependencies.releaseLease(this.#leaseInput))) {
        throw new Error("Runner credential lease cleanup was rejected.");
      }
    } catch {
      // biome-ignore lint/style/useErrorCause: Credential lease errors can contain encrypted metadata.
      throw new RunnerCredentialServiceError(
        "cleanup_pending",
        "Runner credential cleanup could not be confirmed.",
        true
      );
    }
    let compensation: Awaited<
      ReturnType<RunnerCredentialDependencies["compensateReservation"]>
    >;
    try {
      compensation = await this.#dependencies.compensateReservation({
        runId: this.#leaseInput.runId,
        tenant: this.#leaseInput.tenant,
      });
    } catch {
      // biome-ignore lint/style/useErrorCause: Reservation errors can contain encrypted metadata.
      throw new RunnerCredentialServiceError(
        "cleanup_pending",
        "Runner reservation compensation could not be confirmed.",
        true
      );
    }
    if (compensation.kind === "missing") {
      throw new RunnerCredentialServiceError(
        "cleanup_pending",
        "Runner reservation compensation could not be confirmed.",
        true
      );
    }
    if (compensation.kind === "not_consumed") {
      try {
        if (
          !(await this.#dependencies.discardReservation({
            runId: this.#leaseInput.runId,
          }))
        ) {
          throw new Error("Runner reservation cleanup was rejected.");
        }
      } catch {
        // biome-ignore lint/style/useErrorCause: Reservation errors can contain encrypted metadata.
        throw new RunnerCredentialServiceError(
          "cleanup_pending",
          "Runner reservation cleanup could not be confirmed.",
          true
        );
      }
    }
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
  dependencies: Pick<
    RunnerCredentialDependencies,
    "discardReservation" | "releaseLease"
  >,
  leaseInput: LeaseInput
): Promise<RunnerCredentialServiceError | null> {
  const [lease, reservation] = await Promise.allSettled([
    dependencies.releaseLease(leaseInput),
    dependencies.discardReservation({ runId: leaseInput.runId }),
  ]);
  return lease.status !== "fulfilled" ||
    lease.value !== true ||
    reservation.status !== "fulfilled" ||
    reservation.value === null
    ? new RunnerCredentialServiceError(
        "cleanup_pending",
        "Runner credential cleanup could not be confirmed.",
        true
      )
    : null;
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
 * Releases a reservation/lease only when a process never reached durable
 * launch. Both operations are exact-run and idempotent; failures are surfaced
 * so callers retain their recovery ownership instead of silently requeueing.
 */
export async function releaseRunnerCredentialResources(
  runId: string,
  dependencies: Pick<
    RunnerCredentialDependencies,
    "discardReservation" | "releaseLeaseForRun"
  >
): Promise<void> {
  const [lease, reservation] = await Promise.allSettled([
    dependencies.releaseLeaseForRun(runId),
    dependencies.discardReservation({ runId }),
  ]);
  if (lease.status === "rejected" || reservation.status === "rejected") {
    throw new RunnerCredentialServiceError(
      "cleanup_pending",
      "Runner credential cleanup could not be confirmed.",
      true
    );
  }
}

/**
 * Removes capacity accounting only after caller-confirmed provider absence.
 * It is intentionally distinct from terminal cleanup: a command that did
 * launch remains consumed even when its credential lease is retired.
 */
export async function rollbackRunnerCredentialResources(
  input: Readonly<{ runId: string; tenant: string }>,
  dependencies: Pick<
    RunnerCredentialDependencies,
    "compensateReservation" | "discardReservation" | "releaseLeaseForRun"
  >
): Promise<void> {
  try {
    await dependencies.releaseLeaseForRun(input.runId);
    const compensation = await dependencies.compensateReservation({
      runId: input.runId,
      tenant: input.tenant,
    });
    if (compensation.kind === "not_consumed") {
      await dependencies.discardReservation({ runId: input.runId });
    }
  } catch {
    // biome-ignore lint/style/useErrorCause: Cleanup errors can contain encrypted metadata.
    throw new RunnerCredentialServiceError(
      "cleanup_pending",
      "Runner pre-launch cleanup could not be confirmed.",
      true
    );
  }
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
  const reservations = drizzleRunReservationDatabase(database);
  const leases = drizzleCredentialLeaseDatabase(database);
  return {
    compensateReservation: (input) =>
      compensateRunReservation(reservations, input),
    consumeReservation: (input) => consumeRunReservation(reservations, input),
    discardReservation: (input) => discardRunReservation(reservations, input),
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
    releaseLease: (input) => releaseCredentialLease(leases, input),
    releaseLeaseForRun: (runId) => releaseCredentialLeaseForRun(leases, runId),
    reserveRun: (input) => reserveRun(reservations, input),
  };
}
