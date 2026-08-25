/**
 * Agent templates, and the formations that group them.
 *
 * **These agents do not talk to each other.** Nothing in this system
 * orchestrates one agent into another: a run executes one definition's
 * instructions against one task in its own sandbox, and there is no handoff,
 * delegation, or dependency between them. A formation is therefore a
 * complementary *set* you dispatch individually, not a pipeline — calling it
 * a crew is a description of what the members are for, not a claim that they
 * coordinate.
 *
 * That distinction is worth keeping honest in the naming, because a UI that
 * implied collaboration would send someone looking for a handoff that does
 * not exist.
 */
export type AgentTemplate = {
  /** What this member is for, shown under its name. */
  blurb: string;
  id: string;
  instructions: string;
  name: string;
};

export type Formation = {
  blurb: string;
  id: string;
  members: readonly AgentTemplate[];
  name: string;
};

const SHARED_RULES = [
  "Work inside the provided workspace only.",
  "Prefer small, verifiable steps over large rewrites.",
  "Report concrete evidence: commands run, files touched, and what the output actually said.",
  "If the task is ambiguous, state the assumption you made rather than asking and stopping.",
].join(" ");

export const TEMPLATES: readonly AgentTemplate[] = [
  {
    blurb: "Surveys the workspace and reports. Changes nothing.",
    id: "scout",
    instructions:
      "You are a reconnaissance agent. Survey the workspace and report what you find: structure, entry points, risky or surprising code, and anything that looks unsafe or unfinished. " +
      "Make NO changes -- no edits, no new files, no commits. Your output is a report, not a diff. " +
      SHARED_RULES,
    name: "Scout",
  },
  {
    blurb: "Implements a described change, with a test proving it.",
    id: "builder",
    instructions:
      "You are an implementation agent. Make the requested change and prove it works. " +
      "Write or update a test that fails before your change and passes after it, and say explicitly which test that is. " +
      "Do not expand scope: implement what was asked and nothing adjacent. " +
      SHARED_RULES,
    name: "Builder",
  },
  {
    blurb: "Argues against the change. Tries to find what breaks.",
    id: "critic",
    instructions:
      "You are an adversarial reviewer. Your job is to find what is wrong, not to approve. " +
      "For each concern, give a concrete failure scenario: specific inputs or state, and the wrong output or crash that results. " +
      "Discard anything you cannot make concrete -- a vague worry is not a finding. If the work is sound, say so plainly and stop. " +
      SHARED_RULES,
    name: "Critic",
  },
  {
    blurb: "Writes the failing test first, then makes it pass.",
    id: "tester",
    instructions:
      "You are a test-first agent. Write a test that fails for the right reason before writing any implementation, and show the failure output. " +
      "Then make it pass with the smallest change that does so. " +
      "A test that passes before your change proves nothing -- if that happens, say so and fix the test rather than the code. " +
      SHARED_RULES,
    name: "Tester",
  },
  {
    blurb: "Brings documentation back in line with the code.",
    id: "scribe",
    instructions:
      "You are a documentation agent. Find where the documentation and the code disagree, and correct the documentation to match what the code actually does. " +
      "Verify each claim against the source before rewriting it; do not restate intentions the code does not implement. " +
      "Where a document instructs someone to do something the code no longer supports, say so explicitly rather than quietly deleting it. " +
      SHARED_RULES,
    name: "Scribe",
  },
];

export const FORMATIONS: readonly Formation[] = [
  {
    blurb: "Survey, build, then argue against it. A change you can defend.",
    id: "change-crew",
    members: pick("scout", "builder", "critic"),
    name: "Change crew",
  },
  {
    blurb:
      "Test-first, then adversarial review. For work that must not regress.",
    id: "hardening-crew",
    members: pick("tester", "critic"),
    name: "Hardening crew",
  },
  {
    blurb: "Read the code, then make the docs tell the truth about it.",
    id: "docs-crew",
    members: pick("scout", "scribe"),
    name: "Docs crew",
  },
];

function pick(...ids: readonly string[]): readonly AgentTemplate[] {
  return ids.map((id) => {
    const template = TEMPLATES.find((entry) => entry.id === id);

    if (!template) {
      // A formation naming a template that does not exist would create fewer
      // agents than it promised, silently.
      throw new Error(`Formation references unknown template: ${id}`);
    }

    return template;
  });
}

/**
 * Names the agents a formation will create.
 *
 * Suffixed so two formations sharing a member do not collide into one agent,
 * and so the list reads as a set rather than as unrelated agents that happen
 * to exist.
 */
export function memberName(
  formation: Formation,
  template: AgentTemplate
): string {
  return `${template.name} · ${formation.name}`;
}
