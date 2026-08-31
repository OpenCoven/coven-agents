import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, repositoryRoot), "utf8");
}

test("the current-state snapshot covers merged product and planning surfaces", () => {
  const currentState = read("docs/roadmap/current-state.md");

  assert.match(currentState, /Snapshot date: 2026-08-31/u);
  assert.match(
    currentState,
    /Application baseline: `f211e49eb2c633759c63e1cb077a9e44e5bdc172`/u
  );

  for (const evidence of [
    "Console workspace",
    "lib/console/agent-profile.ts",
    "Subscription authority",
    "lib/billing/checkout-lease.ts",
    "Coordinated teams",
    "lib/teams/",
    "Deployment posture",
    "docs/operations/vercel-git-deployment-disablement.md",
    "Planning documents",
    "scripts/planning-docs-policy.ts",
  ]) {
    assert.match(
      currentState,
      new RegExp(evidence.replaceAll("/", "\\/"), "u")
    );
  }

  assert.match(
    currentState,
    /private planning reconciliation remains\s+pending/iu
  );
});

test("the verification matrix records the newly verified repository boundaries", () => {
  const matrix = read("docs/roadmap/verification-matrix.md");

  assert.match(matrix, /as of 2026-08-31/u);
  assert.match(
    matrix,
    /application baseline `f211e49eb2c633759c63e1cb077a9e44e5bdc172`/u
  );

  for (const capability of [
    "Console profile execution",
    "Paid subscription authority",
    "Coordinated team execution",
    "Planning document registry",
    "Vercel Git deployment disablement",
  ]) {
    assert.match(matrix, new RegExp(`\\| ${capability} \\| \`Verified\``, "u"));
  }
});

test("release readiness separates infrastructure cutover from product approval", () => {
  const readiness = read("docs/roadmap/release-readiness.md");

  assert.match(
    readiness,
    /Infrastructure cutover is complete; full product release approval is\s+pending\./u
  );
  assert.match(
    readiness,
    /Git-triggered Vercel deployments remain intentionally disabled/u
  );
  assert.match(
    readiness,
    /private Beads-to-Project reconciliation has completed with\s+a final no-op preview/u
  );
  assert.match(readiness, /## Coordinated team execution/u);
  assert.match(readiness, /GitHub-capable steps fail closed/u);
});

test("the implementation sequence records its authority freshness boundary", () => {
  const sequence = read("docs/roadmap/implementation-sequence.md");

  assert.match(sequence, /Authority freshness/u);
  assert.match(sequence, /not reordered on 2026-08-31/u);
  assert.match(sequence, /private planning authority was unavailable/u);
});
