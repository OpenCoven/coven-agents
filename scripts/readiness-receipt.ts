import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const versionSchema = z.string().trim().min(1).max(128);
const identifierSchema = z.string().trim().min(1).max(128);

const candidateSchema = z
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
    disposition: dispositionSchema.optional(),
    evidenceDigests: z.array(digestSchema).max(32),
    id: identifierSchema,
    journey: z.enum([
      "anonymous_demo",
      "eligible_subscriber_run",
      "cross_tenant_denial",
      "entitlement_transition",
      "daytona_lifecycle",
      "git_workspace_lifecycle",
      "failure_recovery",
      "provider_retirement",
    ]),
    layer: z.enum([
      "hermetic_application",
      "deployed_staging",
      "production_smoke",
    ]),
    outcome: outcomeSchema,
    retentionClass: z.enum([
      "ephemeral_test",
      "release_evidence",
      "security_evidence",
      "operational_evidence",
    ]),
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

const reviewerSchema = z
  .object({
    decision: z.enum(["approve", "reject", "pending"]),
    role: z.enum(["release_operator", "security_reviewer", "product_owner"]),
  })
  .strict();

export const readinessReceiptSchema = z
  .object({
    candidate: candidateSchema,
    environment: z.enum(["hermetic", "staging", "production"]),
    openBlockers: z.array(z.string().trim().min(1).max(256)).max(32),
    receiptVersion: z.literal(1),
    recordedAt: z.string().refine(
      (value) => {
        const parsed = new Date(value);
        return (
          !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value
        );
      },
      { message: "recordedAt must be an exact UTC ISO timestamp" }
    ),
    redaction: z
      .object({
        evidenceDigest: digestSchema,
        outcome: z.enum(["pass", "fail"]),
        scannerVersion: versionSchema,
      })
      .strict(),
    retiredProvider: z
      .object({
        evidenceDigest: digestSchema.optional(),
        outcome: outcomeSchema,
      })
      .strict(),
    review: z
      .object({
        decision: z.enum(["go", "no_go", "pending"]),
        reviewers: z.array(reviewerSchema).max(3),
      })
      .strict(),
    rollback: z
      .object({
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
    tests: z.array(testResultSchema).min(1).max(256),
  })
  .strict()
  .superRefine((receipt, context) => {
    const roles = new Set<string>();
    for (const [index, reviewer] of receipt.review.reviewers.entries()) {
      if (roles.has(reviewer.role)) {
        context.addIssue({
          code: "custom",
          message: "reviewer roles must be unique",
          path: ["review", "reviewers", index, "role"],
        });
      }
      roles.add(reviewer.role);
    }
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
    }
  });

export type ReadinessReceipt = z.infer<typeof readinessReceiptSchema>;

const REQUIRED_REVIEWERS = [
  "release_operator",
  "security_reviewer",
  "product_owner",
] as const;
const REQUIRED_LAYERS = [
  "hermetic_application",
  "deployed_staging",
  "production_smoke",
] as const;

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
  const coveredLayers = new Set(
    receipt.tests
      .filter((result) => result.outcome === "pass")
      .map((result) => result.layer)
  );
  if (REQUIRED_LAYERS.some((layer) => !coveredLayers.has(layer))) {
    violations.push(
      "go decision requires passing evidence for hermetic_application, deployed_staging, and production_smoke"
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
    receipt.retiredProvider.outcome !== "pass" &&
    receipt.retiredProvider.outcome !== "not_applicable"
  ) {
    violations.push(
      "go decision requires retired-provider evidence to pass or be not_applicable"
    );
  }
  return violations;
}

export function validateReadinessReceipt(
  value: unknown,
  expectedSourceSha?: string
): ReadinessReceipt {
  const receipt = readinessReceiptSchema.parse(value);
  const violations = readinessDecisionViolations(receipt);
  if (
    expectedSourceSha !== undefined &&
    receipt.candidate.sourceSha !== expectedSourceSha
  ) {
    violations.push("receipt source SHA does not match the expected candidate");
  }
  if (violations.length > 0) {
    throw new Error(`Readiness receipt is invalid: ${violations.join("; ")}.`);
  }
  return receipt;
}

export function validateReadinessReceiptFile(
  path: string,
  expectedSourceSha?: string
): ReadinessReceipt {
  const contents = readFileSync(path, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error("Readiness receipt is not valid JSON.", { cause: error });
  }
  return validateReadinessReceipt(value, expectedSourceSha);
}

const [, entrypoint, receiptPath, ...argumentsAfterPath] = process.argv;
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  try {
    if (!receiptPath) {
      throw new Error(
        "Usage: pnpm readiness:check <receipt.json> [--expected-sha <git-sha>]"
      );
    }
    const expectedShaIndex = argumentsAfterPath.indexOf("--expected-sha");
    const expectedSourceSha =
      expectedShaIndex === -1
        ? undefined
        : argumentsAfterPath[expectedShaIndex + 1];
    if (
      expectedShaIndex !== -1 &&
      (expectedSourceSha === undefined ||
        argumentsAfterPath.length !== expectedShaIndex + 2)
    ) {
      throw new Error(
        "Usage: pnpm readiness:check <receipt.json> [--expected-sha <git-sha>]"
      );
    }
    validateReadinessReceiptFile(receiptPath, expectedSourceSha);
    process.stdout.write("Readiness receipt passed.\n");
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Readiness receipt is invalid."}\n`
    );
    process.exitCode = 1;
  }
}
