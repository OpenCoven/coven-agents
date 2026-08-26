import assert from "node:assert/strict";
import test from "node:test";
import type { AgentDefinition } from "@opencoven/agent-contracts";
import {
  type FiberContext,
  fiberControl,
  fiberLog,
  resetFiberLog,
} from "../test-support/agents";
import {
  destroyedSandboxes,
  resetDestroyedSandboxes,
  setSandboxDestroyError,
} from "../test-support/cloudflare-sandbox";
import { AgentDirectory, YoloAgent } from "./agents";
import {
  AlreadyRunningError,
  type CloudRunRecord,
  finishCloudRunRecord,
  OperationConflictError,
} from "./run-state";

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

test("a durable admission fence rejects a delayed token but permits the next claim", async () => {
  const yolo = agent();
  const queued = await yolo.enqueue(
    { operationId: OP_A, task: "Fenced work." },
    "3f2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90",
    "hash-fence",
    "identity"
  );

  assert.equal(await yolo.fenceAdmitted(queued.run.id, "1:token-a"), true);
  assert.equal(await yolo.startAdmitted(queued.run.id, "1:late-a"), false);
  assert.equal(yolo.getRun(queued.run.id)?.status, "queued");
  assert.equal(fiberLog.started.length, 0);

  assert.equal(await yolo.startAdmitted(queued.run.id, "2:token-b"), true);
  assert.equal(yolo.getRun(queued.run.id)?.status, "running");
  assert.equal(fiberLog.started.length, 1);
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

test("a fiber start failure closes an admitted run and releases its claim", async () => {
  resetFiberLog();
  fiberControl.runFibers = false;
  let failNext = true;
  const released: string[] = [];
  const yolo = new (class extends YoloAgent {
    override startFiber(
      name: string,
      fn: Parameters<YoloAgent["startFiber"]>[1],
      options?: Parameters<YoloAgent["startFiber"]>[2]
    ): ReturnType<YoloAgent["startFiber"]> {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error("fiber unavailable"));
      }
      return super.startFiber(name, fn, options);
    }
  })(
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

  const first = await yolo.enqueue(
    { operationId: OP_A, task: "First admitted run." },
    "6f2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c93",
    "hash-fiber-failure",
    "identity"
  );

  await assert.rejects(
    () => yolo.startAdmitted(first.run.id),
    /fiber unavailable/
  );

  const failed = yolo.getRun(first.run.id);
  assert.equal(failed?.status, "failed");
  assert.ok(failed?.completedAt);
  assert.deepEqual(released, [first.run.id]);

  const second = await yolo.enqueue(
    { operationId: OP_B, task: "Second admitted run." },
    "7f2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c94",
    "hash-fiber-recovery",
    "identity"
  );
  assert.equal(await yolo.startAdmitted(second.run.id), true);
  assert.equal(yolo.getRun(second.run.id)?.status, "running");
});

test("an already accepted fiber is not reported as a second admission", async () => {
  resetFiberLog();
  fiberControl.runFibers = false;
  const yolo = new (class extends YoloAgent {
    override startFiber(
      _name: string,
      _fn: Parameters<YoloAgent["startFiber"]>[1],
      _options?: Parameters<YoloAgent["startFiber"]>[2]
    ): ReturnType<YoloAgent["startFiber"]> {
      return Promise.resolve({
        accepted: false,
        createdAt: Date.now(),
        fiberId: "fiber:already-accepted",
        name: "run:already-accepted",
        status: "running",
      });
    }
  })(undefined as never, {} as never);
  yolo.configure(definition());
  const queued = await yolo.enqueue(
    { operationId: OP_A, task: "Already accepted work." },
    "8f2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c95",
    "hash-already-accepted",
    "identity"
  );

  assert.equal(await yolo.startAdmitted(queued.run.id), false);
  assert.equal(yolo.getRun(queued.run.id)?.status, "running");
  assert.equal(fiberLog.started.length, 0);
});

test("a recovered admitted fiber fails once, releases capacity, and permits the next run", async () => {
  resetFiberLog();
  resetDestroyedSandboxes();
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
  const first = await yolo.enqueue(
    { operationId: OP_A, task: "Interrupted work." },
    "af2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c96",
    "hash-interrupted",
    "identity"
  );
  assert.equal(await yolo.startAdmitted(first.run.id), true);

  const recovery = {
    createdAt: Date.parse("2026-08-26T00:00:00.000Z"),
    id: "fiber-interrupted",
    metadata: { runId: first.run.id },
    name: `run:${first.run.id}`,
    recoveryReason: "interrupted" as const,
    snapshot: null,
    status: "interrupted" as const,
  };
  const result = await yolo.onFiberRecovered(recovery);
  assert.equal(result?.status, "error");
  assert.equal(destroyedSandboxes().length, 1);
  assert.equal(yolo.getRun(first.run.id)?.status, "failed");
  assert.equal(yolo.snapshot()?.status, "error");
  assert.deepEqual(released, [first.run.id]);

  await yolo.onFiberRecovered(recovery);
  assert.deepEqual(released, [first.run.id]);

  const second = await yolo.enqueue(
    { operationId: OP_B, task: "Next work." },
    "bf2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c97",
    "hash-next",
    "identity"
  );
  assert.equal(await yolo.startAdmitted(second.run.id), true);
});

test("fiber recovery fails closed when sandbox cleanup is unavailable", async () => {
  resetFiberLog();
  resetDestroyedSandboxes();
  setSandboxDestroyError(new Error("sandbox unavailable"));
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
    { operationId: OP_A, task: "Interrupted work." },
    "af2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c96",
    "hash-interrupted",
    "identity"
  );
  assert.equal(await yolo.startAdmitted(queued.run.id), true);

  await assert.rejects(
    () =>
      yolo.onFiberRecovered({
        createdAt: Date.now(),
        id: "fiber-interrupted",
        metadata: { runId: queued.run.id },
        name: `run:${queued.run.id}`,
        recoveryReason: "interrupted",
        snapshot: null,
        status: "interrupted",
      }),
    /sandbox unavailable/
  );
  assert.equal(yolo.getRun(queued.run.id)?.status, "running");
  assert.deepEqual(released, []);
  setSandboxDestroyError(null);
});

test("cancellation waits for sandbox cleanup before releasing capacity", async () => {
  resetFiberLog();
  resetDestroyedSandboxes();
  setSandboxDestroyError(new Error("sandbox unavailable"));
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
  const first = await yolo.enqueue(
    { operationId: OP_A, task: "Cancelled work." },
    "cf2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c98",
    "hash-cancelled",
    "identity"
  );
  assert.equal(await yolo.startAdmitted(first.run.id), true);

  await assert.rejects(() => yolo.stop(first.run.id), /sandbox unavailable/);
  assert.equal(yolo.getRun(first.run.id)?.status, "running");
  assert.deepEqual(released, []);

  setSandboxDestroyError(null);
  const cancelled = await yolo.stop(first.run.id);
  assert.equal(cancelled?.status, "cancelled");
  assert.deepEqual(released, [first.run.id]);
});

test("late fiber completion cannot overwrite cancellation or release twice", async () => {
  resetFiberLog();
  fiberControl.runFibers = false;
  const released: string[] = [];
  let lateFiber: ((context: FiberContext) => Promise<void>) | undefined;
  const yolo = new (class extends YoloAgent {
    override startFiber(
      _name: string,
      fn: Parameters<YoloAgent["startFiber"]>[1],
      _options?: Parameters<YoloAgent["startFiber"]>[2]
    ): ReturnType<YoloAgent["startFiber"]> {
      lateFiber = fn;
      return Promise.resolve({
        accepted: true,
        createdAt: Date.now(),
        fiberId: "fiber:late",
        name: "run:late",
        status: "running",
      });
    }

    protected override driveHarness(
      _definition: AgentDefinition,
      planned: CloudRunRecord
    ): Promise<CloudRunRecord> {
      return Promise.resolve(
        finishCloudRunRecord(planned, {
          completedAt: "2026-08-26T00:00:02.000Z",
          credential: null,
          output: "late completion",
          status: "completed",
        })
      );
    }
  })(
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
    { operationId: OP_A, task: "Race work." },
    "cf2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c98",
    "hash-race",
    "identity"
  );
  assert.equal(await yolo.startAdmitted(queued.run.id), true);

  await yolo.stop(queued.run.id);
  assert.equal(yolo.getRun(queued.run.id)?.status, "cancelled");
  assert.ok(lateFiber);
  await lateFiber({
    id: `fiber:${queued.run.id}`,
    signal: new AbortController().signal,
    snapshot: null,
    stash: () => undefined,
  });

  assert.equal(yolo.getRun(queued.run.id)?.status, "cancelled");
  assert.deepEqual(released, [queued.run.id]);
});

test("a stale admitted fiber callback cannot finish or release a newer token claim", async () => {
  resetFiberLog();
  fiberControl.runFibers = false;
  const released: { runId: string; dispatchToken?: string }[] = [];
  const fibers: ((context: FiberContext) => Promise<void>)[] = [];
  const yolo = new (class extends YoloAgent {
    override startFiber(
      _name: string,
      fn: Parameters<YoloAgent["startFiber"]>[1],
      _options?: Parameters<YoloAgent["startFiber"]>[2]
    ): ReturnType<YoloAgent["startFiber"]> {
      fibers.push(fn);
      return Promise.resolve({
        accepted: true,
        createdAt: Date.now(),
        fiberId: `fiber:${fibers.length}`,
        name: `run:${fibers.length}`,
        status: "running",
      });
    }

    protected override driveHarness(
      _definition: AgentDefinition,
      planned: CloudRunRecord
    ): Promise<CloudRunRecord> {
      if (planned.dispatchToken === "token-old") {
        return Promise.reject(new Error("obsolete"));
      }
      return Promise.resolve(
        finishCloudRunRecord(planned, {
          completedAt: "2026-08-26T00:00:02.000Z",
          credential: null,
          output: "completed",
          status: "completed",
        })
      );
    }
  })(
    undefined as never,
    {
      RunAdmission: {
        getByName: () => ({
          release: (runId: string, dispatchToken?: string) => {
            released.push({ dispatchToken, runId });
            return Promise.resolve(true);
          },
        }),
      },
    } as never
  );
  yolo.configure(definition());

  const queued = await yolo.enqueue(
    { operationId: OP_A, task: "Fenced work." },
    "df2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c99",
    "hash-fenced",
    "identity"
  );
  assert.equal(await yolo.startAdmitted(queued.run.id, "token-old"), true);

  const state = Reflect.get(yolo, "state") as {
    admissionTokens?: Record<string, string>;
    definition: AgentDefinition | null;
    identityTokens?: Record<string, string>;
    runs: CloudRunRecord[];
  };
  const current = state.runs.find(
    (candidate) => candidate.run.id === queued.run.id
  );
  assert.ok(current);
  yolo.setState({
    ...state,
    runs: [
      {
        ...current,
        run: { ...current.run, status: "queued" },
      },
      ...state.runs.filter((candidate) => candidate.run.id !== queued.run.id),
    ],
  });

  assert.equal(await yolo.startAdmitted(queued.run.id, "token-new"), true);
  assert.equal(fibers.length, 2);
  await assert.rejects(
    () =>
      fibers[0]?.({
        id: "fiber:old",
        signal: new AbortController().signal,
        snapshot: null,
        stash: () => undefined,
      }),
    /obsolete/
  );
  assert.deepEqual(released, []);
  assert.equal(yolo.getRun(queued.run.id)?.status, "running");

  const latestState = Reflect.get(yolo, "state") as {
    admissionTokens?: Record<string, string>;
    definition: AgentDefinition | null;
    identityTokens?: Record<string, string>;
    runs: CloudRunRecord[];
  };
  const latestRecord = latestState.runs.find(
    (candidate) => candidate.run.id === queued.run.id
  );
  assert.ok(latestRecord);
  const completed = finishCloudRunRecord(latestRecord, {
    completedAt: "2026-08-26T00:00:03.000Z",
    credential: null,
    output: "completed",
    status: "completed",
  });
  yolo.setState({
    ...latestState,
    runs: [
      completed,
      ...latestState.runs.filter(
        (candidate) => candidate.run.id !== queued.run.id
      ),
    ],
  });
  await fibers[1]?.({
    id: "fiber:new",
    signal: new AbortController().signal,
    snapshot: null,
    stash: () => undefined,
  });
  assert.deepEqual(released, [
    { dispatchToken: "token-new", runId: queued.run.id },
  ]);
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

test("admission terminal reporting does not retain an unbounded run map", async () => {
  resetFiberLog();
  resetDestroyedSandboxes();
  fiberControl.runFibers = false;
  const yolo = new YoloAgent(
    undefined as never,
    {
      RunAdmission: {
        getByName: () => ({
          release: () => Promise.resolve(true),
        }),
      },
    } as never
  );
  yolo.configure(definition());

  for (let index = 0; index < 32; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: Each run must be terminalized before the next retention check.
    const run = await yolo.enqueue(
      {
        operationId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        task: "Discard this.",
      },
      `df2a0f4e-1f4d-4a2e-9c1b-${String(index).padStart(12, "0")}`,
      `hash-${index}`,
      "identity"
    );
    await yolo.stop(run.run.id);
  }

  const state = Reflect.get(yolo, "state") as {
    admissionReported?: Record<string, boolean>;
  };
  assert.ok(
    Object.keys(state.admissionReported ?? {}).length <= 3,
    "terminal reporting state must be bounded with run retention"
  );
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

test("unregistering a run is ownership guarded and idempotent", () => {
  const index = directory();
  index.registerRun(OP_A, AGENT_ID);

  assert.equal(index.unregisterRun(OP_A, "another-agent"), false);
  assert.equal(index.lookupRun(OP_A), AGENT_ID);
  assert.equal(index.unregisterRun(OP_A, AGENT_ID), true);
  assert.equal(index.unregisterRun(OP_A, AGENT_ID), false);
  assert.equal(index.lookupRun(OP_A), null);
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
