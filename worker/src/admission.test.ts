import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { AgentDefinition } from "@opencoven/agent-contracts";
import {
  AdmissionQueue,
  type AdmissionRecord,
  AdmissionUnavailableError,
  admissionLimits,
  admissionMode,
  RunAdmission,
  tenantAdmissionHash,
} from "./admission";
import { YoloAgent } from "./agents";
import { OperationConflictError, planCloudRunStart } from "./run-state";

const TENANT_A = "v1:tenant-a";
const TENANT_B = "v1:tenant-b";

function request(
  index: number,
  tenantHash = TENANT_A,
  requestHash = `request-${index}`
) {
  return {
    agentId: `agent-${index}`,
    operationId: `operation-${index}`,
    requestHash,
    runId: `run-${index}`,
    tenantHash,
  };
}

function activeRecord(index: number, tenantHash = TENANT_A): AdmissionRecord {
  return {
    ...request(index, tenantHash),
    enqueuedAt: new Date(index).toISOString(),
    state: "active",
  };
}

test("one active run per agent remains enforced by run-state", () => {
  const first = planCloudRunStart({
    agentId: "agent-1",
    createdAt: "2026-08-26T00:00:00.000Z",
    operationHash: "hash-1",
    operationId: "operation-1",
    records: [],
    runId: "run-1",
    task: "first",
  });
  assert.equal(first.kind, "created");
  if (first.kind !== "created") {
    return;
  }

  const second = planCloudRunStart({
    agentId: "agent-1",
    createdAt: "2026-08-26T00:00:01.000Z",
    operationHash: "hash-2",
    operationId: "operation-2",
    records: [first.record],
    runId: "run-2",
    task: "second",
  });

  assert.equal(second.kind, "already_running");
});

test("no more than two active runs belong to one tenant", async () => {
  const dispatched: string[] = [];
  const queue = new AdmissionQueue({
    dispatch: (record) => {
      dispatched.push(record.runId);
      return Promise.resolve(true);
    },
  });

  await queue.admit(request(1));
  await queue.admit(request(2));
  const third = await queue.admit(request(3));

  assert.equal(dispatched.length, 2);
  assert.deepEqual(third, { kind: "queued", position: 1, runId: "run-3" });
  assert.equal(
    queue
      .records()
      .filter(
        (record) => record.tenantHash === TENANT_A && record.state === "active"
      ).length,
    2
  );
});

test("a tenant queue never exceeds ten waiting records", async () => {
  const queue = new AdmissionQueue({
    dispatch: () => Promise.resolve(false),
    records: [activeRecord(1), activeRecord(2)],
  });

  for (let index = 3; index <= 12; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: preserve queue order
    const decision = await queue.admit(request(index));
    assert.equal(decision.kind, "queued");
  }

  const refused = await queue.admit(request(13));
  assert.deepEqual(refused, {
    kind: "refused",
    reason: "tenant_queue_full",
  });
  assert.equal(
    queue
      .records()
      .filter(
        (record) => record.tenantHash === TENANT_A && record.state === "queued"
      ).length,
    10
  );
});

test("deployment active ceiling refuses new work", async () => {
  const queue = new AdmissionQueue({
    records: Array.from({ length: 25 }, (_unused, index) =>
      activeRecord(index, `tenant-${index}`)
    ),
  });

  assert.deepEqual(await queue.admit(request(99, TENANT_B)), {
    kind: "refused",
    reason: "global_busy",
  });
});

test("dispatch candidate selection enforces the deployment active ceiling", () => {
  const queue = new AdmissionQueue({
    limits: { deploymentActiveRuns: 1 },
    records: [
      activeRecord(1, TENANT_A),
      {
        ...request(2, TENANT_B),
        enqueuedAt: new Date(2).toISOString(),
        state: "queued",
      },
    ],
  });

  assert.equal(
    queue.nextDispatchCandidate(),
    undefined,
    "a full deployment must not claim another queued record"
  );
});

test("dispatch skips an expired head when a tenant has newer work", () => {
  const now = Date.parse("2026-08-26T00:00:00.000Z");
  const queue = new AdmissionQueue({
    now: () => now,
    records: [
      {
        ...request(3, TENANT_A),
        enqueuedAt: new Date(now - 5 * 60 * 1000 - 1).toISOString(),
        state: "queued",
      },
      {
        ...request(4, TENANT_A),
        enqueuedAt: new Date(now - 1000).toISOString(),
        state: "queued",
      },
    ],
  });

  assert.equal(
    queue.nextDispatchCandidate()?.runId,
    "run-4",
    "an expired queued record must not block newer dispatchable work"
  );
});

test("round-robin dispatch gives a waiting tenant a slot before a third turn", async () => {
  const dispatched: string[] = [];
  const queue = new AdmissionQueue({
    dispatch: (record) => {
      dispatched.push(record.tenantHash);
      return Promise.resolve(true);
    },
  });

  await queue.admit(request(1, TENANT_A));
  await queue.admit(request(2, TENANT_A));
  await queue.admit(request(3, TENANT_A));
  await queue.admit(request(4, TENANT_B));

  await queue.release("run-1");

  assert.deepEqual(dispatched.slice(0, 3), [TENANT_A, TENANT_A, TENANT_B]);
  assert.equal(
    queue.records().find((record) => record.runId === "run-3")?.state,
    "active"
  );
});

test("cancellation and timeout release admission capacity", async () => {
  const activeQueue = new AdmissionQueue({
    dispatch: () => Promise.resolve(true),
  });
  const active = await activeQueue.admit(request(20));
  assert.deepEqual(active, { kind: "active", runId: "run-20" });
  await activeQueue.release("run-20");
  assert.deepEqual(await activeQueue.admit(request(21)), {
    kind: "active",
    runId: "run-21",
  });

  const queue = new AdmissionQueue({
    dispatch: () => Promise.resolve(false),
  });

  await queue.admit(request(1));
  const expired = await queue.expire(Date.now() + 5 * 60 * 1000 + 1);
  assert.deepEqual(expired, ["run-1"]);

  const next = await queue.admit(request(2));
  assert.deepEqual(next, { kind: "queued", position: 1, runId: "run-2" });
  await queue.release("run-2");
  assert.equal(
    queue.records().find((record) => record.runId === "run-2")?.state,
    "terminal"
  );
});

test("duplicate operation ids return the original queued or active record", async () => {
  const queue = new AdmissionQueue({
    dispatch: () => Promise.resolve(false),
  });
  const first = await queue.admit(request(1, TENANT_A, "same-request"));
  assert.deepEqual(first, { kind: "queued", position: 1, runId: "run-1" });

  assert.deepEqual(
    await queue.admit({
      ...request(2, TENANT_A, "same-request"),
      operationId: "operation-1",
    }),
    { kind: "duplicate", runId: "run-1", state: "queued" }
  );
  await assert.rejects(
    () =>
      queue.admit({
        ...request(3, TENANT_A, "different-request"),
        operationId: "operation-1",
      }),
    OperationConflictError
  );

  const activeQueue = new AdmissionQueue({
    dispatch: () => Promise.resolve(true),
  });
  assert.deepEqual(
    await activeQueue.admit({
      ...request(4, TENANT_A, "active-request"),
      operationId: "operation-active",
    }),
    { kind: "active", runId: "run-4" }
  );
  assert.deepEqual(
    await activeQueue.admit({
      ...request(5, TENANT_A, "active-request"),
      operationId: "operation-active",
    }),
    { kind: "duplicate", runId: "run-4", state: "active" }
  );
});

test("admission configuration fails closed and cannot raise hard maxima", () => {
  assert.throws(
    () =>
      admissionLimits({
        RUN_ADMISSION_CONSECUTIVE_MAX: "3",
      }),
    /no greater than its hard maximum/
  );
  assert.throws(
    () =>
      admissionLimits({
        RUN_ADMISSION_TENANT_ACTIVE_MAX: "not-a-number",
      }),
    /non-negative integer/
  );
  assert.throws(
    () => admissionMode({ RUN_ADMISSION_MODE: "bypass" }),
    /either queue or reject/
  );
});

test("tenant admission hashes are stable and do not expose the tenant id", async () => {
  const first = await tenantAdmissionHash("admission-secret", "tenant-a");
  const second = await tenantAdmissionHash("admission-secret", "tenant-a");

  assert.equal(first, second);
  assert.match(first, /^v1:[0-9a-f]{64}$/);
  assert.equal(first.includes("tenant-a"), false);
});

type SqlRows = {
  toArray: () => unknown[];
};
type SqlInput = null | number | bigint | string | NodeJS.ArrayBufferView;

type AdmissionHarnessOptions = {
  setAlarmFailure?: { error: Error | null };
};

function runAdmissionHarness(
  getAgent: () => {
    getRun: (runId: string) => unknown;
    startAdmitted: (runId: string) => Promise<boolean>;
    stop: (runId: string) => Promise<unknown>;
  },
  environment: Record<string, string> = {},
  options: AdmissionHarnessOptions = {}
) {
  const database = new DatabaseSync(":memory:");
  let alarm: number | null = null;
  const background: Promise<unknown>[] = [];
  const sql = {
    exec<T>(
      query: string,
      ...parameters: SqlInput[]
    ): SqlRows & { toArray: () => T[] } {
      const statement = database.prepare(query);
      if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
        return {
          toArray: () => statement.all(...parameters) as T[],
        };
      }
      statement.run(...parameters);
      return { toArray: () => [] as T[] };
    },
  };
  const ctx = {
    blockConcurrencyWhile: <T>(callback: () => Promise<T>) => callback(),
    storage: {
      deleteAlarm: () => {
        alarm = null;
      },
      getAlarm: async () => alarm,
      setAlarm: (scheduled: number) => {
        if (options.setAlarmFailure?.error) {
          return Promise.reject(options.setAlarmFailure.error);
        }
        alarm = scheduled;
        return Promise.resolve();
      },
      sql,
      transactionSync: <T>(callback: () => T) => callback(),
    },
    waitUntil: (promise: Promise<unknown>) => {
      background.push(promise);
    },
  };
  const admission = new RunAdmission(
    ctx as never,
    {
      YoloAgent: { getByName: () => getAgent() },
      ...environment,
    } as never
  );
  return {
    admission,
    alarm: () => alarm,
    background,
    setAlarm: (value: number | null) => {
      alarm = value;
    },
    sql,
  };
}

test("serializes concurrent admissions against the persistent capacity ledger", async () => {
  const harness = runAdmissionHarness(
    () => ({
      getRun: () => ({ status: "queued" }),
      startAdmitted: () => Promise.resolve(false),
      stop: () => Promise.resolve(null),
    }),
    {
      RUN_ADMISSION_TENANT_ACTIVE_MAX: "0",
      RUN_ADMISSION_TENANT_QUEUE_MAX: "10",
    }
  );

  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_unused, index) =>
      harness.admission.admit(request(100 + index))
    )
  );

  assert.equal(
    results.filter(
      (result) =>
        result.status === "fulfilled" && result.value.kind === "queued"
    ).length,
    10
  );
  assert.equal(
    results.filter(
      (result) =>
        result.status === "fulfilled" &&
        result.value.kind === "refused" &&
        result.value.reason === "tenant_queue_full"
    ).length,
    10
  );
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    0,
    "concurrent admissions must not surface persistence errors"
  );
  assert.equal(
    harness.sql
      .exec<{ state: string }>(
        "SELECT state FROM admission_records WHERE state = 'queued'"
      )
      .toArray().length,
    10
  );
});

test("concurrent same-operation admissions deduplicate or conflict deterministically", async () => {
  const harness = runAdmissionHarness(
    () => ({
      getRun: () => ({ status: "queued" }),
      startAdmitted: () => Promise.resolve(false),
      stop: () => Promise.resolve(null),
    }),
    {
      RUN_ADMISSION_TENANT_ACTIVE_MAX: "0",
      RUN_ADMISSION_TENANT_QUEUE_MAX: "10",
    }
  );
  const sameOperation = {
    ...request(200, TENANT_A, "same-request"),
    operationId: "operation-shared",
  };

  const sameHash = await Promise.allSettled(
    Array.from({ length: 20 }, (_unused, index) =>
      harness.admission.admit({
        ...sameOperation,
        runId: `run-shared-${index}`,
      })
    )
  );
  const fulfilledSameHash = sameHash.filter(
    (
      result
    ): result is PromiseFulfilledResult<
      Awaited<ReturnType<RunAdmission["admit"]>>
    > => result.status === "fulfilled"
  );
  assert.equal(
    sameHash.filter((result) => result.status === "rejected").length,
    0
  );
  assert.equal(
    new Set(
      fulfilledSameHash
        .map((result) => result.value)
        .filter((decision) => decision.kind !== "refused")
        .map((decision) => decision.runId)
    ).size,
    1
  );
  assert.equal(
    fulfilledSameHash.filter((result) => result.value.kind === "duplicate")
      .length,
    19
  );

  const conflicts = await Promise.allSettled(
    Array.from({ length: 20 }, (_unused, index) =>
      harness.admission.admit({
        ...sameOperation,
        requestHash: `different-${index}`,
        runId: `run-conflict-${index}`,
      })
    )
  );
  assert.equal(
    conflicts.filter(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof OperationConflictError
    ).length,
    20
  );
  assert.equal(
    conflicts.filter((result) => result.status === "fulfilled").length,
    0
  );
});

test("alarm setup failure terminalizes a new admission without dispatching it", async () => {
  let dispatches = 0;
  const setAlarmFailure: { error: Error | null } = {
    error: new Error("alarm unavailable"),
  };
  const harness = runAdmissionHarness(
    () => ({
      getRun: () => ({ status: "queued" }),
      startAdmitted: () => {
        dispatches += 1;
        return Promise.resolve(true);
      },
      stop: () => Promise.resolve(null),
    }),
    {
      RUN_ADMISSION_TENANT_ACTIVE_MAX: "0",
      RUN_ADMISSION_TENANT_QUEUE_MAX: "1",
    },
    { setAlarmFailure }
  );
  const first = request(220);

  await assert.rejects(
    () => harness.admission.admit(first),
    /alarm unavailable/
  );
  assert.equal(
    (await harness.admission.getRecord(first.runId))?.state,
    "terminal"
  );
  assert.equal(dispatches, 0);

  setAlarmFailure.error = null;
  const retry = await harness.admission.admit({
    ...first,
    runId: "run-retry",
  });
  assert.deepEqual(retry, {
    kind: "queued",
    position: 1,
    runId: "run-retry",
  });
});

test("release dispatches queued work even when alarm setup fails", async () => {
  const dispatched: string[] = [];
  const setAlarmFailure: { error: Error | null } = { error: null };
  const harness = runAdmissionHarness(
    () => ({
      getRun: () => ({ status: "queued" }),
      startAdmitted: (runId) => {
        dispatched.push(runId);
        return Promise.resolve(true);
      },
      stop: () => Promise.resolve(null),
    }),
    {
      RUN_ADMISSION_TENANT_ACTIVE_MAX: "1",
      RUN_ADMISSION_TENANT_QUEUE_MAX: "1",
    },
    { setAlarmFailure }
  );

  assert.deepEqual(await harness.admission.admit(request(221)), {
    kind: "active",
    runId: "run-221",
  });
  await Promise.all(harness.background);
  assert.deepEqual(await harness.admission.admit(request(222)), {
    kind: "queued",
    position: 1,
    runId: "run-222",
  });
  await Promise.all(harness.background);

  setAlarmFailure.error = new Error("alarm unavailable during release");
  harness.setAlarm(Date.now() - 1);
  await assert.rejects(
    () => harness.admission.release("run-221"),
    /alarm unavailable during release/
  );
  await Promise.all(harness.background);

  assert.deepEqual(dispatched, ["run-221", "run-222"]);
  assert.equal((await harness.admission.getRecord("run-222"))?.state, "active");
});

function yoloDefinition(): AgentDefinition {
  return {
    backend: "cloud",
    createdAt: "2026-08-20T12:00:00.000Z",
    description: "",
    id: "3f1a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90",
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

test("admission returns an immediate active decision without waiting for dispatch RPC", async () => {
  let resolveDispatch!: (accepted: boolean) => void;
  const dispatch = new Promise<boolean>((resolve) => {
    resolveDispatch = resolve;
  });
  const harness = runAdmissionHarness(() => ({
    getRun: () => null,
    startAdmitted: () => dispatch,
    stop: async () => null,
  }));

  const decision = await Promise.race([
    harness.admission.admit({
      ...request(30),
    }),
    new Promise<"timed_out">((resolve) =>
      setTimeout(() => resolve("timed_out"), 50)
    ),
  ]);

  assert.notEqual(
    decision,
    "timed_out",
    "the admission request must not be held open by agent dispatch"
  );
  assert.deepEqual(decision, { kind: "active", runId: "run-30" });

  resolveDispatch(true);
  await Promise.all(harness.background);
});

test("alarm reconciles a queued cancellation after its release callback fails", async () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-08-26T00:00:00.000Z");
  let admission!: RunAdmission;
  let releaseAttempts = 0;
  const yolo = new YoloAgent(
    undefined as never,
    {
      RunAdmission: {
        getByName: () => ({
          release: (runId: string) => {
            releaseAttempts += 1;
            if (releaseAttempts === 1) {
              return Promise.reject(new Error("admission unavailable"));
            }
            return admission.release(runId);
          },
        }),
      },
    } as never
  );
  yolo.configure(yoloDefinition());
  const harness = runAdmissionHarness(
    () => ({
      getRun: (runId) => yolo.getRun(runId),
      startAdmitted: (runId) => yolo.startAdmitted(runId),
      stop: (runId) => yolo.stop(runId),
    }),
    {
      RUN_ADMISSION_TENANT_ACTIVE_MAX: "0",
      RUN_ADMISSION_TENANT_QUEUE_MAX: "1",
    }
  );
  ({ admission } = harness);

  try {
    const queuedRequest = {
      ...request(39),
      operationId: "88888888-9999-4000-8111-222222222222",
      runId: "99999999-aaaa-4111-8222-333333333333",
    };
    await yolo.enqueue(
      { operationId: queuedRequest.operationId, task: "Queued work." },
      queuedRequest.runId,
      queuedRequest.requestHash,
      "identity"
    );
    const queued = await admission.admit(queuedRequest);
    assert.deepEqual(queued, {
      kind: "queued",
      position: 1,
      runId: queuedRequest.runId,
    });

    const stopped = await yolo.stop(queuedRequest.runId);
    assert.equal(stopped?.status, "cancelled");
    assert.equal(releaseAttempts, 1);
    assert.equal(
      (await admission.getRecord(queuedRequest.runId))?.state,
      "queued"
    );

    await admission.alarm();

    assert.equal(
      (await admission.getRecord(queuedRequest.runId))?.state,
      "terminal"
    );
    assert.deepEqual(await admission.admit(request(40)), {
      kind: "queued",
      position: 1,
      runId: "run-40",
    });
  } finally {
    Date.now = originalNow;
  }
});

test("alarm keeps its earlier cadence instead of postponing expiry", async () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-08-26T00:00:00.000Z");
  Date.now = () => now;
  try {
    const harness = runAdmissionHarness(() => ({
      getRun: () => ({ status: "queued" }),
      startAdmitted: async () => false,
      stop: async () => null,
    }));
    await harness.admission.admit(request(31));
    const firstAlarm = harness.alarm();
    assert.equal(firstAlarm, now + 30_000);

    now += 10_000;
    await harness.admission.dispatch();

    assert.equal(
      harness.alarm(),
      firstAlarm,
      "continuous lifecycle activity must not move an earlier alarm later"
    );
  } finally {
    Date.now = originalNow;
  }
});

test("failed cancellation leaves an expired queued record for alarm retry", async () => {
  let attempts = 0;
  const harness = runAdmissionHarness(() => ({
    getRun: () => ({ status: "queued" }),
    startAdmitted: () => Promise.resolve(false),
    stop: () => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(new Error("agent unavailable"));
      }
      return Promise.resolve({ status: "cancelled" });
    },
  }));
  await harness.admission.admit(request(32));
  harness.sql.exec(
    "UPDATE admission_records SET enqueued_at = ? WHERE run_id = ?",
    new Date(Date.now() - 5 * 60 * 1000 - 1).toISOString(),
    "run-32"
  );

  await harness.admission.alarm();
  assert.equal((await harness.admission.getRecord("run-32"))?.state, "queued");

  await harness.admission.alarm();
  assert.equal(
    (await harness.admission.getRecord("run-32"))?.state,
    "terminal"
  );
  assert.equal(attempts, 2);
});

test("alarm schedules a new retry after its prior alarm has fired", async () => {
  const originalNow = Date.now;
  const now = Date.parse("2026-08-26T00:00:00.000Z");
  Date.now = () => now;
  try {
    const harness = runAdmissionHarness(() => ({
      getRun: () => ({ status: "queued" }),
      startAdmitted: () => Promise.resolve(false),
      stop: () => Promise.reject(new Error("agent unavailable")),
    }));
    await harness.admission.admit(request(36));
    harness.sql.exec(
      "UPDATE admission_records SET enqueued_at = ? WHERE run_id = ?",
      new Date(now - 5 * 60 * 1000 - 1).toISOString(),
      "run-36"
    );
    harness.setAlarm(now - 1);

    await harness.admission.alarm();

    assert.equal(
      (await harness.admission.getRecord("run-36"))?.state,
      "queued"
    );
    assert.equal(
      harness.alarm(),
      now + 30_000,
      "a fired alarm must be replaced so cancellation can be retried"
    );
  } finally {
    Date.now = originalNow;
  }
});

test("missing active agent runs are reconciled so capacity is released", async () => {
  const harness = runAdmissionHarness(() => ({
    getRun: () => null,
    startAdmitted: async () => true,
    stop: async () => null,
  }));
  assert.deepEqual(await harness.admission.admit(request(33)), {
    kind: "active",
    runId: "run-33",
  });

  await harness.admission.alarm();

  assert.equal(
    (await harness.admission.getRecord("run-33"))?.state,
    "terminal"
  );
});

test("alarm repairs a missed terminal completion callback", async () => {
  let getRunCalls = 0;
  const harness = runAdmissionHarness(() => ({
    getRun: () => {
      getRunCalls += 1;
      return { status: "completed" };
    },
    startAdmitted: () => Promise.resolve(true),
    stop: () => Promise.resolve(null),
  }));
  assert.deepEqual(await harness.admission.admit(request(38)), {
    kind: "active",
    runId: "run-38",
  });

  await harness.admission.alarm();

  assert.equal(
    (await harness.admission.getRecord("run-38"))?.state,
    "terminal"
  );
  assert.ok(
    getRunCalls > 0,
    "alarm must inspect the agent after a missed callback"
  );
});

test("an interrupted dispatch clears its lease before the next alarm", async () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-08-26T00:00:00.000Z");
  let attempts = 0;
  Date.now = () => now;
  try {
    const harness = runAdmissionHarness(() => ({
      getRun: () => ({ status: "queued" }),
      startAdmitted: () => {
        attempts += 1;
        if (attempts === 1) {
          return Promise.reject(new Error("dispatch interrupted"));
        }
        return Promise.resolve(false);
      },
      stop: () => Promise.resolve(null),
    }));

    assert.deepEqual(await harness.admission.admit(request(34)), {
      kind: "active",
      runId: "run-34",
    });
    await Promise.all(harness.background);
    assert.equal(
      (await harness.admission.getRecord("run-34"))?.state,
      "queued",
      "an interrupted RPC must not strand its capacity claim"
    );

    now += 61_000;
    await harness.admission.alarm();

    assert.equal(
      (await harness.admission.getRecord("run-34"))?.state,
      "queued"
    );
    assert.ok(attempts >= 2, "the alarm must retry the interrupted dispatch");
  } finally {
    Date.now = originalNow;
  }
});

test("a queued dispatch still expires on its queue deadline", async () => {
  const originalNow = Date.now;
  const now = Date.parse("2026-08-26T00:00:00.000Z");
  let cancellations = 0;
  Date.now = () => now;
  try {
    const harness = runAdmissionHarness(() => ({
      getRun: () => ({ status: "queued" }),
      startAdmitted: () => Promise.reject(new Error("dispatch interrupted")),
      stop: () => {
        cancellations += 1;
        return Promise.reject(new Error("agent unavailable"));
      },
    }));
    assert.deepEqual(await harness.admission.admit(request(37)), {
      kind: "active",
      runId: "run-37",
    });
    await Promise.all(harness.background);
    harness.sql.exec(
      "UPDATE admission_records SET enqueued_at = ? WHERE run_id = ?",
      new Date(now - 5 * 60 * 1000 - 1).toISOString(),
      "run-37"
    );

    await harness.admission.alarm();

    assert.equal(
      (await harness.admission.getRecord("run-37"))?.state,
      "queued"
    );
    assert.equal(
      cancellations,
      1,
      "an active dispatch whose agent is still queued must enter expiry retry"
    );
  } finally {
    Date.now = originalNow;
  }
});

test("active admission is retained while the agent reports a genuinely running run", async () => {
  const harness = runAdmissionHarness(() => ({
    getRun: () => ({ status: "running" }),
    startAdmitted: () => Promise.resolve(true),
    stop: () => Promise.resolve(null),
  }));
  assert.deepEqual(await harness.admission.admit(request(35)), {
    kind: "active",
    runId: "run-35",
  });

  await harness.admission.alarm();

  assert.equal((await harness.admission.getRecord("run-35"))?.state, "active");
});

test("alarm failure is caught, retained durably, and repaired by a later lifecycle call", async () => {
  const now = Date.parse("2026-08-26T00:00:00.000Z");
  const originalNow = Date.now;
  Date.now = () => now;
  const setAlarmFailure: { error: Error | null } = { error: null };
  let dispatches = 0;
  try {
    const harness = runAdmissionHarness(
      () => ({
        getRun: (runId: string) =>
          runId === "run-50" ? { status: "running" } : { status: "queued" },
        startAdmitted: () => {
          dispatches += 1;
          return Promise.resolve(true);
        },
        stop: () => Promise.resolve(null),
      }),
      {
        RUN_ADMISSION_TENANT_ACTIVE_MAX: "1",
        RUN_ADMISSION_TENANT_QUEUE_MAX: "1",
      },
      { setAlarmFailure }
    );

    assert.deepEqual(await harness.admission.admit(request(50)), {
      kind: "active",
      runId: "run-50",
    });
    await Promise.all(harness.background);
    assert.deepEqual(await harness.admission.admit(request(51)), {
      kind: "queued",
      position: 1,
      runId: "run-51",
    });
    await Promise.all(harness.background);

    setAlarmFailure.error = new Error("alarm unavailable");
    harness.setAlarm(now - 1);
    await harness.admission.alarm();
    assert.equal(
      (await harness.admission.getRecord("run-51"))?.state,
      "queued"
    );

    setAlarmFailure.error = null;
    await harness.admission.release("run-50");
    await Promise.all(harness.background);

    assert.equal(
      (await harness.admission.getRecord("run-51"))?.state,
      "active"
    );
    assert.equal(dispatches, 2);
    assert.equal(harness.alarm(), now + 30_000);
  } finally {
    Date.now = originalNow;
  }
});

test("alarm retry exhaustion closes queued admission and refuses new work", async () => {
  let stopped = 0;
  const setAlarmFailure: { error: Error | null } = {
    error: new Error("alarm permanently unavailable"),
  };
  const harness = runAdmissionHarness(
    () => ({
      getRun: () => ({ status: "queued" }),
      startAdmitted: () => Promise.resolve(false),
      stop: () => {
        stopped += 1;
        return Promise.resolve({ status: "cancelled" });
      },
    }),
    {
      RUN_ADMISSION_TENANT_ACTIVE_MAX: "0",
      RUN_ADMISSION_TENANT_QUEUE_MAX: "1",
    },
    { setAlarmFailure }
  );

  setAlarmFailure.error = null;
  assert.deepEqual(await harness.admission.admit(request(52)), {
    kind: "queued",
    position: 1,
    runId: "run-52",
  });
  await Promise.all(harness.background);
  setAlarmFailure.error = new Error("alarm permanently unavailable");
  harness.setAlarm(Date.now() - 1);

  await harness.admission.alarm();
  await harness.admission.alarm();
  await harness.admission.alarm();

  assert.equal(
    (await harness.admission.getRecord("run-52"))?.state,
    "terminal"
  );
  assert.equal(stopped, 1);
  await assert.rejects(
    () => harness.admission.admit(request(53)),
    (error: unknown) =>
      error instanceof AdmissionUnavailableError &&
      error.message.includes("alarm permanently unavailable")
  );
});

test("dispatch failure clears its lease before alarm failure can leak capacity", async () => {
  const setAlarmFailure: { error: Error | null } = { error: null };
  const harness = runAdmissionHarness(
    () => ({
      getRun: () => ({ status: "queued" }),
      startAdmitted: (runId: string) =>
        runId === "run-55"
          ? Promise.reject(new Error("dispatch unavailable"))
          : Promise.resolve(true),
      stop: () => Promise.resolve({ status: "cancelled" }),
    }),
    {
      RUN_ADMISSION_TENANT_ACTIVE_MAX: "1",
      RUN_ADMISSION_TENANT_QUEUE_MAX: "1",
    },
    { setAlarmFailure }
  );

  assert.deepEqual(await harness.admission.admit(request(54)), {
    kind: "active",
    runId: "run-54",
  });
  await Promise.all(harness.background);
  assert.deepEqual(await harness.admission.admit(request(55)), {
    kind: "queued",
    position: 1,
    runId: "run-55",
  });
  await Promise.all(harness.background);

  setAlarmFailure.error = new Error("alarm unavailable after dispatch");
  harness.setAlarm(Date.now() - 1);
  await assert.rejects(
    () => harness.admission.release("run-54"),
    /alarm unavailable after dispatch/
  );
  await Promise.all(harness.background);

  assert.equal(
    (await harness.admission.getRecord("run-55"))?.state,
    "terminal"
  );
  const leaseRows = harness.sql
    .exec<{ dispatch_lease_until: string | null }>(
      "SELECT dispatch_lease_until FROM admission_records WHERE run_id = ?",
      "run-55"
    )
    .toArray() as { dispatch_lease_until: string | null }[];
  assert.equal(leaseRows[0]?.dispatch_lease_until, null);
});

test("same-millisecond admissions use insertion sequence for positions and fairness", () => {
  const now = Date.parse("2026-08-26T00:00:00.000Z");
  const queue = new AdmissionQueue({
    limits: {
      deploymentActiveRuns: 3,
      tenantActiveRuns: 1,
      tenantQueuedRuns: 3,
    },
    now: () => now,
    records: [
      {
        ...request(61, TENANT_A),
        enqueuedAt: new Date(now).toISOString(),
        state: "queued",
      },
      {
        ...request(62, TENANT_B),
        enqueuedAt: new Date(now).toISOString(),
        state: "queued",
      },
    ],
  });

  assert.equal(queue.nextDispatchCandidate()?.runId, "run-61");
  assert.equal(queue.nextDispatchCandidate()?.runId, "run-62");
  assert.deepEqual(
    queue
      .records()
      .filter((record) => record.state === "queued")
      .map((record) => record.runId),
    []
  );
});

test("durable queue sequence keeps same-millisecond positions in insertion order", async () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-08-26T00:00:00.000Z");
  try {
    const harness = runAdmissionHarness(
      () => ({
        getRun: () => ({ status: "queued" }),
        startAdmitted: () => Promise.resolve(false),
        stop: () => Promise.resolve(null),
      }),
      {
        RUN_ADMISSION_TENANT_ACTIVE_MAX: "0",
        RUN_ADMISSION_TENANT_QUEUE_MAX: "3",
      }
    );

    assert.deepEqual(await harness.admission.admit(request(63)), {
      kind: "queued",
      position: 1,
      runId: "run-63",
    });
    assert.deepEqual(await harness.admission.admit(request(64)), {
      kind: "queued",
      position: 2,
      runId: "run-64",
    });
    assert.deepEqual(await harness.admission.admit(request(65)), {
      kind: "queued",
      position: 3,
      runId: "run-65",
    });

    const sequenceRows = harness.sql
      .exec<{ run_id: string; queue_sequence: number }>(
        "SELECT run_id, queue_sequence FROM admission_records ORDER BY queue_sequence"
      )
      .toArray() as { run_id: string; queue_sequence: number }[];
    assert.deepEqual(
      sequenceRows.map((row) => row.run_id),
      ["run-63", "run-64", "run-65"]
    );
    assert.deepEqual(
      sequenceRows.map((row) => row.queue_sequence),
      [1, 2, 3]
    );
  } finally {
    Date.now = originalNow;
  }
});
