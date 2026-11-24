import type { HarnessId, RunEvent } from "./schema";

/**
 * Translates a harness's private event stream into the normalized run
 * vocabulary. Keeping this pure means the mapping is testable against recorded
 * fixtures without spawning a CLI, and the UI never learns a vendor's event
 * names.
 *
 * Copilot CLI emits JSONL on stdout under `--output-format json`. Unknown event
 * types are dropped rather than guessed at: a harness may add types at any
 * time, and inventing a rendering for one would put false detail on screen.
 */

const MAX_SUMMARY = 160;

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export class MalformedHarnessEventError extends Error {
  constructor() {
    super("Harness event has an invalid structured JSON shape.");
    this.name = "MalformedHarnessEventError";
  }
}

function malformed(): never {
  throw new MalformedHarnessEventError();
}

function optionalString(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  return asString(value) ?? malformed();
}

function optionalNumber(
  record: Record<string, unknown>,
  key: string,
  integer = false
): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (integer && !Number.isInteger(value))
  ) {
    return malformed();
  }
  return value;
}

function optionalRecord(
  record: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  return asRecord(value) ?? malformed();
}

function toolArguments(
  data: Record<string, unknown>
): Record<string, unknown> | null {
  if (typeof data.arguments !== "string") {
    return optionalRecord(data, "arguments") ?? null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.arguments);
  } catch {
    return malformed();
  }
  return asRecord(parsed) ?? malformed();
}

function eventData(envelope: Record<string, unknown>): Record<string, unknown> {
  return optionalRecord(envelope, "data") ?? {};
}

function stringArray(
  record: Record<string, unknown>,
  key: string
): string[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return malformed();
  }
  return value;
}

function clamp(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_SUMMARY
    ? `${collapsed.slice(0, MAX_SUMMARY - 1)}…`
    : collapsed;
}

/**
 * Describes a tool call using the argument that actually identifies the work,
 * so the console reads like "create notes.md" rather than "create".
 */
function summarizeArguments(
  tool: string,
  args: Record<string, unknown> | null
): string {
  if (!args) {
    return tool;
  }
  for (const key of ["command", "path", "file_path", "query", "url", "id"]) {
    const value = asString(args[key]);
    if (value) {
      return clamp(`${tool} ${value}`);
    }
  }
  return tool;
}

function fileOperationFor(infoType: string): string | null {
  switch (infoType) {
    case "file_created":
      return "created";
    case "file_edited":
    case "file_modified":
      return "edited";
    case "file_deleted":
      return "deleted";
    default:
      return null;
  }
}

export function normalizeCopilotEvent(
  line: string,
  fallbackAt: string
): RunEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // A non-JSON line is CLI chrome, not an event. Dropping it keeps the
    // stream clean; genuine failures still surface through the exit code.
    return [];
  }

  const envelope = asRecord(parsed);
  if (!envelope) {
    throw new MalformedHarnessEventError();
  }
  const type = optionalString(envelope, "type");
  if (!type) {
    return [];
  }
  const at = optionalString(envelope, "timestamp") ?? fallbackAt;

  switch (type) {
    case "assistant.reasoning": {
      const data = eventData(envelope);
      const text = asString(data.content);
      return text
        ? [{ at, kind: "reasoning", text }]
        : data.content === undefined
          ? []
          : malformed();
    }
    case "assistant.message_delta": {
      const data = eventData(envelope);
      const text = asString(data.deltaContent);
      return text
        ? [{ at, kind: "delta", text }]
        : data.deltaContent === undefined
          ? []
          : malformed();
    }
    case "assistant.message": {
      const data = eventData(envelope);
      const text = asString(data.content);
      return text
        ? [
            {
              at,
              kind: "message",
              model: optionalString(data, "model") ?? null,
              text,
            },
          ]
        : data.content === undefined || data.content === ""
          ? []
          : malformed();
    }
    case "tool.execution_start": {
      const data = eventData(envelope);
      const tool = optionalString(data, "toolName");
      const callId = optionalString(data, "toolCallId");
      if (!(tool && callId)) {
        return [];
      }
      return [
        {
          at,
          callId,
          kind: "tool-start",
          summary: summarizeArguments(tool, toolArguments(data)),
          tool,
        },
      ];
    }
    case "tool.execution_complete": {
      const data = eventData(envelope);
      const callId = optionalString(data, "toolCallId");
      if (!callId) {
        return [];
      }
      const result = optionalRecord(data, "result");
      const summary = result ? (optionalString(result, "content") ?? "") : "";
      const { success } = data;
      const error = optionalRecord(data, "error");
      const executionDenied =
        success === false &&
        error?.code === "failure" &&
        typeof error.message === "string" &&
        /^Tool '[^']+' does not exist\.$/u.test(error.message);
      if (success !== undefined && typeof success !== "boolean") {
        return malformed();
      }
      return [
        {
          at,
          callId,
          kind: "tool-end",
          ...(executionDenied ? { executionDenied: true as const } : {}),
          success: success !== false,
          summary: clamp(summary),
        },
      ];
    }
    case "session.info": {
      const data = eventData(envelope);
      const infoType = optionalString(data, "infoType") ?? "";
      const operation = fileOperationFor(infoType);
      const path = optionalString(data, "message");
      return operation && path ? [{ at, kind: "file", operation, path }] : [];
    }
    case "session.usage_checkpoint": {
      const data = eventData(envelope);
      const premiumRequests = optionalNumber(data, "totalPremiumRequests");
      return [
        {
          at,
          kind: "usage",
          linesAdded: null,
          linesRemoved: null,
          premiumRequests: premiumRequests ?? null,
        },
      ];
    }
    case "result": {
      const usage = optionalRecord(envelope, "usage");
      const changes = usage ? optionalRecord(usage, "codeChanges") : undefined;
      const exitCode = optionalNumber(envelope, "exitCode", true) ?? null;
      return [
        {
          at,
          kind: "usage",
          linesAdded: changes
            ? (optionalNumber(changes, "linesAdded", true) ?? null)
            : null,
          linesRemoved: changes
            ? (optionalNumber(changes, "linesRemoved", true) ?? null)
            : null,
          premiumRequests: usage
            ? (optionalNumber(usage, "premiumRequests") ?? null)
            : null,
        },
        {
          at,
          exitCode,
          filesModified: changes
            ? (stringArray(changes, "filesModified") ?? [])
            : [],
          kind: "finished",
          sessionId: optionalString(envelope, "sessionId") ?? null,
          status: exitCode === 0 ? "completed" : "failed",
        },
      ];
    }
    default:
      return [];
  }
}

export function normalizeEvent(
  harness: HarnessId,
  line: string,
  fallbackAt: string
): RunEvent[] {
  if (harness === "copilot") {
    return normalizeCopilotEvent(line, fallbackAt);
  }
  // Codex and Claude are detected and reported, but their event translation is
  // deliberately not implemented yet. Emitting nothing is honest; guessing at a
  // shape would render invented detail.
  return [];
}

/**
 * Splits a byte stream into whole lines, holding an incomplete trailing line
 * until the rest of it arrives. Without this a JSON object split across two
 * chunk boundaries would be dropped as unparseable.
 */
export class LineAssembler {
  #buffer = "";

  push(chunk: string): string[] {
    this.#buffer += chunk;
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";
    return lines.map((line) => line.trim()).filter(Boolean);
  }

  flush(): string[] {
    const rest = this.#buffer.trim();
    this.#buffer = "";
    return rest ? [rest] : [];
  }
}
