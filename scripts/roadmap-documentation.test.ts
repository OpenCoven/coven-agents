import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, repositoryRoot), "utf8");
}

test("the current-state snapshot covers merged product and planning surfaces", () => {
  const currentState = read("docs/roadmap/current-state.md");

  assert.match(currentState, /Snapshot date: 2026-09-01/u);
  assert.match(
    currentState,
    /Application baseline: `3ad1232f061b5eaf4440b6fd3c7c13967a6c423f`/u
  );

  for (const evidence of [
    "Console workspace",
    "lib/console/agent-profile.ts",
    "Subscription authority",
    "lib/billing/checkout-lease.ts",
    "Subscription surfaces",
    "components/billing/subscription-card.tsx",
    "Credential authorization",
    "lib/credentials/device-poll-commit.ts",
    "Credential custody",
    "lib/runner/daytona/process.ts",
    "Guest replay",
    "tests/e2e/demo-adversarial.test.ts",
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

  assert.match(matrix, /as of 2026-09-01/u);
  assert.match(
    matrix,
    /application baseline `3ad1232f061b5eaf4440b6fd3c7c13967a6c423f`/u
  );

  for (const capability of [
    "Console profile execution",
    "Paid subscription authority",
    "Subscriber checkout surfaces",
    "Credential authorization lifecycle",
    "Coordinated team execution",
    "Guest replay",
    "Hermetic PostgreSQL browser certification",
    "Planning document registry",
    "Vercel Git deployment disablement",
  ]) {
    assert.match(matrix, new RegExp(`\\| ${capability} \\| \`Verified\``, "u"));
  }
});

test("the cutover attestation matches the exact preview receipt", () => {
  const attestation = read("docs/operations/daytona-cutover-attestation.md");
  const receipt = JSON.parse(
    read("docs/operations/p0-exact-preview-receipt-2026-09-01.json")
  );

  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.deployment.staticGenerationCount, 42);
  assert.equal(receipt.containsCredentialMaterial, false);
  assert.equal(receipt.providerLifecycleCertified, false);

  for (const value of [
    receipt.deployment.id,
    receipt.deployment.sourceCommit,
    receipt.deployment.sourceTree,
    ...receipt.deployment.requiredRoutes,
  ]) {
    if (value) {
      assert.match(attestation, new RegExp(value.replaceAll("/", "\\/"), "u"));
    }
  }

  assert.match(
    attestation,
    new RegExp(
      `static-generation count: \`${receipt.deployment.staticGenerationCount}\``,
      "u"
    )
  );
  assert.match(attestation, /Credential material retained: `no`/u);
  assert.match(attestation, /Provider lifecycle certified: `no`/u);

  const checks = receipt.checks as {
    outcome: string;
    requestId?: string;
    retryable?: boolean;
    route: string;
    status: number;
  }[];
  assert.deepEqual(
    checks.map((check) => check.route),
    [
      "/api/health",
      "/api/agents",
      "/api/diagnostics/sandbox",
      "/api/internal/runner-resource-inventory",
    ]
  );

  const expectedRows = checks.map((check) => {
    const requestId = check.requestId ? `\`${check.requestId}\`` : "n/a";
    const retryable =
      check.retryable === undefined ? "n/a" : check.retryable ? "yes" : "no";
    return `| \`${check.route}\` | ${check.status} | \`${check.outcome}\` | ${requestId} | ${retryable} |`;
  });
  const attestationRows = attestation
    .split("\n")
    .filter((line) => line.startsWith("| `/api/"));
  assert.deepEqual(attestationRows, expectedRows);
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
