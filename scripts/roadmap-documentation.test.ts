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
    /Application baseline: `4bf89dc98667efa1c46b5131e10d4b14bf5f86c3`/u
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
    /private planning\s+reconciliation remains\s+pending/iu
  );
});

test("the verification matrix records the newly verified repository boundaries", () => {
  const matrix = read("docs/roadmap/verification-matrix.md");

  assert.match(matrix, /as of 2026-09-01/u);
  assert.match(
    matrix,
    /application baseline `4bf89dc98667efa1c46b5131e10d4b14bf5f86c3`/u
  );
  assert.match(
    matrix,
    /Hermetic PostgreSQL browser certification.*application baseline `3ad1232f061b5eaf4440b6fd3c7c13967a6c423f`/u
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

  assert.deepEqual(receipt, {
    capturedAt: "2026-09-01",
    checks: [
      {
        apiVersion: "1.0",
        capabilities: [
          "agent-profiles",
          "async-runs",
          "idempotent-runs",
          "run-events",
          "run-cancel",
          "command-evidence",
          "file-evidence",
        ],
        minimumClientVersion: "1.0.0",
        mode: "cloud",
        route: "/api/health",
        status: 200,
      },
      {
        apiVersion: "1.0",
        outcome: "unauthorized",
        requestId: "e155ed8b-13eb-46b3-aa55-b9edb3044414",
        retryable: false,
        route: "/api/agents",
        status: 401,
      },
      {
        apiVersion: "1.0",
        outcome: "diagnostic_unavailable",
        requestId: "2be60f00-5882-4909-af1d-8f1de5c40695",
        retryable: true,
        route: "/api/diagnostics/sandbox",
        status: 503,
      },
      {
        apiVersion: "1.0",
        outcome: "reconcile_unavailable",
        requestId: "b091ba86-b3df-4cb0-be21-e13df7e0de45",
        retryable: true,
        route: "/api/internal/runner-resource-inventory",
        status: 503,
      },
    ],
    containsCredentialMaterial: false,
    deployment: {
      id: "dpl_83qug3pWqY3rHQRsJRcjYEABAaqo",
      requiredRoutes: [
        "/api/internal/runner-resource-inventory",
        "/api/internal/stripe-reconcile",
      ],
      sourceCommit: "52fe9f8a28b5b06099ad70c25eb6504d70597ee4",
      sourceTree: "28ec05d475ff8464a4fbe2f09e4416714fced78a",
      staticGenerationCount: 42,
    },
    providerLifecycleCertified: false,
    schemaVersion: 1,
  });

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
    apiVersion: string;
    capabilities?: string[];
    minimumClientVersion?: string;
    mode?: string;
    outcome?: string;
    requestId?: string;
    retryable?: boolean;
    route: string;
    status: number;
  }[];
  const expectedRows = checks.map((check) => {
    const requestId = check.requestId ? `\`${check.requestId}\`` : "n/a";
    const retryable =
      check.retryable === undefined ? "n/a" : check.retryable ? "yes" : "no";
    const result = check.outcome
      ? `apiVersion=${check.apiVersion}; error=${check.outcome}`
      : `apiVersion=${check.apiVersion}; mode=${check.mode}; minimumClientVersion=${check.minimumClientVersion}; capabilities=${check.capabilities?.length}`;
    return `| \`${check.route}\` | ${check.status} | \`${result}\` | ${requestId} | ${retryable} |`;
  });
  const attestationRows = attestation
    .split("\n")
    .filter((line) => line.startsWith("| `/api/"));
  assert.deepEqual(attestationRows, expectedRows);
});

test("the verification matrix matches the hermetic certification receipt", () => {
  const matrix = read("docs/roadmap/verification-matrix.md");
  const receipt = JSON.parse(
    read("docs/operations/p0-hermetic-receipt-2026-09-01.json")
  );

  assert.deepEqual(receipt, {
    applicationBaseline: "3ad1232f061b5eaf4440b6fd3c7c13967a6c423f",
    applicationTree: "e5696dd81ca6a5d6a6e6c9f80cd4af06d20c98f0",
    capturedAt: "2026-09-01",
    caseCount: 11,
    command: "pnpm test:e2e:hermetic",
    database: {
      disposable: true,
      engine: "PostgreSQL",
      majorVersion: 16,
      timezone: "UTC",
    },
    dbCheck: "passed",
    groups: [
      {
        caseCount: 8,
        file: "tests/e2e/subscriber-hermetic.test.ts",
      },
      {
        caseCount: 1,
        file: "tests/e2e/demo.test.ts",
      },
      {
        caseCount: 2,
        file: "tests/e2e/demo-adversarial.test.ts",
      },
    ],
    repositoryHead: "7310bd65297417283e301141f3973a94b42d1de5",
    result: "passed",
    schemaVersion: 1,
  });
  assert.match(
    matrix,
    /p0-hermetic-receipt-2026-09-01\.json.*11 browser cases.*3ad1232f061b5eaf4440b6fd3c7c13967a6c423f/u
  );
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
