import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_RUNNER_LIMITS } from "@opencoven/agent-contracts";
import { FILE_OPERATIONS, toFileEvidence, toRunResult } from "./agents";
import type { CloudRunRecord } from "./run-state";

/**
 * The harness reports file operations in the past tense and the contract
 * accepts the imperative. Nothing in the type system connects the two, so this
 * is the test that catches the vocabularies drifting apart.
 */
test("every operation the harness emits maps onto a contract operation", () => {
  const emitted = ["created", "edited", "deleted"];

  const evidence = toFileEvidence(
    emitted.map((operation) => ({ operation, path: "/workspace/a.ts" }))
  );

  assert.deepEqual(
    evidence.map((entry) => entry.operation),
    ["create", "modify", "delete"]
  );
  assert.equal(
    evidence.length,
    emitted.length,
    "no harness operation may be dropped"
  );
});

test("filtering to contract values instead of mapping would drop everything", () => {
  // Guards the specific mistake this mapping exists to prevent: the harness
  // emits none of the strings the contract accepts, so a filter matches zero.
  const contractValues = new Set(Object.values(FILE_OPERATIONS));
  for (const emitted of Object.keys(FILE_OPERATIONS)) {
    assert.equal(
      contractValues.has(emitted as never),
      false,
      `${emitted} must not already be a contract value, or this mapping is pointless`
    );
  }
});

test("an operation the contract has not learned is dropped, not guessed", () => {
  const evidence = toFileEvidence([
    { operation: "renamed", path: "/workspace/a.ts" },
    { operation: "created", path: "/workspace/b.ts" },
  ]);

  assert.deepEqual(evidence, [
    { operation: "create", path: "/workspace/b.ts" },
  ]);
});

function record(overrides: Record<string, unknown> = {}) {
  return {
    events: [],
    operationHash: "hash",
    run: {
      agentId: "53af1a29-4e98-43d6-ac5b-3b9dcba5e730",
      apiVersion: "2026-08-01",
      commandEvidence: [],
      completedAt: "2026-08-20T12:00:05.000Z",
      createdAt: "2026-08-20T12:00:00.000Z",
      fileEvidence: [],
      id: "9c1b7d2f-5a6b-4c90-8f1a-0f4e1f4d4a2e",
      operationId: "3f1a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90",
      output: "done",
      startedAt: "2026-08-20T12:00:01.000Z",
      status: "completed",
      task: "Fix the tests.",
      ...overrides,
    },
  } as unknown as CloudRunRecord;
}

test("a cancelled run reports as failed to a caller waiting on a result", () => {
  // RunResult has no cancelled state. Reporting it as completed would tell the
  // caller the work succeeded.
  assert.equal(toRunResult(record({ status: "cancelled" })).status, "failed");
  assert.equal(toRunResult(record({ status: "failed" })).status, "failed");
  assert.equal(
    toRunResult(record({ status: "completed" })).status,
    "completed"
  );
});

test("a run that never started still reports usable timestamps", () => {
  const result = toRunResult(
    record({ completedAt: null, startedAt: null, status: "failed" })
  );

  assert.equal(result.startedAt, "2026-08-20T12:00:00.000Z");
  assert.equal(result.completedAt, "2026-08-20T12:00:00.000Z");
});

test("command evidence is capped rather than returned unbounded", () => {
  const limit = AGENT_RUNNER_LIMITS.maxCommandResults;
  const evidence = Array.from({ length: limit + 5 }, (_unused, index) => ({
    command: `cmd-${index}`,
    exitCode: 0,
    stderr: "",
    stdout: "ok",
  }));

  const result = toRunResult(record({ commandEvidence: evidence }));

  assert.equal(result.commandResults.length, limit);
});

test("a prototype key cannot smuggle itself in as a file operation", () => {
  // FILE_OPERATIONS is a plain object, so an unguarded lookup of "constructor"
  // or "__proto__" returns something truthy off Object.prototype and emits a
  // bogus operation instead of dropping it.
  const evidence = toFileEvidence([
    { operation: "constructor", path: "/workspace/a.ts" },
    { operation: "__proto__", path: "/workspace/b.ts" },
    { operation: "toString", path: "/workspace/c.ts" },
    { operation: "created", path: "/workspace/d.ts" },
  ]);

  assert.deepEqual(evidence, [
    { operation: "create", path: "/workspace/d.ts" },
  ]);
});
