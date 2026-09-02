#!/usr/bin/env tsx

import { randomUUID } from "node:crypto";
import { link, open, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { looksLikeRealSecret, scanText } from "./secret-scan";

export const MAX_STAGING_CERTIFICATION_RESPONSE_BYTES = 65_536;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CREDENTIAL_NAMES = [
  "OPERATOR_DIAGNOSTIC_TOKEN",
  "CRON_SECRET",
  "RUNNER_MANUAL_RECONCILE_SECRET",
] as const;
const safeTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u)
  .refine(
    (value) => scanText("staging-certification-value", value).length === 0
  )
  .refine((value) => !containsOpaqueSecret(value));
const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const deploymentIdSchema = z.string().regex(/^dpl_[A-Za-z0-9]{16,}$/u);
const responseOutcomeSchema = z.enum([
  "passed",
  "refused",
  "unauthorized",
  "credential_accepted",
  "unexpected_response",
  "malformed_response",
  "non_json_response",
  "oversized_response",
  "timeout",
  "unsafe_response",
  "request_failed",
]);

type ResponseOutcome = z.infer<typeof responseOutcomeSchema>;
type OperatorEnvironment = Pick<
  NodeJS.ProcessEnv,
  (typeof CREDENTIAL_NAMES)[number]
> & { STAGING_CERTIFICATION_ORIGIN?: string };

function containsOpaqueSecret(value: string): boolean {
  return (
    value
      .match(/[A-Za-z0-9+_=-]{16,}/gu)
      ?.some(
        (token) =>
          !/^(?:dpl_[A-Za-z0-9]{16,}|[a-f0-9]{40}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/u.test(
            token
          ) &&
          !/^(?:[a-z]{2,15}|\d{1,15}|v\d{1,8})(?:[-_.:/](?:[a-z]{2,15}|\d{1,15}|v\d{1,8}))+$/u.test(
            token
          ) &&
          looksLikeRealSecret(token)
      ) ?? false
  );
}

function exactUtcTimestamp(value: string): boolean {
  const timestamp = new Date(value);
  return (
    !Number.isNaN(timestamp.valueOf()) && timestamp.toISOString() === value
  );
}

function safeOrigin(value: string): boolean {
  try {
    const origin = new URL(value);
    return (
      origin.protocol === "https:" &&
      origin.username === "" &&
      origin.password === "" &&
      origin.pathname === "/" &&
      origin.search === "" &&
      origin.hash === "" &&
      origin.origin === value &&
      scanText("staging-certification-origin", value).length === 0
    );
  } catch {
    return false;
  }
}

const originSchema = z.string().refine(safeOrigin, {
  message: "origin must be an exact HTTPS origin",
});
const buildSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("appBuild"), value: safeTextSchema }).strict(),
  z
    .object({ kind: z.literal("deploymentMetadata"), value: safeTextSchema })
    .strict(),
]);
const candidateSchema = z
  .object({
    build: buildSchema,
    deploymentId: deploymentIdSchema,
    origin: originSchema,
    sourceSha: gitShaSchema,
    sourceTreeSha: gitShaSchema,
  })
  .strict();
const checkResponseSchema = z
  .object({
    method: z.enum(["GET", "POST"]),
    outcome: responseOutcomeSchema,
    route: z
      .string()
      .regex(/^\/(?:api(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+)*|agents)$/u),
    status: z.number().int().min(0).max(599),
  })
  .strict();
const healthCheckSchema = checkResponseSchema
  .extend({
    apiVersion: z.literal("1.0").optional(),
    mode: z.literal("cloud").optional(),
  })
  .strict();
const closedBetaRefusalSchema = checkResponseSchema
  .extend({
    location: z.literal("/login?beta=1").optional(),
  })
  .strict();
const diagnosticCheckSchema = checkResponseSchema
  .extend({
    exitCode: z.literal(0).optional(),
    ok: z.literal(true).optional(),
    output: z.literal("coven-agents").optional(),
  })
  .strict();
const stripeCheckSchema = checkResponseSchema
  .extend({
    execution: z.literal("executed").optional(),
  })
  .strict();
const reconciliationResultSchema = z
  .object({
    adopted: z.number().int().nonnegative(),
    deferred: z.number().int().nonnegative(),
    dispatched: z.number().int().nonnegative(),
    execution: z.literal("executed"),
    expiredScanned: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    logEvents: z.number().int().nonnegative(),
    requeued: z.number().int().nonnegative(),
    sandboxRecovered: z.number().int().nonnegative(),
    terminalCleaned: z.number().int().nonnegative(),
    terminalized: z.number().int().nonnegative(),
    terminalLeaseCleaned: z.number().int().nonnegative(),
  })
  .strict();
const reconciliationCheckSchema = checkResponseSchema
  .extend({
    result: reconciliationResultSchema.optional(),
    sequence: z.union([z.literal(1), z.literal(2)]),
  })
  .strict();
const inventoryCountsSchema = z
  .object({
    ambiguityReasons: z
      .object({
        configurationDrift: z.number().int().nonnegative(),
        databaseBounded: z.number().int().nonnegative(),
        duplicateIdentity: z.number().int().nonnegative(),
        duplicateProviderId: z.number().int().nonnegative(),
        multipleMappings: z.number().int().nonnegative(),
        pendingLifecycle: z.number().int().nonnegative(),
        unresolved: z.number().int().nonnegative(),
      })
      .strict(),
    ambiguous: z.number().int().nonnegative(),
    appOwnedMappings: z.number().int().nonnegative(),
    configurationDrift: z
      .array(
        z
          .object({
            count: z.number().int().positive(),
            field: z.enum([
              "autoArchiveInterval",
              "autoDeleteInterval",
              "autoDestroyAt",
              "autoPauseInterval",
              "autoStopInterval",
              "cpu",
              "disk",
              "domainAllowList",
              "labels",
              "linkedSandbox",
              "memory",
              "name",
              "public",
              "snapshot",
              "target",
              "volumes",
              "warmPool",
            ]),
            relation: z.enum(["above", "below", "different"]),
          })
          .strict()
      )
      .max(32),
    databaseCapped: z.boolean(),
    examined: z.number().int().nonnegative(),
    matched: z.number().int().nonnegative(),
    providerCapped: z.boolean(),
    states: z
      .object({
        active: z.number().int().nonnegative(),
        archived: z.number().int().nonnegative(),
        other: z.number().int().nonnegative(),
        stopped: z.number().int().nonnegative(),
      })
      .strict(),
    status: z.enum(["bounded", "complete"]),
    unowned: z.number().int().nonnegative(),
    version: z.literal(1),
  })
  .strict();
const inventoryCheckSchema = z
  .object({
    after: inventoryCountsSchema,
    before: inventoryCountsSchema,
    method: z.literal("GET"),
    outcome: responseOutcomeSchema,
    route: z.literal("/api/internal/runner-resource-inventory"),
  })
  .strict();
const credentialIsolationSchema = checkResponseSchema
  .extend({
    attemptedCredential: z.enum([
      "diagnostic",
      "manual-reconciliation",
      "scheduled-reconciliation",
    ]),
    intendedCredential: z.enum([
      "diagnostic",
      "manual-reconciliation",
      "scheduled-reconciliation",
    ]),
    requestId: z.string().uuid().optional(),
  })
  .strict();

export const stagingCertificationReceiptSchema = z
  .object({
    candidate: candidateSchema,
    capturedAt: z.string().refine(exactUtcTimestamp),
    certificationScope: z
      .object({
        finalReadinessDecisionIncluded: z.literal(false),
        stagingEvidenceCollectionOnly: z.literal(true),
      })
      .strict(),
    checks: z
      .object({
        closedBetaRefusal: closedBetaRefusalSchema,
        credentialIsolation: z.array(credentialIsolationSchema).length(3),
        health: healthCheckSchema,
        resourceInventory: inventoryCheckSchema,
        runnerReconciliation: z.array(reconciliationCheckSchema).length(2),
        sandboxDiagnostic: diagnosticCheckSchema,
        stripeReconciliation: stripeCheckSchema,
      })
      .strict(),
    containsCredentialMaterial: z.literal(false),
    evidenceFlags: z
      .object({
        approvalsCompleted: z.literal(false),
        diagnosticLifecycleCertified: z.boolean(),
        observationWindowCompleted: z.literal(false),
        persistentSandboxLifecycleCertified: z.literal(false),
        resourceDispositionCertified: z.literal(false),
        stripeCheckoutWebhookFailureRetryCertified: z.literal(false),
        subscriberLifecycleCertified: z.literal(false),
      })
      .strict(),
    schemaVersion: z.literal(1),
  })
  .strict();

export type StagingCertificationReceipt = z.infer<
  typeof stagingCertificationReceiptSchema
>;
export type StagingCertificationArguments = z.infer<typeof candidateSchema> & {
  output: string;
};
type SafeResponse = {
  body: unknown | null;
  location?: "/login?beta=1";
  outcome: ResponseOutcome;
  status: number;
};
type RequestDependencies = {
  fetch?: typeof fetch;
  now?: () => Date;
  requestTimeoutMs?: number;
};

function usageError(cause?: unknown): Error {
  return new Error(
    "Usage: pnpm staging:certify -- --origin <https-origin> --deployment-id <deployment-id> --source-sha <git-sha> --source-tree-sha <git-tree-sha> (--app-build <build> | --deployment-metadata <metadata>) --output <receipt.json> --confirm-effects",
    cause === undefined ? undefined : { cause }
  );
}

export function parseStagingCertificationArguments(
  values: string[]
): StagingCertificationArguments {
  const allowedFlags = new Set([
    "--app-build",
    "--confirm-effects",
    "--deployment-id",
    "--deployment-metadata",
    "--origin",
    "--output",
    "--source-sha",
    "--source-tree-sha",
  ]);
  const flags = new Map<string, string>();

  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (flag === "--confirm-effects") {
      if (flags.has(flag)) {
        throw usageError();
      }
      flags.set(flag, "true");
      continue;
    }
    if (!flag || !allowedFlags.has(flag) || flags.has(flag)) {
      throw usageError();
    }
    const value = values[index + 1];
    if (!value || value.startsWith("--")) {
      throw usageError();
    }
    flags.set(flag, value);
    index += 1;
  }

  if (flags.get("--confirm-effects") !== "true") {
    throw usageError();
  }
  const appBuild = flags.get("--app-build");
  const deploymentMetadata = flags.get("--deployment-metadata");
  if ((appBuild === undefined) === (deploymentMetadata === undefined)) {
    throw usageError();
  }

  try {
    const candidate = candidateSchema.parse({
      build:
        appBuild === undefined
          ? { kind: "deploymentMetadata", value: deploymentMetadata }
          : { kind: "appBuild", value: appBuild },
      deploymentId: flags.get("--deployment-id"),
      origin: flags.get("--origin"),
      sourceSha: flags.get("--source-sha"),
      sourceTreeSha: flags.get("--source-tree-sha"),
    });
    const output = flags.get("--output");
    if (!output || output.includes("\0") || !output.endsWith(".json")) {
      throw usageError();
    }
    return { ...candidate, output };
  } catch (error) {
    throw usageError(error);
  }
}

function operatorCredentials(
  environment: Partial<OperatorEnvironment>
): Record<(typeof CREDENTIAL_NAMES)[number], string> | null {
  const values = CREDENTIAL_NAMES.map((name) => environment[name]?.trim());
  return values.every((value) => value && !/[\r\n]/u.test(value)) &&
    new Set(values).size === CREDENTIAL_NAMES.length
    ? {
        CRON_SECRET: values[1] as string,
        OPERATOR_DIAGNOSTIC_TOKEN: values[0] as string,
        RUNNER_MANUAL_RECONCILE_SECRET: values[2] as string,
      }
    : null;
}

function preapprovedOrigin(
  environment: Partial<OperatorEnvironment>
): string | null {
  const origin = environment.STAGING_CERTIFICATION_ORIGIN?.trim();
  return origin && safeOrigin(origin) ? origin : null;
}

function redactUnsafeResponse(text: string): boolean {
  return (
    scanText("staging-certification-response.json", text).length > 0 ||
    containsOpaqueSecret(text)
  );
}

async function readJsonResponse(
  response: Response,
  controller: AbortController
): Promise<SafeResponse> {
  if (
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("application/json")
  ) {
    return {
      body: null,
      outcome: "non_json_response",
      status: response.status,
    };
  }
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/u.test(contentLength) ||
      Number(contentLength) > MAX_STAGING_CERTIFICATION_RESPONSE_BYTES)
  ) {
    controller.abort();
    return {
      body: null,
      outcome: "oversized_response",
      status: response.status,
    };
  }
  if (!response.body) {
    return {
      body: null,
      outcome: "malformed_response",
      status: response.status,
    };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      // biome-ignore lint/performance/noAwaitInLoops: enforce the byte limit while streaming.
      const next = await reader.read();
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > MAX_STAGING_CERTIFICATION_RESPONSE_BYTES) {
        controller.abort();
        await reader.cancel();
        return {
          body: null,
          outcome: "oversized_response",
          status: response.status,
        };
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (redactUnsafeResponse(text)) {
      return {
        body: null,
        outcome: "unsafe_response",
        status: response.status,
      };
    }
    return {
      body: JSON.parse(text) as unknown,
      outcome: "passed",
      status: response.status,
    };
  } catch {
    return {
      body: null,
      outcome: "malformed_response",
      status: response.status,
    };
  } finally {
    reader.releaseLock();
  }
}

async function requestJson(
  origin: string,
  route: string,
  method: "GET" | "POST",
  credential: string | undefined,
  dependencies: RequestDependencies
): Promise<SafeResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    dependencies.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  );
  try {
    const response = await (dependencies.fetch ?? fetch)(
      new URL(route, origin),
      {
        headers: credential
          ? { authorization: `Bearer ${credential}` }
          : undefined,
        method,
        redirect: "manual",
        signal: controller.signal,
      }
    );
    if (response.status === 307) {
      return {
        body: null,
        location:
          response.headers.get("location") === "/login?beta=1"
            ? "/login?beta=1"
            : undefined,
        outcome: "unexpected_response",
        status: response.status,
      };
    }
    return await readJsonResponse(response, controller);
  } catch {
    return {
      body: null,
      outcome: controller.signal.aborted ? "timeout" : "request_failed",
      status: 0,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function checkResponse(
  response: SafeResponse,
  method: "GET" | "POST",
  route: string
): z.infer<typeof checkResponseSchema> {
  return {
    method,
    outcome: response.outcome,
    route,
    status: response.status,
  };
}

const healthResponseSchema = z
  .object({
    apiVersion: z.literal("1.0"),
    capabilities: z
      .array(z.string().regex(/^[a-z][a-z-]*$/u))
      .min(1)
      .max(32),
    minimumClientVersion: z.literal("1.0.0"),
    mode: z.literal("cloud"),
  })
  .strict();
const diagnosticResponseSchema = z
  .object({
    exitCode: z.literal(0),
    ok: z.literal(true),
    output: z.literal("coven-agents"),
  })
  .strict();
const stripeResponseSchema = z
  .object({
    applied: z.literal(0),
    conflicts: z.literal(0),
    deferred: z.literal(0),
    execution: z.literal("executed"),
    failures: z.literal(0),
    scanned: z.literal(0),
    unchanged: z.literal(0),
  })
  .strict();
const unauthorizedResponseSchema = z
  .object({
    apiVersion: z.literal("1.0"),
    error: z
      .object({
        code: z.literal("unauthorized"),
        message: z.literal("Operator token was rejected."),
        retryable: z.literal(false),
      })
      .strict(),
    requestId: z.string().uuid(),
  })
  .strict();

function parseResponse<T>(
  response: SafeResponse,
  schema: z.ZodType<T>
): T | null {
  if (response.outcome !== "passed") {
    return null;
  }
  const result = schema.safeParse(response.body);
  return result.success ? result.data : null;
}

function expectedCheck<T extends z.infer<typeof checkResponseSchema>>(
  response: SafeResponse,
  method: "GET" | "POST",
  route: string,
  schema: z.ZodType<unknown>,
  enrich: (body: unknown, check: z.infer<typeof checkResponseSchema>) => T
): T {
  const check = checkResponse(response, method, route);
  const body = parseResponse(response, schema);
  return body && response.status === 200
    ? enrich(body, { ...check, outcome: "passed" })
    : (check as T);
}

function credentialProbe(
  response: SafeResponse,
  method: "GET" | "POST",
  route: string,
  attemptedCredential: z.infer<
    typeof credentialIsolationSchema
  >["attemptedCredential"],
  intendedCredential: z.infer<
    typeof credentialIsolationSchema
  >["intendedCredential"]
): z.infer<typeof credentialIsolationSchema> {
  const check = checkResponse(response, method, route);
  const body = parseResponse(response, unauthorizedResponseSchema);
  if (response.status === 401 && body) {
    return {
      ...check,
      attemptedCredential,
      intendedCredential,
      outcome: "unauthorized",
      requestId: body.requestId,
    };
  }
  return {
    ...check,
    attemptedCredential,
    intendedCredential,
    outcome:
      response.outcome === "passed" &&
      response.status >= 200 &&
      response.status < 300
        ? "credential_accepted"
        : response.outcome,
  };
}

export async function collectStagingCertification(
  arguments_: StagingCertificationArguments,
  environment: Partial<OperatorEnvironment>,
  dependencies: RequestDependencies = {}
): Promise<StagingCertificationReceipt> {
  const credentials = operatorCredentials(environment);
  if (!credentials) {
    throw new Error("Required configuration is unavailable.");
  }
  const preapproved = preapprovedOrigin(environment);
  if (preapproved !== null && preapproved !== arguments_.origin) {
    throw new Error("Staging origin is not approved.");
  }
  const { origin } = arguments_;
  const health = await requestJson(
    origin,
    "/api/health",
    "GET",
    undefined,
    dependencies
  );
  const closedBeta = await requestJson(
    origin,
    "/agents",
    "GET",
    undefined,
    dependencies
  );
  const diagnostic = await requestJson(
    origin,
    "/api/diagnostics/sandbox",
    "POST",
    credentials.OPERATOR_DIAGNOSTIC_TOKEN,
    dependencies
  );
  const stripe = await requestJson(
    origin,
    "/api/internal/stripe-reconcile",
    "GET",
    credentials.CRON_SECRET,
    dependencies
  );
  const inventoryBefore = await requestJson(
    origin,
    "/api/internal/runner-resource-inventory",
    "GET",
    credentials.CRON_SECRET,
    dependencies
  );
  const firstReconciliation = await requestJson(
    origin,
    "/api/internal/runner-reconcile",
    "POST",
    credentials.RUNNER_MANUAL_RECONCILE_SECRET,
    dependencies
  );
  const secondReconciliation = await requestJson(
    origin,
    "/api/internal/runner-reconcile",
    "POST",
    credentials.RUNNER_MANUAL_RECONCILE_SECRET,
    dependencies
  );
  const inventoryAfter = await requestJson(
    origin,
    "/api/internal/runner-resource-inventory",
    "GET",
    credentials.CRON_SECRET,
    dependencies
  );
  const diagnosticAsCron = await requestJson(
    origin,
    "/api/internal/runner-resource-inventory",
    "GET",
    credentials.OPERATOR_DIAGNOSTIC_TOKEN,
    dependencies
  );
  const manualAsDiagnostic = await requestJson(
    origin,
    "/api/diagnostics/sandbox",
    "POST",
    credentials.RUNNER_MANUAL_RECONCILE_SECRET,
    dependencies
  );
  const cronAsManual = await requestJson(
    origin,
    "/api/internal/runner-reconcile",
    "POST",
    credentials.CRON_SECRET,
    dependencies
  );

  const healthCheck = expectedCheck(
    health,
    "GET",
    "/api/health",
    healthResponseSchema,
    (body, check) => {
      const value = body as z.infer<typeof healthResponseSchema>;
      return { ...check, apiVersion: value.apiVersion, mode: value.mode };
    }
  );
  const closedBetaCheck = checkResponse(closedBeta, "GET", "/agents");
  const closedBetaLocation = closedBeta.location;
  const closedBetaRefusal =
    closedBeta.status === 307 && closedBetaLocation === "/login?beta=1"
      ? {
          ...closedBetaCheck,
          location: closedBetaLocation,
          outcome: "refused" as const,
        }
      : {
          ...closedBetaCheck,
          outcome:
            closedBetaCheck.outcome === "passed"
              ? ("unexpected_response" as const)
              : closedBetaCheck.outcome,
        };
  const diagnosticCheck = expectedCheck(
    diagnostic,
    "POST",
    "/api/diagnostics/sandbox",
    diagnosticResponseSchema,
    (body, check) => {
      const value = body as z.infer<typeof diagnosticResponseSchema>;
      return {
        ...check,
        exitCode: value.exitCode,
        ok: value.ok,
        output: value.output,
      };
    }
  );
  const stripeCheck = expectedCheck(
    stripe,
    "GET",
    "/api/internal/stripe-reconcile",
    stripeResponseSchema,
    (body, check) => ({
      ...check,
      execution: (body as z.infer<typeof stripeResponseSchema>).execution,
    })
  );
  const before = parseResponse(inventoryBefore, inventoryCountsSchema);
  const after = parseResponse(inventoryAfter, inventoryCountsSchema);
  if (!before || !after) {
    throw new Error("Staging inventory evidence is unavailable.");
  }
  const inventoryOutcome =
    inventoryBefore.status === 200 &&
    inventoryAfter.status === 200 &&
    before &&
    after
      ? "passed"
      : inventoryBefore.outcome === "passed"
        ? inventoryAfter.outcome === "passed"
          ? "unexpected_response"
          : inventoryAfter.outcome
        : inventoryBefore.outcome;
  const inventory = {
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    method: "GET" as const,
    outcome: inventoryOutcome,
    route: "/api/internal/runner-resource-inventory" as const,
  };
  const reconciliation = (
    response: SafeResponse,
    sequence: 1 | 2
  ): z.infer<typeof reconciliationCheckSchema> => {
    const result = parseResponse(response, reconciliationResultSchema);
    return response.status === 200 && result
      ? {
          ...checkResponse(response, "POST", "/api/internal/runner-reconcile"),
          outcome: "passed",
          result,
          sequence,
        }
      : {
          ...checkResponse(response, "POST", "/api/internal/runner-reconcile"),
          sequence,
        };
  };

  return stagingCertificationReceiptSchema.parse({
    candidate: {
      build: arguments_.build,
      deploymentId: arguments_.deploymentId,
      origin: arguments_.origin,
      sourceSha: arguments_.sourceSha,
      sourceTreeSha: arguments_.sourceTreeSha,
    },
    capturedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    certificationScope: {
      finalReadinessDecisionIncluded: false,
      stagingEvidenceCollectionOnly: true,
    },
    checks: {
      closedBetaRefusal,
      credentialIsolation: [
        credentialProbe(
          diagnosticAsCron,
          "GET",
          "/api/internal/runner-resource-inventory",
          "diagnostic",
          "scheduled-reconciliation"
        ),
        credentialProbe(
          manualAsDiagnostic,
          "POST",
          "/api/diagnostics/sandbox",
          "manual-reconciliation",
          "diagnostic"
        ),
        credentialProbe(
          cronAsManual,
          "POST",
          "/api/internal/runner-reconcile",
          "scheduled-reconciliation",
          "manual-reconciliation"
        ),
      ],
      health: healthCheck,
      resourceInventory: inventory,
      runnerReconciliation: [
        reconciliation(firstReconciliation, 1),
        reconciliation(secondReconciliation, 2),
      ],
      sandboxDiagnostic: diagnosticCheck,
      stripeReconciliation: stripeCheck,
    },
    containsCredentialMaterial: false,
    evidenceFlags: {
      approvalsCompleted: false,
      diagnosticLifecycleCertified: diagnosticCheck.outcome === "passed",
      observationWindowCompleted: false,
      persistentSandboxLifecycleCertified: false,
      resourceDispositionCertified: false,
      stripeCheckoutWebhookFailureRetryCertified: false,
      subscriberLifecycleCertified: false,
    },
    schemaVersion: 1,
  });
}

function receiptContainsCredentialMaterial(
  receipt: StagingCertificationReceipt,
  environment: Partial<OperatorEnvironment>
): boolean {
  const serialized = JSON.stringify(receipt);
  return (
    scanText("staging-certification-receipt.json", serialized).length > 0 ||
    containsOpaqueSecret(serialized) ||
    Object.values(environment).some(
      (value) =>
        value !== undefined && value !== "" && serialized.includes(value)
    )
  );
}

export async function writeStagingCertificationReceipt(
  receipt: StagingCertificationReceipt,
  outputPath: string,
  environment: Partial<OperatorEnvironment>,
  dependencies: { randomSuffix?: () => string } = {}
): Promise<void> {
  if (receiptContainsCredentialMaterial(receipt, environment)) {
    throw new Error("Receipt contains credential material.");
  }
  const parsedReceipt = stagingCertificationReceiptSchema.parse(receipt);
  let outputExists = false;
  try {
    await stat(outputPath);
    outputExists = true;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
  if (outputExists) {
    throw new Error("Receipt output already exists.");
  }

  const directory = dirname(outputPath);
  const temporaryPath = join(
    directory,
    `.${basename(outputPath)}.${process.pid}.${dependencies.randomSuffix?.() ?? randomUUID()}.tmp`
  );
  let temporaryCreated = false;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(
        `${JSON.stringify(parsedReceipt, null, 2)}\n`,
        "utf8"
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporaryPath, outputPath);
    await unlink(temporaryPath);
    temporaryCreated = false;
  } catch (error) {
    if (temporaryCreated) {
      await rm(temporaryPath, { force: true });
    }
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error("Receipt output already exists.", { cause: error });
    }
    throw error;
  }
}

export async function runStagingCertificationCli(
  values: string[],
  environment: Partial<OperatorEnvironment>,
  dependencies: RequestDependencies & {
    stderr?: (message: string) => void;
    stdout?: (message: string) => void;
  } = {}
): Promise<number> {
  const stderr =
    dependencies.stderr ?? ((message: string) => process.stderr.write(message));
  const stdout =
    dependencies.stdout ?? ((message: string) => process.stdout.write(message));
  let arguments_: StagingCertificationArguments;
  try {
    arguments_ = parseStagingCertificationArguments(values);
  } catch {
    stderr("Staging certification arguments are invalid.\n");
    return 2;
  }
  if (!operatorCredentials(environment)) {
    stderr("Staging certification configuration is unavailable.\n");
    return 2;
  }
  if (preapprovedOrigin(environment) !== arguments_.origin) {
    stderr("Staging certification configuration is unavailable.\n");
    return 2;
  }
  try {
    const receipt = await collectStagingCertification(
      arguments_,
      environment,
      dependencies
    );
    await writeStagingCertificationReceipt(
      receipt,
      arguments_.output,
      environment
    );
    stdout("Staging certification evidence collected.\n");
    return 0;
  } catch {
    stderr("Staging certification could not complete.\n");
    return 1;
  }
}

const [, entrypoint, ...argumentsAfterEntrypoint] = process.argv;
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runStagingCertificationCli(
    argumentsAfterEntrypoint,
    process.env as Partial<OperatorEnvironment>
  ).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write("Staging certification could not complete.\n");
      process.exitCode = 1;
    }
  );
}
