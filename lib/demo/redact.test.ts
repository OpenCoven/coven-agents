import assert from "node:assert/strict";
import test from "node:test";
import {
  type DemoTranscript,
  demoTranscriptSchema,
} from "@opencoven/agent-contracts";
import { assertNoSecrets, redactTranscript } from "./redact";

const AGENT_ID = "53af1a29-4e98-43d6-ac5b-3b9dcba5e730";
const OPERATION_ID = "f83bf3c5-5992-4c70-a006-f2d8f2520aeb";
const RUN_ID = "3a3f2c72-9b1b-47f7-8c83-28d5f94bf4ce";
const SECRET = "demo-secret-value";

function createTranscript(secret = ""): DemoTranscript {
  const suffix = secret ? ` ${secret}` : "";
  const transcript: DemoTranscript = {
    events: [
      {
        event: {
          id: 1,
          operationId: OPERATION_ID,
          runId: RUN_ID,
          type: "accepted",
        },
        offsetMs: 0,
      },
      {
        event: {
          id: 2,
          status: "running",
          type: "status",
        },
        offsetMs: 15,
      },
      {
        event: {
          id: 3,
          output: `event output context${suffix}`,
          type: "output",
        },
        offsetMs: 30,
      },
      {
        event: {
          evidence: {
            command: `event command context${suffix}`,
            exitCode: 0,
            stderr: `event stderr context${suffix}`,
            stdout: `event stdout context${suffix}`,
          },
          id: 4,
          type: "command",
        },
        offsetMs: 45,
      },
      {
        event: {
          evidence: {
            byteLength: 42,
            operation: "modify",
            path: `/workspace/${secret || "clean"}/event-file.ts`,
          },
          id: 5,
          type: "file",
        },
        offsetMs: 60,
      },
      {
        event: {
          id: 6,
          run: {
            agentId: AGENT_ID,
            apiVersion: "1.0",
            commandEvidence: [
              {
                command: `snapshot command context${suffix}`,
                exitCode: 0,
                stderr: `snapshot stderr context${suffix}`,
                stdout: `snapshot stdout context${suffix}`,
              },
            ],
            completedAt: "2026-08-24T19:03:50.798Z",
            createdAt: "2026-08-24T19:03:49.798Z",
            fileEvidence: [
              {
                byteLength: 42,
                operation: "modify",
                path: `/workspace/${secret || "clean"}/snapshot-file.ts`,
              },
            ],
            id: RUN_ID,
            operationId: OPERATION_ID,
            output: `snapshot output context${suffix}`,
            startedAt: "2026-08-24T19:03:49.898Z",
            status: "completed",
            task: `event task context${suffix}`,
          },
          type: "completed",
        },
        offsetMs: 75,
      },
    ],
    name: "demo-replay",
    recordedAt: "2026-08-24T19:03:51.798Z",
    result: {
      agentId: AGENT_ID,
      commandResults: [
        {
          command: `result command context${suffix}`,
          exitCode: 0,
          stderr: `result stderr context${suffix}`,
          stdout: `result stdout context${suffix}`,
          timestamp: 1_724_526_230,
        },
      ],
      completedAt: "2026-08-24T19:03:50.798Z",
      fileOperations: [
        {
          operation: "modify",
          path: `/workspace/${secret || "clean"}/result-file.ts`,
          timestamp: 1_724_526_229,
        },
      ],
      id: RUN_ID,
      output: `result output context${suffix}`,
      startedAt: "2026-08-24T19:03:49.798Z",
      status: "completed",
    },
    task: `transcript task context${suffix}`,
  };

  assert.equal(demoTranscriptSchema.safeParse(transcript).success, true);
  return transcript;
}

test("redacts credentials from every free-form transcript string while preserving context", () => {
  const redacted = redactTranscript(createTranscript(SECRET), [SECRET, ""]);
  const serialized = JSON.stringify(redacted);

  assert.equal(serialized.includes(SECRET), false);
  for (const context of [
    "event output context",
    "event command context",
    "event stderr context",
    "event stdout context",
    "snapshot command context",
    "snapshot stderr context",
    "snapshot stdout context",
    "snapshot output context",
    "event task context",
    "result command context",
    "result stderr context",
    "result stdout context",
    "result output context",
    "transcript task context",
  ]) {
    assert.equal(serialized.includes(context), true, `${context} was lost`);
  }
});

test("redacts credentials embedded in file paths", () => {
  const redacted = redactTranscript(createTranscript(SECRET), [SECRET]);
  const serialized = JSON.stringify(redacted);

  assert.equal(serialized.includes(`/workspace/${SECRET}/`), false);
  assert.equal(
    serialized.includes("/workspace/[REDACTED]/event-file.ts"),
    true
  );
  assert.equal(
    serialized.includes("/workspace/[REDACTED]/snapshot-file.ts"),
    true
  );
  assert.equal(
    serialized.includes("/workspace/[REDACTED]/result-file.ts"),
    true
  );
});

test("preserves numeric and status values", () => {
  const transcript = createTranscript(SECRET);
  const redacted = redactTranscript(transcript, [SECRET]);

  assert.equal(redacted.events[1].event.type, "status");
  if (redacted.events[1].event.type === "status") {
    assert.equal(redacted.events[1].event.status, "running");
  }
  assert.equal(redacted.events[4].offsetMs, 60);
  if (redacted.events[4].event.type === "file") {
    assert.equal(redacted.events[4].event.evidence.byteLength, 42);
  }
  assert.equal(redacted.result.status, "completed");
  assert.equal(redacted.result.commandResults[0].exitCode, 0);
  assert.equal(redacted.result.commandResults[0].timestamp, 1_724_526_230);
});

test("assertNoSecrets rejects an exact surviving credential", () => {
  assert.throws(() => assertNoSecrets(createTranscript(SECRET), [SECRET]));
});

test("assertNoSecrets rejects credentials recognized by the sanitizer", () => {
  const transcript = createTranscript();
  transcript.task = "Call API with Authorization: Bearer visible-token";

  assert.throws(() => assertNoSecrets(transcript, []));
});

test("assertNoSecrets passes a clean transcript", () => {
  assert.doesNotThrow(() => assertNoSecrets(createTranscript(), [""]));
});
