import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReasoningCardModel,
  foldReasoningCardSteps,
  reasoningActivityStatus,
  reasoningCardActivities,
} from "./reasoning-card";

test("message part boundaries and chronology remain exact", () => {
  const model = buildReasoningCardModel({
    activities: [
      {
        kind: "reasoning",
        state: "completed",
        text: "Compare the two sources before choosing a direction.",
      },
      {
        kind: "tool",
        label: "Fetch source",
        state: "completed",
        tool: "fetchSource",
      },
      {
        kind: "reasoning",
        state: "completed",
        text: "The second source has a newer benchmark, so it should carry more weight.",
      },
    ],
    isStreaming: false,
  });

  assert.equal(
    model.summary,
    "Compare the two sources before choosing a direction."
  );
  assert.equal(model.stepCount, 3);
  assert.equal(model.failureCount, 0);
  assert.equal(model.toolCallCount, 1);
  assert.deepEqual(
    model.steps.map(({ description, kind, title }) => ({
      description,
      kind,
      title,
    })),
    [
      {
        description: "Compare the two sources before choosing a direction.",
        kind: "reasoning",
        title: "Reasoning step 1",
      },
      {
        description: "Completed and returned a result.",
        kind: "tool",
        title: "Fetch source",
      },
      {
        description:
          "The second source has a newer benchmark, so it should carry more weight.",
        kind: "reasoning",
        title: "Reasoning step 2",
      },
    ]
  );
  assert.equal(
    model.footer,
    "Reasoning and tool activity are shown as received."
  );
});

test("activities expose status without leaking inputs or outputs", () => {
  const activities = reasoningCardActivities([
    {
      input: { authorization: "Bearer secret" },
      output: { private: "provider response" },
      state: "output-available",
      type: "tool-createDocument",
    },
    {
      output: { error: "sensitive application failure" },
      state: "output-available",
      type: "tool-updateDocument",
    },
    {
      errorText: "sensitive provider failure",
      state: "output-error",
      type: "tool-getWeather",
    },
    {
      approval: { approved: false, reason: "private denial reason" },
      state: "approval-responded",
      type: "tool-deleteDocument",
    },
    {
      state: "approval-requested",
      type: "tool-requestSuggestions",
    },
    { text: "not a tool", type: "text" },
  ]);

  assert.deepEqual(activities, [
    {
      kind: "tool",
      label: "Create document",
      state: "completed",
      tool: "createDocument",
    },
    {
      kind: "tool",
      label: "Update document",
      state: "failed",
      tool: "updateDocument",
    },
    {
      kind: "tool",
      label: "Get weather",
      state: "failed",
      tool: "getWeather",
    },
    {
      kind: "tool",
      label: "Delete document",
      state: "failed",
      tool: "deleteDocument",
    },
    {
      kind: "tool",
      label: "Request suggestions",
      state: "waiting",
      tool: "requestSuggestions",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(activities), /secret|provider response/u);
  assert.doesNotMatch(
    JSON.stringify(activities),
    /sensitive application failure/u
  );

  const model = buildReasoningCardModel({
    activities: [
      {
        kind: "reasoning",
        state: "completed",
        text: "Check the request.",
      },
      ...activities,
    ],
    isStreaming: false,
  });

  assert.equal(model.failureCount, 3);
  assert.equal(model.toolCallCount, 5);
  assert.equal(model.stepCount, 6);
  assert.match(model.footer, /failed/u);
});

test("streaming and terminal cards use honest status copy", () => {
  const streaming = buildReasoningCardModel({
    activities: [
      {
        kind: "reasoning",
        state: "active",
        text: "Checking the available evidence",
      },
    ],
    isStreaming: true,
  });
  assert.equal(streaming.summary, "Checking the available evidence");
  assert.equal(
    streaming.footer,
    "Reasoning and tool activity are updating live."
  );

  const empty = buildReasoningCardModel({
    activities: [],
    isStreaming: true,
  });
  assert.equal(empty.summary, "Working through the request");
  assert.equal(empty.stepCount, 1);
  assert.equal(empty.steps[0]?.state, "active");
});

test("streaming status aggregates across every reasoning part", () => {
  const activities = reasoningCardActivities([
    {
      state: "streaming",
      text: "Still checking the first source.",
      type: "reasoning",
    },
    {
      state: "done",
      text: "The second source is already complete.",
      type: "reasoning",
    },
  ]);

  assert.deepEqual(reasoningActivityStatus(activities), {
    isStreaming: true,
    present: true,
  });
});

test("long routine runs fold while failures and reasoning remain visible", () => {
  const model = buildReasoningCardModel({
    activities: [
      {
        kind: "reasoning",
        state: "completed",
        text: "Establish the comparison criteria.",
      },
      {
        kind: "tool",
        label: "Read file",
        state: "completed",
        tool: "readFile",
      },
      {
        kind: "tool",
        label: "Search files",
        state: "completed",
        tool: "searchFiles",
      },
      {
        kind: "tool",
        label: "Read file",
        state: "completed",
        tool: "readFile",
      },
      {
        kind: "tool",
        label: "Read file",
        state: "completed",
        tool: "readFile",
      },
      {
        kind: "tool",
        label: "Fetch source",
        state: "failed",
        tool: "fetchSource",
      },
      {
        kind: "tool",
        label: "Retry fetch",
        state: "completed",
        tool: "fetchSource",
      },
      {
        kind: "tool",
        label: "Write note",
        state: "completed",
        tool: "writeNote",
      },
      {
        kind: "tool",
        label: "Read note",
        state: "completed",
        tool: "readNote",
      },
    ],
    isStreaming: false,
  });

  const folded = foldReasoningCardSteps(model.steps, false);
  assert.ok(folded.some((step) => step.kind === "fold"));
  assert.ok(folded.some((step) => step.state === "failed"));
  assert.ok(folded.some((step) => step.kind === "reasoning"));
  assert.deepEqual(foldReasoningCardSteps(model.steps, true), model.steps);
});
