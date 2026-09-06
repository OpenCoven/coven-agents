import assert from "node:assert/strict";
import test from "node:test";
import { TEMPLATES } from "@/lib/agents/formations";
import { familiarForProfileId } from "./familiars";

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

test("custom profiles keep the lightweight initial fallback", () => {
  assert.equal(familiarForProfileId("custom"), null);
  assert.equal(familiarForProfileId("unknown"), null);
});
