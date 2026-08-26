import { DurableObject } from "cloudflare:workers";
import { pseudonymousKey } from "./abuse";
import { isTerminal, OperationConflictError } from "./run-state";

export type AdmissionRecord = {
  agentId: string;
  enqueuedAt: string;
  operationId: string;
  requestHash: string;
  runId: string;
  state: "queued" | "active" | "terminal";
  tenantHash: string;
};

export type AdmissionDecision =
  | { kind: "active"; runId: string }
  | { kind: "queued"; position: number; runId: string }
  | { kind: "duplicate"; runId: string; state: "queued" | "active" }
  | { kind: "refused"; reason: "tenant_queue_full" | "global_busy" };

export type AdmissionRequest = Omit<AdmissionRecord, "enqueuedAt" | "state">;

export type AdmissionLimits = {
  tenantActiveRuns: number;
  tenantQueuedRuns: number;
  deploymentActiveRuns: number;
  consecutiveDispatches: number;
};

export const DEFAULT_ADMISSION_LIMITS: AdmissionLimits = {
  consecutiveDispatches: 2,
  deploymentActiveRuns: 25,
  tenantActiveRuns: 2,
  tenantQueuedRuns: 10,
};

const QUEUED_TTL_MS = 5 * 60 * 1000;
const ALARM_INTERVAL_MS = 30 * 1000;
const ALARM_REPAIR_RETRY_MS = 5 * 1000;
const MAX_ALARM_REPAIR_FAILURES = 3;
const DISPATCH_LEASE_MS = 60 * 1000;

type SchedulerState = {
  consecutiveDispatches: number;
  lastTenantHash: string | null;
};

const INITIAL_SCHEDULER_STATE: SchedulerState = {
  consecutiveDispatches: 0,
  lastTenantHash: null,
};

export type AdmissionDispatch = (record: AdmissionRecord) => Promise<boolean>;

type StoredAdmissionRecord = AdmissionRecord & {
  sequence: number;
};

export type AdmissionQueueOptions = {
  dispatch?: AdmissionDispatch;
  limits?: Partial<AdmissionLimits>;
  now?: () => number;
  records?: readonly (AdmissionRecord | StoredAdmissionRecord)[];
  scheduler?: Partial<SchedulerState>;
  nextSequence?: number;
};

function mergeLimits(limits: Partial<AdmissionLimits> = {}): AdmissionLimits {
  const merged = { ...DEFAULT_ADMISSION_LIMITS, ...limits };
  for (const value of Object.values(merged)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new AdmissionConfigurationError(
        "Run admission limits must be non-negative integers."
      );
    }
  }
  return merged;
}

export class AdmissionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdmissionConfigurationError";
  }
}

export class AdmissionUnavailableError extends Error {
  readonly retryable = true;

  constructor(
    message = "Run admission is temporarily unavailable.",
    options: ErrorOptions = {}
  ) {
    super(message, options);
    this.name = "AdmissionUnavailableError";
  }
}

function configuredLimit(
  env: AdmissionConfigEnvironment,
  name: keyof AdmissionConfigEnvironment,
  fallback: number
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new AdmissionConfigurationError(
      `${name} must be a non-negative integer no greater than its hard maximum.`
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > fallback) {
    throw new AdmissionConfigurationError(
      `${name} must be a non-negative integer no greater than its hard maximum.`
    );
  }
  return value;
}

type AdmissionConfigEnvironment = {
  RUN_ADMISSION_CONSECUTIVE_MAX?: string;
  RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX?: string;
  RUN_ADMISSION_MODE?: string;
  RUN_ADMISSION_TENANT_ACTIVE_MAX?: string;
  RUN_ADMISSION_TENANT_QUEUE_MAX?: string;
};

export type AdmissionEnvironment = AdmissionConfigEnvironment & {
  EDGE_ABUSE_KEY_SECRET?: string;
  YoloAgent: Env["YoloAgent"];
};

export function admissionLimits(
  env: AdmissionConfigEnvironment
): AdmissionLimits {
  return mergeLimits({
    consecutiveDispatches: configuredLimit(
      env,
      "RUN_ADMISSION_CONSECUTIVE_MAX",
      DEFAULT_ADMISSION_LIMITS.consecutiveDispatches
    ),
    deploymentActiveRuns: configuredLimit(
      env,
      "RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX",
      DEFAULT_ADMISSION_LIMITS.deploymentActiveRuns
    ),
    tenantActiveRuns: configuredLimit(
      env,
      "RUN_ADMISSION_TENANT_ACTIVE_MAX",
      DEFAULT_ADMISSION_LIMITS.tenantActiveRuns
    ),
    tenantQueuedRuns: configuredLimit(
      env,
      "RUN_ADMISSION_TENANT_QUEUE_MAX",
      DEFAULT_ADMISSION_LIMITS.tenantQueuedRuns
    ),
  });
}

export function admissionMode(
  env: Pick<AdmissionEnvironment, "RUN_ADMISSION_MODE">
): "queue" | "reject" {
  const mode = env.RUN_ADMISSION_MODE?.trim() || "queue";
  if (mode !== "queue" && mode !== "reject") {
    throw new AdmissionConfigurationError(
      "RUN_ADMISSION_MODE must be either queue or reject."
    );
  }
  return mode;
}

export function tenantAdmissionHash(
  secret: string | undefined,
  tenantId: string
): Promise<string> {
  const normalized = secret?.trim();
  if (!normalized) {
    throw new AdmissionConfigurationError(
      "EDGE_ABUSE_KEY_SECRET is required for run admission."
    );
  }
  return pseudonymousKey(normalized, `tenant:${tenantId}`);
}

function cloneRecord(record: AdmissionRecord): AdmissionRecord {
  return { ...record };
}

function assertAdmissionRequest(input: AdmissionRequest): void {
  const fields = [
    input.agentId,
    input.operationId,
    input.requestHash,
    input.runId,
    input.tenantHash,
  ];
  if (
    fields.some(
      (value) =>
        typeof value !== "string" || value.length === 0 || value.length > 256
    )
  ) {
    throw new AdmissionConfigurationError(
      "Run admission request contains an invalid identifier."
    );
  }
}

function compareQueueOrder(
  left: Pick<StoredAdmissionRecord, "enqueuedAt" | "sequence">,
  right: Pick<StoredAdmissionRecord, "enqueuedAt" | "sequence">
): number {
  const timestampOrder = left.enqueuedAt.localeCompare(right.enqueuedAt);
  return timestampOrder === 0 ? left.sequence - right.sequence : timestampOrder;
}

function queuedPosition(
  records: readonly StoredAdmissionRecord[],
  tenantHash: string,
  runId: string
): number {
  return (
    records
      .filter(
        (record) =>
          record.state === "queued" && record.tenantHash === tenantHash
      )
      .sort(compareQueueOrder)
      .findIndex((record) => record.runId === runId) + 1
  );
}

export class AdmissionQueue {
  private readonly dispatchCallback?: AdmissionDispatch;
  private readonly limits: AdmissionLimits;
  private readonly now: () => number;
  private readonly queueRecords: StoredAdmissionRecord[];
  private nextSequence: number;
  private queueScheduler: SchedulerState;

  constructor(options: AdmissionQueueOptions = {}) {
    this.dispatchCallback = options.dispatch;
    this.limits = mergeLimits(options.limits);
    this.now = options.now ?? Date.now;
    this.queueRecords = (options.records ?? []).map((record, index) => {
      const sequence =
        "sequence" in record &&
        Number.isSafeInteger(record.sequence) &&
        record.sequence > 0
          ? record.sequence
          : index + 1;
      return { ...cloneRecord(record), sequence };
    });
    const firstAvailableSequence =
      Math.max(0, ...this.queueRecords.map((record) => record.sequence)) + 1;
    this.nextSequence = Math.max(
      firstAvailableSequence,
      options.nextSequence ?? firstAvailableSequence
    );
    this.queueScheduler = {
      ...INITIAL_SCHEDULER_STATE,
      ...options.scheduler,
    };
  }

  records(): AdmissionRecord[] {
    return this.queueRecords.map(({ sequence: _sequence, ...record }) =>
      cloneRecord(record)
    );
  }

  scheduler(): SchedulerState {
    return { ...this.queueScheduler };
  }

  async admit(input: AdmissionRequest): Promise<AdmissionDecision> {
    const decision = this.admitSynchronously(input);
    if (
      this.dispatchCallback &&
      decision.kind !== "refused" &&
      decision.kind !== "duplicate"
    ) {
      await this.dispatch();
    }
    return decision.kind === "refused" || decision.kind === "duplicate"
      ? decision
      : this.decisionFor(input.runId);
  }

  admitSynchronously(input: AdmissionRequest): AdmissionDecision {
    assertAdmissionRequest(input);
    const existing = this.queueRecords.find(
      (candidate) => candidate.operationId === input.operationId
    );
    if (existing) {
      if (existing.requestHash !== input.requestHash) {
        throw new OperationConflictError();
      }
      if (existing.state !== "terminal") {
        return {
          kind: "duplicate",
          runId: existing.runId,
          state: existing.state,
        };
      }
      this.remove(existing.runId);
    }

    if (this.activeCount() >= this.limits.deploymentActiveRuns) {
      return { kind: "refused", reason: "global_busy" };
    }
    if (this.queuedCount(input.tenantHash) >= this.limits.tenantQueuedRuns) {
      return { kind: "refused", reason: "tenant_queue_full" };
    }

    const record: AdmissionRecord = {
      ...input,
      enqueuedAt: new Date(this.now()).toISOString(),
      state: "queued",
    };
    this.queueRecords.push({ ...record, sequence: this.nextSequence });
    this.nextSequence += 1;
    return this.decisionFor(record.runId);
  }

  async dispatch(): Promise<void> {
    if (!this.dispatchCallback) {
      return;
    }
    while (this.activeCount() < this.limits.deploymentActiveRuns) {
      const candidate = this.nextDispatchCandidate();
      if (!candidate) {
        return;
      }
      let accepted = false;
      try {
        // Dispatches are serialized to preserve the durable capacity ledger.
        // biome-ignore lint/performance/noAwaitInLoops: dispatches are intentionally sequential
        accepted = await this.dispatchCallback(candidate);
      } catch {
        accepted = false;
      }
      const current = this.queueRecords.find(
        (record) => record.runId === candidate.runId
      );
      if (!current || current.state === "terminal") {
        continue;
      }
      if (!accepted) {
        current.state = "queued";
        return;
      }
    }
  }

  async release(runId: string): Promise<void> {
    const record = this.queueRecords.find(
      (candidate) => candidate.runId === runId
    );
    if (!record || record.state === "terminal") {
      return;
    }
    record.state = "terminal";
    await this.dispatch();
  }

  async expire(now = this.now()): Promise<string[]> {
    const expired: string[] = [];
    for (const record of this.queueRecords) {
      if (record.state === "queued" && this.isQueueExpired(record, now)) {
        record.state = "terminal";
        expired.push(record.runId);
      }
    }
    await this.dispatch();
    return expired;
  }

  nextDispatchCandidate(): AdmissionRecord | undefined {
    if (this.activeCount() >= this.limits.deploymentActiveRuns) {
      return;
    }
    const tenants = [
      ...new Set(
        this.queueRecords
          .filter(
            (record) =>
              record.state === "queued" && !this.isQueueExpired(record)
          )
          .map((record) => record.tenantHash)
      ),
    ].filter(
      (tenantHash) =>
        this.activeCountForTenant(tenantHash) < this.limits.tenantActiveRuns
    );
    if (tenants.length === 0) {
      return;
    }

    const ordered = tenants.sort((left, right) => {
      const leftHead = this.oldestDispatchableQueued(left);
      const rightHead = this.oldestDispatchableQueued(right);
      return leftHead && rightHead
        ? compareQueueOrder(leftHead, rightHead)
        : leftHead
          ? -1
          : rightHead
            ? 1
            : 0;
    });
    const waitingForOtherTenant = ordered.some(
      (tenantHash) => tenantHash !== this.queueScheduler.lastTenantHash
    );
    let eligible = ordered;
    if (
      waitingForOtherTenant &&
      this.queueScheduler.lastTenantHash &&
      this.queueScheduler.consecutiveDispatches >=
        this.limits.consecutiveDispatches
    ) {
      eligible = ordered.filter(
        (tenantHash) => tenantHash !== this.queueScheduler.lastTenantHash
      );
    }

    const afterLast = this.queueScheduler.lastTenantHash
      ? eligible.indexOf(this.queueScheduler.lastTenantHash)
      : -1;
    const selectedTenant =
      eligible[(afterLast + 1 + eligible.length) % eligible.length] ??
      eligible[0];
    if (!selectedTenant) {
      return;
    }
    const selected = this.oldestDispatchableQueued(selectedTenant);
    if (!selected) {
      return;
    }
    selected.state = "active";
    this.queueScheduler = {
      consecutiveDispatches:
        this.queueScheduler.lastTenantHash === selectedTenant
          ? this.queueScheduler.consecutiveDispatches + 1
          : 1,
      lastTenantHash: selectedTenant,
    };
    return cloneRecord(selected);
  }

  private activeCount(): number {
    return this.queueRecords.filter((record) => record.state === "active")
      .length;
  }

  private activeCountForTenant(tenantHash: string): number {
    return this.queueRecords.filter(
      (record) => record.state === "active" && record.tenantHash === tenantHash
    ).length;
  }

  private isQueueExpired(record: AdmissionRecord, now = this.now()): boolean {
    const enqueuedAt = Date.parse(record.enqueuedAt);
    return Number.isFinite(enqueuedAt) && now - enqueuedAt >= QUEUED_TTL_MS;
  }

  private oldestDispatchableQueued(
    tenantHash: string
  ): StoredAdmissionRecord | undefined {
    return this.queueRecords
      .filter(
        (record) =>
          record.state === "queued" &&
          record.tenantHash === tenantHash &&
          !this.isQueueExpired(record)
      )
      .sort(compareQueueOrder)[0];
  }

  private queuedCount(tenantHash: string): number {
    return this.queueRecords.filter(
      (record) => record.state === "queued" && record.tenantHash === tenantHash
    ).length;
  }

  private decisionFor(runId: string): AdmissionDecision {
    const record = this.queueRecords.find(
      (candidate) => candidate.runId === runId
    );
    if (!record) {
      throw new AdmissionConfigurationError("Admission record disappeared.");
    }
    if (record.state === "active") {
      return { kind: "active", runId };
    }
    if (record.state === "queued") {
      return {
        kind: "queued",
        position: queuedPosition(this.queueRecords, record.tenantHash, runId),
        runId,
      };
    }
    throw new AdmissionConfigurationError(
      "A terminal admission record cannot produce a new decision."
    );
  }

  private remove(runId: string): void {
    const index = this.queueRecords.findIndex(
      (record) => record.runId === runId
    );
    if (index >= 0) {
      this.queueRecords.splice(index, 1);
    }
  }
}

type AdmissionRow = {
  agent_id: string;
  enqueued_at: string;
  operation_id: string;
  request_hash: string;
  run_id: string;
  queue_sequence: number;
  state: string;
  tenant_hash: string;
};

type MetaRow = {
  key: string;
  value: string;
};

const NEXT_WAKE_META_KEY = "next_wake_at";
const ALARM_FAILURES_META_KEY = "alarm_failure_count";
const ALARM_UNAVAILABLE_META_KEY = "alarm_unavailable";
const NEXT_SEQUENCE_META_KEY = "next_sequence";

function rowToStoredRecord(row: AdmissionRow): StoredAdmissionRecord {
  if (
    (row.state !== "queued" &&
      row.state !== "active" &&
      row.state !== "terminal") ||
    !row.agent_id ||
    !row.enqueued_at ||
    !row.operation_id ||
    !row.request_hash ||
    !row.run_id ||
    !row.tenant_hash ||
    !Number.isSafeInteger(row.queue_sequence) ||
    row.queue_sequence <= 0
  ) {
    throw new AdmissionConfigurationError(
      "Run admission storage contains an invalid record."
    );
  }
  return {
    agentId: row.agent_id,
    enqueuedAt: row.enqueued_at,
    operationId: row.operation_id,
    requestHash: row.request_hash,
    runId: row.run_id,
    sequence: row.queue_sequence,
    state: row.state,
    tenantHash: row.tenant_hash,
  };
}

function publicRecord(record: StoredAdmissionRecord): AdmissionRecord {
  const { sequence: _sequence, ...result } = record;
  return cloneRecord(result);
}

export class RunAdmission extends DurableObject<Env> {
  private readonly initialized: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initialized = ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS admission_records (
          agent_id TEXT NOT NULL,
          enqueued_at TEXT NOT NULL,
          operation_id TEXT NOT NULL UNIQUE,
          request_hash TEXT NOT NULL,
          run_id TEXT PRIMARY KEY,
          queue_sequence INTEGER NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK (state IN ('queued', 'active', 'terminal')),
          tenant_hash TEXT NOT NULL,
          dispatch_started_at TEXT,
          dispatch_lease_until TEXT
        )
      `);
      const columns = ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(admission_records)")
        .toArray()
        .map((column) => column.name);
      if (!columns.includes("dispatch_started_at")) {
        ctx.storage.sql.exec(
          "ALTER TABLE admission_records ADD COLUMN dispatch_started_at TEXT"
        );
      }
      if (!columns.includes("dispatch_lease_until")) {
        ctx.storage.sql.exec(
          "ALTER TABLE admission_records ADD COLUMN dispatch_lease_until TEXT"
        );
      }
      if (!columns.includes("queue_sequence")) {
        ctx.storage.sql.exec(
          "ALTER TABLE admission_records ADD COLUMN queue_sequence INTEGER"
        );
        ctx.storage.sql.exec(
          "UPDATE admission_records SET queue_sequence = rowid WHERE queue_sequence IS NULL"
        );
      }
      ctx.storage.sql.exec(`
        CREATE INDEX IF NOT EXISTS admission_records_queue_sequence_idx
        ON admission_records (state, tenant_hash, queue_sequence)
      `);
      ctx.storage.sql.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS admission_records_sequence_idx
        ON admission_records (queue_sequence)
      `);
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS admission_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
      await Promise.resolve();
    });
  }

  async admit(input: AdmissionRequest): Promise<AdmissionDecision> {
    await this.initialized;
    const limits = admissionLimits(this.env);
    await this.ensureAlarm({ throwOnFailure: true });
    const result = this.ctx.storage.transactionSync(() => {
      const existing = this.findByOperationId(input.operationId);
      const storedRecords = this.readStoredRecords();
      const nextSequence = this.readNextSequence(storedRecords);
      const queue = new AdmissionQueue({
        limits,
        nextSequence,
        records: storedRecords,
      });
      const decision = queue.admitSynchronously(input);
      if (existing?.state === "terminal") {
        this.deleteRecord(existing.runId);
      }
      if (decision.kind === "refused" || decision.kind === "duplicate") {
        return { decision, record: null };
      }
      const record = queue
        .records()
        .find((candidate) => candidate.runId === input.runId);
      if (!record) {
        throw new AdmissionConfigurationError(
          "Admission record was not created."
        );
      }
      this.writeRecord({ ...record, sequence: nextSequence });
      this.writeMetaValue(NEXT_SEQUENCE_META_KEY, String(nextSequence + 1));
      return { decision, record };
    });
    if (result.decision.kind === "refused") {
      return result.decision;
    }
    if (result.decision.kind === "duplicate") {
      return result.decision;
    }
    const created = result.record;
    if (!created) {
      throw new AdmissionConfigurationError(
        "Admission record was not created."
      );
    }
    try {
      await this.ensureAlarm({ throwOnFailure: true });
    } catch (error) {
      this.terminalizeFailedAdmission(created);
      this.ctx.waitUntil(this.dispatchAvailable(limits));
      try {
        await this.env.YoloAgent.getByName(created.agentId).stop(created.runId);
      } catch {
        // The terminal record lets the alarm reconcile an unavailable agent.
      }
      throw error;
    }
    this.ctx.waitUntil(this.dispatchAvailable(limits));
    const current = this.findByRunId(input.runId);
    if (!current) {
      throw new AdmissionConfigurationError("Admission record disappeared.");
    }
    return this.decisionForStoredRecord(current, limits);
  }

  private terminalizeFailedAdmission(record: AdmissionRecord): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `
          UPDATE admission_records
          SET state = 'terminal',
              dispatch_started_at = NULL,
              dispatch_lease_until = NULL
          WHERE run_id = ?
            AND operation_id = ?
            AND request_hash = ?
            AND state IN ('queued', 'active')
        `,
        record.runId,
        record.operationId,
        record.requestHash
      );
    });
  }

  async release(runId: string): Promise<boolean> {
    await this.initialized;
    const current = this.findByRunId(runId);
    if (!current || current.state === "terminal") {
      return false;
    }
    this.updateState(runId, "terminal");
    this.clearDispatchLease(runId);
    this.ctx.waitUntil(this.dispatchAvailable(admissionLimits(this.env)));
    await this.ensureAlarm({ throwOnFailure: true });
    return true;
  }

  async getRecord(runId: string): Promise<AdmissionRecord | null> {
    await this.initialized;
    const record = this.findByRunId(runId);
    await this.ensureAlarm({ throwOnFailure: false });
    return record;
  }

  async getByOperationId(operationId: string): Promise<AdmissionRecord | null> {
    await this.initialized;
    const record = this.findByOperationId(operationId);
    await this.ensureAlarm({ throwOnFailure: false });
    return record;
  }

  async dispatch(): Promise<void> {
    await this.initialized;
    this.ctx.waitUntil(this.dispatchAvailable(admissionLimits(this.env)));
    await this.ensureAlarm({ throwOnFailure: true });
  }

  async alarm(): Promise<void> {
    await this.initialized;
    const now = Date.now();
    for (const record of this.readRecords()) {
      if (record.state === "active") {
        // Reconciliation is serialized with the Durable Object state.
        // biome-ignore lint/performance/noAwaitInLoops: reconciliation is intentionally sequential
        await this.reconcileActive(
          record,
          now - Date.parse(record.enqueuedAt) >= QUEUED_TTL_MS
        );
      } else if (record.state === "queued") {
        // A queued run can become terminal when its agent is stopped before
        // dispatch. Reconcile it on the regular alarm cadence so a failed
        // release callback cannot occupy queue capacity until TTL expiry.
        await this.reconcileQueued(record);
      }
    }
    const expired = this.readRecords().filter(
      (record) =>
        record.state === "queued" &&
        now - Date.parse(record.enqueuedAt) >= QUEUED_TTL_MS
    );
    for (const record of expired) {
      let cancellationProven = false;
      try {
        // Each cancellation is reconciled before the admission row is closed.
        // biome-ignore lint/performance/noAwaitInLoops: cancellations are intentionally sequential
        const stopped = await this.env.YoloAgent.getByName(record.agentId).stop(
          record.runId
        );
        cancellationProven =
          stopped === null ||
          (typeof stopped === "object" &&
            stopped !== null &&
            "status" in stopped &&
            typeof stopped.status === "string" &&
            isTerminal(stopped.status));
      } catch {
        // Keep the queued record so a later alarm can retry cancellation.
      }
      const current = this.findByRunId(record.runId);
      if (current?.state === "queued" && cancellationProven) {
        this.updateState(record.runId, "terminal");
      }
    }
    await this.dispatchAvailable(admissionLimits(this.env));
    await this.ensureAlarm({ throwOnFailure: false });
  }

  private async dispatchAvailable(limits: AdmissionLimits): Promise<void> {
    while (true) {
      const candidate = this.claimNextCandidate(limits);
      if (!candidate) {
        return;
      }
      let accepted = false;
      try {
        // Dispatches are serialized to preserve the durable capacity ledger.
        // biome-ignore lint/performance/noAwaitInLoops: dispatches are intentionally sequential
        accepted = await this.env.YoloAgent.getByName(
          candidate.agentId
        ).startAdmitted(candidate.runId);
      } catch {
        // Reconcile immediately so a dispatch error never makes capacity
        // depend on the next alarm. If the alarm cannot be repaired, close
        // this affected admission rather than leaving accepted work stranded.
        await this.reconcileDispatchFailure(candidate);
        return;
      }
      const current = this.findByRunId(candidate.runId);
      if (!current || current.state === "terminal" || accepted) {
        if (accepted) {
          this.clearDispatchLease(candidate.runId);
        }
        continue;
      }
      // A false response means the agent can tell us whether this run is
      // still queued, terminal, or absent. Do not strand the deployment slot.
      await this.reconcileDispatchFailure(current);
      if (this.findByRunId(candidate.runId)?.state === "queued") {
        return;
      }
    }
  }

  private async reconcileDispatchFailure(
    candidate: AdmissionRecord
  ): Promise<void> {
    await this.reconcileActive(candidate, true);
    const current = this.findByRunId(candidate.runId);
    if (!current || current.state === "terminal") {
      return;
    }
    if (
      current.state === "active" &&
      this.dispatchLeaseUntil(candidate.runId) !== null
    ) {
      this.updateState(candidate.runId, "queued");
      this.clearDispatchLease(candidate.runId);
    }
    try {
      await this.ensureAlarm({ throwOnFailure: true });
    } catch {
      const afterFailure = this.findByRunId(candidate.runId);
      if (afterFailure?.state === "queued") {
        this.terminalizeFailedAdmission(candidate);
        try {
          await this.env.YoloAgent.getByName(candidate.agentId).stop(
            candidate.runId
          );
        } catch {
          // The terminal admission row is the durable capacity decision.
        }
      }
    }
  }

  private async ensureAlarm(options: {
    throwOnFailure: boolean;
  }): Promise<boolean> {
    const records = this.readStoredRecords();
    const hasWork = records.some(
      (record) => record.state === "queued" || record.state === "active"
    );
    if (!hasWork) {
      this.writeMetaValue(NEXT_WAKE_META_KEY, "");
      try {
        await this.ctx.storage.deleteAlarm();
        this.markAlarmHealthy();
        return true;
      } catch (error) {
        return this.handleAlarmFailure(null, error, options.throwOnFailure);
      }
    }

    const now = Date.now();
    const next = this.nextWakeAt(records, now);
    // The durable deadline is written before touching the platform alarm. A
    // later RPC can therefore repair a missing alarm without relying on an
    // uncaught alarm retry.
    this.writeMetaValue(NEXT_WAKE_META_KEY, String(next));
    try {
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current <= now || current > next) {
        await this.ctx.storage.setAlarm(next);
      }
      this.markAlarmHealthy();
      return true;
    } catch (error) {
      return this.handleAlarmFailure(next, error, options.throwOnFailure);
    }
  }

  private nextWakeAt(
    records: readonly StoredAdmissionRecord[],
    now: number
  ): number {
    const queuedDeadlines = records
      .filter((record) => record.state === "queued")
      .map((record) => Date.parse(record.enqueuedAt) + QUEUED_TTL_MS);
    const dispatchLeases = records
      .filter((record) => record.state === "active")
      .map((record) => this.dispatchLeaseUntil(record.runId))
      .filter((value): value is number => value !== null);
    const deadlines = [...queuedDeadlines, ...dispatchLeases].filter(
      (value) => Number.isFinite(value) && value > now
    );
    return Math.min(now + ALARM_INTERVAL_MS, ...deadlines);
  }

  private async handleAlarmFailure(
    nextWake: number | null,
    error: unknown,
    throwOnFailure: boolean
  ): Promise<boolean> {
    const failures = this.readAlarmFailureCount() + 1;
    this.writeMetaValue(ALARM_FAILURES_META_KEY, String(failures));
    this.writeMetaValue(
      ALARM_UNAVAILABLE_META_KEY,
      failures >= MAX_ALARM_REPAIR_FAILURES ? "1" : "0"
    );

    let repaired = false;
    if (nextWake !== null) {
      const retryAt = Math.min(nextWake, Date.now() + ALARM_REPAIR_RETRY_MS);
      try {
        await this.ctx.storage.setAlarm(retryAt);
        this.writeMetaValue(NEXT_WAKE_META_KEY, String(nextWake));
        this.markAlarmHealthy();
        repaired = true;
      } catch {
        // One bounded best effort is enough; recursion here would hot-loop
        // when the platform storage API is permanently unavailable.
      }
    }

    if (!repaired && failures >= MAX_ALARM_REPAIR_FAILURES) {
      this.failClosedQueuedAdmissions();
    }
    if (!repaired && throwOnFailure) {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      throw new AdmissionUnavailableError(
        `Run admission alarm is unavailable${detail}`
      );
    }
    return repaired;
  }

  private failClosedQueuedAdmissions(): void {
    const queued = this.readStoredRecords().filter(
      (record) => record.state === "queued"
    );
    for (const record of queued) {
      this.terminalizeFailedAdmission(record);
      this.ctx.waitUntil(
        (async () => {
          try {
            await this.env.YoloAgent.getByName(record.agentId).stop(
              record.runId
            );
          } catch {
            // The terminal admission row is the durable capacity decision.
          }
        })()
      );
    }
    this.writeMetaValue(NEXT_WAKE_META_KEY, "");
  }

  private readAlarmFailureCount(): number {
    const value = Number(this.readMetaValue(ALARM_FAILURES_META_KEY) ?? "0");
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  private markAlarmHealthy(): void {
    this.writeMetaValue(ALARM_FAILURES_META_KEY, "0");
    this.writeMetaValue(ALARM_UNAVAILABLE_META_KEY, "0");
  }

  private claimNextCandidate(
    limits: AdmissionLimits
  ): AdmissionRecord | undefined {
    const queue = new AdmissionQueue({
      limits,
      records: this.readStoredRecords(),
      scheduler: this.readScheduler(),
    });
    const candidate = queue.nextDispatchCandidate();
    if (!candidate) {
      return;
    }
    const startedAt = new Date(Date.now()).toISOString();
    this.updateDispatchLease(
      candidate.runId,
      startedAt,
      new Date(Date.now() + DISPATCH_LEASE_MS).toISOString()
    );
    this.writeScheduler(queue.scheduler());
    return candidate;
  }

  private async reconcileActive(
    record: AdmissionRecord,
    forceQueued = false
  ): Promise<void> {
    try {
      const run = await this.env.YoloAgent.getByName(record.agentId).getRun(
        record.runId
      );
      const current = this.findByRunId(record.runId);
      if (current?.state !== "active") {
        return;
      }
      if (!run) {
        this.updateState(record.runId, "terminal");
        this.clearDispatchLease(record.runId);
        return;
      }
      if (run.status === "running") {
        this.clearDispatchLease(record.runId);
        return;
      }
      if (isTerminal(run.status)) {
        this.updateState(record.runId, "terminal");
        this.clearDispatchLease(record.runId);
        return;
      }
      const leaseUntil = this.dispatchLeaseUntil(record.runId);
      if (forceQueued || leaseUntil === null || leaseUntil <= Date.now()) {
        this.updateState(record.runId, "queued");
        this.clearDispatchLease(record.runId);
      }
    } catch {
      // Keep the active record and retry after its dispatch lease.
    }
  }

  private async reconcileQueued(record: AdmissionRecord): Promise<void> {
    try {
      const run = await this.env.YoloAgent.getByName(record.agentId).getRun(
        record.runId
      );
      const current = this.findByRunId(record.runId);
      if (current?.state !== "queued") {
        return;
      }
      if (!run || isTerminal(run.status)) {
        this.updateState(record.runId, "terminal");
        this.clearDispatchLease(record.runId);
      }
    } catch {
      // Keep the queued record and retry on the next alarm.
    }
  }

  private decisionForStoredRecord(
    record: AdmissionRecord,
    limits: AdmissionLimits
  ): AdmissionDecision {
    if (record.state === "active") {
      return { kind: "active", runId: record.runId };
    }
    if (record.state === "queued") {
      const position =
        this.readStoredRecords()
          .filter(
            (candidate) =>
              candidate.state === "queued" &&
              candidate.tenantHash === record.tenantHash
          )
          .sort(compareQueueOrder)
          .findIndex((candidate) => candidate.runId === record.runId) + 1;
      return { kind: "queued", position, runId: record.runId };
    }
    if (limits.tenantQueuedRuns < 0) {
      throw new AdmissionConfigurationError("Invalid admission limits.");
    }
    throw new AdmissionConfigurationError(
      "A terminal admission record cannot produce a new decision."
    );
  }

  private readRecords(): AdmissionRecord[] {
    return this.readStoredRecords().map(publicRecord);
  }

  private readStoredRecords(): StoredAdmissionRecord[] {
    return this.ctx.storage.sql
      .exec<AdmissionRow>(
        "SELECT agent_id, enqueued_at, operation_id, request_hash, run_id, queue_sequence, state, tenant_hash FROM admission_records ORDER BY queue_sequence"
      )
      .toArray()
      .map(rowToStoredRecord);
  }

  private findByOperationId(operationId: string): AdmissionRecord | null {
    const rows = this.ctx.storage.sql
      .exec<AdmissionRow>(
        "SELECT agent_id, enqueued_at, operation_id, request_hash, run_id, queue_sequence, state, tenant_hash FROM admission_records WHERE operation_id = ?",
        operationId
      )
      .toArray();
    return rows[0] ? publicRecord(rowToStoredRecord(rows[0])) : null;
  }

  private findByRunId(runId: string): AdmissionRecord | null {
    const rows = this.ctx.storage.sql
      .exec<AdmissionRow>(
        "SELECT agent_id, enqueued_at, operation_id, request_hash, run_id, queue_sequence, state, tenant_hash FROM admission_records WHERE run_id = ?",
        runId
      )
      .toArray();
    return rows[0] ? publicRecord(rowToStoredRecord(rows[0])) : null;
  }

  private writeRecord(record: StoredAdmissionRecord): void {
    this.ctx.storage.sql.exec(
      `
        INSERT INTO admission_records
          (agent_id, enqueued_at, operation_id, request_hash, run_id, queue_sequence, state, tenant_hash, dispatch_started_at, dispatch_lease_until)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
        ON CONFLICT(run_id) DO UPDATE SET
          agent_id = excluded.agent_id,
          enqueued_at = excluded.enqueued_at,
          operation_id = excluded.operation_id,
          request_hash = excluded.request_hash,
          queue_sequence = excluded.queue_sequence,
          state = excluded.state,
          tenant_hash = excluded.tenant_hash,
          dispatch_started_at = NULL,
          dispatch_lease_until = NULL
      `,
      record.agentId,
      record.enqueuedAt,
      record.operationId,
      record.requestHash,
      record.runId,
      record.sequence,
      record.state,
      record.tenantHash
    );
  }

  private updateState(runId: string, state: AdmissionRecord["state"]): void {
    this.ctx.storage.sql.exec(
      "UPDATE admission_records SET state = ? WHERE run_id = ?",
      state,
      runId
    );
  }

  private updateDispatchLease(
    runId: string,
    startedAt: string,
    leaseUntil: string
  ): void {
    this.ctx.storage.sql.exec(
      "UPDATE admission_records SET state = 'active', dispatch_started_at = ?, dispatch_lease_until = ? WHERE run_id = ?",
      startedAt,
      leaseUntil,
      runId
    );
  }

  private clearDispatchLease(runId: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE admission_records SET dispatch_started_at = NULL, dispatch_lease_until = NULL WHERE run_id = ?",
      runId
    );
  }

  private dispatchLeaseUntil(runId: string): number | null {
    const rows = this.ctx.storage.sql
      .exec<{ dispatch_lease_until: string | null }>(
        "SELECT dispatch_lease_until FROM admission_records WHERE run_id = ?",
        runId
      )
      .toArray();
    const value = rows[0]?.dispatch_lease_until;
    if (!value) {
      return null;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private deleteRecord(runId: string): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM admission_records WHERE run_id = ?",
      runId
    );
  }

  private readScheduler(): SchedulerState {
    const rows = this.ctx.storage.sql
      .exec<MetaRow>(
        "SELECT key, value FROM admission_meta WHERE key IN ('last_tenant_hash', 'consecutive_dispatches')"
      )
      .toArray();
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const consecutive = Number(values.get("consecutive_dispatches") ?? "0");
    if (!Number.isInteger(consecutive) || consecutive < 0) {
      throw new AdmissionConfigurationError(
        "Run admission scheduler storage is invalid."
      );
    }
    return {
      consecutiveDispatches: consecutive,
      lastTenantHash: values.get("last_tenant_hash") ?? null,
    };
  }

  private writeScheduler(scheduler: SchedulerState): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO admission_meta (key, value) VALUES ('last_tenant_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      scheduler.lastTenantHash ?? ""
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO admission_meta (key, value) VALUES ('consecutive_dispatches', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      String(scheduler.consecutiveDispatches)
    );
  }

  private readMetaValue(key: string): string | null {
    const rows = this.ctx.storage.sql
      .exec<MetaRow>("SELECT key, value FROM admission_meta WHERE key = ?", key)
      .toArray();
    return rows[0]?.value ?? null;
  }

  private writeMetaValue(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO admission_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value
    );
  }

  private readNextSequence(records: readonly StoredAdmissionRecord[]): number {
    const persisted = Number(this.readMetaValue(NEXT_SEQUENCE_META_KEY) ?? "1");
    const highest =
      Math.max(0, ...records.map((record) => record.sequence)) + 1;
    if (!Number.isSafeInteger(persisted) || persisted < 1) {
      throw new AdmissionConfigurationError(
        "Run admission sequence storage is invalid."
      );
    }
    return Math.max(persisted, highest);
  }
}
