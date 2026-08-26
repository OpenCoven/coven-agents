import assert from "node:assert/strict";
import test from "node:test";
import type { AgentDefinition } from "@opencoven/agent-contracts";
import { fiberControl, fiberLog, resetFiberLog } from "../test-support/agents";
import { AgentDirectory, YoloAgent } from "./agents";
import { AlreadyRunningError, OperationConflictError } from "./run-state";

const AGENT_ID = "3f1a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90";
const OP_A = "11111111-2222-4333-8444-555555555555";
const OP_B = "22222222-3333-4444-8555-666666666666";

function definition(): AgentDefinition {
  return {
    backend: "cloud",
    createdAt: "2026-08-20T12:00:00.000Z",
    description: "",
    id: AGENT_ID,
    instructions: "Do the thing.",
    lastRunAt: null,
    model: "auto",
    name: "Cody",
    owner: { kind: "tenant", tenantId: "acct_1" },
    runtime: "copilot",
    status: "idle",
    updatedAt: "2026-08-20T12:00:00.000Z",
  };
}

/**
 * Fibers are dispatched but not executed. The harness itself is covered
 * elsewhere; what matters here is that a run is accepted, recorded and left
 * in flight, which is exactly the state a caller sees after a 202.
 */
function agent(): YoloAgent {
  resetFiberLog();
  fiberControl.runFibers = false;
  const instance = new YoloAgent(undefined as never, {} as never);
  instance.configure(definition());
  return instance;
}

test("start accepts a run, records it queued, and dispatches one fiber", async () => {
  const yolo = agent();

  const started = await yolo.start(
    { operationId: OP_A, task: "Fix tests." },
    "identity"
  );

  assert.equal(started.created, true);
  assert.equal(started.run.status, "queued");
  assert.equal(started.run.task, "Fix tests.");
  assert.equal(fiberLog.started.length, 1);
  assert.equal(
    fiberLog.started[0]?.key,
    `run:${started.run.id}`,
    "the fiber is keyed on the run so stop can find it"
  );
});

test("replaying an operation id returns the same run without a second fiber", async () => {
  const yolo = agent();

  const first = await yolo.start(
    { operationId: OP_A, task: "Fix tests." },
    "identity"
  );
  const second = await yolo.start(
    { operationId: OP_A, task: "Fix tests." },
    "identity"
  );

  assert.equal(second.run.id, first.run.id);
  assert.equal(second.created, false, "a replay must not create a new run");
  assert.equal(fiberLog.started.length, 1, "no second fiber may be dispatched");
});

test("reusing an operation id for a different task is a conflict", async () => {
  const yolo = agent();
  await yolo.start({ operationId: OP_A, task: "Fix tests." }, "identity");

  await assert.rejects(
    () =>
      yolo.start({ operationId: OP_A, task: "Something else." }, "identity"),
    OperationConflictError
  );
});

test("a second concurrent run is refused", async () => {
  const yolo = agent();
  await yolo.start({ operationId: OP_A, task: "Fix tests." }, "identity");

  await assert.rejects(
    () => yolo.start({ operationId: OP_B, task: "Another job." }, "identity"),
    AlreadyRunningError
  );
});

test("concurrent admitted dispatches claim only one run for an agent", async () => {
  const yolo = agent();
  const first = await yolo.enqueue(
    { operationId: OP_A, task: "First admitted run." },
    "3f1a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90",
    "hash-a",
    "identity"
  );
  const second = await yolo.enqueue(
    { operationId: OP_B, task: "Second admitted run." },
    "4f2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c91",
    "hash-b",
    "identity"
  );

  const results = await Promise.allSettled([
    yolo.startAdmitted(first.run.id),
    yolo.startAdmitted(second.run.id),
  ]);

  assert.equal(
    results.filter(
      (result) => result.status === "fulfilled" && result.value === true
    ).length,
    1,
    "one dispatch must win the atomic agent claim"
  );
  assert.equal(
    results.filter(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof AlreadyRunningError
    ).length,
    1,
    "the losing dispatch must observe the active-run invariant"
  );
});

test("missing admitted identity does not consume the agent slot", async () => {
  const yolo = agent();
  const queued = await yolo.enqueue(
    { operationId: OP_A, task: "Missing identity." },
    "5f2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c92",
    "hash-missing-identity",
    ""
  );

  await assert.rejects(
    () => yolo.startAdmitted(queued.run.id),
    /Queued run identity is unavailable/
  );

  assert.equal(yolo.getRun(queued.run.id)?.status, "queued");
});

test("stop cancels the fiber and closes the record", async () => {
  const yolo = agent();
  const started = await yolo.start(
    { operationId: OP_A, task: "Fix tests." },
    "identity"
  );

  const stopped = await yolo.stop(started.run.id);

  assert.equal(stopped?.status, "cancelled");
  assert.ok(stopped?.completedAt, "a cancelled run must be closed out");
  assert.deepEqual(
    fiberLog.cancelled.map((entry) => entry.key),
    [`run:${started.run.id}`]
  );
});

test("a cancelled run frees the agent for the next one", async () => {
  // Without closing the record, the run stays "running" forever and every
  // later start is refused as already_running.
  const yolo = agent();
  const first = await yolo.start(
    { operationId: OP_A, task: "Fix tests." },
    "identity"
  );
  await yolo.stop(first.run.id);

  const second = await yolo.start(
    { operationId: OP_B, task: "Next job." },
    "identity"
  );

  assert.equal(second.created, true);
});

test("cancelling an admitted queued run releases its deployment slot", async () => {
  resetFiberLog();
  fiberControl.runFibers = false;
  const released: string[] = [];
  const yolo = new YoloAgent(
    undefined as never,
    {
      RunAdmission: {
        getByName: () => ({
          release: (runId: string) => {
            released.push(runId);
            return Promise.resolve(true);
          },
        }),
      },
    } as never
  );
  yolo.configure(definition());

  const queued = await yolo.enqueue(
    { operationId: OP_A, task: "Queued work." },
    "9c1b7d2f-5a6b-4c90-8f1a-0f4e1f4d4a2e",
    "request-hash",
    "identity"
  );
  await yolo.stop(queued.run.id);

  assert.deepEqual(released, [queued.run.id]);
});

test("stopping a finished run does not rewrite its outcome", async () => {
  const yolo = agent();
  const started = await yolo.start(
    { operationId: OP_A, task: "Fix tests." },
    "identity"
  );
  const cancelled = await yolo.stop(started.run.id);

  const again = await yolo.stop(started.run.id);

  assert.equal(again?.status, "cancelled");
  assert.equal(again?.completedAt, cancelled?.completedAt);
  assert.equal(
    fiberLog.cancelled.length,
    1,
    "a terminal run must not be cancelled twice"
  );
});

test("stopping an unknown run reports absence rather than inventing one", async () => {
  const yolo = agent();

  assert.equal(await yolo.stop(OP_B), null);
});

test("the event stream returns only events after the cursor", async () => {
  const yolo = agent();
  const started = await yolo.start(
    { operationId: OP_A, task: "Fix tests." },
    "identity"
  );

  const all = yolo.getEventStream(started.run.id, 0);
  const after = yolo.getEventStream(
    started.run.id,
    all?.events.at(-1)?.id ?? 0
  );

  assert.ok((all?.events.length ?? 0) > 0);
  assert.deepEqual(after?.events, [], "a caught-up cursor yields nothing new");
  assert.equal(after?.terminal, false, "the run is still in flight");
});

test("the event stream reports terminal so a subscriber can stop polling", async () => {
  const yolo = agent();
  const started = await yolo.start(
    { operationId: OP_A, task: "Fix tests." },
    "identity"
  );
  await yolo.stop(started.run.id);

  assert.equal(yolo.getEventStream(started.run.id, 0)?.terminal, true);
});

test("the event stream distinguishes an unknown run from an empty one", () => {
  const yolo = agent();

  assert.equal(yolo.getEventStream(OP_B, 0), null);
});

function directory(): AgentDirectory {
  const instance = new AgentDirectory(undefined as never, {} as never);
  instance.upsert(definition());
  return instance;
}

test("a registered run resolves back to its agent", () => {
  const index = directory();
  index.registerRun(OP_A, AGENT_ID);

  assert.equal(index.lookupRun(OP_A), AGENT_ID);
  assert.equal(index.lookupRun(OP_B), null);
});

test("registering a run does not drop the agent list", () => {
  // setState replaces rather than merges, so a missing spread here silently
  // empties the directory.
  const index = directory();
  index.registerRun(OP_A, AGENT_ID);

  assert.equal(index.list("acct_1").length, 1);
});

test("a prototype key is not mistaken for a registered run", () => {
  const index = directory();

  assert.equal(index.lookupRun("constructor"), null);
  assert.equal(index.lookupRun("__proto__"), null);
});

test("removing an agent drops its runs from the index", () => {
  // A leftover entry would resolve a stale run id to an agent that no longer
  // exists, and the run route would address an empty Durable Object.
  const index = directory();
  index.registerRun(OP_A, AGENT_ID);

  index.remove(AGENT_ID);

  assert.equal(index.lookupRun(OP_A), null);
  assert.equal(index.list("acct_1").length, 0);
});
