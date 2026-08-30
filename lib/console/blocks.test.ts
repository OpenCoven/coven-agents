import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentDefinition,
  RunEvent,
  RunSnapshot,
  RunStatus,
} from "@opencoven/agent-contracts";
import { isTerminal, projectRun } from "./blocks";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";

const AGENT: AgentDefinition = {
  backend: "cloud",
  createdAt: "2026-08-25T11:00:00.000Z",
  description: "Implements a described change, with a test proving it.",
  id: AGENT_ID,
  instructions: "You are an implementation agent.",
  lastRunAt: null,
  model: "auto",
  name: "Builder",
  owner: { kind: "tenant", tenantId: "tenant-a" },
  runtime: "copilot",
  status: "running",
  updatedAt: "2026-08-25T11:00:00.000Z",
  warm: {
    status: "ready",
    updatedAt: "2026-08-25T11:00:00.000Z",
  },
  workspace: "/workspace",
};

function snapshot(patch: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    agentId: AGENT_ID,
    apiVersion: "1.0",
    commandEvidence: [],
    completedAt: null,
    createdAt: "2026-08-25T12:00:00.000Z",
    fileEvidence: [],
    id: RUN_ID,
    operationId: OPERATION_ID,
    output: "",
    startedAt: "2026-08-25T12:00:00.000Z",
    status: "running",
    task: "Find what makes the session-claims test flaky and fix it.",
    ...patch,
  };
}

function project(events: RunEvent[], run: RunSnapshot | null = snapshot()) {
  return projectRun({ agent: AGENT, events, run });
}

test("the mission opens the record and is not a step", () => {
  // The mission is the premise, not something the agent did. Counting it as a
  // step would put a row in the index for work that never happened.
  const { blocks, steps } = project([]);

  assert.equal(blocks[0]?.kind, "mission");
  assert.equal(steps.length, 0);
});

test("the streamed record does not repeat the subscriber identity", () => {
  const [mission] = project([]).blocks;

  assert.equal(mission?.kind, "mission");
  assert.equal(mission && "who" in mission, false);
});

test("a running run exposes useful public-safe activity without copying event payloads", () => {
  const sensitiveOutput = "Authorization: Bearer private-stream-token";
  const sensitiveCommand = "curl https://user:password@example.invalid";
  const sensitivePath = "/Users/private/project/secret.txt";
  const { activity } = project([
    {
      at: "2026-08-25T12:00:01.000Z",
      id: 1,
      output: sensitiveOutput,
      type: "output",
    },
    {
      at: "2026-08-25T12:00:02.000Z",
      evidence: {
        command: sensitiveCommand,
        exitCode: 0,
        stderr: "",
        stdout: "",
      },
      id: 2,
      type: "command",
    },
    {
      at: "2026-08-25T12:00:03.000Z",
      evidence: { operation: "modify", path: sensitivePath },
      id: 3,
      type: "file",
    },
  ]);

  assert.deepEqual(activity, {
    detail: "A file change was reported. The agent is continuing.",
    headline: "Runner active",
    lastSignalAt: "2026-08-25T12:00:03.000Z",
    metrics: [
      { label: "Safe updates", value: "3" },
      { label: "Commands", value: "1" },
      { label: "Files", value: "1" },
    ],
    phase: "running",
  });
  assert.equal(
    JSON.stringify(activity).includes("private-stream-token"),
    false
  );
  assert.equal(JSON.stringify(activity).includes("password"), false);
  assert.equal(JSON.stringify(activity).includes("private/project"), false);
});

test("a quiet running run explains that it is waiting for sanitized output", () => {
  const { activity } = project([]);

  assert.equal(activity?.headline, "Runner active");
  assert.equal(
    activity?.detail,
    "The runner is checking the isolated process while waiting for the first sanitized update. It will stop and report a run that reaches the execution limit."
  );
  assert.equal(activity?.lastSignalAt, snapshot().startedAt);
});

test("the console projection defensively redacts every displayed runner string", () => {
  const token = [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "eyJzdWIiOiJwdWJsaWMtc3RyZWFtIn0",
    "abcdefghijklmnop0123456789",
  ].join(".");
  const privateKey = [
    "-----BEGIN PRIVATE",
    " KEY-----\nmaterial\n-----END PRIVATE",
    " KEY-----",
  ].join("");
  const { blocks } = project(
    [
      {
        at: "2026-08-25T12:00:01.000Z",
        id: 1,
        output: `analysis ${token}`,
        type: "output",
      },
      {
        at: "2026-08-25T12:00:02.000Z",
        evidence: {
          command: "curl postgres://runner:password@example.invalid/app",
          exitCode: 1,
          stderr: privateKey,
          stdout: "",
        },
        id: 2,
        type: "command",
      },
      {
        at: "2026-08-25T12:00:03.000Z",
        evidence: {
          operation: "modify",
          path: "/Users/private/project/secret.txt",
        },
        id: 3,
        type: "file",
      },
      {
        at: "2026-08-25T12:00:04.000Z",
        error: {
          code: "provider_error",
          details: `Authorization: Bearer ${token}`,
          message: `failed ${token}`,
          retryable: true,
        },
        id: 4,
        type: "failed",
      },
    ],
    snapshot({ task: `Inspect ${token}` })
  );
  const displayed = JSON.stringify(blocks);

  assert.equal(displayed.includes(token), false);
  assert.equal(displayed.includes("runner:password"), false);
  assert.equal(displayed.includes("material"), false);
  assert.equal(displayed.includes("/Users/private"), false);
  assert.match(displayed, /\[REDACTED\]/);
});

test("the console projection redacts structured credential fields", () => {
  const secrets = [
    "projected-camel-secret",
    "projected-hyphen-secret",
    "projected-yaml-secret",
    "projected-list-secret",
    "projected multi word secret",
    "projected inline yaml secret",
    "projected capital acronym secret",
    "projected lowercase compact secret",
    "projected nested api key secret",
    "projected escaped secret tail",
  ];
  const { blocks } = project([
    {
      at: "2026-08-25T12:00:01.000Z",
      id: 1,
      output: [
        `{"apiKey":"${secrets[0]}"}`,
        `{"x-api-key":"${secrets[1]}"}`,
        `  password: ${secrets[2]}`,
        `  - password: ${secrets[3]}`,
        `  password: ${secrets[4]}`,
        `{api.key: ${secrets[5]}}`,
        `{"APIKey":"${secrets[6]}"}`,
        `{"apikey":"${secrets[7]}"}`,
        `{"config":{"apiKey":"${secrets[8]}"}}`,
        `{"apiKey":"prefix\\"${secrets[9]}"}`,
      ].join("\n"),
      type: "output",
    },
  ]);
  const displayed = JSON.stringify(blocks);

  for (const secret of secrets) {
    assert.equal(displayed.includes(secret), false);
  }
  assert.match(displayed, /\[REDACTED\]/);
});

test("the console projection sanitizes arbitrary agent metadata", () => {
  const token = ["ghp", "_", "A".repeat(24)].join("");
  const projection = projectRun({
    agent: {
      ...AGENT,
      model: token,
      name: `Builder ${token}`,
      workspace: "/Users/private/project",
    },
    events: [],
    run: snapshot({
      completedAt: "2026-08-25T12:01:00.000Z",
      output: "Done.",
      status: "completed",
    }),
  });
  const displayed = JSON.stringify(projection.blocks);

  assert.equal(displayed.includes(token), false);
  assert.equal(displayed.includes("/Users/private"), false);
  assert.match(displayed, /\[REDACTED\]/);
});

test("a queued status opens no lifecycle line", () => {
  // The run is already queued when it is accepted, so announcing it would open
  // every thread with a step that never happened.
  const { blocks } = project([
    { at: "2026-08-25T12:00:00.000Z", id: 1, status: "queued", type: "status" },
  ]);

  assert.ok(!blocks.some((block) => block.kind === "lifecycle"));
});

test("consecutive output events coalesce into one passage", () => {
  // The runner flushes output at whatever granularity the harness produced it.
  // One block per flush would shred a paragraph into a column of fragments.
  const { blocks } = project([
    {
      at: "2026-08-25T12:00:01.000Z",
      id: 1,
      output: "Three failures ",
      type: "output",
    },
    {
      at: "2026-08-25T12:00:02.000Z",
      id: 2,
      output: "in twenty.",
      type: "output",
    },
  ]);

  const text = blocks.filter((block) => block.kind === "text");
  assert.equal(text.length, 1);
  assert.equal(
    text[0]?.kind === "text" ? text[0].text : "",
    "Three failures in twenty."
  );
});

test("the trailing passage is live only while the run is not terminal", () => {
  const events: RunEvent[] = [
    {
      at: "2026-08-25T12:00:01.000Z",
      id: 1,
      output: "Working.",
      type: "output",
    },
  ];

  const live = project(events).blocks.at(-1);
  assert.equal(live?.kind === "text" && live.live, true);

  const done = project(
    events,
    snapshot({ completedAt: "2026-08-25T12:01:00.000Z", status: "completed" })
  ).blocks.find((block) => block.kind === "text");
  assert.equal(done?.kind === "text" && done.live, false);
});

test("consecutive file events group into one card that names the operation", () => {
  const { blocks } = project([
    {
      at: "2026-08-25T12:00:03.000Z",
      evidence: { operation: "modify", path: "lib/session-claims.ts" },
      id: 1,
      type: "file",
    },
    {
      at: "2026-08-25T12:00:04.000Z",
      evidence: { operation: "modify", path: "lib/session-claims.test.ts" },
      id: 2,
      type: "file",
    },
  ]);

  const files = blocks.filter((block) => block.kind === "files");
  assert.equal(files.length, 1);
  assert.equal(
    files[0]?.kind === "files" ? files[0].label : "",
    "Edited 2 files"
  );
});

test("a card of creates says created, not edited", () => {
  const { blocks } = project([
    {
      at: "2026-08-25T12:00:03.000Z",
      evidence: { operation: "create", path: "lib/clock.ts" },
      id: 1,
      type: "file",
    },
  ]);

  const card = blocks.find((block) => block.kind === "files");
  assert.equal(card?.kind === "files" ? card.label : "", "Created 1 file");
});

test("a command's duration comes from its own timestamps, not the gap after it", () => {
  // The gap to the next event includes whatever the agent did afterwards.
  // Attributing that to the command would make every command look slow.
  const { blocks } = project([
    {
      at: "2026-08-25T12:00:05.000Z",
      evidence: {
        command: "pnpm vitest run lib",
        completedAt: "2026-08-25T12:00:07.000Z",
        exitCode: 1,
        startedAt: "2026-08-25T12:00:05.000Z",
        stderr: "",
        stdout: " Tests  1 failed",
      },
      id: 1,
      type: "command",
    },
    {
      at: "2026-08-25T12:01:00.000Z",
      id: 2,
      output: "Looking.",
      type: "output",
    },
  ]);

  const command = blocks.find((block) => block.kind === "command");
  assert.equal(command?.kind === "command" ? command.durationMs : null, 2000);
  assert.equal(command?.kind === "command" ? command.exitCode : null, 1);
});

test("a command with no exit code yet is live", () => {
  const { blocks } = project([
    {
      at: "2026-08-25T12:00:05.000Z",
      evidence: {
        command: "pnpm build",
        exitCode: null,
        stderr: "",
        stdout: "",
      },
      id: 1,
      type: "command",
    },
  ]);

  const command = blocks.find((block) => block.kind === "command");
  assert.equal(command?.kind === "command" ? command.live : false, true);
});

test("a terminal snapshot writes a receipt even when the completed event was missed", () => {
  // Reconnecting after the stream closed lands exactly here. The receipt is
  // what the run is for, so it is built from the snapshot rather than left off.
  const { blocks } = project(
    [],
    snapshot({
      commandEvidence: [
        { command: "pnpm tsc", exitCode: 0, stderr: "", stdout: "" },
        { command: "pnpm test", exitCode: 1, stderr: "boom", stdout: "" },
      ],
      completedAt: "2026-08-25T12:02:24.000Z",
      fileEvidence: [{ operation: "modify", path: "lib/db/index.ts" }],
      output: "The compiler is what stops it now.",
      status: "completed",
    })
  );

  const receipt = blocks.find((block) => block.kind === "evidence");
  assert.ok(receipt);
  if (receipt?.kind !== "evidence") {
    return;
  }

  assert.deepEqual(
    receipt.stats.map((stat) => stat.value),
    ["2", "1", "1 of 2", "2m 24s"]
  );
  assert.equal(receipt.claim, "The compiler is what stops it now.");
});

test("a diagnostic-only completion is not classified as an agent answer", () => {
  const { blocks } = project(
    [],
    snapshot({
      completedAt: "2026-08-25T12:01:00.000Z",
      output: "Runner omitted a file operation without a path.",
      status: "completed",
    })
  );
  const receipt = blocks.find((block) => block.kind === "evidence");

  assert.ok(receipt);
  assert.equal(
    (receipt as { hasAnswer?: boolean } | undefined)?.hasAnswer,
    false
  );
});

test("a failed run reports the runner's error rather than inventing one", () => {
  const { blocks, steps } = project(
    [],
    snapshot({
      completedAt: "2026-08-25T12:00:30.000Z",
      error: {
        code: "command_failed",
        details: "exit 1",
        message: "A command exited 1 and the run stopped.",
        retryable: false,
      },
      status: "failed",
    })
  );

  const failure = blocks.find((block) => block.kind === "error");
  assert.equal(failure?.kind === "error" ? failure.code : "", "command_failed");
  assert.equal(steps.at(-1)?.tone, "danger");
});

test("a watchdog timeout remains explicit and retryable in the run record", () => {
  const timeoutError = {
    code: "run_timeout",
    details:
      "Complete sanitized updates received before shutdown are preserved in this record.",
    message:
      "The runner stopped this run after it reached the execution time limit.",
    retryable: true,
  };
  const { blocks } = project(
    [
      {
        at: "2026-08-25T12:15:00.000Z",
        error: timeoutError,
        id: 1,
        type: "failed",
      },
    ],
    snapshot({
      completedAt: "2026-08-25T12:15:00.000Z",
      error: timeoutError,
      status: "failed",
    })
  );
  const failure = blocks.find((block) => block.kind === "error");

  assert.equal(failure?.kind === "error" ? failure.code : "", "run_timeout");
  assert.equal(failure?.kind === "error" && failure.retryable, true);
  assert.match(
    failure?.kind === "error" ? failure.message : "",
    /execution time limit/u
  );
});

test("the running strip names the command in flight", () => {
  const { nowDoing } = project([
    {
      at: "2026-08-25T12:00:05.000Z",
      evidence: {
        command: "pnpm vitest run lib",
        exitCode: null,
        stderr: "",
        stdout: "",
      },
      id: 1,
      type: "command",
    },
  ]);

  assert.equal(nowDoing, "Running pnpm");
});

test("a queued run says it is waiting for a sandbox", () => {
  const { nowDoing } = project([], snapshot({ status: "queued" }));
  assert.equal(nowDoing, "Waiting for a sandbox");
});

test("a terminal run is doing nothing", () => {
  const { activity, nowDoing } = project(
    [],
    snapshot({ completedAt: "2026-08-25T12:01:00.000Z", status: "completed" })
  );
  assert.equal(nowDoing, "");
  assert.equal(activity, null);
});

test("only the three ended statuses are terminal", () => {
  const terminal: RunStatus[] = ["completed", "failed", "cancelled"];
  for (const status of terminal) {
    assert.equal(isTerminal(status), true, status);
  }
  assert.equal(isTerminal("queued"), false);
  assert.equal(isTerminal("running"), false);
  assert.equal(isTerminal(null), false);
});

test("with no run there is nothing to project", () => {
  const { blocks, steps } = project([], null);
  assert.deepEqual(blocks, []);
  assert.deepEqual(steps, []);
});
