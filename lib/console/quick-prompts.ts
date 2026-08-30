import type { AgentDefinition } from "@opencoven/agent-contracts";
import { TEMPLATES } from "@/lib/agents/formations";

const ROLE_PROMPTS: Readonly<Record<string, readonly string[]>> = {
  builder: [
    "Implement the highest-impact pending change and prove it with a focused test.",
    "Fix one concrete bug in the current workspace without expanding scope.",
    "Ship a small usability improvement and verify the existing behavior still works.",
  ],
  critic: [
    "Review the latest changes and report only concrete regressions with failure scenarios.",
    "Try to break the most important workflow with adversarial edge cases.",
    "Audit the current workspace for security, data-loss, and isolation risks.",
  ],
  scout: [
    "Map the repository architecture and identify the three riskiest boundaries.",
    "Find unfinished or fragile areas and rank them by likely impact.",
    "Trace one important workflow from entry point to persistence and report what can fail.",
  ],
  scribe: [
    "Audit the documentation against current behavior and correct the highest-impact drift.",
    "Verify the setup instructions from a clean start and fix anything misleading.",
    "Document one important workflow with source-backed examples and failure guidance.",
  ],
  tester: [
    "Reproduce one user-visible bug with a failing test, then make the smallest fix.",
    "Find the highest-risk untested behavior and add focused regression coverage.",
    "Stress one critical workflow with edge cases and report the exact failures.",
  ],
};

const CUSTOM_PROMPTS = [
  "Inspect the current workspace and recommend the highest-impact next action with evidence.",
  "Complete one bounded improvement that fits this profile and verify the outcome.",
  "Review the current state for one concrete risk, then explain how to address it.",
] as const;

function templateIdFor(agent: AgentDefinition): string | null {
  const template = TEMPLATES.find(
    (candidate) => agent.instructions === candidate.instructions
  );
  return template?.id ?? null;
}

export function quickPromptsForAgent(
  agent: AgentDefinition
): readonly string[] {
  const templateId = templateIdFor(agent);
  return templateId
    ? (ROLE_PROMPTS[templateId] ?? CUSTOM_PROMPTS)
    : CUSTOM_PROMPTS;
}
