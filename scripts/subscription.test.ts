import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./subscription.ts", import.meta.url),
  "utf8"
);

test("subscription CLI delegates mutation to the audited server-only override module", () => {
  assert.match(source, /runSubscriptionCli/);
  assert.match(source, /databaseSubscriptionOverrideStore/);
  assert.match(source, /findSubscriptionOverrideUserByEmail/);
  assert.match(source, /applySubscriptionOverride/);
  assert.match(source, /readSubscriptionOverrideReference\(process\.stdin\)/);
  assert.doesNotMatch(source, /--reference(?:\s|["'])/);
  assert.doesNotMatch(source, /\.update\(user\)/);
  assert.doesNotMatch(source, /Sign out and back in/);
});
