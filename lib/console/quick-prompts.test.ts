import assert from "node:assert/strict";
import test from "node:test";
import type { AgentDefinition } from "@opencoven/agent-contracts";
import { TEMPLATES } from "@/lib/agents/formations";
import { quickPromptsForAgent } from "./quick-prompts";

const BASE_AGENT: AgentDefinition = {
  backend: "cloud",
  createdAt: "2026-08-30T12:00:00.000Z",
  description: "",
  familiarId: "auto",
  id: "11111111-1111-4111-8111-111111111111",
  instructions: "Custom operating contract.",
  lastRunAt: null,
  model: "auto",
  name: "Custom agent",
  owner: { kind: "tenant", tenantId: "tenant-a" },
  runtime: "copilot",
  status: "idle",
  updatedAt: "2026-08-30T12:00:00.000Z",
  warm: {
    status: "ready",
    updatedAt: "2026-08-30T12:00:00.000Z",
  },
  workspace: "/workspace",
};

test("offers reconnaissance prompts for a scout profile", () => {
  const scout = TEMPLATES.find((template) => template.id === "scout");
  assert.ok(scout);

  assert.deepEqual(
    quickPromptsForAgent({
      ...BASE_AGENT,
      description: scout.blurb,
      instructions: scout.instructions,
      name: scout.name,
    }),
    [
      "Map the repository architecture and identify the three riskiest boundaries.",
      "Find unfinished or fragile areas and rank them by likely impact.",
      "Trace one important workflow from entry point to persistence and report what can fail.",
    ]
  );
});

test("offers implementation prompts for a renamed builder profile", () => {
  const builder = TEMPLATES.find((template) => template.id === "builder");
  assert.ok(builder);

  assert.deepEqual(
    quickPromptsForAgent({
      ...BASE_AGENT,
      instructions: builder.instructions,
      name: "Scout",
    }),
    [
      "Implement the highest-impact pending change and prove it with a focused test.",
      "Fix one concrete bug in the current workspace without expanding scope.",
      "Ship a small usability improvement and verify the existing behavior still works.",
    ]
  );
});

test("offers bounded generic prompts for a custom profile", () => {
  const prompts = quickPromptsForAgent({
    ...BASE_AGENT,
    name: "Builder",
  });

  assert.equal(prompts.length, 3);
  assert.ok(prompts.every((prompt) => prompt.length >= 12));
  assert.equal(
    JSON.stringify(prompts).includes(BASE_AGENT.instructions),
    false
  );
});
