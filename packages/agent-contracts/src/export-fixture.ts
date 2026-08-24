import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import type {
  AgentOwner,
  AgentRunnerCapability,
  AgentRunnerHealth,
  AgentRunnerLimits,
  AgentRunnerRoute,
  RunErrorEnvelope,
  RunEventType,
  RunSnapshotEnvelope,
  RunStatus,
} from "./index";
import {
  AGENT_RUNNER_API_VERSION,
  AGENT_RUNNER_CAPABILITIES,
  AGENT_RUNNER_EVENT_TYPES,
  AGENT_RUNNER_LIMITS,
  AGENT_RUNNER_ROUTES,
  AGENT_RUNNER_STATUSES,
  agentOwnerSchema,
  agentRunnerApiVersionSchema,
  agentRunnerCapabilitiesSchema,
  agentRunnerEventTypesSchema,
  agentRunnerHealthSchema,
  agentRunnerLimitsSchema,
  agentRunnerRoutesSchema,
  agentRunnerStatusesSchema,
  runErrorEnvelopeSchema,
  runSnapshotEnvelopeSchema,
} from "./index";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureDirectory = resolve(root, "packages/agent-contracts/fixtures");
const jsonPath = resolve(fixtureDirectory, "agent-runner-v1.json");
const hashPath = resolve(fixtureDirectory, "agent-runner-v1.sha256");
const jsonName = "agent-runner-v1.json";

const sourceOwners = [
  { kind: "standalone" },
  {
    caveInstanceId: "cave-123",
    familiarId: "familiar-123",
    kind: "cave-familiar",
    sourceRevision: "rev-2026-08-20",
  },
] satisfies readonly z.input<typeof agentOwnerSchema>[];

const sourceExamples = {
  error: {
    apiVersion: AGENT_RUNNER_API_VERSION,
    error: {
      code: "run_not_found",
      details: "The requested run does not exist.",
      message: "Run was not found.",
      retryable: false,
    },
    requestId: "request-123",
  },
  health: {
    apiVersion: AGENT_RUNNER_API_VERSION,
    capabilities: [...AGENT_RUNNER_CAPABILITIES],
    minimumClientVersion: "1.0.0",
    mode: "local",
  },
  success: {
    apiVersion: AGENT_RUNNER_API_VERSION,
    run: {
      agentId: "53af1a29-4e98-43d6-ac5b-3b9dcba5e730",
      apiVersion: AGENT_RUNNER_API_VERSION,
      commandEvidence: [],
      completedAt: null,
      createdAt: "2026-08-20T19:00:00.000Z",
      fileEvidence: [],
      id: "3a3f2c72-9b1b-47f7-8c83-28d5f94bf4ce",
      operationId: "0f6f31ae-7b6c-49c9-bc82-0f2cbf56cc4d",
      output: "",
      startedAt: null,
      status: AGENT_RUNNER_STATUSES[0],
      task: "Run the tests.",
    },
  },
} satisfies {
  error: z.input<typeof runErrorEnvelopeSchema>;
  health: z.input<typeof agentRunnerHealthSchema>;
  success: z.input<typeof runSnapshotEnvelopeSchema>;
};

export type AgentRunnerFixture = {
  apiVersion: string;
  capabilities: AgentRunnerCapability[];
  eventTypes: RunEventType[];
  examples: {
    error: RunErrorEnvelope;
    health: AgentRunnerHealth;
    success: RunSnapshotEnvelope;
  };
  limits: AgentRunnerLimits;
  owners: AgentOwner[];
  routes: AgentRunnerRoute[];
  statuses: RunStatus[];
};

export type AgentRunnerFixtureOverrides = {
  examples?: Partial<{
    error: unknown;
    health: unknown;
    success: unknown;
  }>;
  owners?: unknown;
};

function parseFixtureSection<T>(
  section: string,
  schema: z.ZodType<T>,
  value: unknown
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid ${section}: ${result.error.message}`);
  }
  return result.data;
}

export function buildAgentRunnerFixture(
  overrides: AgentRunnerFixtureOverrides = {}
): AgentRunnerFixture {
  const exampleSources = {
    ...sourceExamples,
    ...overrides.examples,
  };

  return {
    apiVersion: parseFixtureSection(
      "apiVersion",
      agentRunnerApiVersionSchema,
      AGENT_RUNNER_API_VERSION
    ),
    capabilities: parseFixtureSection(
      "capabilities",
      agentRunnerCapabilitiesSchema,
      [...AGENT_RUNNER_CAPABILITIES]
    ),
    eventTypes: parseFixtureSection("eventTypes", agentRunnerEventTypesSchema, [
      ...AGENT_RUNNER_EVENT_TYPES,
    ]),
    examples: {
      error: parseFixtureSection(
        "examples.error",
        runErrorEnvelopeSchema,
        exampleSources.error
      ),
      health: parseFixtureSection(
        "examples.health",
        agentRunnerHealthSchema,
        exampleSources.health
      ),
      success: parseFixtureSection(
        "examples.success",
        runSnapshotEnvelopeSchema,
        exampleSources.success
      ),
    },
    limits: parseFixtureSection(
      "limits",
      agentRunnerLimitsSchema,
      AGENT_RUNNER_LIMITS
    ),
    owners: parseFixtureSection(
      "owners",
      agentOwnerSchema.array(),
      overrides.owners ?? sourceOwners
    ),
    routes: parseFixtureSection("routes", agentRunnerRoutesSchema, [
      ...AGENT_RUNNER_ROUTES,
    ]),
    statuses: parseFixtureSection("statuses", agentRunnerStatusesSchema, [
      ...AGENT_RUNNER_STATUSES,
    ]),
  };
}

export function serializeAgentRunnerFixture(
  fixture = buildAgentRunnerFixture()
): string {
  const prettyJson = JSON.stringify(fixture, null, 2);
  const multilineStatuses = JSON.stringify(fixture.statuses, null, 2).replace(
    /\n/g,
    "\n  "
  );
  return `${prettyJson.replace(
    `  "statuses": ${multilineStatuses}`,
    `  "statuses": ${JSON.stringify(fixture.statuses).replaceAll(",", ", ")}`
  )}\n`;
}

export function getAgentRunnerContractArtifacts() {
  const fixture = buildAgentRunnerFixture();
  const json = serializeAgentRunnerFixture(fixture);
  const digest = createHash("sha256").update(json, "utf8").digest("hex");
  const hash = `${digest}  ${jsonName}\n`;
  return { fixture, hash, json };
}

function readMatches(path: string, expected: string) {
  try {
    return readFileSync(path, "utf8") === expected;
  } catch {
    return false;
  }
}

export function exportAgentRunnerContract(check = false) {
  const { hash, json } = getAgentRunnerContractArtifacts();

  if (check) {
    const jsonMatches = readMatches(jsonPath, json);
    const hashMatches = readMatches(hashPath, hash);
    if (!jsonMatches || !hashMatches) {
      if (!jsonMatches) {
        console.error(`Contract fixture differs: ${jsonPath}`);
      }
      if (!hashMatches) {
        console.error(`Contract checksum differs: ${hashPath}`);
      }
      return false;
    }
    return true;
  }

  mkdirSync(fixtureDirectory, { recursive: true });
  writeFileSync(jsonPath, json);
  writeFileSync(hashPath, hash);
  return true;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = exportAgentRunnerContract(process.argv.includes("--check"))
    ? 0
    : 1;
}
