import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { contractDescriptor } from "../contract-descriptor";
import {
  buildAgentRunnerFixture,
  getAgentRunnerContractArtifacts,
} from "./export-fixture";
import {
  AGENT_RUNNER_API_VERSION,
  AGENT_RUNNER_CAPABILITIES,
  AGENT_RUNNER_EVENT_TYPES,
  AGENT_RUNNER_LIMITS,
  AGENT_RUNNER_ROUTES,
  AGENT_RUNNER_STATUSES,
  agentOwnerSchema,
  agentRunnerHealthSchema,
  runErrorEnvelopeSchema,
  runSnapshotEnvelopeSchema,
} from "./index";

const fixturePath = fileURLToPath(
  new URL("../fixtures/agent-runner-v1.json", import.meta.url)
);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

test("validates every owner and representative example with exported schemas", () => {
  const fixture = buildAgentRunnerFixture();
  const serializedFixture = JSON.parse(readFileSync(fixturePath, "utf8"));

  assert.deepEqual(
    agentOwnerSchema.array().parse(fixture.owners),
    fixture.owners
  );
  assert.deepEqual(
    agentRunnerHealthSchema.parse(fixture.examples.health),
    fixture.examples.health
  );
  assert.deepEqual(
    runErrorEnvelopeSchema.parse(fixture.examples.error),
    fixture.examples.error
  );
  assert.deepEqual(
    runSnapshotEnvelopeSchema.parse(fixture.examples.success),
    fixture.examples.success
  );
  assert.deepEqual(
    agentOwnerSchema.array().parse(serializedFixture.owners),
    serializedFixture.owners
  );
  assert.deepEqual(
    agentRunnerHealthSchema.parse(serializedFixture.examples.health),
    serializedFixture.examples.health
  );
  assert.deepEqual(
    runErrorEnvelopeSchema.parse(serializedFixture.examples.error),
    serializedFixture.examples.error
  );
  assert.deepEqual(
    runSnapshotEnvelopeSchema.parse(serializedFixture.examples.success),
    serializedFixture.examples.success
  );
});

test("fails export when an owner or example violates its schema", () => {
  assert.throws(
    () =>
      buildAgentRunnerFixture({
        owners: [{ kind: "cave-familiar" }],
      }),
    /owners/
  );
  assert.throws(
    () =>
      buildAgentRunnerFixture({
        examples: {
          error: {
            apiVersion: AGENT_RUNNER_API_VERSION,
            error: {
              code: "run_not_found",
              message: "",
              retryable: false,
            },
            requestId: "request-123",
          },
        },
      }),
    /examples\.error/
  );
  assert.throws(
    () =>
      buildAgentRunnerFixture({
        examples: {
          health: {
            apiVersion: AGENT_RUNNER_API_VERSION,
            capabilities: ["not-a-capability"],
            minimumClientVersion: "1.0.0",
            mode: "local",
          },
        },
      }),
    /examples\.health/
  );
  assert.throws(
    () =>
      buildAgentRunnerFixture({
        examples: {
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
              status: "not-a-status",
              task: "Run the tests.",
            },
          },
        },
      }),
    /examples\.success/
  );
});

test("uses one typed descriptor source for runtime exports", () => {
  assert.deepEqual(contractDescriptor.apiVersions, [AGENT_RUNNER_API_VERSION]);
  assert.deepEqual(contractDescriptor.capabilities, AGENT_RUNNER_CAPABILITIES);
  assert.deepEqual(contractDescriptor.eventTypes, AGENT_RUNNER_EVENT_TYPES);
  assert.deepEqual(contractDescriptor.limits, AGENT_RUNNER_LIMITS);
  assert.deepEqual(contractDescriptor.routes, AGENT_RUNNER_ROUTES);
  assert.deepEqual(contractDescriptor.statuses, AGENT_RUNNER_STATUSES);
  assert.equal(existsSync(`${packageRoot}/contract-descriptor.mjs`), false);
  assert.equal(existsSync(`${packageRoot}/contract-descriptor.d.mts`), false);
});

test("serializes the validated fixture and checksum deterministically", () => {
  const { json, hash } = getAgentRunnerContractArtifacts();

  assert.equal(json, readFileSync(fixturePath, "utf8"));
  assert.equal(
    hash,
    readFileSync(
      fileURLToPath(
        new URL("../fixtures/agent-runner-v1.sha256", import.meta.url)
      ),
      "utf8"
    )
  );
});
