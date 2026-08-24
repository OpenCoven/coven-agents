import assert from "node:assert/strict";
import test from "node:test";
import { loadDemoTranscript, loadTranscript } from "./load";

const AGENT_ID = "3f1a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90";
const RUN_ID = "11111111-2222-4333-8444-555555555555";
const OPERATION_ID = "22222222-3333-4444-8555-666666666666";

function validTranscript(name: string) {
  return JSON.stringify({
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
    ],
    name,
    recordedAt: "2026-08-24T12:00:00.000Z",
    result: {
      agentId: AGENT_ID,
      commandResults: [],
      completedAt: "2026-08-24T12:01:00.000Z",
      fileOperations: [],
      id: RUN_ID,
      output: "Added a test.",
      startedAt: "2026-08-24T12:00:00.000Z",
      status: "completed",
    },
    task: `Run ${name}`,
  });
}

test("unparseable input yields null rather than throwing", () => {
  assert.equal(loadTranscript("{ not json"), null);
});

test("input failing schema validation yields null", () => {
  assert.equal(loadTranscript(JSON.stringify({ name: "x" })), null);
});

test("a valid transcript with numeric event ids is returned parsed", () => {
  const transcript = loadTranscript(validTranscript("valid-run"));

  assert.equal(transcript?.name, "valid-run");
  assert.equal(transcript?.events[0]?.event.id, 1);
});

test("the first valid fixture is chosen from deterministic filename order", () => {
  const transcript = loadDemoTranscript({
    fixtures: [
      { filename: "c-third.json", raw: validTranscript("c-third") },
      { filename: "a-invalid.json", raw: "{ invalid" },
      { filename: "b-first.json", raw: validTranscript("b-first") },
      { filename: "ignored.txt", raw: validTranscript("ignored") },
    ],
  });

  assert.equal(transcript?.name, "b-first");
});

test("an explicitly selected fixture is loaded without falling back", () => {
  const fixtures = [
    { filename: "a-first.json", raw: validTranscript("a-first") },
    { filename: "b-selected.json", raw: validTranscript("b-selected") },
  ];

  assert.equal(
    loadDemoTranscript({
      fixtures,
      selectedName: "b-selected",
    })?.name,
    "b-selected"
  );
  assert.equal(
    loadDemoTranscript({
      fixtures,
      selectedName: "missing",
    }),
    null
  );
});

test("no valid fixture and unsafe selections yield null", () => {
  assert.equal(
    loadDemoTranscript({
      fixtures: [{ filename: "invalid.json", raw: "{ invalid" }],
    }),
    null
  );
  assert.equal(
    loadDemoTranscript({
      fixtures: [{ filename: "package.json", raw: validTranscript("package") }],
      selectedName: "../package",
    }),
    null
  );
});
