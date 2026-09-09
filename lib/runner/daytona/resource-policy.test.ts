import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DAYTONA_PROVIDER_RESOURCE_MAXIMA,
  DAYTONA_SANDBOX_RESOURCE_POLICY_CAPS,
  DAYTONA_SANDBOX_RESOURCE_POLICY_DEFAULTS,
} from "./resource-policy";

test("public resource policy imports without server conditions or provider dependencies", () => {
  const source = readFileSync(
    new URL("./resource-policy.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /^\s*import\b/gmu);
  assert.doesNotMatch(source, /process\.env|server-only|@daytona\/sdk/u);
  assert.deepEqual(DAYTONA_SANDBOX_RESOURCE_POLICY_DEFAULTS, {
    autoArchiveInterval: 10_080,
    autoStopInterval: 15,
    cpu: 2,
    disk: 10,
    memory: 4,
  });
  assert.ok(Object.isFrozen(DAYTONA_SANDBOX_RESOURCE_POLICY_DEFAULTS));
  for (const field of ["cpu", "disk", "memory"] as const) {
    assert.ok(
      DAYTONA_SANDBOX_RESOURCE_POLICY_DEFAULTS[field] <=
        DAYTONA_SANDBOX_RESOURCE_POLICY_CAPS[field]
    );
    assert.equal(
      DAYTONA_SANDBOX_RESOURCE_POLICY_CAPS[field],
      DAYTONA_PROVIDER_RESOURCE_MAXIMA[field]
    );
  }
});
