import "server-only";

import {
  sanitizeEvidencePath,
  sanitizeEvidenceText,
} from "@opencoven/agent-contracts";
import type {
  HarnessId,
  HarnessSpec,
  HarnessStatus,
  RunEvent,
} from "@opencoven/harness";
import {
  buildInvocation,
  HARNESS_SPECS,
  harnessAuthHint,
  harnessSpec,
  harnessStatus,
  isRunnableHarness,
  LineAssembler,
  normalizeEvent,
  toShellCommand,
} from "@opencoven/harness";

export type {
  HarnessId,
  HarnessSpec,
  HarnessStatus,
  RunEvent,
  RunSummary,
} from "@opencoven/harness";
export {
  HARNESS_SPECS,
  LineAssembler,
  shellQuote,
  summarizeRun,
  toShellCommand,
} from "@opencoven/harness";

const DEFAULT_WORKSPACE = "/workspace";
const MAX_MALFORMED_DIAGNOSTICS = 20;

export type HarnessCredential = Readonly<{ credential: string | null }>;

export class HarnessError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "HarnessError";
  }
}

/**
 * Resolves a user supplied workspace without allowing it to escape the
 * sandbox-owned workspace root. This is provider neutral by design.
 */
export function resolveSandboxWorkspace(requested?: string): string {
  const raw = (requested ?? "").trim();
  if (!raw) {
    return DEFAULT_WORKSPACE;
  }
  const base = raw.startsWith("/") ? raw : `${DEFAULT_WORKSPACE}/${raw}`;
  const parts: string[] = [];
  for (const segment of base.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  const resolved = `/${parts.join("/")}`;
  if (
    resolved !== DEFAULT_WORKSPACE &&
    !resolved.startsWith(`${DEFAULT_WORKSPACE}/`)
  ) {
    throw new HarnessError(
      `Workspace must stay inside ${DEFAULT_WORKSPACE}.`,
      "workspace_escape"
    );
  }
  return resolved;
}

/** Validates a runnable harness and binds it to only the caller's credential. */
export function requireHarness(
  runtime: string,
  supplied: HarnessCredential
): { auth: { name: string; value: string }; spec: HarnessSpec } {
  const spec = harnessSpec(runtime);
  if (!spec) {
    throw new HarnessError(`Unknown harness: ${runtime}`, "unknown_harness");
  }
  if (!isRunnableHarness(runtime)) {
    throw new HarnessError(
      `${spec.label} is not supported by the runner.`,
      "harness_unsupported"
    );
  }
  const [name] = spec.authEnvVars;
  const value = supplied.credential;
  if (!name || typeof value !== "string" || !value.trim()) {
    throw new HarnessError(harnessAuthHint(spec), "harness_unauthenticated");
  }
  return { auth: { name, value }, spec };
}

export function harnessesFromProbe(
  probe: (
    spec: HarnessSpec
  ) => Promise<{ installed: boolean; version: string | null }>
): Promise<HarnessStatus[]> {
  return Promise.all(
    HARNESS_SPECS.map(async (spec) => harnessStatus(spec, await probe(spec)))
  );
}

function redact(value: string, credential: string | null): string {
  return sanitizeEvidenceText(value, credential ? [credential] : []);
}

function sanitizeEvent(event: RunEvent, credential: string | null): RunEvent {
  switch (event.kind) {
    case "reasoning":
    case "delta":
      return { ...event, text: redact(event.text, credential) };
    case "message":
      return { ...event, text: redact(event.text, credential) };
    case "tool-start":
    case "tool-end":
      return { ...event, summary: redact(event.summary, credential) };
    case "file":
      return {
        ...event,
        path: redact(sanitizeEvidencePath(event.path), credential),
      };
    case "finished":
      return {
        ...event,
        filesModified: event.filesModified.map((path) =>
          redact(sanitizeEvidencePath(path), credential)
        ),
        sessionId: event.sessionId ? redact(event.sessionId, credential) : null,
      };
    case "error":
      return { ...event, message: redact(event.message, credential) };
    default:
      return event;
  }
}

export type HarnessLogParse = Readonly<{
  cursor: number;
  diagnostics: readonly RunEvent[];
  events: readonly RunEvent[];
}>;

/**
 * Parses the accumulated stdout returned by a provider without retaining it.
 * A live poll advances through complete newline-delimited frames only; a
 * terminal poll consumes its final unterminated JSON object as well.
 */
export function parseHarnessLog(
  harness: HarnessId,
  stdout: string,
  cursor: number,
  terminal: boolean,
  credential: string | null,
  fallbackAt: string
): HarnessLogParse {
  const safeCursor =
    Number.isSafeInteger(cursor) && cursor >= 0 && cursor <= stdout.length
      ? cursor
      : 0;
  const fresh = stdout.slice(safeCursor);
  const finalNewline = fresh.lastIndexOf("\n");
  const consumed = terminal
    ? fresh
    : finalNewline === -1
      ? ""
      : fresh.slice(0, finalNewline + 1);
  const nextCursor = safeCursor + consumed.length;
  const assembler = new LineAssembler();
  const lines = terminal
    ? [...assembler.push(consumed), ...assembler.flush()]
    : assembler.push(consumed);
  const events: RunEvent[] = [];
  const diagnostics: RunEvent[] = [];

  for (const line of lines) {
    let validJson = true;
    try {
      JSON.parse(line);
    } catch {
      validJson = false;
    }
    const normalized = normalizeEvent(harness, line, fallbackAt).map((event) =>
      sanitizeEvent(event, credential)
    );
    events.push(...normalized);
    if (!validJson && diagnostics.length < MAX_MALFORMED_DIAGNOSTICS) {
      diagnostics.push({
        at: fallbackAt,
        kind: "error",
        message: "Malformed harness JSONL event was ignored.",
      });
    }
  }
  return { cursor: nextCursor, diagnostics, events };
}

export function buildHarnessCommand(input: {
  harness: HarnessId;
  instructions: string;
  model: string;
  task: string;
  workspace: string;
}): string {
  return toShellCommand(
    buildInvocation({
      cwd: input.workspace,
      harness: input.harness,
      instructions: input.instructions,
      model: input.model,
      stream: true,
      task: input.task,
    })
  );
}
