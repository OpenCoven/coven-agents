import { isAbsolute, relative, resolve } from "node:path";
import { GITHUB_TOOL_SERVER_DEADLINE_MS } from "@opencoven/agent-contracts";
import { type HarnessSpec, harnessSpec } from "./registry";

export interface Invocation {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
}

export type HarnessExecutionPermission =
  | "unrestricted"
  | "workspace_read"
  | "workspace_write"
  | "github_only";
export const COVEN_GITHUB_TOOL_PATH = "/tmp/coven-tools/v1/coven-github";
export const COVEN_GITHUB_MCP_PATH = "/tmp/coven-tools/v1/coven-github-mcp";
export const COVEN_GITHUB_MCP_MODEL_TOOL = "CovenGitHub-execute";
export const COVEN_GITHUB_MCP_PERMISSION = "CovenGitHub(execute)";
export const COVEN_GITHUB_MCP_TIMEOUT_MS =
  GITHUB_TOOL_SERVER_DEADLINE_MS + 25_000;

function environmentReference(name: string): string {
  return `\${${name}}`;
}

export const COVEN_GITHUB_CAPABILITY_ENV_REFERENCE = environmentReference(
  "COVEN_GITHUB_CAPABILITY"
);
export const COVEN_GITHUB_TOOL_URL_ENV_REFERENCE = environmentReference(
  "COVEN_GITHUB_TOOL_URL"
);

export interface InvocationRequest {
  /** Guaranteed-empty, non-workspace working directory for restricted runs. */
  attemptDir?: string;
  /** Fresh configuration directory outside caller-controlled workspace files. */
  configDir?: string;
  /** Working directory the harness runs in. Callers resolve and sandbox this. */
  cwd: string;
  /** Expose only the server-brokered coven-github executable. */
  githubTool?: boolean;
  harness: string;
  instructions: string;
  /** `auto` lets the harness pick, so no `--model` flag is passed. */
  model: string;
  /** Restrict tools for tasks that must not inherit broad harness authority. */
  permissionMode?: HarnessExecutionPermission;
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

function containsPath(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function copilotArgs(request: InvocationRequest): string[] {
  const permissionMode = request.permissionMode ?? "unrestricted";
  const restricted = permissionMode !== "unrestricted";
  const workspaceRestricted =
    permissionMode === "workspace_read" || permissionMode === "workspace_write";
  const githubTool = request.githubTool ?? false;
  if (githubTool && permissionMode === "unrestricted") {
    throw new Error(
      "A restricted GitHub tool cannot be added to unrestricted execution."
    );
  }
  if (permissionMode === "github_only" && !githubTool) {
    throw new Error("GitHub-only execution requires the typed GitHub tool.");
  }
  if ((restricted || githubTool) && !request.configDir) {
    throw new Error(
      "Restricted Copilot runs require an isolated config directory."
    );
  }
  if (
    restricted &&
    (!request.attemptDir ||
      !request.configDir ||
      !isAbsolute(request.attemptDir) ||
      !isAbsolute(request.configDir) ||
      !isAbsolute(request.cwd) ||
      containsPath(request.cwd, request.attemptDir) ||
      containsPath(request.attemptDir, request.cwd) ||
      containsPath(request.cwd, request.configDir) ||
      containsPath(request.configDir, request.cwd) ||
      containsPath(request.configDir, request.attemptDir) ||
      containsPath(request.attemptDir, request.configDir))
  ) {
    throw new Error(
      "Restricted Copilot runs require an isolated attempt directory."
    );
  }
  const availableTools =
    permissionMode === "workspace_read"
      ? ["view", "grep", "glob"]
      : permissionMode === "workspace_write"
        ? ["view", "edit", "grep", "glob"]
        : permissionMode === "github_only"
          ? []
          : null;
  if (githubTool) {
    availableTools?.push(COVEN_GITHUB_MCP_MODEL_TOOL);
  }
  const permissionArgs =
    availableTools === null
      ? ["--yolo"]
      : [
          "--available-tools",
          availableTools.join(","),
          ...(permissionMode === "workspace_write"
            ? ["--allow-tool", "write"]
            : []),
          ...(githubTool ? ["--allow-tool", COVEN_GITHUB_MCP_PERMISSION] : []),
        ];
  const restrictedArgs = restricted
    ? [
        "--disable-builtin-mcps",
        "--no-custom-instructions",
        "--disallow-temp-dir",
        "--no-bash-env",
        "--secret-env-vars",
        "COPILOT_GITHUB_TOKEN",
      ]
    : [];
  const configArgs = request.configDir
    ? ["--config-dir", request.configDir]
    : [];
  const directoryArgs = restricted
    ? [
        "-C",
        request.attemptDir as string,
        ...(workspaceRestricted ? ["--add-dir", request.cwd] : []),
      ]
    : [];
  const mcpArgs = githubTool
    ? [
        "--additional-mcp-config",
        JSON.stringify({
          mcpServers: {
            CovenGitHub: {
              args: [],
              command: COVEN_GITHUB_MCP_PATH,
              env: {
                COVEN_GITHUB_CAPABILITY: COVEN_GITHUB_CAPABILITY_ENV_REFERENCE,
                COVEN_GITHUB_TOOL_URL: COVEN_GITHUB_TOOL_URL_ENV_REFERENCE,
              },
              timeout: COVEN_GITHUB_MCP_TIMEOUT_MS,
              tools: ["execute"],
              type: "local",
            },
          },
        }),
      ]
    : [];
  return [
    "-s",
    "-p",
    buildMission(request.instructions, request.task),
    ...permissionArgs,
    "--no-ask-user",
    ...configArgs,
    ...directoryArgs,
    ...mcpArgs,
    ...restrictedArgs,
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
  const permissionMode = request.permissionMode ?? "unrestricted";
  if (
    (permissionMode !== "unrestricted" || request.githubTool) &&
    spec.id !== "copilot"
  ) {
    throw new Error(
      `${spec.label} cannot enforce ${permissionMode} permissions.`
    );
  }
  return {
    args: build(request),
    command: spec.command,
    cwd:
      permissionMode === "unrestricted"
        ? request.cwd
        : (request.attemptDir as string),
  };
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
