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
        : data.content === undefined
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
          summary: summarizeArguments(
            tool,
            optionalRecord(data, "arguments") ?? null
          ),
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
      if (success !== undefined && typeof success !== "boolean") {
        return malformed();
      }
      return [
        {
          at,
          callId,
          kind: "tool-end",
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

/** Parse structured CLI lines; chrome is ignored, malformed JSON values refuse. */
function cliEnvelope(line: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return asRecord(parsed) ?? malformed();
}

function requiredString(record: Record<string, unknown>, key: string): string {
  return asString(record[key]) ?? malformed();
}

function terminal(
  at: string,
  failed: boolean,
  sessionId: string | null = null
): RunEvent {
  return {
    at,
    exitCode: null,
    filesModified: [],
    kind: "finished",
    sessionId,
    status: failed ? "failed" : "completed",
  };
}

/** Codex exec --json, pinned to the exec event vocabulary (not app-server RPC). */
function normalizeCodexEvent(line: string, at: string): RunEvent[] {
  const envelope = cliEnvelope(line);
  if (!envelope) {
    return [];
  }
  const type = optionalString(envelope, "type");
  if (type === "turn.completed") {
    optionalRecord(envelope, "usage");
    return [terminal(at, false)];
  }
  if (type === "turn.failed" || type === "error") {
    const error =
      type === "error"
        ? envelope
        : (optionalRecord(envelope, "error") ?? malformed());
    return [
      { at, kind: "error", message: requiredString(error, "message") },
      terminal(at, true),
    ];
  }
  if (
    type !== "item.started" &&
    type !== "item.completed" &&
    type !== "item.updated"
  ) {
    return [];
  }
  const item = optionalRecord(envelope, "item") ?? malformed();
  const itemType = optionalString(item, "type");
  const completed = type === "item.completed";
  if (itemType === "agent_message" || itemType === "reasoning") {
    const text = requiredString(item, "text");
    return completed
      ? [
          itemType === "agent_message"
            ? { at, kind: "message", model: null, text }
            : { at, kind: "reasoning", text },
        ]
      : [];
  }
  if (itemType === "command_execution" || itemType === "mcp_tool_call") {
    const callId = requiredString(item, "id");
    const tool =
      itemType === "command_execution"
        ? itemType
        : requiredString(item, "tool");
    const summary =
      itemType === "command_execution"
        ? clamp(`${tool} ${requiredString(item, "command")}`)
        : clamp(`${requiredString(item, "server")} ${tool}`);
    if (type === "item.started") {
      return [{ at, callId, kind: "tool-start", summary, tool }];
    }
    if (!completed) {
      return [];
    }
    const status = requiredString(item, "status");
    if (status !== "completed" && status !== "failed") {
      return malformed();
    }
    const exit = optionalNumber(item, "exit_code", true);
    const text = optionalString(item, "aggregated_output") ?? summary;
    return [
      {
        at,
        callId,
        kind: "tool-end",
        success: status === "completed" && (exit === undefined || exit === 0),
        summary: clamp(text),
      },
    ];
  }
  if (itemType === "file_change" && completed) {
    if (item.status !== "completed" && item.status !== "failed") {
      return malformed();
    }
    if (!Array.isArray(item.changes)) {
      return malformed();
    }
    const events = item.changes.map((change) => {
      const entry = asRecord(change) ?? malformed();
      const path = requiredString(entry, "path");
      const operation =
        entry.kind === "add"
          ? "created"
          : entry.kind === "delete"
            ? "deleted"
            : entry.kind === "update"
              ? "edited"
              : malformed();
      return { at, kind: "file" as const, operation, path };
    });
    // A requested or failed patch is not evidence that a file changed.
    return item.status === "completed" ? events : [];
  }
  if (itemType === "error" && completed) {
    return [{ at, kind: "error", message: requiredString(item, "message") }];
  }
  return [];
}

/** Claude --print --output-format stream-json. Unknown frames are ignored. */
function normalizeClaudeEvent(line: string, at: string): RunEvent[] {
  const envelope = cliEnvelope(line);
  if (!envelope) {
    return [];
  }
  const type = optionalString(envelope, "type");
  if (type === "result") {
    if (typeof envelope.is_error !== "boolean") {
      return malformed();
    }
    const subtype = requiredString(envelope, "subtype");
    const failed = envelope.is_error || subtype !== "success";
    const sessionId = optionalString(envelope, "session_id") ?? null;
    const message = optionalString(envelope, "result");
    const errors = stringArray(envelope, "errors");
    return [
      ...(failed
        ? [
            {
              at,
              kind: "error" as const,
              message:
                message || errors?.join("; ") || "Claude CLI run failed.",
            },
          ]
        : []),
      terminal(at, failed, sessionId),
    ];
  }
  if (type !== "assistant" && type !== "user") {
    return [];
  }
  const message = optionalRecord(envelope, "message") ?? malformed();
  if (!Array.isArray(message.content)) {
    return malformed();
  }
  const model = optionalString(message, "model") ?? null;
  const events: RunEvent[] = [];
  for (const raw of message.content) {
    const block = asRecord(raw) ?? malformed();
    const kind = optionalString(block, "type");
    if (type === "assistant" && kind === "text") {
      events.push({
        at,
        kind: "message",
        model,
        text: requiredString(block, "text"),
      });
    } else if (type === "assistant" && kind === "tool_use") {
      const tool = requiredString(block, "name");
      events.push({
        at,
        callId: requiredString(block, "id"),
        kind: "tool-start",
        summary: summarizeArguments(
          tool,
          optionalRecord(block, "input") ?? null
        ),
        tool,
      });
    } else if (type === "user" && kind === "tool_result") {
      if (block.is_error !== undefined && typeof block.is_error !== "boolean") {
        return malformed();
      }
      let summary = "";
      if (typeof block.content === "string") {
        summary = block.content;
      } else if (Array.isArray(block.content)) {
        summary = block.content
          .map((rawPart) => {
            const part = asRecord(rawPart) ?? malformed();
            return part.type === "text" ? requiredString(part, "text") : "";
          })
          .join(" ");
      } else if (block.content !== undefined) {
        return malformed();
      }
      events.push({
        at,
        callId: requiredString(block, "tool_use_id"),
        kind: "tool-end",
        success: block.is_error !== true,
        summary: clamp(summary),
      });
    }
  }
  return events;
}

export function normalizeEvent(
  harness: HarnessId,
  line: string,
  fallbackAt: string
): RunEvent[] {
  switch (harness) {
    case "copilot":
      return normalizeCopilotEvent(line, fallbackAt);
    case "codex":
      return normalizeCodexEvent(line, fallbackAt);
    case "claude":
      return normalizeClaudeEvent(line, fallbackAt);
    default:
      return [];
  }
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
