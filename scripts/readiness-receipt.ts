import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const MAX_RECEIPT_BYTES = 1_048_576;
const MAX_REVIEWER_KEYS_BYTES = 65_536;
const MAX_RECEIPT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const versionSchema = z.string().trim().min(1).max(128);
const identifierSchema = z.string().trim().min(1).max(128);
const utcTimestampSchema = z.string().refine(
  (value) => {
    const parsed = new Date(value);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
  },
  { message: "value must be an exact UTC ISO timestamp" }
);
const httpsUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((value) => new URL(value).protocol === "https:", {
    message: "reference must use HTTPS",
  });
const reviewerRoleSchema = z.enum([
  "release_operator",
  "security_reviewer",
  "product_owner",
]);
const journeySchema = z.enum([
  "anonymous_demo",
  "eligible_subscriber_run",
  "cross_tenant_denial",
  "entitlement_transition",
  "daytona_lifecycle",
  "git_workspace_lifecycle",
  "failure_recovery",
  "provider_retirement",
]);
const layerSchema = z.enum([
  "hermetic_application",
  "deployed_staging",
  "production_smoke",
]);
const retentionClassSchema = z.enum([
  "ephemeral_test",
  "release_evidence",
  "security_evidence",
  "operational_evidence",
]);
const durableRetentionClassSchema = z.enum([
  "release_evidence",
  "security_evidence",
  "operational_evidence",
]);

const candidateFieldsSchema = z
  .object({
    adapterVersion: versionSchema,
    appBuild: identifierSchema,
    configurationDigest: digestSchema,
    daytonaApiVersion: versionSchema,
    daytonaSdkVersion: versionSchema,
    executorContractVersion: versionSchema,
    migrationVersion: versionSchema,
    region: identifierSchema,
    snapshotDigest: digestSchema,
    sourceSha: gitShaSchema,
    target: identifierSchema,
  })
  .strict();

type CandidateFields = z.infer<typeof candidateFieldsSchema>;

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")}`;
}

export function candidateManifestDigest(
  candidate: CandidateFields & { manifestDigest?: string }
): `sha256:${string}` {
  const {
    adapterVersion,
    appBuild,
    configurationDigest,
    daytonaApiVersion,
    daytonaSdkVersion,
    executorContractVersion,
    migrationVersion,
    region,
    snapshotDigest,
    sourceSha,
    target,
  } = candidate;
  const parsed = candidateFieldsSchema.parse({
    adapterVersion,
    appBuild,
    configurationDigest,
    daytonaApiVersion,
    daytonaSdkVersion,
    executorContractVersion,
    migrationVersion,
    region,
    snapshotDigest,
    sourceSha,
    target,
  });
  return sha256(parsed) as `sha256:${string}`;
}

const candidateSchema = candidateFieldsSchema
  .extend({
    manifestDigest: digestSchema,
  })
  .strict();

const outcomeSchema = z.enum(["pass", "fail", "deferred", "not_applicable"]);
const dispositionSchema = z.enum([
  "rejected",
  "queued",
  "dispatching",
  "running",
  "cancelled",
  "failed",
  "succeeded",
  "unknown_recovery_required",
]);

const testResultSchema = z
  .object({
    candidateDigest: digestSchema,
    disposition: dispositionSchema.optional(),
    evidenceDigests: z.array(digestSchema).max(32),
    id: identifierSchema,
    journey: journeySchema,
    layer: layerSchema,
    outcome: outcomeSchema,
    recordedAt: utcTimestampSchema,
    retentionClass: retentionClassSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (
      (result.outcome === "pass" || result.outcome === "fail") &&
      result.evidenceDigests.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message: "passing and failing test results require evidence digests",
        path: ["evidenceDigests"],
      });
    }
    if (result.outcome === "fail" && result.disposition === undefined) {
      context.addIssue({
        code: "custom",
        message: "failed test results require an explicit disposition",
        path: ["disposition"],
      });
    }
  });

const reviewerApprovalSchema = z
  .object({
    approvalReference: httpsUrlSchema,
    approvedAt: utcTimestampSchema,
    candidateDigest: digestSchema,
    decision: z.enum(["approve", "reject", "pending"]),
    evidenceSetDigest: digestSchema,
    keyId: identifierSchema,
    reviewerId: z.string().trim().email().max(254),
    role: reviewerRoleSchema,
    signature: z.string().min(1).max(256),
  })
  .strict();

type ReviewerApproval = z.infer<typeof reviewerApprovalSchema>;

export function reviewerApprovalPayload(
  approval: Omit<ReviewerApproval, "signature"> | ReviewerApproval
): string {
  return JSON.stringify({
    approvalReference: approval.approvalReference,
    approvedAt: approval.approvedAt,
    candidateDigest: approval.candidateDigest,
    decision: approval.decision,
    evidenceSetDigest: approval.evidenceSetDigest,
    keyId: approval.keyId,
    reviewerId: approval.reviewerId,
    role: approval.role,
  });
}

export const READINESS_TEST_MANIFEST = [
  {
    id: "hermetic-health-account",
    journey: "eligible_subscriber_run",
    layer: "hermetic_application",
  },
  {
    id: "hermetic-guest-protected-refusal",
    journey: "cross_tenant_denial",
    layer: "hermetic_application",
  },
  {
    id: "hermetic-subscriber-agent-crud",
    journey: "eligible_subscriber_run",
    layer: "hermetic_application",
  },
  {
    id: "hermetic-subscriber-skill-team-crud",
    journey: "eligible_subscriber_run",
    layer: "hermetic_application",
  },
  {
    id: "hermetic-subscription-states",
    journey: "entitlement_transition",
    layer: "hermetic_application",
  },
  {
    id: "hermetic-device-authorization",
    journey: "git_workspace_lifecycle",
    layer: "hermetic_application",
  },
  {
    id: "hermetic-daytona-lifecycle",
    journey: "daytona_lifecycle",
    layer: "hermetic_application",
  },
  {
    id: "hermetic-run-idempotency",
    journey: "eligible_subscriber_run",
    layer: "hermetic_application",
  },
  {
    id: "hermetic-team-run-lifecycle",
    journey: "eligible_subscriber_run",
    layer: "hermetic_application",
  },
  {
    id: "hermetic-sse-reconnect",
    journey: "failure_recovery",
    layer: "hermetic_application",
  },
  {
    id: "hermetic-stop-convergence",
    journey: "failure_recovery",
    layer: "hermetic_application",
  },
  {
    id: "hermetic-launch-compensation",
    journey: "failure_recovery",
    layer: "hermetic_application",
  },
  {
    id: "hermetic-revocation-fencing",
    journey: "entitlement_transition",
    layer: "hermetic_application",
  },
  {
    id: "hermetic-reconciliation",
    journey: "failure_recovery",
    layer: "hermetic_application",
  },
  {
    id: "hermetic-operator-diagnostics",
    journey: "eligible_subscriber_run",
    layer: "hermetic_application",
  },
  {
    id: "hermetic-provider-retirement",
    journey: "provider_retirement",
    layer: "hermetic_application",
  },
  {
    id: "staging-health-account",
    journey: "eligible_subscriber_run",
    layer: "deployed_staging",
  },
  {
    id: "staging-guest-protected-refusal",
    journey: "cross_tenant_denial",
    layer: "deployed_staging",
  },
  {
    id: "staging-subscriber-agent-crud",
    journey: "eligible_subscriber_run",
    layer: "deployed_staging",
  },
  {
    id: "staging-subscriber-skill-team-crud",
    journey: "eligible_subscriber_run",
    layer: "deployed_staging",
  },
  {
    id: "staging-subscription-states",
    journey: "entitlement_transition",
    layer: "deployed_staging",
  },
  {
    id: "staging-device-authorization",
    journey: "git_workspace_lifecycle",
    layer: "deployed_staging",
  },
  {
    id: "staging-daytona-lifecycle",
    journey: "daytona_lifecycle",
    layer: "deployed_staging",
  },
  {
    id: "staging-run-idempotency",
    journey: "eligible_subscriber_run",
    layer: "deployed_staging",
  },
  {
    id: "staging-team-run-lifecycle",
    journey: "eligible_subscriber_run",
    layer: "deployed_staging",
  },
  {
    id: "staging-sse-reconnect",
    journey: "failure_recovery",
    layer: "deployed_staging",
  },
  {
    id: "staging-stop-convergence",
    journey: "failure_recovery",
    layer: "deployed_staging",
  },
  {
    id: "staging-launch-compensation",
    journey: "failure_recovery",
    layer: "deployed_staging",
  },
  {
    id: "staging-revocation-fencing",
    journey: "entitlement_transition",
    layer: "deployed_staging",
  },
  {
    id: "staging-reconciliation",
    journey: "failure_recovery",
    layer: "deployed_staging",
  },
  {
    id: "staging-operator-diagnostics",
    journey: "eligible_subscriber_run",
    layer: "deployed_staging",
  },
  {
    id: "staging-provider-retirement",
    journey: "provider_retirement",
    layer: "deployed_staging",
  },
  {
    id: "production-anonymous-demo",
    journey: "anonymous_demo",
    layer: "production_smoke",
  },
  {
    id: "production-health-account",
    journey: "eligible_subscriber_run",
    layer: "production_smoke",
  },
  {
    id: "production-guest-protected-refusal",
    journey: "cross_tenant_denial",
    layer: "production_smoke",
  },
  {
    id: "production-subscriber-run",
    journey: "eligible_subscriber_run",
    layer: "production_smoke",
  },
  {
    id: "production-subscription-authority",
    journey: "entitlement_transition",
    layer: "production_smoke",
  },
  {
    id: "production-daytona-lifecycle",
    journey: "daytona_lifecycle",
    layer: "production_smoke",
  },
] as const;

type EvidenceSetInput = {
  redaction: {
    candidateDigest: string;
    evidenceDigest: string;
    outcome: string;
    recordedAt: string;
    retentionClass: string;
    scannerVersion: string;
  };
  retiredProvider: {
    candidateDigest: string;
    evidenceDigest?: string;
    outcome: string;
    recordedAt: string;
    retentionClass: string;
  };
  syntheticCorrelations: {
    accountDigest: string;
    runDigest: string;
    tenantDigest: string;
  };
  tests: ReadonlyArray<{
    candidateDigest: string;
    disposition?: string;
    evidenceDigests: readonly string[];
    id: string;
    journey: string;
    layer: string;
    outcome: string;
    recordedAt: string;
    retentionClass: string;
  }>;
};

export function evidenceSetManifestDigest(
  evidence: EvidenceSetInput
): `sha256:${string}` {
  const tests = evidence.tests
    .map((result) => ({
      candidateDigest: result.candidateDigest,
      disposition: result.disposition ?? null,
      evidenceDigests: [...result.evidenceDigests].sort(),
      id: result.id,
      journey: result.journey,
      layer: result.layer,
      outcome: result.outcome,
      recordedAt: result.recordedAt,
      retentionClass: result.retentionClass,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return sha256({
    redaction: {
      candidateDigest: evidence.redaction.candidateDigest,
      evidenceDigest: evidence.redaction.evidenceDigest,
      outcome: evidence.redaction.outcome,
      recordedAt: evidence.redaction.recordedAt,
      retentionClass: evidence.redaction.retentionClass,
      scannerVersion: evidence.redaction.scannerVersion,
    },
    retiredProvider: {
      candidateDigest: evidence.retiredProvider.candidateDigest,
      evidenceDigest: evidence.retiredProvider.evidenceDigest,
      outcome: evidence.retiredProvider.outcome,
      recordedAt: evidence.retiredProvider.recordedAt,
      retentionClass: evidence.retiredProvider.retentionClass,
    },
    syntheticCorrelations: {
      accountDigest: evidence.syntheticCorrelations.accountDigest,
      runDigest: evidence.syntheticCorrelations.runDigest,
      tenantDigest: evidence.syntheticCorrelations.tenantDigest,
    },
    tests,
  }) as `sha256:${string}`;
}

export const readinessReceiptSchema = z
  .object({
    candidate: candidateSchema,
    environment: z.enum(["hermetic", "staging", "production"]),
    evidenceSetDigest: digestSchema,
    openBlockers: z.array(z.string().trim().min(1).max(256)).max(32),
    receiptVersion: z.literal(1),
    recordedAt: utcTimestampSchema,
    redaction: z
      .object({
        candidateDigest: digestSchema,
        evidenceDigest: digestSchema,
        outcome: z.enum(["pass", "fail"]),
        recordedAt: utcTimestampSchema,
        retentionClass: durableRetentionClassSchema,
        scannerVersion: versionSchema,
      })
      .strict(),
    retiredProvider: z
      .object({
        candidateDigest: digestSchema,
        evidenceDigest: digestSchema.optional(),
        outcome: outcomeSchema,
        recordedAt: utcTimestampSchema,
        retentionClass: durableRetentionClassSchema,
      })
      .strict(),
    review: z
      .object({
        decision: z.enum(["go", "no_go", "pending"]),
        reviewers: z.array(reviewerApprovalSchema).max(3),
      })
      .strict(),
    rollback: z
      .object({
        candidateDigest: digestSchema,
        certificationEvidenceDigest: digestSchema,
        certifiedAt: utcTimestampSchema,
        deploymentReference: httpsUrlSchema,
        schemaCompatibilityEvidenceDigest: digestSchema,
        targetCandidateDigest: digestSchema,
        targetSourceSha: gitShaSchema,
      })
      .strict(),
    syntheticCorrelations: z
      .object({
        accountDigest: digestSchema,
        runDigest: digestSchema,
        tenantDigest: digestSchema,
      })
      .strict(),
    testManifestVersion: z.literal(1),
    tests: z.array(testResultSchema).min(1).max(256),
  })
  .strict()
  .superRefine((receipt, context) => {
    const expectedCandidateDigest = candidateManifestDigest(receipt.candidate);
    if (receipt.candidate.manifestDigest !== expectedCandidateDigest) {
      context.addIssue({
        code: "custom",
        message: "candidate manifest digest does not match candidate fields",
        path: ["candidate", "manifestDigest"],
      });
    }

    const bindings: [string, string | undefined, (string | number)[]][] = [
      [
        "redaction",
        receipt.redaction.candidateDigest,
        ["redaction", "candidateDigest"],
      ],
      [
        "retired provider",
        receipt.retiredProvider.candidateDigest,
        ["retiredProvider", "candidateDigest"],
      ],
      [
        "rollback",
        receipt.rollback.candidateDigest,
        ["rollback", "candidateDigest"],
      ],
    ];
    for (const [label, binding, path] of bindings) {
      if (binding !== receipt.candidate.manifestDigest) {
        context.addIssue({
          code: "custom",
          message: `${label} evidence must bind to the candidate manifest`,
          path,
        });
      }
    }

    const recordedAt = new Date(receipt.recordedAt).valueOf();
    const evidenceTimestamps: [string, string, (string | number)[]][] = [
      ["redaction", receipt.redaction.recordedAt, ["redaction", "recordedAt"]],
      [
        "retired provider",
        receipt.retiredProvider.recordedAt,
        ["retiredProvider", "recordedAt"],
      ],
      [
        "rollback certification",
        receipt.rollback.certifiedAt,
        ["rollback", "certifiedAt"],
      ],
    ];

    const testIds = new Set<string>();
    for (const [index, result] of receipt.tests.entries()) {
      if (testIds.has(result.id)) {
        context.addIssue({
          code: "custom",
          message: "test result identifiers must be unique",
          path: ["tests", index, "id"],
        });
      }
      testIds.add(result.id);
      if (result.candidateDigest !== receipt.candidate.manifestDigest) {
        context.addIssue({
          code: "custom",
          message: "test evidence must bind to the candidate manifest",
          path: ["tests", index, "candidateDigest"],
        });
      }
      evidenceTimestamps.push([
        "test evidence",
        result.recordedAt,
        ["tests", index, "recordedAt"],
      ]);
    }

    const roles = new Set<string>();
    const reviewerIds = new Set<string>();
    const keyIds = new Set<string>();
    for (const [index, reviewer] of receipt.review.reviewers.entries()) {
      if (roles.has(reviewer.role)) {
        context.addIssue({
          code: "custom",
          message: "reviewer roles must be unique",
          path: ["review", "reviewers", index, "role"],
        });
      }
      if (reviewerIds.has(reviewer.reviewerId)) {
        context.addIssue({
          code: "custom",
          message: "reviewer identities must be unique",
          path: ["review", "reviewers", index, "reviewerId"],
        });
      }
      if (keyIds.has(reviewer.keyId)) {
        context.addIssue({
          code: "custom",
          message: "reviewer signing keys must be unique",
          path: ["review", "reviewers", index, "keyId"],
        });
      }
      roles.add(reviewer.role);
      reviewerIds.add(reviewer.reviewerId);
      keyIds.add(reviewer.keyId);
      if (reviewer.candidateDigest !== receipt.candidate.manifestDigest) {
        context.addIssue({
          code: "custom",
          message: "reviewer approval must bind to the candidate manifest",
          path: ["review", "reviewers", index, "candidateDigest"],
        });
      }
      if (reviewer.evidenceSetDigest !== receipt.evidenceSetDigest) {
        context.addIssue({
          code: "custom",
          message: "reviewer approval must bind to the evidence set",
          path: ["review", "reviewers", index, "evidenceSetDigest"],
        });
      }
      evidenceTimestamps.push([
        "reviewer approval",
        reviewer.approvedAt,
        ["review", "reviewers", index, "approvedAt"],
      ]);
    }

    for (const [label, timestamp, path] of evidenceTimestamps) {
      if (new Date(timestamp).valueOf() > recordedAt) {
        context.addIssue({
          code: "custom",
          message: `${label} cannot be recorded after the receipt`,
          path,
        });
      }
    }

    if (receipt.rollback.targetSourceSha === receipt.candidate.sourceSha) {
      context.addIssue({
        code: "custom",
        message: "rollback target must differ from the candidate source SHA",
        path: ["rollback", "targetSourceSha"],
      });
    }
    if (
      receipt.rollback.targetCandidateDigest ===
      receipt.candidate.manifestDigest
    ) {
      context.addIssue({
        code: "custom",
        message:
          "rollback target must identify a different certified candidate",
        path: ["rollback", "targetCandidateDigest"],
      });
    }

    const expectedEvidenceSetDigest = evidenceSetManifestDigest(receipt);
    if (receipt.evidenceSetDigest !== expectedEvidenceSetDigest) {
      context.addIssue({
        code: "custom",
        message: "evidence set digest does not match retained evidence",
        path: ["evidenceSetDigest"],
      });
    }
  });

export type ReadinessReceipt = z.infer<typeof readinessReceiptSchema>;

export type ReviewerKey = {
  keyId: string;
  publicKeyPem: string;
  reviewerId: string;
  roles: readonly z.infer<typeof reviewerRoleSchema>[];
};

export type ReadinessValidationOptions = {
  expectedCandidateDigest?: string;
  expectedRollbackCandidateDigest?: string;
  expectedRollbackSourceSha?: string;
  expectedSourceSha?: string;
  maxReceiptAgeMs?: number;
  now?: Date;
  reviewerKeys?: readonly ReviewerKey[];
};

const REQUIRED_REVIEWERS = [
  "release_operator",
  "security_reviewer",
  "product_owner",
] as const;
const DURABLE_RETENTION_CLASSES = new Set([
  "release_evidence",
  "security_evidence",
  "operational_evidence",
]);

export function readinessDecisionViolations(
  receipt: ReadinessReceipt
): string[] {
  if (receipt.review.decision !== "go") {
    return [];
  }

  const violations: string[] = [];
  if (
    receipt.tests.some(
      (result) =>
        result.outcome !== "pass" && result.outcome !== "not_applicable"
    )
  ) {
    violations.push(
      "go decision requires every test outcome to pass or be not_applicable"
    );
  }
  if (receipt.openBlockers.length > 0) {
    violations.push("go decision requires no open blockers");
  }

  const testsById = new Map(receipt.tests.map((result) => [result.id, result]));
  if (
    READINESS_TEST_MANIFEST.some((requirement) => {
      const result = testsById.get(requirement.id);
      return (
        result === undefined ||
        result.journey !== requirement.journey ||
        result.layer !== requirement.layer ||
        result.outcome !== "pass" ||
        !DURABLE_RETENTION_CLASSES.has(result.retentionClass) ||
        result.evidenceDigests.length === 0
      );
    })
  ) {
    violations.push(
      "go decision requires durable passing evidence for every readiness test manifest v1 entry"
    );
  }

  const approvedRoles = new Set(
    receipt.review.reviewers
      .filter((reviewer) => reviewer.decision === "approve")
      .map((reviewer) => reviewer.role)
  );
  if (REQUIRED_REVIEWERS.some((role) => !approvedRoles.has(role))) {
    violations.push(
      "go decision requires approval from release_operator, security_reviewer, and product_owner"
    );
  }
  if (receipt.redaction.outcome !== "pass") {
    violations.push("go decision requires a passing redaction scan");
  }
  if (
    receipt.retiredProvider.outcome !== "pass" ||
    receipt.retiredProvider.evidenceDigest === undefined
  ) {
    violations.push(
      "go decision requires retired-provider evidence to pass with retained evidence"
    );
  }
  return violations;
}

function reviewerApprovalsAreValid(
  receipt: ReadinessReceipt,
  reviewerKeys: readonly ReviewerKey[]
): boolean {
  const trustedKeys = new Map(reviewerKeys.map((key) => [key.keyId, key]));
  return receipt.review.reviewers.every((approval) => {
    const trustedKey = trustedKeys.get(approval.keyId);
    if (
      trustedKey === undefined ||
      trustedKey.reviewerId !== approval.reviewerId ||
      !trustedKey.roles.includes(approval.role)
    ) {
      return false;
    }
    try {
      const signature = Buffer.from(approval.signature, "base64");
      return (
        signature.length === 64 &&
        verify(
          null,
          Buffer.from(reviewerApprovalPayload(approval)),
          createPublicKey(trustedKey.publicKeyPem),
          signature
        )
      );
    } catch {
      return false;
    }
  });
}

export function validateReadinessReceipt(
  value: unknown,
  options: ReadinessValidationOptions = {}
): ReadinessReceipt {
  const receipt = readinessReceiptSchema.parse(value);
  const violations = readinessDecisionViolations(receipt);

  if (receipt.review.decision === "go") {
    if (options.expectedSourceSha === undefined) {
      violations.push("go validation requires an expected source SHA");
    } else if (receipt.candidate.sourceSha !== options.expectedSourceSha) {
      violations.push(
        "receipt source SHA does not match the expected candidate"
      );
    }
    if (options.expectedCandidateDigest === undefined) {
      violations.push(
        "go validation requires an expected candidate manifest digest"
      );
    } else if (
      receipt.candidate.manifestDigest !== options.expectedCandidateDigest
    ) {
      violations.push(
        "receipt candidate manifest digest does not match the expected deployment"
      );
    }
    if (options.expectedRollbackSourceSha === undefined) {
      violations.push("go validation requires an expected rollback source SHA");
    } else if (
      receipt.rollback.targetSourceSha !== options.expectedRollbackSourceSha
    ) {
      violations.push(
        "receipt rollback source SHA does not match the expected certified release"
      );
    }
    if (options.expectedRollbackCandidateDigest === undefined) {
      violations.push(
        "go validation requires an expected rollback candidate digest"
      );
    } else if (
      receipt.rollback.targetCandidateDigest !==
      options.expectedRollbackCandidateDigest
    ) {
      violations.push(
        "receipt rollback candidate digest does not match the expected certified release"
      );
    }
    if (
      options.reviewerKeys === undefined ||
      !reviewerApprovalsAreValid(receipt, options.reviewerKeys)
    ) {
      violations.push(
        "go decision requires valid authorized signatures for every reviewer approval"
      );
    }

    const currentTime = (options.now ?? new Date()).valueOf();
    const receiptTime = new Date(receipt.recordedAt).valueOf();
    if (receiptTime > currentTime + MAX_CLOCK_SKEW_MS) {
      violations.push("go receipt cannot be recorded in the future");
    }
    if (
      currentTime - receiptTime >
      (options.maxReceiptAgeMs ?? MAX_RECEIPT_AGE_MS)
    ) {
      violations.push(
        "go receipt cannot be older than the allowed receipt age"
      );
    }
  }

  if (violations.length > 0) {
    throw new Error(`Readiness receipt is invalid: ${violations.join("; ")}.`);
  }
  return receipt;
}

export function validateReadinessReceiptFile(
  path: string,
  options: ReadinessValidationOptions = {}
): ReadinessReceipt {
  if (statSync(path).size > MAX_RECEIPT_BYTES) {
    throw new Error("Readiness receipt exceeds the 1 MiB limit.");
  }
  const contents = readFileSync(path, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error("Readiness receipt is not valid JSON.", { cause: error });
  }
  return validateReadinessReceipt(value, options);
}

const reviewerKeySchema = z
  .object({
    keyId: identifierSchema,
    publicKeyPem: z.string().min(1).max(4096),
    reviewerId: z.string().trim().email().max(254),
    roles: z.array(reviewerRoleSchema).min(1).max(3),
  })
  .strict();
const reviewerKeyFileSchema = z
  .object({
    keys: z.array(reviewerKeySchema).min(3).max(32),
  })
  .strict();

function readReviewerKeys(path: string): ReviewerKey[] {
  if (statSync(path).size > MAX_REVIEWER_KEYS_BYTES) {
    throw new Error("Reviewer key file exceeds the 64 KiB limit.");
  }
  try {
    return reviewerKeyFileSchema.parse(JSON.parse(readFileSync(path, "utf8")))
      .keys;
  } catch (error) {
    throw new Error("Reviewer key file is invalid.", { cause: error });
  }
}

function cliValue(values: string[], flag: string): string | undefined {
  const index = values.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = values[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

const [, entrypoint, receiptPath, ...argumentsAfterPath] = process.argv;
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  try {
    if (!receiptPath) {
      throw new Error(
        "Usage: pnpm readiness:check <receipt.json> --expected-sha <git-sha> --expected-candidate-digest <sha256> --expected-rollback-sha <git-sha> --expected-rollback-candidate-digest <sha256> --reviewer-keys <keys.json>"
      );
    }
    const expectedFlags = new Set([
      "--expected-candidate-digest",
      "--expected-rollback-candidate-digest",
      "--expected-rollback-sha",
      "--expected-sha",
      "--reviewer-keys",
    ]);
    for (let index = 0; index < argumentsAfterPath.length; index += 2) {
      const flag = argumentsAfterPath[index];
      if (
        flag === undefined ||
        !expectedFlags.has(flag) ||
        argumentsAfterPath[index + 1] === undefined
      ) {
        throw new Error("Readiness receipt arguments are invalid.");
      }
    }
    const reviewerKeysPath = cliValue(argumentsAfterPath, "--reviewer-keys");
    validateReadinessReceiptFile(receiptPath, {
      expectedCandidateDigest: cliValue(
        argumentsAfterPath,
        "--expected-candidate-digest"
      ),
      expectedRollbackCandidateDigest: cliValue(
        argumentsAfterPath,
        "--expected-rollback-candidate-digest"
      ),
      expectedRollbackSourceSha: cliValue(
        argumentsAfterPath,
        "--expected-rollback-sha"
      ),
      expectedSourceSha: cliValue(argumentsAfterPath, "--expected-sha"),
      reviewerKeys:
        reviewerKeysPath === undefined
          ? undefined
          : readReviewerKeys(reviewerKeysPath),
    });
    process.stdout.write("Readiness receipt passed.\n");
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Readiness receipt is invalid."}\n`
    );
    process.exitCode = 1;
  }
}
