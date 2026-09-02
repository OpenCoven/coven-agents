import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, repositoryRoot), "utf8");
}

test("the current-state snapshot covers merged product and planning surfaces", () => {
  const currentState = read("docs/roadmap/current-state.md");

  assert.match(currentState, /Snapshot date: 2026-09-02/u);
  assert.match(
    currentState,
    /Application baseline: `140bc1a5617c12cb1ad89b1b0a4945d27478564f`/u
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
    "Manual resource repair",
    "lib/runner/daytona/resource-repair.ts",
    "p0-latest-main-candidate-receipt-2026-09-02.json",
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

  assert.match(matrix, /as of 2026-09-02/u);
  assert.match(
    matrix,
    /application baseline `140bc1a5617c12cb1ad89b1b0a4945d27478564f`/u
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
  assert.match(matrix, /\| Daytona resource disposition \| `Blocked` \|/u);
});

test("the latest-main candidate receipt records safe smoke without promotion", () => {
  const currentState = read("docs/roadmap/current-state.md");
  const matrix = read("docs/roadmap/verification-matrix.md");
  const receipt = JSON.parse(
    read("docs/operations/p0-latest-main-candidate-receipt-2026-09-02.json")
  );

  assert.deepEqual(receipt, {
    capturedAt: "2026-09-02",
    containsCredentialMaterial: false,
    containsDaytonaResourceIdentifiers: false,
    containsTenantIdentifiers: false,
    deployment: {
      automaticDomainPromotion: false,
      deploymentId: "dpl_CWMnd5TuRTvanpmuotyyuQA5Vdaj",
      deploymentUrl: "https://coven-agents-htfbvw3l7-0xbuns.vercel.app",
      generatedStaticPages: 47,
      readyState: "READY",
      target: "production",
    },
    disposition: {
      candidatePromoted: false,
      releaseCertified: false,
      remainingBlockers: [
        "authenticated_subscriber_lifecycle",
        "stripe_provider_lifecycle",
        "daytona_persistent_workspace_lifecycle",
        "daytona_resize_capability",
        "observation_window",
        "rollback_exercise",
        "named_approvals",
      ],
    },
    productionAlias: {
      deploymentId: "dpl_EERKkjtfpkT5SPRD7uxRKPutRLoy",
      unchanged: true,
    },
    requiredRoutes: [
      "/api/internal/runner-resource-repair",
      "/api/teams",
      "/api/team-runs/[id]/approve",
      "/api/team-runs/[id]/stop",
    ],
    safeSmoke: [
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
        location: "/login?beta=1",
        route: "/api/agents",
        status: 307,
      },
      {
        location: "/login?beta=1",
        route: "/api/teams",
        status: 307,
      },
      {
        errorCode: "unauthorized",
        retryable: false,
        route: "/api/internal/runner-resource-repair",
        status: 401,
      },
    ],
    schemaVersion: 1,
    source: {
      archiveExported: true,
      commit: "140bc1a5617c12cb1ad89b1b0a4945d27478564f",
      tree: "a52c25f529c8f75466ce85969b4e6e3866f54033",
    },
  });

  for (const document of [currentState, matrix]) {
    assert.match(
      document,
      /p0-latest-main-candidate-receipt-2026-09-02\.json/u
    );
  }
  assert.match(currentState, /automatic domain promotion\s+disabled/iu);
  assert.match(matrix, /non-promoted latest-main build/iu);
});

test("the resource repair receipt records the provider blocker without identifiers", () => {
  const currentState = read("docs/roadmap/current-state.md");
  const matrix = read("docs/roadmap/verification-matrix.md");
  const attestation = read("docs/operations/daytona-cutover-attestation.md");
  const receipt = JSON.parse(
    read("docs/operations/p0-daytona-resource-repair-receipt-2026-09-02.json")
  );

  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.capturedAt, "2026-09-02");
  assert.deepEqual(receipt.repairImplementation, {
    deploymentId: "dpl_EgN8t3QvMk4JEcGrprRXponHLPQe",
    mergeCommit: "80d787e2d2288141cd5fbcd5b9417edda74888f9",
    pullRequest: 198,
    requiredRoute: "/api/internal/runner-resource-repair",
    sourceTree: "aafe5ceda5156fed8fa57d33175a57d372eca5fb",
  });
  assert.deepEqual(receipt.rejectionHandling, {
    deploymentId: "dpl_EERKkjtfpkT5SPRD7uxRKPutRLoy",
    mergeCommit: "dbe5ebbf70c5b943561612512fc03e5ae4542b3b",
    pullRequest: 200,
    sourceTree: "8c35b9f03410cbbff8370e99ab19ba07b544ce47",
  });
  assert.deepEqual(
    receipt.repairResults.map(
      ({
        deferred,
        eligible,
        examined,
        failures,
        phase,
        repaired,
      }: {
        deferred: number;
        eligible: number;
        examined: number;
        failures: number;
        phase: string;
        repaired: number;
      }) => ({
        deferred,
        eligible,
        examined,
        failures,
        phase,
        repaired,
      })
    ),
    [
      {
        deferred: 3,
        eligible: 3,
        examined: 3,
        failures: 0,
        phase: "initial",
        repaired: 0,
      },
      {
        deferred: 0,
        eligible: 3,
        examined: 3,
        failures: 3,
        phase: "definite-rejection-recovery",
        repaired: 0,
      },
    ]
  );
  assert.equal(receipt.providerDiagnostic.exactSandboxHydrationSucceeded, true);
  assert.equal(receipt.providerDiagnostic.resizeHttpStatus, 404);
  assert.equal(receipt.providerDiagnostic.includedProviderMessage, false);
  assert.equal(receipt.postRepairInventory.length, 2);
  assert.deepEqual(
    {
      ...receipt.postRepairInventory[0],
      sequence: 2,
    },
    receipt.postRepairInventory[1]
  );
  for (const inventory of receipt.postRepairInventory) {
    assert.equal(inventory.appOwnedMappings, 4);
    assert.equal(inventory.examined, 4);
    assert.equal(inventory.ambiguous, 4);
    assert.equal(inventory.unowned, 0);
    assert.equal(inventory.states.stopped, 4);
    assert.deepEqual(inventory.configurationDrift, [
      { count: 4, field: "cpu", relation: "below" },
      { count: 4, field: "memory", relation: "below" },
      { count: 4, field: "disk", relation: "below" },
    ]);
  }
  assert.deepEqual(receipt.disposition, {
    durableResizeFencesRemaining: 0,
    providerBlocker: "resize_endpoint_not_found",
    providerResizeSupportedForObservedResources: false,
    resourceDispositionCertified: false,
    resourcesAdopted: 0,
    resourcesDeleted: 0,
    resourcesRecreated: 0,
  });
  assert.equal(
    receipt.productionAlias.deploymentId,
    "dpl_EERKkjtfpkT5SPRD7uxRKPutRLoy"
  );
  assert.equal(receipt.containsCredentialMaterial, false);
  assert.equal(receipt.containsProviderIdentifiers, false);
  assert.equal(receipt.containsTenantIdentifiers, false);

  for (const document of [currentState, matrix, attestation]) {
    assert.match(
      document,
      /p0-daytona-resource-repair-receipt-2026-09-02\.json/u
    );
    assert.match(
      document,
      /HTTP 404|resize_endpoint_not_found|resize operation/u
    );
  }
  assert.match(attestation, /no resource was deleted, recreated, or adopted/iu);
  assert.match(attestation, /Resource disposition certified:\s+`no`/u);
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

test("the cutover attestation matches the production configuration receipt", () => {
  const attestation = read("docs/operations/daytona-cutover-attestation.md");
  const receipt = JSON.parse(
    read("docs/operations/p0-production-config-receipt-2026-09-01.json")
  );

  assert.deepEqual(receipt, {
    capturedAt: "2026-09-01",
    checks: {
      closedBetaRefusal: {
        location: "/login?beta=1",
        method: "GET",
        route: "/agents",
        status: 307,
      },
      credentialIsolation: [
        {
          attemptedCredential: "diagnostic",
          intendedCredential: "scheduled-reconciliation",
          method: "GET",
          outcome: "unauthorized",
          requestId: "8069c025-0add-454a-9b5e-4f5ccdc9a23b",
          retryable: false,
          route: "/api/internal/runner-resource-inventory",
          status: 401,
        },
        {
          attemptedCredential: "manual-reconciliation",
          intendedCredential: "diagnostic",
          method: "POST",
          outcome: "unauthorized",
          requestId: "2dd79a06-62a7-4396-86e6-00971899024e",
          retryable: false,
          route: "/api/diagnostics/sandbox",
          status: 401,
        },
        {
          attemptedCredential: "scheduled-reconciliation",
          intendedCredential: "manual-reconciliation",
          method: "POST",
          outcome: "unauthorized",
          requestId: "14389c8a-5db2-4c96-a784-e7b8f4985808",
          retryable: false,
          route: "/api/internal/runner-reconcile",
          status: 401,
        },
      ],
      health: {
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
        method: "GET",
        minimumClientVersion: "1.0.0",
        mode: "cloud",
        route: "/api/health",
        status: 200,
      },
      resourceInventory: {
        after: {
          ambiguous: 4,
          appOwnedMappings: 4,
          databaseCapped: false,
          examined: 4,
          matched: 0,
          providerCapped: false,
          states: {
            active: 0,
            archived: 0,
            other: 0,
            stopped: 4,
          },
          status: "complete",
          unowned: 0,
          version: 1,
        },
        before: {
          ambiguous: 4,
          appOwnedMappings: 4,
          databaseCapped: false,
          examined: 4,
          matched: 0,
          providerCapped: false,
          states: {
            active: 0,
            archived: 0,
            other: 0,
            stopped: 4,
          },
          status: "complete",
          unowned: 0,
          version: 1,
        },
        method: "GET",
        nonDestructive: true,
        route: "/api/internal/runner-resource-inventory",
        status: 200,
      },
      runnerReconciliation: [
        {
          method: "POST",
          result: {
            adopted: 0,
            deferred: 0,
            dispatched: 0,
            execution: "executed",
            expiredScanned: 0,
            failures: 0,
            logEvents: 0,
            requeued: 0,
            sandboxRecovered: 0,
            terminalCleaned: 0,
            terminalized: 0,
            terminalLeaseCleaned: 0,
          },
          route: "/api/internal/runner-reconcile",
          sequence: 1,
          status: 200,
        },
        {
          method: "POST",
          result: {
            adopted: 0,
            deferred: 0,
            dispatched: 0,
            execution: "executed",
            expiredScanned: 0,
            failures: 0,
            logEvents: 0,
            requeued: 0,
            sandboxRecovered: 0,
            terminalCleaned: 0,
            terminalized: 0,
            terminalLeaseCleaned: 0,
          },
          route: "/api/internal/runner-reconcile",
          sequence: 2,
          status: 200,
        },
      ],
      sandboxDiagnostic: {
        exitCode: 0,
        method: "POST",
        ok: true,
        output: "coven-agents",
        route: "/api/diagnostics/sandbox",
        status: 200,
      },
      stripeReconciliation: {
        applied: 0,
        conflicts: 0,
        deferred: 0,
        execution: "executed",
        failures: 0,
        method: "GET",
        route: "/api/internal/stripe-reconcile",
        scanned: 0,
        status: 200,
        unchanged: 0,
      },
    },
    cleanup: {
      defaultAliasDeploymentId: "dpl_F4EXbTYZTvscUjrBUPZYjjSuDWB1",
      productionAdminPlaceholderRestored: true,
      temporarySubscriberDeploymentsRemoved: 3,
    },
    containsCredentialMaterial: false,
    deployment: {
      evidenceClass: "production-safe",
      id: "dpl_F4EXbTYZTvscUjrBUPZYjjSuDWB1",
      sourceCommit: "a2c11ff408caf8f97af8dbbe37903a13e928f255",
      sourceTree: "46df1be994b882c19fbcedd0bdecbba9c76ff299",
      staticGenerationCount: 42,
      target: "production",
    },
    evidenceFlags: {
      approvalsCompleted: false,
      diagnosticLifecycleCertified: true,
      observationWindowCompleted: false,
      persistentSandboxLifecycleCertified: false,
      resourceDispositionCertified: false,
      stripeCheckoutWebhookFailureRetryCertified: false,
      subscriberLifecycleCertified: false,
    },
    schemaVersion: 1,
  });

  for (const value of [
    receipt.deployment.id,
    receipt.deployment.sourceCommit,
    receipt.deployment.sourceTree,
  ]) {
    assert.match(attestation, new RegExp(value, "u"));
  }
  assert.match(attestation, /p0-production-config-receipt-2026-09-01\.json/u);
  const normalizedAttestation = attestation.replace(/\s+/gu, " ");
  assert.ok(
    normalizedAttestation.includes(
      `Production-target build generated \`${receipt.deployment.staticGenerationCount}\` static pages`
    )
  );

  const { checks } = receipt;
  assert.ok(
    normalizedAttestation.includes(
      `\`${checks.health.method} ${checks.health.route}\` returned HTTP ${checks.health.status} with API v1 in ${checks.health.mode} mode`
    )
  );
  assert.ok(
    normalizedAttestation.includes(
      `signed-out \`${checks.closedBetaRefusal.method} ${checks.closedBetaRefusal.route}\` returned HTTP ${checks.closedBetaRefusal.status} to \`${checks.closedBetaRefusal.location}\``
    )
  );
  assert.ok(
    normalizedAttestation.includes(
      `\`${checks.sandboxDiagnostic.method} ${checks.sandboxDiagnostic.route}\` Daytona diagnostic returned HTTP ${checks.sandboxDiagnostic.status}, exit code zero, and the fixed sanitized output \`${checks.sandboxDiagnostic.output}\``
    )
  );
  assert.ok(
    normalizedAttestation.includes(
      `\`${checks.stripeReconciliation.method} ${checks.stripeReconciliation.route}\` returned HTTP ${checks.stripeReconciliation.status} with \`execution=${checks.stripeReconciliation.execution}\` and zero scanned, changed, deferred, conflicting, or failed candidates`
    )
  );
  assert.ok(
    normalizedAttestation.includes(
      `two consecutive manual \`${checks.runnerReconciliation[0].method} ${checks.runnerReconciliation[0].route}\` requests returned HTTP ${checks.runnerReconciliation[0].status} with \`execution=${checks.runnerReconciliation[0].result.execution}\` and every work and failure aggregate equal to zero`
    )
  );
  assert.ok(
    normalizedAttestation.includes(
      `bounded \`${checks.resourceInventory.method} ${checks.resourceInventory.route}\` results before and after reconciliation each examined ${checks.resourceInventory.before.examined} application-owned mappings without provider or database truncation`
    )
  );
  assert.ok(
    normalizedAttestation.includes(
      "four stopped resources remain ambiguous and were neither adopted nor deleted"
    )
  );

  const label = (value: string) => {
    const words = value.replaceAll("-", " ");
    return `${words[0]?.toUpperCase()}${words.slice(1)}`;
  };
  for (const denial of checks.credentialIsolation) {
    assert.ok(
      attestation.includes(
        `| ${label(denial.attemptedCredential)} | ${label(
          denial.intendedCredential
        )} | \`${denial.method} ${denial.route}\` | ${denial.status} | \`${
          denial.requestId
        }\` |`
      )
    );
  }
  assert.ok(
    normalizedAttestation.includes(
      `alias was restored to the receipt deployment after an isolated subscriber-session investigation: \`${receipt.cleanup.defaultAliasDeploymentId}\``
    )
  );
  assert.ok(
    normalizedAttestation.includes(
      `${receipt.cleanup.temporarySubscriberDeploymentsRemoved} temporary subscriber deployments were removed`
    )
  );
  assert.ok(
    normalizedAttestation.includes(
      "empty Production admin allowlist placeholder was restored"
    )
  );
  assert.ok(
    normalizedAttestation.includes(
      `Diagnostic lifecycle certified: \`${
        receipt.evidenceFlags.diagnosticLifecycleCertified ? "yes" : "no"
      }\``
    )
  );
  assert.match(attestation, /Subscriber lifecycle certified: `no`/u);
  assert.match(attestation, /Persistent sandbox lifecycle certified: `no`/u);
  assert.match(attestation, /Resource disposition certified:\s+`no`/u);
  assert.match(
    attestation,
    /Stripe checkout\/webhook failure-retry certified: `no`/u
  );
  assert.match(attestation, /Observation\s+window completed: `no`/u);
  assert.match(attestation, /Named approvals completed: `no`/u);
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
