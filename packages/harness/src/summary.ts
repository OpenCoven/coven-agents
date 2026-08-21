import type { RunEvent } from "./schema.js";

export interface RunSummary {
  /** Files the harness reported creating, editing or deleting. */
  readonly fileOperations: { operation: string; path: string }[];
  /** Assistant text, in order, with deltas folded into their message. */
  readonly output: string;
  readonly premiumRequests: number | null;
  readonly sessionId: string | null;
  readonly status: "completed" | "failed";
  readonly toolCalls: { success: boolean; summary: string; tool: string }[];
}

/**
 * Folds a normalized event stream into the fields a run record needs.
 *
 * `delta` frames are dropped when a corresponding `message` frame exists,
 * because Copilot CLI emits both: the deltas are the incremental render of the
 * same text, so keeping both would duplicate every reply.
 */
export function summarizeRun(events: readonly RunEvent[]): RunSummary {
  const messages: string[] = [];
  const deltas: string[] = [];
  const fileOperations: { operation: string; path: string }[] = [];
  const starts = new Map<string, { summary: string; tool: string }>();
  const toolCalls: { success: boolean; summary: string; tool: string }[] = [];
  let premiumRequests: number | null = null;
  let sessionId: string | null = null;
  let status: "completed" | "failed" | null = null;
  const errors: string[] = [];

  for (const event of events) {
    switch (event.kind) {
      case "message":
        messages.push(event.text);
        break;
      case "delta":
        deltas.push(event.text);
        break;
      case "file":
        fileOperations.push({
          operation: event.operation,
          path: event.path,
        });
        break;
      case "tool-start":
        starts.set(event.callId, { summary: event.summary, tool: event.tool });
        break;
      case "tool-end": {
        const start = starts.get(event.callId);
        toolCalls.push({
          success: event.success,
          summary: start?.summary ?? event.summary,
          tool: start?.tool ?? "tool",
        });
        break;
      }
      case "usage":
        if (event.premiumRequests !== null) {
          ({ premiumRequests } = event);
        }
        break;
      case "finished":
        ({ sessionId, status } = event);
        break;
      case "error":
        errors.push(event.message);
        break;
      default:
        break;
    }
  }

  const body = messages.length > 0 ? messages.join("\n\n") : deltas.join("");
  const output = [body.trim(), ...errors].filter(Boolean).join("\n");

  return {
    fileOperations,
    output,
    premiumRequests,
    sessionId,
    status: status ?? (errors.length > 0 ? "failed" : "completed"),
    toolCalls,
  };
}
