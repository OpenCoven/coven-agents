import "server-only";

import { createHash } from "node:crypto";
import {
  AGENT_RUNNER_API_VERSION,
  AGENT_RUNNER_LIMITS,
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
import type { RunEvent as HarnessRunEvent } from "@opencoven/harness";

export const MAX_COMMAND_RESULTS_PER_RUN =
  AGENT_RUNNER_LIMITS.maxCommandResults;
export const MAX_FILE_OPERATIONS_PER_RUN =
  AGENT_RUNNER_LIMITS.maxFileOperations;
export const MAX_EVENTS_PER_RUN =
  MAX_COMMAND_RESULTS_PER_RUN + MAX_FILE_OPERATIONS_PER_RUN + 4;
export const MAX_CAPTURED_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_TERMINAL_RUNS_PER_AGENT = 20;

const OUTPUT_TRUNCATED = "\n[output truncated by runner]";
const COMMAND_TRUNCATED = "\n[command truncated by runner]";
const PATH_TRUNCATED = "\n[path truncated by runner]";

type EvidenceNormalization<T> = {
  diagnostics: string[];
  evidence: T[];
};

export type NormalizedCommandEvidence =
  EvidenceNormalization<CommandEvidence> & {
    outputExceeded: boolean;
  };

export type NormalizedFileEvidence = EvidenceNormalization<FileEvidence>;

export type QueuedRunInput = {
  agentId: string;
  createdAt: string;
  operationId: string;
  runId: string;
  task: string;
};

export type TerminalRunResult = {
  commandEvidence?: readonly unknown[];
  completedAt: string;
  credential: string | null;
  error?: RunError | null;
  fileEvidence?: readonly unknown[];
  output: string;
  status: Extract<RunSnapshot["status"], "cancelled" | "completed" | "failed">;
};

export type TerminalRunProjection = {
  events: RunEvent[];
  run: RunSnapshot;
};

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

/**
 * Bounds a string by both the contract's UTF-16 length limit and its UTF-8
 * byte budget, never splitting a Unicode code point.
 */
export function truncateUtf8(
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

function credentialSecrets(credential: string | null): Iterable<string> {
  return credential ? [credential] : [];
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
      boundedDiagnostic("Runner omitted an invalid evidence timestamp.")
    );
    return;
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf())) {
    diagnostics.push(
      boundedDiagnostic("Runner omitted an invalid evidence timestamp.")
    );
    return;
  }
  return timestamp.toISOString();
}

function normalizedText(
  value: unknown,
  field: "stderr" | "stdout",
  diagnostics: string[],
  credential: string | null
): string {
  if (typeof value !== "string") {
    diagnostics.push(
      boundedDiagnostic(`Runner omitted malformed command ${field}.`)
    );
    return "";
  }
  if (isOversized(value, AGENT_RUNNER_LIMITS.maxEventOutputLength)) {
    diagnostics.push(
      boundedDiagnostic(`Runner truncated oversized command ${field}.`)
    );
  }
  return sanitizeRunText(value, credential);
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

function commandResultsFromEvidence(evidence: readonly unknown[]): unknown[] {
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

function fileResultsFromEvidence(evidence: readonly unknown[]): unknown[] {
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

function normalizeRunError(
  error: RunError,
  credential: string | null
): RunError {
  return runErrorSchema.parse({
    code: truncateUtf8(
      sanitizeEvidenceText(error.code, credentialSecrets(credential)),
      64,
      64,
      ""
    ),
    ...(error.details
      ? {
          details: truncateUtf8(
            sanitizeEvidenceText(error.details, credentialSecrets(credential)),
            AGENT_RUNNER_LIMITS.maxDetailsLength,
            AGENT_RUNNER_LIMITS.maxDetailsLength,
            ""
          ),
        }
      : {}),
    message: truncateUtf8(
      sanitizeEvidenceText(error.message, credentialSecrets(credential)),
      AGENT_RUNNER_LIMITS.maxMessageLength,
      AGENT_RUNNER_LIMITS.maxMessageLength,
      ""
    ),
    retryable: error.retryable,
  });
}

const LIVE_FILE_OPERATIONS: Record<string, FileEvidence["operation"]> = {
  created: "create",
  deleted: "delete",
  edited: "modify",
};

export function createQueuedRunSnapshot(input: QueuedRunInput): RunSnapshot {
  return runSnapshotSchema.parse({
    agentId: input.agentId,
    apiVersion: AGENT_RUNNER_API_VERSION,
    commandEvidence: [],
    completedAt: null,
    createdAt: input.createdAt,
    fileEvidence: [],
    id: input.runId,
    operationId: input.operationId,
    output: "",
    startedAt: null,
    status: "queued",
    task: input.task,
  });
}

export function createAcceptedRunEvent(
  snapshot: RunSnapshot,
  id = 1
): RunEvent {
  return runEventSchema.parse({
    at: snapshot.createdAt,
    id,
    operationId: snapshot.operationId,
    runId: snapshot.id,
    type: "accepted",
  });
}

/**
 * Computes the immutable request identity used to detect operation ID reuse.
 */
export function hashRunRequest(agentId: string, task: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ agentId, task }), "utf8")
    .digest("hex");
}

export function isTerminalRun(status: RunSnapshot["status"]): boolean {
  return status !== "queued" && status !== "running";
}

export function nextRunEventId(events: readonly RunEvent[]): number {
  return (events.at(-1)?.id ?? 0) + 1;
}

export function retainRunEvents(
  events: readonly RunEvent[],
  additions: readonly RunEvent[] = []
): RunEvent[] {
  return [...events, ...additions].slice(-MAX_EVENTS_PER_RUN);
}

export function retainRunSnapshots(
  snapshots: readonly RunSnapshot[]
): RunSnapshot[] {
  const active = snapshots.filter(
    (snapshot) => !isTerminalRun(snapshot.status)
  );
  const terminal = snapshots
    .filter((snapshot) => isTerminalRun(snapshot.status))
    .sort(
      (left, right) =>
        Date.parse(right.completedAt ?? right.createdAt) -
        Date.parse(left.completedAt ?? left.createdAt)
    )
    .slice(0, MAX_TERMINAL_RUNS_PER_AGENT);
  return [...active, ...terminal];
}

/**
 * Redacts known secret forms and the run credential before textual evidence is
 * retained or emitted, then applies the contract's output limit.
 */
export function sanitizeRunText(
  value: string,
  credential: string | null
): string {
  return truncateUtf8(
    sanitizeEvidenceText(value, credentialSecrets(credential)),
    AGENT_RUNNER_LIMITS.maxEventOutputLength,
    AGENT_RUNNER_LIMITS.maxEventOutputLength
  );
}

export function normalizeCommandEvidence(
  results: readonly unknown[],
  credential: string | null
): NormalizedCommandEvidence {
  const diagnostics: string[] = [];
  const evidence: CommandEvidence[] = [];
  let remainingBytes = MAX_CAPTURED_OUTPUT_BYTES;
  let outputExceeded = false;

  for (const result of results.slice(-MAX_COMMAND_RESULTS_PER_RUN)) {
    const candidate = asRecord(result);
    if (!candidate || typeof candidate.command !== "string") {
      diagnostics.push(
        boundedDiagnostic("Runner omitted malformed command evidence.")
      );
      continue;
    }
    const command = candidate.command.trim();
    if (!command) {
      diagnostics.push(
        boundedDiagnostic("Runner omitted a command without text.")
      );
      continue;
    }
    if (isOversized(command, AGENT_RUNNER_LIMITS.maxCommandLength)) {
      diagnostics.push(
        boundedDiagnostic("Runner truncated an oversized command.")
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
          boundedDiagnostic("Runner omitted an invalid command exit code.")
        );
      }
    }
    const completedAt = normalizeTimestamp(candidate.timestamp, diagnostics);
    const parsed = commandEvidenceSchema.safeParse({
      command: truncateUtf8(
        sanitizeEvidenceText(command, credentialSecrets(credential)),
        AGENT_RUNNER_LIMITS.maxCommandLength,
        AGENT_RUNNER_LIMITS.maxCommandLength,
        COMMAND_TRUNCATED
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
        boundedDiagnostic("Runner omitted invalid normalized command evidence.")
      );
    }
  }

  return { diagnostics, evidence, outputExceeded };
}

export function normalizeFileEvidence(
  results: readonly unknown[],
  credential: string | null
): NormalizedFileEvidence {
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
          "Runner omitted a file operation with an unsafe operation."
        )
      );
      continue;
    }
    if (typeof candidate.path !== "string" || !candidate.path.trim()) {
      diagnostics.push(
        boundedDiagnostic("Runner omitted a file operation without a path.")
      );
      continue;
    }
    if (isOversized(candidate.path, AGENT_RUNNER_LIMITS.maxPathLength)) {
      diagnostics.push(
        boundedDiagnostic("Runner truncated an oversized file path.")
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
        boundedDiagnostic("Runner omitted an invalid file byte length.")
      );
    }
    const path = sanitizeEvidenceText(
      sanitizeEvidencePath(candidate.path.trim()),
      credentialSecrets(credential)
    );
    const parsed = fileEvidenceSchema.safeParse({
      ...(byteLengthValue === undefined ? {} : { byteLength: byteLengthValue }),
      ...(occurredAt ? { occurredAt } : {}),
      operation,
      path: truncateUtf8(
        path,
        AGENT_RUNNER_LIMITS.maxPathLength,
        AGENT_RUNNER_LIMITS.maxPathLength,
        PATH_TRUNCATED
      ),
    });
    if (parsed.success) {
      evidence.push(parsed.data);
    } else {
      diagnostics.push(
        boundedDiagnostic("Runner omitted invalid normalized file evidence.")
      );
    }
  }

  return { diagnostics, evidence };
}

/**
 * Projects a normalized harness event into the Agent Runner v1 event contract.
 * The caller owns toolNames so a tool-start can be paired with its later end.
 */
export function projectHarnessRunEvent(
  event: HarnessRunEvent,
  id: number,
  credential: string | null,
  toolNames: Map<string, string>
): RunEvent | null {
  switch (event.kind) {
    case "reasoning":
    case "message": {
      const output = sanitizeRunText(event.text, credential);
      return output
        ? runEventSchema.parse({ at: event.at, id, output, type: "output" })
        : null;
    }
    case "tool-start": {
      toolNames.set(event.callId, event.tool);
      const detail = event.summary ? ` · ${event.summary}` : "";
      return runEventSchema.parse({
        at: event.at,
        id,
        output: sanitizeRunText(`→ ${event.tool}${detail}`, credential),
        type: "output",
      });
    }
    case "tool-end":
      return runEventSchema.parse({
        at: event.at,
        evidence: {
          command: truncateUtf8(
            sanitizeEvidenceText(
              toolNames.get(event.callId) ?? "tool",
              credentialSecrets(credential)
            ),
            AGENT_RUNNER_LIMITS.maxCommandLength,
            AGENT_RUNNER_LIMITS.maxCommandLength
          ),
          exitCode: event.success ? 0 : 1,
          stderr: "",
          stdout: sanitizeRunText(event.summary, credential),
        },
        id,
        type: "command",
      });
    case "file": {
      const operation = LIVE_FILE_OPERATIONS[event.operation];
      if (!operation) {
        return null;
      }
      return runEventSchema.parse({
        at: event.at,
        evidence: {
          operation,
          path: truncateUtf8(
            sanitizeEvidenceText(
              sanitizeEvidencePath(event.path),
              credentialSecrets(credential)
            ),
            AGENT_RUNNER_LIMITS.maxPathLength,
            AGENT_RUNNER_LIMITS.maxPathLength
          ),
        },
        id,
        type: "file",
      });
    }
    default:
      return null;
  }
}

export function projectTerminalRun(
  snapshot: RunSnapshot,
  result: TerminalRunResult,
  firstEventId: number
): TerminalRunProjection {
  if (isTerminalRun(snapshot.status)) {
    return { events: [], run: snapshot };
  }

  const normalizedCommands = normalizeCommandEvidence(
    commandResultsFromEvidence(
      result.commandEvidence ?? snapshot.commandEvidence
    ),
    result.credential
  );
  const normalizedFiles = normalizeFileEvidence(
    fileResultsFromEvidence(result.fileEvidence ?? snapshot.fileEvidence),
    result.credential
  );
  const diagnostics = [
    ...normalizedCommands.diagnostics,
    ...normalizedFiles.diagnostics,
  ];
  const error = result.error
    ? normalizeRunError(result.error, result.credential)
    : null;
  const run = runSnapshotSchema.parse({
    ...snapshot,
    commandEvidence: normalizedCommands.evidence,
    completedAt: result.completedAt,
    ...(error ? { error } : {}),
    fileEvidence: normalizedFiles.evidence,
    output: sanitizeRunText(
      diagnostics.length > 0
        ? `${result.output}\n${diagnostics.join("\n")}`
        : result.output,
      result.credential
    ),
    status: result.status,
  });

  const events: RunEvent[] = [];
  let eventId = firstEventId;
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
  if (result.status === "failed" && error) {
    events.push(
      runEventSchema.parse({
        at: result.completedAt,
        error,
        id: takeEventId(),
        type: "failed",
      })
    );
  }
  return { events, run };
}
