import "server-only";

import { generateText } from "ai";
import { titleModel } from "./models";
import { teamMissionPrompt } from "./prompts";
import { getTitleModel } from "./providers";

/**
 * Drafts the mission for a coordinated team run.
 *
 * The blank textarea was the real cost of starting a team run: a person had
 * to invent, unaided, the one instruction every member would read. This
 * writes a first draft from the team's own roster so the person edits
 * something concrete instead of facing an empty box. The draft is never
 * submitted on its own — it lands in the field, and a human still starts the
 * run — because a mission commits paid minutes.
 *
 * It reuses the small, fast model already wired for titles rather than
 * introducing a second model configuration for one short generation.
 */
export type TeamMissionMember = Readonly<{
  required: boolean;
  responsibility: string;
}>;

export type DraftTeamMissionInput = Readonly<{
  description: string;
  hint: string;
  members: readonly TeamMissionMember[];
  name: string;
}>;

const MAX_RESPONSIBILITY_CHARS = 400;
const MAX_MEMBERS = 12;

function roster(members: readonly TeamMissionMember[]): string {
  return members
    .slice(0, MAX_MEMBERS)
    .map((member, index) => {
      const responsibility = member.responsibility
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_RESPONSIBILITY_CHARS);
      return `${index + 1}. ${responsibility}${member.required ? "" : " (optional member)"}`;
    })
    .join("\n");
}

/** The model input, built from the team alone. Pure, so it is testable. */
export function teamMissionRequest(input: DraftTeamMissionInput): string {
  const hint = input.hint.replace(/\s+/g, " ").trim();
  return [
    `Team: ${input.name}`,
    input.description.trim() ? `Purpose: ${input.description.trim()}` : "",
    "Members, in the order they run:",
    roster(input.members),
    hint ? `What the person asked for: ${hint}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Strips the heading, quoting, and bullet noise a model adds unbidden. */
export function cleanDraftedMission(text: string): string {
  return text
    .replace(/^[#*\-\s"']+/, "")
    .replace(/["'\s]+$/, "")
    .trim();
}

export async function draftTeamMission(
  input: DraftTeamMissionInput,
  generate: typeof generateText = generateText
): Promise<string> {
  const { text } = await generate({
    instructions: teamMissionPrompt,
    model: getTitleModel(),
    prompt: teamMissionRequest(input),
    providerOptions: { gateway: { order: titleModel.gatewayOrder } },
  });
  return cleanDraftedMission(text);
}
