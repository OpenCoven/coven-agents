import { isAbsolute, relative, resolve } from "node:path";
import type { AgentDefinition } from "@opencoven/agent-contracts";

export interface Invocation {
  args: string[];
  command: string;
  cwd: string;
}

export function resolveWorkspace(root: string, requested?: string): string {
  const normalizedRoot = resolve(root);
  const workspace = resolve(normalizedRoot, requested || ".");
  const pathFromRoot = relative(normalizedRoot, workspace);
  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error("Workspace must stay inside OPENCOVEN_LOCAL_ROOT.");
  }
  return workspace;
}

export function buildInvocation(
  agent: AgentDefinition,
  task: string,
  root: string
): Invocation {
  const cwd = resolveWorkspace(root, agent.workspace);
  const mission = `${agent.instructions}\n\nMission:\n${task}`;
  const modelArgs = agent.model === "auto" ? [] : ["--model", agent.model];

  switch (agent.runtime) {
    case "copilot":
      return {
        args: [
          "-s",
          "-p",
          mission,
          "--yolo",
          "--no-ask-user",
          "--no-auto-update",
          "--output-format",
          "text",
          ...modelArgs,
        ],
        command: "copilot",
        cwd,
      };
    case "codex":
      return {
        args: [
          "exec",
          "--dangerously-bypass-approvals-and-sandbox",
          "--skip-git-repo-check",
          "--color",
          "never",
          "-C",
          cwd,
          ...modelArgs,
          mission,
        ],
        command: "codex",
        cwd,
      };
    case "claude":
      return {
        args: [
          "-p",
          "--dangerously-skip-permissions",
          "--no-session-persistence",
          "--output-format",
          "text",
          "--append-system-prompt",
          agent.instructions,
          ...modelArgs,
          task,
        ],
        command: "claude",
        cwd,
      };
    default:
      throw new Error(`Unsupported local runtime: ${agent.runtime}`);
  }
}
