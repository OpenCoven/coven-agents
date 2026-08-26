import assert from "node:assert/strict";
import test from "node:test";
import {
  AdmissionQueue,
  type AdmissionRecord,
  admissionLimits,
  admissionMode,
  tenantAdmissionHash,
} from "./admission";
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
