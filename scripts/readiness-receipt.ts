import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { looksLikeRealSecret, scanText } from "./secret-scan";

const MAX_RECEIPT_BYTES = 1_048_576;
const MAX_REVIEWER_KEYS_BYTES = 65_536;
const MAX_RECEIPT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const SECRET_SCAN_SUPPRESSION = /secret-scan:\s*allow-next-line\b/iu;
const secretSafeStringSchema = z
  .string()
  .refine((value) => !/[\r\n]/u.test(value), {
    message: "value must be a single line",
  })
  .refine(
    (value) =>
      !SECRET_SCAN_SUPPRESSION.test(value) &&
      scanText("readiness-receipt.json", value).length === 0,
    {
      message: "value must not contain secret-shaped content",
    }
  );
const PUBLIC_OPAQUE_IDENTIFIER =
  /^(?:dpl_[A-Za-z0-9]{16,}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/u;
const DESCRIPTIVE_IDENTIFIER =
  /^(?:[a-z]{2,15}|\d{1,15}|v\d{1,8})(?:[-_.:/](?:[a-z]{2,15}|\d{1,15}|v\d{1,8}))+$/u;

function containsOpaqueSecret(value: string): boolean {
  return (
    value
      .match(/[A-Za-z0-9+_=-]{16,}/gu)
      ?.some(
        (token) =>
          !PUBLIC_OPAQUE_IDENTIFIER.test(token) &&
          !DESCRIPTIVE_IDENTIFIER.test(token) &&
          looksLikeRealSecret(token)
      ) ?? false
  );
}

const secretSafeOpaqueStringSchema = secretSafeStringSchema.refine(
  (value) => !containsOpaqueSecret(value),
  { message: "value must not contain opaque secret-shaped content" }
);
const versionSchema = secretSafeOpaqueStringSchema
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:+/@-]*$/u);
const identifierSchema = secretSafeOpaqueStringSchema
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
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
  .refine(
    (value) => {
      const url = new URL(value);
      let decodedComponents = [
        url.hostname,
        url.pathname,
        url.search,
        url.hash,
      ].join("\n");
      try {
        for (let depth = 0; depth < 4; depth += 1) {
          const decoded = decodeURIComponent(decodedComponents);
          if (decoded === decodedComponents) {
            break;
          }
          decodedComponents = decoded;
        }
      } catch {
        return false;
      }
      if (/%[0-9a-f]{2}/iu.test(decodedComponents)) {
        return false;
      }
      return (
        url.protocol === "https:" &&
        url.username === "" &&
        url.password === "" &&
        !SECRET_SCAN_SUPPRESSION.test(value) &&
        !SECRET_SCAN_SUPPRESSION.test(decodedComponents) &&
        scanText("readiness-reference.txt", value).length === 0 &&
        scanText("readiness-reference.txt", decodedComponents).length === 0 &&
        !containsOpaqueSecret(decodedComponents)
      );
    },
    {
      message:
        "reference must use HTTPS without credentials or secret-shaped content",
    }
  );
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
const environmentSchema = z.enum(["hermetic", "staging", "production"]);
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
    decisionDigest: digestSchema,
    evidenceSetDigest: digestSchema,
    keyId: identifierSchema,
    reviewerId: secretSafeOpaqueStringSchema.trim().email().max(254),
    role: reviewerRoleSchema,
    signature: z
      .string()
      .regex(/^[A-Za-z0-9+/]{86}==$/u)
      .refine(
        (value) => {
          const decoded = Buffer.from(value, "base64");
          return decoded.length === 64 && decoded.toString("base64") === value;
        },
        { message: "signature must be canonical Ed25519 Base64" }
      ),
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
    decisionDigest: approval.decisionDigest,
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
  recordedAt: string;
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
  rollback: {
    candidateDigest: string;
    certificationEvidenceDigest: string;
    certifiedAt: string;
    deploymentReference: string;
    schemaCompatibilityEvidenceDigest: string;
    targetCandidateDigest: string;
    targetSourceSha: string;
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
    .sort((left, right) =>
      Buffer.compare(
        Buffer.from(left.id, "utf8"),
        Buffer.from(right.id, "utf8")
      )
    );
  return sha256({
    recordedAt: evidence.recordedAt,
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
    rollback: {
      candidateDigest: evidence.rollback.candidateDigest,
      certificationEvidenceDigest:
        evidence.rollback.certificationEvidenceDigest,
      certifiedAt: evidence.rollback.certifiedAt,
      deploymentReference: evidence.rollback.deploymentReference,
      schemaCompatibilityEvidenceDigest:
        evidence.rollback.schemaCompatibilityEvidenceDigest,
      targetCandidateDigest: evidence.rollback.targetCandidateDigest,
      targetSourceSha: evidence.rollback.targetSourceSha,
    },
    syntheticCorrelations: {
      accountDigest: evidence.syntheticCorrelations.accountDigest,
      runDigest: evidence.syntheticCorrelations.runDigest,
      tenantDigest: evidence.syntheticCorrelations.tenantDigest,
    },
    tests,
  }) as `sha256:${string}`;
}

type ReleaseDecisionInput = {
  candidate: { manifestDigest: string };
  environment: string;
  evidenceSetDigest: string;
  openBlockers: readonly string[];
  receiptVersion: number;
  recordedAt: string;
  review: { decision: string };
  rollback: EvidenceSetInput["rollback"];
  testManifestVersion: number;
};

export function releaseDecisionManifestDigest(
  decision: ReleaseDecisionInput
): `sha256:${string}` {
  const openBlockers = [...decision.openBlockers].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
  );
  return sha256({
    candidateDigest: decision.candidate.manifestDigest,
    environment: decision.environment,
    evidenceSetDigest: decision.evidenceSetDigest,
    openBlockers,
    receiptVersion: decision.receiptVersion,
    recordedAt: decision.recordedAt,
    requestedDecision: decision.review.decision,
    rollback: {
      candidateDigest: decision.rollback.candidateDigest,
      certificationEvidenceDigest:
        decision.rollback.certificationEvidenceDigest,
      certifiedAt: decision.rollback.certifiedAt,
      deploymentReference: decision.rollback.deploymentReference,
      schemaCompatibilityEvidenceDigest:
        decision.rollback.schemaCompatibilityEvidenceDigest,
      targetCandidateDigest: decision.rollback.targetCandidateDigest,
      targetSourceSha: decision.rollback.targetSourceSha,
    },
    testManifestVersion: decision.testManifestVersion,
  }) as `sha256:${string}`;
}

export const readinessReceiptSchema = z
  .object({
    candidate: candidateSchema,
    decisionDigest: digestSchema,
    environment: environmentSchema,
    evidenceSetDigest: digestSchema,
    openBlockers: z
      .array(secretSafeOpaqueStringSchema.trim().min(1).max(256))
      .max(32),
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

    const latestEvidenceTime = Math.max(
      ...evidenceTimestamps.map(([, timestamp]) =>
        new Date(timestamp).valueOf()
      )
    );
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
      if (reviewer.decisionDigest !== receipt.decisionDigest) {
        context.addIssue({
          code: "custom",
          message:
            "reviewer approval must bind to the complete release decision",
          path: ["review", "reviewers", index, "decisionDigest"],
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
      if (new Date(reviewer.approvedAt).valueOf() < latestEvidenceTime) {
        context.addIssue({
          code: "custom",
          message: "reviewer approval must follow the latest retained evidence",
          path: ["review", "reviewers", index, "approvedAt"],
        });
      }
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
    const expectedDecisionDigest = releaseDecisionManifestDigest(receipt);
    if (receipt.decisionDigest !== expectedDecisionDigest) {
      context.addIssue({
        code: "custom",
        message: "release decision digest does not match the complete decision",
        path: ["decisionDigest"],
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
  expectedEnvironment?: ReadinessReceipt["environment"];
  expectedRollbackCertificationEvidenceDigest?: string;
  expectedRollbackCandidateDigest?: string;
  expectedRollbackDeploymentReference?: string;
  expectedRollbackSchemaCompatibilityEvidenceDigest?: string;
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
  if (receipt.review.decision === "pending") {
    return [];
  }

  const violations: string[] = [];
  if (receipt.review.decision === "no_go") {
    const hasBlockingEvidence =
      receipt.openBlockers.length > 0 ||
      receipt.tests.some((result) => result.outcome === "fail") ||
      receipt.redaction.outcome === "fail" ||
      receipt.retiredProvider.outcome === "fail";
    if (!hasBlockingEvidence) {
      violations.push(
        "no-go decision requires an explicit blocker or failed evidence"
      );
    }
    if (
      !receipt.review.reviewers.some(
        (reviewer) => reviewer.decision === "reject"
      )
    ) {
      violations.push("no-go decision requires a rejecting reviewer");
    }
    return violations;
  }

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
        signature.toString("base64") === approval.signature &&
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

function reviewerKeyRegistryViolation(
  reviewerKeys: readonly ReviewerKey[]
): string | undefined {
  const keyIds = new Set<string>();
  const reviewerIds = new Set<string>();
  const fingerprints = new Set<string>();

  for (const key of reviewerKeys) {
    if (keyIds.has(key.keyId) || reviewerIds.has(key.reviewerId)) {
      return "reviewer key registry requires unique key IDs and reviewer identities";
    }
    keyIds.add(key.keyId);
    reviewerIds.add(key.reviewerId);
    try {
      const publicKey = createPublicKey(key.publicKeyPem);
      const canonicalPem = publicKey
        .export({ format: "pem", type: "spki" })
        .toString();
      if (key.publicKeyPem !== canonicalPem) {
        return "reviewer key registry requires canonical public keys";
      }
      if (publicKey.asymmetricKeyType !== "ed25519") {
        return "reviewer key registry requires Ed25519 public keys";
      }
      const fingerprint = createHash("sha256")
        .update(publicKey.export({ format: "der", type: "spki" }))
        .digest("hex");
      if (fingerprints.has(fingerprint)) {
        return "final decisions require cryptographically distinct reviewer keys";
      }
      fingerprints.add(fingerprint);
    } catch {
      return "reviewer key registry contains an invalid public key";
    }
  }
  return undefined;
}

export function validateReadinessReceipt(
  value: unknown,
  options: ReadinessValidationOptions = {}
): ReadinessReceipt {
  const receipt = readinessReceiptSchema.parse(value);
  const violations = readinessDecisionViolations(receipt);

  if (receipt.review.decision !== "pending") {
    const finalDecision = receipt.review.decision;
    if (options.expectedSourceSha === undefined) {
      violations.push(
        `${finalDecision} validation requires an expected source SHA`
      );
    } else if (receipt.candidate.sourceSha !== options.expectedSourceSha) {
      violations.push(
        "receipt source SHA does not match the expected candidate"
      );
    }
    if (options.expectedCandidateDigest === undefined) {
      violations.push(
        `${finalDecision} validation requires an expected candidate manifest digest`
      );
    } else if (
      receipt.candidate.manifestDigest !== options.expectedCandidateDigest
    ) {
      violations.push(
        "receipt candidate manifest digest does not match the expected deployment"
      );
    }
    if (options.expectedEnvironment === undefined) {
      violations.push(
        `${finalDecision} validation requires an expected deployment environment`
      );
    } else if (receipt.environment !== options.expectedEnvironment) {
      violations.push(
        "receipt environment does not match the expected deployment"
      );
    }
    if (options.expectedRollbackSourceSha === undefined) {
      violations.push(
        `${finalDecision} validation requires an expected rollback source SHA`
      );
    } else if (
      receipt.rollback.targetSourceSha !== options.expectedRollbackSourceSha
    ) {
      violations.push(
        "receipt rollback source SHA does not match the expected certified release"
      );
    }
    if (options.expectedRollbackCandidateDigest === undefined) {
      violations.push(
        `${finalDecision} validation requires an expected rollback candidate digest`
      );
    } else if (
      receipt.rollback.targetCandidateDigest !==
      options.expectedRollbackCandidateDigest
    ) {
      violations.push(
        "receipt rollback candidate digest does not match the expected certified release"
      );
    }
    if (options.expectedRollbackCertificationEvidenceDigest === undefined) {
      violations.push(
        `${finalDecision} validation requires an expected rollback certification digest`
      );
    } else if (
      receipt.rollback.certificationEvidenceDigest !==
      options.expectedRollbackCertificationEvidenceDigest
    ) {
      violations.push(
        "receipt rollback certification does not match the expected certified release"
      );
    }
    if (
      options.expectedRollbackSchemaCompatibilityEvidenceDigest === undefined
    ) {
      violations.push(
        `${finalDecision} validation requires an expected rollback schema-compatibility digest`
      );
    } else if (
      receipt.rollback.schemaCompatibilityEvidenceDigest !==
      options.expectedRollbackSchemaCompatibilityEvidenceDigest
    ) {
      violations.push(
        "receipt rollback schema compatibility does not match the expected certified release"
      );
    }
    if (options.expectedRollbackDeploymentReference === undefined) {
      violations.push(
        `${finalDecision} validation requires an expected rollback deployment reference`
      );
    } else if (
      receipt.rollback.deploymentReference !==
      options.expectedRollbackDeploymentReference
    ) {
      violations.push(
        "receipt rollback deployment reference does not match the expected certified release"
      );
    }
    const reviewerKeyViolation =
      options.reviewerKeys === undefined
        ? undefined
        : reviewerKeyRegistryViolation(options.reviewerKeys);
    if (reviewerKeyViolation !== undefined) {
      violations.push(reviewerKeyViolation);
    } else if (
      options.reviewerKeys === undefined ||
      !reviewerApprovalsAreValid(receipt, options.reviewerKeys)
    ) {
      violations.push(
        `${finalDecision} decision requires valid authorized signatures for every reviewer approval`
      );
    }

    const currentTime = (options.now ?? new Date()).valueOf();
    const maxReceiptAgeMs = options.maxReceiptAgeMs ?? MAX_RECEIPT_AGE_MS;
    const timestamps = [
      receipt.recordedAt,
      receipt.redaction.recordedAt,
      receipt.retiredProvider.recordedAt,
      receipt.rollback.certifiedAt,
      ...receipt.tests.map((result) => result.recordedAt),
      ...receipt.review.reviewers.map((reviewer) => reviewer.approvedAt),
    ];
    if (
      timestamps.some(
        (timestamp) =>
          new Date(timestamp).valueOf() > currentTime + MAX_CLOCK_SKEW_MS
      )
    ) {
      violations.push(
        `${finalDecision} receipt cannot contain future evidence`
      );
    }
    if (
      timestamps.some(
        (timestamp) =>
          currentTime - new Date(timestamp).valueOf() > maxReceiptAgeMs
      )
    ) {
      violations.push(
        `${finalDecision} evidence or approval cannot be older than the allowed receipt age`
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
    reviewerId: secretSafeOpaqueStringSchema.trim().email().max(254),
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

function cliEnvironment(
  values: string[]
): ReadinessReceipt["environment"] | undefined {
  const value = cliValue(values, "--expected-environment");
  return value === undefined ? undefined : environmentSchema.parse(value);
}

const [, entrypoint, receiptPath, ...argumentsAfterPath] = process.argv;
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  try {
    if (!receiptPath) {
      throw new Error(
        "Usage: pnpm readiness:check <receipt.json> --expected-sha <git-sha> --expected-candidate-digest <sha256> --expected-environment <environment> --expected-rollback-sha <git-sha> --expected-rollback-candidate-digest <sha256> --expected-rollback-certification-digest <sha256> --expected-rollback-schema-digest <sha256> --expected-rollback-deployment-reference <https-url> --reviewer-keys <keys.json>"
      );
    }
    const expectedFlags = new Set([
      "--expected-candidate-digest",
      "--expected-environment",
      "--expected-rollback-candidate-digest",
      "--expected-rollback-certification-digest",
      "--expected-rollback-deployment-reference",
      "--expected-rollback-schema-digest",
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
      expectedEnvironment: cliEnvironment(argumentsAfterPath),
      expectedRollbackCandidateDigest: cliValue(
        argumentsAfterPath,
        "--expected-rollback-candidate-digest"
      ),
      expectedRollbackCertificationEvidenceDigest: cliValue(
        argumentsAfterPath,
        "--expected-rollback-certification-digest"
      ),
      expectedRollbackDeploymentReference: cliValue(
        argumentsAfterPath,
        "--expected-rollback-deployment-reference"
      ),
      expectedRollbackSchemaCompatibilityEvidenceDigest: cliValue(
        argumentsAfterPath,
        "--expected-rollback-schema-digest"
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
