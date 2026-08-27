import { DurableObject } from "cloudflare:workers";
import { pseudonymousKey } from "./abuse";
import {
  type AdmissionCleanupCapability,
  isAgentBusyError,
  isTerminal,
  MAX_TERMINAL_RUNS_PER_AGENT,
  OperationConflictError,
  type PreparedAdmissionConfirmationOutcome,
} from "./run-state";

export type AdmissionRecord = {
  agentId: string;
  enqueuedAt: string;
  mode?: AdmissionMode;
  noQueue?: boolean;
  operationId: string;
  requestHash: string;
  runId: string;
  state: "queued" | "active" | "terminal";
  tenantHash: string;
};

export type AdmissionMode = "queue" | "reject";

export type AdmissionDecision =
  | {
      admissionCapability?: AdmissionCleanupCapability;
      kind: "active";
      runId: string;
    }
  | {
      admissionCapability?: AdmissionCleanupCapability;
      kind: "queued";
      position: number;
      runId: string;
    }
  | {
      admissionCapability?: AdmissionCleanupCapability;
      kind: "duplicate";
      runId: string;
      state: "queued" | "active" | "terminal";
    }
  | { kind: "refused"; reason: "tenant_queue_full" | "global_busy" };

export type AdmissionRequest = Omit<AdmissionRecord, "enqueuedAt" | "state"> & {
  mode?: AdmissionMode;
  noQueue?: boolean;
  prepareOwner?: string;
};

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
const DEFAULT_TERMINAL_RETENTION = MAX_TERMINAL_RUNS_PER_AGENT;
const MAX_CLEANUP_TASKS_PER_ALARM = 50;
export const PROVISIONAL_CONFIRMATION_GRACE_MS = 60 * 1000;
export const MAX_GLOBAL_ADMISSION_ENTRIES = 1024;

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
  mode?: AdmissionMode;
  noQueue?: boolean;
  dispatchLeaseUntil?: string;
  dispatchStartedAt?: string;
  dispatchToken?: string;
  sequence: number;
  terminalizedAt?: string;
};

function cleanupCapability(
  record: Pick<
    StoredAdmissionRecord,
    | "agentId"
    | "operationId"
    | "requestHash"
    | "runId"
    | "sequence"
    | "dispatchToken"
  >
): AdmissionCleanupCapability {
  return {
    admissionSequence: record.sequence,
    agentId: record.agentId,
    ...(record.dispatchToken ? { dispatchToken: record.dispatchToken } : {}),
    operationId: record.operationId,
    requestHash: record.requestHash,
    runId: record.runId,
  };
}

function decisionWithCleanupCapability(
  decision: AdmissionDecision,
  capability: AdmissionCleanupCapability,
  enumerable = true
): AdmissionDecision {
  Object.defineProperty(decision, "admissionCapability", {
    configurable: true,
    enumerable,
    value: capability,
  });
  return decision;
}

function matchesCleanupIdentity(
  record: Pick<
    AdmissionRecord,
    "agentId" | "operationId" | "requestHash" | "runId"
  >,
  expected: Pick<
    AdmissionCleanupCapability,
    "agentId" | "operationId" | "requestHash" | "runId"
  >
): boolean {
  return (
    record.agentId === expected.agentId &&
    record.operationId === expected.operationId &&
    record.requestHash === expected.requestHash &&
    record.runId === expected.runId
  );
}

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
  RUN_ADMISSION_TERMINAL_RETENTION?: string;
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

function terminalRetention(env: AdmissionConfigEnvironment): number {
  return configuredLimit(
    env,
    "RUN_ADMISSION_TERMINAL_RETENTION",
    DEFAULT_TERMINAL_RETENTION
  );
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

function recordInput(
  input: AdmissionRequest
): Omit<AdmissionRequest, "mode" | "noQueue" | "prepareOwner"> {
  const {
    mode: _mode,
    noQueue: _noQueue,
    prepareOwner: _prepareOwner,
    ...record
  } = input;
  return record;
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
  runId: string,
  now: number
): number {
  return (
    records
      .filter(
        (record) =>
          record.state === "queued" &&
          record.tenantHash === tenantHash &&
          !isQueueExpired(record, now)
      )
      .sort(compareQueueOrder)
      .findIndex((record) => record.runId === runId) + 1
  );
}

function isQueueExpired(record: AdmissionRecord, now = Date.now()): boolean {
  const enqueuedAt = Date.parse(record.enqueuedAt);
  return Number.isFinite(enqueuedAt) && now - enqueuedAt >= QUEUED_TTL_MS;
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
    let highestSequence = 0;
    for (const record of this.queueRecords) {
      highestSequence = Math.max(highestSequence, record.sequence);
    }
    const firstAvailableSequence = highestSequence + 1;
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
    return this.queueRecords.map(
      ({
        dispatchLeaseUntil: _dispatchLeaseUntil,
        dispatchStartedAt: _dispatchStartedAt,
        dispatchToken: _dispatchToken,
        sequence: _sequence,
        terminalizedAt: _terminalizedAt,
        ...record
      }) => cloneRecord(record)
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
    const normalizedInput = recordInput(input);
    this.expireQueuedRecords(this.now());
    const existing = this.queueRecords.find(
      (candidate) => candidate.operationId === input.operationId
    );
    if (existing) {
      if (existing.requestHash !== input.requestHash) {
        throw new OperationConflictError();
      }
      return {
        kind: "duplicate",
        runId: existing.runId,
        state: existing.state,
      };
    }
    if (this.queueRecords.length >= MAX_GLOBAL_ADMISSION_ENTRIES) {
      return { kind: "refused", reason: "global_busy" };
    }

    if (
      input.mode === "reject" &&
      this.queueRecords.some(
        (entry) =>
          entry.agentId === input.agentId &&
          entry.state !== "terminal" &&
          (entry.state === "active" || Boolean(entry.dispatchToken))
      )
    ) {
      return { kind: "refused", reason: "global_busy" };
    }
    if (this.activeCount() >= this.limits.deploymentActiveRuns) {
      return { kind: "refused", reason: "global_busy" };
    }
    if (
      !this.wouldActivateImmediately(input) &&
      this.queuedCount(input.tenantHash) >= this.limits.tenantQueuedRuns
    ) {
      return { kind: "refused", reason: "tenant_queue_full" };
    }
    if (input.mode === "reject") {
      return { kind: "refused", reason: "global_busy" };
    }

    const record: AdmissionRecord = {
      ...normalizedInput,
      enqueuedAt: new Date(this.now()).toISOString(),
      state: "queued",
    };
    this.queueRecords.push({ ...record, sequence: this.nextSequence });
    this.nextSequence += 1;
    return this.decisionFor(record.runId);
  }

  wouldActivateImmediately(input: AdmissionRequest): boolean {
    assertAdmissionRequest(input);
    return this.schedulerForImmediateAdmission(input) !== null;
  }

  schedulerForImmediateAdmission(
    input: AdmissionRequest
  ): SchedulerState | null {
    assertAdmissionRequest(input);
    const now = this.now();
    const candidate: StoredAdmissionRecord = {
      ...recordInput(input),
      enqueuedAt: new Date(now).toISOString(),
      sequence: this.nextSequence,
      state: "queued",
    };
    const tentativeQueue = new AdmissionQueue({
      limits: this.limits,
      nextSequence: this.nextSequence + 1,
      now: () => now,
      records: [...this.queueRecords, candidate],
      scheduler: this.queueScheduler,
    });
    return tentativeQueue.nextDispatchCandidate()?.runId === input.runId
      ? tentativeQueue.scheduler()
      : null;
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
        if (
          this.queuedCount(current.tenantHash) >= this.limits.tenantQueuedRuns
        ) {
          current.state = "terminal";
          continue;
        }
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

  nextDispatchCandidate(): StoredAdmissionRecord | undefined {
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
    return { ...selected };
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
    return isQueueExpired(record, now);
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
      (record) =>
        record.state === "queued" &&
        record.tenantHash === tenantHash &&
        !this.isQueueExpired(record)
    ).length;
  }

  private expireQueuedRecords(now: number): void {
    for (const record of this.queueRecords) {
      if (record.state === "queued" && this.isQueueExpired(record, now)) {
        record.state = "terminal";
      }
    }
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
        position: queuedPosition(
          this.queueRecords,
          record.tenantHash,
          runId,
          this.now()
        ),
        runId,
      };
    }
    return {
      kind: "refused",
      reason:
        this.queuedCount(record.tenantHash) >= this.limits.tenantQueuedRuns
          ? "tenant_queue_full"
          : "global_busy",
    };
  }
}

type AdmissionRow = {
  agent_id: string;
  dispatch_lease_until: string | null;
  dispatch_started_at: string | null;
  dispatch_token: string | null;
  enqueued_at: string;
  mode: string | null;
  no_queue: number | null;
  operation_id: string;
  request_hash: string;
  run_id: string;
  queue_sequence: number;
  state: string;
  terminalized_at: string | null;
  tenant_hash: string;
};

type MetaRow = {
  key: string;
  value: string;
};

type ActiveReconciliation =
  | "ambiguous"
  | "requeued"
  | "running"
  | "terminal"
  | "refused";

const NEXT_WAKE_META_KEY = "next_wake_at";
const ALARM_FAILURES_META_KEY = "alarm_failure_count";
const ALARM_UNAVAILABLE_META_KEY = "alarm_unavailable";
const NEXT_SEQUENCE_META_KEY = "next_sequence";
const NEXT_DISPATCH_GENERATION_META_KEY = "next_dispatch_generation";

function rowToStoredRecord(row: AdmissionRow): StoredAdmissionRecord {
  const noQueue = row.no_queue === 1 || row.mode === "reject";
  const mode: AdmissionMode = noQueue ? "reject" : "queue";
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
    (row.mode !== null &&
      row.mode !== undefined &&
      row.mode !== "queue" &&
      row.mode !== "reject") ||
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
    mode,
    noQueue,
    operationId: row.operation_id,
    requestHash: row.request_hash,
    runId: row.run_id,
    sequence: row.queue_sequence,
    state: row.state,
    tenantHash: row.tenant_hash,
    ...(row.dispatch_lease_until
      ? { dispatchLeaseUntil: row.dispatch_lease_until }
      : {}),
    ...(row.dispatch_started_at
      ? { dispatchStartedAt: row.dispatch_started_at }
      : {}),
    ...(row.dispatch_token ? { dispatchToken: row.dispatch_token } : {}),
    ...(row.terminalized_at ? { terminalizedAt: row.terminalized_at } : {}),
  };
}

function publicRecord(record: StoredAdmissionRecord): AdmissionRecord {
  const {
    dispatchLeaseUntil: _dispatchLeaseUntil,
    dispatchStartedAt: _dispatchStartedAt,
    dispatchToken: _dispatchToken,
    sequence: _sequence,
    terminalizedAt: _terminalizedAt,
    ...result
  } = record;
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
          mode TEXT NOT NULL DEFAULT 'queue' CHECK (mode IN ('queue', 'reject')),
          no_queue INTEGER NOT NULL DEFAULT 0 CHECK (no_queue IN (0, 1)),
          operation_id TEXT NOT NULL UNIQUE,
          request_hash TEXT NOT NULL,
          run_id TEXT PRIMARY KEY,
          queue_sequence INTEGER NOT NULL UNIQUE,
          state TEXT NOT NULL CHECK (state IN ('queued', 'active', 'terminal')),
          tenant_hash TEXT NOT NULL,
          dispatch_started_at TEXT,
          dispatch_lease_until TEXT,
          dispatch_token TEXT,
          terminalized_at TEXT
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
      if (!columns.includes("mode")) {
        ctx.storage.sql.exec(
          "ALTER TABLE admission_records ADD COLUMN mode TEXT NOT NULL DEFAULT 'queue'"
        );
      }
      if (!columns.includes("no_queue")) {
        ctx.storage.sql.exec(
          "ALTER TABLE admission_records ADD COLUMN no_queue INTEGER NOT NULL DEFAULT 0"
        );
      }
      ctx.storage.sql.exec(
        "UPDATE admission_records SET no_queue = CASE WHEN mode = 'reject' THEN 1 ELSE 0 END"
      );
      if (!columns.includes("dispatch_lease_until")) {
        ctx.storage.sql.exec(
          "ALTER TABLE admission_records ADD COLUMN dispatch_lease_until TEXT"
        );
      }
      if (!columns.includes("dispatch_token")) {
        ctx.storage.sql.exec(
          "ALTER TABLE admission_records ADD COLUMN dispatch_token TEXT"
        );
      }
      if (!columns.includes("terminalized_at")) {
        ctx.storage.sql.exec(
          "ALTER TABLE admission_records ADD COLUMN terminalized_at TEXT"
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
        CREATE INDEX IF NOT EXISTS admission_records_terminal_sequence_idx
        ON admission_records (state, queue_sequence DESC)
      `);
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS admission_cleanup_tasks (
          agent_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          admission_sequence INTEGER NOT NULL DEFAULT 0,
          kind TEXT NOT NULL DEFAULT 'admission',
          dispatch_token TEXT,
          prepare_owner TEXT,
          operation_id TEXT,
          request_hash TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER NOT NULL,
          confirmation_grace_until INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (run_id, admission_sequence)
        )
      `);
      let cleanupColumns = ctx.storage.sql
        .exec<{ name: string }>("PRAGMA table_info(admission_cleanup_tasks)")
        .toArray()
        .map((column) => column.name);
      if (!cleanupColumns.includes("admission_sequence")) {
        ctx.storage.sql.exec(
          "ALTER TABLE admission_cleanup_tasks RENAME TO admission_cleanup_tasks_legacy"
        );
        ctx.storage.sql.exec(`
          CREATE TABLE admission_cleanup_tasks (
            agent_id TEXT NOT NULL,
            run_id TEXT NOT NULL,
            admission_sequence INTEGER NOT NULL DEFAULT 0,
            kind TEXT NOT NULL DEFAULT 'admission',
            dispatch_token TEXT,
            prepare_owner TEXT,
            operation_id TEXT,
            request_hash TEXT,
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at INTEGER NOT NULL,
            confirmation_grace_until INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (run_id, admission_sequence)
          )
        `);
        ctx.storage.sql.exec(`
          INSERT INTO admission_cleanup_tasks
            (agent_id, run_id, admission_sequence, kind, dispatch_token, attempts, next_attempt_at)
          SELECT legacy.agent_id,
                 legacy.run_id,
                 admission_records.queue_sequence,
                 'admission',
                 NULL,
                 legacy.attempts,
                 legacy.next_attempt_at
          FROM admission_cleanup_tasks_legacy AS legacy
          JOIN admission_records
            ON admission_records.run_id = legacy.run_id
        `);
        ctx.storage.sql.exec("DROP TABLE admission_cleanup_tasks_legacy");
        cleanupColumns = [
          "agent_id",
          "run_id",
          "admission_sequence",
          "kind",
          "dispatch_token",
          "prepare_owner",
          "operation_id",
          "request_hash",
          "attempts",
          "next_attempt_at",
          "confirmation_grace_until",
        ];
      } else if (!cleanupColumns.includes("dispatch_token")) {
        ctx.storage.sql.exec(
          "ALTER TABLE admission_cleanup_tasks ADD COLUMN dispatch_token TEXT"
        );
      }
      if (!cleanupColumns.includes("kind")) {
        ctx.storage.sql.exec(
          "ALTER TABLE admission_cleanup_tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'admission'"
        );
      }
      if (!cleanupColumns.includes("prepare_owner")) {
        ctx.storage.sql.exec(
          "ALTER TABLE admission_cleanup_tasks ADD COLUMN prepare_owner TEXT"
        );
      }
      if (!cleanupColumns.includes("operation_id")) {
        ctx.storage.sql.exec(
          "ALTER TABLE admission_cleanup_tasks ADD COLUMN operation_id TEXT"
        );
      }
      if (!cleanupColumns.includes("request_hash")) {
        ctx.storage.sql.exec(
          "ALTER TABLE admission_cleanup_tasks ADD COLUMN request_hash TEXT"
        );
      }
      if (!cleanupColumns.includes("confirmation_grace_until")) {
        ctx.storage.sql.exec(
          "ALTER TABLE admission_cleanup_tasks ADD COLUMN confirmation_grace_until INTEGER NOT NULL DEFAULT 0"
        );
      }
      ctx.storage.sql.exec(
        `
          UPDATE admission_cleanup_tasks
          SET confirmation_grace_until = next_attempt_at + ?
          WHERE kind = 'provisional' AND confirmation_grace_until <= 0
        `,
        PROVISIONAL_CONFIRMATION_GRACE_MS
      );
      ctx.storage.sql.exec(`
        CREATE INDEX IF NOT EXISTS admission_cleanup_tasks_due_idx
        ON admission_cleanup_tasks (next_attempt_at, run_id, admission_sequence)
      `);
      ctx.storage.sql.exec(`
        DELETE FROM admission_cleanup_tasks
        WHERE (kind = 'admission' AND (
                 admission_sequence <= 0
                 OR NOT EXISTS (
             SELECT 1
             FROM admission_records
             WHERE admission_records.run_id = admission_cleanup_tasks.run_id
               AND admission_records.queue_sequence =
                 admission_cleanup_tasks.admission_sequence
           )))
           OR (kind = 'provisional' AND (
                 prepare_owner IS NULL OR prepare_owner = ''
           ))
      `);
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS admission_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
      ctx.storage.transactionSync(() => {
        this.reconcileExpiredQueuedAdmissionsInTransaction(Date.now());
      });
      await Promise.resolve();
    });
  }

  async admit(input: AdmissionRequest): Promise<AdmissionDecision> {
    await this.initialized;
    const mode: AdmissionMode =
      input.noQueue || input.mode === "reject" ? "reject" : "queue";
    const noQueue = mode === "reject";
    const limits = admissionLimits(this.env);
    await this.ensureAlarm({ throwOnFailure: true });
    const result = this.ctx.storage.transactionSync(() => {
      this.reconcileExpiredQueuedAdmissionsInTransaction(Date.now());
      const existing = this.findByOperationId(input.operationId);
      if (existing) {
        if (existing.requestHash !== input.requestHash) {
          throw new OperationConflictError();
        }
        if (existing.state === "terminal") {
          this.pruneTerminalRecords();
        }
        const decision = {
          kind: "duplicate",
          runId: existing.runId,
          state: existing.state,
        } as AdmissionDecision;
        return {
          decision: decisionWithCleanupCapability(
            decision,
            cleanupCapability(existing),
            input.mode !== undefined || input.noQueue !== undefined
          ),
          record: null,
        };
      }
      const existingRun = this.findStoredByRunId(input.runId);
      if (existingRun) {
        if (
          existingRun.operationId !== input.operationId ||
          existingRun.requestHash !== input.requestHash
        ) {
          throw new OperationConflictError();
        }
        const decision = {
          kind: "duplicate",
          runId: existingRun.runId,
          state: existingRun.state,
        } as AdmissionDecision;
        return {
          decision: decisionWithCleanupCapability(
            decision,
            cleanupCapability(existingRun),
            input.mode !== undefined || input.noQueue !== undefined
          ),
          record: null,
        };
      }
      this.pruneTerminalRecords(1);
      if (!this.hasGlobalRetentionCapacity()) {
        return {
          decision: {
            kind: "refused",
            reason: "global_busy",
          } as AdmissionDecision,
          record: null,
        };
      }
      const storedRecords = this.readStoredRecords();
      const nextSequence = this.readNextSequence();
      if (
        noQueue &&
        storedRecords.some(
          (entry) =>
            entry.agentId === input.agentId &&
            entry.state !== "terminal" &&
            (entry.state === "active" || Boolean(entry.dispatchToken))
        )
      ) {
        return {
          decision: {
            kind: "refused",
            reason: "global_busy",
          } as AdmissionDecision,
          record: null,
        };
      }
      const queue = new AdmissionQueue({
        limits,
        nextSequence,
        records: storedRecords,
        scheduler: this.readScheduler(),
      });
      const enqueuedRecord: StoredAdmissionRecord = {
        agentId: input.agentId,
        enqueuedAt: new Date(Date.now()).toISOString(),
        mode,
        noQueue,
        operationId: input.operationId,
        requestHash: input.requestHash,
        runId: input.runId,
        sequence: nextSequence,
        state: "queued",
        tenantHash: input.tenantHash,
      };
      const immediateScheduler = queue.schedulerForImmediateAdmission(input);
      const canActivateImmediately = immediateScheduler !== null;
      const decision = canActivateImmediately
        ? ({ kind: "active", runId: input.runId } as AdmissionDecision)
        : noQueue
          ? ({
              kind: "refused",
              reason:
                storedRecords.filter((entry) => entry.state === "active")
                  .length >= limits.deploymentActiveRuns
                  ? "global_busy"
                  : storedRecords.filter(
                        (entry) =>
                          entry.state === "queued" &&
                          entry.tenantHash === input.tenantHash
                      ).length >= limits.tenantQueuedRuns
                    ? "tenant_queue_full"
                    : "global_busy",
            } as AdmissionDecision)
          : queue.admitSynchronously(input);
      if (decision.kind === "refused" || decision.kind === "duplicate") {
        return { decision, record: null };
      }
      let record: StoredAdmissionRecord = canActivateImmediately
        ? {
            ...enqueuedRecord,
            state: "active",
          }
        : {
            ...enqueuedRecord,
            state: "queued",
          };
      this.writeRecord(record);
      this.invalidateOlderCleanupTasks(record.runId, record.sequence);
      this.writeMetaValue(NEXT_SEQUENCE_META_KEY, String(nextSequence + 1));
      if (immediateScheduler !== null) {
        this.writeScheduler(immediateScheduler);
        const marked = this.markDispatchPending(record.runId);
        if (!marked) {
          throw new AdmissionConfigurationError(
            "Active admission dispatch token was not persisted."
          );
        }
        record = marked;
      }
      return {
        decision: decisionWithCleanupCapability(
          decision,
          cleanupCapability(record),
          input.mode !== undefined || input.noQueue !== undefined
        ),
        record,
      };
    });
    if (result.decision.kind === "refused") {
      this.ctx.waitUntil(this.retryCleanupTasks());
      return result.decision;
    }
    if (result.decision.kind === "duplicate") {
      this.ctx.waitUntil(this.retryCleanupTasks());
      return result.decision;
    }
    const created = result.record;
    if (!created) {
      throw new AdmissionConfigurationError(
        "Admission record was not created."
      );
    }
    this.ctx.waitUntil(this.retryCleanupTasks());
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
    return result.decision;
  }

  private terminalizeFailedAdmission(
    record: AdmissionRecord,
    dispatchToken?: string
  ): void {
    this.ctx.storage.transactionSync(() => {
      if (dispatchToken) {
        this.ctx.storage.sql.exec(
          `
            UPDATE admission_records
            SET state = 'terminal',
                dispatch_started_at = NULL,
                dispatch_lease_until = NULL,
                dispatch_token = NULL,
                terminalized_at = ?
            WHERE run_id = ?
              AND operation_id = ?
              AND request_hash = ?
              AND state IN ('queued', 'active')
              AND (
                dispatch_token = ?
                OR (dispatch_token IS NULL AND state = 'queued')
              )
          `,
          new Date(Date.now()).toISOString(),
          record.runId,
          record.operationId,
          record.requestHash,
          dispatchToken
        );
      } else {
        this.ctx.storage.sql.exec(
          `
          UPDATE admission_records
          SET state = 'terminal',
              dispatch_started_at = NULL,
              dispatch_lease_until = NULL,
              dispatch_token = NULL,
              terminalized_at = ?
          WHERE run_id = ?
            AND operation_id = ?
            AND request_hash = ?
            AND state IN ('queued', 'active')
          `,
          new Date(Date.now()).toISOString(),
          record.runId,
          record.operationId,
          record.requestHash
        );
      }
      this.pruneTerminalRecords();
    });
  }

  async release(
    runId: string,
    dispatchToken?: string,
    admissionSequence?: number
  ): Promise<boolean> {
    await this.initialized;
    const current = this.findByRunId(runId);
    if (!current || current.state === "terminal") {
      return false;
    }
    const stored = this.findStoredByRunId(runId);
    if (
      admissionSequence !== undefined &&
      stored?.sequence !== admissionSequence
    ) {
      return false;
    }
    if (dispatchToken && !this.dispatchTokenMatches(runId, dispatchToken)) {
      return false;
    }
    this.terminalizeRecord(runId, dispatchToken);
    this.pruneTerminalRecords();
    this.ctx.waitUntil(this.dispatchAvailable(admissionLimits(this.env)));
    await this.ensureAlarm({ throwOnFailure: true });
    return true;
  }

  async enqueueCleanup(
    agentId: string,
    runId: string,
    capability?: AdmissionCleanupCapability
  ): Promise<void> {
    await this.initialized;
    const current = this.findStoredByRunId(runId);
    if (!current && !capability) {
      return;
    }
    this.enqueueCleanupTask({
      agentId: capability?.agentId ?? agentId,
      enqueuedAt: new Date().toISOString(),
      operationId: capability?.operationId ?? `cleanup:${runId}`,
      requestHash: capability?.requestHash ?? "cleanup",
      runId,
      sequence: capability?.admissionSequence ?? current?.sequence ?? 0,
      state: current?.state ?? "terminal",
      tenantHash: "cleanup",
      ...((capability?.dispatchToken ?? current?.dispatchToken)
        ? {
            dispatchToken: capability?.dispatchToken ?? current?.dispatchToken,
          }
        : {}),
    });
    await this.ensureAlarm({ throwOnFailure: false });
  }

  async enqueueProvisionalCleanup(
    agentId: string,
    runId: string,
    prepareOwner: string,
    operationId?: string,
    requestHash?: string
  ): Promise<void> {
    await this.initialized;
    if (!agentId || !runId || !prepareOwner) {
      throw new AdmissionConfigurationError(
        "Provisional cleanup requires an agent, run, and prepare owner."
      );
    }
    this.ctx.storage.sql.exec(
      `
        INSERT INTO admission_cleanup_tasks
          (agent_id, run_id, admission_sequence, kind, dispatch_token,
             prepare_owner, operation_id, request_hash, attempts, next_attempt_at,
             confirmation_grace_until)
          VALUES (?, ?, 0, 'provisional', NULL, ?, ?, ?, 0, ?, ?)
          ON CONFLICT(run_id, admission_sequence) DO UPDATE SET
            agent_id = excluded.agent_id,
            kind = excluded.kind,
            prepare_owner = excluded.prepare_owner,
            operation_id = excluded.operation_id,
            request_hash = excluded.request_hash,
            attempts = 0,
            next_attempt_at = excluded.next_attempt_at,
            confirmation_grace_until = MAX(
              admission_cleanup_tasks.confirmation_grace_until,
              excluded.confirmation_grace_until
            )
          WHERE admission_cleanup_tasks.kind = 'provisional'
      `,
      agentId,
      runId,
      prepareOwner,
      operationId ?? `cleanup:${runId}`,
      requestHash ?? "cleanup",
      Date.now(),
      Date.now() + PROVISIONAL_CONFIRMATION_GRACE_MS
    );
    await this.ensureAlarm({ throwOnFailure: false });
  }

  async getCleanupCapability(
    runId: string,
    expected?: Pick<
      AdmissionCleanupCapability,
      "agentId" | "operationId" | "requestHash" | "runId"
    >
  ): Promise<AdmissionCleanupCapability | null> {
    await this.initialized;
    const current = this.findStoredByRunId(runId);
    if (!current || (expected && !matchesCleanupIdentity(current, expected))) {
      return null;
    }
    return {
      admissionSequence: current.sequence,
      agentId: current.agentId,
      ...(current.dispatchToken
        ? { dispatchToken: current.dispatchToken }
        : {}),
      operationId: current.operationId,
      requestHash: current.requestHash,
      runId: current.runId,
    };
  }

  async confirmPreparedAdmission(
    runId: string,
    prepareOwner: string | undefined,
    capability: AdmissionCleanupCapability
  ): Promise<PreparedAdmissionConfirmationOutcome> {
    await this.initialized;
    if (!capability) {
      return { kind: "stale" };
    }
    return this.ctx.storage.transactionSync(() => {
      const current = this.findStoredByRunId(runId);
      if (
        !current ||
        current.sequence !== capability.admissionSequence ||
        !matchesCleanupIdentity(current, {
          agentId: capability.agentId,
          operationId: capability.operationId,
          requestHash: capability.requestHash,
          runId,
        })
      ) {
        return { kind: "stale" };
      }
      if (current.state === "terminal") {
        return { kind: "terminal" };
      }
      if (current.dispatchToken !== capability.dispatchToken) {
        return { kind: "stale" };
      }
      this.ctx.storage.sql.exec(
        `
          DELETE FROM admission_cleanup_tasks
          WHERE run_id = ?
          AND admission_sequence = 0
          AND kind = 'provisional'
          AND (? IS NULL OR prepare_owner = ?)
          AND agent_id = ?
            AND operation_id = ?
            AND request_hash = ?
        `,
        runId,
        prepareOwner ?? null,
        prepareOwner ?? null,
        capability.agentId,
        capability.operationId,
        capability.requestHash
      );
      return { kind: "confirmed" };
    });
  }

  async validateCleanup(
    capability: AdmissionCleanupCapability
  ): Promise<boolean> {
    await this.initialized;
    const current = this.findStoredByRunId(capability.runId);
    if (
      !current ||
      current.sequence !== capability.admissionSequence ||
      !matchesCleanupIdentity(current, capability)
    ) {
      return false;
    }
    if (capability.dispatchToken) {
      return current.dispatchToken === capability.dispatchToken;
    }
    return true;
  }

  async getRecord(runId: string): Promise<AdmissionRecord | null> {
    await this.initialized;
    const record = this.findByRunId(runId);
    await this.ensureAlarm({ throwOnFailure: false });
    return record;
  }

  async validateDispatch(
    runId: string,
    dispatchToken: string
  ): Promise<boolean> {
    await this.initialized;
    if (!dispatchToken) {
      return false;
    }
    const record = this.findStoredByRunId(runId);
    return Boolean(
      record?.state === "active" &&
        record.dispatchToken === dispatchToken &&
        record.dispatchStartedAt &&
        record.dispatchLeaseUntil &&
        Date.parse(record.dispatchLeaseUntil) > Date.now()
    );
  }

  async getByOperationId(operationId: string): Promise<AdmissionRecord | null> {
    await this.initialized;
    const record = this.findByOperationId(operationId);
    await this.ensureAlarm({ throwOnFailure: false });
    return record ? publicRecord(record) : null;
  }

  async dispatch(): Promise<void> {
    await this.initialized;
    this.ctx.waitUntil(this.dispatchAvailable(admissionLimits(this.env)));
    await this.ensureAlarm({ throwOnFailure: true });
  }

  async alarm(): Promise<void> {
    await this.initialized;
    const now = Date.now();
    const expired = this.reconcileExpiredQueuedAdmissions(now);
    for (const record of expired) {
      // The tombstone is written before this RPC so capacity is released even
      // when the agent is unavailable. The durable task remains for retry.
      // biome-ignore lint/performance/noAwaitInLoops: cleanup is intentionally sequential
      await this.cleanupExpiredAdmission(record);
    }
    for (const record of this.readStoredRecords()) {
      if (record.state === "active") {
        // Reconciliation is serialized with the Durable Object state.
        // biome-ignore lint/performance/noAwaitInLoops: reconciliation is intentionally sequential
        const reconciliation = await this.reconcileActive(record);
        if (reconciliation === "refused") {
          await this.cleanupRejectedAdmission(record);
        }
      } else if (record.state === "queued") {
        // A queued run can become terminal when its agent is stopped before
        // dispatch. Reconcile it on the regular alarm cadence so a failed
        // release callback cannot occupy queue capacity until TTL expiry.
        await this.reconcileQueued(record);
      }
    }
    const requeuedExpired = this.reconcileExpiredQueuedAdmissions(now);
    for (const record of requeuedExpired) {
      // A dispatch lease can expire into a queued record during the
      // reconciliation pass. Tombstone it before dispatch selection too.
      // biome-ignore lint/performance/noAwaitInLoops: cleanup is intentionally sequential
      await this.cleanupExpiredAdmission(record);
    }
    await this.retryCleanupTasks();
    await this.dispatchAvailable(admissionLimits(this.env));
    this.pruneTerminalRecords();
    // A transient platform failure is recoverable on the next alarm, but
    // once repair is exhausted the exception must escape so the platform can
    // retry delivery while accepted work remains fail closed.
    try {
      await this.ensureAlarm({ throwOnFailure: true });
    } catch (error) {
      if (this.readAlarmFailureCount() >= MAX_ALARM_REPAIR_FAILURES) {
        throw error;
      }
    }
  }

  private async dispatchAvailable(limits: AdmissionLimits): Promise<void> {
    while (true) {
      const candidate = this.claimNextCandidate(limits);
      if (!candidate) {
        return;
      }
      let accepted = false;
      try {
        if (!candidate.dispatchToken) {
          // biome-ignore lint/performance/noAwaitInLoops: dispatches are intentionally sequential
          await this.reconcileDispatchFailure(candidate, false);
          return;
        }
        accepted = await this.env.YoloAgent.getByName(
          candidate.agentId
        ).startAdmitted(
          candidate.runId,
          candidate.dispatchToken,
          cleanupCapability(candidate)
        );
      } catch (error) {
        if (isAgentBusyError(error)) {
          const fenceToken = await this.fenceDispatch(
            candidate,
            !candidate.noQueue
          );
          const reconciliation = candidate.noQueue
            ? fenceToken
              ? this.refuseDispatch(candidate, fenceToken)
              : "ambiguous"
            : fenceToken
              ? this.requeueRecord(candidate, fenceToken)
              : "ambiguous";
          if (reconciliation === "refused") {
            await this.cleanupRejectedAdmission(candidate, !candidate.noQueue);
          }
          if (reconciliation === "requeued") {
            return;
          }
        }
        // Reconcile immediately so a dispatch error never makes capacity
        // depend on the next alarm. If the alarm cannot be repaired, close
        // this affected admission rather than leaving accepted work stranded.
        await this.reconcileDispatchFailure(candidate, false);
        return;
      }
      const current = this.findByRunId(candidate.runId);
      if (!current || current.state === "terminal" || accepted) {
        if (
          accepted &&
          this.dispatchTokenMatches(candidate.runId, candidate.dispatchToken)
        ) {
          this.clearDispatchLease(candidate.runId, candidate.dispatchToken);
        }
        continue;
      }
      if (
        !this.dispatchTokenMatches(candidate.runId, candidate.dispatchToken)
      ) {
        continue;
      }
      // A false response means the agent can tell us whether this run is
      // still queued, terminal, or absent. Do not strand the deployment slot.
      await this.reconcileDispatchFailure(candidate, true);
      if (this.findByRunId(candidate.runId)?.state === "queued") {
        return;
      }
    }
  }

  private async reconcileDispatchFailure(
    candidate: StoredAdmissionRecord,
    rpcCompleted: boolean
  ): Promise<void> {
    const reconciliation = rpcCompleted
      ? await this.reconcileCompletedDispatch(candidate)
      : await this.reconcileActive(candidate);
    if (reconciliation === "refused") {
      await this.cleanupRejectedAdmission(candidate);
      return;
    }
    const current = this.findByRunId(candidate.runId);
    if (!current || current.state === "terminal") {
      return;
    }

    try {
      await this.ensureAlarm({ throwOnFailure: true });
    } catch {
      const afterFailure = this.findByRunId(candidate.runId);
      if (reconciliation === "requeued" && afterFailure?.state === "queued") {
        this.terminalizeFailedAdmission(candidate, candidate.dispatchToken);
        try {
          const stopped = await this.stopForCleanup(
            candidate,
            !candidate.dispatchToken,
            "Run cancelled because admission reconciliation is unavailable."
          );
          if (!this.isTerminalOrAbsent(stopped)) {
            this.enqueueCleanupTask({
              ...candidate,
              dispatchToken: undefined,
            });
          }
        } catch {
          this.enqueueCleanupTask({
            ...candidate,
            dispatchToken: undefined,
          });
        }
      }
    }
  }

  private async reconcileCompletedDispatch(
    record: StoredAdmissionRecord
  ): Promise<ActiveReconciliation> {
    try {
      const run = await this.env.YoloAgent.getByName(record.agentId).getRun(
        record.runId
      );
      if (!this.dispatchTokenMatches(record.runId, record.dispatchToken)) {
        return "ambiguous";
      }
      if (!run) {
        const fenceToken = await this.fenceDispatch(record, false);
        if (
          !fenceToken ||
          !this.dispatchTokenMatches(record.runId, fenceToken)
        ) {
          return "ambiguous";
        }
        this.terminalizeRecord(record.runId, fenceToken);
        this.enqueueCleanupTask({ ...record, dispatchToken: fenceToken });
        return "terminal";
      }
      if (isTerminal(run.status)) {
        this.terminalizeRecord(record.runId, record.dispatchToken);
        return "terminal";
      }
      if (run.status === "queued") {
        const fenceToken = await this.fenceDispatch(record);
        if (!fenceToken) {
          return "ambiguous";
        }
        if (!this.dispatchTokenMatches(record.runId, fenceToken)) {
          return "ambiguous";
        }
        return record.noQueue
          ? this.refuseDispatch(record, fenceToken)
          : this.requeueRecord(record, fenceToken);
      }
      if (run.status === "running") {
        this.clearDispatchLease(record.runId, record.dispatchToken);
        return "running";
      }
      return "ambiguous";
    } catch {
      return "ambiguous";
    }
  }

  private requeueRecord(
    record: StoredAdmissionRecord,
    dispatchToken?: string
  ): ActiveReconciliation {
    const limits = admissionLimits(this.env);
    return this.ctx.storage.transactionSync(() => {
      this.reconcileExpiredQueuedAdmissionsInTransaction(Date.now());
      const current = this.readStoredRecords().find(
        (candidate) => candidate.runId === record.runId
      );
      if (
        current?.state !== "active" ||
        (dispatchToken && current.dispatchToken !== dispatchToken) ||
        (!dispatchToken && current.dispatchToken)
      ) {
        return "ambiguous";
      }

      if (
        this.queuedCountForTenant(current.tenantHash) >= limits.tenantQueuedRuns
      ) {
        this.terminalizeRecord(current.runId, dispatchToken);
        this.enqueueCleanupTask({ ...current, dispatchToken: undefined });
        return "refused";
      }

      this.ctx.storage.sql.exec(
        dispatchToken
          ? `
            UPDATE admission_records
            SET state = 'queued',
                dispatch_started_at = NULL,
                dispatch_lease_until = NULL,
                dispatch_token = NULL,
                terminalized_at = NULL
            WHERE run_id = ?
              AND state = 'active'
              AND dispatch_token = ?
          `
          : `
            UPDATE admission_records
            SET state = 'queued',
                dispatch_started_at = NULL,
                dispatch_lease_until = NULL,
                dispatch_token = NULL,
                terminalized_at = NULL
            WHERE run_id = ?
              AND state = 'active'
              AND dispatch_token IS NULL
          `,
        current.runId,
        ...(dispatchToken ? [dispatchToken] : [])
      );
      return "requeued";
    });
  }

  private refuseDispatch(
    record: StoredAdmissionRecord,
    dispatchToken: string
  ): ActiveReconciliation {
    const current = this.findStoredByRunId(record.runId);
    if (
      current?.state !== "active" ||
      current.dispatchToken !== dispatchToken
    ) {
      return "ambiguous";
    }
    this.terminalizeRecord(record.runId, dispatchToken);
    this.enqueueCleanupTask({ ...current, dispatchToken });
    return "refused";
  }

  private async ensureAlarm(options: {
    throwOnFailure: boolean;
  }): Promise<boolean> {
    const hasWork = this.hasLiveRecords() || this.hasCleanupTasks();
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
    const records = this.readStoredRecords();
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
    const cleanupDeadline = this.nextCleanupAt();
    const deadlines = [...queuedDeadlines, ...dispatchLeases].filter(
      (value) => Number.isFinite(value) && value > now
    );
    if (cleanupDeadline !== null && cleanupDeadline > now) {
      deadlines.push(cleanupDeadline);
    }
    return Math.min(now + ALARM_INTERVAL_MS, ...deadlines);
  }

  private async handleAlarmFailure(
    nextWake: number | null,
    error: unknown,
    throwOnFailure: boolean
  ): Promise<boolean> {
    const failures = this.readAlarmFailureCount() + 1;
    this.writeMetaValue(ALARM_FAILURES_META_KEY, String(failures));

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
      await this.failClosedQueuedAdmissions();
    }
    const outstanding = this.hasOutstandingCoordinatedState();
    this.writeMetaValue(
      ALARM_UNAVAILABLE_META_KEY,
      !repaired && outstanding ? "1" : "0"
    );
    if (
      !repaired &&
      throwOnFailure &&
      (failures < MAX_ALARM_REPAIR_FAILURES || outstanding)
    ) {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      throw new AdmissionUnavailableError(
        `Run admission alarm is unavailable${detail}`
      );
    }
    return repaired;
  }

  private hasOutstandingCoordinatedState(): boolean {
    return this.hasLiveRecords() || this.hasCleanupTasks();
  }

  private async failClosedQueuedAdmissions(): Promise<void> {
    const queued = this.readStoredRecords().filter(
      (record) => record.state === "queued"
    );
    for (const record of queued) {
      this.terminalizeFailedAdmission(record, record.dispatchToken);
      try {
        // biome-ignore lint/performance/noAwaitInLoops: fail-closed cleanup must be durable before returning.
        const stopped = await this.stopForCleanup(record);
        if (!this.isTerminalOrAbsent(stopped)) {
          this.enqueueCleanupTask({
            ...record,
            dispatchToken: undefined,
          });
        }
      } catch {
        this.enqueueCleanupTask({
          ...record,
          dispatchToken: undefined,
        });
      }
    }
    if (this.hasCleanupTasks()) {
      this.writeMetaValue(
        NEXT_WAKE_META_KEY,
        String(Date.now() + ALARM_REPAIR_RETRY_MS)
      );
    }
  }

  private reconcileExpiredQueuedAdmissions(
    now: number
  ): StoredAdmissionRecord[] {
    return this.ctx.storage.transactionSync(() =>
      this.reconcileExpiredQueuedAdmissionsInTransaction(now)
    );
  }

  private reconcileExpiredQueuedAdmissionsInTransaction(
    now: number
  ): StoredAdmissionRecord[] {
    const cutoff = new Date(now - QUEUED_TTL_MS).toISOString();
    const expired = this.ctx.storage.sql
      .exec<AdmissionRow>(
        `
          SELECT agent_id, dispatch_token, enqueued_at, mode, no_queue,
                 operation_id, request_hash, run_id, queue_sequence, state,
                 terminalized_at, tenant_hash
          FROM admission_records
          WHERE state = 'queued'
            AND dispatch_started_at IS NULL
            AND enqueued_at <= ?
          ORDER BY queue_sequence
        `,
        cutoff
      )
      .toArray()
      .map(rowToStoredRecord);

    for (const record of expired) {
      this.terminalizeRecord(record.runId, record.dispatchToken);
      this.enqueueCleanupTask(record);
    }
    return expired;
  }

  private queuedCountForTenant(tenantHash: string): number {
    const rows = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM admission_records WHERE state = 'queued' AND tenant_hash = ?",
        tenantHash
      )
      .toArray();
    return rows[0]?.count ?? 0;
  }

  private async cleanupExpiredAdmission(
    record: StoredAdmissionRecord
  ): Promise<void> {
    try {
      const stopped = await this.stopForCleanup(record);
      if (this.isTerminalOrAbsent(stopped)) {
        this.deleteCleanupTask(record.runId, record.sequence);
      }
    } catch {
      // The durable cleanup task will retry on a later alarm.
    }
  }

  private async cleanupRejectedAdmission(
    record: StoredAdmissionRecord,
    queuedOnly = false
  ): Promise<void> {
    const cleanupRecord = queuedOnly
      ? { ...record, dispatchToken: undefined }
      : record;
    try {
      const stopped = await this.stopForCleanup(
        cleanupRecord,
        queuedOnly,
        "Run refused because the tenant queue is full."
      );
      if (this.isTerminalOrAbsent(stopped)) {
        this.deleteCleanupTask(record.runId, record.sequence);
      }
    } catch {
      // The transition transaction already left a durable cleanup task.
    }
  }

  private async stopForCleanup(
    record: Pick<
      StoredAdmissionRecord,
      | "agentId"
      | "operationId"
      | "requestHash"
      | "runId"
      | "sequence"
      | "dispatchToken"
    >,
    queuedOnly = !record.dispatchToken,
    reason?: string
  ): Promise<unknown> {
    const agent = this.env.YoloAgent.getByName(record.agentId);
    const guard = {
      admissionSequence: record.sequence,
      agentId: record.agentId,
      ...(record.dispatchToken ? { dispatchToken: record.dispatchToken } : {}),
      operationId: record.operationId,
      queuedOnly,
      requestHash: record.requestHash,
      runId: record.runId,
    };
    return await agent.stop(record.runId, record.dispatchToken, reason, guard);
  }

  private hasCleanupTasks(): boolean {
    const rows = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM admission_cleanup_tasks"
      )
      .toArray();
    return (rows[0]?.count ?? 0) > 0;
  }

  private hasLiveRecords(): boolean {
    const rows = this.ctx.storage.sql
      .exec<{ found: number }>(
        "SELECT 1 AS found FROM admission_records WHERE state IN ('queued', 'active') LIMIT 1"
      )
      .toArray();
    return rows.length > 0;
  }

  private hasGlobalRetentionCapacity(): boolean {
    const rows = this.ctx.storage.sql
      .exec<{ count: number }>(
        `
          SELECT
            (SELECT COUNT(*) FROM admission_records) +
            (SELECT COUNT(*) FROM admission_cleanup_tasks) AS count
        `
      )
      .toArray();
    return (rows[0]?.count ?? 0) < MAX_GLOBAL_ADMISSION_ENTRIES;
  }

  private nextCleanupAt(): number | null {
    const rows = this.ctx.storage.sql
      .exec<{ next_attempt_at: number }>(
        "SELECT next_attempt_at FROM admission_cleanup_tasks ORDER BY next_attempt_at, run_id LIMIT 1"
      )
      .toArray();
    return rows[0]?.next_attempt_at ?? null;
  }

  private enqueueCleanupTask(record: StoredAdmissionRecord): void {
    this.ctx.storage.sql.exec(
      `
        INSERT INTO admission_cleanup_tasks
          (agent_id, run_id, admission_sequence, kind, dispatch_token,
           operation_id, request_hash, attempts, next_attempt_at)
        VALUES (?, ?, ?, 'admission', ?, ?, ?, 0, ?)
        ON CONFLICT(run_id, admission_sequence) DO NOTHING
      `,
      record.agentId,
      record.runId,
      record.sequence,
      record.dispatchToken ?? null,
      record.operationId,
      record.requestHash,
      Date.now()
    );
  }

  private invalidateOlderCleanupTasks(
    runId: string,
    admissionSequence: number
  ): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM admission_cleanup_tasks WHERE run_id = ? AND admission_sequence <> ? AND kind = 'admission'",
      runId,
      admissionSequence
    );
  }

  private deleteCleanupTask(
    runId: string,
    admissionSequence: number,
    kind?: "admission" | "provisional"
  ): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM admission_cleanup_tasks
       WHERE run_id = ? AND admission_sequence = ?
         ${kind ? "AND kind = ?" : ""}`,
      runId,
      admissionSequence,
      ...(kind ? [kind] : [])
    );
  }

  private isTerminalOrAbsent(value: unknown): boolean {
    if (value === null) {
      return true;
    }
    if (
      typeof value !== "object" ||
      !("status" in value) ||
      typeof value.status !== "string"
    ) {
      return false;
    }
    return (
      value.status === "cancelled" ||
      value.status === "completed" ||
      value.status === "failed"
    );
  }

  private rescheduleCleanupTask(
    task: {
      admission_sequence: number;
      attempts: number;
      kind: "admission" | "provisional";
      run_id: string;
    },
    nextAttemptAt = Date.now() + ALARM_REPAIR_RETRY_MS
  ): void {
    this.ctx.storage.sql.exec(
      "UPDATE admission_cleanup_tasks SET attempts = ?, next_attempt_at = ? WHERE run_id = ? AND admission_sequence = ? AND kind = ?",
      task.attempts + 1,
      nextAttemptAt,
      task.run_id,
      task.admission_sequence,
      task.kind
    );
  }

  private async retryCleanupTasks(): Promise<void> {
    const tasks = this.ctx.storage.sql
      .exec<{
        admission_sequence: number;
        agent_id: string;
        attempts: number;
        dispatch_token: string | null;
        kind: "admission" | "provisional";
        next_attempt_at: number;
        confirmation_grace_until: number;
        operation_id: string | null;
        prepare_owner: string | null;
        request_hash: string | null;
        run_id: string;
      }>(
        `
          SELECT agent_id, admission_sequence, attempts, dispatch_token, kind,
                 next_attempt_at, confirmation_grace_until, operation_id,
                 prepare_owner, request_hash, run_id
          FROM admission_cleanup_tasks
          WHERE next_attempt_at <= ?
          ORDER BY next_attempt_at, run_id, admission_sequence
          LIMIT ${MAX_CLEANUP_TASKS_PER_ALARM}
        `,
        Date.now()
      )
      .toArray();
    for (const task of tasks) {
      if (task.kind === "provisional") {
        const now = Date.now();
        const graceUntil =
          task.confirmation_grace_until > 0
            ? task.confirmation_grace_until
            : now + PROVISIONAL_CONFIRMATION_GRACE_MS;
        const current = this.findStoredByRunId(task.run_id);
        const sameIncarnation =
          current !== null &&
          matchesCleanupIdentity(current, {
            agentId: task.agent_id,
            operationId: task.operation_id ?? "",
            requestHash: task.request_hash ?? "",
            runId: task.run_id,
          });
        if (current && !sameIncarnation) {
          this.deleteCleanupTask(
            task.run_id,
            task.admission_sequence,
            "provisional"
          );
          continue;
        }

        let confirmed = false;
        try {
          const agent = this.env.YoloAgent.getByName(task.agent_id);
          const { isAdmissionConfirmed } = agent as unknown as {
            isAdmissionConfirmed?: (
              runId: string,
              prepareOwner: string
            ) => Promise<boolean> | boolean;
          };
          confirmed = Boolean(
            isAdmissionConfirmed &&
              // biome-ignore lint/performance/noAwaitInLoops: Cleanup tasks are deliberately processed sequentially.
              (await isAdmissionConfirmed.call(
                agent,
                task.run_id,
                task.prepare_owner ?? ""
              ))
          );
        } catch {
          confirmed = false;
        }
        if (confirmed) {
          this.deleteCleanupTask(
            task.run_id,
            task.admission_sequence,
            "provisional"
          );
          continue;
        }

        if (
          current?.state === "queued" ||
          current?.state === "active" ||
          now < graceUntil
        ) {
          this.rescheduleCleanupTask(
            task,
            Math.max(graceUntil, now + ALARM_REPAIR_RETRY_MS)
          );
          continue;
        }

        let completed: boolean | "protected" | "confirmed" = false;
        try {
          const agent = this.env.YoloAgent.getByName(task.agent_id);
          const { discardPreparedRun } = agent as unknown as {
            discardPreparedRun?: (
              runId: string,
              prepareOwner: string
            ) =>
              | Promise<boolean | "protected" | "confirmed">
              | boolean
              | "protected"
              | "confirmed";
          };
          completed = discardPreparedRun
            ? await discardPreparedRun.call(
                agent,
                task.run_id,
                task.prepare_owner ?? ""
              )
            : false;
        } catch {
          completed = false;
        }
        if (completed === true || completed === "confirmed") {
          this.deleteCleanupTask(
            task.run_id,
            task.admission_sequence,
            "provisional"
          );
        } else {
          this.rescheduleCleanupTask(task);
        }
        continue;
      }
      const current = this.findStoredByRunId(task.run_id);
      if (!current) {
        this.deleteCleanupTask(task.run_id, task.admission_sequence);
        continue;
      }
      if (current.sequence !== task.admission_sequence) {
        this.deleteCleanupTask(task.run_id, task.admission_sequence);
        continue;
      }
      if (current.agentId !== task.agent_id) {
        this.ctx.storage.sql.exec(
          "UPDATE admission_cleanup_tasks SET attempts = ?, next_attempt_at = ? WHERE run_id = ? AND admission_sequence = ?",
          task.attempts + 1,
          Date.now() + ALARM_REPAIR_RETRY_MS,
          task.run_id,
          task.admission_sequence
        );
        continue;
      }
      let completed = false;
      try {
        const stopped = await this.stopForCleanup({
          agentId: task.agent_id,
          ...(task.dispatch_token
            ? { dispatchToken: task.dispatch_token }
            : {}),
          operationId: current.operationId,
          requestHash: current.requestHash,
          runId: task.run_id,
          sequence: task.admission_sequence,
        });
        completed = this.isTerminalOrAbsent(stopped);
      } catch {
        completed = false;
      }
      if (completed) {
        try {
          const released = await this.release(
            task.run_id,
            task.dispatch_token ?? undefined,
            task.admission_sequence
          );
          completed =
            released ||
            this.findStoredByRunId(task.run_id)?.sequence !==
              task.admission_sequence ||
            this.findByRunId(task.run_id)?.state === "terminal" ||
            this.findByRunId(task.run_id) === null;
        } catch {
          completed = false;
        }
      }
      if (completed) {
        this.deleteCleanupTask(task.run_id, task.admission_sequence);
      } else {
        this.ctx.storage.sql.exec(
          "UPDATE admission_cleanup_tasks SET attempts = ?, next_attempt_at = ? WHERE run_id = ? AND admission_sequence = ?",
          task.attempts + 1,
          Date.now() + ALARM_REPAIR_RETRY_MS,
          task.run_id,
          task.admission_sequence
        );
      }
    }
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
  ): StoredAdmissionRecord | undefined {
    const [pending] = this.ctx.storage.sql
      .exec<AdmissionRow>(
        `
          SELECT agent_id, dispatch_token, enqueued_at, mode, no_queue,
                 operation_id, request_hash, run_id, queue_sequence, state,
                 terminalized_at, tenant_hash
          FROM admission_records
          WHERE state = 'active'
            AND dispatch_started_at = 'pending'
            AND dispatch_lease_until > ?
          ORDER BY queue_sequence
          LIMIT 1
        `,
        new Date(Date.now()).toISOString()
      )
      .toArray()
      .map(rowToStoredRecord);
    if (pending) {
      const { dispatchToken } = pending;
      if (!dispatchToken) {
        return;
      }
      this.claimDispatchLease(pending.runId, dispatchToken);
      return { ...pending, dispatchToken };
    }
    const queue = new AdmissionQueue({
      limits,
      records: this.readStoredRecords(),
      scheduler: this.readScheduler(),
    });
    const candidate = queue.nextDispatchCandidate();
    if (!candidate) {
      return;
    }
    const dispatchToken = this.claimDispatchLease(candidate.runId);
    this.writeScheduler(queue.scheduler());
    return { ...candidate, dispatchToken };
  }

  private async reconcileActive(
    record: StoredAdmissionRecord
  ): Promise<ActiveReconciliation> {
    try {
      const agent = this.env.YoloAgent.getByName(record.agentId);
      const repair = (
        agent as unknown as {
          repairSandboxCleanup?: () => Promise<boolean>;
        }
      ).repairSandboxCleanup;
      if (repair && !(await repair.call(agent))) {
        return "running";
      }
      let run = await agent.getRun(record.runId);
      const current = this.findByRunId(record.runId);
      if (current?.state !== "active") {
        return "terminal";
      }
      if (!this.dispatchTokenMatches(record.runId, record.dispatchToken)) {
        return "ambiguous";
      }
      const ensureFiber = (
        agent as unknown as {
          ensureAdmittedFiber?: (
            runId: string,
            dispatchToken: string,
            capability: AdmissionCleanupCapability
          ) => Promise<boolean>;
        }
      ).ensureAdmittedFiber;
      if (ensureFiber && record.dispatchToken) {
        const ensured = await ensureFiber.call(
          agent,
          record.runId,
          record.dispatchToken,
          cleanupCapability(record)
        );
        if (ensured) {
          run = await agent.getRun(record.runId);
        } else {
          run = await agent.getRun(record.runId);
          if (!run || !isTerminal(run.status)) {
            return "ambiguous";
          }
        }
      }
      const leaseUntil = this.dispatchLeaseUntil(record.runId);
      const leaseExpired = leaseUntil === null || leaseUntil <= Date.now();
      if (!run) {
        if (!leaseExpired) {
          return "ambiguous";
        }
        const fenceToken = await this.fenceDispatch(record, false);
        if (
          !fenceToken ||
          !this.dispatchTokenMatches(record.runId, fenceToken)
        ) {
          return "ambiguous";
        }
        this.terminalizeRecord(record.runId, fenceToken);
        this.enqueueCleanupTask({ ...record, dispatchToken: fenceToken });
        return "terminal";
      }
      if (run.status === "running") {
        this.clearDispatchLease(record.runId, record.dispatchToken);
        return "running";
      }
      if (isTerminal(run.status)) {
        this.terminalizeRecord(record.runId, record.dispatchToken);
        return "terminal";
      }
      if (run.status === "queued" && leaseExpired) {
        const fenceToken = await this.fenceDispatch(record);
        if (!fenceToken) {
          return "ambiguous";
        }
        if (!this.dispatchTokenMatches(record.runId, fenceToken)) {
          return "ambiguous";
        }
        return record.noQueue
          ? this.refuseDispatch(record, fenceToken)
          : this.requeueRecord(record, fenceToken);
      }
      return "ambiguous";
    } catch {
      // Keep the active record and retry after its dispatch lease. The start
      // RPC may have succeeded remotely, so this claim must remain counted.
      return "ambiguous";
    }
  }

  private async reconcileQueued(record: StoredAdmissionRecord): Promise<void> {
    try {
      const run = await this.env.YoloAgent.getByName(record.agentId).getRun(
        record.runId
      );
      const current = this.findByRunId(record.runId);
      if (current?.state !== "queued") {
        return;
      }
      if (!run || isTerminal(run.status)) {
        this.terminalizeRecord(record.runId, record.dispatchToken);
      }
    } catch {
      // Keep the queued record and retry on the next alarm.
    }
  }

  private async fenceDispatch(
    record: StoredAdmissionRecord,
    allowRequeue = true
  ): Promise<string | false> {
    const dispatchToken =
      record.dispatchToken ?? this.createCompatibilityDispatchToken(record);
    if (!dispatchToken) {
      return false;
    }
    try {
      const agent = this.env.YoloAgent.getByName(record.agentId);
      const fenced = await agent.fenceAdmitted(record.runId, dispatchToken);
      if (!fenced) {
        return false;
      }
      if (!allowRequeue) {
        return dispatchToken;
      }
      const requeue = (
        agent as unknown as {
          requeueAdmitted?: (
            runId: string,
            token: string
          ) => Promise<boolean> | boolean;
        }
      ).requeueAdmitted;
      if (!requeue) {
        return dispatchToken;
      }
      return (await requeue.call(agent, record.runId, dispatchToken))
        ? dispatchToken
        : false;
    } catch {
      return false;
    }
  }

  private createCompatibilityDispatchToken(
    record: StoredAdmissionRecord
  ): string | undefined {
    const generation = this.readNextDispatchGeneration();
    const dispatchToken = `${generation}:compat-${crypto.randomUUID()}`;
    this.writeMetaValue(
      NEXT_DISPATCH_GENERATION_META_KEY,
      String(generation + 1)
    );
    this.ctx.storage.sql.exec(
      `
        UPDATE admission_records
        SET dispatch_token = ?
        WHERE run_id = ?
          AND state = 'active'
          AND dispatch_token IS NULL
      `,
      dispatchToken,
      record.runId
    );
    return this.dispatchTokenMatches(record.runId, dispatchToken)
      ? dispatchToken
      : undefined;
  }

  private readStoredRecords(): StoredAdmissionRecord[] {
    return this.ctx.storage.sql
      .exec<AdmissionRow>(
        "SELECT agent_id, dispatch_token, enqueued_at, mode, no_queue, operation_id, request_hash, run_id, queue_sequence, state, terminalized_at, tenant_hash FROM admission_records ORDER BY queue_sequence"
      )
      .toArray()
      .map(rowToStoredRecord);
  }

  private findByOperationId(operationId: string): StoredAdmissionRecord | null {
    const rows = this.ctx.storage.sql
      .exec<AdmissionRow>(
        "SELECT agent_id, dispatch_token, enqueued_at, mode, no_queue, operation_id, request_hash, run_id, queue_sequence, state, terminalized_at, tenant_hash FROM admission_records WHERE operation_id = ?",
        operationId
      )
      .toArray();
    return rows[0] ? rowToStoredRecord(rows[0]) : null;
  }

  private findByRunId(runId: string): AdmissionRecord | null {
    const record = this.findStoredByRunId(runId);
    return record ? publicRecord(record) : null;
  }

  private findStoredByRunId(runId: string): StoredAdmissionRecord | null {
    const rows = this.ctx.storage.sql
      .exec<AdmissionRow>(
        "SELECT agent_id, dispatch_token, enqueued_at, mode, no_queue, operation_id, request_hash, run_id, queue_sequence, state, terminalized_at, tenant_hash, dispatch_started_at, dispatch_lease_until FROM admission_records WHERE run_id = ?",
        runId
      )
      .toArray();
    return rows[0] ? rowToStoredRecord(rows[0]) : null;
  }

  private writeRecord(record: StoredAdmissionRecord): void {
    this.ctx.storage.sql.exec(
      `
        INSERT INTO admission_records
          (agent_id, enqueued_at, mode, no_queue, operation_id, request_hash, run_id, queue_sequence, state, tenant_hash, dispatch_started_at, dispatch_lease_until, dispatch_token, terminalized_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          agent_id = excluded.agent_id,
          enqueued_at = excluded.enqueued_at,
          mode = excluded.mode,
          no_queue = excluded.no_queue,
          operation_id = excluded.operation_id,
          request_hash = excluded.request_hash,
          queue_sequence = excluded.queue_sequence,
          state = excluded.state,
          tenant_hash = excluded.tenant_hash,
          dispatch_started_at = NULL,
          dispatch_lease_until = NULL,
          dispatch_token = NULL,
          terminalized_at = NULL
        WHERE admission_records.state <> 'terminal'
           OR excluded.state = 'terminal'
      `,
      record.agentId,
      record.enqueuedAt,
      record.mode,
      record.noQueue ? 1 : 0,
      record.operationId,
      record.requestHash,
      record.runId,
      record.sequence,
      record.state,
      record.tenantHash,
      record.dispatchToken ?? null,
      record.terminalizedAt ?? null
    );
  }

  private terminalizeRecord(runId: string, dispatchToken?: string): void {
    const terminalizedAt = new Date(Date.now()).toISOString();
    this.ctx.storage.sql.exec(
      dispatchToken
        ? "UPDATE admission_records SET state = 'terminal', dispatch_started_at = NULL, dispatch_lease_until = NULL, dispatch_token = NULL, terminalized_at = ? WHERE run_id = ? AND state IN ('queued', 'active') AND dispatch_token = ?"
        : "UPDATE admission_records SET state = 'terminal', dispatch_started_at = NULL, dispatch_lease_until = NULL, dispatch_token = NULL, terminalized_at = ? WHERE run_id = ? AND state IN ('queued', 'active')",
      terminalizedAt,
      runId,
      ...(dispatchToken ? [dispatchToken] : [])
    );
  }

  private updateDispatchLease(
    runId: string,
    startedAt: string,
    leaseUntil: string,
    dispatchToken: string
  ): void {
    this.ctx.storage.sql.exec(
      "UPDATE admission_records SET state = 'active', dispatch_started_at = ?, dispatch_lease_until = ?, dispatch_token = ?, terminalized_at = NULL WHERE run_id = ?",
      startedAt,
      leaseUntil,
      dispatchToken,
      runId
    );
  }

  private markDispatchPending(runId: string): StoredAdmissionRecord | null {
    const dispatchToken = this.newDispatchToken();
    this.ctx.storage.sql.exec(
      `
        UPDATE admission_records
        SET dispatch_started_at = 'pending',
            dispatch_lease_until = ?,
            dispatch_token = ?,
            terminalized_at = NULL
        WHERE run_id = ?
          AND state = 'active'
      `,
      new Date(Date.now() + DISPATCH_LEASE_MS).toISOString(),
      dispatchToken,
      runId
    );
    return this.findStoredByRunId(runId);
  }

  private claimDispatchLease(runId: string, token?: string): string {
    const startedAt = new Date(Date.now()).toISOString();
    const dispatchToken = token ?? this.newDispatchToken();
    this.updateDispatchLease(
      runId,
      startedAt,
      new Date(Date.now() + DISPATCH_LEASE_MS).toISOString(),
      dispatchToken
    );
    return dispatchToken;
  }

  private newDispatchToken(): string {
    const generation = this.readNextDispatchGeneration();
    this.writeMetaValue(
      NEXT_DISPATCH_GENERATION_META_KEY,
      String(generation + 1)
    );
    return `${generation}:${crypto.randomUUID()}`;
  }

  private clearDispatchLease(runId: string, dispatchToken?: string): void {
    this.ctx.storage.sql.exec(
      dispatchToken
        ? "UPDATE admission_records SET dispatch_started_at = NULL, dispatch_lease_until = NULL WHERE run_id = ? AND dispatch_token = ?"
        : "UPDATE admission_records SET dispatch_started_at = NULL, dispatch_lease_until = NULL WHERE run_id = ?",
      runId,
      ...(dispatchToken ? [dispatchToken] : [])
    );
  }

  private pruneTerminalRecords(reservedEntries = 0): void {
    const retention = Math.min(
      terminalRetention(this.env),
      MAX_TERMINAL_RUNS_PER_AGENT
    );
    this.ctx.storage.sql.exec(
      `
        DELETE FROM admission_records
        WHERE state = 'terminal'
          AND run_id IN (
            SELECT run_id
            FROM (
              SELECT
                run_id,
                ROW_NUMBER() OVER (
                  PARTITION BY agent_id
                  ORDER BY
                    COALESCE(terminalized_at, enqueued_at) DESC,
                    queue_sequence DESC
                ) AS retention_rank
              FROM admission_records
              WHERE state = 'terminal'
            )
            WHERE retention_rank > ?
          )
          AND NOT EXISTS (
            SELECT 1
            FROM admission_cleanup_tasks AS cleanup
            WHERE cleanup.run_id = admission_records.run_id
              AND cleanup.admission_sequence = admission_records.queue_sequence
          )
      `,
      retention
    );

    const recordRows = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM admission_records"
      )
      .toArray();
    const removableRows = this.ctx.storage.sql
      .exec<{ count: number }>(
        `
          SELECT COUNT(*) AS count
          FROM admission_records
          WHERE state = 'terminal'
            AND NOT EXISTS (
              SELECT 1
              FROM admission_cleanup_tasks AS cleanup
              WHERE cleanup.run_id = admission_records.run_id
                AND cleanup.admission_sequence = admission_records.queue_sequence
            )
        `
      )
      .toArray();
    const taskRows = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM admission_cleanup_tasks"
      )
      .toArray();
    const ceiling = MAX_GLOBAL_ADMISSION_ENTRIES - reservedEntries;
    const excess = Math.max(
      0,
      Math.min(
        removableRows[0]?.count ?? 0,
        (recordRows[0]?.count ?? 0) + (taskRows[0]?.count ?? 0) - ceiling
      )
    );
    if (excess === 0) {
      return;
    }
    this.ctx.storage.sql.exec(
      `
        DELETE FROM admission_records
        WHERE state = 'terminal'
          AND run_id IN (
            SELECT run_id
            FROM admission_records
            WHERE state = 'terminal'
              AND NOT EXISTS (
                SELECT 1
                FROM admission_cleanup_tasks AS cleanup
                WHERE cleanup.run_id = admission_records.run_id
                  AND cleanup.admission_sequence =
                    admission_records.queue_sequence
              )
            ORDER BY COALESCE(terminalized_at, enqueued_at), queue_sequence
            LIMIT ?
          )
      `,
      excess
    );
  }

  private dispatchTokenMatches(
    runId: string,
    dispatchToken: string | undefined
  ): boolean {
    if (!dispatchToken) {
      return true;
    }
    const rows = this.ctx.storage.sql
      .exec<{ dispatch_token: string | null }>(
        "SELECT dispatch_token FROM admission_records WHERE run_id = ?",
        runId
      )
      .toArray();
    return rows[0]?.dispatch_token === dispatchToken;
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

  private readNextDispatchGeneration(): number {
    const value = Number(
      this.readMetaValue(NEXT_DISPATCH_GENERATION_META_KEY) ?? "1"
    );
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new AdmissionConfigurationError(
        "Run admission dispatch generation storage is invalid."
      );
    }
    return value;
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

  private readNextSequence(): number {
    const persisted = Number(this.readMetaValue(NEXT_SEQUENCE_META_KEY) ?? "1");
    const rows = this.ctx.storage.sql
      .exec<{ max_sequence: number | null }>(
        "SELECT MAX(queue_sequence) AS max_sequence FROM admission_records"
      )
      .toArray();
    const highest = (rows[0]?.max_sequence ?? 0) + 1;
    if (!Number.isSafeInteger(persisted) || persisted < 1) {
      throw new AdmissionConfigurationError(
        "Run admission sequence storage is invalid."
      );
    }
    return Math.max(persisted, highest);
  }
}
