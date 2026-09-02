export type ReasoningToolActivity = Readonly<{
  kind: "tool";
  label: string;
  state: "active" | "completed" | "failed" | "waiting";
  tool: string;
}>;

export type ReasoningActivity =
  | ReasoningToolActivity
  | Readonly<{
      kind: "reasoning";
      state: "active" | "completed";
      text: string;
    }>;

export type ReasoningCardStep = Readonly<{
  collapsedCount?: number;
  description: string;
  id: string;
  kind: "fold" | "reasoning" | "tool";
  state: "active" | "completed" | "failed" | "waiting";
  title: string;
  tool?: string;
}>;

export type ReasoningCardModel = Readonly<{
  failureCount: number;
  footer: string;
  stepCount: number;
  steps: readonly ReasoningCardStep[];
  summary: string;
  toolCallCount: number;
}>;

type BuildReasoningCardModelInput = Readonly<{
  activities: readonly ReasoningActivity[];
  isStreaming: boolean;
}>;

type ToolPart = Readonly<{
  approval?: unknown;
  output?: unknown;
  state?: unknown;
  text?: unknown;
  type?: unknown;
}>;

const SUMMARY_LIMIT = 120;

function normalizeSpace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function plainText(value: string): string {
  return normalizeSpace(
    value
      .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
      .replace(/^[#>*+\-\d.)\s]+/gmu, "")
      .replace(/[`_*~]/gu, "")
  );
}

function boundedSummary(value: string): string {
  const normalized = plainText(value);
  if (normalized.length <= SUMMARY_LIMIT) {
    return normalized;
  }
  return `${normalized.slice(0, SUMMARY_LIMIT - 1).trimEnd()}…`;
}

function firstSentence(value: string): string {
  const normalized = plainText(value);
  const match = normalized.match(/^.*?[.!?](?:\s|$)/u);
  return boundedSummary(match?.[0] ?? normalized);
}

function humanizeToolName(tool: string): string {
  const spaced = tool
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ");
  const normalized = normalizeSpace(spaced);
  return normalized
    ? `${normalized.charAt(0).toUpperCase()}${normalized.slice(1).toLowerCase()}`
    : "Tool call";
}

function toolState(
  value: unknown,
  approval: unknown,
  output: unknown
): ReasoningToolActivity["state"] {
  const denied =
    value === "approval-responded" &&
    approval !== null &&
    typeof approval === "object" &&
    "approved" in approval &&
    approval.approved === false;
  if (value === "output-error" || value === "output-denied" || denied) {
    return "failed";
  }
  if (value === "output-available") {
    return output !== null &&
      typeof output === "object" &&
      Object.hasOwn(output, "error")
      ? "failed"
      : "completed";
  }
  if (value === "approval-requested") {
    return "waiting";
  }
  return "active";
}

export function reasoningCardActivities(
  parts: readonly unknown[]
): ReasoningActivity[] {
  const activities: ReasoningActivity[] = [];
  for (const candidate of parts) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const part = candidate as ToolPart;
    if (
      part.type === "reasoning" &&
      typeof part.text === "string" &&
      part.text.trim().length > 0
    ) {
      activities.push({
        kind: "reasoning",
        state: part.state === "streaming" ? "active" : "completed",
        text: part.text,
      });
      continue;
    }
    if (typeof part.type !== "string" || !part.type.startsWith("tool-")) {
      continue;
    }
    const tool = part.type.slice("tool-".length);
    activities.push({
      kind: "tool",
      label: humanizeToolName(tool),
      state: toolState(part.state, part.approval, part.output),
      tool,
    });
  }
  return activities;
}

function toolDescription(state: ReasoningToolActivity["state"]): string {
  switch (state) {
    case "completed":
      return "Completed and returned a result.";
    case "failed":
      return "The call did not complete. No result was assumed.";
    case "waiting":
      return "Waiting for approval before continuing.";
    default:
      return "Running now.";
  }
}

export function buildReasoningCardModel({
  activities,
  isStreaming,
}: BuildReasoningCardModelInput): ReasoningCardModel {
  let reasoningIndex = 0;
  let toolCallCount = 0;
  const steps: ReasoningCardStep[] = activities.map((activity, index) => {
    if (activity.kind === "reasoning") {
      reasoningIndex += 1;
      return {
        description: activity.text,
        id: `reasoning-${index}`,
        kind: "reasoning",
        state: activity.state,
        title: `Reasoning step ${reasoningIndex}`,
      };
    }
    toolCallCount += 1;
    return {
      description: toolDescription(activity.state),
      id: `tool-${index}-${activity.tool}`,
      kind: "tool",
      state: activity.state,
      title: activity.label,
      tool: activity.tool,
    };
  });
  if (steps.length === 0 && isStreaming) {
    steps.push({
      description: "The model is preparing its reasoning.",
      id: "reasoning-active",
      kind: "reasoning",
      state: "active",
      title: "Reasoning",
    });
  }

  const failureCount = steps.filter((step) => step.state === "failed").length;
  const firstReasoning = activities.find(
    (activity) => activity.kind === "reasoning"
  );

  let footer = "Reasoning and tool activity are shown as received.";
  if (isStreaming) {
    footer = "Reasoning and tool activity are updating live.";
  } else if (failureCount > 0) {
    footer =
      failureCount === 1
        ? "One step failed. Completed work is preserved."
        : `${failureCount} steps failed. Completed work is preserved.`;
  }

  return {
    failureCount,
    footer,
    stepCount: steps.length,
    steps,
    summary:
      (firstReasoning ? firstSentence(firstReasoning.text) : "") ||
      (isStreaming ? "Working through the request" : "Reasoning complete"),
    toolCallCount,
  };
}

function isRoutineTool(step: ReasoningCardStep): boolean {
  return step.kind === "tool" && step.state === "completed";
}

export function foldReasoningCardSteps(
  steps: readonly ReasoningCardStep[],
  expanded: boolean
): readonly ReasoningCardStep[] {
  if (expanded || steps.length <= 7) {
    return steps;
  }

  const folded: ReasoningCardStep[] = [];
  let routineRun: ReasoningCardStep[] = [];

  const flush = () => {
    if (routineRun.length > 3) {
      const [first] = routineRun;
      const last = routineRun.at(-1);
      if (!(first && last)) {
        routineRun = [];
        return;
      }
      folded.push(first, {
        collapsedCount: routineRun.length - 2,
        description: `${routineRun.length - 2} completed calls are folded to keep the trace readable.`,
        id: `fold-${first.id}`,
        kind: "fold",
        state: "completed",
        title: "Routine tool calls",
      });
      folded.push(last);
    } else {
      folded.push(...routineRun);
    }
    routineRun = [];
  };

  for (const step of steps) {
    if (isRoutineTool(step)) {
      routineRun.push(step);
    } else {
      flush();
      folded.push(step);
    }
  }
  flush();
  return folded;
}
