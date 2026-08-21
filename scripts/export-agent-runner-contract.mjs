import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const jsonPath = resolve(
  root,
  "packages/agent-contracts/fixtures/agent-runner-v1.json"
);
const hashPath = resolve(
  root,
  "packages/agent-contracts/fixtures/agent-runner-v1.sha256"
);
const jsonName = "agent-runner-v1.json";

const capabilities = [
  "agent-profiles",
  "async-runs",
  "idempotent-runs",
  "run-events",
  "run-cancel",
  "command-evidence",
  "file-evidence",
];

const fixture = {
  apiVersion: "1.0",
  capabilities,
  eventTypes: [
    "accepted",
    "status",
    "output",
    "command",
    "file",
    "completed",
    "failed",
  ],
  examples: {
    error: {
      apiVersion: "1.0",
      error: {
        code: "run_not_found",
        details: "The requested run does not exist.",
        message: "Run was not found.",
        retryable: false,
      },
      requestId: "request-123",
    },
    health: {
      apiVersion: "1.0",
      capabilities,
      minimumClientVersion: "1.0.0",
      mode: "local",
    },
    success: {
      apiVersion: "1.0",
      run: {
        agentId: "53af1a29-4e98-43d6-ac5b-3b9dcba5e730",
        apiVersion: "1.0",
        commandEvidence: [],
        completedAt: null,
        createdAt: "2026-08-20T19:00:00.000Z",
        fileEvidence: [],
        id: "3a3f2c72-9b1b-47f7-8c83-28d5f94bf4ce",
        operationId: "0f6f31ae-7b6c-49c9-bc82-0f2cbf56cc4d",
        output: "",
        startedAt: null,
        status: "queued",
        task: "Run the tests.",
      },
    },
  },
  limits: {
    maxCommandLength: 8000,
    maxDescriptionLength: 240,
    maxDetailsLength: 2000,
    maxEventOutputLength: 100_000,
    maxInstructionsLength: 12_000,
    maxMessageLength: 500,
    maxModelLength: 120,
    maxOwnerIdLength: 128,
    maxPathLength: 1024,
    maxRequestIdLength: 128,
    maxSourceRevisionLength: 256,
    maxTaskLength: 40_000,
    maxWorkspaceLength: 1024,
  },
  owners: [
    { kind: "standalone" },
    {
      caveInstanceId: "cave-123",
      familiarId: "familiar-123",
      kind: "cave-familiar",
      sourceRevision: "rev-2026-08-20",
    },
  ],
  routes: [
    { method: "GET", path: "/api/health" },
    { method: "POST", path: "/api/agents/:agentId/runs" },
    { method: "GET", path: "/api/agents/:agentId/runs/:runId" },
    { method: "POST", path: "/api/agents/:agentId/runs/:runId/stop" },
  ],
  statuses: ["queued", "running", "completed", "failed", "cancelled"],
};

const prettyJson = JSON.stringify(fixture, null, 2);
const multilineStatuses = JSON.stringify(fixture.statuses, null, 2).replace(
  /\n/g,
  "\n  "
);
const json = `${prettyJson.replace(
  `  "statuses": ${multilineStatuses}`,
  `  "statuses": ${JSON.stringify(fixture.statuses).replaceAll(",", ", ")}`
)}\n`;
const digest = createHash("sha256").update(json, "utf8").digest("hex");
const hash = `${digest}  ${jsonName}\n`;

function checkFile(path, expected) {
  try {
    return readFileSync(path, "utf8") === expected;
  } catch {
    return false;
  }
}

if (process.argv.includes("--check")) {
  const jsonMatches = checkFile(jsonPath, json);
  const hashMatches = checkFile(hashPath, hash);
  if (!jsonMatches || !hashMatches) {
    if (!jsonMatches) {
      console.error(`Contract fixture differs: ${jsonPath}`);
    }
    if (!hashMatches) {
      console.error(`Contract checksum differs: ${hashPath}`);
    }
    process.exitCode = 1;
  }
} else {
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, json);
  writeFileSync(hashPath, hash);
}
