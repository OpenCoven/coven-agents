import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  candidateManifestDigest,
  evidenceSetManifestDigest,
  READINESS_TEST_MANIFEST,
  type ReadinessReceipt,
  type ReviewerKey,
  readinessDecisionViolations,
  readinessReceiptSchema,
  releaseDecisionManifestDigest,
  reviewerApprovalPayload,
  validateReadinessReceipt,
  validateReadinessReceiptFile,
} from "./readiness-receipt";

const digest = `sha256:${"a".repeat(64)}`;
const sourceSha = "b".repeat(40);
const rollbackSourceSha = "c".repeat(40);
const recordedAt = "2026-09-01T23:30:00.000Z";
const now = new Date("2026-09-02T00:00:00.000Z");
const roles = [
  "release_operator",
  "security_reviewer",
  "product_owner",
] as const;
const keyPairs = Object.fromEntries(
  roles.map((role) => [
    role,
    generateKeyPairSync("ed25519", {
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    }),
  ])
) as Record<(typeof roles)[number], { privateKey: string; publicKey: string }>;
const reviewerKeys: ReviewerKey[] = roles.map((role) => ({
  keyId: `${role}-key`,
  publicKeyPem: keyPairs[role].publicKey,
  reviewerId: `${role}@opencoven.test`,
  roles: [role],
}));

function receipt(): ReadinessReceipt {
  const candidateWithoutDigest = {
    adapterVersion: "runner-daytona-v1",
    appBuild: "deployment-build-123",
    configurationDigest: digest,
    daytonaApiVersion: "2026-08",
    daytonaSdkVersion: "0.207.0",
    executorContractVersion: "hosted-executor-v1",
    migrationVersion: "0031",
    region: "us",
    snapshotDigest: digest,
    sourceSha,
    target: "synthetic-staging",
  };
  const candidateDigest = candidateManifestDigest(candidateWithoutDigest);
  const rollback = {
    candidateDigest,
    certificationEvidenceDigest: digest,
    certifiedAt: recordedAt,
    deploymentReference:
      "https://vercel.com/opencoven/coven-agents/deployments/previous",
    schemaCompatibilityEvidenceDigest: digest,
    targetCandidateDigest: `sha256:${"d".repeat(64)}`,
    targetSourceSha: rollbackSourceSha,
  };
  const tests = READINESS_TEST_MANIFEST.map((requirement, index) => ({
    candidateDigest,
    evidenceDigests: [`sha256:${index.toString(16).padStart(64, "0")}`],
    id: requirement.id,
    journey: requirement.journey,
    layer: requirement.layer,
    outcome: "pass" as const,
    recordedAt,
    retentionClass: "release_evidence" as const,
  }));
  const evidence = {
    recordedAt,
    redaction: {
      candidateDigest,
      evidenceDigest: digest,
      outcome: "pass" as const,
      recordedAt,
      retentionClass: "security_evidence" as const,
      scannerVersion: "evidence-safety-v1",
    },
    retiredProvider: {
      candidateDigest,
      evidenceDigest: digest,
      outcome: "pass" as const,
      recordedAt,
      retentionClass: "operational_evidence" as const,
    },
    rollback,
    syntheticCorrelations: {
      accountDigest: digest,
      runDigest: digest,
      tenantDigest: digest,
    },
    tests,
  };
  const evidenceSetDigest = evidenceSetManifestDigest(evidence);
  const decisionDigest = releaseDecisionManifestDigest({
    candidate: { manifestDigest: candidateDigest },
    environment: "staging",
    evidenceSetDigest,
    openBlockers: [],
    receiptVersion: 1,
    recordedAt,
    review: { decision: "go" },
    rollback,
    testManifestVersion: 1,
  });
  const reviewers = roles.map((role) => {
    const approval = {
      approvalReference: `https://github.com/OpenCoven/coven-agents/issues/1#${role}`,
      approvedAt: recordedAt,
      candidateDigest,
      decision: "approve" as const,
      decisionDigest,
      evidenceSetDigest,
      keyId: `${role}-key`,
      reviewerId: `${role}@opencoven.test`,
      role,
    };
    return {
      ...approval,
      signature: sign(
        null,
        Buffer.from(reviewerApprovalPayload(approval)),
        keyPairs[role].privateKey
      ).toString("base64"),
    };
  });

  return readinessReceiptSchema.parse({
    candidate: {
      ...candidateWithoutDigest,
      manifestDigest: candidateDigest,
    },
    decisionDigest,
    environment: "staging",
    evidenceSetDigest,
    openBlockers: [],
    receiptVersion: 1,
    recordedAt,
    redaction: evidence.redaction,
    retiredProvider: evidence.retiredProvider,
    review: {
      decision: "go",
      reviewers,
    },
    rollback,
    syntheticCorrelations: evidence.syntheticCorrelations,
    testManifestVersion: 1,
    tests,
  });
}

function validationOptions() {
  const value = receipt();
  return {
    expectedCandidateDigest: value.candidate.manifestDigest,
    expectedEnvironment: value.environment,
    expectedRollbackCandidateDigest: value.rollback.targetCandidateDigest,
    expectedRollbackCertificationEvidenceDigest:
      value.rollback.certificationEvidenceDigest,
    expectedRollbackDeploymentReference: value.rollback.deploymentReference,
    expectedRollbackSchemaCompatibilityEvidenceDigest:
      value.rollback.schemaCompatibilityEvidenceDigest,
    expectedRollbackSourceSha: rollbackSourceSha,
    expectedSourceSha: sourceSha,
    now,
    reviewerKeys,
  };
}

function refreshEvidenceBindings(value: ReadinessReceipt) {
  value.evidenceSetDigest = evidenceSetManifestDigest(value);
  value.decisionDigest = releaseDecisionManifestDigest(value);
  value.review.reviewers = value.review.reviewers.map((reviewer) => {
    const approval = {
      ...reviewer,
      decisionDigest: value.decisionDigest,
      evidenceSetDigest: value.evidenceSetDigest,
    };
    return {
      ...approval,
      signature: sign(
        null,
        Buffer.from(reviewerApprovalPayload(approval)),
        keyPairs[reviewer.role].privateKey
      ).toString("base64"),
    };
  });
}

function refreshDecisionBindingWithoutResigning(value: ReadinessReceipt) {
  value.decisionDigest = releaseDecisionManifestDigest(value);
  value.review.reviewers = value.review.reviewers.map((reviewer) => ({
    ...reviewer,
    decisionDigest: value.decisionDigest,
  }));
}

test("accepts a signed exact-deployment readiness receipt", () => {
  const parsed = validateReadinessReceipt(receipt(), validationOptions());

  assert.equal(parsed.candidate.sourceSha, sourceSha);
  assert.equal(parsed.review.decision, "go");
});

test("rejects raw or unrecognized evidence fields", () => {
  const unsafe = {
    ...receipt(),
    operatorToken: "secret-value",
  };

  assert.equal(readinessReceiptSchema.safeParse(unsafe).success, false);
});

test("rejects secret-shaped values in recognized fields and unsafe references", () => {
  const secret = `ghp_${"A1b2C3d4E5f6G7h8I9j0".repeat(2)}`;
  const unsafeBlocker = receipt();
  unsafeBlocker.review = { decision: "pending", reviewers: [] };
  unsafeBlocker.openBlockers = [`Provider failed with ${secret}`];
  refreshEvidenceBindings(unsafeBlocker);
  const opaqueSecretBlocker = receipt();
  opaqueSecretBlocker.review = { decision: "pending", reviewers: [] };
  opaqueSecretBlocker.openBlockers = [
    "Provider failed with q7V9m2K4p8R1t6W3x5Y0z9A2b4C6d8E0",
  ];
  refreshEvidenceBindings(opaqueSecretBlocker);

  const unsafeReference = receipt();
  unsafeReference.rollback.deploymentReference = `https://example.com/deployment?token=${secret}`;
  refreshEvidenceBindings(unsafeReference);
  const encodedReference = receipt();
  encodedReference.rollback.deploymentReference = `https://example.com/deployment?value=${encodeURIComponent(secret)}`;
  refreshEvidenceBindings(encodedReference);

  assert.equal(readinessReceiptSchema.safeParse(unsafeBlocker).success, false);
  assert.equal(
    readinessReceiptSchema.safeParse(opaqueSecretBlocker).success,
    false
  );
  assert.equal(
    readinessReceiptSchema.safeParse(unsafeReference).success,
    false
  );
  assert.equal(
    readinessReceiptSchema.safeParse(encodedReference).success,
    false
  );
});

test("requires explicit recovery disposition for failed tests", () => {
  const failed = receipt();
  failed.tests[0] = {
    ...failed.tests[0],
    outcome: "fail",
  };

  assert.equal(readinessReceiptSchema.safeParse(failed).success, false);
});

test("requires retained evidence digests for passing and failing tests", () => {
  const missingEvidence = receipt();
  missingEvidence.tests[0] = {
    ...missingEvidence.tests[0],
    evidenceDigests: [],
  };

  assert.equal(
    readinessReceiptSchema.safeParse(missingEvidence).success,
    false
  );
});

test("blocks go decisions with incomplete evidence or missing approvals", () => {
  const incomplete = receipt();
  incomplete.tests[0] = {
    ...incomplete.tests[0],
    outcome: "deferred",
  };
  incomplete.openBlockers = ["Daytona lifecycle evidence is pending."];
  incomplete.review.reviewers = incomplete.review.reviewers.slice(0, 2);
  refreshEvidenceBindings(incomplete);

  const parsed = readinessReceiptSchema.parse(incomplete);

  assert.deepEqual(readinessDecisionViolations(parsed), [
    "go decision requires every test outcome to pass or be not_applicable",
    "go decision requires no open blockers",
    "go decision requires durable passing evidence for every readiness test manifest v1 entry",
    "go decision requires approval from release_operator, security_reviewer, and product_owner",
  ]);
});

test("allows pending receipts to retain explicit blockers and deferred evidence", () => {
  const pending = receipt();
  pending.tests[0] = {
    ...pending.tests[0],
    outcome: "deferred",
  };
  pending.openBlockers = ["Deployed lifecycle exercise is pending."];
  pending.review = {
    decision: "pending",
    reviewers: [],
  };
  pending.evidenceSetDigest = evidenceSetManifestDigest(pending);
  pending.decisionDigest = releaseDecisionManifestDigest(pending);

  const parsed = readinessReceiptSchema.parse(pending);

  assert.deepEqual(readinessDecisionViolations(parsed), []);
});

test("rejects go receipts that replace required journeys with generic layer evidence", () => {
  const incomplete = receipt();
  incomplete.tests = [
    "hermetic_application",
    "deployed_staging",
    "production_smoke",
  ].map((layer, index) => ({
    candidateDigest: incomplete.candidate.manifestDigest,
    evidenceDigests: [digest],
    id: `generic-${index}`,
    journey: "anonymous_demo" as const,
    layer: layer as ReadinessReceipt["tests"][number]["layer"],
    outcome: "pass" as const,
    recordedAt,
    retentionClass: "release_evidence" as const,
  }));
  refreshEvidenceBindings(incomplete);

  assert.throws(
    () => validateReadinessReceipt(incomplete, validationOptions()),
    /durable passing evidence for every readiness test manifest v1 entry/u
  );
});

test("does not count ephemeral evidence toward required readiness journeys", () => {
  const incomplete = receipt();
  incomplete.tests[0] = {
    ...incomplete.tests[0],
    retentionClass: "ephemeral_test",
  };
  refreshEvidenceBindings(incomplete);

  assert.throws(
    () => validateReadinessReceipt(incomplete, validationOptions()),
    /durable passing evidence for every readiness test manifest v1 entry/u
  );
});

test("rejects duplicate test case identifiers", () => {
  const duplicate = receipt();
  duplicate.tests[1] = {
    ...duplicate.tests[1],
    id: duplicate.tests[0]?.id ?? "",
  };

  assert.equal(readinessReceiptSchema.safeParse(duplicate).success, false);
});

test("rejects evidence that is not bound to the exact candidate", () => {
  const mismatched = receipt();
  mismatched.tests[0] = {
    ...mismatched.tests[0],
    candidateDigest: `sha256:${"e".repeat(64)}`,
  };

  assert.equal(readinessReceiptSchema.safeParse(mismatched).success, false);
});

test("requires external candidate and rollback bindings for go validation", () => {
  assert.throws(
    () => validateReadinessReceipt(receipt(), { now, reviewerKeys }),
    /expected source SHA/u
  );
  assert.throws(
    () =>
      validateReadinessReceipt(receipt(), {
        ...validationOptions(),
        expectedCandidateDigest: `sha256:${"f".repeat(64)}`,
      }),
    /candidate manifest digest does not match/u
  );
  assert.throws(
    () =>
      validateReadinessReceipt(receipt(), {
        ...validationOptions(),
        expectedRollbackSourceSha: "d".repeat(40),
      }),
    /rollback source SHA does not match/u
  );
  assert.throws(
    () =>
      validateReadinessReceipt(receipt(), {
        ...validationOptions(),
        expectedEnvironment: "production",
      }),
    /environment does not match/u
  );
  assert.throws(
    () =>
      validateReadinessReceipt(receipt(), {
        ...validationOptions(),
        expectedRollbackCertificationEvidenceDigest: `sha256:${"f".repeat(64)}`,
      }),
    /rollback certification does not match/u
  );
  assert.throws(
    () =>
      validateReadinessReceipt(receipt(), {
        ...validationOptions(),
        expectedRollbackSchemaCompatibilityEvidenceDigest: `sha256:${"f".repeat(64)}`,
      }),
    /rollback schema compatibility does not match/u
  );
});

test("rejects spoofed, unauthorized, or invalid reviewer signatures", () => {
  const unsigned = receipt();
  unsigned.review.reviewers[0] = {
    ...unsigned.review.reviewers[0],
    signature: Buffer.alloc(64).toString("base64"),
  };

  assert.throws(
    () => validateReadinessReceipt(unsigned, validationOptions()),
    /valid authorized signatures/u
  );
  assert.throws(
    () =>
      validateReadinessReceipt(receipt(), {
        ...validationOptions(),
        reviewerKeys: [],
      }),
    /valid authorized signatures/u
  );
});

test("reviewer signatures cover the complete release decision", () => {
  const tampered = receipt();
  tampered.environment = "production";
  refreshDecisionBindingWithoutResigning(tampered);

  assert.throws(
    () =>
      validateReadinessReceipt(tampered, {
        ...validationOptions(),
        expectedEnvironment: "production",
      }),
    /valid authorized signatures/u
  );
});

test("rejects noncanonical signatures with appended secret content", () => {
  const invalid = receipt();
  invalid.review.reviewers[0] = {
    ...invalid.review.reviewers[0],
    signature: `${invalid.review.reviewers[0]?.signature}ghp_${"A1b2C3d4E5f6G7h8I9j0".repeat(2)}`,
  };

  assert.equal(readinessReceiptSchema.safeParse(invalid).success, false);
});

test("requires cryptographically distinct reviewer signing keys", () => {
  const sharedKeyReceipt = receipt();
  sharedKeyReceipt.review.reviewers = sharedKeyReceipt.review.reviewers.map(
    (reviewer) => {
      const approval = {
        ...reviewer,
        signature: undefined,
      };
      return {
        ...reviewer,
        signature: sign(
          null,
          Buffer.from(reviewerApprovalPayload(approval)),
          keyPairs.release_operator.privateKey
        ).toString("base64"),
      };
    }
  );
  const sharedReviewerKeys = reviewerKeys.map((key) => ({
    ...key,
    publicKeyPem: keyPairs.release_operator.publicKey,
  }));

  assert.throws(
    () =>
      validateReadinessReceipt(sharedKeyReceipt, {
        ...validationOptions(),
        reviewerKeys: sharedReviewerKeys,
      }),
    /cryptographically distinct reviewer keys/u
  );
});

test("requires a distinct externally certified rollback target", () => {
  const invalid = receipt();
  invalid.rollback = {
    ...invalid.rollback,
    targetSourceSha: invalid.candidate.sourceSha,
  };

  assert.equal(readinessReceiptSchema.safeParse(invalid).success, false);
});

test("rejects future-dated and stale go receipts", () => {
  assert.throws(
    () =>
      validateReadinessReceipt(receipt(), {
        ...validationOptions(),
        now: new Date("2026-09-01T23:20:00.000Z"),
      }),
    /future/u
  );
  assert.throws(
    () =>
      validateReadinessReceipt(receipt(), {
        ...validationOptions(),
        now: new Date("2026-09-20T00:00:00.000Z"),
      }),
    /older than/u
  );
});

test("cannot renew stale evidence by changing only receipt time and signatures", () => {
  const renewed = receipt();
  renewed.recordedAt = "2026-09-19T23:30:00.000Z";
  refreshEvidenceBindings(renewed);

  assert.throws(
    () =>
      validateReadinessReceipt(renewed, {
        ...validationOptions(),
        now: new Date("2026-09-20T00:00:00.000Z"),
      }),
    /evidence or approval cannot be older than/u
  );
});

test("requires approvals after the latest evidence they attest", () => {
  const premature = receipt();
  premature.tests[0] = {
    ...premature.tests[0],
    recordedAt: "2026-09-01T23:35:00.000Z",
  };
  premature.recordedAt = "2026-09-01T23:40:00.000Z";
  refreshEvidenceBindings(premature);

  assert.equal(readinessReceiptSchema.safeParse(premature).success, false);
});

test("binds rollback certification evidence into reviewer signatures", () => {
  const tampered = receipt();
  tampered.rollback.certificationEvidenceDigest = `sha256:${"e".repeat(64)}`;

  assert.equal(readinessReceiptSchema.safeParse(tampered).success, false);
});

test("requires an explicit signed and externally bound no-go decision", () => {
  const noGo = receipt();
  noGo.review = {
    decision: "no_go",
    reviewers: [],
  };
  noGo.decisionDigest = releaseDecisionManifestDigest(noGo);

  assert.throws(
    () => validateReadinessReceipt(noGo),
    /no-go decision requires an explicit blocker or failed evidence/u
  );
});

test("requires retained retired-provider proof for go", () => {
  const invalid = receipt();
  invalid.retiredProvider = {
    ...invalid.retiredProvider,
    evidenceDigest: undefined,
    outcome: "not_applicable",
  };
  refreshEvidenceBindings(invalid);

  assert.throws(
    () => validateReadinessReceipt(invalid, validationOptions()),
    /retired-provider evidence to pass with retained evidence/u
  );
});

test("validates a receipt file and reports malformed or oversized JSON", () => {
  const directory = mkdtempSync(join(tmpdir(), "coven-readiness-receipt-"));
  const validPath = join(directory, "valid.json");
  const malformedPath = join(directory, "malformed.json");
  const oversizedPath = join(directory, "oversized.json");

  try {
    writeFileSync(validPath, JSON.stringify(receipt()));
    writeFileSync(malformedPath, "{");
    writeFileSync(oversizedPath, " ".repeat(1_048_577));

    assert.equal(
      validateReadinessReceiptFile(validPath, validationOptions()).candidate
        .sourceSha,
      sourceSha
    );
    assert.throws(
      () => validateReadinessReceiptFile(malformedPath),
      /Readiness receipt is not valid JSON/u
    );
    assert.throws(
      () => validateReadinessReceiptFile(oversizedPath),
      /exceeds the 1 MiB limit/u
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
