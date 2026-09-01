import assert from "node:assert/strict";
import test from "node:test";
import type { RunnerReconciliationContext } from "../attempt-reconcile";
import { daytonaRunSessionName } from "../daytona/names";
import type {
  RunnerDaytonaAttemptId,
  RunnerDispatchAuthority,
  RunnerRunRecord,
} from "../types";
import {
  HERMETIC_EXECUTION_PROVENANCE,
  HERMETIC_HOLD_TASK_MARKER,
  hermeticCommandId,
} from "./executor";
import { hermeticReconciliationProvider } from "./reconcile";

const runId = "00000000-0000-4000-8000-000000000002";
const attemptId =
  "53af1a29-4e98-43d6-ac5b-3b9dcba5e730" as RunnerDaytonaAttemptId;
const authority = {
  attemptId,
  expectedVersion: 2,
  leaseToken: "hermetic-lease",
  runId,
} as RunnerDispatchAuthority;

function run(task = "complete certification"): RunnerRunRecord {
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    agentInstructions: "instructions",
    agentModel: "auto",
    agentRuntime: "copilot",
    agentWorkspace: null,
    authVersion: 1,
    cancellationRequestedAt: null,
    commandEvidence: [],
    completedAt: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    daytonaAttemptId: attemptId,
    daytonaCommandId: hermeticCommandId(runId, attemptId),
    daytonaLogCursor: 0,
    daytonaSessionId: daytonaRunSessionName(runId, attemptId),
    dispatchLeaseExpiresAt: new Date("2026-09-01T00:05:00.000Z"),
    dispatchLeaseToken: "hermetic-lease",
    dispatchState: "running",
    error: null,
    executionPermission: "unrestricted",
    executionProvenance: HERMETIC_EXECUTION_PROVENANCE,
    fileEvidence: [],
    id: runId,
    logCursor: 0,
    operationId: "33333333-3333-4333-8333-333333333333",
    output: "",
    queueSequence: 1,
    requestHash: "hash",
    startedAt: new Date("2026-09-01T00:00:00.000Z"),
    status: "running",
    task,
    tenant: "tenant_a",
    version: 2,
  };
}

test("hermetic reconciliation emits bounded deterministic evidence without a credential", async () => {
  const provider = hermeticReconciliationProvider();
  const context = await provider.resolveExecutionContext(run(), authority);
  assert.ok(context);
  const first = await provider.snapshot?.({
    attemptId,
    commandId: hermeticCommandId(runId, attemptId),
    context,
    credential: null,
    cursor: 0,
    harness: "copilot",
    runId,
  });
  assert.equal(provider.requiresAttemptRedaction, false);
  assert.equal(first?.status, "completed");
  assert.equal(
    first?.summary.output,
    "Hermetic runner completed deterministic certification task."
  );
  assert.equal(first?.events.length, 5);
  assert.equal(
    first?.events.some((event) => "credential" in event),
    false
  );
  const resumed = await provider.snapshot?.({
    attemptId,
    commandId: hermeticCommandId(runId, attemptId),
    context,
    credential: null,
    cursor: first?.cursor ?? 0,
    harness: "copilot",
    runId,
  });
  assert.equal(resumed?.events.length, 0);
  assert.deepEqual(await provider.stop(context, { attemptId, runId }), {
    kind: "stopped",
  });
});

test("hermetic held run stays running until generic cancellation stops its exact attempt", async () => {
  const provider = hermeticReconciliationProvider();
  const context = await provider.resolveExecutionContext(
    run(`hold ${HERMETIC_HOLD_TASK_MARKER}`),
    authority
  );
  assert.ok(context);
  const held = await provider.snapshot?.({
    attemptId,
    commandId: hermeticCommandId(runId, attemptId),
    context,
    credential: null,
    cursor: 0,
    harness: "copilot",
    runId,
  });
  assert.equal(held?.status, "running");
  assert.deepEqual(
    await provider.stop({} as RunnerReconciliationContext, {
      attemptId,
      runId,
    }),
    { kind: "provider_unavailable" }
  );
});

test("hermetic reconciliation confirms an exact prepared-only attempt has no process", async () => {
  const provider = hermeticReconciliationProvider();

  assert.equal(
    await provider.resolveExecutionContext(
      {
        ...run(),
        daytonaCommandId: null,
        daytonaSessionId: null,
        dispatchState: "dispatching",
      },
      authority
    ),
    null
  );
});

test("hermetic recovery rejects foreign, incomplete, and mismatched provider identities", async () => {
  const provider = hermeticReconciliationProvider();
  const cases = [
    {
      ...run(),
      executionProvenance: {
        ...HERMETIC_EXECUTION_PROVENANCE,
        provider: "daytona",
      },
    },
    { ...run(), executionProvenance: null },
    {
      ...run(),
      executionProvenance: {
        provider: "hermetic",
      } as never,
    },
    {
      ...run(),
      daytonaAttemptId: "foreign-attempt" as RunnerDaytonaAttemptId,
      daytonaCommandId: null,
      daytonaSessionId: null,
    },
    { ...run(), daytonaCommandId: null },
    { ...run(), daytonaSessionId: null },
    { ...run(), daytonaCommandId: "foreign-command" },
    { ...run(), daytonaSessionId: "foreign-session" },
  ];

  await Promise.all(
    cases.map(
      async (candidate) =>
        await assert.rejects(
          provider.resolveExecutionContext(candidate, authority),
          /unavailable|ambiguous/u
        )
    )
  );
  await assert.rejects(
    provider.resolveExecutionContext(run(), {
      ...authority,
      attemptId:
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as RunnerDaytonaAttemptId,
    }),
    /unavailable|ambiguous/u
  );
});

test("hermetic fake cannot snapshot or stop a spoofed context", async () => {
  const provider = hermeticReconciliationProvider();
  const context = await provider.resolveExecutionContext(run(), authority);
  assert.ok(context);
  await assert.rejects(async () =>
    provider.snapshot?.({
      attemptId,
      commandId: "foreign-command",
      context,
      credential: null,
      cursor: 0,
      harness: "copilot",
      runId,
    })
  );
  assert.deepEqual(
    await provider.stop(context, {
      attemptId:
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as RunnerDaytonaAttemptId,
      runId,
    }),
    { kind: "provider_unavailable" }
  );
  assert.deepEqual(
    await provider.stop(
      {
        attemptId,
        runId,
      } as unknown as RunnerReconciliationContext,
      { attemptId, runId }
    ),
    { kind: "provider_unavailable" }
  );
});
