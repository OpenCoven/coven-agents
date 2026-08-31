import assert from "node:assert/strict";
import test from "node:test";
import type { AgentDefinition } from "@opencoven/agent-contracts";
import { TEMPLATES } from "@/lib/agents/formations";
import { executionProfileForAgent } from "./agent-profile";

const BASE_AGENT: AgentDefinition = {
  backend: "cloud",
  createdAt: "2026-08-30T12:00:00.000Z",
  description: "",
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

const EXPECTED = {
  builder: {
    mode: "Can edit",
    outcome: "Working change and focused proof",
  },
  critic: {
    mode: "Report only",
    outcome: "Concrete failure scenarios",
  },
  scout: {
    mode: "Report only",
    outcome: "Findings and risks",
  },
  scribe: {
    mode: "Can edit docs",
    outcome: "Source-backed documentation update",
  },
  tester: {
    mode: "Can edit",
    outcome: "Failing-first test and fix",
  },
} as const;

test("every built-in role has complete selection and run guidance", () => {
  for (const template of TEMPLATES) {
    const profile = executionProfileForAgent({
      ...BASE_AGENT,
      description: template.blurb,
      instructions: template.instructions,
      name: template.name,
    });
    const expected = EXPECTED[template.id as keyof typeof EXPECTED];

    assert.equal(profile.id, template.id);
    assert.equal(profile.label, template.name);
    assert.equal(profile.mode, expected.mode);
    assert.equal(profile.outcome, expected.outcome);
    assert.equal(profile.purpose, template.blurb);
    assert.equal(profile.prompts.length, 3);
    assert.ok(profile.prompts.every((prompt) => prompt.length >= 12));
    assert.ok(profile.composerGuidance.includes(expected.outcome));
    assert.ok(profile.safetyNote.length >= 20);
  }
});

test("renamed and crew-suffixed built-ins retain their operating role", () => {
  const builder = TEMPLATES.find((template) => template.id === "builder");
  assert.ok(builder);

  for (const name of ["Release engineer", "Builder · Change crew"]) {
    const profile = executionProfileForAgent({
      ...BASE_AGENT,
      instructions: builder.instructions,
      name,
    });

    assert.equal(profile.id, "builder");
    assert.equal(profile.label, "Builder");
    assert.equal(profile.mode, "Can edit");
  }
});

test("custom profiles get neutral bounded guidance", () => {
  const profile = executionProfileForAgent(BASE_AGENT);

  assert.equal(profile.id, "custom");
  assert.equal(profile.label, "Custom contract");
  assert.equal(profile.mode, "Contract defined");
  assert.equal(profile.outcome, "Evidence required by the stored contract");
  assert.equal(profile.prompts.length, 3);
  assert.equal(
    JSON.stringify(profile).includes(BASE_AGENT.instructions),
    false
  );
});
