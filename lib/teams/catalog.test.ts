import assert from "node:assert/strict";
import test from "node:test";
import { TEMPLATES } from "@/lib/agents/formations";
import { BUILT_IN_SKILLS, builtInSkill, GITHUB_DELIVERY_TEAM } from "./catalog";

test("GitHub delivery omits Project writes until exact user management authority is provable", () => {
  assert.deepEqual(
    GITHUB_DELIVERY_TEAM.members.map(({ name }) => name),
    ["Issue Triage", "Builder", "PR Shepherd", "Critic"]
  );
  assert.deepEqual(
    GITHUB_DELIVERY_TEAM.members.map(({ agentTemplateId }) => agentTemplateId),
    ["scout", "builder", "builder", "critic"]
  );
  assert.equal(
    BUILT_IN_SKILLS.some(({ id }) => id === "github-project-update"),
    false
  );
});

test("every built-in team member references known templates and skills", () => {
  const templateIds = new Set(TEMPLATES.map(({ id }) => id));
  const skillIds = new Set(BUILT_IN_SKILLS.map(({ id }) => id));

  for (const member of GITHUB_DELIVERY_TEAM.members) {
    assert.equal(templateIds.has(member.agentTemplateId), true);
    assert.equal(member.skillIds.length > 0, true);
    assert.equal(
      member.skillIds.every((id) => skillIds.has(id)),
      true
    );
  }
});

test("GitHub write skills declare explicit write capabilities", () => {
  const implementation = builtInSkill("repository-implementation");
  assert.deepEqual(implementation.requiredCapabilities, [
    "workspace.read",
    "workspace.write",
    "github.contents.write",
    "github.pull_requests.read",
    "github.pull_requests.write",
  ]);
  assert.match(implementation.instructions, /repository\.commit/u);
  assert.match(implementation.instructions, /never request or expose.*token/iu);
  assert.deepEqual(builtInSkill("github-pr-delivery").requiredCapabilities, [
    "workspace.read",
    "github.pull_requests.read",
    "github.pull_requests.write",
  ]);
  assert.throws(
    () => builtInSkill("github-project-update"),
    /Unknown built-in team skill/u
  );
});

test("built-in skill lookup fails closed for an unknown id", () => {
  assert.throws(
    () => builtInSkill("unknown"),
    /Unknown built-in team skill: unknown/u
  );
});
