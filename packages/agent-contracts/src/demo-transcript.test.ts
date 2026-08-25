import assert from "node:assert/strict";
import test from "node:test";
import { demoTranscriptSchema, runEventsSchema } from "./index";

const transcript = {
  events: [
    {
      event: {
        id: 1,
        operationId: "53af1a29-4e98-43d6-ac5b-3b9dcba5e730",
        runId: "3a3f2c72-9b1b-47f7-8c83-28d5f94bf4ce",
        type: "accepted",
      },
      offsetMs: 0,
    },
  ],
  name: "demo-replay",
  recordedAt: "2026-08-24T19:03:49.798Z",
  result: {
    agentId: "53af1a29-4e98-43d6-ac5b-3b9dcba5e730",
    commandResults: [],
    completedAt: "2026-08-24T19:03:50.798Z",
    fileOperations: [],
    id: "3a3f2c72-9b1b-47f7-8c83-28d5f94bf4ce",
    output: "Demo complete.",
    startedAt: "2026-08-24T19:03:49.798Z",
    status: "completed",
  },
  task: "Replay the demo.",
};

test("parses a valid demo transcript", () => {
  assert.equal(demoTranscriptSchema.safeParse(transcript).success, true);
});

test("requires every demo transcript field", () => {
  for (const field of [
    "name",
    "task",
    "events",
    "result",
    "recordedAt",
  ] as const) {
    const candidate = { ...transcript };
    delete candidate[field];
    assert.equal(
      demoTranscriptSchema.safeParse(candidate).success,
      false,
      `${field} should be required`
    );
  }
});

test("rejects invalid recordedAt timestamps", () => {
  assert.equal(
    demoTranscriptSchema.safeParse({
      ...transcript,
      recordedAt: "not-a-timestamp",
    }).success,
    false
  );
});

test("rejects invented event types", () => {
  assert.equal(
    demoTranscriptSchema.safeParse({
      ...transcript,
      events: [
        {
          event: { id: 1, type: "demo-only-event" },
          offsetMs: 0,
        },
      ],
    }).success,
    false
  );
});

test("accepts only lowercase alphanumeric hyphen names", () => {
  for (const name of ["demo", "demo-replay", "demo2"]) {
    assert.equal(
      demoTranscriptSchema.safeParse({ ...transcript, name }).success,
      true,
      `${name} should be valid`
    );
  }

  for (const name of ["Demo", "demo_replay", "demo replay"]) {
    assert.equal(
      demoTranscriptSchema.safeParse({ ...transcript, name }).success,
      false,
      `${name} should be invalid`
    );
  }
});

test("rejects negative event offsets", () => {
  assert.equal(
    demoTranscriptSchema.safeParse({
      ...transcript,
      events: [{ ...transcript.events[0], offsetMs: -1 }],
    }).success,
    false
  );
});

test("rejects duplicate and decreasing event ids", () => {
  for (const ids of [
    [1, 1],
    [2, 1],
  ]) {
    const events = ids.map((id, index) => ({
      event: { ...transcript.events[0].event, id },
      offsetMs: index,
    }));

    assert.equal(
      runEventsSchema.safeParse(events.map(({ event }) => event)).success,
      false
    );
    assert.equal(
      demoTranscriptSchema.safeParse({ ...transcript, events }).success,
      false
    );
  }
});
