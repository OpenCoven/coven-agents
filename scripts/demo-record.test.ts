import assert from "node:assert/strict";
import test from "node:test";
import type { RunResult } from "@opencoven/agent-contracts";
import { runDemoRecorder, USAGE } from "./demo-record";

const credential = "demo-harness-credential";
const result: RunResult = {
  agentId: "53af1a29-4e98-43d6-ac5b-3b9dcba5e730",
  commandResults: [],
  completedAt: "2026-08-24T19:04:49.798Z",
  fileOperations: [],
  id: "3a3f2c72-9b1b-47f7-8c83-28d5f94bf4ce",
  output: `Finished with ${credential}.`,
  startedAt: "2026-08-24T19:03:49.798Z",
  status: "completed",
};

function dependencies() {
  let captureCalls = 0;
  const errors: string[] = [];
  const output: string[] = [];
  const writes: { contents: string; path: string }[] = [];
  return {
    captureCalls: () => captureCalls,
    dependencies: {
      cwd: () => "/repo",
      loadCapture: () => {
        captureCalls += 1;
        return Promise.resolve(async () => ({
          arrivals: [
            {
              event: {
                id: 1,
                operationId: "3f1a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90",
                runId: result.id,
                type: "accepted" as const,
              },
              receivedAt: 100,
            },
          ],
          result,
        }));
      },
      now: () => new Date("2026-08-24T19:05:00.000Z"),
      stderr: (message: string) => errors.push(message),
      stdout: (message: string) => output.push(message),
      writeFile: (path: string, contents: string) =>
        writes.push({ contents, path }),
    },
    errors,
    output,
    writes,
  };
}

test("usage returns exit 2 before loading capture", async () => {
  const fixture = dependencies();

  const code = await runDemoRecorder(
    [],
    { DEMO_RECORDING_CREDENTIAL: credential },
    fixture.dependencies
  );

  assert.equal(code, 2);
  assert.deepEqual(fixture.errors, [USAGE]);
  assert.equal(fixture.captureCalls(), 0);
});

test("a wrong repository refuses before loading capture", async () => {
  const fixture = dependencies();

  const code = await runDemoRecorder(
    ["--name", "parser-test", "--task", "Add a parser test."],
    {
      DEMO_RECORDING_CREDENTIAL: credential,
      DEMO_REPOSITORY: "someone/private",
    },
    fixture.dependencies
  );

  assert.equal(code, 1);
  assert.match(fixture.errors.join(""), /OpenCoven\/demo-workspace/);
  assert.equal(fixture.captureCalls(), 0);
});

test("a missing credential refuses before loading capture", async () => {
  const fixture = dependencies();

  const code = await runDemoRecorder(
    ["--name", "parser-test", "--task", "Add a parser test."],
    {},
    fixture.dependencies
  );

  assert.equal(code, 1);
  assert.match(fixture.errors.join(""), /credential/i);
  assert.equal(fixture.captureCalls(), 0);
});

test("top-level recorder errors redact every configured secret", async () => {
  const fixture = dependencies();
  const authSecret = "auth-secret-sensitive";
  const sessionCookie = "session-cookie-sensitive";
  const recordingCredential = "recording-credential-sensitive";

  const code = await runDemoRecorder(
    ["--name", "parser-test", "--task", "Add a parser test."],
    {
      AUTH_SECRET: authSecret,
      DEMO_RECORDING_CREDENTIAL: recordingCredential,
    },
    {
      ...fixture.dependencies,
      loadCapture: () =>
        Promise.reject(
          new Error(`${authSecret} ${sessionCookie} ${recordingCredential}`, {
            cause: new Error(`${recordingCredential} in cause`),
          })
        ),
    }
  );

  const printed = fixture.errors.join("");
  assert.equal(code, 1);
  for (const secret of [authSecret, recordingCredential]) {
    assert.equal(printed.includes(secret), false);
  }
});

test("redacts every configured recorder secret from captured events and results", async () => {
  const fixture = dependencies();
  const authSecret = "auth-secret-sensitive";
  const recorderEmail = "recorder@example.com";
  const ephemeralSession = "session-cookie-sensitive";

  const code = await runDemoRecorder(
    ["--name", "parser-test", "--task", "Add a parser test."],
    {
      AUTH_SECRET: authSecret,
      DEMO_RECORDER_ACCOUNT_EMAIL: recorderEmail,
      DEMO_RECORDING_CREDENTIAL: credential,
    },
    {
      ...fixture.dependencies,
      loadCapture: () =>
        Promise.resolve(async () => ({
          arrivals: [
            {
              event: {
                id: 1,
                output: `${authSecret} ${ephemeralSession}`,
                type: "output" as const,
              },
              receivedAt: 100,
            },
          ],
          result: {
            ...result,
            output: `${authSecret} ${recorderEmail}`,
          },
          secrets: [ephemeralSession],
        })),
    }
  );

  assert.equal(code, 0);
  const written = fixture.writes[0]?.contents ?? "";
  for (const secret of [authSecret, recorderEmail, ephemeralSession]) {
    assert.equal(written.includes(secret), false);
  }
});

test("revalidates after redaction and refuses an invalid structural field", async () => {
  const fixture = dependencies();
  const structuralCredential = "parser-test";

  const code = await runDemoRecorder(
    ["--name", structuralCredential, "--task", "Add a parser test."],
    { DEMO_RECORDING_CREDENTIAL: structuralCredential },
    fixture.dependencies
  );

  assert.equal(code, 1);
  assert.equal(fixture.writes.length, 0);
  assert.match(fixture.errors.join(""), /schema validation/i);
});

test("captures, validates, redacts, and writes a pretty transcript", async () => {
  const fixture = dependencies();

  const code = await runDemoRecorder(
    ["--name", "parser-test", "--task", "Add a parser test."],
    { DEMO_RECORDING_CREDENTIAL: credential },
    fixture.dependencies
  );

  assert.equal(code, 0);
  assert.equal(fixture.captureCalls(), 1);
  assert.equal(
    fixture.writes[0]?.path,
    "/repo/lib/demo/fixtures/parser-test.json"
  );
  assert.equal(fixture.writes[0]?.contents.endsWith("\n"), true);
  assert.match(fixture.writes[0]?.contents ?? "", /\n {2}"events":/);
  assert.doesNotMatch(
    fixture.writes[0]?.contents ?? "",
    new RegExp(credential)
  );
  assert.match(fixture.writes[0]?.contents ?? "", /\[REDACTED\]/);
  assert.match(fixture.output.join(""), /parser-test\.json/);
});
