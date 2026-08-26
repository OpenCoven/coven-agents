import assert from "node:assert/strict";
import test from "node:test";
import { isAdminEmail } from "./access";
import { maskEmail } from "./directory";

test("an unset allowlist admits nobody", () => {
  assert.equal(isAdminEmail("val@opencoven.ai", undefined), false);
  assert.equal(isAdminEmail("val@opencoven.ai", ""), false);
  assert.equal(isAdminEmail("val@opencoven.ai", " , "), false);
});

test("matching is exact on the normalized address", () => {
  const list = "Val@OpenCoven.ai, other@example.com";
  assert.equal(isAdminEmail("val@opencoven.ai", list), true);
  assert.equal(isAdminEmail("  VAL@opencoven.AI ", list), true);
  assert.equal(isAdminEmail("other@example.com", list), true);
  // A substring must not admit — the classic suffix trick.
  assert.equal(isAdminEmail("val@opencoven.ai.attacker.test", list), false);
  assert.equal(isAdminEmail("xval@opencoven.ai", list), false);
  assert.equal(isAdminEmail(null, list), false);
  assert.equal(isAdminEmail("", list), false);
});

test("masked emails keep shape and lose the address", () => {
  assert.equal(maskEmail("val@opencoven.ai"), "v··@o··.ai");
  assert.equal(maskEmail("a@b.co"), "a··@b··.co");
  const masked = maskEmail("someone.long@sub.example.com");
  assert.ok(!masked.includes("someone"));
  assert.ok(!masked.includes("example"));
  assert.ok(masked.includes("@"));
});
