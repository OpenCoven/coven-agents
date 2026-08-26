import { getSandbox } from "@cloudflare/sandbox";
import {
  type AgentDefinition,
  agentDefinitionSchema,
  type CommandEvidence,
  type FileEvidence,
  type RunEvent,
  type RunResult,
  type RunSnapshot,
  runSnapshotToResult,
  startRunInputSchema,
  type WarmState,
} from "@opencoven/agent-contracts";
import type {
  HarnessStatus,
  RunEvent as HarnessStreamEvent,
} from "@opencoven/harness";
import {
  Agent,
  type FiberRecoveryContext,
  type FiberRecoveryResult,
} from "agents";
import {
  HarnessError,
  listCloudHarnesses,
  PROBE_TIMEOUT_MS,
  RUN_TIMEOUT_MS,
  runHarnessInSandbox,
  warmSandbox,
} from "./harness-runner";
import {
  AgentBusyError,
  AgentDecommissioningError,
  AlreadyRunningError,
  appendEvents,
  type CloudRunRecord,
  cloudFiberKey,
  finishCloudRunRecord,
  isTerminal,
  liveCloudRunEvent,
  MAX_TERMINAL_RUNS_PER_AGENT,
  nextEventId,
  OperationConflictError,
  planCloudRunStart,
  recoverCloudRunRecord,
  retainCloudRuns,
  validateCloudWorkspace,
} from "./run-state";
import { sandboxKey, tenantOf } from "./tenant";
import {
  fetchTenantCredential,
  normalizeCredential,
} from "./tenant-credentials";

type DirectoryState = {
  agents: AgentDefinition[];
  /**
   * Run id to agent id. A run route receives only a run id, and the Durable
   * Object that owns the run cannot be addressed without knowing which agent
   * it belongs to, so the mapping has to live somewhere both can reach.
   */
  runs?: Record<string, string>;
  runRegistrations?: Record<string, RunRegistration>;
  nextRunRegistrationSequence?: number;
  pendingRunStatuses?: Record<string, RunRegistration>;
  pendingUnregisters?: Record<string, string>;
};

type RunRegistrationStatus = "active" | "queued" | "terminal" | "unknown";

type RunRegistration = {
  agentId: string;
  sequence: number;
  status: RunRegistrationStatus;
};

type DirectoryRunMappings = {
  nextSequence: number;
  registrations: Record<string, RunRegistration>;
  runs: Record<string, string>;
};

type AdmissionFence = {
  cancelled?: boolean;
  generation?: number;
  tokens?: string[];
};

type SandboxCleanup = {
  attempts: number;
  finalStatus: "cancelled" | "failed";
  generation: number;
  message: string;
  nextAttemptAt: number;
  owner: string;
  dispatchToken?: string;
  runId?: string;
};

type SandboxOwnership = {
  cleanup?: SandboxCleanup;
  cleanupRetryScheduleGeneration?: number;
  cleanupRetryScheduleId?: string;
  cleanupRetryScheduleToken?: string;
  generation: number;
  owner?: string;
  dispatchToken?: string;
  runId?: string;
};

type CleanupRetryPayload = {
  generation: number;
  token: string;
};

type AdmissionReleaseIntent = {
  dispatchToken?: string;
};

type DecommissionSaga = {
  admissionReleases: Record<string, AdmissionReleaseIntent>;
  lastError?: string;
  retryScheduleId?: string;
};

type YoloAgentState = {
  admissionFences?: Record<string, AdmissionFence | string[]>;
  admissionTokens?: Record<string, string>;
  decommission?: DecommissionSaga;
  dispatchClaims?: Record<string, string>;
  definition: AgentDefinition | null;
  identityCapabilities?: Record<string, StoredIdentityCapability>;
  /** Legacy pre-capability state; migrated on the next queued retry. */
  identityTokens?: Record<string, string>;
  lifecycle: {
    generation: number;
    status: "active" | "decommissioning" | "decommissioned";
  };
  runs: CloudRunRecord[];
  sandbox?: SandboxOwnership;
  warmFiberKey?: string;
};

type AgentLifecycle = YoloAgentState["lifecycle"];

const WARM_FIBER_KEY = "warm";
const CLEANUP_RETRY_DELAY_MS = 5000;
export const PENDING_ADMISSION_TIMEOUT_MS = 30_000;
const MAX_LEGACY_ADMISSION_FENCE_TOKENS = 32;
const MAX_ADMISSION_FENCE_TOMBSTONES = 128;
const MAX_PENDING_RUN_STATUS_UPDATES = 128;
const LEGACY_RUN_MIGRATION_BATCH = MAX_TERMINAL_RUNS_PER_AGENT;
const IDENTITY_CAPABILITY_TTL_MS = 15 * 60 * 1000;

type StoredIdentityCapability = {
  ciphertext: string;
  expiresAt: number;
  iv: string;
};

type PendingAdmissionSchedulePayload = {
  generation: number;
  runId: string;
  token: string;
};

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64Decode(value: string): ArrayBuffer {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
    .buffer as ArrayBuffer;
}

function dispatchGeneration(dispatchToken: string): number | undefined {
  const prefix = dispatchToken.match(/^([1-9]\d*):/u)?.[1];
  if (!prefix) {
    return;
  }
  const generation = Number(prefix);
  return Number.isSafeInteger(generation) ? generation : undefined;
}

function normalizeAdmissionFence(
  fence: AdmissionFence | string[] | undefined
): AdmissionFence {
  if (Array.isArray(fence)) {
    return { tokens: fence };
  }
  return fence ?? {};
}

function rejectsAdmissionToken(
  fence: AdmissionFence | string[] | undefined,
  dispatchToken?: string
): boolean {
  const normalized = normalizeAdmissionFence(fence);
  if (normalized.cancelled) {
    return true;
  }
  if (normalized.generation !== undefined && !dispatchToken) {
    return true;
  }
  if (!dispatchToken) {
    return false;
  }
  const generation = dispatchGeneration(dispatchToken);
  if (
    normalized.generation !== undefined &&
    (generation === undefined || generation <= normalized.generation)
  ) {
    return true;
  }
  return normalized.tokens?.includes(dispatchToken) ?? false;
}

/**
 * How long a warmed-but-idle container is kept before it sleeps, and — the
 * same number on purpose — how long a recorded `ready` is trusted before a
 * new trigger re-probes. The container pool caps at ten lite instances, so
 * this is the paid-idle window per warmed profile, chosen to cover the gap
 * between creating a profile and typing its first mission.
 */
const WARM_SLEEP_AFTER = "10m";
const WARM_TRUST_WINDOW_MS = 10 * 60 * 1000;
/**
 * When a non-terminal run is provably a ghost: the probe deadline plus the
 * run deadline plus two minutes of margin for dispatch and persistence. No
 * live fiber can exist past this — both deadlines throw, and the catch
 * closes the record — so anything older with a live status was interrupted
 * before its catch could run.
 */
const RUN_OVERDUE_MS = PROBE_TIMEOUT_MS + RUN_TIMEOUT_MS + 120_000;

/**
 * The harness and the contract name file operations differently — the harness
 * reports `created`/`edited`/`deleted`, the contract accepts
 * `create`/`modify`/`delete`. Translating explicitly is the point: filtering to
 * the values the contract allows would have matched none of them and dropped
 * every file operation without a word.
 */
export const FILE_OPERATIONS: Record<string, FileEvidence["operation"]> = {
  created: "create",
  deleted: "delete",
  edited: "modify",
};

export function toFileEvidence(
  operations: { operation: string; path: string }[]
): FileEvidence[] {
  return operations.flatMap((entry) => {
    const operation = Object.hasOwn(FILE_OPERATIONS, entry.operation)
      ? FILE_OPERATIONS[entry.operation]
      : undefined;
    if (!operation) {
      // An unmapped verb means the harness grew one the contract has not
      // learned. Say so rather than discarding the evidence silently.
      console.warn(
        JSON.stringify({
          event: "runner.evidence.unmapped_file_operation",
          operation: entry.operation,
        })
      );
      return [];
    }
    return [{ operation, path: entry.path }];
  });
}

/**
 * Delegates to the contract so the worker and the browser client cannot
 * disagree about how a snapshot becomes a result.
 */
export function toRunResult(record: CloudRunRecord): RunResult {
  return runSnapshotToResult(record.run);
}

export class AgentDirectory extends Agent<Env, DirectoryState> {
  initialState: DirectoryState = {
    agents: [],
    nextRunRegistrationSequence: 1,
    pendingRunStatuses: {},
    pendingUnregisters: {},
    runRegistrations: {},
    runs: {},
  };

  list(tenantId: string): AgentDefinition[] {
    this.drainPendingUnregisters();
    return this.state.agents
      .filter((agent) => tenantOf(agent) === tenantId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  upsert(definition: AgentDefinition): AgentDefinition {
    const parsed = agentDefinitionSchema.parse(definition);
    this.setState({
      // Spread first: replacing the whole object would drop the run index and
      // orphan every run id already registered against this directory.
      ...this.state,
      agents: [
        parsed,
        ...this.state.agents.filter((agent) => agent.id !== parsed.id),
      ],
    });
    return parsed;
  }

  remove(agentId: string): void {
    const mappings = this.migrateRunMappings();
    const runs = Object.fromEntries(
      Object.entries(mappings.runs).filter(([, owner]) => owner !== agentId)
    );
    const registrations = Object.fromEntries(
      Object.entries(mappings.registrations).filter(
        ([, registration]) => registration.agentId !== agentId
      )
    );
    const pendingUnregisters = Object.fromEntries(
      Object.entries(this.state.pendingUnregisters ?? {}).filter(
        ([, owner]) => owner !== agentId
      )
    );
    const pendingRunStatuses = Object.fromEntries(
      Object.entries(this.state.pendingRunStatuses ?? {}).filter(
        ([, registration]) => registration.agentId !== agentId
      )
    );
    const pruned = this.pruneRunMappings(runs, registrations);
    this.directorySql(
      "DELETE FROM agent_directory_legacy_runs WHERE agent_id = ?",
      [agentId]
    );
    this.setState({
      ...this.state,
      agents: this.state.agents.filter((agent) => agent.id !== agentId),
      nextRunRegistrationSequence: mappings.nextSequence,
      pendingRunStatuses,
      pendingUnregisters,
      runRegistrations: pruned.registrations,
      runs: pruned.runs,
    });
  }

  registerRun(
    runId: string,
    agentId: string,
    status: Exclude<RunRegistrationStatus, "unknown"> = "active"
  ): boolean {
    const mappings = this.migrateRunMappings();
    const { runs } = mappings;
    if (Object.hasOwn(runs, runId)) {
      if (runs[runId] !== agentId) {
        return false;
      }
      const pending = this.state.pendingRunStatuses?.[runId];
      const registration = mappings.registrations[runId];
      const effectiveStatus =
        registration?.status !== "terminal" &&
        pending?.agentId === agentId &&
        pending.status !== "unknown"
          ? pending.status
          : status;
      const registrations = {
        ...mappings.registrations,
        [runId]: {
          ...mappings.registrations[runId],
          status: effectiveStatus,
        },
      };
      const pendingRunStatuses = {
        ...(this.state.pendingRunStatuses ?? {}),
      };
      delete pendingRunStatuses[runId];
      const pruned = this.pruneRunMappings(runs, registrations);
      this.setState({
        ...this.state,
        pendingRunStatuses,
        runRegistrations: pruned.registrations,
        runs: pruned.runs,
      });
      return true;
    }
    const legacy = this.readLegacyRun(runId);
    if (legacy) {
      if (legacy.agentId !== agentId) {
        return false;
      }
      const pending = this.state.pendingRunStatuses?.[runId];
      const effectiveStatus =
        pending?.agentId === agentId && pending.status !== "unknown"
          ? pending.status
          : status;
      const registrations = {
        ...mappings.registrations,
        [runId]: {
          agentId,
          sequence: legacy.sequence,
          status: effectiveStatus,
        },
      };
      const projectedRuns = { ...mappings.runs, [runId]: agentId };
      const pruned = this.pruneRunMappings(projectedRuns, registrations);
      this.directorySql(
        "DELETE FROM agent_directory_legacy_runs WHERE run_id = ? AND agent_id = ?",
        [runId, agentId]
      );
      const pendingRunStatuses = {
        ...(this.state.pendingRunStatuses ?? {}),
      };
      delete pendingRunStatuses[runId];
      this.setState({
        ...this.state,
        nextRunRegistrationSequence: Math.max(
          this.state.nextRunRegistrationSequence ?? 1,
          legacy.sequence + 1
        ),
        pendingRunStatuses,
        runRegistrations: pruned.registrations,
        runs: pruned.runs,
      });
      return true;
    }
    const pending = this.state.pendingRunStatuses?.[runId];
    const effectiveStatus =
      pending?.agentId === agentId && pending.status !== "unknown"
        ? pending.status
        : status;
    const registrations = {
      ...mappings.registrations,
      [runId]: {
        agentId,
        sequence: mappings.nextSequence,
        status: effectiveStatus,
      },
    };
    const pendingRunStatuses = {
      ...(this.state.pendingRunStatuses ?? {}),
    };
    delete pendingRunStatuses[runId];
    const pruned = this.pruneRunMappings(runs, registrations);
    this.setState({
      ...this.state,
      nextRunRegistrationSequence: mappings.nextSequence + 1,
      pendingRunStatuses,
      runRegistrations: pruned.registrations,
      runs: { ...pruned.runs, [runId]: agentId },
    });
    return true;
  }

  unregisterRun(runId: string, agentId: string): boolean {
    this.drainPendingUnregisters();
    const mappings = this.migrateRunMappings();
    const { runs } = mappings;
    if (Object.hasOwn(runs, runId) && runs[runId] === agentId) {
      const remaining = { ...runs };
      delete remaining[runId];
      const registrations = { ...mappings.registrations };
      delete registrations[runId];
      const pruned = this.pruneRunMappings(remaining, registrations);
      const pendingRunStatuses = {
        ...(this.state.pendingRunStatuses ?? {}),
      };
      delete pendingRunStatuses[runId];
      this.directorySql(
        "DELETE FROM agent_directory_legacy_runs WHERE run_id = ? AND agent_id = ?",
        [runId, agentId]
      );
      this.setState({
        ...this.state,
        pendingRunStatuses,
        runRegistrations: pruned.registrations,
        runs: pruned.runs,
      });
      return true;
    }
    const legacy = this.readLegacyRun(runId);
    if (!legacy || legacy.agentId !== agentId) {
      return false;
    }
    this.directorySql(
      "DELETE FROM agent_directory_legacy_runs WHERE run_id = ? AND agent_id = ?",
      [runId, agentId]
    );
    const pendingRunStatuses = {
      ...(this.state.pendingRunStatuses ?? {}),
    };
    delete pendingRunStatuses[runId];
    this.setState({ ...this.state, pendingRunStatuses });
    return true;
  }

  markRunStatus(
    runId: string,
    agentId: string,
    status: Exclude<RunRegistrationStatus, "unknown">
  ): boolean {
    const mappings = this.migrateRunMappings();
    const current = mappings.registrations[runId];
    if (current && current.agentId !== agentId) {
      return false;
    }
    if (!current) {
      const legacy = this.readLegacyRun(runId);
      if (legacy) {
        if (legacy.agentId !== agentId) {
          return false;
        }
        const effectiveStatus =
          legacy.status === "terminal" && status !== "terminal"
            ? "terminal"
            : status;
        const registrations = {
          ...mappings.registrations,
          [runId]: {
            agentId,
            sequence: legacy.sequence,
            status: effectiveStatus,
          },
        };
        const runs = { ...mappings.runs, [runId]: agentId };
        const pruned = this.pruneRunMappings(runs, registrations);
        this.directorySql(
          "DELETE FROM agent_directory_legacy_runs WHERE run_id = ? AND agent_id = ?",
          [runId, agentId]
        );
        this.setState({
          ...this.state,
          nextRunRegistrationSequence: Math.max(
            this.state.nextRunRegistrationSequence ?? 1,
            legacy.sequence + 1
          ),
          runRegistrations: pruned.registrations,
          runs: pruned.runs,
        });
        return true;
      }
      const pending = this.state.pendingRunStatuses?.[runId];
      const effectiveStatus =
        pending?.status === "terminal" && status !== "terminal"
          ? "terminal"
          : status;
      const pendingRunStatuses = this.prunePendingRunStatuses({
        ...(this.state.pendingRunStatuses ?? {}),
        [runId]: {
          agentId,
          sequence: Number.MAX_SAFE_INTEGER,
          status: effectiveStatus,
        },
      });
      this.setState({ ...this.state, pendingRunStatuses });
      return true;
    }
    const effectiveStatus =
      current?.status === "terminal" && status !== "terminal"
        ? "terminal"
        : status;
    const registrations = {
      ...mappings.registrations,
      [runId]: { ...current, status: effectiveStatus },
    };
    const pruned = this.pruneRunMappings(mappings.runs, registrations);
    this.setState({
      ...this.state,
      pendingRunStatuses: Object.fromEntries(
        Object.entries(this.state.pendingRunStatuses ?? {}).filter(
          ([candidate]) => candidate !== runId
        )
      ),
      runRegistrations: pruned.registrations,
      runs: pruned.runs,
    });
    return true;
  }

  lookupRun(runId: string): string | null {
    this.drainPendingUnregisters();
    // Own-property check: a run id of "constructor" or "__proto__" would
    // otherwise resolve to something off Object.prototype and be treated as an
    // agent id.
    const { runs } = this.migrateRunMappings();
    if (Object.hasOwn(runs, runId)) {
      return runs[runId] ?? null;
    }
    return this.readLegacyRun(runId)?.agentId ?? null;
  }

  enqueueRunMappingCleanup(runId: string, agentId: string): void {
    this.migrateRunMappings();
    this.setState({
      ...this.state,
      pendingUnregisters: {
        ...(this.state.pendingUnregisters ?? {}),
        [runId]: agentId,
      },
    });
  }

  private drainPendingUnregisters(): void {
    const pending = this.state.pendingUnregisters ?? {};
    const entries = Object.entries(pending);
    if (entries.length === 0) {
      return;
    }
    const mappings = this.migrateRunMappings();
    const runs = { ...mappings.runs };
    const registrations = { ...mappings.registrations };
    const remaining = { ...pending };
    for (const [runId, agentId] of entries) {
      if (runs[runId] === agentId) {
        delete runs[runId];
        delete registrations[runId];
      }
      this.directorySql(
        "DELETE FROM agent_directory_legacy_runs WHERE run_id = ? AND agent_id = ?",
        [runId, agentId]
      );
      delete remaining[runId];
    }
    const pendingRunStatuses = {
      ...(this.state.pendingRunStatuses ?? {}),
    };
    for (const [runId] of entries) {
      delete pendingRunStatuses[runId];
    }
    this.setState({
      ...this.state,
      pendingRunStatuses,
      pendingUnregisters: remaining,
      runRegistrations: registrations,
      runs,
    });
  }

  private migrateRunMappings(): DirectoryRunMappings {
    this.ensureLegacyRunTable();
    const legacyRuns = { ...(this.state.runs ?? {}) };
    const existing = this.state.runRegistrations ?? {};
    const registrations: Record<string, RunRegistration> = {};
    let nextSequence = 1;
    let changed = this.state.runRegistrations === undefined;
    const migrated: {
      agentId: string;
      runId: string;
      sequence: number;
    }[] = [];

    for (const [runId, agentId] of Object.entries(legacyRuns)) {
      const candidate = existing[runId];
      const candidateStatus =
        candidate?.agentId === agentId &&
        (candidate.status === "active" ||
          candidate.status === "queued" ||
          candidate.status === "terminal" ||
          candidate.status === "unknown")
          ? candidate.status
          : undefined;
      const sequence =
        candidate &&
        candidate.agentId === agentId &&
        Number.isSafeInteger(candidate.sequence) &&
        candidate.sequence > 0
          ? candidate.sequence
          : nextSequence;
      if (candidateStatus) {
        registrations[runId] = {
          agentId,
          sequence,
          status: candidateStatus,
        };
      } else {
        migrated.push({ agentId, runId, sequence });
      }
      nextSequence = Math.max(nextSequence, sequence + 1);
      if (
        !candidate ||
        candidate.agentId !== agentId ||
        candidate.sequence !== sequence ||
        candidate.status !== candidateStatus
      ) {
        changed = true;
      }
    }

    for (const entry of migrated) {
      this.writeLegacyRun(entry);
    }
    // Keep only a small recent projection in Agent state. The complete legacy
    // index lives in the Agent's SQLite store so migration cannot create an
    // unbounded state blob, while lookups still resolve every old run.
    const recentCounts = new Map<string, number>();
    const recentLegacyIds = new Set(
      migrated
        .sort((left, right) => right.sequence - left.sequence)
        .filter((entry) => {
          const count = recentCounts.get(entry.agentId) ?? 0;
          if (count >= LEGACY_RUN_MIGRATION_BATCH) {
            return false;
          }
          recentCounts.set(entry.agentId, count + 1);
          return true;
        })
        .map((entry) => entry.runId)
    );
    for (const entry of migrated) {
      if (!recentLegacyIds.has(entry.runId)) {
        continue;
      }
      registrations[entry.runId] = {
        agentId: entry.agentId,
        sequence: entry.sequence,
        status: "unknown",
      };
    }

    for (const [runId, candidate] of Object.entries(existing)) {
      if (Object.hasOwn(registrations, runId)) {
        continue;
      }
      if (
        !candidate.agentId ||
        !Number.isSafeInteger(candidate.sequence) ||
        candidate.sequence <= 0
      ) {
        changed = true;
        continue;
      }
      registrations[runId] = { ...candidate };
      legacyRuns[runId] = candidate.agentId;
      nextSequence = Math.max(nextSequence, candidate.sequence + 1);
      changed = true;
    }

    const storedNext = this.state.nextRunRegistrationSequence;
    if (
      storedNext === undefined ||
      !Number.isSafeInteger(storedNext) ||
      storedNext < nextSequence
    ) {
      changed = true;
    } else {
      nextSequence = storedNext;
    }

    const pruned = this.pruneRunMappings(
      Object.fromEntries(
        Object.entries(registrations).map(([runId, registration]) => [
          runId,
          registration.agentId,
        ])
      ),
      registrations
    );
    if (
      Object.keys(pruned.registrations).length !==
      Object.keys(registrations).length
    ) {
      changed = true;
    }
    if (changed || this.state.nextRunRegistrationSequence === undefined) {
      const projectedRuns = Object.fromEntries(
        Object.entries(pruned.registrations).map(([runId, registration]) => [
          runId,
          registration.agentId,
        ])
      );
      this.setState({
        ...this.state,
        nextRunRegistrationSequence: nextSequence,
        runRegistrations: pruned.registrations,
        runs: projectedRuns,
      });
      return {
        nextSequence,
        registrations: pruned.registrations,
        runs: pruned.runs,
      };
    }
    return {
      nextSequence,
      registrations,
      runs: Object.fromEntries(
        Object.entries(registrations).map(([runId, registration]) => [
          runId,
          registration.agentId,
        ])
      ),
    };
  }

  private pruneRunMappings(
    runs: Record<string, string>,
    registrations: Record<string, RunRegistration>
  ): DirectoryRunMappings {
    const keep = new Set<string>();
    const byAgent = new Map<string, [string, RunRegistration][]>();
    for (const [runId, registration] of Object.entries(registrations)) {
      const entries = byAgent.get(registration.agentId) ?? [];
      entries.push([runId, registration]);
      byAgent.set(registration.agentId, entries);
    }
    for (const entries of byAgent.values()) {
      const ordered = entries.sort(
        (left, right) => right[1].sequence - left[1].sequence
      );
      for (const [runId] of ordered.filter(
        ([, candidate]) => candidate.status !== "terminal"
      )) {
        keep.add(runId);
      }
      for (const [runId] of ordered
        .filter(([, candidate]) => candidate.status === "terminal")
        .slice(0, MAX_TERMINAL_RUNS_PER_AGENT)) {
        keep.add(runId);
      }
    }
    return {
      nextSequence: this.state.nextRunRegistrationSequence ?? 1,
      registrations: Object.fromEntries(
        Object.entries(registrations).filter(([runId]) => keep.has(runId))
      ),
      runs: Object.fromEntries(
        Object.entries(runs).filter(([runId]) => keep.has(runId))
      ),
    };
  }

  private ensureLegacyRunTable(): void {
    this.directorySql(`
      CREATE TABLE IF NOT EXISTS agent_directory_legacy_runs (
        run_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('unknown', 'active', 'queued', 'terminal'))
      )
    `);
  }

  private directorySql<T = Record<string, unknown>>(
    query: string,
    values: (string | number | null)[] = []
  ): T[] {
    const { sql } = this as unknown as {
      sql?: (
        strings: TemplateStringsArray,
        ...values: (string | number | null)[]
      ) => T[];
    };
    if (typeof sql !== "function") {
      return [];
    }
    const parts = query.split("?");
    const strings = parts as unknown as TemplateStringsArray & {
      raw: string[];
    };
    strings.raw = parts;
    return sql.call(this, strings, ...values);
  }

  private writeLegacyRun(entry: {
    agentId: string;
    runId: string;
    sequence: number;
  }): void {
    this.directorySql(
      `
        INSERT INTO agent_directory_legacy_runs
          (run_id, agent_id, sequence, status)
        VALUES (?, ?, ?, 'unknown')
        ON CONFLICT(run_id) DO UPDATE SET
          agent_id = excluded.agent_id,
          sequence = excluded.sequence
      `,
      [entry.runId, entry.agentId, entry.sequence]
    );
  }

  private readLegacyRun(runId: string): {
    agentId: string;
    sequence: number;
    status: RunRegistrationStatus;
  } | null {
    const [row] = this.directorySql<{
      agent_id: string;
      sequence: number;
      status: RunRegistrationStatus;
    }>(
      "SELECT agent_id, sequence, status FROM agent_directory_legacy_runs WHERE run_id = ?",
      [runId]
    );
    return row
      ? {
          agentId: row.agent_id,
          sequence: row.sequence,
          status: row.status,
        }
      : null;
  }

  private prunePendingRunStatuses(
    statuses: Record<string, RunRegistration>
  ): Record<string, RunRegistration> {
    const byAgent = new Map<string, [string, RunRegistration][]>();
    for (const [runId, registration] of Object.entries(statuses)) {
      const entries = byAgent.get(registration.agentId) ?? [];
      entries.push([runId, registration]);
      byAgent.set(registration.agentId, entries);
    }
    const keep = new Set<string>();
    for (const entries of byAgent.values()) {
      const ordered = entries.sort(
        (left, right) => right[1].sequence - left[1].sequence
      );
      for (const [runId] of ordered
        .filter(([, candidate]) => candidate.status !== "terminal")
        .slice(0, MAX_PENDING_RUN_STATUS_UPDATES)) {
        keep.add(runId);
      }
      for (const [runId] of ordered
        .filter(([, candidate]) => candidate.status === "terminal")
        .slice(0, MAX_TERMINAL_RUNS_PER_AGENT)) {
        keep.add(runId);
      }
    }
    return Object.fromEntries(
      Object.entries(statuses).filter(([runId]) => keep.has(runId))
    );
  }

  harnesses(): Promise<HarnessStatus[]> {
    return listCloudHarnesses(
      getSandbox(this.env.Sandbox, "harness-probe", {
        enableDefaultSession: false,
        sleepAfter: "30s",
      })
    );
  }
}

export class YoloAgent extends Agent<Env, YoloAgentState> {
  private readonly ephemeralIdentityTokens = new Map<
    string,
    { expiresAt: number; token: string }
  >();

  initialState: YoloAgentState = {
    admissionFences: {},
    admissionTokens: {},
    definition: null,
    dispatchClaims: {},
    identityCapabilities: {},
    identityTokens: {},
    lifecycle: { generation: 0, status: "active" },
    runs: [],
    sandbox: { generation: 0 },
  };
  private readonly admissionReleaseInFlight = new Map<
    string,
    Promise<boolean>
  >();
  private readonly admissionReleaseCompleted = new Set<string>();
  private readonly sandboxCleanupInFlight = new Map<number, Promise<boolean>>();
  private readonly fiberCompletions = new Map<string, Promise<void>>();
  private cleanupRetryScheduleId: string | undefined;
  private cleanupRetrySchedulePromise: Promise<void> | undefined;

  configure(definition: AgentDefinition): AgentDefinition {
    const lifecycle = this.currentLifecycle();
    if (
      lifecycle.status === "decommissioning" ||
      this.state.sandbox?.cleanup ||
      Object.keys(this.state.decommission?.admissionReleases ?? {}).length > 0
    ) {
      throw new AgentDecommissioningError();
    }
    const parsed = agentDefinitionSchema.parse(definition);
    this.setState({
      ...this.state,
      definition: parsed,
      lifecycle: {
        generation:
          lifecycle.status === "active"
            ? lifecycle.generation
            : lifecycle.generation + 1,
        status: "active",
      },
    });
    return parsed;
  }

  snapshot(): AgentDefinition | null {
    return this.state.definition;
  }

  private requireDefinition(): AgentDefinition {
    const { definition } = this.state;
    if (!definition) {
      throw new Error("Agent has not been configured.");
    }
    return definition;
  }

  private requireActiveDefinition(): AgentDefinition {
    const definition = this.requireDefinition();
    if (!this.lifecycleIsActive()) {
      throw new AgentBusyError();
    }
    return definition;
  }

  private currentLifecycle(): AgentLifecycle {
    return (
      this.state.lifecycle ?? {
        generation: 0,
        status: "active",
      }
    );
  }

  private lifecycleIsActive(generation?: number): boolean {
    const lifecycle = this.currentLifecycle();
    return (
      lifecycle.status === "active" &&
      (generation === undefined || lifecycle.generation === generation)
    );
  }

  private definitionIsCurrent(
    definition: AgentDefinition,
    lifecycleGeneration: number
  ): boolean {
    return (
      this.lifecycleIsActive(lifecycleGeneration) &&
      this.state.definition?.id === definition.id &&
      this.state.definition.updatedAt === definition.updatedAt &&
      !this.state.decommission
    );
  }

  private executionIsLive(execution: {
    generation: number;
    runId: string;
    dispatchToken?: string;
    signal?: AbortSignal;
  }): boolean {
    if (execution.signal?.aborted) {
      return false;
    }
    return this.executionRecordIsCurrent(execution);
  }

  private executionRecordIsCurrent(execution: {
    generation: number;
    runId: string;
    dispatchToken?: string;
  }): boolean {
    if (!this.lifecycleIsActive(execution.generation)) {
      return false;
    }
    const current = this.state.runs.find(
      (candidate) => candidate.run.id === execution.runId
    );
    if (current?.run.status !== "running") {
      return false;
    }
    return (
      execution.dispatchToken === undefined ||
      current.dispatchToken === execution.dispatchToken ||
      this.state.admissionTokens?.[execution.runId] === execution.dispatchToken
    );
  }

  private currentAdmittedStart(
    runId: string,
    dispatchToken: string | undefined,
    lifecycleGeneration: number,
    definitionId: string
  ): CloudRunRecord | null {
    if (
      !this.lifecycleIsActive(lifecycleGeneration) ||
      this.state.definition?.id !== definitionId ||
      this.state.decommission
    ) {
      return null;
    }
    const current = this.state.runs.find(
      (candidate) => candidate.run.id === runId
    );
    if (
      current?.run.status !== "queued" ||
      this.state.sandbox?.cleanup ||
      this.hasOtherExecutionClaim(runId) ||
      rejectsAdmissionToken(this.state.admissionFences?.[runId], dispatchToken)
    ) {
      return null;
    }
    return current;
  }

  private requireCurrentAdmittedStart(
    runId: string,
    dispatchToken: string | undefined,
    lifecycleGeneration: number,
    definitionId: string
  ): CloudRunRecord {
    const current = this.currentAdmittedStart(
      runId,
      dispatchToken,
      lifecycleGeneration,
      definitionId
    );
    if (!current) {
      throw new AgentBusyError();
    }
    return current;
  }

  private async dispatchIsAdmitted(
    runId: string,
    dispatchToken: string
  ): Promise<boolean> {
    const runAdmission = (
      this.env as unknown as {
        RunAdmission?: {
          getByName: (name: string) => {
            validateDispatch?: (
              admissionRunId: string,
              admissionToken: string
            ) => Promise<boolean>;
          };
        };
      }
    ).RunAdmission;
    if (!runAdmission) {
      return false;
    }
    const admission = runAdmission.getByName("deployment");
    if (typeof admission.validateDispatch !== "function") {
      return false;
    }
    return await admission.validateDispatch(runId, dispatchToken);
  }

  private async markDirectoryRunStatus(
    runId: string,
    status: Exclude<RunRegistrationStatus, "unknown">
  ): Promise<void> {
    const namespace = (
      this.env as unknown as {
        AgentDirectory?: {
          getByName: (name: string) => {
            markRunStatus?: (
              mappingRunId: string,
              agentId: string,
              mappingStatus: "active" | "queued" | "terminal"
            ) => Promise<boolean> | boolean;
          };
        };
      }
    ).AgentDirectory;
    try {
      const directory = namespace?.getByName("default");
      const markRunStatus = directory?.markRunStatus;
      if (typeof markRunStatus !== "function") {
        return;
      }
      await markRunStatus.call(
        directory,
        runId,
        this.requireDefinition().id,
        status
      );
    } catch {
      // Run history remains available through the agent when the index is
      // temporarily unavailable; a later status transition can repair it.
    }
  }

  private currentRunOr(
    runId: string,
    fallback: CloudRunRecord
  ): CloudRunRecord {
    return (
      this.state.runs.find((candidate) => candidate.run.id === runId) ??
      fallback
    );
  }

  private persistExecutionCancellation(
    execution: {
      generation: number;
      runId: string;
      dispatchToken?: string;
    },
    credential: string | null,
    output = "Run cancelled before execution completed."
  ): void {
    if (!this.executionRecordIsCurrent(execution)) {
      return;
    }
    const current = this.state.runs.find(
      (candidate) => candidate.run.id === execution.runId
    );
    if (current?.run.status !== "running") {
      return;
    }
    const completedAt = new Date().toISOString();
    const cancelled = finishCloudRunRecord(current, {
      completedAt,
      credential,
      output,
      status: "cancelled",
    });
    if (this.persistRun(cancelled, { dispatchClaim: null })) {
      this.updateDefinitionAfterCancellation(completedAt);
    }
  }

  private trackFiberCompletion(
    key: string,
    work: Promise<void>
  ): Promise<void> {
    const tracked = work.finally(() => {
      if (this.fiberCompletions.get(key) === tracked) {
        this.fiberCompletions.delete(key);
      }
    });
    this.fiberCompletions.set(key, tracked);
    return tracked;
  }

  private clearWarmFiberKey(key: string): void {
    if (this.state.warmFiberKey !== key) {
      return;
    }
    const { warmFiberKey: _warmFiberKey, ...rest } = this.state;
    this.setState(rest);
  }

  private async rollbackWarmDispatch(
    definition: AgentDefinition,
    ownership: {
      generation: number;
      owner: string;
      dispatchToken?: string;
      runId?: string;
    },
    fiberKey: string
  ): Promise<boolean> {
    this.clearWarmFiberKey(fiberKey);
    if (this.state.definition?.id === definition.id) {
      this.updateDefinition({
        warm: {
          status: "failed",
          updatedAt: new Date().toISOString(),
        },
      });
    }
    return await this.cleanupOwnedSandbox(
      definition,
      ownership,
      "failed",
      "The warm-up fiber was not accepted and its sandbox was reclaimed."
    );
  }

  private tryAcquireSandboxOwnership(
    runId?: string,
    dispatchToken?: string,
    canAcquire?: () => boolean
  ): {
    generation: number;
    owner: string;
    dispatchToken?: string;
    runId?: string;
  } | null {
    if (canAcquire && !canAcquire()) {
      return null;
    }
    const current = this.state.sandbox;
    if (current?.owner || current?.cleanup) {
      return null;
    }
    const generation = (this.state.sandbox?.generation ?? 0) + 1;
    const owner = `${runId ?? "warm"}:${crypto.randomUUID()}`;
    this.setState({
      ...this.state,
      sandbox: {
        generation,
        owner,
        ...(dispatchToken ? { dispatchToken } : {}),
        ...(runId ? { runId } : {}),
      },
    });
    return {
      generation,
      owner,
      ...(dispatchToken ? { dispatchToken } : {}),
      ...(runId ? { runId } : {}),
    };
  }

  private clearSandboxOwnershipAfterFence(
    ownership:
      | {
          generation: number;
          owner: string;
          dispatchToken?: string;
          runId?: string;
        }
      | undefined
  ): void {
    if (!ownership) {
      return;
    }
    const current = this.state.sandbox;
    if (
      current?.generation !== ownership.generation ||
      current.owner !== ownership.owner ||
      current.cleanup?.generation === ownership.generation
    ) {
      return;
    }
    this.clearSandboxOwnership(ownership);
  }

  private executionWasCancelled(error: unknown, signal?: AbortSignal): boolean {
    return (
      signal?.aborted === true ||
      (error instanceof Error && error.name === "AbortError")
    );
  }

  private acquireSandboxOwnership(
    runId?: string,
    dispatchToken?: string
  ): {
    generation: number;
    owner: string;
    dispatchToken?: string;
    runId?: string;
  } {
    const ownership = this.tryAcquireSandboxOwnership(runId, dispatchToken);
    if (!ownership) {
      throw new AgentBusyError();
    }
    return ownership;
  }

  private ownsSandbox(ownership: {
    generation: number;
    owner: string;
    dispatchToken?: string;
    runId?: string;
  }): boolean {
    const current = this.state.sandbox;
    return (
      current?.generation === ownership.generation &&
      current.owner === ownership.owner
    );
  }

  private clearSandboxOwnership(ownership: {
    generation: number;
    owner: string;
    dispatchToken?: string;
    runId?: string;
  }): void {
    if (!this.ownsSandbox(ownership)) {
      return;
    }
    this.setState({
      ...this.state,
      sandbox: {
        cleanupRetryScheduleGeneration:
          this.state.sandbox?.cleanupRetryScheduleGeneration,
        cleanupRetryScheduleId:
          this.state.sandbox?.cleanupRetryScheduleId ??
          this.cleanupRetryScheduleId,
        cleanupRetryScheduleToken:
          this.state.sandbox?.cleanupRetryScheduleToken,
        generation: ownership.generation,
      },
    });
  }

  private markSandboxCleanup(
    ownership: {
      generation: number;
      owner: string;
      dispatchToken?: string;
      runId?: string;
    },
    finalStatus: "cancelled" | "failed",
    message: string,
    attempts = 0
  ): void {
    if (!this.ownsSandbox(ownership)) {
      return;
    }
    this.setState({
      ...this.state,
      sandbox: {
        cleanup: {
          attempts,
          dispatchToken: ownership.dispatchToken,
          finalStatus,
          generation: ownership.generation,
          message,
          nextAttemptAt: Date.now() + 5000,
          owner: ownership.owner,
          runId: ownership.runId,
        },
        cleanupRetryScheduleGeneration:
          this.state.sandbox?.cleanupRetryScheduleGeneration,
        cleanupRetryScheduleId:
          this.state.sandbox?.cleanupRetryScheduleId ??
          this.cleanupRetryScheduleId,
        cleanupRetryScheduleToken:
          this.state.sandbox?.cleanupRetryScheduleToken,
        dispatchToken: ownership.dispatchToken,
        generation: ownership.generation,
        owner: ownership.owner,
        runId: ownership.runId,
      },
    });
  }

  private cleanupOwnedSandbox(
    definition: AgentDefinition,
    ownership: {
      generation: number;
      owner: string;
      dispatchToken?: string;
      runId?: string;
    },
    finalStatus: "cancelled" | "failed",
    message: string
  ): Promise<boolean> {
    if (!this.ownsSandbox(ownership)) {
      return Promise.resolve(true);
    }
    const existing = this.sandboxCleanupInFlight.get(ownership.generation);
    if (existing) {
      return existing;
    }
    const cleanup = (async () => {
      const attempts = this.state.sandbox?.cleanup?.attempts ?? 0;
      // Record intent before the platform call so a DO restart during destroy
      // still leaves durable work for the alarm/recovery path.
      this.markSandboxCleanup(ownership, finalStatus, message, attempts);
      try {
        await this.destroyAgentSandbox(definition, () =>
          this.ownsSandbox(ownership)
        );
        this.clearSandboxOwnership(ownership);
        return true;
      } catch (error) {
        const detail = error instanceof Error ? ` ${error.message}` : "";
        this.markSandboxCleanup(
          ownership,
          finalStatus,
          `${message}${detail}`,
          attempts + 1
        );
        this.scheduleCleanupRetry().catch(() => undefined);
        return false;
      } finally {
        this.sandboxCleanupInFlight.delete(ownership.generation);
      }
    })();
    this.sandboxCleanupInFlight.set(ownership.generation, cleanup);
    return cleanup;
  }

  private async repairPendingSandboxCleanup(
    definition: AgentDefinition,
    force = true
  ): Promise<boolean> {
    const lifecycle = this.currentLifecycle();
    const cleanup = this.state.sandbox?.cleanup;
    if (!cleanup) {
      return true;
    }

    if (!force && cleanup.nextAttemptAt > Date.now()) {
      return false;
    }
    const ownership = {
      dispatchToken: cleanup.dispatchToken,
      generation: cleanup.generation,
      owner: cleanup.owner,
      runId: cleanup.runId,
    };
    const repaired = await this.cleanupOwnedSandbox(
      definition,
      ownership,
      cleanup.finalStatus,
      cleanup.message
    );
    if (!repaired) {
      return false;
    }
    if (
      lifecycle.status !== "active" ||
      !this.lifecycleIsActive(lifecycle.generation)
    ) {
      return true;
    }
    const current = this.state.runs.find(
      (candidate) => candidate.run.id === cleanup.runId
    );
    if (current && !isTerminal(current.run.status)) {
      const completedAt = new Date().toISOString();
      const finished = finishCloudRunRecord(current, {
        completedAt,
        credential: null,
        error:
          cleanup.finalStatus === "failed"
            ? {
                code: "sandbox_cleanup_failed",
                message: cleanup.message,
                retryable: true,
              }
            : undefined,
        output: cleanup.message,
        status: cleanup.finalStatus,
      });
      if (this.persistRun(finished, { dispatchClaim: null })) {
        this.updateDefinition({
          lastRunAt: completedAt,
          status: cleanup.finalStatus === "cancelled" ? "idle" : "error",
          updatedAt: completedAt,
        });
        await this.reportAdmissionTerminal(cleanup.runId as string);
      }
    } else if (
      this.state.definition?.warm?.status === "provisioning" &&
      this.lifecycleIsActive()
    ) {
      this.updateDefinition({
        warm: {
          status: "failed",
          updatedAt: new Date().toISOString(),
        },
      });
    }
    return true;
  }

  /**
   * Gives an admitted run priority over the optional warm-up. A warm owner is
   * cancelled first and its fiber is allowed to settle before the run can
   * claim the sandbox. If the warm fiber was accepted but has not started yet,
   * the durable owner is cleaned directly; the generation check in
   * `cleanupOwnedSandbox` keeps a late warm callback from touching the run.
   */
  private async ensureSandboxAvailableForRun(
    definition: AgentDefinition,
    runId?: string
  ): Promise<void> {
    if (
      this.state.sandbox?.cleanup &&
      !(await this.repairPendingSandboxCleanup(definition))
    ) {
      throw new AgentBusyError();
    }

    let current = this.state.sandbox;
    if (current?.runId && current.runId !== runId) {
      throw new AgentBusyError();
    }
    if (current?.owner && !current.runId) {
      const warmFiberKey = this.state.warmFiberKey ?? WARM_FIBER_KEY;
      try {
        await this.cancelFiberByKey(
          warmFiberKey,
          "A run was admitted while warm-up was optional."
        );
      } catch (error) {
        console.warn({
          error,
          event: "sandbox.warm_cancel_failed",
        });
        // biome-ignore lint/style/useErrorCause: AgentBusyError forwards the cancellation failure as its cause.
        throw new AgentBusyError(error);
      }

      // The callback normally appears in fiberCompletions as soon as the
      // platform starts it. Yield once for that registration before deciding
      // whether the reserved owner needs direct cleanup.
      await Promise.resolve();
      const completion = this.fiberCompletions.get(warmFiberKey);
      if (completion) {
        await completion.catch(() => undefined);
      }
    }

    if (
      this.state.sandbox?.cleanup &&
      !(await this.repairPendingSandboxCleanup(definition))
    ) {
      throw new AgentBusyError();
    }

    current = this.state.sandbox;
    if (current?.owner && !current.runId) {
      const ownership = {
        dispatchToken: current.dispatchToken,
        generation: current.generation,
        owner: current.owner,
        runId: current.runId,
      };
      if (
        !(await this.cleanupOwnedSandbox(
          definition,
          ownership,
          "failed",
          "The warm-up was cancelled before the run started."
        ))
      ) {
        throw new AgentBusyError();
      }
    }

    if (
      (this.state.sandbox?.owner && this.state.sandbox.runId !== runId) ||
      this.state.sandbox?.cleanup
    ) {
      throw new AgentBusyError();
    }
  }

  async repairSandboxCleanup(
    payload?: CleanupRetryPayload,
    schedule?: { id?: string }
  ): Promise<boolean> {
    const isScheduledCallback = payload !== undefined || schedule !== undefined;
    if (
      isScheduledCallback &&
      !this.consumeCleanupRetrySchedule(payload, schedule?.id)
    ) {
      // A stale callback must not repair or reschedule work owned by a newer
      // retry.
      return true;
    }
    const { definition } = this.state;
    const repaired = definition
      ? await this.repairPendingSandboxCleanup(definition, true)
      : true;
    if (repaired) {
      await this.cancelScheduledCleanup();
    }
    if (!repaired) {
      this.scheduleCleanupRetry().catch(() => undefined);
    }
    return repaired;
  }

  private scheduleCleanupRetry(): Promise<void> {
    if (!this.lifecycleIsActive()) {
      return Promise.resolve();
    }
    const existingScheduleId =
      this.state.sandbox?.cleanupRetryScheduleId ?? this.cleanupRetryScheduleId;
    if (existingScheduleId !== undefined) {
      this.cleanupRetryScheduleId = existingScheduleId;
      return Promise.resolve();
    }
    if (this.cleanupRetrySchedulePromise) {
      return this.cleanupRetrySchedulePromise;
    }
    const work = (async () => {
      const { schedule } = this as unknown as {
        schedule?: (
          when: Date,
          callback: string,
          payload?: unknown,
          options?: { idempotent?: boolean }
        ) => Promise<{ id: string }>;
      };
      if (!schedule) {
        return;
      }
      const { sandbox } = this.state;
      const generation = (sandbox?.cleanupRetryScheduleGeneration ?? 0) + 1;
      const token = crypto.randomUUID();
      try {
        const scheduled = await schedule.call(
          this,
          new Date(Date.now() + CLEANUP_RETRY_DELAY_MS),
          "repairSandboxCleanup",
          { generation, token },
          { idempotent: false }
        );
        if (!this.lifecycleIsActive() || !this.state.sandbox?.cleanup) {
          await this.cancelScheduledCleanup(scheduled.id);
          return;
        }
        const currentScheduleId =
          this.state.sandbox.cleanupRetryScheduleId ??
          this.cleanupRetryScheduleId;
        if (currentScheduleId !== undefined) {
          await this.cancelScheduledCleanup(scheduled.id);
          return;
        }
        this.cleanupRetryScheduleId = scheduled.id;
        this.setState({
          ...this.state,
          sandbox: {
            ...this.state.sandbox,
            cleanupRetryScheduleGeneration: generation,
            cleanupRetryScheduleId: scheduled.id,
            cleanupRetryScheduleToken: token,
          },
        });
      } catch {
        // Every lifecycle RPC also repairs pending cleanup, so a scheduler
        // outage cannot turn a retryable cleanup into a permanent block.
      }
    })();
    const tracked = work.finally(() => {
      if (this.cleanupRetrySchedulePromise === tracked) {
        this.cleanupRetrySchedulePromise = undefined;
      }
    });
    this.cleanupRetrySchedulePromise = tracked;
    return tracked;
  }

  private async cancelScheduledCleanup(id?: string) {
    const scheduledId =
      id ??
      this.state.sandbox?.cleanupRetryScheduleId ??
      this.cleanupRetryScheduleId;
    if (!scheduledId) {
      return;
    }
    const { sandbox } = this.state;
    const ownsSchedule =
      this.cleanupRetryScheduleId === scheduledId ||
      sandbox?.cleanupRetryScheduleId === scheduledId;
    if (ownsSchedule) {
      this.cleanupRetryScheduleId = undefined;
      if (sandbox?.cleanupRetryScheduleId === scheduledId) {
        const {
          cleanupRetryScheduleId: _cleanupRetryScheduleId,
          cleanupRetryScheduleToken: _cleanupRetryScheduleToken,
          ...rest
        } = sandbox;
        this.setState({ ...this.state, sandbox: rest });
      }
    }
    const { cancelSchedule } = this as unknown as {
      cancelSchedule?: (scheduleId: string) => Promise<boolean>;
    };
    if (!cancelSchedule) {
      return;
    }
    try {
      await cancelSchedule.call(this, scheduledId);
    } catch {
      // Decommission remains fenced even if platform schedule cancellation fails.
    }
  }

  private consumeCleanupRetrySchedule(
    payload: CleanupRetryPayload | undefined,
    scheduleId: string | undefined
  ): boolean {
    const { sandbox } = this.state;
    const currentId =
      sandbox?.cleanupRetryScheduleId ?? this.cleanupRetryScheduleId;
    if (!currentId || (scheduleId !== undefined && currentId !== scheduleId)) {
      return false;
    }
    const payloadMatches =
      payload?.generation === sandbox?.cleanupRetryScheduleGeneration &&
      payload?.token === sandbox?.cleanupRetryScheduleToken;
    const legacyPayloadMatches =
      payload === undefined && sandbox?.cleanupRetryScheduleToken === undefined;
    if (!payloadMatches && !legacyPayloadMatches) {
      return false;
    }
    if (scheduleId === undefined && !payloadMatches) {
      return false;
    }
    this.cleanupRetryScheduleId = undefined;
    if (sandbox?.cleanupRetryScheduleId === currentId) {
      const {
        cleanupRetryScheduleId: _cleanupRetryScheduleId,
        cleanupRetryScheduleToken: _cleanupRetryScheduleToken,
        ...rest
      } = sandbox;
      this.setState({ ...this.state, sandbox: rest });
    }
    return true;
  }

  /**
   * Borrows the tenant's own harness credential for the duration of this run.
   *
   * The worker holds no key material of its own — it asks the Next app, the
   * sole custodian, over an internal service call. `APP_ORIGIN` and
   * `RUNNER_SERVICE_TOKEN` missing is a deployment misconfiguration, not an
   * absent credential, so it fails closed with a thrown error rather than
   * quietly resolving to null and letting `requireHarness` report it as
   * merely "not signed in".
   */
  private async resolveTenantCredential(
    definition: AgentDefinition,
    identityToken: string,
    runId: string,
    signal?: AbortSignal
  ): Promise<string | null> {
    const { APP_ORIGIN, RUNNER_SERVICE_TOKEN } = this.env;
    if (!APP_ORIGIN || !RUNNER_SERVICE_TOKEN) {
      throw new Error(
        "APP_ORIGIN and RUNNER_SERVICE_TOKEN must be configured to fetch a tenant credential."
      );
    }
    const fetched = await fetchTenantCredential(
      { harnessId: definition.runtime, runId, tenant: tenantOf(definition) },
      {
        endpoint: APP_ORIGIN,
        // Wrapped, never passed bare. A Workers built-in detached from its
        // receiver throws "Illegal invocation: function called with incorrect
        // `this` reference" the moment it is called -- which surfaced as a
        // failed run with zero commands and zero file operations, because the
        // credential fetch died before the sandbox ever started.
        fetchImpl: (input, init) => fetch(input, init),
        identityToken,
        serviceToken: RUNNER_SERVICE_TOKEN,
        signal,
      }
    );

    // Normalised exactly once, here, because two consumers must agree on the
    // bytes: `requireHarness` trims before injecting into the sandbox, and the
    // same value is handed to evidence redaction. Trimming in only one of them
    // means the harness uses one string while redaction searches for another,
    // and a credential stored with stray whitespace leaks into stored output.
    return normalizeCredential(fetched);
  }

  /**
   * Drives the harness for one planned run and records the outcome.
   *
   * Called by `startAdmitted`, which runs it inside a fiber. Keeping one body
   * means the coordinated asynchronous path has one place to record evidence
   * and outcomes.
   */
  protected async driveHarness(
    definition: AgentDefinition,
    planned: CloudRunRecord,
    task: string,
    identityToken: string,
    signal?: AbortSignal
  ): Promise<CloudRunRecord> {
    const lifecycle = this.currentLifecycle();
    const execution = {
      dispatchToken: planned.dispatchToken,
      generation: lifecycle.generation,
      runId: planned.run.id,
      signal,
    };
    const current = this.state.runs.find(
      (candidate) => candidate.run.id === planned.run.id
    );
    if (
      lifecycle.status !== "active" ||
      signal?.aborted ||
      (current &&
        current.run.status !== "queued" &&
        current.run.status !== "running")
    ) {
      return current ?? planned;
    }
    let record = this.claimRunStart(planned);

    // Declared outside the try block, not `const` inside it: the catch
    // block below also hands its outcome to `finishCloudRunRecord`, and if
    // resolution itself throws (or something later throws with the
    // credential already in hand) that path needs the same value in scope
    // to redact with — never an unset variable that would either crash or,
    // worse, silently skip redaction.
    let credential: string | null = null;
    let ownership:
      | {
          generation: number;
          owner: string;
          dispatchToken?: string;
          runId?: string;
        }
      | undefined;
    try {
      credential = await this.resolveTenantCredential(
        definition,
        identityToken,
        planned.run.id,
        signal
      );
      if (!this.executionIsLive(execution)) {
        if (signal?.aborted) {
          this.persistExecutionCancellation(execution, credential);
        }
        return this.currentRunOr(planned.run.id, record);
      }
      /**
       * Streams each harness event into the record as it happens, so the
       * console shows what the run is doing rather than a spinner. Redaction
       * happens inside `liveCloudRunEvent` before the event exists; the
       * incremental persist is what the event stream reads, so a watcher
       * sees the activity within a poll interval of it occurring.
       */
      const toolNames = new Map<string, string>();
      const onEvent = (streamedEvent: HarnessStreamEvent) => {
        const mapped = liveCloudRunEvent(
          streamedEvent,
          nextEventId(record),
          credential,
          toolNames
        );
        if (mapped && this.executionIsLive(execution)) {
          record = appendEvents(record, [mapped]);
          this.persistRun(record);
        }
      };

      await this.ensureSandboxAvailableForRun(definition, planned.run.id);
      if (!this.executionIsLive(execution)) {
        if (signal?.aborted) {
          this.persistExecutionCancellation(execution, credential);
        }
        return this.currentRunOr(planned.run.id, record);
      }
      const claimedOwnership = this.tryAcquireSandboxOwnership(
        planned.run.id,
        planned.dispatchToken,
        () => this.executionIsLive(execution)
      );
      if (claimedOwnership) {
        ownership = claimedOwnership;
      } else {
        if (!this.executionIsLive(execution)) {
          if (signal?.aborted) {
            this.persistExecutionCancellation(execution, credential);
          }
          return this.currentRunOr(planned.run.id, record);
        }
        const currentSandbox = this.state.sandbox;
        if (currentSandbox?.runId !== planned.run.id || !currentSandbox.owner) {
          throw new AgentBusyError();
        }
        ownership = {
          dispatchToken: currentSandbox.dispatchToken,
          generation: currentSandbox.generation,
          owner: currentSandbox.owner,
          runId: currentSandbox.runId,
        };
      }
      if (!this.executionIsLive(execution)) {
        this.clearSandboxOwnershipAfterFence(ownership);
        if (signal?.aborted) {
          this.persistExecutionCancellation(execution, credential);
        }
        return this.currentRunOr(planned.run.id, record);
      }
      const sandboxName = await sandboxKey(tenantOf(definition), definition.id);
      if (!this.executionIsLive(execution)) {
        this.clearSandboxOwnershipAfterFence(ownership);
        if (signal?.aborted) {
          this.persistExecutionCancellation(execution, credential);
        }
        return this.currentRunOr(planned.run.id, record);
      }
      const run = await runHarnessInSandbox({
        credential: { credential },
        destroySandbox: async () => {
          const cleaned = await this.cleanupOwnedSandbox(
            definition,
            ownership as {
              generation: number;
              owner: string;
              runId?: string;
            },
            "cancelled",
            "The sandbox was destroyed while cancelling the cloud run."
          );
          if (!cleaned) {
            throw new Error("Sandbox cleanup is pending and will be retried.");
          }
        },
        instructions: `${definition.instructions}

You are running in a dedicated cloud sandbox. Tool calls are pre-approved. Work only inside the sandbox, verify the result, and include exact evidence in your final response.`,
        model: definition.model,
        onEvent,
        runtime: definition.runtime,
        sandbox: getSandbox(this.env.Sandbox, sandboxName, {
          // Chosen rather than inherited: the same idle window the warm-up
          // uses, so a warmed container and a run container age identically.
          sleepAfter: WARM_SLEEP_AFTER,
        }),
        signal,
        task,
        workspace: definition.workspace,
      });

      if (!this.executionIsLive(execution)) {
        this.clearSandboxOwnershipAfterFence(ownership);
        if (signal?.aborted) {
          this.persistExecutionCancellation(execution, credential);
        }
        return this.currentRunOr(planned.run.id, record);
      }
      this.clearSandboxOwnership(
        ownership as { generation: number; owner: string }
      );
      const completedAt = new Date().toISOString();
      const failed = run.summary.status === "failed" || run.exitCode !== 0;
      // A harness tool call is {tool, summary, success}, which is not the
      // command-evidence shape, so the translation is explicit. Everything is
      // handed to finishCloudRunRecord rather than trimmed here: that is where
      // evidence is redacted, normalized and capped, and doing any of it twice
      // would risk the two disagreeing.
      const commandEvidence: CommandEvidence[] = [
        {
          command: run.command,
          exitCode: run.exitCode,
          stderr: run.stderr,
          stdout: run.summary.output,
        },
        // A tool call has no streams of its own, so its summary is the stdout
        // and stderr stays empty rather than duplicating it into both.
        ...run.summary.toolCalls.map((call) => ({
          command: call.tool,
          exitCode: call.success ? 0 : 1,
          stderr: "",
          stdout: call.summary,
        })),
      ];
      const fileEvidence = toFileEvidence(run.summary.fileOperations);

      record = finishCloudRunRecord(record, {
        commandEvidence,
        completedAt,
        credential,
        fileEvidence,
        output:
          run.summary.output ||
          run.stderr.trim() ||
          "The harness produced no output.",
        status: failed ? "failed" : "completed",
      });
      if (!this.executionIsLive(execution)) {
        if (signal?.aborted) {
          this.persistExecutionCancellation(execution, credential);
        }
        return this.currentRunOr(planned.run.id, record);
      }
      if (this.persistRun(record)) {
        this.updateDefinition({
          lastRunAt: completedAt,
          status: failed ? "error" : "idle",
          updatedAt: completedAt,
        });
        return record;
      }
      return (
        this.state.runs.find(
          (candidate) => candidate.run.id === planned.run.id
        ) ?? record
      );
    } catch (error) {
      if (error instanceof AgentBusyError) {
        throw error;
      }
      const cancellation = this.executionWasCancelled(error, signal);
      const cleanupRequired =
        error instanceof HarnessError &&
        (error.code === "harness_timeout" ||
          error.code === "sandbox_cleanup_failed");
      if (cleanupRequired && ownership) {
        console.warn({
          agentId: definition.id,
          event: "sandbox.reap_after_timeout",
          runId: planned.run.id,
        });
        const cancelled = error.code === "sandbox_cleanup_failed";
        const cleaned = await this.cleanupOwnedSandbox(
          definition,
          ownership,
          cancelled ? "cancelled" : "failed",
          error instanceof Error ? error.message : "Sandbox cleanup required."
        );
        if (!cleaned) {
          // biome-ignore lint/style/useErrorCause: HarnessError stores the cause through its typed constructor.
          throw new HarnessError(
            "Sandbox cleanup is pending and the run remains active until it succeeds.",
            "sandbox_cleanup_pending",
            error
          );
        }
        if (error.code === "sandbox_cleanup_failed") {
          this.persistExecutionCancellation(execution, credential);
          return this.currentRunOr(planned.run.id, record);
        }
        if (!this.executionIsLive(execution)) {
          this.clearSandboxOwnershipAfterFence(ownership);
          return this.currentRunOr(planned.run.id, record);
        }
      } else if (ownership) {
        this.clearSandboxOwnership(ownership);
      }
      if (cancellation) {
        this.clearSandboxOwnershipAfterFence(ownership);
        this.persistExecutionCancellation(execution, credential);
        return this.currentRunOr(planned.run.id, record);
      }
      if (!this.executionIsLive(execution)) {
        this.clearSandboxOwnershipAfterFence(ownership);
        return this.currentRunOr(planned.run.id, record);
      }
      const completedAt = new Date().toISOString();
      record = finishCloudRunRecord(record, {
        completedAt,
        credential,
        error: {
          code:
            error instanceof HarnessError ? "harness_failed" : "internal_error",
          message:
            error instanceof Error ? error.message : "Agent execution failed.",
          retryable:
            error instanceof HarnessError &&
            error.code === "sandbox_cleanup_pending",
        },
        output:
          error instanceof Error ? error.message : "Agent execution failed.",
        status:
          error instanceof HarnessError &&
          (error.code === "harness_cancelled" ||
            error.code === "sandbox_cleanup_failed")
            ? "cancelled"
            : "failed",
      });
      if (!this.executionIsLive(execution)) {
        this.clearSandboxOwnershipAfterFence(ownership);
        return this.currentRunOr(planned.run.id, record);
      }
      if (this.persistRun(record)) {
        this.updateDefinition({
          lastRunAt: completedAt,
          status: "error",
          updatedAt: completedAt,
        });
        return record;
      }
      return (
        this.state.runs.find(
          (candidate) => candidate.run.id === planned.run.id
        ) ?? record
      );
    }
  }

  /**
   * Records a run after the admission object has accepted it, but does not
   * create a sandbox or dispatch a fiber. Queued runs keep their identity
   * token in this agent's durable state until they are dispatched; the global
   * admission object stores only the pseudonymous tenant hash.
   */
  async enqueue(
    input: unknown,
    runId: string,
    requestHash: string,
    identityToken: string
  ): Promise<{
    created: boolean;
    prepareOwner?: string;
    run: RunSnapshot;
  }> {
    const { operationId, task } = startRunInputSchema.parse(input);
    const definition = this.requireActiveDefinition();
    validateCloudWorkspace(definition);

    const plan = planCloudRunStart(
      {
        agentId: definition.id,
        createdAt: new Date().toISOString(),
        operationHash: requestHash,
        operationId,
        records: this.state.runs,
        runId,
        task,
      },
      { allowQueued: true }
    );
    if (plan.kind === "conflict") {
      throw new OperationConflictError();
    }
    if (plan.kind === "existing") {
      if (
        plan.record.run.status === "queued" &&
        !plan.record.admissionConfirmedAt
      ) {
        if (identityToken) {
          await this.attachIdentityCapability(
            plan.record.run.id,
            identityToken
          );
        }
        if (!plan.record.pendingAdmission) {
          const pendingAdmission = this.newPendingAdmission();
          this.persistRun({
            ...plan.record,
            pendingAdmission,
          });
        }
        await this.schedulePendingAdmission(plan.record.run.id);
      }
      return Promise.resolve({ created: false, run: plan.record.run });
    }

    const prepareOwner = crypto.randomUUID();
    const pendingAdmission = this.newPendingAdmission(prepareOwner);
    this.persistRun({
      ...plan.record,
      pendingAdmission,
    });
    if (identityToken) {
      await this.attachIdentityCapability(runId, identityToken);
    }
    await this.schedulePendingAdmission(runId);
    return { created: true, prepareOwner, run: plan.record.run };
  }

  private async attachIdentityCapability(
    runId: string,
    identityToken: string
  ): Promise<void> {
    const secret = (this.env as unknown as { RUNNER_SERVICE_TOKEN?: string })
      .RUNNER_SERVICE_TOKEN;
    if (!secret) {
      // Test/local agents may not have a deployment secret. Keep this
      // capability only in the live object; durable state must never contain
      // the bearer token in plaintext.
      this.ephemeralIdentityTokens.set(runId, {
        expiresAt: Date.now() + IDENTITY_CAPABILITY_TTL_MS,
        token: identityToken,
      });
      const identityCapabilities = {
        ...(this.state.identityCapabilities ?? {}),
      };
      delete identityCapabilities[runId];
      const identityTokens = { ...(this.state.identityTokens ?? {}) };
      delete identityTokens[runId];
      this.setState({ ...this.state, identityCapabilities, identityTokens });
      return;
    }
    const capability = await this.protectIdentityToken(identityToken);
    const identityCapabilities = {
      ...(this.state.identityCapabilities ?? {}),
      [runId]: capability,
    };
    const identityTokens = { ...(this.state.identityTokens ?? {}) };
    delete identityTokens[runId];
    this.setState({
      ...this.state,
      identityCapabilities,
      identityTokens,
    });
  }

  private async protectIdentityToken(
    identityToken: string
  ): Promise<StoredIdentityCapability> {
    const expiresAt = Date.now() + IDENTITY_CAPABILITY_TTL_MS;
    const secret = (this.env as unknown as { RUNNER_SERVICE_TOKEN?: string })
      .RUNNER_SERVICE_TOKEN;
    if (!secret) {
      throw new Error("Runner service token is required for durable identity.");
    }
    const key = await this.identityCapabilityKey(secret);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { iv, name: "AES-GCM" },
      key,
      new TextEncoder().encode(identityToken)
    );
    return {
      ciphertext: base64Encode(new Uint8Array(encrypted)),
      expiresAt,
      iv: base64Encode(iv),
    };
  }

  private async readIdentityToken(runId: string): Promise<string | undefined> {
    const capability = this.state.identityCapabilities?.[runId];
    if (capability) {
      if (capability.expiresAt <= Date.now()) {
        this.removeIdentityCapability(runId);
        return;
      }
      const secret = (this.env as unknown as { RUNNER_SERVICE_TOKEN?: string })
        .RUNNER_SERVICE_TOKEN;
      if (!secret || !capability.iv) {
        this.removeIdentityCapability(runId);
        return this.readEphemeralIdentityToken(runId);
      }
      try {
        const key = await this.identityCapabilityKey(secret);
        const decrypted = await crypto.subtle.decrypt(
          { iv: base64Decode(capability.iv), name: "AES-GCM" },
          key,
          base64Decode(capability.ciphertext)
        );
        return new TextDecoder().decode(decrypted);
      } catch {
        this.removeIdentityCapability(runId);
        return;
      }
    }
    const legacyToken = this.state.identityTokens?.[runId];
    if (legacyToken) {
      const secret = (this.env as unknown as { RUNNER_SERVICE_TOKEN?: string })
        .RUNNER_SERVICE_TOKEN;
      if (secret) {
        await this.attachIdentityCapability(runId, legacyToken);
        return this.readIdentityToken(runId);
      }
      this.removeIdentityCapability(runId);
    }
    return this.readEphemeralIdentityToken(runId);
  }

  private readEphemeralIdentityToken(runId: string): string | undefined {
    const capability = this.ephemeralIdentityTokens.get(runId);
    if (!capability) {
      return;
    }
    if (capability.expiresAt <= Date.now()) {
      this.ephemeralIdentityTokens.delete(runId);
      return;
    }
    return capability.token;
  }

  private removeIdentityCapability(runId: string): void {
    this.ephemeralIdentityTokens.delete(runId);
    const identityCapabilities = {
      ...(this.state.identityCapabilities ?? {}),
    };
    delete identityCapabilities[runId];
    const identityTokens = { ...(this.state.identityTokens ?? {}) };
    delete identityTokens[runId];
    this.setState({ ...this.state, identityCapabilities, identityTokens });
  }

  private async identityCapabilityKey(secret: string): Promise<CryptoKey> {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(secret)
    );
    return await crypto.subtle.importKey(
      "raw",
      digest,
      { name: "AES-GCM" },
      false,
      ["decrypt", "encrypt"]
    );
  }

  private newPendingAdmission(
    prepareOwner?: string
  ): NonNullable<CloudRunRecord["pendingAdmission"]> {
    return {
      deadlineAt: Date.now() + PENDING_ADMISSION_TIMEOUT_MS,
      ...(prepareOwner ? { prepareOwner } : {}),
      scheduleGeneration: 1,
      scheduleToken: crypto.randomUUID(),
    };
  }

  private async schedulePendingAdmission(runId: string): Promise<void> {
    const current = this.state.runs.find(
      (candidate) => candidate.run.id === runId
    );
    const pending = current?.pendingAdmission;
    if (!current || !pending || current.run.status !== "queued") {
      return;
    }
    const { schedule } = this as unknown as {
      schedule?: (
        when: Date,
        callback: string,
        payload?: PendingAdmissionSchedulePayload,
        options?: { idempotent?: boolean }
      ) => Promise<{ id: string }>;
    };
    if (!schedule || pending.scheduleId !== undefined) {
      return;
    }
    const generation = pending.scheduleGeneration ?? 1;
    const token = pending.scheduleToken ?? crypto.randomUUID();
    if (
      pending.scheduleGeneration !== generation ||
      pending.scheduleToken !== token
    ) {
      const updated = {
        ...current,
        pendingAdmission: {
          ...pending,
          scheduleGeneration: generation,
          scheduleToken: token,
        },
      };
      this.persistRun(updated);
    }
    try {
      const scheduled = await schedule.call(
        this,
        new Date(pending.deadlineAt),
        "expirePendingAdmission",
        { generation, runId, token },
        { idempotent: false }
      );
      const latest = this.state.runs.find(
        (candidate) => candidate.run.id === runId
      );
      if (
        !latest?.pendingAdmission ||
        latest.pendingAdmission.scheduleGeneration !== generation ||
        latest.pendingAdmission.scheduleToken !== token ||
        latest.run.status !== "queued"
      ) {
        await this.cancelPendingAdmissionSchedule(scheduled.id);
        return;
      }
      this.persistRun({
        ...latest,
        pendingAdmission: {
          ...latest.pendingAdmission,
          scheduleId: scheduled.id,
        },
      });
    } catch {
      // The durable deadline remains on the run. A retry request or a later
      // lifecycle callback can schedule it again.
    }
  }

  async confirmAdmission(
    runId: string,
    operationId: string,
    requestHash: string
  ): Promise<boolean> {
    const current = this.state.runs.find(
      (candidate) => candidate.run.id === runId
    );
    if (
      !current ||
      current.run.operationId !== operationId ||
      current.operationHash !== requestHash ||
      current.run.agentId !== this.requireDefinition().id
    ) {
      return false;
    }
    if (isTerminal(current.run.status)) {
      await this.reportAdmissionTerminal(runId);
      return true;
    }
    const pending = current.pendingAdmission;
    if (!pending && current.admissionConfirmedAt) {
      return true;
    }
    this.persistRun({
      ...current,
      admissionConfirmedAt:
        current.admissionConfirmedAt ?? new Date().toISOString(),
      pendingAdmission: undefined,
    });
    if (pending?.scheduleId) {
      await this.cancelPendingAdmissionSchedule(pending.scheduleId);
    }
    return true;
  }

  async expirePendingAdmission(
    payload?: PendingAdmissionSchedulePayload,
    schedule?: { id?: string }
  ): Promise<boolean> {
    let current = this.state.runs.find(
      (candidate) => candidate.run.id === payload?.runId
    );
    if (!current && payload?.runId) {
      return true;
    }
    if (!current) {
      current = this.state.runs.find((candidate) => candidate.pendingAdmission);
    }
    const pending = current?.pendingAdmission;
    if (!current || !pending || isTerminal(current.run.status)) {
      return true;
    }
    if (
      payload &&
      (pending.scheduleGeneration !== payload.generation ||
        pending.scheduleToken !== payload.token ||
        (schedule?.id !== undefined && pending.scheduleId !== schedule.id))
    ) {
      return true;
    }
    if (pending.scheduleId && schedule?.id === pending.scheduleId) {
      this.persistRun({
        ...current,
        pendingAdmission: {
          ...pending,
          scheduleId: undefined,
        },
      });
      current = this.state.runs.find(
        (candidate) => candidate.run.id === current?.run.id
      );
    }
    if (!current?.pendingAdmission) {
      return true;
    }
    if (current.pendingAdmission.deadlineAt > Date.now()) {
      await this.schedulePendingAdmission(current.run.id);
      return true;
    }

    let admissionRecord: {
      agentId: string;
      operationId: string;
      requestHash: string;
      runId: string;
      state: "queued" | "active" | "terminal";
    } | null = null;
    try {
      const runAdmission = (
        this.env as unknown as {
          RunAdmission?: {
            getByName: (name: string) => {
              getRecord?: (
                admissionRunId: string
              ) => Promise<typeof admissionRecord>;
            };
          };
        }
      ).RunAdmission;
      const admission = runAdmission?.getByName("deployment");
      const getRecord = admission?.getRecord;
      admissionRecord = getRecord
        ? await getRecord.call(admission, current.run.id)
        : null;
    } catch {
      await this.schedulePendingAdmission(current.run.id);
      return false;
    }
    if (
      admissionRecord &&
      admissionRecord.state !== "terminal" &&
      admissionRecord.agentId === current.run.agentId &&
      admissionRecord.operationId === current.run.operationId &&
      admissionRecord.requestHash === current.operationHash &&
      admissionRecord.runId === current.run.id
    ) {
      return await this.confirmAdmission(
        current.run.id,
        current.run.operationId,
        current.operationHash
      );
    }

    const latest = this.state.runs.find(
      (candidate) => candidate.run.id === current?.run.id
    );
    if (
      latest?.run.status === "queued" &&
      latest.pendingAdmission &&
      !latest.dispatchToken &&
      !this.state.admissionTokens?.[latest.run.id] &&
      !this.state.dispatchClaims?.[latest.run.id]
    ) {
      const discarded = this.discardRun(
        latest.run.id,
        latest.pendingAdmission.prepareOwner
      );
      if (discarded && pending.scheduleId) {
        await this.cancelPendingAdmissionSchedule(pending.scheduleId);
      }
      return discarded;
    }
    return true;
  }

  private async cancelPendingAdmissionSchedule(id: string): Promise<void> {
    const { cancelSchedule } = this as unknown as {
      cancelSchedule?: (scheduleId: string) => Promise<boolean>;
    };
    if (!cancelSchedule) {
      return;
    }
    try {
      await cancelSchedule.call(this, id);
    } catch {
      // The state fence is authoritative even if platform cancellation fails.
    }
  }

  /**
   * Starts a run selected by RunAdmission. The admission object marks its
   * record active before this RPC, and a terminal callback in `finally`
   * releases that capacity even when the harness throws.
   */
  async startAdmitted(runId: string, dispatchToken: string): Promise<boolean> {
    if (!dispatchToken) {
      return false;
    }
    if (!(await this.dispatchIsAdmitted(runId, dispatchToken))) {
      const terminal = this.state.runs.find(
        (candidate) => candidate.run.id === runId
      );
      if (terminal && isTerminal(terminal.run.status)) {
        await this.reportAdmissionTerminal(runId, dispatchToken);
        return true;
      }
      return false;
    }
    const admittedRecord = this.state.runs.find(
      (candidate) => candidate.run.id === runId
    );
    if (admittedRecord) {
      const confirmed = await this.confirmAdmission(
        runId,
        admittedRecord.run.operationId,
        admittedRecord.operationHash
      );
      if (!confirmed) {
        return false;
      }
      const afterConfirmation = this.state.runs.find(
        (candidate) => candidate.run.id === runId
      );
      if (afterConfirmation && isTerminal(afterConfirmation.run.status)) {
        await this.reportAdmissionTerminal(runId, dispatchToken);
        return true;
      }
    }
    const definition = this.requireActiveDefinition();
    const lifecycleGeneration = this.currentLifecycle().generation;
    if (!(await this.repairPendingSandboxCleanup(definition))) {
      throw new AgentBusyError();
    }
    if (
      !this.lifecycleIsActive(lifecycleGeneration) ||
      this.state.definition?.id !== definition.id ||
      this.state.decommission
    ) {
      throw new AgentBusyError();
    }
    let record = this.state.runs.find(
      (candidate) => candidate.run.id === runId
    );
    if (
      rejectsAdmissionToken(this.state.admissionFences?.[runId], dispatchToken)
    ) {
      return false;
    }
    if (!record || isTerminal(record.run.status)) {
      return false;
    }
    if (
      dispatchToken &&
      record.run.status !== "queued" &&
      record.dispatchToken !== dispatchToken
    ) {
      return false;
    }
    const identityToken = await this.readIdentityToken(runId);
    if (!identityToken) {
      throw new Error("Queued run identity is unavailable.");
    }
    if (this.state.sandbox?.owner || this.state.sandbox?.cleanup) {
      await this.ensureSandboxAvailableForRun(definition, runId);
    }
    record = this.requireCurrentAdmittedStart(
      runId,
      dispatchToken,
      lifecycleGeneration,
      definition.id
    );
    if (dispatchToken) {
      record = this.requireCurrentAdmittedStart(
        runId,
        dispatchToken,
        lifecycleGeneration,
        definition.id
      );
      const tokenized = { ...record, dispatchToken };
      this.persistRun(tokenized, { allowDispatchTokenReplacement: true });
      this.setState({
        ...this.state,
        admissionTokens: {
          ...(this.state.admissionTokens ?? {}),
          [runId]: dispatchToken,
        },
      });
    }
    record = this.requireCurrentAdmittedStart(
      runId,
      dispatchToken,
      lifecycleGeneration,
      definition.id
    );
    const claimed = this.claimRunStart(
      dispatchToken ? { ...record, dispatchToken } : record
    );
    const token = claimed.dispatchToken;
    await this.markDirectoryRunStatus(runId, "active");
    try {
      const receipt = await this.startFiber(
        cloudFiberKey(runId),
        async (fiber) =>
          this.trackFiberCompletion(
            cloudFiberKey(runId),
            (async () => {
              try {
                await this.driveHarness(
                  definition,
                  claimed,
                  claimed.run.task,
                  identityToken,
                  fiber.signal
                );
              } finally {
                await this.reportAdmissionTerminal(runId, token);
              }
            })()
          ),
        {
          idempotencyKey: cloudFiberKey(runId),
          metadata: {
            runId,
            ...(token ? { dispatchToken: token } : {}),
          },
        }
      );
      if (!receipt.accepted) {
        if (receipt.status !== "pending" && receipt.status !== "running") {
          await this.failRunAfterDispatchError(
            runId,
            new Error("An existing cloud run fiber was no longer active."),
            token
          );
          await this.reportAdmissionTerminal(runId, token);
        }
        return false;
      }
    } catch (error) {
      await this.failRunAfterDispatchError(runId, error, token);
      await this.reportAdmissionTerminal(runId, token);
      throw error;
    }
    return true;
  }

  /**
   * Durably rejects a dispatch that the admission coordinator is about to
   * requeue. The queued status check and fence write happen in this Agent
   * Durable Object before the RPC yields, so a start that wins the race makes
   * this return false and keeps the coordinator's claim active.
   */
  fenceAdmitted(runId: string, dispatchToken: string): boolean {
    if (!dispatchToken) {
      return false;
    }
    const lifecycle = this.currentLifecycle();
    const record = this.state.runs.find(
      (candidate) => candidate.run.id === runId
    );
    if (lifecycle.status !== "active" && record) {
      return false;
    }
    if (record && record.run.status !== "queued") {
      return false;
    }
    const existing = normalizeAdmissionFence(
      this.state.admissionFences?.[runId]
    );
    const generation = dispatchGeneration(dispatchToken);
    if (
      generation !== undefined &&
      existing.generation !== undefined &&
      existing.generation >= generation
    ) {
      return true;
    }

    if (generation === undefined && existing.tokens?.includes(dispatchToken)) {
      return true;
    }
    let nextFence: AdmissionFence;
    if (generation === undefined) {
      nextFence = {
        ...existing,
        tokens: [
          ...(existing.tokens ?? []).filter((token) => token !== dispatchToken),
          dispatchToken,
        ].slice(-MAX_LEGACY_ADMISSION_FENCE_TOKENS),
      };
    } else {
      nextFence = {
        ...existing,
        generation: Math.max(existing.generation ?? 0, generation),
      };
    }
    this.setState({
      ...this.state,
      admissionFences: this.pruneAdmissionFences({
        ...(this.state.admissionFences ?? {}),
        [runId]: nextFence,
      }),
    });
    return true;
  }

  /**
   * Atomically fences a stale dispatch and clears the local token that made
   * the run look claimed. The run must still be queued and unstarted; a
   * started or terminal run is left untouched so admission keeps its active
   * ambiguity rather than risking a duplicate execution.
   */
  requeueAdmitted(runId: string, dispatchToken: string): boolean {
    if (!dispatchToken || !this.lifecycleIsActive()) {
      return false;
    }
    const record = this.state.runs.find(
      (candidate) => candidate.run.id === runId
    );
    if (record?.run.status !== "queued" || record.run.startedAt !== null) {
      return false;
    }
    const localToken =
      record.dispatchToken ?? this.state.admissionTokens?.[runId];
    const localClaim = this.state.dispatchClaims?.[runId];
    if (
      (localToken && localToken !== dispatchToken) ||
      (localClaim && localClaim !== dispatchToken)
    ) {
      return false;
    }
    const existing = normalizeAdmissionFence(
      this.state.admissionFences?.[runId]
    );
    if (existing.cancelled) {
      return false;
    }
    const generation = dispatchGeneration(dispatchToken);
    const nextFence =
      generation === undefined
        ? {
            ...existing,
            tokens: [
              ...(existing.tokens ?? []).filter(
                (token) => token !== dispatchToken
              ),
              dispatchToken,
            ].slice(-MAX_LEGACY_ADMISSION_FENCE_TOKENS),
          }
        : {
            ...existing,
            generation: Math.max(existing.generation ?? 0, generation),
          };
    const runs = this.state.runs.map((candidate) =>
      candidate.run.id === runId
        ? { ...candidate, dispatchToken: undefined }
        : candidate
    );
    const admissionTokens = { ...(this.state.admissionTokens ?? {}) };
    delete admissionTokens[runId];
    const dispatchClaims = { ...(this.state.dispatchClaims ?? {}) };
    delete dispatchClaims[runId];
    this.setState({
      ...this.state,
      admissionFences: this.pruneAdmissionFences({
        ...(this.state.admissionFences ?? {}),
        [runId]: nextFence,
      }),
      admissionTokens,
      dispatchClaims,
      runs,
    });
    return true;
  }

  private pruneAdmissionFences(
    fences: Record<string, AdmissionFence | string[]>
  ): Record<string, AdmissionFence | string[]> {
    const entries = Object.entries(fences);
    if (entries.length <= MAX_ADMISSION_FENCE_TOMBSTONES) {
      return fences;
    }
    return Object.fromEntries(entries.slice(-MAX_ADMISSION_FENCE_TOMBSTONES));
  }

  async onFiberRecovered(
    context: FiberRecoveryContext
  ): Promise<undefined | FiberRecoveryResult> {
    if (
      context.name === WARM_FIBER_KEY ||
      context.metadata?.kind === WARM_FIBER_KEY
    ) {
      return this.recoverWarmFiber();
    }
    const metadataRunId = context.metadata?.runId;
    const metadataDispatchToken = context.metadata?.dispatchToken;
    const recoveredDispatchToken =
      typeof metadataDispatchToken === "string"
        ? metadataDispatchToken
        : undefined;
    const runId =
      typeof metadataRunId === "string"
        ? metadataRunId
        : context.name.startsWith("run:")
          ? context.name.slice("run:".length)
          : null;
    if (!runId) {
      const recovered = await super.onFiberRecovered(context);
      return recovered === undefined ? undefined : recovered;
    }
    if (!this.lifecycleIsActive()) {
      return {
        reason: "Agent is being decommissioned.",
        status: "aborted",
      };
    }

    const current = this.state.runs.find(
      (candidate) => candidate.run.id === runId
    );
    if (!current) {
      return {
        error: "Cloud run record was not retained after fiber recovery.",
        status: "error",
      };
    }
    const currentDispatchToken =
      current.dispatchToken ?? this.state.admissionTokens?.[runId];
    if (
      currentDispatchToken &&
      currentDispatchToken !== recoveredDispatchToken
    ) {
      return {
        reason: "Recovered fiber belongs to an obsolete admission dispatch.",
        status: "aborted",
      };
    }
    // A queued cancellation never created a fiber or sandbox. Recovered
    // fibers from dispatch-claimed work still require the normal cleanup.
    const cancelledBeforeDispatch =
      current.run.status === "cancelled" &&
      current.run.startedAt === null &&
      !current.dispatchToken &&
      !this.state.admissionTokens?.[runId] &&
      !this.state.dispatchClaims?.[runId];
    if (!cancelledBeforeDispatch) {
      const { sandbox } = this.state;
      if (
        sandbox?.owner &&
        (sandbox.runId !== runId ||
          sandbox.dispatchToken !== recoveredDispatchToken)
      ) {
        return {
          reason: "Recovered fiber cannot take ownership of a newer sandbox.",
          status: "aborted",
        };
      }
      if (sandbox?.cleanup?.runId && sandbox.cleanup.runId !== runId) {
        return {
          reason: "Recovered fiber cannot take ownership of a newer sandbox.",
          status: "aborted",
        };
      }
      const ownership =
        sandbox?.runId === runId && sandbox.owner
          ? {
              dispatchToken: sandbox.dispatchToken,
              generation: sandbox.generation,
              owner: sandbox.owner,
              runId,
            }
          : this.acquireSandboxOwnership(runId, recoveredDispatchToken);
      const cleaned = await this.cleanupOwnedSandbox(
        this.requireDefinition(),
        ownership,
        "failed",
        "The cloud run fiber was interrupted before sandbox cleanup completed."
      );
      if (!cleaned) {
        throw new Error(
          `Sandbox cleanup is still unavailable.${this.state.sandbox?.cleanup?.message ? ` ${this.state.sandbox.cleanup.message}` : ""}`
        );
      }
    }
    if (isTerminal(current.run.status)) {
      await this.reportAdmissionTerminal(
        runId,
        recoveredDispatchToken ?? currentDispatchToken
      );
      if (current.run.status === "cancelled") {
        return {
          reason: "Run was cancelled before recovery.",
          status: "aborted",
        };
      }
      return current.run.status === "completed"
        ? { status: "completed" }
        : {
            error:
              current.run.error?.message ??
              "Cloud run was already failed before fiber recovery.",
            status: "error",
          };
    }

    const recovered = recoverCloudRunRecord(current, new Date().toISOString());
    if (!this.lifecycleIsActive()) {
      return {
        reason: "Agent is being decommissioned.",
        status: "aborted",
      };
    }
    if (this.persistRun(recovered, { dispatchClaim: null })) {
      this.updateDefinition({
        lastRunAt: recovered.run.completedAt ?? new Date().toISOString(),
        status: "error",
        updatedAt: recovered.run.completedAt ?? new Date().toISOString(),
      });
    }
    await this.reportAdmissionTerminal(
      runId,
      recoveredDispatchToken ?? currentDispatchToken
    );
    return {
      error: recovered.run.error?.message ?? "Cloud run was interrupted.",
      status: "error",
    };
  }

  /**
   * Claims the only agent execution slot before any asynchronous fiber call.
   * Admission can retry the same RPC, but two different run ids cannot both
   * observe a free slot while the first fiber is still being accepted.
   */
  private claimRunStart(planned: CloudRunRecord): CloudRunRecord {
    const current =
      this.state.runs.find(
        (candidate) => candidate.run.id === planned.run.id
      ) ?? planned;
    if (
      planned.dispatchToken &&
      current.dispatchToken !== planned.dispatchToken
    ) {
      throw new Error("Cloud run dispatch is obsolete.");
    }
    if (isTerminal(current.run.status)) {
      throw new AlreadyRunningError();
    }
    if (this.state.sandbox?.cleanup) {
      throw new AgentBusyError();
    }
    if (this.hasOtherExecutionClaim(current.run.id)) {
      throw new AgentBusyError();
    }
    if (current.run.status === "running") {
      return current;
    }
    const startedAt = new Date().toISOString();
    const claimed = appendEvents(
      {
        ...current,
        run: { ...current.run, startedAt, status: "running" as const },
      },
      [
        {
          at: startedAt,
          id: nextEventId(current),
          status: "running",
          type: "status",
        },
      ]
    );
    this.persistRun(claimed, { dispatchClaim: null });
    this.updateDefinition({ status: "running", updatedAt: startedAt });
    return claimed;
  }

  private failRunAfterDispatchError(
    runId: string,
    error: unknown,
    dispatchToken?: string
  ): void {
    const current = this.state.runs.find(
      (candidate) => candidate.run.id === runId
    );
    if (!current || isTerminal(current.run.status)) {
      return;
    }
    if (dispatchToken && current.dispatchToken !== dispatchToken) {
      return;
    }
    const completedAt = new Date().toISOString();
    const failed = finishCloudRunRecord(current, {
      completedAt,
      credential: null,
      error: {
        code: "internal_error",
        message:
          error instanceof Error
            ? error.message
            : "Cloud run fiber could not be started.",
        retryable: false,
      },
      output:
        error instanceof Error
          ? error.message
          : "Cloud run fiber could not be started.",
      status: "failed",
    });
    if (this.persistRun(failed, { dispatchClaim: null })) {
      this.updateDefinition({
        lastRunAt: completedAt,
        status: "error",
        updatedAt: completedAt,
      });
    }
  }

  /** Checks whether this caller still owns the prepared admission. */
  prepareOwnerMatches(runId: string, prepareOwner: string): boolean {
    return Boolean(
      prepareOwner &&
        this.state.runs.find((candidate) => candidate.run.id === runId)
          ?.pendingAdmission?.prepareOwner === prepareOwner
    );
  }

  /** Removes a prepared run when admission refuses it before dispatch. */
  discardRun(runId: string, prepareOwner?: string): boolean {
    const record = this.state.runs.find(
      (candidate) => candidate.run.id === runId
    );
    if (
      record?.run.status !== "queued" ||
      !prepareOwner ||
      record.pendingAdmission?.prepareOwner !== prepareOwner
    ) {
      return false;
    }
    this.setState({
      ...this.state,
      admissionFences: Object.fromEntries(
        Object.entries(this.state.admissionFences ?? {}).filter(
          ([candidate]) => candidate !== runId
        )
      ),
      dispatchClaims: Object.fromEntries(
        Object.entries(this.state.dispatchClaims ?? {}).filter(
          ([candidate]) => candidate !== runId
        )
      ),
      identityCapabilities: Object.fromEntries(
        Object.entries(this.state.identityCapabilities ?? {}).filter(
          ([candidate]) => candidate !== runId
        )
      ),
      identityTokens: Object.fromEntries(
        Object.entries(this.state.identityTokens ?? {}).filter(
          ([candidate]) => candidate !== runId
        )
      ),
      runs: this.state.runs.filter((candidate) => candidate.run.id !== runId),
    });
    return true;
  }

  /**
   * Cancels a run that is still in flight and records it as cancelled.
   *
   * Cancelling the fiber is not enough on its own — a cancelled fiber simply
   * stops, leaving the record stuck in `running` forever. The record has to be
   * closed here so a caller polling the run sees a terminal state.
   */
  async stop(
    runId: string,
    dispatchToken?: string,
    reason = "Run cancelled by operator request."
  ): Promise<RunSnapshot | null> {
    const definition = this.requireDefinition();
    const record = this.state.runs.find(
      (candidate) => candidate.run.id === runId
    );
    if (!record) {
      return null;
    }
    const currentDispatchToken =
      record.dispatchToken ?? this.state.admissionTokens?.[runId];
    const expectedDispatchToken = dispatchToken ?? currentDispatchToken;
    if (dispatchToken && currentDispatchToken !== dispatchToken) {
      return record.run;
    }
    if (isTerminal(record.run.status)) {
      // Already finished. Cancelling would be a no-op and rewriting the record
      // would discard the real outcome.
      await this.reportAdmissionTerminal(runId, expectedDispatchToken);
      return record.run;
    }

    if (this.isTrulyQueued(record)) {
      const cancelled = this.cancelQueuedRun(record, reason);
      if (cancelled) {
        await this.reportAdmissionTerminal(runId, expectedDispatchToken);
        this.updateDefinitionAfterCancellation(
          cancelled.run.completedAt ?? new Date().toISOString()
        );
        return cancelled.run;
      }
    }

    if (this.state.sandbox?.cleanup) {
      if (!(await this.repairPendingSandboxCleanup(definition))) {
        throw new Error("Sandbox cleanup is still unavailable.");
      }
      const repaired = this.state.runs.find(
        (candidate) => candidate.run.id === runId
      );
      if (!repaired || isTerminal(repaired.run.status)) {
        await this.reportAdmissionTerminal(runId, expectedDispatchToken);
        return repaired?.run ?? null;
      }
    }
    await this.cancelFiberByKey(cloudFiberKey(runId), "Cancelled by operator.");
    const afterCancel = this.state.runs.find(
      (candidate) => candidate.run.id === runId
    );
    if (!afterCancel) {
      await this.reportAdmissionTerminal(runId, expectedDispatchToken);
      return null;
    }
    if (isTerminal(afterCancel.run.status)) {
      await this.reportAdmissionTerminal(runId, expectedDispatchToken);
      return afterCancel.run;
    }
    if (
      expectedDispatchToken &&
      !this.dispatchTokenMatches(runId, expectedDispatchToken)
    ) {
      return afterCancel.run;
    }
    if (this.state.sandbox?.owner && !this.state.sandbox.runId) {
      await this.ensureSandboxAvailableForRun(definition, runId);
    }
    if (this.state.sandbox?.runId && this.state.sandbox.runId !== runId) {
      throw new AgentBusyError();
    }
    const ownership =
      this.state.sandbox?.runId === runId && this.state.sandbox.owner
        ? {
            dispatchToken: this.state.sandbox.dispatchToken,
            generation: this.state.sandbox.generation,
            owner: this.state.sandbox.owner,
            runId,
          }
        : this.tryAcquireSandboxOwnership(runId, expectedDispatchToken, () => {
            const current = this.state.runs.find(
              (candidate) => candidate.run.id === runId
            );
            return Boolean(
              current &&
                !isTerminal(current.run.status) &&
                (!expectedDispatchToken ||
                  this.dispatchTokenMatches(runId, expectedDispatchToken)) &&
                !this.state.sandbox?.owner &&
                !this.state.sandbox?.cleanup
            );
          });
    if (!ownership) {
      throw new AgentBusyError();
    }
    if (
      !(await this.cleanupOwnedSandbox(
        definition,
        ownership,
        "cancelled",
        "The sandbox was destroyed while cancelling the cloud run."
      ))
    ) {
      throw new Error(
        `Sandbox cleanup is still unavailable.${this.state.sandbox?.cleanup?.message ? ` ${this.state.sandbox.cleanup.message}` : ""}`
      );
    }
    const current = this.state.runs.find(
      (candidate) => candidate.run.id === runId
    );
    if (!current) {
      return null;
    }
    if (
      expectedDispatchToken &&
      !this.dispatchTokenMatches(runId, expectedDispatchToken)
    ) {
      return current.run;
    }
    if (isTerminal(current.run.status)) {
      await this.reportAdmissionTerminal(runId, expectedDispatchToken);
      return current.run;
    }
    const cancelled = finishCloudRunRecord(current, {
      completedAt: new Date().toISOString(),
      // Cancellation is an operator action outside `driveHarness`, so no
      // credential is in scope here — the static message below carries none,
      // and the run's already-persisted evidence was redacted when it was
      // first captured.
      credential: null,
      output: reason,
      status: "cancelled",
    });
    if (this.persistRun(cancelled, { dispatchClaim: null })) {
      await this.reportAdmissionTerminal(runId, expectedDispatchToken);
      this.updateDefinitionAfterCancellation(
        cancelled.run.completedAt ?? new Date().toISOString()
      );
      return cancelled.run;
    }
    const latest = this.state.runs.find(
      (candidate) => candidate.run.id === runId
    );
    if (latest) {
      await this.reportAdmissionTerminal(runId, expectedDispatchToken);
      return latest.run;
    }
    return null;
  }

  private isTrulyQueued(record: CloudRunRecord): boolean {
    return (
      record.run.status === "queued" &&
      !record.dispatchToken &&
      !this.state.admissionTokens?.[record.run.id] &&
      !this.state.dispatchClaims?.[record.run.id]
    );
  }

  private hasOtherExecutionClaim(runId: string): boolean {
    return this.state.runs.some(
      (candidate) =>
        candidate.run.id !== runId &&
        !isTerminal(candidate.run.status) &&
        (candidate.run.status === "running" ||
          Boolean(candidate.dispatchToken) ||
          Boolean(this.state.admissionTokens?.[candidate.run.id]) ||
          Boolean(this.state.dispatchClaims?.[candidate.run.id]))
    );
  }

  private cancelQueuedRun(
    record: CloudRunRecord,
    reason: string
  ): CloudRunRecord | null {
    const current = this.state.runs.find(
      (candidate) => candidate.run.id === record.run.id
    );
    if (!current || !this.isTrulyQueued(current)) {
      return null;
    }

    const fence = normalizeAdmissionFence(
      this.state.admissionFences?.[record.run.id]
    );
    const cancelled = finishCloudRunRecord(current, {
      completedAt: new Date().toISOString(),
      credential: null,
      output: reason,
      status: "cancelled",
    });
    // Persist the terminal record and its cancellation fence together. A
    // later dispatch must observe either this terminal state or the old
    // queued state, never a cancellation without its fence.
    return this.persistRun(cancelled, {
      admissionFence: { ...fence, cancelled: true },
    })
      ? cancelled
      : null;
  }

  private updateDefinitionAfterCancellation(completedAt: string): void {
    this.updateDefinition({
      status: this.state.runs.some(
        (candidate) => candidate.run.status === "running"
      )
        ? "running"
        : "idle",
      updatedAt: completedAt,
    });
  }

  /**
   * Events recorded after `lastEventId`, plus whether the run has finished.
   *
   * `terminal` is what lets the stream close rather than poll forever, so it
   * reports the run's status and not whether this batch happened to be empty.
   */
  /**
   * Closes any run that is provably dead but still marked live.
   *
   * Every path a run can take is bounded — the probe at 300s, the exec at
   * 900s — so a record still non-terminal past their sum plus margin has no
   * fiber behind it: the fiber either finished the record or died with a
   * restart before it could. `onFiberRecovered` is the fast path for that
   * case, but it was observed not firing for fibers interrupted by tonight's
   * deploys, and three ghost runs kept their agents' active-run slots and
   * their consoles reconnecting once a minute for an hour. Reconciling on
   * the read path is deterministic: the very next poll of a ghost closes it.
   */
  private reconcileOverdueRuns(): void {
    const now = Date.now();
    const completedAt = new Date(now).toISOString();
    let changed = false;
    const runs = this.state.runs.map((record) => {
      if (
        isTerminal(record.run.status) ||
        now - Date.parse(record.run.createdAt) < RUN_OVERDUE_MS
      ) {
        return record;
      }
      changed = true;
      console.warn({
        event: "run.recovered_after_interruption",
        runId: record.run.id,
        via: "overdue_reconcile",
      });
      return recoverCloudRunRecord(record, completedAt);
    });
    if (changed) {
      this.setState({ ...this.state, runs });
      if (this.state.definition) {
        this.updateDefinition({ status: "error", updatedAt: completedAt });
      }
    }
  }

  getEventStream(
    runId: string,
    lastEventId: number
  ): { events: RunEvent[]; terminal: boolean } | null {
    this.reconcileOverdueRuns();
    const record = this.state.runs.find(
      (candidate) => candidate.run.id === runId
    );
    if (!record) {
      return null;
    }
    return {
      events: record.events.filter((event) => event.id > lastEventId),
      terminal: isTerminal(record.run.status),
    };
  }

  /** The recorded snapshot for one run, or null when this agent has no such run. */
  getRun(runId: string): RunSnapshot | null {
    this.reconcileOverdueRuns();
    return (
      this.state.runs.find((record) => record.run.id === runId)?.run ?? null
    );
  }

  /** Every run this agent still retains, newest first. */
  listRuns(): RunSnapshot[] {
    this.reconcileOverdueRuns();
    return [...this.state.runs]
      .sort(
        (left, right) =>
          Date.parse(right.run.createdAt) - Date.parse(left.run.createdAt)
      )
      .map((record) => record.run);
  }

  /**
   * Boots this agent's sandbox ahead of its next run.
   *
   * Fire-and-settle: the caller gets `provisioning` back as soon as the
   * fiber is spawned, and the fiber records `ready` or `failed` when the
   * probe answers. Idempotent by fiber key — a second trigger while one is
   * booting joins it, and a `ready` state younger than the container's idle
   * window is trusted rather than re-probed, so a burst of triggers cannot
   * boot anything twice. Warming never touches the credential route: no run
   * is counted and no credential is ever in scope here.
   */
  async warm(): Promise<WarmState> {
    const definition = this.requireActiveDefinition();
    const lifecycleGeneration = this.currentLifecycle().generation;
    const pendingCleanup = this.state.sandbox?.cleanup;
    if (pendingCleanup?.runId) {
      throw new AgentBusyError();
    }
    if (
      pendingCleanup &&
      !(await this.repairPendingSandboxCleanup(definition))
    ) {
      throw new AgentBusyError();
    }
    if (!this.lifecycleIsActive(lifecycleGeneration)) {
      throw new AgentBusyError();
    }
    const current = definition.warm;
    const now = Date.now();
    if (
      current &&
      current.status !== "not_started" &&
      current.status !== "failed" &&
      now - Date.parse(current.updatedAt) < WARM_TRUST_WINDOW_MS
    ) {
      return current;
    }
    const { sandbox } = this.state;
    if (
      sandbox?.owner &&
      !sandbox.runId &&
      current?.status === "provisioning"
    ) {
      return current;
    }
    if (
      sandbox?.owner ||
      sandbox?.cleanup ||
      this.state.runs.some((record) => !isTerminal(record.run.status))
    ) {
      throw new AgentBusyError();
    }

    const ownership = this.tryAcquireSandboxOwnership(
      undefined,
      undefined,
      () =>
        this.definitionIsCurrent(definition, lifecycleGeneration) &&
        !this.state.sandbox?.owner &&
        !this.state.sandbox?.cleanup &&
        !this.state.runs.some((record) => !isTerminal(record.run.status))
    );
    if (!ownership) {
      throw new AgentBusyError();
    }

    const provisioning: WarmState = {
      status: "provisioning",
      updatedAt: new Date(now).toISOString(),
    };
    this.updateDefinition({ warm: provisioning });
    const warmFiberKey = `${WARM_FIBER_KEY}:${ownership.generation}`;
    this.setState({ ...this.state, warmFiberKey });

    try {
      const receipt = await this.startFiber(
        warmFiberKey,
        async (fiber) =>
          this.trackFiberCompletion(
            warmFiberKey,
            (async () => {
              try {
                await this.driveWarm(definition, ownership, fiber.signal);
              } finally {
                this.clearWarmFiberKey(warmFiberKey);
              }
            })()
          ),
        {
          idempotencyKey: warmFiberKey,
          metadata: { kind: WARM_FIBER_KEY },
        }
      );
      if (!receipt.accepted) {
        const cleaned = await this.rollbackWarmDispatch(
          definition,
          ownership,
          warmFiberKey
        );
        if (!cleaned) {
          return (
            this.state.definition?.warm ?? {
              status: "failed",
              updatedAt: new Date().toISOString(),
            }
          );
        }
        return this.state.definition?.warm ?? provisioning;
      }
    } catch (error) {
      const cleaned = await this.rollbackWarmDispatch(
        definition,
        ownership,
        warmFiberKey
      );
      if (!cleaned) {
        return (
          this.state.definition?.warm ?? {
            status: "failed",
            updatedAt: new Date().toISOString(),
          }
        );
      }
      throw error;
    }
    return provisioning;
  }

  private async driveWarm(
    definition: AgentDefinition,
    ownership: {
      generation: number;
      owner: string;
      dispatchToken?: string;
      runId?: string;
    },
    signal?: AbortSignal
  ): Promise<void> {
    const startedAt = Date.now();
    const lifecycleGeneration = this.currentLifecycle().generation;
    const sandboxName = await sandboxKey(tenantOf(definition), definition.id);
    if (
      !this.lifecycleIsActive(lifecycleGeneration) ||
      signal?.aborted ||
      !this.ownsSandbox(ownership)
    ) {
      return;
    }
    const sandbox = getSandbox(this.env.Sandbox, sandboxName, {
      sleepAfter: WARM_SLEEP_AFTER,
    });
    const outcome = await warmSandbox(sandbox, definition.runtime, undefined, {
      destroy: async () => {
        const cleaned = await this.cleanupOwnedSandbox(
          definition,
          ownership,
          "failed",
          "The warm-up sandbox was destroyed after a probe timeout."
        );
        if (!cleaned) {
          throw new Error("Warm-up sandbox cleanup is pending.");
        }
        if (
          this.state.sandbox?.generation === ownership.generation &&
          !this.state.sandbox.owner
        ) {
          this.setState({
            ...this.state,
            sandbox: {
              generation: ownership.generation,
              owner: ownership.owner,
            },
          });
        }
      },
      ownsSandbox: () => this.ownsSandbox(ownership),
      signal,
    });
    if (
      !this.lifecycleIsActive(lifecycleGeneration) ||
      !this.ownsSandbox(ownership)
    ) {
      return;
    }
    if (!this.state.sandbox?.cleanup) {
      this.clearSandboxOwnership(ownership);
    }
    console.log({
      agentId: definition.id,
      durationMs: Date.now() - startedAt,
      event: "sandbox.warm",
      outcome: outcome.ready ? "ready" : "failed",
      version: outcome.version,
    });
    // The agent may have been decommissioned while the container booted; a
    // cleared definition must stay cleared rather than be resurrected by a
    // late warm result.
    if (this.state.definition?.id === definition.id) {
      this.updateDefinition({
        warm: {
          status: outcome.ready ? "ready" : "failed",
          updatedAt: new Date().toISOString(),
        },
      });
    }
  }

  private async recoverWarmFiber(): Promise<FiberRecoveryResult> {
    const { definition } = this.state;
    const lifecycle = this.currentLifecycle();
    if (!definition || lifecycle.status !== "active") {
      return {
        reason: "Warm fiber belongs to a decommissioned agent.",
        status: "aborted",
      };
    }
    const current = this.state.sandbox;
    if (current?.runId) {
      return {
        reason: "Recovered warm fiber cannot take a run sandbox.",
        status: "aborted",
      };
    }
    if (!this.lifecycleIsActive(lifecycle.generation)) {
      return {
        reason: "Agent is being decommissioned.",
        status: "aborted",
      };
    }
    if (this.state.runs.some((record) => !isTerminal(record.run.status))) {
      return {
        reason: "A run is active; recovered warm-up must yield.",
        status: "aborted",
      };
    }
    const ownership = current?.owner
      ? {
          dispatchToken: current.dispatchToken,
          generation: current.generation,
          owner: current.owner,
          runId: current.runId,
        }
      : this.acquireSandboxOwnership();
    if (this.state.warmFiberKey) {
      this.clearWarmFiberKey(this.state.warmFiberKey);
    }
    this.updateDefinition({
      warm: {
        status: "failed",
        updatedAt: new Date().toISOString(),
      },
    });
    const cleaned = await this.cleanupOwnedSandbox(
      definition,
      ownership,
      "failed",
      "The warm sandbox was recovered after interruption and must be cleaned up."
    );
    if (!this.lifecycleIsActive(lifecycle.generation)) {
      return {
        reason: "Agent is being decommissioned.",
        status: "aborted",
      };
    }
    if (!cleaned) {
      throw new Error(
        `Warm sandbox cleanup is still unavailable.${this.state.sandbox?.cleanup?.message ? ` ${this.state.sandbox.cleanup.message}` : ""}`
      );
    }
    return {
      reason: "Recovered warm fiber was cleaned up before retry.",
      status: "aborted",
    };
  }

  private async destroyAgentSandbox(
    definition = this.requireDefinition(),
    owns?: () => boolean
  ): Promise<void> {
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (owns && !owns()) {
        return;
      }
      try {
        // biome-ignore lint/performance/noAwaitInLoops: Retries must be ordered to bound cleanup.
        const sandboxName = await sandboxKey(
          tenantOf(definition),
          definition.id
        );
        if (owns && !owns()) {
          return;
        }
        await getSandbox(this.env.Sandbox, sandboxName).destroy();
        return;
      } catch (error) {
        failure = error;
      }
    }
    throw failure instanceof Error
      ? failure
      : new Error("Agent sandbox cleanup failed.");
  }

  private decommissionSaga(): DecommissionSaga {
    const existing = this.state.decommission;
    if (existing) {
      return existing;
    }
    const admissionReleases: Record<string, AdmissionReleaseIntent> = {};
    const runIds = new Set([
      ...this.state.runs.map((record) => record.run.id),
      ...Object.keys(this.state.admissionTokens ?? {}),
    ]);
    for (const runId of runIds) {
      const record = this.state.runs.find(
        (candidate) => candidate.run.id === runId
      );
      const dispatchToken =
        record?.dispatchToken ?? this.state.admissionTokens?.[runId];
      admissionReleases[runId] = dispatchToken ? { dispatchToken } : {};
    }
    return { admissionReleases };
  }

  private async scheduleDecommissionRetry(): Promise<void> {
    const lifecycle = this.currentLifecycle();
    const saga = this.state.decommission;
    if (
      lifecycle.status !== "decommissioning" ||
      !saga ||
      saga.retryScheduleId
    ) {
      return;
    }
    const { schedule } = this as unknown as {
      schedule?: (
        when: Date,
        callback: string,
        payload?: unknown,
        options?: { idempotent?: boolean }
      ) => Promise<{ id: string }>;
    };
    if (!schedule) {
      return;
    }
    try {
      const scheduled = await schedule.call(
        this,
        new Date(Date.now() + CLEANUP_RETRY_DELAY_MS),
        "retryDecommission",
        undefined,
        { idempotent: false }
      );
      const current = this.currentLifecycle();
      const currentSaga = this.state.decommission;
      if (
        current.status !== "decommissioning" ||
        current.generation !== lifecycle.generation ||
        !currentSaga
      ) {
        await this.cancelDecommissionRetry(scheduled.id);
        return;
      }
      this.setState({
        ...this.state,
        decommission: {
          ...currentSaga,
          retryScheduleId: scheduled.id,
        },
      });
    } catch {
      // A subsequent DELETE or the admission alarm can drive the saga if the
      // platform scheduler is temporarily unavailable.
    }
  }

  private async cancelDecommissionRetry(
    id = this.state.decommission?.retryScheduleId
  ): Promise<void> {
    if (!id) {
      return;
    }
    const saga = this.state.decommission;
    if (saga?.retryScheduleId === id) {
      const { retryScheduleId: _retryScheduleId, ...rest } = saga;
      this.setState({ ...this.state, decommission: rest });
    }
    const { cancelSchedule } = this as unknown as {
      cancelSchedule?: (scheduleId: string) => Promise<boolean>;
    };
    if (!cancelSchedule) {
      return;
    }
    try {
      await cancelSchedule.call(this, id);
    } catch {
      // The lifecycle remains fenced even if schedule cancellation fails.
    }
  }

  async retryDecommission(): Promise<void> {
    const id = this.state.decommission?.retryScheduleId;
    if (id) {
      await this.cancelDecommissionRetry(id);
    }
    if (this.currentLifecycle().status === "decommissioning") {
      await this.decommission();
    }
  }

  async decommission(): Promise<void> {
    const lifecycle = this.currentLifecycle();
    if (lifecycle.status === "decommissioned") {
      return;
    }
    const { definition } = this.state;
    if (!definition && !this.state.decommission) {
      this.setState({
        ...this.initialState,
        lifecycle: {
          generation: lifecycle.generation,
          status: "decommissioned",
        },
      });
      return;
    }

    const generation =
      lifecycle.status === "decommissioning"
        ? lifecycle.generation
        : lifecycle.generation + 1;
    if (lifecycle.status !== "decommissioning") {
      this.setState({
        ...this.state,
        decommission: this.decommissionSaga(),
        lifecycle: { generation, status: "decommissioning" },
      });
    }
    await this.cancelDecommissionRetry();
    await this.cancelScheduledCleanup();

    const activeRunIds = this.state.runs
      .filter((record) => !isTerminal(record.run.status))
      .map((record) => record.run.id);
    const fiberKeys = new Set([
      WARM_FIBER_KEY,
      ...(this.state.warmFiberKey ? [this.state.warmFiberKey] : []),
      ...activeRunIds.map((runId) => cloudFiberKey(runId)),
      ...this.fiberCompletions.keys(),
    ]);
    const cancellationErrors: string[] = [];
    for (const fiberKey of fiberKeys) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: cancellation failures must be persisted before continuing.
        await this.cancelFiberByKey(
          fiberKey,
          fiberKey === WARM_FIBER_KEY
            ? "Agent decommissioned during warm-up."
            : "Agent decommissioned during run cleanup."
        );
      } catch (error) {
        cancellationErrors.push(
          error instanceof Error ? error.message : String(error)
        );
      }
    }
    if (cancellationErrors.length > 0) {
      const detail = cancellationErrors.join("; ");
      const saga = this.state.decommission;
      if (saga) {
        this.setState({
          ...this.state,
          decommission: { ...saga, lastError: detail },
        });
      }
      await this.scheduleDecommissionRetry();
      throw new AgentDecommissioningError(
        `Agent fiber cancellation is still pending. ${detail}`
      );
    }
    while (this.fiberCompletions.size > 0) {
      // biome-ignore lint/performance/noAwaitInLoops: wait for every late fiber before resetting durable state.
      await Promise.allSettled([...this.fiberCompletions.values()]);
    }

    for (const runId of activeRunIds) {
      const current = this.state.runs.find(
        (candidate) => candidate.run.id === runId
      );
      if (!current || isTerminal(current.run.status)) {
        continue;
      }
      const cancelled = finishCloudRunRecord(current, {
        completedAt: new Date().toISOString(),
        credential: null,
        output: "Run cancelled because the agent was decommissioned.",
        status: "cancelled",
      });
      this.persistRun(cancelled, { dispatchClaim: null });
    }

    const releaseRunIds = Object.keys(
      this.state.decommission?.admissionReleases ?? {}
    );
    for (const runId of releaseRunIds) {
      // biome-ignore lint/performance/noAwaitInLoops: releases are coordinated per run.
      const released = await this.reportAdmissionTerminal(runId);
      if (!released) {
        await this.scheduleDecommissionRetry();
        throw new AgentDecommissioningError();
      }
    }

    const currentDefinition = this.state.definition;
    if (!currentDefinition) {
      await this.scheduleDecommissionRetry();
      throw new AgentDecommissioningError();
    }
    if (!(await this.repairPendingSandboxCleanup(currentDefinition))) {
      await this.scheduleDecommissionRetry();
      throw new AgentDecommissioningError(
        "Agent sandbox cleanup is still pending. Try again later."
      );
    }
    const currentLifecycle = this.currentLifecycle();
    if (
      currentLifecycle.status !== "decommissioning" ||
      currentLifecycle.generation !== generation ||
      this.state.definition?.id !== currentDefinition.id
    ) {
      if (currentLifecycle.status === "decommissioned") {
        return;
      }
      await this.scheduleDecommissionRetry();
      throw new AgentDecommissioningError();
    }
    const current = this.state.sandbox;
    const ownership = current?.owner
      ? {
          dispatchToken: current.dispatchToken,
          generation: current.generation,
          owner: current.owner,
          runId: current.runId,
        }
      : this.tryAcquireSandboxOwnership(
          undefined,
          undefined,
          () =>
            this.currentLifecycle().status === "decommissioning" &&
            this.currentLifecycle().generation === generation &&
            this.state.definition?.id === currentDefinition.id &&
            !this.state.sandbox?.owner &&
            !this.state.sandbox?.cleanup
        );
    if (!ownership) {
      await this.scheduleDecommissionRetry();
      throw new AgentDecommissioningError();
    }
    if (
      !(await this.cleanupOwnedSandbox(
        currentDefinition,
        ownership,
        "failed",
        "The agent sandbox was destroyed during decommission."
      ))
    ) {
      await this.scheduleDecommissionRetry();
      throw new AgentDecommissioningError(
        "Agent sandbox cleanup is still pending. Try again later."
      );
    }
    await this.cancelDecommissionRetry();
    this.setState({
      ...this.initialState,
      lifecycle: { generation, status: "decommissioned" },
    });
  }

  private updateDefinition(
    patch: Partial<
      Pick<AgentDefinition, "status" | "updatedAt" | "lastRunAt" | "warm">
    >
  ): AgentDefinition {
    const current = this.state.definition;
    if (!current) {
      throw new Error("Agent has not been configured.");
    }
    const definition = { ...current, ...patch };
    this.setState({ ...this.state, definition });
    return definition;
  }

  /**
   * Writes one run record, replacing any earlier revision of the same run so a
   * queued entry is superseded rather than duplicated as it progresses.
   *
   * Retention is delegated to `retainCloudRuns`, which keeps every active run
   * and only trims terminal ones. The previous `slice(0, 20)` counted from the
   * front of an unsorted list, so a long-running agent could have dropped a run
   * that was still executing.
   */
  private persistRun(
    record: CloudRunRecord,
    options: {
      admissionFence?: AdmissionFence;
      allowDispatchTokenReplacement?: boolean;
      dispatchClaim?: string | null;
    } = {}
  ): boolean {
    const current = this.state.runs.find(
      (candidate) => candidate.run.id === record.run.id
    );
    if (
      current &&
      current.dispatchToken !== record.dispatchToken &&
      !options.allowDispatchTokenReplacement
    ) {
      return false;
    }
    if (
      current &&
      (isTerminal(current.run.status) ||
        (current.run.status === "running" && record.run.status === "queued"))
    ) {
      return false;
    }
    const others = this.state.runs.filter(
      (candidate) => candidate.run.id !== record.run.id
    );
    const admissionFences = {
      ...(this.state.admissionFences ?? {}),
      ...(options.admissionFence
        ? { [record.run.id]: options.admissionFence }
        : {}),
    };
    const dispatchClaims = { ...(this.state.dispatchClaims ?? {}) };
    if (options.dispatchClaim === null) {
      delete dispatchClaims[record.run.id];
    } else if (options.dispatchClaim) {
      dispatchClaims[record.run.id] = options.dispatchClaim;
    }
    const runs =
      this.currentLifecycle().status === "decommissioning"
        ? [record, ...others]
        : retainCloudRuns([record, ...others]);
    const retainedRunIds = new Set(runs.map((candidate) => candidate.run.id));
    this.setState({
      ...this.state,
      admissionFences: Object.fromEntries(
        Object.entries(admissionFences).filter(([runId]) =>
          retainedRunIds.has(runId)
        )
      ),
      admissionTokens: Object.fromEntries(
        Object.entries(this.state.admissionTokens ?? {}).filter(([runId]) =>
          retainedRunIds.has(runId)
        )
      ),
      dispatchClaims: Object.fromEntries(
        Object.entries(dispatchClaims).filter(([runId]) =>
          retainedRunIds.has(runId)
        )
      ),
      identityCapabilities: Object.fromEntries(
        Object.entries(this.state.identityCapabilities ?? {}).filter(
          ([runId]) => retainedRunIds.has(runId)
        )
      ),
      identityTokens: Object.fromEntries(
        Object.entries(this.state.identityTokens ?? {}).filter(([runId]) =>
          retainedRunIds.has(runId)
        )
      ),
      runs,
    });
    return true;
  }

  private dispatchTokenMatches(
    runId: string,
    dispatchToken: string | undefined
  ): boolean {
    if (!dispatchToken) {
      return true;
    }
    const record = this.state.runs.find(
      (candidate) => candidate.run.id === runId
    );
    return (
      record?.dispatchToken === dispatchToken ||
      (!record?.dispatchToken &&
        this.state.admissionTokens?.[runId] === dispatchToken)
    );
  }

  private async reportAdmissionTerminal(
    runId: string,
    dispatchToken?: string
  ): Promise<boolean> {
    const intent = this.state.decommission?.admissionReleases[runId];
    const record = this.state.runs.find(
      (candidate) => candidate.run.id === runId
    );
    if ((!record || !isTerminal(record.run.status)) && !intent) {
      return true;
    }
    if (this.admissionReleaseCompleted.has(runId)) {
      return true;
    }
    const inFlight = this.admissionReleaseInFlight.get(runId);
    if (inFlight) {
      return await inFlight;
    }
    const currentDispatchToken =
      record?.dispatchToken ??
      this.state.admissionTokens?.[runId] ??
      intent?.dispatchToken;
    const token = dispatchToken ?? currentDispatchToken;
    if (currentDispatchToken && currentDispatchToken !== token) {
      return false;
    }
    const identityTokens = Object.fromEntries(
      Object.entries(this.state.identityTokens ?? {}).filter(
        ([candidate]) => candidate !== runId
      )
    );
    const identityCapabilities = Object.fromEntries(
      Object.entries(this.state.identityCapabilities ?? {}).filter(
        ([candidate]) => candidate !== runId
      )
    );
    this.setState({ ...this.state, identityCapabilities, identityTokens });
    await this.markDirectoryRunStatus(runId, "terminal");
    const release = (async () => {
      let confirmed = false;
      try {
        const runAdmission = (
          this.env as unknown as {
            RunAdmission?: {
              getByName: (name: string) => {
                getRecord?: (admissionRunId: string) => Promise<{
                  state: "queued" | "active" | "terminal";
                } | null>;
                release: (
                  admissionRunId: string,
                  admissionToken?: string
                ) => Promise<boolean>;
              };
            };
          }
        ).RunAdmission;
        if (!runAdmission) {
          return true;
        }
        const admission = runAdmission.getByName("deployment");
        const released = await admission.release(runId, token);
        confirmed = released || !token;
        if (!confirmed && admission.getRecord) {
          const currentAdmission = await admission.getRecord(runId);
          confirmed =
            !currentAdmission || currentAdmission.state === "terminal";
        }
        if (confirmed) {
          this.admissionReleaseCompleted.add(runId);
          const retainedRunIds = new Set(
            this.state.runs.map((candidate) => candidate.run.id)
          );
          for (const completedRunId of this.admissionReleaseCompleted) {
            if (!retainedRunIds.has(completedRunId)) {
              this.admissionReleaseCompleted.delete(completedRunId);
            }
          }
          this.setState({
            ...this.state,
            admissionTokens: Object.fromEntries(
              Object.entries(this.state.admissionTokens ?? {}).filter(
                ([candidate]) => candidate !== runId
              )
            ),
          });
          const saga = this.state.decommission;
          if (saga?.admissionReleases[runId]) {
            const { [runId]: _released, ...remaining } = saga.admissionReleases;
            this.setState({
              ...this.state,
              decommission: {
                ...saga,
                admissionReleases: remaining,
              },
            });
          }
        }
      } catch {
        // The admission alarm reconciles an active record if this callback fails.
      } finally {
        this.admissionReleaseInFlight.delete(runId);
      }
      return confirmed;
    })();
    this.admissionReleaseInFlight.set(runId, release);
    return await release;
  }
}
