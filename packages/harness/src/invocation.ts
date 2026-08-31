import { type HarnessSpec, harnessSpec } from "./registry";

export interface Invocation {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
}

export interface InvocationRequest {
  /** Working directory the harness runs in. Callers resolve and sandbox this. */
  cwd: string;
  harness: string;
  instructions: string;
  /** `auto` lets the harness pick, so no `--model` flag is passed. */
  model: string;
  /** Restrict tools for tasks that must not inherit broad harness authority. */
  permissionMode?: "unrestricted" | "workspace";
  /** Ask for the harness's structured event stream instead of a text blob. */
  stream?: boolean;
  task: string;
}

export function buildMission(instructions: string, task: string): string {
  return `${instructions}\n\nMission:\n${task}`;
}

function modelArgs(model: string): string[] {
  return model === "auto" ? [] : ["--model", model];
}

function copilotArgs(request: InvocationRequest): string[] {
  const permissionArgs =
    request.permissionMode === "workspace"
      ? [
          "--available-tools",
          "view,edit,grep,glob",
          "--allow-tool",
          "read,write",
        ]
      : ["--yolo"];
  return [
    "-s",
    "-p",
    buildMission(request.instructions, request.task),
    ...permissionArgs,
    "--no-ask-user",
    "--no-auto-update",
    "--no-color",
    // JSONL carries tool calls, file writes and usage. Plain text collapses all
    // of that into one undifferentiated blob, so a live console asks for the
    // structured form.
    "--output-format",
    request.stream ? "json" : "text",
    "--log-level",
    "none",
    ...modelArgs(request.model),
  ];
}

function codexArgs(request: InvocationRequest): string[] {
  return [
    "exec",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "--color",
    "never",
    "-C",
    request.cwd,
    ...modelArgs(request.model),
    buildMission(request.instructions, request.task),
  ];
}

function claudeArgs(request: InvocationRequest): string[] {
  return [
    "-p",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
    "--output-format",
    "text",
    "--append-system-prompt",
    request.instructions,
    ...modelArgs(request.model),
    request.task,
  ];
}

const ARG_BUILDERS: Record<string, (request: InvocationRequest) => string[]> = {
  claude: claudeArgs,
  codex: codexArgs,
  copilot: copilotArgs,
};

/**
 * The single definition of how each harness is driven. Daytona launch paths
 * share this builder so the supported CLI subset cannot drift.
 */
export function buildInvocation(request: InvocationRequest): Invocation {
  const spec: HarnessSpec | null = harnessSpec(request.harness);
  const build = spec ? ARG_BUILDERS[spec.id] : undefined;
  if (!(spec && build)) {
    throw new Error(`Unsupported harness: ${request.harness}`);
  }
  return { args: build(request), command: spec.command, cwd: request.cwd };
}

/**
 * POSIX single-quote escaping. The sandbox SDK's `exec` accepts one command
 * string rather than an argv array, so a mission containing quotes, newlines or
 * `$(...)` would otherwise be re-parsed by the shell and could execute.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function toShellCommand(invocation: Invocation): string {
  return [invocation.command, ...invocation.args].map(shellQuote).join(" ");
}
