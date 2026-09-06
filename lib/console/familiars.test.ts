import assert from "node:assert/strict";
import test from "node:test";
import { TEMPLATES } from "@/lib/agents/formations";
import { familiarForProfileId, resolveFamiliarProfileId } from "./familiars";

test("every built-in profile has a distinct familiar", () => {
  const familiars = TEMPLATES.map((template) =>
    familiarForProfileId(template.id)
  );

  assert.ok(familiars.every((familiar) => familiar !== null));
  assert.equal(
    new Set(familiars.map((familiar) => familiar?.name)).size,
    TEMPLATES.length
  );
  assert.equal(
    new Set(familiars.map((familiar) => familiar?.species)).size,
    TEMPLATES.length
  );
});

test("custom profiles receive the neutral unbound familiar", () => {
  assert.deepEqual(familiarForProfileId("custom"), {
    name: "Unbound",
    profileId: "custom",
    species: "moonstone cat",
  });
  assert.equal(familiarForProfileId("unknown"), null);
});

test("explicit familiar selections override automatic role matching", () => {
  assert.equal(resolveFamiliarProfileId("builder", "auto"), "builder");
  assert.equal(resolveFamiliarProfileId("builder", "scribe"), "scribe");
  assert.equal(resolveFamiliarProfileId("unknown", "auto"), "custom");
});
