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

interface CopilotEnvelope {
  data?: Record<string, unknown>;
  exitCode?: number;
  sessionId?: string;
  timestamp?: string;
  type?: string;
  usage?: {
    codeChanges?: {
      filesModified?: string[];
      linesAdded?: number;
      linesRemoved?: number;
    };
    premiumRequests?: number;
  };
}

const MAX_SUMMARY = 160;

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
  let parsed: CopilotEnvelope;
  try {
    parsed = JSON.parse(line) as CopilotEnvelope;
  } catch {
    // A non-JSON line is CLI chrome, not an event. Dropping it keeps the
    // stream clean; genuine failures still surface through the exit code.
    return [];
  }

  const at = parsed.timestamp ?? fallbackAt;
  const data = parsed.data ?? {};

  switch (parsed.type) {
    case "assistant.reasoning": {
      const text = asString(data.content);
      return text ? [{ at, kind: "reasoning", text }] : [];
    }
    case "assistant.message_delta": {
      const text = asString(data.deltaContent);
      return text ? [{ at, kind: "delta", text }] : [];
    }
    case "assistant.message": {
      const text = asString(data.content);
      return text
        ? [{ at, kind: "message", model: asString(data.model), text }]
        : [];
    }
    case "tool.execution_start": {
      const tool = asString(data.toolName);
      const callId = asString(data.toolCallId);
      if (!(tool && callId)) {
        return [];
      }
      return [
        {
          at,
          callId,
          kind: "tool-start",
          summary: summarizeArguments(tool, asRecord(data.arguments)),
          tool,
        },
      ];
    }
    case "tool.execution_complete": {
      const callId = asString(data.toolCallId);
      if (!callId) {
        return [];
      }
      const result = asRecord(data.result);
      const summary = asString(result?.content) ?? "";
      return [
        {
          at,
          callId,
          kind: "tool-end",
          success: data.success !== false,
          summary: clamp(summary),
        },
      ];
    }
    case "session.info": {
      const infoType = asString(data.infoType) ?? "";
      const operation = fileOperationFor(infoType);
      const path = asString(data.message);
      return operation && path ? [{ at, kind: "file", operation, path }] : [];
    }
    case "session.usage_checkpoint": {
      const premiumRequests = data.totalPremiumRequests;
      return [
        {
          at,
          kind: "usage",
          linesAdded: null,
          linesRemoved: null,
          premiumRequests:
            typeof premiumRequests === "number" ? premiumRequests : null,
        },
      ];
    }
    case "result": {
      const changes = parsed.usage?.codeChanges;
      const exitCode =
        typeof parsed.exitCode === "number" ? parsed.exitCode : null;
      return [
        {
          at,
          kind: "usage",
          linesAdded: changes?.linesAdded ?? null,
          linesRemoved: changes?.linesRemoved ?? null,
          premiumRequests: parsed.usage?.premiumRequests ?? null,
        },
        {
          at,
          exitCode,
          filesModified: changes?.filesModified ?? [],
          kind: "finished",
          sessionId: parsed.sessionId ?? null,
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
