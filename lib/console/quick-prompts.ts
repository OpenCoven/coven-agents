import type { AgentDefinition } from "@opencoven/agent-contracts";
import { executionProfileForAgent } from "@/lib/console/agent-profile";

export function quickPromptsForAgent(
  agent: AgentDefinition
): readonly string[] {
  return executionProfileForAgent(agent).prompts;
}
