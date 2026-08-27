import {
  AGENT_RUNNER_API_VERSION,
  AGENT_RUNNER_LIMITS,
  type AgentDefinition,
  type CommandEvidence,
  commandEvidenceSchema,
  type FileEvidence,
  fileEvidenceSchema,
  type RunError,
  type RunEvent,
  type RunSnapshot,
  runErrorSchema,
  runEventSchema,
  runSnapshotSchema,
  sanitizeEvidencePath,
  sanitizeEvidenceText,
} from "@opencoven/agent-contracts";
import type { RunEvent as HarnessStreamEvent } from "@opencoven/harness";
import { HttpError } from "./http.js";

export const MAX_COMMAND_RESULTS_PER_RUN =
  AGENT_RUNNER_LIMITS.maxCommandResults;
export const MAX_FILE_OPERATIONS_PER_RUN =
  AGENT_RUNNER_LIMITS.maxFileOperations;
export const MAX_EVENTS_PER_RUN =
  MAX_COMMAND_RESULTS_PER_RUN + MAX_FILE_OPERATIONS_PER_RUN + 4;
export const MAX_CAPTURED_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_TERMINAL_RUNS_PER_AGENT = 20;

const OUTPUT_TRUNCATED = "\n[output truncated by runner]";

export type AdmissionCleanupCapability = {
  admissionSequence: number;
  agentId: string;
  dispatchToken?: string;
  operationId: string;
  requestHash: string;
  runId: string;
};

export type AdmissionCleanupGuard = AdmissionCleanupCapability & {
  queuedOnly?: boolean;
};

export type PreparedAdmissionConfirmationOutcome =
  | { kind: "confirmed" }
  | { kind: "stale" }
  | { kind: "terminal" };

export type AdmissionConfirmationOutcome =
  | { kind: "confirmed" }
  | {
      admissionCapability?: AdmissionCleanupCapability;
      kind: "stale_provisional";
      prepareOwner?: string;
    }
  | { kind: "lifecycle_pending" }
  | { kind: "nonterminal" }
  | { kind: "terminal" }
  | {
      admissionCapability?: AdmissionCleanupCapability;
      kind: "expired";
      prepareOwner?: string;
    };

export type AdmissionDispatchIntent = {
  admissionSequence?: number;
  fiberKey: string;
  phase: "starting" | "fiber_started";
  dispatchToken?: string;
};

export type CloudRunRecord = {
  /**
   * Admission's fencing token is internal coordination state. It is kept
   * beside the run so recovered fibers and late callbacks can prove which
   * dispatch they belong to without exposing it in the public snapshot.
   */
  dispatchToken?: string;
  events: RunEvent[];
  operationHash: string;
  admissionConfirmedAt?: string;
  admissionCapability?: AdmissionCleanupCapability;
  pendingAdmission?: {
    admissionCapability?: AdmissionCleanupCapability;
    deadlineAt: number;
    expiryClaim?: string;
    prepareOwner?: string;
    scheduleGeneration?: number;
    scheduleId?: string;
    scheduleToken?: string;
  };
  run: RunSnapshot;
};

export type CloudRunStartPlan =
  | {
      fiberKey: string;
      kind: "created";
      record: CloudRunRecord;
    }
  | {
      fiberKey: string;
      kind: "existing";
      record: CloudRunRecord;
    }
  | {
      kind: "already_running";
      record: CloudRunRecord;
    }
  | {
      kind: "conflict";
      record: CloudRunRecord;
    };

type EvidenceNormalization<T> = {
  diagnostics: string[];
  evidence: T[];
};

export type NormalizedCloudCommandEvidence =
  EvidenceNormalization<CommandEvidence> & {
    outputExceeded: boolean;
  };

export type NormalizedCloudFileEvidence = EvidenceNormalization<FileEvidence>;

export class OperationConflictError extends Error {
  constructor() {
    super("Operation ID was already used for a different request.");
    this.name = "OperationConflictError";
  }
}

export class AlreadyRunningError extends Error {
  constructor(cause?: unknown) {
    super(
      "An agent already has an active run.",
      cause === undefined ? undefined : { cause }
    );
    this.name = "AlreadyRunningError";
  }
}

export class AgentBusyError extends AlreadyRunningError {
  readonly code = "agent_busy";
  readonly provenNotStarted = true;

  constructor(cause?: unknown) {
    super(cause);
    this.name = "AgentBusyError";
  }
}

export class InvalidWorkspaceError extends HttpError {
  readonly provenNotStarted = true;

  constructor() {
    super(
      "Cloud agents may only use the /workspace scratch sandbox.",
      400,
      "invalid_workspace"
    );
    this.name = "HttpError";
  }
}

export class DispatchRejectedError extends Error {
  readonly code = "dispatch_rejected";
  readonly provenNotStarted = true;

  constructor(cause?: unknown) {
    super("Cloud run dispatch was rejected.", {
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = "DispatchRejectedError";
  }
}

export function isDispatchRejectedError(error: unknown): boolean {
  if (error instanceof DispatchRejectedError) {
    return true;
  }
  if (error instanceof InvalidWorkspaceError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const candidate = error as Error & {
    code?: unknown;
    provenNotStarted?: unknown;
  };
  return (
    candidate.provenNotStarted === true &&
    (error.name === "DispatchRejectedError" ||
      error.name === "InvalidWorkspaceError" ||
      candidate.code === "invalid_workspace")
  );
}

export class AgentDecommissioningError extends Error {
  readonly code = "agent_decommissioning";
  readonly retryable = true;

  constructor(
    message = "Agent decommission is still in progress. Try again later."
  ) {
    super(message);
    this.name = "AgentDecommissioningError";
  }
}

export function isAgentBusyError(error: unknown): boolean {
  if (error instanceof AgentBusyError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "AgentBusyError") {
    return true;
  }
  return (
    error.name === "AlreadyRunningError" &&
    (error as Error & { code?: unknown }).code === "agent_busy"
  );
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function characterByteLength(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint <= 0x7f) {
    return 1;
  }
  if (codePoint <= 0x7_ff) {
    return 2;
  }
  if (codePoint <= 0xff_ff) {
    return 3;
  }
  return 4;
}

function isOversized(value: string, maxLength: number): boolean {
  return value.length > maxLength || byteLength(value) > maxLength;
}

function truncateUtf8(
  value: string,
  maxLength: number,
  maxBytes: number,
  suffix = OUTPUT_TRUNCATED
): string {
  if (value.length <= maxLength && byteLength(value) <= maxBytes) {
    return value;
  }
  const safeSuffix =
    suffix.length <= maxLength && byteLength(suffix) <= maxBytes ? suffix : "";
  const allowedLength = maxLength - safeSuffix.length;
  const allowedBytes = maxBytes - byteLength(safeSuffix);
  let result = "";
  let resultBytes = 0;
  for (const character of value) {
    const characterBytes = characterByteLength(character);
    if (
      result.length + character.length > allowedLength ||
      resultBytes + characterBytes > allowedBytes
    ) {
      break;
    }
    result += character;
    resultBytes += characterBytes;
  }
  return `${result}${safeSuffix}`;
}

function boundedDiagnostic(message: string): string {
  return truncateUtf8(
    message,
    AGENT_RUNNER_LIMITS.maxDetailsLength,
    AGENT_RUNNER_LIMITS.maxDetailsLength,
    ""
  );
}

function normalizeTimestamp(
  value: unknown,
  diagnostics: string[]
): string | undefined {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "number" && typeof value !== "string") {
    diagnostics.push(
      boundedDiagnostic("Cloud runner omitted an invalid evidence timestamp.")
    );
    return;
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf())) {
    diagnostics.push(
      boundedDiagnostic("Cloud runner omitted an invalid evidence timestamp.")
    );
    return;
  }
  return timestamp.toISOString();
}

/**
 * The single place that turns a borrowed tenant credential into the
 * `additionalSecrets` shape `sanitizeEvidenceText` expects. Every redaction
 * call site in this file routes through here rather than writing its own
 * `credential ? [credential] : []`, so there is exactly one place that could
 * get that check wrong.
 */
function credentialSecrets(credential: string | null): Iterable<string> {
  return credential ? [credential] : [];
}

function normalizedText(
  value: unknown,
  field: "stderr" | "stdout",
  diagnostics: string[],
  credential: string | null
): string {
  if (typeof value !== "string") {
    diagnostics.push(
      boundedDiagnostic(`Cloud runner omitted malformed command ${field}.`)
    );
    return "";
  }
  if (isOversized(value, AGENT_RUNNER_LIMITS.maxEventOutputLength)) {
    diagnostics.push(
      boundedDiagnostic(`Cloud runner truncated oversized command ${field}.`)
    );
  }
  return truncateUtf8(
    sanitizeEvidenceText(value, credentialSecrets(credential)),
    AGENT_RUNNER_LIMITS.maxEventOutputLength,
    AGENT_RUNNER_LIMITS.maxEventOutputLength
  );
}

function fitCapturedOutput(
  value: string,
  remainingBytes: number
): { output: string; remainingBytes: number; truncated: boolean } {
  if (byteLength(value) <= remainingBytes) {
    return {
      output: value,
      remainingBytes: remainingBytes - byteLength(value),
      truncated: false,
    };
  }
  const output = truncateUtf8(
    value,
    AGENT_RUNNER_LIMITS.maxEventOutputLength,
    remainingBytes
  );
  return {
    output,
    remainingBytes: Math.max(0, remainingBytes - byteLength(output)),
    truncated: true,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function commandResultsFromEvidence(evidence: unknown[]): unknown[] {
  return evidence.map((value) => {
    const candidate = asRecord(value);
    return candidate
      ? {
          ...candidate,
          timestamp: candidate.completedAt,
        }
      : value;
  });
}

function fileResultsFromEvidence(evidence: unknown[]): unknown[] {
  return evidence.map((value) => {
    const candidate = asRecord(value);
    return candidate
      ? {
          ...candidate,
          status: "completed",
          timestamp: candidate.occurredAt,
        }
      : value;
  });
}

export function validateCloudWorkspace(
  definition: Pick<AgentDefinition, "workspace">
): string {
  if (
    definition.workspace === undefined ||
    definition.workspace === "/workspace"
  ) {
    return "/workspace";
  }
  throw new InvalidWorkspaceError();
}

export function createQueuedRun(
  agentId: string,
  operationId: string,
  task: string,
  runId: string,
  createdAt: string
): CloudRunRecord {
  return {
    events: [
      {
        at: createdAt,
        id: 1,
        operationId,
        runId,
        type: "accepted",
      },
    ],
    operationHash: "",
    run: {
      agentId,
      apiVersion: AGENT_RUNNER_API_VERSION,
      commandEvidence: [],
      completedAt: null,
      createdAt,
      fileEvidence: [],
      id: runId,
      operationId,
      output: "",
      startedAt: null,
      status: "queued",
      task,
    },
  };
}

export function nextEventId(record: CloudRunRecord): number {
  return (record.events.at(-1)?.id ?? 0) + 1;
}

export function appendEvents(
  record: CloudRunRecord,
  events: RunEvent[]
): CloudRunRecord {
  return {
    ...record,
    events: [...record.events, ...events].slice(-MAX_EVENTS_PER_RUN),
  };
}

const LIVE_FILE_OPERATIONS: Record<string, FileEvidence["operation"]> = {
  created: "create",
  deleted: "delete",
  edited: "modify",
};

/**
 * Translates one streamed harness event into a contract run event, or null
 * for the kinds that are noise mid-run (token deltas, usage checkpoints).
 *
 * This is what makes a run legible while it happens: before it, nothing
 * reached the record between "running" and the outcome, and a healthy
 * fifteen-minute run was indistinguishable from a wedged one. Every string
 * passes through `safeRunText` — the same credential-aware redaction the
 * final evidence gets — BEFORE the event exists, so an unredacted string
 * cannot be persisted or streamed by construction.
 *
 * `toolNames` carries tool identity across the start/end pair: the harness
 * names the tool only on `tool-start`, and the caller owns the map so the
 * pairing survives however many events arrive in between.
 */
export function liveCloudRunEvent(
  event: HarnessStreamEvent,
  id: number,
  credential: string | null,
  toolNames: Map<string, string>
): RunEvent | null {
  switch (event.kind) {
    case "reasoning":
    case "message": {
      const output = safeRunText(event.text, credential);
      return output ? { at: event.at, id, output, type: "output" } : null;
    }
    case "tool-start": {
      toolNames.set(event.callId, event.tool);
      const detail = event.summary ? ` · ${event.summary}` : "";
      return {
        at: event.at,
        id,
        output: safeRunText(`→ ${event.tool}${detail}`, credential),
        type: "output",
      };
    }
    case "tool-end":
      return {
        at: event.at,
        evidence: {
          command: truncateUtf8(
            safeRunText(toolNames.get(event.callId) ?? "tool", credential),
            AGENT_RUNNER_LIMITS.maxCommandLength,
            AGENT_RUNNER_LIMITS.maxCommandLength
          ),
          exitCode: event.success ? 0 : 1,
          stderr: "",
          stdout: safeRunText(event.summary, credential),
        },
        id,
        type: "command",
      };
    case "file": {
      const operation = LIVE_FILE_OPERATIONS[event.operation];
      if (!operation) {
        return null;
      }
      return {
        at: event.at,
        evidence: {
          operation,
          path: truncateUtf8(
            sanitizeEvidencePath(event.path),
            AGENT_RUNNER_LIMITS.maxPathLength,
            AGENT_RUNNER_LIMITS.maxPathLength
          ),
        },
        id,
        type: "file",
      };
    }
    default:
      return null;
  }
}

export function safeRunText(value: string, credential: string | null): string {
  return truncateUtf8(
    sanitizeEvidenceText(value, credentialSecrets(credential)),
    AGENT_RUNNER_LIMITS.maxEventOutputLength,
    AGENT_RUNNER_LIMITS.maxEventOutputLength
  );
}

export function normalizeCloudCommandEvidence(
  results: unknown[],
  credential: string | null
): NormalizedCloudCommandEvidence {
  const diagnostics: string[] = [];
  const evidence: CommandEvidence[] = [];
  let remainingBytes = MAX_CAPTURED_OUTPUT_BYTES;
  let outputExceeded = false;

  for (const result of results.slice(-MAX_COMMAND_RESULTS_PER_RUN)) {
    const candidate = asRecord(result);
    if (!candidate || typeof candidate.command !== "string") {
      diagnostics.push(
        boundedDiagnostic("Cloud runner omitted malformed command evidence.")
      );
      continue;
    }
    const command = candidate.command.trim();
    if (!command) {
      diagnostics.push(
        boundedDiagnostic("Cloud runner omitted a command without text.")
      );
      continue;
    }
    if (isOversized(command, AGENT_RUNNER_LIMITS.maxCommandLength)) {
      diagnostics.push(
        boundedDiagnostic("Cloud runner truncated an oversized command.")
      );
    }
    const stdout = fitCapturedOutput(
      normalizedText(candidate.stdout, "stdout", diagnostics, credential),
      remainingBytes
    );
    ({ remainingBytes } = stdout);
    const stderr = fitCapturedOutput(
      normalizedText(candidate.stderr, "stderr", diagnostics, credential),
      remainingBytes
    );
    ({ remainingBytes } = stderr);
    outputExceeded ||= stdout.truncated || stderr.truncated;

    let exitCode: number | null = null;
    const { exitCode: candidateExitCode } = candidate;
    if (candidateExitCode !== null && candidateExitCode !== undefined) {
      if (
        typeof candidateExitCode === "number" &&
        Number.isInteger(candidateExitCode)
      ) {
        exitCode = candidateExitCode;
      } else {
        diagnostics.push(
          boundedDiagnostic(
            "Cloud runner omitted an invalid command exit code."
          )
        );
      }
    }
    const completedAt = normalizeTimestamp(candidate.timestamp, diagnostics);
    const parsed = commandEvidenceSchema.safeParse({
      command: truncateUtf8(
        sanitizeEvidenceText(command, credentialSecrets(credential)),
        AGENT_RUNNER_LIMITS.maxCommandLength,
        AGENT_RUNNER_LIMITS.maxCommandLength,
        "\n[command truncated by runner]"
      ),
      ...(completedAt ? { completedAt } : {}),
      exitCode,
      stderr: stderr.output,
      stdout: stdout.output,
    });
    if (parsed.success) {
      evidence.push(parsed.data);
    } else {
      diagnostics.push(
        boundedDiagnostic(
          "Cloud runner omitted invalid normalized command evidence."
        )
      );
    }
  }

  return { diagnostics, evidence, outputExceeded };
}

export function normalizeCloudFileEvidence(
  results: unknown[]
): NormalizedCloudFileEvidence {
  const diagnostics: string[] = [];
  const evidence: FileEvidence[] = [];

  for (const result of results.slice(-MAX_FILE_OPERATIONS_PER_RUN)) {
    const candidate = asRecord(result);
    if (candidate?.status !== "completed") {
      continue;
    }
    const operation =
      candidate.operation === "update" ? "modify" : candidate.operation;
    if (
      operation !== "create" &&
      operation !== "modify" &&
      operation !== "delete"
    ) {
      diagnostics.push(
        boundedDiagnostic(
          "Cloud runner omitted a file operation with an unsafe operation."
        )
      );
      continue;
    }
    if (typeof candidate.path !== "string" || !candidate.path.trim()) {
      diagnostics.push(
        boundedDiagnostic(
          "Cloud runner omitted a file operation without a path."
        )
      );
      continue;
    }
    if (isOversized(candidate.path, AGENT_RUNNER_LIMITS.maxPathLength)) {
      diagnostics.push(
        boundedDiagnostic("Cloud runner truncated an oversized file path.")
      );
    }
    const occurredAt = normalizeTimestamp(candidate.timestamp, diagnostics);
    const byteLengthValue =
      typeof candidate.byteLength === "number" &&
      Number.isInteger(candidate.byteLength) &&
      candidate.byteLength >= 0
        ? candidate.byteLength
        : undefined;
    if (candidate.byteLength !== undefined && byteLengthValue === undefined) {
      diagnostics.push(
        boundedDiagnostic("Cloud runner omitted an invalid file byte length.")
      );
    }
    const parsed = fileEvidenceSchema.safeParse({
      ...(byteLengthValue === undefined ? {} : { byteLength: byteLengthValue }),
      ...(occurredAt ? { occurredAt } : {}),
      operation,
      path: truncateUtf8(
        sanitizeEvidencePath(candidate.path.trim()),
        AGENT_RUNNER_LIMITS.maxPathLength,
        AGENT_RUNNER_LIMITS.maxPathLength,
        "\n[path truncated by runner]"
      ),
    });
    if (parsed.success) {
      evidence.push(parsed.data);
    } else {
      diagnostics.push(
        boundedDiagnostic(
          "Cloud runner omitted invalid normalized file evidence."
        )
      );
    }
  }

  return { diagnostics, evidence };
}

export async function hashOperation(
  agentId: string,
  task: string
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({ agentId, task }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function isTerminal(status: RunSnapshot["status"]): boolean {
  return status !== "queued" && status !== "running";
}

export function retainCloudRuns(records: CloudRunRecord[]): CloudRunRecord[] {
  const active = records.filter((record) => !isTerminal(record.run.status));
  const terminal = records
    .filter((record) => isTerminal(record.run.status))
    .sort(
      (left, right) =>
        Date.parse(right.run.completedAt ?? right.run.createdAt) -
        Date.parse(left.run.completedAt ?? left.run.createdAt)
    )
    .slice(0, MAX_TERMINAL_RUNS_PER_AGENT);
  return [...active, ...terminal];
}

export function cloudFiberKey(runId: string): string {
  return `run:${runId}`;
}

export function planCloudRunStart(
  input: {
    agentId: string;
    createdAt: string;
    operationHash: string;
    operationId: string;
    records: CloudRunRecord[];
    runId: string;
    task: string;
  },
  options: { allowQueued?: boolean } = {}
): CloudRunStartPlan {
  const existing = input.records.find(
    (candidate) => candidate.run.operationId === input.operationId
  );
  if (existing) {
    if (existing.operationHash !== input.operationHash) {
      return { kind: "conflict", record: existing };
    }
    return {
      fiberKey: cloudFiberKey(existing.run.id),
      kind: "existing",
      record: existing,
    };
  }
  const active = input.records.find((candidate) =>
    options.allowQueued ? false : !isTerminal(candidate.run.status)
  );
  if (active) {
    return { kind: "already_running", record: active };
  }
  const record = {
    ...createQueuedRun(
      input.agentId,
      input.operationId,
      input.task,
      input.runId,
      input.createdAt
    ),
    operationHash: input.operationHash,
  };
  return {
    fiberKey: cloudFiberKey(record.run.id),
    kind: "created",
    record,
  };
}

export async function dispatchCloudRun(
  plan: Exclude<CloudRunStartPlan, { kind: "already_running" | "conflict" }>,
  dispatch?: (
    record: CloudRunRecord,
    fiberKey: string
  ) => Promise<{ accepted: boolean }>
): Promise<{ created: boolean; run: RunSnapshot }> {
  if (plan.kind === "existing") {
    return { created: false, run: plan.record.run };
  }
  if (!dispatch) {
    throw new Error("A new cloud run requires fiber dispatch.");
  }
  const receipt = await dispatch(plan.record, plan.fiberKey);
  return { created: receipt.accepted, run: plan.record.run };
}

export function finishCloudRunRecord(
  record: CloudRunRecord,
  result: {
    commandEvidence?: CommandEvidence[];
    completedAt: string;
    /**
     * The tenant credential borrowed for this run, or `null` if none was
     * resolved (the run failed before resolution, or this is an
     * interruption recovery with no credential in scope). Required rather
     * than optional: every call site has to make an explicit decision about
     * what the run's credential was, so a call site cannot silently disable
     * redaction by forgetting the argument. Threaded into every evidence
     * normalization below so a token echoed to stdout, stderr, or a command
     * line is redacted the same way regardless of which stream carried it.
     */
    credential: string | null;
    error?: RunError;
    fileEvidence?: FileEvidence[];
    output: string;
    status: Extract<
      RunSnapshot["status"],
      "cancelled" | "completed" | "failed"
    >;
  }
): CloudRunRecord {
  if (isTerminal(record.run.status)) {
    return record;
  }
  const commandResults = commandResultsFromEvidence(
    result.commandEvidence ?? record.run.commandEvidence
  );
  const fileResults = fileResultsFromEvidence(
    result.fileEvidence ?? record.run.fileEvidence
  );
  const normalizedCommands = normalizeCloudCommandEvidence(
    commandResults,
    result.credential
  );
  const normalizedFiles = normalizeCloudFileEvidence(fileResults);
  const commandEvidence = normalizedCommands.evidence.map((evidence) =>
    commandEvidenceSchema.parse(evidence)
  );
  const fileEvidence = normalizedFiles.evidence.map((evidence) =>
    fileEvidenceSchema.parse(evidence)
  );
  const diagnostics = [
    ...normalizedCommands.diagnostics,
    ...normalizedFiles.diagnostics,
  ];
  const run = runSnapshotSchema.parse({
    ...record.run,
    commandEvidence,
    completedAt: result.completedAt,
    error: result.error ? runErrorSchema.parse(result.error) : null,
    fileEvidence,
    output: safeRunText(
      diagnostics.length > 0
        ? `${result.output}\n${diagnostics.join("\n")}`
        : result.output,
      result.credential
    ),
    status: result.status,
  });
  const events: RunEvent[] = [];
  let eventId = nextEventId(record);
  const takeEventId = (): number => {
    const id = eventId;
    eventId += 1;
    return id;
  };
  for (const evidence of run.commandEvidence) {
    events.push(
      runEventSchema.parse({
        at: result.completedAt,
        evidence,
        id: takeEventId(),
        type: "command",
      })
    );
  }
  for (const evidence of run.fileEvidence) {
    events.push(
      runEventSchema.parse({
        at: result.completedAt,
        evidence,
        id: takeEventId(),
        type: "file",
      })
    );
  }
  if (run.output) {
    events.push(
      runEventSchema.parse({
        at: result.completedAt,
        id: takeEventId(),
        output: run.output,
        type: "output",
      })
    );
  }
  events.push(
    runEventSchema.parse({
      at: result.completedAt,
      id: takeEventId(),
      status: result.status,
      type: "status",
    })
  );
  if (result.status === "completed") {
    events.push(
      runEventSchema.parse({
        at: result.completedAt,
        id: takeEventId(),
        run,
        type: "completed",
      })
    );
  }
  if (result.status === "failed" && result.error) {
    events.push(
      runEventSchema.parse({
        at: result.completedAt,
        error: runErrorSchema.parse(result.error),
        id: takeEventId(),
        type: "failed",
      })
    );
  }
  return appendEvents({ ...record, run }, events);
}

export function recoverCloudRunRecord(
  record: CloudRunRecord,
  completedAt: string
): CloudRunRecord {
  return finishCloudRunRecord(record, {
    completedAt,
    // Recovery runs after a durable interruption, with no credential in
    // scope to have leaked here in the first place.
    credential: null,
    error: {
      code: "interrupted",
      message: "Cloud run was interrupted before completion.",
      retryable: true,
    },
    output: "Cloud durable execution was interrupted.",
    status: "failed",
  });
}

export async function destroyCloudAgentSandbox(
  definition: Pick<AgentDefinition, "id"> | null,
  destroy: (name: string) => Promise<void>
): Promise<void> {
  if (definition) {
    await destroy(`agent-${definition.id}`);
  }
}
