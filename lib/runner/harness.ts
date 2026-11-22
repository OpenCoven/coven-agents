import "server-only";

import {
  type EvidenceRedactionInput,
  sanitizeEvidencePath,
  sanitizeEvidenceText,
} from "@opencoven/agent-contracts";
import type {
  HarnessExecutionPermission,
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
  MalformedHarnessEventError,
  normalizeEvent,
  runEventSchema,
  runEventTimestampSchema,
  toShellCommand,
} from "@opencoven/harness";
import { ZodError } from "zod";

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
): {
  auth: { name: string; value: string };
  secrets: readonly string[];
  spec: HarnessSpec;
} {
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
  const secrets = [value];
  if (spec.id === "codex") {
    // Only CLI ChatGPT sign-in, never an API-key auth.json. Do not retain
    // parsing errors, which could contain the caller's credential bytes.
    try {
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Invalid CLI sign-in shape.");
      }
      const auth = parsed as Record<string, unknown>;
      if (
        auth.auth_mode !== "chatgpt" ||
        (auth.OPENAI_API_KEY !== null && auth.OPENAI_API_KEY !== undefined)
      ) {
        throw new Error("Invalid CLI sign-in shape.");
      }
      const { tokens } = auth;
      if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
        throw new Error("Invalid CLI sign-in shape.");
      }
      const bag = tokens as Record<string, unknown>;
      for (const key of [
        "id_token",
        "access_token",
        "refresh_token",
        "account_id",
      ]) {
        const token = bag[key];
        if (typeof token !== "string" || !token.trim()) {
          throw new Error("Invalid CLI sign-in shape.");
        }
        secrets.push(token);
      }
    } catch {
      // biome-ignore lint/style/useErrorCause: Credential parser errors may contain secret bytes and must never escape.
      throw new HarnessError(
        "Codex requires its ChatGPT CLI auth.json, without a provider API key.",
        "harness_unauthenticated"
      );
    }
  }
  return { auth: { name, value }, secrets, spec };
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

function redact(value: string, credential: EvidenceRedactionInput): string {
  return sanitizeEvidenceText(value, credential);
}

function canonicalTimestamp(
  value: string,
  credential: EvidenceRedactionInput,
  fallbackAt: string
): string {
  const canonical = (candidate: string): string | null => {
    const parsed = runEventTimestampSchema.safeParse(
      redact(candidate, credential)
    );
    if (!parsed.success) {
      return null;
    }
    const date = new Date(parsed.data);
    if (Number.isNaN(date.valueOf())) {
      return null;
    }
    const timestamp = date.toISOString();
    return runEventTimestampSchema.safeParse(timestamp).success
      ? timestamp
      : null;
  };

  return canonical(value) ?? canonical(fallbackAt) ?? new Date().toISOString();
}

/**
 * Removes credential material from every string a harness can provide and
 * validates the result through the normalized event contract before it can be
 * persisted. Invalid timestamps are replaced rather than returning their raw
 * provider value.
 */
export function sanitizeHarnessEvent(
  fallbackHarness: HarnessId,
  event: RunEvent,
  credential: EvidenceRedactionInput,
  fallbackAt: string
): RunEvent {
  const at = canonicalTimestamp(event.at, credential, fallbackAt);
  switch (event.kind) {
    case "started": {
      const harness = redact(event.harness, credential);
      return runEventSchema.parse({
        ...event,
        at,
        harness:
          harness === "copilot" || harness === "codex" || harness === "claude"
            ? harness
            : fallbackHarness,
        runId: redact(event.runId, credential),
      });
    }
    case "reasoning":
    case "delta":
      return runEventSchema.parse({
        ...event,
        at,
        text: redact(event.text, credential),
      });
    case "message":
      return runEventSchema.parse({
        ...event,
        at,
        model: event.model === null ? null : redact(event.model, credential),
        text: redact(event.text, credential),
      });
    case "tool-start":
      return runEventSchema.parse({
        ...event,
        at,
        callId: redact(event.callId, credential),
        summary: redact(event.summary, credential),
        tool: redact(event.tool, credential),
      });
    case "tool-end":
      return runEventSchema.parse({
        ...event,
        at,
        callId: redact(event.callId, credential),
        summary: redact(event.summary, credential),
      });
    case "file":
      return runEventSchema.parse({
        ...event,
        at,
        operation: redact(event.operation, credential),
        path: redact(sanitizeEvidencePath(event.path), credential),
      });
    case "usage":
      return runEventSchema.parse({ ...event, at });
    case "finished":
      return runEventSchema.parse({
        ...event,
        at,
        filesModified: event.filesModified.map((path) =>
          redact(sanitizeEvidencePath(path), credential)
        ),
        sessionId:
          event.sessionId === null ? null : redact(event.sessionId, credential),
      });
    case "error":
      return runEventSchema.parse({
        ...event,
        at,
        message: redact(event.message, credential),
      });
    default:
      throw new HarnessError(
        "Unknown normalized harness event cannot be persisted.",
        "unknown_harness"
      );
  }
}

export type HarnessLogParse = Readonly<{
  cursor: number;
  events: readonly RunEvent[];
  pendingTail: boolean;
}>;

/**
 * Parses the accumulated stdout returned by a provider without retaining it.
 * A live poll advances through complete newline-delimited frames only. A
 * terminal poll consumes its final unterminated JSON object only when it is
 * valid JSON; a partial provider write remains pending for the next poll.
 */
export function parseHarnessLog(
  harness: HarnessId,
  stdout: string,
  cursor: number,
  terminal: boolean,
  credential: EvidenceRedactionInput,
  fallbackAt: string
): HarnessLogParse {
  const safeCursor =
    Number.isSafeInteger(cursor) && cursor >= 0 && cursor <= stdout.length
      ? cursor
      : 0;
  const fresh = stdout.slice(safeCursor);
  const finalNewline = fresh.lastIndexOf("\n");
  const trailing = finalNewline === -1 ? fresh : fresh.slice(finalNewline + 1);
  const hasUnterminatedTail = trailing.length > 0;
  let pendingTail = false;
  let consumed: string;
  if (!terminal) {
    consumed = finalNewline === -1 ? "" : fresh.slice(0, finalNewline + 1);
  } else if (hasUnterminatedTail) {
    try {
      JSON.parse(trailing);
      consumed = fresh;
    } catch {
      consumed = finalNewline === -1 ? "" : fresh.slice(0, finalNewline + 1);
      pendingTail = true;
    }
  } else {
    consumed = fresh;
  }
  const nextCursor = safeCursor + consumed.length;
  const assembler = new LineAssembler();
  const lines = terminal
    ? [...assembler.push(consumed), ...assembler.flush()]
    : assembler.push(consumed);
  const events: RunEvent[] = [];
  let malformedDiagnostics = 0;

  for (const line of lines) {
    let malformed = false;
    try {
      JSON.parse(line);
    } catch {
      malformed = true;
    }
    if (!malformed) {
      try {
        const normalized = normalizeEvent(harness, line, fallbackAt).map(
          (event) =>
            sanitizeHarnessEvent(harness, event, credential, fallbackAt)
        );
        events.push(...normalized);
      } catch (error) {
        if (
          !(
            error instanceof MalformedHarnessEventError ||
            error instanceof ZodError
          )
        ) {
          throw error;
        }
        malformed = true;
      }
    }
    if (malformed && malformedDiagnostics < MAX_MALFORMED_DIAGNOSTICS) {
      events.push(
        sanitizeHarnessEvent(
          harness,
          {
            at: fallbackAt,
            kind: "error",
            message: "Malformed harness JSONL event was ignored.",
          },
          credential,
          fallbackAt
        )
      );
      malformedDiagnostics += 1;
    }
  }
  return { cursor: nextCursor, events, pendingTail };
}

export function buildHarnessCommand(input: {
  attemptDirectory?: string;
  configDirectory?: string;
  executionPermission?: HarnessExecutionPermission;
  githubTool?: boolean;
  harness: HarnessId;
  instructions: string;
  model: string;
  task: string;
  workspace: string;
}): string {
  return toShellCommand(
    buildInvocation({
      attemptDir: input.attemptDirectory,
      configDir: input.configDirectory,
      cwd: input.workspace,
      githubTool: input.githubTool ?? false,
      harness: input.harness,
      instructions: input.instructions,
      model: input.model,
      permissionMode: input.executionPermission ?? "unrestricted",
      stream: true,
      task: input.task,
    })
  );
}
