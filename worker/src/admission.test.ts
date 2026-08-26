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
    fenceAdmitted?: (runId: string, dispatchToken: string) => Promise<boolean>;
    getRun: (runId: string) => unknown;
    startAdmitted: (runId: string, dispatchToken?: string) => Promise<boolean>;
    stop: (
      runId: string,
      dispatchToken?: string,
      reason?: string
    ) => Promise<unknown>;
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

function seedAdmissionRecord(
  harness: ReturnType<typeof runAdmissionHarness>,
  record: AdmissionRecord,
  sequence: number
): void {
  harness.sql.exec(
    `
      INSERT INTO admission_records
        (agent_id, enqueued_at, operation_id, request_hash, run_id,
         queue_sequence, state, tenant_hash, dispatch_started_at,
         dispatch_lease_until, dispatch_token, terminalized_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)
    `,
    record.agentId,
    record.enqueuedAt,
    record.operationId,
    record.requestHash,
    record.runId,
    sequence,
    record.state,
    record.tenantHash
  );
}

test("alarm reconciliation does not requeue a nonexpired dispatch lease", async () => {
  let now = Date.parse("2026-08-26T00:00:00.000Z");
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    let dispatchCalls = 0;
    let resolveFirst!: (accepted: boolean) => void;
    let resolveSecond!: (accepted: boolean) => void;
    const firstDispatch = new Promise<boolean>((resolve) => {
      resolveFirst = resolve;
    });

    const secondDispatch = new Promise<boolean>((resolve) => {
      resolveSecond = resolve;
    });
    const harness = runAdmissionHarness(() => ({
      fenceAdmitted: () => Promise.resolve(true),
      getRun: () => ({ status: "queued" }),
      startAdmitted: () => {
        dispatchCalls += 1;
        return dispatchCalls === 1 ? firstDispatch : secondDispatch;
      },
      stop: () => Promise.resolve(null),
    }));

    await harness.admission.admit(request(61));
    await new Promise<void>((resolve) => setImmediate(resolve));
    now += 30_000;
    await harness.admission.alarm();

    const rows = harness.sql
      .exec<{ state: string; dispatch_lease_until: number | null }>(
        "SELECT state, dispatch_lease_until FROM admission_records WHERE run_id = ?",
        "run-61"
      )
      .toArray() as { state: string; dispatch_lease_until: number | null }[];
    assert.equal(dispatchCalls, 1);
    assert.equal(rows[0]?.state, "active");
    assert.ok(Date.parse(String(rows[0]?.dispatch_lease_until ?? "")) > now);

    now += 31_000;
    const alarm = harness.admission.alarm();
    while (dispatchCalls < 2) {
      // biome-ignore lint/performance/noAwaitInLoops: This deterministic wait observes alarm dispatch completion.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const secondLease = harness.sql
      .exec<{ dispatch_lease_until: string | null }>(
        "SELECT dispatch_lease_until FROM admission_records WHERE run_id = ?",
        "run-61"
      )
      .toArray() as { dispatch_lease_until: string | null }[];
    assert.ok(Date.parse(String(secondLease[0]?.dispatch_lease_until)) > now);
    resolveFirst(true);
    await Promise.all(harness.background);
    assert.equal(
      (
        harness.sql
          .exec<{ dispatch_lease_until: string | null }>(
            "SELECT dispatch_lease_until FROM admission_records WHERE run_id = ?",
            "run-61"
          )
          .toArray() as { dispatch_lease_until: string | null }[]
      )[0]?.dispatch_lease_until,
      secondLease[0]?.dispatch_lease_until
    );
    resolveSecond(true);
    await alarm;
  } finally {
    Date.now = originalNow;
  }
});

test("dispatch fencing tokens reach the agent and stale completion cannot release a newer claim", async () => {
  const fencingOriginalNow = Date.now;
  let fencingNow = Date.parse("2026-08-26T00:00:00.000Z");
  Date.now = () => fencingNow;
  try {
    const dispatchedTokens: string[] = [];
    const harness = runAdmissionHarness(() => ({
      fenceAdmitted: () => Promise.resolve(true),
      getRun: () => ({ status: "queued" }),
      startAdmitted: (_runId, dispatchToken) => {
        dispatchedTokens.push(dispatchToken ?? "");
        return Promise.resolve(true);
      },
      stop: () => Promise.resolve(null),
    }));

    assert.deepEqual(await harness.admission.admit(request(68)), {
      kind: "active",
      runId: "run-68",
    });
    await Promise.all(harness.background);

    const firstToken = (
      harness.sql
        .exec<{ dispatch_token: string | null }>(
          "SELECT dispatch_token FROM admission_records WHERE run_id = ?",
          "run-68"
        )
        .toArray() as { dispatch_token: string | null }[]
    )[0]?.dispatch_token;
    assert.ok(firstToken);
    assert.equal(
      dispatchedTokens[0],
      firstToken,
      "the first dispatch must carry its persisted fencing token"
    );

    fencingNow += 61_000;
    await harness.admission.alarm();

    const secondToken = (
      harness.sql
        .exec<{ dispatch_token: string | null }>(
          "SELECT dispatch_token FROM admission_records WHERE run_id = ?",
          "run-68"
        )
        .toArray() as { dispatch_token: string | null }[]
    )[0]?.dispatch_token;
    assert.equal(dispatchedTokens.length, 2);
    assert.ok(secondToken);
    assert.notEqual(secondToken, firstToken);

    assert.equal(
      await harness.admission.release("run-68", firstToken),
      false,
      "a stale completion must not release the newer admission claim"
    );
    assert.equal(
      (await harness.admission.getRecord("run-68"))?.state,
      "active"
    );
    assert.equal(await harness.admission.release("run-68", secondToken), true);
  } finally {
    Date.now = fencingOriginalNow;
  }
});

test("expired dispatch fencing rejects delayed A before re-dispatching B", async () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-08-26T00:00:00.000Z");
  Date.now = () => now;
  try {
    let resolveDelayedA!: (accepted: boolean) => void;
    const delayedA = new Promise<boolean>((resolve) => {
      resolveDelayedA = resolve;
    });
    const dispatchTokens: string[] = [];
    const fencedTokens: string[] = [];
    const accepted: boolean[] = [];
    let starts = 0;
    const harness = runAdmissionHarness(
      () => ({
        fenceAdmitted: (_runId, dispatchToken) => {
          fencedTokens.push(dispatchToken);
          return Promise.resolve(true);
        },
        getRun: () => ({ status: "queued" }),
        startAdmitted: (_runId, dispatchToken) => {
          dispatchTokens.push(dispatchToken ?? "");
          if (dispatchTokens.length === 1) {
            return delayedA.then((result) => {
              accepted.push(result);
              return result;
            });
          }
          starts += 1;
          accepted.push(true);
          return Promise.resolve(true);
        },
        stop: () => Promise.resolve(null),
      }),
      {
        RUN_ADMISSION_TENANT_ACTIVE_MAX: "1",
        RUN_ADMISSION_TENANT_QUEUE_MAX: "1",
      }
    );

    assert.deepEqual(await harness.admission.admit(request(73)), {
      kind: "active",
      runId: "run-73",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(await harness.admission.admit(request(74)), {
      kind: "queued",
      position: 1,
      runId: "run-74",
    });

    now += 61_000;
    await harness.admission.alarm();

    assert.equal(dispatchTokens.length, 2);
    assert.ok(dispatchTokens[0]);
    assert.ok(dispatchTokens[1]);
    assert.notEqual(dispatchTokens[0], dispatchTokens[1]);
    assert.ok(
      Number(dispatchTokens[1]?.split(":", 1)[0]) >
        Number(dispatchTokens[0]?.split(":", 1)[0]),
      "each re-dispatch must advance its durable generation"
    );
    assert.deepEqual(fencedTokens, [dispatchTokens[0]]);
    assert.equal(starts, 1, "token B starts exactly once");

    resolveDelayedA(false);
    await Promise.all(harness.background);

    assert.deepEqual(accepted, [true, false]);
    assert.equal(
      (await harness.admission.getRecord("run-73"))?.state,
      "terminal"
    );
    assert.equal(
      (await harness.admission.getRecord("run-74"))?.state,
      "active"
    );
  } finally {
    Date.now = originalNow;
  }
});

test("an expired tokenless admission gets a compatibility fence before requeue", async () => {
  const originalNow = Date.now;
  const now = Date.parse("2026-08-26T00:00:00.000Z");
  Date.now = () => now;
  try {
    const fencedTokens: string[] = [];
    const dispatchTokens: (string | undefined)[] = [];
    let dispatches = 0;
    const harness = runAdmissionHarness(
      () => ({
        fenceAdmitted: (_runId, dispatchToken) => {
          fencedTokens.push(dispatchToken);
          return Promise.resolve(true);
        },
        getRun: () => ({ status: "queued" }),
        startAdmitted: (_runId, dispatchToken) => {
          dispatches += 1;
          dispatchTokens.push(dispatchToken);
          return Promise.resolve(dispatches === 1);
        },
        stop: () => Promise.resolve(null),
      }),
      {
        RUN_ADMISSION_TENANT_ACTIVE_MAX: "1",
        RUN_ADMISSION_TENANT_QUEUE_MAX: "1",
      }
    );

    assert.deepEqual(await harness.admission.admit(request(77)), {
      kind: "active",
      runId: "run-77",
    });
    await Promise.all(harness.background);
    harness.sql.exec(
      `
        UPDATE admission_records
        SET dispatch_token = NULL,
            dispatch_lease_until = ?
        WHERE run_id = ?
      `,
      new Date(now - 1).toISOString(),
      "run-77"
    );

    await harness.admission.alarm();

    assert.equal(fencedTokens.length, 2);
    assert.match(fencedTokens[0] ?? "", /^[2-9]\d*:compat-/u);
    assert.ok(dispatchTokens[0]);
    assert.ok(dispatchTokens[1]);
    assert.notEqual(dispatchTokens[0], dispatchTokens[1]);
    assert.equal(
      dispatches,
      2,
      "recovery must issue only one replacement dispatch"
    );
    assert.equal(
      (await harness.admission.getRecord("run-77"))?.state,
      "queued"
    );
  } finally {
    Date.now = originalNow;
  }
});

test("a fence that loses to A starting retains the active claim and does not issue B", async () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-08-26T00:00:00.000Z");
  Date.now = () => now;
  try {
    const dispatchTokens: string[] = [];
    const fencedTokens: string[] = [];
    const harness = runAdmissionHarness(
      () => ({
        fenceAdmitted: (_runId, dispatchToken) => {
          fencedTokens.push(dispatchToken);
          return Promise.resolve(false);
        },
        getRun: () => ({ status: "queued" }),
        startAdmitted: (_runId, dispatchToken) => {
          dispatchTokens.push(dispatchToken ?? "");
          return Promise.reject(new Error("A started before the fence"));
        },
        stop: () => Promise.resolve(null),
      }),
      {
        RUN_ADMISSION_TENANT_ACTIVE_MAX: "1",
        RUN_ADMISSION_TENANT_QUEUE_MAX: "1",
      }
    );

    assert.deepEqual(await harness.admission.admit(request(75)), {
      kind: "active",
      runId: "run-75",
    });
    await Promise.all(harness.background);
    assert.deepEqual(await harness.admission.admit(request(76)), {
      kind: "queued",
      position: 1,
      runId: "run-76",
    });

    now += 61_000;
    await harness.admission.alarm();

    assert.equal(fencedTokens.length, 1);
    assert.equal(dispatchTokens.length, 1, "B must not be issued");
    assert.equal(
      (await harness.admission.getRecord("run-75"))?.state,
      "active"
    );
    assert.equal(
      (await harness.admission.getRecord("run-76"))?.state,
      "queued"
    );
  } finally {
    Date.now = originalNow;
  }
});

test("expired queued cleanup is enqueued even when an obsolete dispatch token remains", async () => {
  const cleanupOriginalNow = Date.now;
  const cleanupNow = Date.parse("2026-08-26T00:00:00.000Z");
  Date.now = () => cleanupNow;
  try {
    let cancellationAttempts = 0;
    const cancellationTokens: (string | undefined)[] = [];
    const harness = runAdmissionHarness(
      () => ({
        getRun: () => ({ status: "queued" }),
        startAdmitted: () => Promise.resolve(false),
        stop: (_runId, dispatchToken) => {
          cancellationTokens.push(dispatchToken);
          cancellationAttempts += 1;
          if (cancellationAttempts < 3) {
            return Promise.reject(new Error("agent unavailable"));
          }
          return Promise.resolve({ status: "cancelled" });
        },
      }),
      {
        RUN_ADMISSION_TENANT_ACTIVE_MAX: "0",
        RUN_ADMISSION_TENANT_QUEUE_MAX: "1",
      }
    );

    await harness.admission.admit(request(69));
    harness.sql.exec(
      "UPDATE admission_records SET state = 'queued', dispatch_token = ?, enqueued_at = ? WHERE run_id = ?",
      "obsolete-token",
      new Date(cleanupNow - 5 * 60 * 1000 - 1).toISOString(),
      "run-69"
    );

    await harness.admission.alarm();

    assert.equal(
      (await harness.admission.getRecord("run-69"))?.state,
      "terminal"
    );
    assert.equal(
      (
        harness.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM admission_cleanup_tasks WHERE run_id = ?",
            "run-69"
          )
          .toArray() as { count: number }[]
      )[0]?.count,
      1,
      "a failed cancellation must leave a durable cleanup retry"
    );
    assert.deepEqual(cancellationTokens, ["obsolete-token", undefined]);

    harness.sql.exec("UPDATE admission_cleanup_tasks SET next_attempt_at = 0");
    await harness.admission.alarm();
    assert.equal(cancellationAttempts, 3);
    assert.equal(
      (
        harness.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM admission_cleanup_tasks WHERE run_id = ?",
            "run-69"
          )
          .toArray() as { count: number }[]
      )[0]?.count,
      0
    );
  } finally {
    Date.now = cleanupOriginalNow;
  }
});

test("terminal admission retention matches the agent's per-agent run history", async () => {
  const sameAgent = "agent-retention";
  const harness = runAdmissionHarness(
    () => ({
      getRun: () => ({ status: "queued" }),
      startAdmitted: () => Promise.resolve(true),
      stop: () => Promise.resolve(null),
    }),
    { RUN_ADMISSION_TENANT_ACTIVE_MAX: "1" }
  );

  const first = {
    ...request(300),
    agentId: sameAgent,
  };
  for (let index = 0; index < 21; index += 1) {
    const operation = {
      ...request(300 + index),
      agentId: sameAgent,
    };
    // biome-ignore lint/performance/noAwaitInLoops: Each admission must be terminalized before retention is checked.
    const decision = await harness.admission.admit(operation);
    assert.equal(decision.kind, "active");
    await Promise.all(harness.background);
    await harness.admission.release(operation.runId);
  }

  const terminalRows = harness.sql
    .exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM admission_records WHERE state = 'terminal' AND agent_id = ?",
      sameAgent
    )
    .toArray() as { count: number }[];
  assert.ok((terminalRows[0]?.count ?? 0) <= 20);

  const replay = await harness.admission.admit({
    ...first,
    runId: "run-retention-replay",
  });
  assert.notEqual(
    replay.kind,
    "duplicate",
    "a replay after both histories expire must be admitted as fresh work"
  );
});

test("zero queue capacity admits immediately when an active slot is free", async () => {
  const harness = runAdmissionHarness(
    () => ({
      getRun: () => ({ status: "queued" }),
      startAdmitted: () => Promise.resolve(true),
      stop: () => Promise.resolve(null),
    }),
    {
      RUN_ADMISSION_TENANT_ACTIVE_MAX: "1",
      RUN_ADMISSION_TENANT_QUEUE_MAX: "0",
    }
  );

  const decision = await harness.admission.admit(request(62));

  assert.equal(decision.kind, "active");
  await Promise.all(harness.background);
});

test("zero queue capacity refuses when deployment capacity is full", async () => {
  const harness = runAdmissionHarness(
    () => ({
      getRun: () => ({ status: "running" }),
      startAdmitted: () => Promise.resolve(true),
      stop: () => Promise.resolve(null),
    }),
    {
      RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX: "1",
      RUN_ADMISSION_TENANT_ACTIVE_MAX: "1",
      RUN_ADMISSION_TENANT_QUEUE_MAX: "0",
    }
  );
  await harness.admission.getRecord("initialize");
  seedAdmissionRecord(harness, activeRecord(1), 1);

  assert.deepEqual(await harness.admission.admit(request(2, TENANT_B)), {
    kind: "refused",
    reason: "global_busy",
  });
});

test("a full deployment refuses even when the tenant queue is at its cap", async () => {
  const harness = runAdmissionHarness(
    () => ({
      getRun: () => ({ status: "queued" }),
      startAdmitted: () => Promise.resolve(false),
      stop: () => Promise.resolve(null),
    }),
    {
      RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX: "1",
      RUN_ADMISSION_TENANT_ACTIVE_MAX: "1",
      RUN_ADMISSION_TENANT_QUEUE_MAX: "10",
    }
  );
  await harness.admission.getRecord("initialize");
  seedAdmissionRecord(harness, activeRecord(1), 1);
  for (let index = 2; index <= 11; index += 1) {
    seedAdmissionRecord(
      harness,
      {
        ...request(index),
        enqueuedAt: new Date(Date.now() - (12 - index) * 1000).toISOString(),
        state: "queued",
      },
      index
    );
  }

  assert.deepEqual(await harness.admission.admit(request(12)), {
    kind: "refused",
    reason: "global_busy",
  });
  assert.equal(
    (
      harness.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM admission_records WHERE state = 'queued' AND tenant_hash = ?",
          TENANT_A
        )
        .toArray() as { count: number }[]
    )[0]?.count,
    10
  );
});

test("fairness applies the queue cap instead of bypassing a waiting tenant", async () => {
  const harness = runAdmissionHarness(
    () => ({
      getRun: () => ({ status: "queued" }),
      startAdmitted: () => Promise.resolve(true),
      stop: () => Promise.resolve(null),
    }),
    {
      RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX: "2",
      RUN_ADMISSION_TENANT_ACTIVE_MAX: "2",
      RUN_ADMISSION_TENANT_QUEUE_MAX: "10",
    }
  );
  await harness.admission.getRecord("initialize");
  seedAdmissionRecord(harness, activeRecord(1, TENANT_A), 1);
  for (let index = 2; index <= 11; index += 1) {
    seedAdmissionRecord(
      harness,
      {
        ...request(index, TENANT_A),
        enqueuedAt: new Date(Date.now() - (12 - index) * 1000).toISOString(),
        state: "queued",
      },
      index
    );
  }

  assert.deepEqual(await harness.admission.admit(request(12, TENANT_A)), {
    kind: "refused",
    reason: "tenant_queue_full",
  });
  assert.equal(
    (
      harness.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM admission_records WHERE state = 'queued'"
        )
        .toArray() as { count: number }[]
    )[0]?.count,
    10
  );
});

test("a delayed dispatch cannot create a transient eleventh queued record", async () => {
  let resolveDispatch!: (accepted: boolean) => void;
  const dispatch = new Promise<boolean>((resolve) => {
    resolveDispatch = resolve;
  });
  const harness = runAdmissionHarness(
    () => ({
      getRun: () => ({ status: "queued" }),
      startAdmitted: () => dispatch,
      stop: () => Promise.resolve(null),
    }),
    {
      RUN_ADMISSION_TENANT_ACTIVE_MAX: "1",
      RUN_ADMISSION_TENANT_QUEUE_MAX: "10",
    }
  );

  assert.deepEqual(await harness.admission.admit(request(400)), {
    kind: "active",
    runId: "run-400",
  });
  for (let index = 401; index <= 410; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: Build the full bounded queue deterministically.
    assert.deepEqual(await harness.admission.admit(request(index)), {
      kind: "queued",
      position: index - 400,
      runId: `run-${index}`,
    });
  }

  const refusals = await Promise.all(
    Array.from({ length: 8 }, (_unused, index) =>
      harness.admission.admit(request(500 + index))
    )
  );
  assert.equal(
    refusals.filter(
      (decision) =>
        decision.kind === "refused" && decision.reason === "tenant_queue_full"
    ).length,
    8
  );
  assert.equal(
    (
      harness.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM admission_records WHERE state = 'queued' AND tenant_hash = ?",
          TENANT_A
        )
        .toArray() as { count: number }[]
    )[0]?.count,
    10
  );

  resolveDispatch(true);
  await Promise.all(harness.background);
});

test("a proven-not-started dispatch is terminalized instead of exceeding the queue cap", async () => {
  const stopped: string[] = [];
  const fenced: string[] = [];
  const harness = runAdmissionHarness(
    () => ({
      fenceAdmitted: (runId, token) => {
        fenced.push(`${runId}:${token}`);
        return Promise.resolve(true);
      },
      getRun: (runId) =>
        runId === "run-3" ? { status: "queued" } : { status: "running" },
      startAdmitted: () => Promise.resolve(true),
      stop: (runId) => {
        stopped.push(runId);
        return Promise.resolve({ status: "cancelled" });
      },
    }),
    {
      RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX: "3",
      RUN_ADMISSION_TENANT_ACTIVE_MAX: "2",
      RUN_ADMISSION_TENANT_QUEUE_MAX: "10",
    }
  );
  await harness.admission.getRecord("initialize");
  seedAdmissionRecord(
    harness,
    { ...activeRecord(1), enqueuedAt: new Date(Date.now()).toISOString() },
    1
  );
  seedAdmissionRecord(
    harness,
    { ...activeRecord(2), enqueuedAt: new Date(Date.now()).toISOString() },
    2
  );
  seedAdmissionRecord(
    harness,
    { ...activeRecord(3), enqueuedAt: new Date(Date.now()).toISOString() },
    3
  );
  for (let index = 4; index <= 13; index += 1) {
    seedAdmissionRecord(
      harness,
      {
        ...request(index),
        enqueuedAt: new Date(Date.now()).toISOString(),
        state: "queued",
      },
      index
    );
  }
  harness.sql.exec(
    `
      UPDATE admission_records
      SET state = 'active',
          dispatch_lease_until = ?,
          dispatch_token = ?
      WHERE run_id = ?
    `,
    new Date(Date.now() - 1).toISOString(),
    "dispatch-run-3",
    "run-3"
  );

  await harness.admission.alarm();
  await Promise.all(harness.background);

  assert.deepEqual(fenced.length, 1);
  assert.deepEqual(stopped, ["run-3"]);
  assert.equal(
    (
      harness.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM admission_records WHERE state = 'queued' AND tenant_hash = ?",
          TENANT_A
        )
        .toArray() as { count: number }[]
    )[0]?.count,
    10
  );
  assert.equal((await harness.admission.getRecord("run-3"))?.state, "terminal");
});

test("a zero-capacity dispatch failure terminalizes the local run", async () => {
  const stopped: string[] = [];
  const stopReasons: string[] = [];
  const harness = runAdmissionHarness(
    () => ({
      fenceAdmitted: () => Promise.resolve(true),
      getRun: () => ({ status: "queued" }),
      startAdmitted: () => Promise.resolve(false),
      stop: (runId, _dispatchToken, reason) => {
        stopped.push(runId);
        if (reason) {
          stopReasons.push(reason);
        }
        return Promise.resolve({ status: "cancelled" });
      },
    }),
    {
      RUN_ADMISSION_TENANT_ACTIVE_MAX: "1",
      RUN_ADMISSION_TENANT_QUEUE_MAX: "0",
    }
  );

  assert.deepEqual(await harness.admission.admit(request(411)), {
    kind: "active",
    runId: "run-411",
  });
  await Promise.all(harness.background);

  assert.deepEqual(stopped, ["run-411"]);
  assert.deepEqual(stopReasons, [
    "Run refused because the tenant queue is full.",
  ]);
  assert.equal(
    (await harness.admission.getRecord("run-411"))?.state,
    "terminal"
  );
  assert.equal(
    (
      harness.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM admission_records WHERE state = 'queued'"
        )
        .toArray() as { count: number }[]
    )[0]?.count,
    0
  );
});

test("concurrent proven-not-started failures each honor their tenant queue cap", async () => {
  const stopped: string[] = [];
  const harness = runAdmissionHarness(
    () => ({
      fenceAdmitted: () => Promise.resolve(true),
      getRun: (runId) =>
        runId === "run-20" || runId === "run-22"
          ? { status: "running" }
          : { status: "queued" },
      startAdmitted: () => Promise.resolve(false),
      stop: (runId) => {
        stopped.push(runId);
        return Promise.resolve({ status: "cancelled" });
      },
    }),
    {
      RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX: "4",
      RUN_ADMISSION_TENANT_ACTIVE_MAX: "2",
      RUN_ADMISSION_TENANT_QUEUE_MAX: "1",
    }
  );
  await harness.admission.getRecord("initialize");
  for (const [index, tenantHash, sequence] of [
    [20, TENANT_A, 1],
    [24, TENANT_A, 2],
    [22, TENANT_B, 4],
    [25, TENANT_B, 5],
  ] as const) {
    seedAdmissionRecord(
      harness,
      {
        ...activeRecord(index, tenantHash),
        enqueuedAt: new Date(Date.now()).toISOString(),
      },
      sequence
    );
  }
  seedAdmissionRecord(
    harness,
    {
      ...request(26, TENANT_A),
      enqueuedAt: new Date(Date.now()).toISOString(),
      state: "queued",
    },
    3
  );
  seedAdmissionRecord(
    harness,
    {
      ...request(27, TENANT_B),
      enqueuedAt: new Date(Date.now()).toISOString(),
      state: "queued",
    },
    6
  );
  harness.sql.exec(
    `
      UPDATE admission_records
      SET dispatch_lease_until = ?, dispatch_token = ?
      WHERE run_id = ?
    `,
    new Date(Date.now() - 1).toISOString(),
    "dispatch-run-24",
    "run-24"
  );
  harness.sql.exec(
    `
      UPDATE admission_records
      SET dispatch_lease_until = ?, dispatch_token = ?
      WHERE run_id = ?
    `,
    new Date(Date.now() - 1).toISOString(),
    "dispatch-run-25",
    "run-25"
  );

  await Promise.all([harness.admission.alarm(), harness.admission.alarm()]);
  await Promise.all(harness.background);

  assert.ok(stopped.includes("run-24"));
  assert.ok(stopped.includes("run-25"));
  for (const tenantHash of [TENANT_A, TENANT_B]) {
    assert.equal(
      (
        harness.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM admission_records WHERE state = 'queued' AND tenant_hash = ?",
            tenantHash
          )
          .toArray() as { count: number }[]
      )[0]?.count,
      1
    );
  }
});

test("admission reconciles expired queued tombstones before applying a new cap", async () => {
  const now = Date.parse("2026-08-26T00:00:00.000Z");
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const harness = runAdmissionHarness(
      () => ({
        getRun: () => ({ status: "queued" }),
        startAdmitted: () => Promise.resolve(false),
        stop: () => Promise.reject(new Error("cleanup outage")),
      }),
      {
        RUN_ADMISSION_TENANT_ACTIVE_MAX: "0",
        RUN_ADMISSION_TENANT_QUEUE_MAX: "10",
      }
    );
    await harness.admission.getRecord("initialize");
    for (let index = 0; index < 10; index += 1) {
      seedAdmissionRecord(
        harness,
        {
          ...request(430 + index),
          enqueuedAt: new Date(now - 5 * 60 * 1000 - 1).toISOString(),
          state: "queued",
        },
        index + 1
      );
    }

    assert.deepEqual(await harness.admission.admit(request(440)), {
      kind: "queued",
      position: 1,
      runId: "run-440",
    });
    await Promise.all(harness.background);

    assert.equal(
      (
        harness.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM admission_records WHERE state = 'queued' AND tenant_hash = ?",
            TENANT_A
          )
          .toArray() as { count: number }[]
      )[0]?.count,
      1
    );
    assert.equal(
      (
        harness.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM admission_records WHERE state = 'terminal' AND tenant_hash = ?",
            TENANT_A
          )
          .toArray() as { count: number }[]
      )[0]?.count,
      10
    );
    assert.equal(
      (
        harness.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM admission_cleanup_tasks"
          )
          .toArray() as { count: number }[]
      )[0]?.count,
      10,
      "cleanup tombstones remain durable during an agent outage"
    );
  } finally {
    Date.now = originalNow;
  }
});

test("durable dispatch fairness gives tenant B a slot before tenant A's third turn", async () => {
  const originalNow = Date.now;
  const now = Date.parse("2026-08-26T00:00:00.000Z");
  Date.now = () => now;
  try {
    const dispatched: string[] = [];
    const tenantByRun = new Map<string, string>();
    const harness = runAdmissionHarness(
      () => ({
        getRun: () => ({ status: "queued" }),
        startAdmitted: (runId) => {
          dispatched.push(tenantByRun.get(runId) ?? "unknown");
          return Promise.resolve(true);
        },
        stop: () => Promise.resolve(null),
      }),
      {
        RUN_ADMISSION_CONSECUTIVE_MAX: "2",
        RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX: "3",
        RUN_ADMISSION_TENANT_ACTIVE_MAX: "2",
        RUN_ADMISSION_TENANT_QUEUE_MAX: "10",
      }
    );
    await harness.admission.getRecord("initialize");
    for (const [index, tenantHash, state] of [
      [450, TENANT_A, "active"],
      [451, TENANT_A, "active"],
      [452, TENANT_A, "queued"],
      [453, TENANT_B, "queued"],
    ] as const) {
      const current = request(index, tenantHash);
      tenantByRun.set(current.runId, tenantHash);
      seedAdmissionRecord(
        harness,
        {
          ...current,
          enqueuedAt: new Date(now).toISOString(),
          state,
        },
        index - 449
      );
    }
    harness.sql.exec(
      "INSERT INTO admission_meta (key, value) VALUES ('last_tenant_hash', ?), ('consecutive_dispatches', '2')",
      TENANT_A
    );

    assert.equal(await harness.admission.release("run-450"), true);
    await Promise.all(harness.background);

    assert.deepEqual(dispatched.slice(0, 2), [TENANT_B, TENANT_A]);
    assert.equal(
      (await harness.admission.getRecord("run-453"))?.state,
      "active"
    );
    assert.equal(
      (await harness.admission.getRecord("run-452"))?.state,
      "active"
    );
  } finally {
    Date.now = originalNow;
  }
});

test("terminal admission history is retained for duplicate idempotency but pruned", async () => {
  const harness = runAdmissionHarness(
    () => ({
      getRun: () => ({ status: "queued" }),
      startAdmitted: () => Promise.resolve(true),
      stop: () => Promise.resolve(null),
    }),
    {
      RUN_ADMISSION_TENANT_ACTIVE_MAX: "1",
      RUN_ADMISSION_TERMINAL_RETENTION: "3",
    }
  );

  for (let index = 0; index < 8; index += 1) {
    const operation = {
      ...request(100 + index),
      agentId: "agent-retention-configured",
    };
    // biome-ignore lint/performance/noAwaitInLoops: Each admission must be retained and pruned in sequence.
    const admitted = await harness.admission.admit(operation);
    assert.equal(admitted.kind, "active");
    await Promise.all(harness.background);
    await harness.admission.release(operation.runId);
  }

  const terminalRows = harness.sql
    .exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM admission_records WHERE state = 'terminal' AND agent_id = ?",
      "agent-retention-configured"
    )
    .toArray() as { count: number }[];
  assert.ok((terminalRows[0]?.count ?? 0) <= 3);
  assert.equal(
    (
      await harness.admission.admit({
        ...request(107),
        agentId: "agent-retention-configured",
      })
    ).kind,
    "duplicate"
  );
});

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
    kind: "duplicate",
    runId: first.runId,
    state: "terminal",
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

test("expired queued cleanup remains durable through an unavailable agent", async () => {
  let attempts = 0;
  const harness = runAdmissionHarness(() => ({
    fenceAdmitted: () => Promise.resolve(true),
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
  assert.equal(
    (await harness.admission.getRecord("run-32"))?.state,
    "terminal"
  );
  assert.equal(attempts, 2, "the alarm retries cleanup once immediately");
  assert.equal(
    (
      harness.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM admission_cleanup_tasks"
        )
        .toArray() as { count: number }[]
    )[0]?.count,
    0,
    "a terminal agent response clears the cleanup tombstone"
  );
});

test("an undispatched queued run expires during a persistent agent outage", async () => {
  let agentAvailable = false;
  const harness = runAdmissionHarness(
    () => ({
      getRun: () => ({ status: "queued" }),
      startAdmitted: (runId) => Promise.resolve(runId === "run-70"),
      stop: () =>
        agentAvailable
          ? Promise.resolve(null)
          : Promise.reject(new Error("agent unavailable")),
    }),
    {
      RUN_ADMISSION_TENANT_ACTIVE_MAX: "1",
      RUN_ADMISSION_TENANT_QUEUE_MAX: "1",
    }
  );
  await harness.admission.admit(request(70));
  await Promise.all(harness.background);
  await harness.admission.admit(request(71));
  await Promise.all(harness.background);
  harness.sql.exec(
    "UPDATE admission_records SET enqueued_at = ? WHERE run_id = ?",
    new Date(Date.now() - 5 * 60 * 1000 - 1).toISOString(),
    "run-71"
  );

  await harness.admission.alarm();

  assert.equal(
    (await harness.admission.getRecord("run-71"))?.state,
    "terminal"
  );
  const cleanupTasks = harness.sql
    .exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM admission_cleanup_tasks"
    )
    .toArray() as { count: number }[];
  assert.equal(cleanupTasks[0]?.count, 1);
  agentAvailable = true;
  harness.sql.exec("UPDATE admission_cleanup_tasks SET next_attempt_at = 0");
  await harness.admission.alarm();
  const remainingTasks = harness.sql
    .exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM admission_cleanup_tasks"
    )
    .toArray() as { count: number }[];
  assert.equal(remainingTasks[0]?.count, 0);
  await harness.admission.release("run-70");
  assert.deepEqual(await harness.admission.admit(request(72)), {
    kind: "active",
    runId: "run-72",
  });
});

test("alarm schedules a new cleanup retry after its prior alarm has fired", async () => {
  const originalNow = Date.now;
  const now = Date.parse("2026-08-26T00:00:00.000Z");
  Date.now = () => now;
  try {
    const harness = runAdmissionHarness(() => ({
      fenceAdmitted: () => Promise.resolve(true),
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
      "terminal"
    );
    assert.equal(
      harness.alarm(),
      now + 5000,
      "a fired alarm must be replaced so cleanup can be retried"
    );
  } finally {
    Date.now = originalNow;
  }
});

test("missing active agent runs are reconciled so capacity is released", async () => {
  const fencedTokens: string[] = [];
  const harness = runAdmissionHarness(() => ({
    fenceAdmitted: (_runId, dispatchToken) => {
      fencedTokens.push(dispatchToken);
      return Promise.resolve(true);
    },
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
  assert.equal(fencedTokens.length, 1);
  assert.match(fencedTokens[0] ?? "", /^[1-9]\d*:/u);
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
      fenceAdmitted: () => Promise.resolve(true),
      getRun: () => ({ status: "queued" }),
      startAdmitted: () => {
        attempts += 1;
        if (attempts === 1) {
          return Promise.reject(new Error("dispatch interrupted"));
        }
        return Promise.resolve(false);
      },
      stop: () => Promise.reject(new Error("agent unavailable")),
    }));

    assert.deepEqual(await harness.admission.admit(request(34)), {
      kind: "active",
      runId: "run-34",
    });
    await Promise.all(harness.background);
    assert.equal(
      (await harness.admission.getRecord("run-34"))?.state,
      "active",
      "an interrupted RPC retains its lease until it can be fenced"
    );

    now += 61_000;
    await harness.admission.alarm();

    assert.equal(
      (await harness.admission.getRecord("run-34"))?.state,
      "queued"
    );
    assert.ok(attempts >= 2, "the alarm must retry the interrupted dispatch");

    now += 5 * 60_000 + 1;
    harness.sql.exec(
      "UPDATE admission_records SET enqueued_at = ? WHERE run_id = ?",
      new Date(now - 5 * 60 * 1000 - 1).toISOString(),
      "run-34"
    );
    await harness.admission.alarm();
    assert.equal(
      (await harness.admission.getRecord("run-34"))?.state,
      "terminal",
      "a requeued run must still expire after its new queue deadline"
    );
  } finally {
    Date.now = originalNow;
  }
});

test("an ambiguous dispatch stays active until reconciliation proves its outcome", async () => {
  let dispatchAttempts = 0;
  let reconciliation: "ambiguous" | "running" | "terminal" = "ambiguous";
  const harness = runAdmissionHarness(
    () => ({
      getRun: (runId: string) => {
        if (runId === "run-66") {
          if (reconciliation === "ambiguous") {
            throw new Error("agent status unavailable");
          }
          return { status: reconciliation };
        }
        return { status: "queued" };
      },
      startAdmitted: (runId: string) => {
        dispatchAttempts += 1;
        if (runId === "run-66" && dispatchAttempts === 1) {
          throw new Error("accepted remotely before the RPC failed");
        }
        return Promise.resolve(true);
      },
      stop: () => Promise.resolve(null),
    }),
    {
      RUN_ADMISSION_TENANT_ACTIVE_MAX: "1",
      RUN_ADMISSION_TENANT_QUEUE_MAX: "1",
    }
  );

  assert.deepEqual(await harness.admission.admit(request(66)), {
    kind: "active",
    runId: "run-66",
  });
  await Promise.all(harness.background);
  assert.equal(
    (await harness.admission.getRecord("run-66"))?.state,
    "active",
    "an uncertain start must retain its capacity claim"
  );
  assert.equal(dispatchAttempts, 1);

  assert.deepEqual(await harness.admission.admit(request(67)), {
    kind: "queued",
    position: 1,
    runId: "run-67",
  });
  await Promise.all(harness.background);
  assert.equal(
    dispatchAttempts,
    1,
    "an ambiguous start must not be dispatched a second time"
  );
  assert.equal((await harness.admission.getRecord("run-67"))?.state, "queued");

  reconciliation = "running";
  await harness.admission.alarm();
  assert.equal((await harness.admission.getRecord("run-66"))?.state, "active");

  reconciliation = "terminal";
  await harness.admission.alarm();
  assert.equal(
    (await harness.admission.getRecord("run-66"))?.state,
    "terminal"
  );
  assert.equal((await harness.admission.getRecord("run-67"))?.state, "active");
  assert.equal(dispatchAttempts, 2);
});

test("a queued dispatch still expires on its queue deadline", async () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-08-26T00:00:00.000Z");
  let cancellations = 0;
  Date.now = () => now;
  try {
    const harness = runAdmissionHarness(() => ({
      fenceAdmitted: () => Promise.resolve(true),
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
    now += 61_000;

    harness.sql.exec(
      "UPDATE admission_records SET enqueued_at = ? WHERE run_id = ?",
      new Date(now - 5 * 60 * 1000 - 1).toISOString(),
      "run-37"
    );

    await harness.admission.alarm();

    assert.equal(
      (await harness.admission.getRecord("run-37"))?.state,
      "terminal",
      "an expired queued record must become a cleanup tombstone"
    );
    assert.equal(
      cancellations,
      2,
      "an active dispatch whose agent is still queued must enter expiry retry"
    );
    assert.equal(
      (
        harness.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM admission_cleanup_tasks WHERE run_id = ?",
            "run-37"
          )
          .toArray() as { count: number }[]
      )[0]?.count,
      1
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

  assert.equal((await harness.admission.getRecord("run-55"))?.state, "active");
  const leaseRows = harness.sql
    .exec<{ dispatch_lease_until: string | null }>(
      "SELECT dispatch_lease_until FROM admission_records WHERE run_id = ?",
      "run-55"
    )
    .toArray() as { dispatch_lease_until: string | null }[];
  assert.ok(leaseRows[0]?.dispatch_lease_until);
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
