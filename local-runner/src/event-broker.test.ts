import assert from "node:assert/strict";
import test from "node:test";
import type { RunEvent } from "@opencoven/agent-contracts";
import { RunEventBroker } from "./event-broker.js";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("serializes replay registration with publication so an interleaved event is delivered exactly once", async () => {
  const broker = new RunEventBroker();
  const runId = "3a3f2c72-9b1b-47f7-8c83-28d5f94bf4ce";
  const first: RunEvent = {
    at: "2026-08-20T20:00:00.000Z",
    id: 1,
    operationId: "0f6f31ae-7b6c-49c9-bc82-0f2cbf56cc4d",
    runId,
    type: "accepted",
  };
  const second: RunEvent = {
    at: "2026-08-20T20:00:01.000Z",
    id: 2,
    status: "running",
    type: "status",
  };
  const snapshotReached = deferred();
  const allowRegistration = deferred();
  const writes: string[] = [];
  let ends = 0;

  const subscribing = broker.subscribe(
    runId,
    0,
    async () => {
      const snapshot = { events: [first], terminal: false };
      snapshotReached.resolve();
      await allowRegistration.promise;
      return snapshot;
    },
    {
      end: () => {
        ends += 1;
      },
      write: (chunk) => {
        writes.push(chunk);
      },
    }
  );

  await snapshotReached.promise;
  const publishing = broker.update(runId, async () => ({
    events: [second],
    terminal: true,
    value: undefined,
  }));
  allowRegistration.resolve();
  await Promise.all([subscribing, publishing]);

  assert.deepEqual(
    [...writes.join("").matchAll(/^id: (\d+)$/gmu)].map((match) =>
      Number(match[1])
    ),
    [1, 2]
  );
  assert.equal(ends, 1);
});
