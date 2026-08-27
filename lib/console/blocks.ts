import type {
  AgentDefinition,
  CommandEvidence,
  FileEvidence,
  RunEvent,
  RunSnapshot,
  RunStatus,
} from "@opencoven/agent-contracts";
import { formatDuration, spanBetween } from "@/lib/console/format";

/**
 * Projects a run's event stream onto the blocks the console reads.
 *
 * This is the only place that decides what a run *looked like*. It is pure and
 * separately tested because the alternative — deriving it inside the component
 * as it renders — is how a thread and its steps panel end up disagreeing about
 * how many commands ran.
 *
 * Nothing here invents a number. Where the runner reports no duration the block
 * carries `null` and the console prints an em dash, rather than the console
 * showing a plausible figure the receipt cannot support.
 */

export type ThreadBlock =
  | {
      context: string[];
      id: string;
      kind: "mission";
      text: string;
      who: string;
    }
  | {
      detail: string | null;
      durationMs: number | null;
      id: string;
      kind: "lifecycle";
      label: string;
      status: RunStatus;
    }
  | {
      command: string;
      durationMs: number | null;
      exitCode: number | null;
      id: string;
      kind: "command";
      live: boolean;
      stderr: string;
      stdout: string;
    }
  | {
      durationMs: number | null;
      files: FileEvidence[];
      id: string;
      kind: "files";
      label: string;
    }
  | {
      durationMs: number | null;
      id: string;
      kind: "text";
      live: boolean;
      text: string;
    }
  | {
      code: string;
      details: string | null;
      id: string;
      kind: "error";
      message: string;
      retryable: boolean;
    }
  | {
      claim: string;
      id: string;
      kind: "evidence";
      meta: string;
      provenance: string;
      stats: { label: string; value: string }[];
      touched: FileEvidence[];
    };

export type Step = {
  blockId: string;
  detail: string;
  duration: string;
  /**
   * Up to a handful of body lines behind the one-line detail — command
   * output, report opening, file paths. The rail shows these by default and
   * collapses to the single line on demand, so the index can carry real
   * content without the thread's bulk.
   */
  expanded: string[];
  id: string;
  label: string;
  tone: "danger" | "muted" | "running" | "success";
};

export type RunProjection = {
  blocks: ThreadBlock[];
  /** What the agent is doing right now, for the running strip. */
  nowDoing: string;
  steps: Step[];
};

type ProjectInput = {
  agent: AgentDefinition | null;
  events: RunEvent[];
  run: RunSnapshot | null;
  /** The account the mission is attributed to. */
  who: string;
};

const TERMINAL_STATUSES: readonly RunStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

export function isTerminal(status: RunStatus | null | undefined): boolean {
  return status ? TERMINAL_STATUSES.includes(status) : false;
}

const STATUS_LABELS: Record<RunStatus, string> = {
  cancelled: "Run cancelled",
  completed: "Run closed",
  failed: "Run stopped",
  queued: "Run queued",
  running: "Sandbox provisioned",
};

function fileVerb(files: FileEvidence[]): string {
  const operations = new Set(files.map((file) => file.operation));
  if (operations.size === 1) {
    const [only] = [...operations];
    if (only === "create") {
      return "Created";
    }
    if (only === "delete") {
      return "Deleted";
    }
  }
  return "Edited";
}

function fileLabel(files: FileEvidence[]): string {
  const noun = files.length === 1 ? "file" : "files";
  return `${fileVerb(files)} ${files.length} ${noun}`;
}

function commandExitTone(exitCode: number | null): Step["tone"] {
  if (exitCode === null) {
    return "running";
  }
  return exitCode === 0 ? "success" : "danger";
}

/** The leading token of a command, which is how a reader recognises it. */
function commandHead(command: string): string {
  return command.trim().split(/\s+/, 1)[0] ?? command;
}

function commandDuration(evidence: CommandEvidence): number | null {
  return spanBetween(evidence.startedAt, evidence.completedAt);
}

/**
 * A one-line summary of what a command produced.
 *
 * Prefers the last non-empty line of stderr over stdout: when a command fails,
 * the reason is almost always the last thing it complained about, and burying
 * that under the final line of a passing-looking stdout is what makes a failed
 * step look fine in the collapsed view.
 */
function commandSummary(evidence: CommandEvidence): string {
  const source =
    evidence.exitCode !== null && evidence.exitCode !== 0 && evidence.stderr
      ? evidence.stderr
      : evidence.stdout || evidence.stderr;
  const lines = source
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "";
}

/**
 * Groups the stream into blocks.
 *
 * Consecutive `output` events coalesce into one passage and consecutive `file`
 * events into one card, because the runner emits them at whatever granularity
 * the harness happened to flush at — one block per flush would shred a
 * paragraph into a column of fragments.
 */
function collectBlocks(input: ProjectInput): ThreadBlock[] {
  const blocks: ThreadBlock[] = [];
  const { agent, events, run, who } = input;

  if (run?.task) {
    blocks.push({
      context: [
        agent?.name ?? "agent",
        agent?.runtime ? `${agent.runtime} · ${agent.model}` : "",
        agent?.workspace ?? "",
      ].filter(Boolean),
      id: "mission",
      kind: "mission",
      text: run.task,
      who,
    });
  }

  const nextAt = (index: number): string | undefined => {
    for (let ahead = index + 1; ahead < events.length; ahead += 1) {
      const at = events[ahead]?.at;
      if (at) {
        return at;
      }
    }
    return run?.completedAt ?? undefined;
  };

  events.forEach((event, index) => {
    const gap = spanBetween(event.at, nextAt(index));

    switch (event.type) {
      case "accepted":
        break;

      case "status": {
        // Only the transitions worth a line in the record. `queued` is the
        // state the run is already in when it is accepted, so announcing it
        // would open every thread with a step that never happened.
        if (event.status === "queued") {
          break;
        }
        blocks.push({
          detail:
            event.status === "running"
              ? `${agent?.runtime ?? "harness"} · isolated container`
              : null,
          durationMs: gap,
          id: `e${event.id}`,
          kind: "lifecycle",
          label: STATUS_LABELS[event.status],
          status: event.status,
        });
        break;
      }

      case "output": {
        const previous = blocks.at(-1);
        if (previous?.kind === "text") {
          previous.text = `${previous.text}${event.output}`;
          previous.durationMs = gap;
          break;
        }
        blocks.push({
          durationMs: gap,
          id: `e${event.id}`,
          kind: "text",
          live: false,
          text: event.output,
        });
        break;
      }

      case "command":
        blocks.push({
          command: event.evidence.command,
          durationMs: commandDuration(event.evidence) ?? gap,
          exitCode: event.evidence.exitCode,
          id: `e${event.id}`,
          kind: "command",
          live: event.evidence.exitCode === null,
          stderr: event.evidence.stderr,
          stdout: event.evidence.stdout,
        });
        break;

      case "file": {
        const previous = blocks.at(-1);
        if (previous?.kind === "files") {
          previous.files.push(event.evidence);
          previous.label = fileLabel(previous.files);
          previous.durationMs = gap;
          break;
        }
        blocks.push({
          durationMs: gap,
          files: [event.evidence],
          id: `e${event.id}`,
          kind: "files",
          label: fileLabel([event.evidence]),
        });
        break;
      }

      case "failed":
        blocks.push({
          code: event.error.code,
          details: event.error.details ?? null,
          id: `e${event.id}`,
          kind: "error",
          message: event.error.message,
          retryable: event.error.retryable,
        });
        break;

      case "completed":
        blocks.push(evidenceBlock(event.run, agent, `e${event.id}`));
        break;

      default:
        break;
    }
  });

  // A run can reach a terminal snapshot without the console having seen the
  // `completed` event — a reconnect after the stream closed lands exactly
  // there. The receipt is what the run is for, so it is built from the
  // snapshot rather than left off because an event was missed.
  const hasEvidence = blocks.some((block) => block.kind === "evidence");
  if (run && run.status === "completed" && !hasEvidence) {
    blocks.push(evidenceBlock(run, agent, "receipt"));
  }

  if (run?.error && !blocks.some((block) => block.kind === "error")) {
    blocks.push({
      code: run.error.code,
      details: run.error.details ?? null,
      id: "run-error",
      kind: "error",
      message: run.error.message,
      retryable: run.error.retryable,
    });
  }

  const last = blocks.at(-1);
  if (last?.kind === "text" && run && !isTerminal(run.status)) {
    last.live = true;
  }

  return blocks;
}

/**
 * The receipt.
 *
 * Every figure here is counted off the snapshot. "Verified" is the number of
 * commands that exited zero, which is the only claim the evidence actually
 * supports — a passing test count would have to be parsed out of arbitrary
 * stdout, and guessing wrong there is worse than not claiming it.
 */
function evidenceBlock(
  run: RunSnapshot,
  agent: AgentDefinition | null,
  id: string
): ThreadBlock {
  const verified = run.commandEvidence.filter(
    (evidence) => evidence.exitCode === 0
  ).length;
  const wall = spanBetween(run.startedAt ?? run.createdAt, run.completedAt);

  return {
    claim: run.output.trim(),
    id,
    kind: "evidence",
    meta: `run ${run.id.slice(0, 8)}`,
    provenance: [
      agent?.runtime ? `${agent.runtime} · ${agent.model}` : null,
      agent?.workspace ?? null,
      "1 run against the cap",
    ]
      .filter(Boolean)
      .join(" · "),
    stats: [
      { label: "Commands", value: String(run.commandEvidence.length) },
      { label: "Files", value: String(run.fileEvidence.length) },
      {
        label: "Exited 0",
        value: `${verified} of ${run.commandEvidence.length}`,
      },
      {
        label: "Wall clock",
        value: wall === null ? "—" : formatDuration(wall),
      },
    ],
    touched: run.fileEvidence,
  };
}

const EXPANDED_LINES = 5;

function expandedLines(source: string): string[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, EXPANDED_LINES);
}

function stepFor(block: ThreadBlock): Step | null {
  const duration =
    "durationMs" in block && block.durationMs !== null
      ? formatDuration(block.durationMs)
      : "—";

  switch (block.kind) {
    case "mission":
      return null;
    case "lifecycle":
      return {
        blockId: block.id,
        detail: block.detail ?? "",
        duration,
        expanded: [],
        id: block.id,
        label: block.label,
        tone: block.status === "running" ? "running" : "muted",
      };
    case "command": {
      // The result, not the invocation: the label already names what ran, so
      // the detail line is the one place the step can say what came back.
      // Falls back to the command for a tool that produced no output.
      const outcome =
        block.stdout.trim().split("\n", 1)[0] ||
        block.stderr.trim().split("\n", 1)[0] ||
        block.command;
      return {
        blockId: block.id,
        detail: outcome,
        duration,
        expanded: expandedLines(
          block.exitCode !== null && block.exitCode !== 0 && block.stderr
            ? block.stderr
            : block.stdout || block.stderr
        ),
        id: block.id,
        label: `Ran ${commandHead(block.command)}`,
        tone: commandExitTone(block.exitCode),
      };
    }
    case "files": {
      const paths = block.files.map((file) => file.path);
      return {
        blockId: block.id,
        detail: paths.join(", "),
        duration,
        expanded:
          paths.length > EXPANDED_LINES
            ? [
                ...paths.slice(0, EXPANDED_LINES - 1),
                `+${paths.length - (EXPANDED_LINES - 1)} more`,
              ]
            : paths,
        id: block.id,
        label: block.label,
        tone: "muted",
      };
    }
    case "text": {
      const lines = block.text
        .trim()
        .split("\n")
        .filter((line) => line.trim());
      const first = lines[0] ?? "";
      return {
        blockId: block.id,
        // The first line plus how much sits behind it, so a one-word
        // acknowledgement and a twelve-paragraph survey read differently in
        // the rail without either being expanded.
        detail: lines.length > 1 ? `${first} · ${lines.length} lines` : first,
        duration,
        expanded: lines.slice(0, EXPANDED_LINES),
        id: block.id,
        label: block.live ? "Reporting" : "Reported",
        tone: block.live ? "running" : "muted",
      };
    }
    case "error":
      return {
        blockId: block.id,
        detail: block.message,
        duration: "—",
        expanded: expandedLines(block.details ?? ""),
        id: block.id,
        label: "Stopped",
        tone: "danger",
      };
    case "evidence":
      return {
        blockId: block.id,
        detail: "receipt written",
        duration: "—",
        expanded: block.stats.map((stat) => `${stat.label}: ${stat.value}`),
        id: block.id,
        label: "Closed",
        tone: "success",
      };
    default:
      return null;
  }
}

/**
 * The line in the running strip.
 *
 * Reads the last block rather than the last event so it agrees with what the
 * thread is showing; a stream that ends mid-command should say the command is
 * running, not that output arrived.
 */
function describeNow(blocks: ThreadBlock[], run: RunSnapshot | null): string {
  if (!run || isTerminal(run.status)) {
    return "";
  }
  if (run.status === "queued") {
    return "Waiting for a sandbox";
  }

  const last = blocks.at(-1);
  switch (last?.kind) {
    case "command":
      return last.live
        ? `Running ${commandHead(last.command)}`
        : `Ran ${commandHead(last.command)}`;
    case "files":
      return last.label;
    case "text":
      return "Writing the report";
    default:
      return "Working";
  }
}

export function projectRun(input: ProjectInput): RunProjection {
  const blocks = collectBlocks(input);
  const steps = blocks
    .map(stepFor)
    .filter((step): step is Step => step !== null);

  return { blocks, nowDoing: describeNow(blocks, input.run), steps };
}

export { commandHead, commandSummary };
