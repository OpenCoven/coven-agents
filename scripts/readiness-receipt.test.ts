import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type ReadinessReceipt,
  readinessDecisionViolations,
  readinessReceiptSchema,
  validateReadinessReceipt,
  validateReadinessReceiptFile,
} from "./readiness-receipt";

const digest = `sha256:${"a".repeat(64)}`;
const sourceSha = "b".repeat(40);

function receipt(): ReadinessReceipt {
  return {
    candidate: {
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
    },
    environment: "staging",
    openBlockers: [],
    receiptVersion: 1,
    recordedAt: "2026-09-01T23:30:00.000Z",
    redaction: {
      evidenceDigest: digest,
      outcome: "pass",
      scannerVersion: "evidence-safety-v1",
    },
    retiredProvider: {
      evidenceDigest: digest,
      outcome: "pass",
    },
    review: {
      decision: "go",
      reviewers: [
        { decision: "approve", role: "release_operator" },
        { decision: "approve", role: "security_reviewer" },
        { decision: "approve", role: "product_owner" },
      ],
    },
    rollback: {
      targetSourceSha: "c".repeat(40),
    },
    syntheticCorrelations: {
      accountDigest: digest,
      runDigest: digest,
      tenantDigest: digest,
    },
    tests: [
      {
        evidenceDigests: [digest],
        id: "hermetic-browser",
        journey: "eligible_subscriber_run",
        layer: "hermetic_application",
        outcome: "pass",
        retentionClass: "release_evidence",
      },
      {
        evidenceDigests: [digest],
        id: "daytona-lifecycle",
        journey: "eligible_subscriber_run",
        layer: "deployed_staging",
        outcome: "pass",
        retentionClass: "release_evidence",
      },
      {
        evidenceDigests: [digest],
        id: "production-demo-smoke",
        journey: "anonymous_demo",
        layer: "production_smoke",
        outcome: "pass",
        retentionClass: "release_evidence",
      },
    ],
  };
}

test("accepts a strict exact-deployment readiness receipt", () => {
  const parsed = readinessReceiptSchema.parse(receipt());

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

  const parsed = readinessReceiptSchema.parse(incomplete);

  assert.deepEqual(readinessDecisionViolations(parsed), [
    "go decision requires every test outcome to pass or be not_applicable",
    "go decision requires no open blockers",
    "go decision requires passing evidence for hermetic_application, deployed_staging, and production_smoke",
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

  const parsed = readinessReceiptSchema.parse(pending);

  assert.deepEqual(readinessDecisionViolations(parsed), []);
});

test("rejects go decisions that omit a required certification layer", () => {
  const incomplete = receipt();
  incomplete.tests = incomplete.tests.filter(
    (result) => result.layer !== "deployed_staging"
  );

  assert.throws(
    () => validateReadinessReceipt(incomplete),
    /go decision requires passing evidence for hermetic_application, deployed_staging, and production_smoke/u
  );
});

test("does not count not-applicable results as required layer evidence", () => {
  const incomplete = receipt();
  incomplete.tests[1] = {
    ...incomplete.tests[1],
    outcome: "not_applicable",
  };

  assert.throws(
    () => validateReadinessReceipt(incomplete),
    /go decision requires passing evidence for hermetic_application, deployed_staging, and production_smoke/u
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

test("rejects receipts for a different expected source SHA", () => {
  assert.throws(
    () => validateReadinessReceipt(receipt(), "d".repeat(40)),
    /receipt source SHA does not match the expected candidate/u
  );
});

test("validates a receipt file and reports malformed JSON explicitly", () => {
  const directory = mkdtempSync(join(tmpdir(), "coven-readiness-receipt-"));
  const validPath = join(directory, "valid.json");
  const malformedPath = join(directory, "malformed.json");

  try {
    writeFileSync(validPath, JSON.stringify(receipt()));
    writeFileSync(malformedPath, "{");

    assert.equal(
      validateReadinessReceiptFile(validPath, sourceSha).candidate.sourceSha,
      sourceSha
    );
    assert.throws(
      () => validateReadinessReceiptFile(malformedPath),
      /Readiness receipt is not valid JSON/u
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
