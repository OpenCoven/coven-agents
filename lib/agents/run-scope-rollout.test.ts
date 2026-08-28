import assert from "node:assert/strict";
import test from "node:test";
import { runScopedIdentityWritesEnabled } from "./run-scope-rollout";

test("run-scoped identity writes require an explicit rollout flag", () => {
  assert.equal(runScopedIdentityWritesEnabled(undefined), false);
  assert.equal(runScopedIdentityWritesEnabled("false"), false);
  assert.equal(runScopedIdentityWritesEnabled("true"), true);
});
