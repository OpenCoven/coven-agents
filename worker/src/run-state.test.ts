import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  AGENT_RUNNER_LIMITS,
  type AgentDefinition,
  commandEvidenceSchema,
  fileEvidenceSchema,
  sanitizeEvidenceText,
} from "@opencoven/agent-contracts";
import {
  cloudFiberKey,
  createQueuedRun,
  destroyCloudAgentSandbox,
  dispatchCloudRun,
  finishCloudRunRecord,
  liveCloudRunEvent,
  normalizeCloudCommandEvidence,
  normalizeCloudFileEvidence,
  planCloudRunStart,
  recoverCloudRunRecord,
  retainCloudRuns,
} from "./run-state.js";

const agentId = "53af1a29-4e98-43d6-ac5b-3b9dcba5e730";

const agent: AgentDefinition = {
  backend: "cloud",
  createdAt: "2026-08-20T20:00:00.000Z",
  description: "Cloud test profile",
  id: agentId,
  instructions: "Work in the sandbox.",
  lastRunAt: null,
  model: "gpt-5.1",
  name: "Cloud runner",
  owner: { kind: "standalone" },
  runtime: "cloud",
  status: "idle",
  updatedAt: "2026-08-20T20:00:00.000Z",
  workspace: "/workspace",
};

test("normalizes oversized cloud command evidence through the strict contract schema", () => {
  // secret-scan: allow-next-line -- synthetic OpenAI redaction fixture
  const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
  const normalized = normalizeCloudCommandEvidence(
    [
      {
        command: `deploy --api-key header-api-key ${secret}`,
        exitCode: 0,
        stderr: "Authorization: Bearer bearer-command-value",
        stdout:
          "preflight complete\nSERVICE_TOKEN=service-token-value\npostflight complete",
        timestamp: "2026-08-20T20:00:00.000Z",
      },
      {
        command: "x".repeat(AGENT_RUNNER_LIMITS.maxCommandLength + 50),
        exitCode: 1.5,
        stderr: "y".repeat(AGENT_RUNNER_LIMITS.maxEventOutputLength + 20),
        stdout: "z".repeat(AGENT_RUNNER_LIMITS.maxEventOutputLength + 20),
        timestamp: "not-a-date",
      },
      { command: null, stdout: 42 },
      ...Array.from({ length: 11 }, () => ({
        command: "capture output",
        exitCode: 0,
        stderr: "e".repeat(AGENT_RUNNER_LIMITS.maxEventOutputLength),
        stdout: "o".repeat(AGENT_RUNNER_LIMITS.maxEventOutputLength),
        timestamp: "2026-08-20T20:00:01.000Z",
      })),
    ],
    null
  );

  assert.equal(normalized.outputExceeded, true);
  assert.ok(normalized.diagnostics.length > 0);
  assert.ok(normalized.evidence.length > 0);
  for (const evidence of normalized.evidence) {
    assert.equal(commandEvidenceSchema.safeParse(evidence).success, true);
    assert.ok(evidence.command.length <= AGENT_RUNNER_LIMITS.maxCommandLength);
    assert.ok(
      Buffer.byteLength(evidence.stdout) <=
        AGENT_RUNNER_LIMITS.maxEventOutputLength
    );
    assert.ok(
      Buffer.byteLength(evidence.stderr) <=
        AGENT_RUNNER_LIMITS.maxEventOutputLength
    );
    assert.equal(evidence.command.includes(secret), false);
    assert.equal(evidence.stdout.includes("service-token-value"), false);
    assert.equal(evidence.stderr.includes("bearer-command-value"), false);
  }
});

test("normalizes cloud file evidence with a safe operation, bounded path, and bounded diagnostic", () => {
  // secret-scan: allow-next-line -- synthetic GitHub path fixture
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD";
  const normalized = normalizeCloudFileEvidence([
    {
      operation: "update",
      path: `/workspace/${secret}-${"a".repeat(
        AGENT_RUNNER_LIMITS.maxPathLength + 50
      )}`,
      status: "completed",
      timestamp: "2026-08-20T20:00:00.000Z",
    },
    {
      operation: "chmod",
      path: "/workspace/script.sh",
      status: "completed",
      timestamp: "not-a-date",
    },
  ]);

  assert.equal(normalized.evidence.length, 1);
  assert.ok(normalized.diagnostics.length > 0);
  assert.equal(normalized.evidence[0]?.operation, "modify");
  assert.equal(
    fileEvidenceSchema.safeParse(normalized.evidence[0]).success,
    true
  );
  assert.ok(
    (normalized.evidence[0]?.path.length ?? Number.POSITIVE_INFINITY) <=
      AGENT_RUNNER_LIMITS.maxPathLength
  );
  assert.equal(normalized.evidence[0]?.path.includes(secret), false);
});

test("uses a per-run fiber key after pruning while retained operations still replay", async () => {
  const operationIds = Array.from({ length: 21 }, () => randomUUID());
  const records = operationIds.map((operationId, index) => {
    const timestamp = new Date(
      Date.parse("2026-08-20T20:00:00.000Z") + index * 1000
    ).toISOString();
    const record = createQueuedRun(
      agentId,
      operationId,
      "Run focused tests.",
      randomUUID(),
      timestamp
    );
    return {
      ...record,
      operationHash: "same-request",
      run: {
        ...record.run,
        completedAt: timestamp,
        status: "completed" as const,
      },
    };
  });
  const retained = retainCloudRuns(records);
  const reusedOperationId = operationIds[0] as string;
  const newRunId = randomUUID();
  const prunedDecision = planCloudRunStart({
    agentId,
    createdAt: "2026-08-20T21:00:00.000Z",
    operationHash: "same-request",
    operationId: reusedOperationId,
    records: retained,
    runId: newRunId,
    task: "Run focused tests.",
  });

  assert.equal(prunedDecision.kind, "created");
  assert.equal(prunedDecision.fiberKey, cloudFiberKey(newRunId));
  const retainedFiberKeys = new Set(
    retained.map((record) => cloudFiberKey(record.run.id))
  );
  let executions = 0;
  const launched = await dispatchCloudRun(
    prunedDecision,
    (_record, fiberKey) => {
      if (retainedFiberKeys.has(fiberKey)) {
        return Promise.resolve({ accepted: false });
      }
      retainedFiberKeys.add(fiberKey);
      executions += 1;
      return Promise.resolve({ accepted: true });
    }
  );
  assert.equal(launched.created, true);
  assert.equal(executions, 1);

  const [retainedRecord] = retained;
  assert.ok(retainedRecord);
  const replay = planCloudRunStart({
    agentId,
    createdAt: "2026-08-20T21:00:01.000Z",
    operationHash: retainedRecord.operationHash,
    operationId: retainedRecord.run.operationId,
    records: retained,
    runId: randomUUID(),
    task: retainedRecord.run.task,
  });
  const conflict = planCloudRunStart({
    agentId,
    createdAt: "2026-08-20T21:00:02.000Z",
    operationHash: "different-request",
    operationId: retainedRecord.run.operationId,
    records: retained,
    runId: randomUUID(),
    task: "Different mission.",
  });

  assert.equal(replay.kind, "existing");
  assert.equal(replay.record.run.id, retainedRecord.run.id);
  const replayed = await dispatchCloudRun(replay);
  assert.equal(replayed.created, false);
  assert.equal(replayed.run.id, retainedRecord.run.id);
  assert.equal(conflict.kind, "conflict");
});

test("recovers interrupted cloud runs and destroys only the configured sandbox", async () => {
  const record = createQueuedRun(
    agentId,
    "0f6f31ae-7b6c-49c9-bc82-0f2cbf56cc4d",
    "Inspect the sandbox.",
    "3a3f2c72-9b1b-47f7-8c83-28d5f94bf4ce",
    "2026-08-20T20:01:00.000Z"
  );

  const recovered = recoverCloudRunRecord(record, "2026-08-20T20:02:00.000Z");
  const destroyed: string[] = [];
  await destroyCloudAgentSandbox(agent, (name) => {
    destroyed.push(name);
    return Promise.resolve();
  });

  assert.equal(recovered.run.status, "failed");
  assert.equal(recovered.run.error?.code, "interrupted");
  assert.equal(recovered.events.at(-1)?.type, "failed");
  assert.deepEqual(destroyed, [`agent-${agent.id}`]);
});

test("sanitizes cloud evidence again before finalized state and events are stored", () => {
  const record = createQueuedRun(
    agentId,
    "0f6f31ae-7b6c-49c9-bc82-0f2cbf56cc4d",
    "Inspect the sandbox.",
    "3a3f2c72-9b1b-47f7-8c83-28d5f94bf4ce",
    "2026-08-20T20:01:00.000Z"
  );
  const secrets = [
    "final-bearer-value",
    "final-access-value",
    // secret-scan: allow-next-line -- synthetic stored-output fixture
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
  ];
  const finished = finishCloudRunRecord(record, {
    commandEvidence: [
      {
        command: "curl -H 'Authorization: Bearer final-bearer-value'",
        completedAt: "2026-08-20T20:02:00.000Z",
        exitCode: 0,
        stderr: "",
        stdout: "FINAL_ACCESS_KEY=final-access-value",
      },
    ],
    completedAt: "2026-08-20T20:02:00.000Z",
    credential: null,
    fileEvidence: [
      {
        occurredAt: "2026-08-20T20:02:00.000Z",
        operation: "modify",
        // secret-scan: allow-next-line -- synthetic stored-path fixture
        path: "/workspace/ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
      },
    ],
    output: "completed with Bearer final-bearer-value",
    status: "completed",
  });
  const persisted = JSON.stringify(finished);

  for (const secret of secrets) {
    assert.equal(persisted.includes(secret), false, `stored ${secret}`);
  }
  assert.match(persisted, /\[REDACTED\]/);
});

test("retains the newest bounded cloud command and file evidence before storage", () => {
  const expectedLimit = 256;
  const record = createQueuedRun(
    agentId,
    "0f6f31ae-7b6c-49c9-bc82-0f2cbf56cc4d",
    "Inspect the sandbox.",
    "3a3f2c72-9b1b-47f7-8c83-28d5f94bf4ce",
    "2026-08-20T20:01:00.000Z"
  );
  const finished = finishCloudRunRecord(record, {
    commandEvidence: Array.from({ length: expectedLimit + 1 }, (_, index) => ({
      command: `command-${index}`,
      exitCode: 0,
      stderr: "",
      stdout: `stdout-${index}`,
    })),
    completedAt: "2026-08-20T20:02:00.000Z",
    credential: null,
    fileEvidence: Array.from({ length: expectedLimit + 1 }, (_, index) => ({
      operation: "modify" as const,
      path: `src/file-${index}.ts`,
    })),
    output: "completed",
    status: "completed",
  });

  assert.equal(finished.run.commandEvidence.length, expectedLimit);
  assert.equal(finished.run.fileEvidence.length, expectedLimit);
  assert.equal(finished.run.commandEvidence[0]?.command, "command-1");
  assert.equal(finished.run.fileEvidence[0]?.path, "src/file-1.ts");
});

/**
 * These three tenant-credential shapes are deliberately unlike anything
 * `sanitizeEvidenceText`'s built-in patterns already catch (no `Bearer `,
 * no `Authorization:`, no `KEY=value`, no recognized provider prefix like
 * `ghp_`, no `--token`-style CLI flag). If a test here passed only because a
 * pre-existing pattern happened to also match the fixture text, it would
 * stay green even after the tenant-credential threading was removed — which
 * is exactly the false confidence this task warned against. Each fixture is
 * checked against `sanitizeEvidenceText` with no additional secrets so a
 * fixture that starts colliding with a future pattern fails loudly here
 * instead of silently validating nothing.
 */
function assertOnlyCredentialThreadingCouldRedact(
  text: string,
  credential: string
): void {
  assert.ok(
    sanitizeEvidenceText(text).includes(credential),
    "fixture must not already be redacted by a built-in pattern"
  );
}

test("a harness that echoes its own credential does not leak it into evidence", () => {
  // The realistic failure: a CLI printing its auth header in a debug line.
  // Everything it writes to stdout and stderr is captured and persisted.
  const credential = "tnt-7f2c9ae04d81b6f3c58a221e0d94b7ac";
  const output = `startup: echoing runtime token ${credential} for diagnostics`;
  assertOnlyCredentialThreadingCouldRedact(output, credential);

  const record = createQueuedRun(
    agentId,
    "0f6f31ae-7b6c-49c9-bc82-0f2cbf56cc4d",
    "Inspect the sandbox.",
    "3a3f2c72-9b1b-47f7-8c83-28d5f94bf4ce",
    "2026-08-20T20:01:00.000Z"
  );
  const finished = finishCloudRunRecord(record, {
    commandEvidence: [
      {
        command: "coven-cli run",
        exitCode: 0,
        stderr: "",
        stdout: output,
      },
    ],
    completedAt: "2026-08-20T20:02:00.000Z",
    credential,
    output,
    status: "completed",
  });
  const persisted = JSON.stringify(finished);

  assert.equal(persisted.includes(credential), false);
  assert.ok(persisted.includes("startup: echoing runtime token"));
});

test("a credential echoed to stderr is redacted too", () => {
  // stderr is captured the same way stdout is.
  const credential = "tnt-b83e5f0a1c476dd9284fa61b9e0c7d35";
  const stderrLine = `startup: echoing runtime token ${credential} for diagnostics`;
  assertOnlyCredentialThreadingCouldRedact(stderrLine, credential);

  const record = createQueuedRun(
    agentId,
    "0f6f31ae-7b6c-49c9-bc82-0f2cbf56cc4d",
    "Inspect the sandbox.",
    "3a3f2c72-9b1b-47f7-8c83-28d5f94bf4ce",
    "2026-08-20T20:01:00.000Z"
  );
  const finished = finishCloudRunRecord(record, {
    commandEvidence: [
      {
        command: "coven-cli run",
        exitCode: 1,
        stderr: stderrLine,
        stdout: "",
      },
    ],
    completedAt: "2026-08-20T20:02:00.000Z",
    credential,
    output: "The harness produced no output.",
    status: "failed",
  });
  const persisted = JSON.stringify(finished);

  assert.equal(persisted.includes(credential), false);
  assert.ok(persisted.includes("startup: echoing runtime token"));
});

test("a credential appearing in a command line is redacted", () => {
  // The third call site. A token passed as an argument is leaked as surely as
  // one printed to a stream. Passed positionally, not through a `--token`
  // style flag, so the built-in CLI-option pattern cannot be what redacts it.
  const credential = "tnt-2ac4d19f7e356b0812fc9a5e6d3b71ce";
  const command = `coven-cli exec --workspace /workspace ${credential}`;
  assertOnlyCredentialThreadingCouldRedact(command, credential);

  const record = createQueuedRun(
    agentId,
    "0f6f31ae-7b6c-49c9-bc82-0f2cbf56cc4d",
    "Inspect the sandbox.",
    "3a3f2c72-9b1b-47f7-8c83-28d5f94bf4ce",
    "2026-08-20T20:01:00.000Z"
  );
  const finished = finishCloudRunRecord(record, {
    commandEvidence: [
      {
        command,
        exitCode: 0,
        stderr: "",
        stdout: "",
      },
    ],
    completedAt: "2026-08-20T20:02:00.000Z",
    credential,
    output: "completed",
    status: "completed",
  });
  const persisted = JSON.stringify(finished);

  assert.equal(persisted.includes(credential), false);
  assert.ok(persisted.includes("coven-cli exec --workspace /workspace"));
});

test("live events carry redacted text, never the credential", () => {
  const credential = "ghp_live_credential_value_123";
  const toolNames = new Map<string, string>();

  const message = liveCloudRunEvent(
    {
      at: "2026-08-26T00:00:00.000Z",
      kind: "message",
      model: "gpt-5",
      text: `Using token ${credential} to fetch the repo`,
    },
    3,
    credential,
    toolNames
  );

  assert.ok(message && message.type === "output");
  assert.equal(message.id, 3);
  assert.ok(!message.output.includes(credential));
  assert.ok(message.output.includes("Using token"));
});

test("live tool events pair names across start and end", () => {
  const toolNames = new Map<string, string>();

  const start = liveCloudRunEvent(
    {
      at: "2026-08-26T00:00:00.000Z",
      callId: "call-1",
      kind: "tool-start",
      summary: "ls -la",
      tool: "shell",
    },
    1,
    null,
    toolNames
  );
  const end = liveCloudRunEvent(
    {
      at: "2026-08-26T00:00:01.000Z",
      callId: "call-1",
      kind: "tool-end",
      success: false,
      summary: "permission denied",
    },
    2,
    null,
    toolNames
  );

  assert.ok(start && start.type === "output");
  assert.ok(start.output.includes("shell"));
  assert.ok(end && end.type === "command");
  assert.equal(end.evidence.command, "shell");
  assert.equal(end.evidence.exitCode, 1);
  assert.equal(end.evidence.stdout, "permission denied");
});

test("live file events translate operations and drop unknown verbs", () => {
  const toolNames = new Map<string, string>();

  const edited = liveCloudRunEvent(
    {
      at: "2026-08-26T00:00:00.000Z",
      kind: "file",
      operation: "edited",
      path: "/workspace/notes.md",
    },
    1,
    null,
    toolNames
  );
  const unknown = liveCloudRunEvent(
    {
      at: "2026-08-26T00:00:00.000Z",
      kind: "file",
      operation: "transmogrified",
      path: "/workspace/notes.md",
    },
    2,
    null,
    toolNames
  );

  assert.ok(edited && edited.type === "file");
  assert.equal(edited.evidence.operation, "modify");
  assert.equal(edited.evidence.path, "/workspace/notes.md");
  assert.equal(unknown, null);
});

test("live token deltas and usage checkpoints are noise, not events", () => {
  const toolNames = new Map<string, string>();

  assert.equal(
    liveCloudRunEvent(
      { at: "2026-08-26T00:00:00.000Z", kind: "delta", text: "W" },
      1,
      null,
      toolNames
    ),
    null
  );
  assert.equal(
    liveCloudRunEvent(
      {
        at: "2026-08-26T00:00:00.000Z",
        kind: "usage",
        linesAdded: 1,
        linesRemoved: 0,
        premiumRequests: null,
      },
      2,
      null,
      toolNames
    ),
    null
  );
});
