import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_RUNNER_LIMITS,
  commandEvidenceSchema,
  exactEvidenceRedactions,
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

test("request hashing binds restricted execution permission without changing ordinary hashes", () => {
  const legacy = hashRunRequest(agentId, "Same task.");
  assert.equal(hashRunRequest(agentId, "Same task.", "unrestricted"), legacy);
  assert.notEqual(
    hashRunRequest(agentId, "Same task.", "workspace_read"),
    hashRunRequest(agentId, "Same task.", "workspace_write")
  );
});

test("request hashing binds a sandbox binding without changing unbound hashes", () => {
  const unbound = hashRunRequest(agentId, "Same task.");
  const binding = { expectedGeneration: 2, expectedSandboxId: "sandbox-a" };
  assert.equal(
    hashRunRequest(agentId, "Same task.", "unrestricted", null),
    unbound
  );
  const bound = hashRunRequest(agentId, "Same task.", "unrestricted", binding);
  assert.notEqual(bound, unbound);
  assert.equal(
    hashRunRequest(agentId, "Same task.", "unrestricted", {
      expectedGeneration: 2,
      expectedSandboxId: "sandbox-a",
    }),
    bound
  );
  assert.notEqual(
    hashRunRequest(agentId, "Same task.", "unrestricted", {
      ...binding,
      expectedGeneration: 3,
    }),
    bound
  );
  assert.notEqual(
    hashRunRequest(agentId, "Same task.", "unrestricted", {
      ...binding,
      expectedSandboxId: "sandbox-b",
    }),
    bound
  );
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
  assert.deepEqual(projection.run.error, {
    code: "runner_failure",
    details: "details [REDACTED]",
    message: "message [REDACTED]",
    retryable: false,
  });
});

test("redacts bounded provider identifiers across neutral evidence projections", () => {
  const tenantCredential = "tenant-credential-cross-surface";
  const daytonaApiKey = [
    "sk",
    "proj",
    "syntheticdaytonaapikeyfixture000000",
  ].join("-");
  const reconcileBearer = "manual-reconcile-service-bearer";
  const signedClaim = [
    "eyJhbGciOiJIUzI1NiJ9",
    "eyJzdWIiOiJmaXh0dXJlIn0",
    "c2lnbmVkLWNyb3NzLXN1cmZhY2U",
  ].join(".");
  const sandboxId = "daytona-sandbox-private-id";
  const sandboxName = "daytona-sandbox-private-name";
  const sessionId = "daytona-session-private-id";
  const commandId = "daytona-command-private-id";
  const attemptId = "daytona-attempt-private-id";
  const tenantBMarker = "tenant-b-evidence-marker";
  const redactions = exactEvidenceRedactions(
    tenantCredential,
    daytonaApiKey,
    reconcileBearer,
    signedClaim,
    sandboxId,
    sandboxName,
    sessionId,
    commandId,
    attemptId,
    tenantBMarker
  );
  const planted = [
    tenantCredential,
    daytonaApiKey,
    `Bearer ${reconcileBearer}`,
    signedClaim,
    sandboxId,
    sandboxName,
    sessionId,
    commandId,
    attemptId,
    tenantBMarker,
  ].join(" | ");
  const normalizedCommands = normalizeCommandEvidence(
    [
      {
        command: planted,
        stderr: planted,
        stdout: planted,
      },
    ],
    redactions
  );
  const normalizedFiles = normalizeFileEvidence(
    [
      {
        operation: "modify",
        path: `/workspace/${planted}.md`,
        status: "completed",
      },
    ],
    redactions
  );
  const live = [
    projectHarnessRunEvent(
      {
        at: createdAt,
        kind: "message",
        model: "test-model",
        text: planted,
      },
      2,
      redactions,
      new Map()
    ),
    projectHarnessRunEvent(
      {
        at: createdAt,
        kind: "file",
        operation: "edited",
        path: `/workspace/${planted}.md`,
      },
      3,
      redactions,
      new Map()
    ),
  ];
  const terminal = projectTerminalRun(
    queuedSnapshot(),
    {
      commandEvidence: [
        {
          command: planted,
          stderr: planted,
          stdout: planted,
        },
      ],
      completedAt: "2026-08-20T20:02:00.000Z",
      credential: redactions,
      error: {
        code: "runner_failure",
        details: planted,
        message: planted,
        retryable: false,
      },
      fileEvidence: [
        {
          operation: "modify",
          path: `/workspace/${planted}.md`,
          status: "completed",
        },
      ],
      output: planted,
      status: "failed",
    },
    2
  );
  const persisted = JSON.stringify({
    diagnostics: [
      ...normalizedCommands.diagnostics,
      ...normalizedFiles.diagnostics,
    ],
    events: terminal.events,
    files: normalizedFiles.evidence,
    live,
    run: terminal.run,
    terminal: terminal.run.output,
  });

  for (const value of [
    tenantCredential,
    daytonaApiKey,
    reconcileBearer,
    signedClaim,
    sandboxId,
    sandboxName,
    sessionId,
    commandId,
    attemptId,
    tenantBMarker,
  ]) {
    assert.equal(persisted.includes(value), false, `leaked ${value}`);
  }
});

test("includes a null error in completed snapshots and completion events", () => {
  const projection = projectTerminalRun(
    queuedSnapshot(),
    {
      completedAt: "2026-08-20T20:02:00.000Z",
      credential: null,
      output: "Finished.",
      status: "completed",
    },
    2
  );
  const completed = projection.events.find(
    (event) => event.type === "completed"
  );

  assert.equal(Object.hasOwn(projection.run, "error"), true);
  assert.equal(projection.run.error, null);
  assert.ok(completed && completed.type === "completed");
  assert.equal(Object.hasOwn(completed.run, "error"), true);
  assert.equal(completed.run.error, null);
});

test("includes a null error in cancelled terminal snapshots", () => {
  const projection = projectTerminalRun(
    queuedSnapshot(),
    {
      completedAt: "2026-08-20T20:02:00.000Z",
      credential: null,
      output: "",
      status: "cancelled",
    },
    2
  );

  assert.equal(Object.hasOwn(projection.run, "error"), true);
  assert.equal(projection.run.error, null);
  assert.deepEqual(projection.events, [
    {
      at: "2026-08-20T20:02:00.000Z",
      id: 2,
      status: "cancelled",
      type: "status",
    },
  ]);
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
