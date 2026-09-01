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
      provenance: {
        fixture: "demo-replay",
        kind: "synthetic-demo",
      },
    },
  ],
  name: "demo-replay",
  provenance: {
    fixture: "demo-replay",
    kind: "synthetic-demo",
  },
  recordedAt: "2026-08-24T19:03:49.798Z",
  result: {
    agentId: "53af1a29-4e98-43d6-ac5b-3b9dcba5e730",
    commandResults: [
      {
        command: "pnpm test",
        exitCode: 0,
        provenance: {
          fixture: "demo-replay",
          kind: "synthetic-demo",
        },
        stderr: "",
        stdout: "Tests passed.",
      },
    ],
    completedAt: "2026-08-24T19:03:50.798Z",
    fileOperations: [
      {
        operation: "modify",
        path: "src/demo.ts",
        provenance: {
          fixture: "demo-replay",
          kind: "synthetic-demo",
        },
      },
    ],
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
    "provenance",
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

test("requires synthetic provenance on every demo event", () => {
  const event = { ...transcript.events[0], provenance: undefined };

  assert.equal(
    demoTranscriptSchema.safeParse({
      ...transcript,
      events: [event],
    }).success,
    false
  );
});

test("requires synthetic provenance on every demo artifact", () => {
  const commandResult = {
    ...transcript.result.commandResults[0],
    provenance: undefined,
  };
  const fileOperation = {
    ...transcript.result.fileOperations[0],
    provenance: undefined,
  };

  assert.equal(
    demoTranscriptSchema.safeParse({
      ...transcript,
      result: {
        ...transcript.result,
        commandResults: [commandResult],
      },
    }).success,
    false
  );
  assert.equal(
    demoTranscriptSchema.safeParse({
      ...transcript,
      result: {
        ...transcript.result,
        fileOperations: [fileOperation],
      },
    }).success,
    false
  );
});

test("binds every provenance marker to the fixture name", () => {
  assert.equal(
    demoTranscriptSchema.safeParse({
      ...transcript,
      events: [
        {
          ...transcript.events[0],
          provenance: {
            ...transcript.provenance,
            fixture: "another-fixture",
          },
        },
      ],
    }).success,
    false
  );
  assert.equal(
    demoTranscriptSchema.safeParse({
      ...transcript,
      result: {
        ...transcript.result,
        commandResults: [
          {
            ...transcript.result.commandResults[0],
            provenance: {
              ...transcript.provenance,
              fixture: "another-fixture",
            },
          },
        ],
      },
    }).success,
    false
  );
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
    const provenance = { ...transcript.provenance, fixture: name };
    assert.equal(
      demoTranscriptSchema.safeParse({
        ...transcript,
        events: transcript.events.map((event) => ({ ...event, provenance })),
        name,
        provenance,
        result: {
          ...transcript.result,
          commandResults: transcript.result.commandResults.map((result) => ({
            ...result,
            provenance,
          })),
          fileOperations: transcript.result.fileOperations.map((operation) => ({
            ...operation,
            provenance,
          })),
        },
      }).success,
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

test("bounds the number of replay events", () => {
  const events = Array.from({ length: 257 }, (_, index) => ({
    event: {
      id: index + 1,
      output: `Event ${index + 1}`,
      type: "output" as const,
    },
    offsetMs: index,
    provenance: transcript.provenance,
  }));

  assert.equal(
    demoTranscriptSchema.safeParse({ ...transcript, events }).success,
    false
  );
});

test("bounds task and result output text", () => {
  assert.equal(
    demoTranscriptSchema.safeParse({
      ...transcript,
      task: "x".repeat(40_001),
    }).success,
    false
  );
  assert.equal(
    demoTranscriptSchema.safeParse({
      ...transcript,
      result: {
        ...transcript.result,
        output: "x".repeat(100_001),
      },
    }).success,
    false
  );
});

test("requires monotonic offsets within a bounded replay duration", () => {
  const secondEvent = {
    event: {
      id: 2,
      output: "Second event",
      type: "output" as const,
    },
    offsetMs: 5,
    provenance: transcript.provenance,
  };

  assert.equal(
    demoTranscriptSchema.safeParse({
      ...transcript,
      events: [{ ...transcript.events[0], offsetMs: 10 }, secondEvent],
    }).success,
    false
  );
  assert.equal(
    demoTranscriptSchema.safeParse({
      ...transcript,
      events: [{ ...transcript.events[0], offsetMs: 120_001 }],
    }).success,
    false
  );
});

test("bounds demo artifact text and paths", () => {
  assert.equal(
    demoTranscriptSchema.safeParse({
      ...transcript,
      result: {
        ...transcript.result,
        commandResults: [
          {
            ...transcript.result.commandResults[0],
            command: "x".repeat(8001),
          },
        ],
      },
    }).success,
    false
  );

  for (const path of [
    "/private/customer.txt",
    "../customer.txt",
    "https://example.com/private",
  ]) {
    assert.equal(
      demoTranscriptSchema.safeParse({
        ...transcript,
        result: {
          ...transcript.result,
          fileOperations: [
            {
              ...transcript.result.fileOperations[0],
              path,
            },
          ],
        },
      }).success,
      false,
      `${path} should be rejected`
    );
  }
});
