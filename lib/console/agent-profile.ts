import type { AgentDefinition } from "@opencoven/agent-contracts";
import { type AgentTemplate, TEMPLATES } from "@/lib/agents/formations";

export type ExecutionProfile = Readonly<{
  composerGuidance: string;
  id: string;
  label: string;
  mode: string;
  outcome: string;
  prompts: readonly [string, string, string];
  purpose: string;
  safetyNote: string;
}>;

type RoleProfile = Omit<ExecutionProfile, "purpose">;

const ROLE_PROFILES: Readonly<Record<string, RoleProfile>> = {
  builder: {
    composerGuidance:
      "Define the bounded change and the evidence Builder must return: Working change and focused proof.",
    id: "builder",
    label: "Builder",
    mode: "Can edit",
    outcome: "Working change and focused proof",
    prompts: [
      "Implement the highest-impact pending change and prove it with a focused test.",
      "Fix one concrete bug in the current workspace without expanding scope.",
      "Ship a small usability improvement and verify the existing behavior still works.",
    ],
    safetyNote:
      "Builder may edit workspace files and must prove the requested change with focused verification.",
  },
  critic: {
    composerGuidance:
      "Define what Critic should challenge and the evidence it must return: Concrete failure scenarios.",
    id: "critic",
    label: "Critic",
    mode: "Report only",
    outcome: "Concrete failure scenarios",
    prompts: [
      "Review the latest changes and report only concrete regressions with failure scenarios.",
      "Try to break the most important workflow with adversarial edge cases.",
      "Audit the current workspace for security, data-loss, and isolation risks.",
    ],
    safetyNote:
      "Critic reports concrete findings by contract and is instructed not to modify the workspace.",
  },
  scout: {
    composerGuidance:
      "Define what Scout should investigate and the evidence it must return: Findings and risks.",
    id: "scout",
    label: "Scout",
    mode: "Report only",
    outcome: "Findings and risks",
    prompts: [
      "Map the repository architecture and identify the three riskiest boundaries.",
      "Find unfinished or fragile areas and rank them by likely impact.",
      "Trace one important workflow from entry point to persistence and report what can fail.",
    ],
    safetyNote:
      "Scout reports what it finds by contract and is instructed not to modify the workspace.",
  },
  scribe: {
    composerGuidance:
      "Define the documentation truth Scribe must establish: Source-backed documentation update.",
    id: "scribe",
    label: "Scribe",
    mode: "Can edit docs",
    outcome: "Source-backed documentation update",
    prompts: [
      "Audit the documentation against current behavior and correct the highest-impact drift.",
      "Verify the setup instructions from a clean start and fix anything misleading.",
      "Document one important workflow with source-backed examples and failure guidance.",
    ],
    safetyNote:
      "Scribe may edit documentation and must verify every changed claim against source behavior.",
  },
  tester: {
    composerGuidance:
      "Define the behavior Tester must reproduce and prove: Failing-first test and fix.",
    id: "tester",
    label: "Tester",
    mode: "Can edit",
    outcome: "Failing-first test and fix",
    prompts: [
      "Reproduce one user-visible bug with a failing test, then make the smallest fix.",
      "Find the highest-risk untested behavior and add focused regression coverage.",
      "Stress one critical workflow with edge cases and report the exact failures.",
    ],
    safetyNote:
      "Tester may edit tests and implementation only after reproducing the requested behavior with a failing test.",
  },
};

const CUSTOM_PROFILE: ExecutionProfile = {
  composerGuidance:
    "Define the outcome and evidence this custom profile must return: Evidence required by the stored contract.",
  id: "custom",
  label: "Custom contract",
  mode: "Contract defined",
  outcome: "Evidence required by the stored contract",
  prompts: [
    "Inspect the current workspace and recommend the highest-impact next action with evidence.",
    "Complete one bounded improvement that fits this profile and verify the outcome.",
    "Review the current state for one concrete risk, then explain how to address it.",
  ],
  purpose: "Runs the operating contract stored on this profile.",
  safetyNote:
    "This profile follows its stored operating contract and the permissions granted by its selected runtime.",
};

export function templateForAgent(
  agent: Pick<AgentDefinition, "instructions">
): AgentTemplate | null {
  return (
    TEMPLATES.find(
      (candidate) => agent.instructions === candidate.instructions
    ) ?? null
  );
}

export function executionProfileForTemplate(
  template: AgentTemplate
): ExecutionProfile {
  const profile = ROLE_PROFILES[template.id];
  if (!profile) {
    throw new Error(`Missing execution profile metadata: ${template.id}`);
  }
  return { ...profile, purpose: template.blurb };
}

export function executionProfileForAgent(
  agent: Pick<AgentDefinition, "description" | "instructions" | "name">
): ExecutionProfile {
  const template = templateForAgent(agent);
  return template ? executionProfileForTemplate(template) : CUSTOM_PROFILE;
}
