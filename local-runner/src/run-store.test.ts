import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import type { RunEvent, RunSnapshot } from "@opencoven/agent-contracts";
import {
  MAX_EVENTS_PER_RUN,
  MAX_TERMINAL_RUNS_PER_AGENT,
  RunStore,
} from "./run-store.js";

const agentId = "53af1a29-4e98-43d6-ac5b-3b9dcba5e730";
const operationId = "6b716eb5-c789-48bd-972f-c81f1d1ad9aa";

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    agentId,
    apiVersion: "1.0",
    commandEvidence: [],
    completedAt: null,
    createdAt: "2026-08-20T20:00:00.000Z",
    fileEvidence: [],
    id: "3a3f2c72-9b1b-47f7-8c83-28d5f94bf4ce",
    operationId,
    output: "",
    startedAt: null,
    status: "queued",
    task: "Run focused tests.",
    ...overrides,
  };
}

function accepted(run: RunSnapshot): RunEvent {
  return {
    at: run.createdAt,
    id: 1,
    operationId: run.operationId,
    runId: run.id,
    type: "accepted",
  };
}

async function withStore(
  callback: (store: RunStore) => Promise<void>
): Promise<void> {
  const path = join(
    process.cwd(),
    ".test-artifacts",
    `run-store-${process.pid}-${randomUUID()}.json`
  );
  await mkdir(dirname(path), { recursive: true });
  try {
    await callback(new RunStore(path));
  } finally {
    await rm(path, { force: true });
  }
}

test("returns the original run for an identical operation request", async () => {
  await withStore(async (store) => {
    const run = snapshot();
    const first = await store.createOrGet({
      events: [accepted(run)],
      operationHash: "same-request",
      run,
    });
    const repeated = await store.createOrGet({
      events: [accepted(run)],
      operationHash: "same-request",
      run: snapshot({ id: randomUUID() }),
    });

    assert.equal(first.kind, "created");
    assert.equal(repeated.kind, "existing");
    assert.equal(repeated.record.run.id, run.id);
  });
});

test("bounds persisted event history while retaining the newest cursor", async () => {
  await withStore(async (store) => {
    const run = snapshot();
    const events: RunEvent[] = Array.from(
      { length: MAX_EVENTS_PER_RUN + 1 },
      (_, index) => ({
        at: run.createdAt,
        id: index + 1,
        status: "running" as const,
        type: "status" as const,
      })
    );

    const result = await store.createOrGet({
      events,
      operationHash: "bounded-events",
      run,
    });

    assert.equal(result.kind, "created");
    assert.equal(result.record.events.length, MAX_EVENTS_PER_RUN);
    assert.equal(result.record.events[0]?.id, 2);
    assert.equal(result.record.events.at(-1)?.id, MAX_EVENTS_PER_RUN + 1);
  });
});

test("finds the oldest queued run for an agent", async () => {
  await withStore(async (store) => {
    const first = snapshot({
      createdAt: "2026-08-20T20:00:00.000Z",
      id: randomUUID(),
      operationId: randomUUID(),
    });
    const second = snapshot({
      createdAt: "2026-08-20T20:01:00.000Z",
      id: randomUUID(),
      operationId: randomUUID(),
    });
    await store.createOrGet({
      events: [accepted(first)],
      operationHash: "first",
      run: first,
    });
    await store.createOrGet({
      events: [accepted(second)],
      operationHash: "second",
      run: second,
    });

    const queued = await store.findFirstByAgentStatus(agentId, "queued");

    assert.equal(queued?.run.id, first.id);
  });
});

test("marks an interrupted active run failed only once on restart", async () => {
  await withStore(async (store) => {
    const run = snapshot();
    await store.createOrGet({
      events: [accepted(run)],
      operationHash: "restart",
      run,
    });

    const recovered = await store.recoverInterrupted();
    const stored = await store.get(run.id);
    const repeated = await store.recoverInterrupted();

    assert.equal(recovered.length, 1);
    assert.equal(stored?.run.status, "failed");
    assert.equal(stored?.run.error?.code, "interrupted");
    assert.equal(stored?.events.at(-1)?.type, "failed");
    assert.equal(repeated.length, 0);
  });
});

test("retains at most twenty terminal runs for an agent", async () => {
  await withStore(async (store) => {
    await Promise.all(
      Array.from({ length: MAX_TERMINAL_RUNS_PER_AGENT + 1 }, (_, index) => {
        const completedAt = new Date(
          Date.parse("2026-08-20T20:00:00.000Z") + index * 1000
        ).toISOString();
        const run = snapshot({
          completedAt,
          createdAt: completedAt,
          id: randomUUID(),
          operationId: randomUUID(),
          status: "completed",
        });
        return store.createOrGet({
          events: [accepted(run)],
          operationHash: `terminal-${index}`,
          run,
        });
      })
    );

    const retained = await store.listForAgent(agentId);

    assert.equal(retained.length, MAX_TERMINAL_RUNS_PER_AGENT);
    assert.equal(
      retained.some(
        (record) => record.run.createdAt === "2026-08-20T20:00:00.000Z"
      ),
      false
    );
  });
});
