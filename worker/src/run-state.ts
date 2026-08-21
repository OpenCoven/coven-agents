import {
  AGENT_RUNNER_API_VERSION,
  AGENT_RUNNER_LIMITS,
  type AgentDefinition,
  type RunEvent,
  type RunSnapshot,
} from "@opencoven/agent-contracts";

export const MAX_EVENTS_PER_RUN = 200;
export const MAX_EVIDENCE_PER_RUN = 20;
export const MAX_CAPTURED_OUTPUT_BYTES = 2 * 1024 * 1024;

export type CloudRunRecord = {
  events: RunEvent[];
  operationHash: string;
  run: RunSnapshot;
};

export function validateCloudWorkspace(
  definition: Pick<AgentDefinition, "workspace">
): string {
  if (
    definition.workspace === undefined ||
    definition.workspace === "/workspace"
  ) {
    return "/workspace";
  }
  throw new Error("Cloud agents may only use the /workspace scratch sandbox.");
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

export function truncateRunText(value: string): string {
  if (value.length <= AGENT_RUNNER_LIMITS.maxEventOutputLength) {
    return value;
  }
  const suffix = "\n[output truncated by runner]";
  return `${value.slice(
    0,
    AGENT_RUNNER_LIMITS.maxEventOutputLength - suffix.length
  )}${suffix}`;
}

export function safeRunText(value: string): string {
  const environmentLines = value
    .split(/\r?\n/u)
    .filter((line) => /^[A-Z_][A-Z0-9_]*=/u.test(line));
  if (environmentLines.length >= 3) {
    return "[environment output redacted]";
  }
  return truncateRunText(
    value
      .replace(/(Bearer\s+)[^\s"'`]+/giu, "$1[REDACTED]")
      .replace(
        /\b(AGENT_CONTROL_TOKEN|OPENAI_API_KEY)\s*=\s*[^\s]+/giu,
        "$1=[REDACTED]"
      )
  );
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
