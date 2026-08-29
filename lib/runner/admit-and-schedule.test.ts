import assert from "node:assert/strict";
import test from "node:test";
import type { RunSnapshot } from "@opencoven/agent-contracts";
import { admitAndScheduleRunnerRun } from "./admit-and-schedule";
import type { RunnerClaimedDispatch } from "./types";

const RUN_ID = "11111111-2222-4333-8444-555555555555";
const run = { id: RUN_ID } as RunSnapshot;

function claimedDispatch(): RunnerClaimedDispatch {
  return {
    authority: {
      expectedVersion: 7,
      leaseToken: "opaque-claim",
      runId: RUN_ID,
    },
    run: { id: RUN_ID },
  } as unknown as RunnerClaimedDispatch;
}

test("claimed admission schedules its exact dispatch once without reconciliation", async () => {
  const claimed = claimedDispatch();
  const callbacks: (() => void | Promise<void>)[] = [];
  const dispatched: RunnerClaimedDispatch[] = [];
  let reconciled = 0;

  const result = admitAndScheduleRunnerRun(
    { admission: "claimed", claimed, kind: "accepted", run },
    {
      dispatchClaim: (value) => {
        dispatched.push(value);
        return Promise.resolve({ kind: "started", runId: RUN_ID });
      },
      reconcile: () => {
        reconciled += 1;
        return Promise.resolve();
      },
      schedule: (callback) => {
        callbacks.push(callback);
      },
    }
  );

  assert.deepEqual(result, { kind: "accepted", run });
  assert.equal(callbacks.length, 1);
  assert.equal(dispatched.length, 0);
  await callbacks[0]?.();
  assert.deepEqual(dispatched, [claimed]);
  assert.equal(reconciled, 0);
});

test("duplicate admission returns the existing run without scheduling", () => {
  const callbacks: (() => void | Promise<void>)[] = [];

  const result = admitAndScheduleRunnerRun(
    { admission: "duplicate", kind: "accepted", run },
    {
      dispatchClaim: () =>
        Promise.reject(new Error("duplicate must not dispatch")),
      reconcile: () =>
        Promise.reject(new Error("duplicate must not reconcile")),
      schedule: (callback) => {
        callbacks.push(callback);
      },
    }
  );

  assert.deepEqual(result, { kind: "accepted", run });
  assert.equal(callbacks.length, 0);
});

test("created admission schedules one bounded reconciliation callback", async () => {
  const callbacks: (() => void | Promise<void>)[] = [];
  let reconciled = 0;

  const result = admitAndScheduleRunnerRun(
    { admission: "created", kind: "accepted", run },
    {
      dispatchClaim: () =>
        Promise.reject(new Error("created must not dispatch directly")),
      reconcile: () => {
        reconciled += 1;
        return Promise.resolve();
      },
      schedule: (callback) => {
        callbacks.push(callback);
      },
    }
  );

  assert.deepEqual(result, { kind: "accepted", run });
  assert.equal(callbacks.length, 1);
  assert.equal(reconciled, 0);
  await callbacks[0]?.();
  assert.equal(reconciled, 1);
});

test("scheduled dispatch failure is contained and leaves the run accepted", async () => {
  const claimed = claimedDispatch();
  let callback: (() => void | Promise<void>) | undefined;
  const unhandled: unknown[] = [];
  const recordUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", recordUnhandled);

  try {
    const result = admitAndScheduleRunnerRun(
      { admission: "claimed", claimed, kind: "accepted", run },
      {
        dispatchClaim: () =>
          Promise.reject(new Error("provider=private-detail")),
        reconcile: () => Promise.resolve(),
        schedule: (scheduled) => {
          callback = scheduled;
        },
      }
    );

    assert.deepEqual(result, { kind: "accepted", run });
    await callback?.();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.deepEqual(unhandled, []);
    assert.equal(JSON.stringify(result).includes("private-detail"), false);
    assert.equal(JSON.stringify(result).includes("opaque-claim"), false);
  } finally {
    process.off("unhandledRejection", recordUnhandled);
  }
});

test("refused, invalid, and not-found results remain unchanged", () => {
  const callbacks: (() => void | Promise<void>)[] = [];
  const dependencies = {
    dispatchClaim: () => Promise.resolve({ kind: "idle" as const }),
    reconcile: () => Promise.resolve(),
    schedule: (callback: () => void | Promise<void>) => {
      callbacks.push(callback);
    },
  };
  const invalid = { kind: "invalid" as const };
  const notFound = { kind: "not_found" as const };
  const refused = {
    code: "busy" as const,
    kind: "refused" as const,
    retryable: true,
  };

  assert.equal(admitAndScheduleRunnerRun(invalid, dependencies), invalid);
  assert.equal(admitAndScheduleRunnerRun(notFound, dependencies), notFound);
  assert.equal(admitAndScheduleRunnerRun(refused, dependencies), refused);
  assert.equal(callbacks.length, 0);
});
