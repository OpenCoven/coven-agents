import assert from "node:assert/strict";
import test from "node:test";
import { FORMATIONS, memberName, TEMPLATES } from "./formations";

test("every formation member resolves to a real template", () => {
  // A formation naming a template that does not exist would create fewer
  // agents than it promised, silently. `pick` throws at module load, so
  // importing this file at all is most of the assertion.
  for (const formation of FORMATIONS) {
    assert.ok(formation.members.length > 0, `${formation.id} has no members`);

    for (const member of formation.members) {
      assert.ok(
        TEMPLATES.some((template) => template.id === member.id),
        `${formation.id} references ${member.id}`
      );
    }
  }
});

test("template ids are unique", () => {
  const ids = TEMPLATES.map((template) => template.id);

  assert.equal(new Set(ids).size, ids.length);
});

test("formation ids are unique", () => {
  const ids = FORMATIONS.map((formation) => formation.id);

  assert.equal(new Set(ids).size, ids.length);
});

test("member names are unique within a formation", () => {
  // Two members resolving to the same name would look like one agent that
  // failed to create rather than two that did.
  for (const formation of FORMATIONS) {
    const names = formation.members.map((member) =>
      memberName(formation, member)
    );

    assert.equal(new Set(names).size, names.length, formation.id);
  }
});

test("the same template in two formations yields distinct agents", () => {
  // Scout appears in more than one crew. Without the formation suffix both
  // would be called "Scout" and the second would look like a duplicate.
  const scout = TEMPLATES.find((template) => template.id === "scout");

  assert.ok(scout);

  const names = FORMATIONS.filter((formation) =>
    formation.members.some((member) => member.id === "scout")
  ).map((formation) => memberName(formation, scout));

  assert.ok(names.length > 1, "scout should appear in more than one formation");
  assert.equal(new Set(names).size, names.length);
});

test("every template carries usable instructions", () => {
  for (const template of TEMPLATES) {
    // Instructions are the entire behaviour of an agent. A short or empty one
    // produces an agent that does whatever the model felt like.
    assert.ok(
      template.instructions.length > 200,
      `${template.id} instructions are too thin`
    );
    assert.ok(template.blurb.length > 0, `${template.id} has no blurb`);
  }
});

test("the scout is told not to change anything", () => {
  // Its whole purpose is a survey. An agent that edits while reconnoitring
  // is a different and more dangerous thing than advertised.
  const scout = TEMPLATES.find((template) => template.id === "scout");

  assert.match(scout?.instructions ?? "", /Make NO changes/);
});

test("the critic is told to be concrete, not merely negative", () => {
  const critic = TEMPLATES.find((template) => template.id === "critic");

  assert.match(critic?.instructions ?? "", /concrete failure scenario/);
  assert.match(critic?.instructions ?? "", /If the work is sound, say so/);
});
