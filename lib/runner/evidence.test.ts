import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_RUNNER_LIMITS,
  commandEvidenceSchema,
  fileEvidenceSchema,
  runEventSchema,
  runEventsSchema,
  runSnapshotSchema,
  sanitizeEvidenceText,
} from "@opencoven/agent-contracts";
import {
  createAcceptedRunEvent,
  createQueuedRunSnapshot,
  hashRunRequest,
  MAX_CAPTURED_OUTPUT_BYTES,
  normalizeCommandEvidence,
  normalizeFileEvidence,
  projectHarnessRunEvent,
  projectTerminalRun,
  retainRunEvents,
  retainRunSnapshots,
  truncateUtf8,
} from "./evidence";

const agentId = "53af1a29-4e98-43d6-ac5b-3b9dcba5e730";
const operationId = "0f6f31ae-7b6c-49c9-bc82-0f2cbf56cc4d";
const runId = "3a3f2c72-9b1b-47f7-8c83-28d5f94bf4ce";
const createdAt = "2026-08-20T20:00:00.000Z";

function queuedSnapshot(overrides = {}) {
  return createQueuedRunSnapshot({
    agentId,
    createdAt,
    operationId,
    runId,
    task: "Inspect the sandbox.",
    ...overrides,
  });
}

function isUtf8(value: string): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(
      new TextEncoder().encode(value)
    );
    return true;
  } catch {
    return false;
  }
}

test("creates strict queued snapshots and accepted events with a stable request hash", async () => {
  const snapshot = queuedSnapshot();
  const accepted = createAcceptedRunEvent(snapshot);
  const matchingHash = await hashRunRequest(agentId, snapshot.task);
  const differentHash = await hashRunRequest(agentId, "Different task.");

  assert.equal(runSnapshotSchema.safeParse(snapshot).success, true);
  assert.equal(runEventSchema.safeParse(accepted).success, true);
  assert.deepEqual(accepted, {
    at: createdAt,
    id: 1,
    operationId,
    runId,
    type: "accepted",
  });
  assert.match(matchingHash, /^[a-f0-9]{64}$/u);
  assert.notEqual(matchingHash, differentHash);
});

test("bounds Unicode by UTF-16 and UTF-8 limits without splitting characters", () => {
  const value = "😀".repeat(100);
  const bounded = truncateUtf8(value, 31, 31, "");

  assert.ok(bounded.length <= 31);
  assert.ok(Buffer.byteLength(bounded) <= 31);
  assert.equal(isUtf8(bounded), true);
  assert.equal(bounded, "😀".repeat(7));
});

test("normalizes and bounds command evidence with credential redaction", () => {
  const credential = "tenant-credential-4a6f8c103d2e";
  const echoed = `credential was ${credential}`;
  assert.equal(sanitizeEvidenceText(echoed).includes(credential), true);
  const output = "😀".repeat(30_000);
  const normalized = normalizeCommandEvidence(
    [
      {
        command: `runner exec ${credential} ${"x".repeat(
          AGENT_RUNNER_LIMITS.maxCommandLength
        )}`,
        exitCode: 0,
        stderr: echoed,
        stdout: `${echoed}\n${output}`,
        timestamp: createdAt,
      },
      ...Array.from({ length: 30 }, () => ({
        command: "capture",
        exitCode: 0,
        stderr: "",
        stdout: "x".repeat(AGENT_RUNNER_LIMITS.maxEventOutputLength),
      })),
      { command: null, stdout: 42 },
    ],
    credential
  );
  const capturedBytes = normalized.evidence.reduce(
    (total, evidence) =>
      total +
      Buffer.byteLength(evidence.stdout) +
      Buffer.byteLength(evidence.stderr),
    0
  );

  assert.equal(normalized.outputExceeded, true);
  assert.ok(normalized.diagnostics.length > 0);
  assert.ok(capturedBytes <= MAX_CAPTURED_OUTPUT_BYTES);
  for (const evidence of normalized.evidence) {
    assert.equal(commandEvidenceSchema.safeParse(evidence).success, true);
    assert.ok(
      Buffer.byteLength(evidence.command) <=
        AGENT_RUNNER_LIMITS.maxCommandLength
    );
    assert.ok(
      Buffer.byteLength(evidence.stdout) <=
        AGENT_RUNNER_LIMITS.maxEventOutputLength
    );
    assert.equal(evidence.command.includes(credential), false);
    assert.equal(evidence.stdout.includes(credential), false);
    assert.equal(evidence.stderr.includes(credential), false);
    assert.equal(isUtf8(evidence.stdout), true);
  }
});

test("redacts credentials in file paths and normalizes only safe file evidence", () => {
  const credential = "tenant-credential-9137fc2a";
  const normalized = normalizeFileEvidence(
    [
      {
        byteLength: 1,
        operation: "update",
        path: `/workspace/${credential}/${"😀".repeat(1000)}`,
        status: "completed",
        timestamp: createdAt,
      },
      {
        operation: "chmod",
        path: "/workspace/script.sh",
        status: "completed",
      },
    ],
    credential
  );
  const [evidence] = normalized.evidence;

  assert.ok(evidence);
  assert.equal(evidence.operation, "modify");
  assert.equal(fileEvidenceSchema.safeParse(evidence).success, true);
  assert.equal(evidence.path.includes(credential), false);
  assert.ok(evidence.path.length <= AGENT_RUNNER_LIMITS.maxPathLength);
  assert.ok(
    Buffer.byteLength(evidence.path) <= AGENT_RUNNER_LIMITS.maxPathLength
  );
  assert.equal(isUtf8(evidence.path), true);
  assert.ok(normalized.diagnostics.length > 0);
});

test("projects harness events into strict, credential-safe contract events", () => {
  const credential = "tenant-credential-7907ae2b";
  const toolNames = new Map<string, string>();
  const message = projectHarnessRunEvent(
    {
      at: createdAt,
      kind: "message",
      model: "test-model",
      text: `Using ${credential}`,
    },
    2,
    credential,
    toolNames
  );
  const start = projectHarnessRunEvent(
    {
      at: createdAt,
      callId: "call-1",
      kind: "tool-start",
      summary: credential,
      tool: "shell",
    },
    3,
    credential,
    toolNames
  );
  const end = projectHarnessRunEvent(
    {
      at: createdAt,
      callId: "call-1",
      kind: "tool-end",
      success: false,
      summary: credential,
    },
    4,
    credential,
    toolNames
  );
  const file = projectHarnessRunEvent(
    {
      at: createdAt,
      kind: "file",
      operation: "edited",
      path: `/workspace/${credential}.md`,
    },
    5,
    credential,
    toolNames
  );
  const ignored = projectHarnessRunEvent(
    { at: createdAt, kind: "delta", text: "token delta" },
    6,
    credential,
    toolNames
  );
  const events = [message, start, end, file].filter(
    (event): event is NonNullable<typeof event> => event !== null
  );

  assert.equal(ignored, null);
  assert.equal(runEventsSchema.safeParse(events).success, true);
  assert.equal(JSON.stringify(events).includes(credential), false);
  assert.ok(end && end.type === "command");
  assert.equal(end?.evidence.command, "shell");
  assert.ok(file && file.type === "file");
  assert.equal(file?.evidence.operation, "modify");
});

test("projects terminal output, evidence, and errors as bounded strict events", () => {
  const credential = "tenant-credential-df52a09e";
  const projection = projectTerminalRun(
    queuedSnapshot(),
    {
      commandEvidence: [
        {
          command: `execute ${credential}`,
          exitCode: 1,
          stderr: `failed with ${credential}`,
          stdout: `started with ${credential}`,
        },
      ],
      completedAt: "2026-08-20T20:02:00.000Z",
      credential,
      error: {
        code: "runner_failure",
        details: `details ${credential}`,
        message: `message ${credential}`,
        retryable: false,
      },
      fileEvidence: [
        {
          operation: "modify",
          path: `/workspace/${credential}.md`,
          status: "completed",
        },
      ],
      output: `${credential}\n${"😀".repeat(30_000)}`,
      status: "failed",
    },
    2
  );
  const persisted = JSON.stringify(projection);

  assert.equal(runSnapshotSchema.safeParse(projection.run).success, true);
  assert.equal(runEventsSchema.safeParse(projection.events).success, true);
  assert.equal(persisted.includes(credential), false);
  assert.ok(
    Buffer.byteLength(projection.run.output) <=
      AGENT_RUNNER_LIMITS.maxEventOutputLength
  );
  assert.equal(isUtf8(projection.run.output), true);
  assert.deepEqual(
    projection.events.map((event) => event.id),
    [2, 3, 4, 5, 6]
  );
  assert.equal(projection.events.at(-1)?.type, "failed");
});

test("retains active runs, recent terminal runs, and bounded event history", () => {
  const snapshots = Array.from({ length: 22 }, (_, index) => ({
    ...queuedSnapshot({
      createdAt: new Date(Date.parse(createdAt) + index * 1000).toISOString(),
      runId: `${index.toString().padStart(8, "0")}-0000-4000-8000-000000000000`,
    }),
    completedAt: new Date(Date.parse(createdAt) + index * 1000).toISOString(),
    status: "completed" as const,
  }));
  const active = queuedSnapshot({
    runId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  });
  const retained = retainRunSnapshots([...snapshots, active]);
  const events = Array.from({ length: 520 }, (_, index) => ({
    at: createdAt,
    id: index,
    output: "progress",
    type: "output" as const,
  }));
  const retainedEvents = retainRunEvents(events);

  assert.equal(retained.length, 21);
  assert.equal(retained.includes(active), true);
  assert.equal(retained[0]?.id, active.id);
  assert.equal(retainedEvents.length, 516);
  assert.equal(retainedEvents[0]?.id, 4);
});
