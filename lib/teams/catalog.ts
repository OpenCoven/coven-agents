import type { TeamCapability } from "@opencoven/agent-contracts";
import type { AgentTemplate } from "@/lib/agents/formations";

export type BuiltInTeamSkill = {
  description: string;
  id: string;
  instructions: string;
  name: string;
  requiredCapabilities: readonly TeamCapability[];
};

export type BuiltInTeamMember = {
  agentTemplateId: AgentTemplate["id"];
  name: string;
  required: boolean;
  responsibility: string;
  skillIds: readonly BuiltInTeamSkill["id"][];
};

export type BuiltInTeam = {
  description: string;
  id: string;
  members: readonly BuiltInTeamMember[];
  name: string;
};

export const BUILT_IN_SKILLS: readonly BuiltInTeamSkill[] = [
  {
    description:
      "Read issues, inspect repository context, and return an implementation-ready scope.",
    id: "github-issue-triage",
    instructions:
      "Inspect the named issue and relevant repository context. Return bounded scope, acceptance evidence, dependencies, and concrete risks without modifying GitHub or the workspace.",
    name: "GitHub issue triage",
    requiredCapabilities: ["workspace.read", "github.issues.read"],
  },
  {
    description:
      "Implement an approved issue scope and produce focused verification.",
    id: "repository-implementation",
    instructions:
      "Implement only the approved scope in the workspace. Add focused regression coverage, publish the changed files to an approved branch with the server-authorized repository.commit operation, and create the pull request when requested. Never request or expose a GitHub token.",
    name: "Repository implementation",
    requiredCapabilities: [
      "workspace.read",
      "workspace.write",
      "github.contents.write",
      "github.pull_requests.read",
      "github.pull_requests.write",
    ],
  },
  {
    description:
      "Create or update the pull request and communicate verified delivery evidence.",
    id: "github-pr-delivery",
    instructions:
      "Use the approved branch and sanitized implementation evidence to create or update the pull request. Never merge, delete branches, alter settings, or expand repository access.",
    name: "GitHub pull request delivery",
    requiredCapabilities: [
      "workspace.read",
      "github.pull_requests.read",
      "github.pull_requests.write",
    ],
  },
  {
    description:
      "Review the implementation and pull request for concrete regressions.",
    id: "github-pr-review",
    instructions:
      "Review the implementation and pull request evidence adversarially. Report only reproducible defects and post review feedback only when that operation is explicitly approved.",
    name: "GitHub pull request review",
    requiredCapabilities: [
      "workspace.read",
      "github.pull_requests.read",
      "github.pull_requests.write",
    ],
  },
];

export const GITHUB_DELIVERY_TEAM: BuiltInTeam = {
  description:
    "Moves an approved GitHub issue through implementation, pull request delivery, and review.",
  id: "github-delivery",
  members: [
    {
      agentTemplateId: "scout",
      name: "Issue Triage",
      required: true,
      responsibility:
        "Clarify the issue, repository context, dependencies, acceptance evidence, and bounded implementation scope.",
      skillIds: ["github-issue-triage"],
    },
    {
      agentTemplateId: "builder",
      name: "Builder",
      required: true,
      responsibility:
        "Implement the approved scope and return focused regression and build evidence.",
      skillIds: ["repository-implementation"],
    },
    {
      agentTemplateId: "builder",
      name: "PR Shepherd",
      required: true,
      responsibility:
        "Prepare the pull request from approved implementation evidence and maintain its delivery state.",
      skillIds: ["github-pr-delivery"],
    },
    {
      agentTemplateId: "critic",
      name: "Critic",
      required: true,
      responsibility:
        "Challenge the implementation and pull request with concrete failure scenarios.",
      skillIds: ["github-pr-review"],
    },
  ],
  name: "GitHub delivery team",
};

export function builtInSkill(id: string): BuiltInTeamSkill {
  const skill = BUILT_IN_SKILLS.find((candidate) => candidate.id === id);

  if (!skill) {
    throw new Error(`Unknown built-in team skill: ${id}`);
  }

  return skill;
}
