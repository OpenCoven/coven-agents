import "server-only";

import { isCanonicalUuid } from "@/lib/session";

/** Rows locked per transaction. Small, so Stripe latency holds few locks. */
export const USAGE_METERING_BATCH_SIZE = 50;
/** Batches per invocation, so one scheduled run is bounded in wall time. */
export const USAGE_METERING_MAX_BATCHES = 20;
/**
 * Stripe accepts meter event timestamps up to 35 calendar days in the past.
 * Staying a day inside that window keeps a late report from being rejected
 * at the boundary; an older settlement is reported at the current time so it
 * is still billed, just on the current invoice.
 */
export const USAGE_METERING_TIMESTAMP_WINDOW_MS = 34 * 86_400_000;
const MAX_METER_EVENT_NAME_LENGTH = 100;

export type UsageMeteringOutcome = "reported" | "no_customer" | "not_billable";

export type UnmeteredRun = Readonly<{
  costUnits: number;
  runId: string;
  settledAt: Date;
  /** Raw tenant from the usage receipt; null when no receipt was counted. */
  tenant: string | null;
}>;

export interface UsageMeteringTransaction {
  /** Settled, consumed, unreported rows, oldest first, locked and skipped if held. */
  lockUnmetered: (limit: number) => Promise<UnmeteredRun[]>;
  markMetered: (
    runId: string,
    outcome: UsageMeteringOutcome,
    meteredAt: Date
  ) => Promise<boolean>;
  stripeCustomerIdForUser: (userId: string) => Promise<string | null>;
}

export interface UsageMeteringStore {
  transaction: <T>(
    callback: (transaction: UsageMeteringTransaction) => Promise<T>
  ) => Promise<T>;
}

export interface UsageMeteringProvider {
  createMeterEvent: (
    input: Readonly<{
      customerId: string;
      eventName: string;
      identifier: string;
      timestamp: Date;
      value: number;
    }>
  ) => Promise<void>;
}

/** The Stripe key cannot write meter events; retrying will not help. */
export class UsageMeteringProviderUnauthorizedError extends Error {
  constructor() {
    super("Stripe rejected the usage reporting credential.");
    this.name = "UsageMeteringProviderUnauthorizedError";
  }
}

export type UsageMeteringResult = Readonly<{
  batches: number;
  noCustomer: number;
  notBillable: number;
  reported: number;
  scanned: number;
  stopped: "batch_limit" | "drained" | "provider_failure";
}>;

/**
 * Inverts `tenantForUser`. Only subscriber tenants (`u_` plus the packed
 * uuid) map back to an account; demo tenants and anything unexpected are
 * never billable, so they return null rather than a guess.
 */
export function userIdForTenant(tenant: string | null): string | null {
  if (!tenant || !/^u_[0-9a-f]{32}$/u.test(tenant)) {
    return null;
  }
  const hex = tenant.slice(2);
  const userId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return isCanonicalUuid(userId) ? userId : null;
}

/** The instant Stripe is told the usage happened. */
export function meterEventTimestamp(settledAt: Date, now: Date): Date {
  return now.getTime() - settledAt.getTime() >
    USAGE_METERING_TIMESTAMP_WINDOW_MS
    ? now
    : settledAt;
}

/**
 * Hands settled run minutes to Stripe as meter events, once each.
 *
 * Runs are billed only after settlement: the tenant pays the minutes the run
 * measurably held, never the reservation. Each row is locked, reported, and
 * marked inside one transaction, and the meter event identifier is the run
 * id, so a crash between Stripe accepting the event and the mark committing
 * is repaired by Stripe's own identifier deduplication on the retry.
 *
 * A provider failure stops the invocation after committing the rows already
 * marked; the unreported rows stay pending for the next schedule. A
 * credential rejection propagates so the operator hears about it.
 */
export async function meterSettledUsage(input: {
  batchSize?: number;
  eventName: string;
  maxBatches?: number;
  now?: Date;
  provider: UsageMeteringProvider;
  store: UsageMeteringStore;
}): Promise<UsageMeteringResult> {
  const batchSize = input.batchSize ?? USAGE_METERING_BATCH_SIZE;
  const maxBatches = input.maxBatches ?? USAGE_METERING_MAX_BATCHES;
  const eventName = input.eventName.trim();
  if (
    !eventName ||
    eventName.length > MAX_METER_EVENT_NAME_LENGTH ||
    !Number.isSafeInteger(batchSize) ||
    batchSize <= 0 ||
    !Number.isSafeInteger(maxBatches) ||
    maxBatches <= 0
  ) {
    throw new Error("Usage metering configuration is invalid.");
  }

  const counts = { noCustomer: 0, notBillable: 0, reported: 0, scanned: 0 };
  let batches = 0;
  while (batches < maxBatches) {
    batches += 1;
    const now = input.now ?? new Date();
    // biome-ignore lint/performance/noAwaitInLoops: Each batch must commit before the next is locked.
    const batch = await input.store.transaction(async (transaction) => {
      const rows = await transaction.lockUnmetered(batchSize);
      for (const row of rows) {
        counts.scanned += 1;
        const userId = userIdForTenant(row.tenant);
        if (!userId) {
          // biome-ignore lint/performance/noAwaitInLoops: Rows are reported and marked in order inside one locking transaction.
          await mark(transaction, row.runId, "not_billable", now);
          counts.notBillable += 1;
          continue;
        }
        const customerId = await transaction.stripeCustomerIdForUser(userId);
        if (!customerId) {
          await mark(transaction, row.runId, "no_customer", now);
          counts.noCustomer += 1;
          continue;
        }
        try {
          await input.provider.createMeterEvent({
            customerId,
            eventName,
            identifier: `run:${row.runId}`,
            timestamp: meterEventTimestamp(row.settledAt, now),
            value: row.costUnits,
          });
        } catch (error) {
          if (error instanceof UsageMeteringProviderUnauthorizedError) {
            throw error;
          }
          return { failed: true, size: rows.length };
        }
        await mark(transaction, row.runId, "reported", now);
        counts.reported += 1;
      }
      return { failed: false, size: rows.length };
    });
    if (batch.failed) {
      return { ...counts, batches, stopped: "provider_failure" };
    }
    if (batch.size < batchSize) {
      return { ...counts, batches, stopped: "drained" };
    }
  }
  return { ...counts, batches, stopped: "batch_limit" };
}

async function mark(
  transaction: UsageMeteringTransaction,
  runId: string,
  outcome: UsageMeteringOutcome,
  meteredAt: Date
): Promise<void> {
  if (!(await transaction.markMetered(runId, outcome, meteredAt))) {
    throw new Error("Usage metering mark was rejected.");
  }
}
