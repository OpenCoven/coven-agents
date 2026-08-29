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
  sandboxGetCount,
  setSandboxDestroyError,
  setSandboxExec,
} from "../test-support/cloudflare-sandbox";
import {
  AgentDirectory,
  PENDING_ADMISSION_TIMEOUT_MS,
  YoloAgent,
} from "./agents";
import { HarnessError } from "./harness-runner";
import {
  AgentBusyError,
  AgentDecommissioningError,
  AlreadyRunningError,
  type CloudRunRecord,
  cloudFiberKey,
  finishCloudRunRecord,
  InvalidWorkspaceError,
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
    warm: {
      status: "not_started",
      updatedAt: "2026-08-20T12:00:00.000Z",
    },
  };
}

function admissionTestEnv(): Record<string, unknown> {
  return {
    RunAdmission: {
      getByName: () => ({
        getCleanupCapability: testAdmissionCapability,
        release: () => Promise.resolve(true),
        validateDispatch: () => Promise.resolve(true),
      }),
    },
  };
}

function testAdmissionCapability(
  runId: string,
  expected: {
    agentId: string;
    operationId: string;
    requestHash: string;
  }
) {
  return Promise.resolve({
    admissionSequence: 1,
    ...expected,
    runId,
  });
}

/**
 * Fibers are dispatched but not executed. The harness itself is covered
 * elsewhere; what matters here is that a run is accepted, recorded and left
 * in flight, which is exactly the state a caller sees after a 202.
 */
function agent(): YoloAgent {
  resetFiberLog();
  fiberControl.runFibers = false;
  const instance = new YoloAgent(
    undefined as never,
    admissionTestEnv() as never
  );
  instance.configure(definition());
  return instance;
}

function legacyAgent(): YoloAgent {
  const instance = agent();
  const state = Reflect.get(instance, "state") as Record<string, unknown>;
  const {
    decommission: _decommission,
    lifecycle: _lifecycle,
    ...legacy
  } = state;
  instance.setState(legacy as never);
  return instance;
}

function setLegacyRuntime(instance: YoloAgent): void {
  const state = Reflect.get(instance, "state") as Record<string, unknown> & {
    definition: AgentDefinition;
  };
  instance.setState({
    ...state,
    definition: { ...state.definition, runtime: "cloud" },
  } as never);
}

async function admittedStart(
  yolo: YoloAgent,
  input: { operationId: string; task: string },
  identityToken = "identity",
  dispatchToken = `1:test-${input.operationId}`
) {
  const prepared = await yolo.enqueue(
    input,
    crypto.randomUUID(),
    `${input.operationId}:${input.task}`,
    identityToken
  );
  if (prepared.created) {
    assert.equal(
      await yolo.startAdmitted(prepared.run.id, dispatchToken),
      true
    );
  }
  return { ...prepared, run: yolo.getRun(prepared.run.id) ?? prepared.run };
}

test("public run-start surfaces are admission-gated", () => {
  const yolo = agent();
  const startSurfaces = ["enqueue", "startAdmitted"].filter(
    (name) =>
      typeof (yolo as unknown as Record<string, unknown>)[name] === "function"
  );

  assert.deepEqual(startSurfaces, ["enqueue", "startAdmitted"]);
  assert.equal("execute" in yolo, false);
  assert.equal("start" in yolo, false);
});

test("corrupt persisted workspace is rejected before admission confirmation or execution", async () => {
  resetDestroyedSandboxes();
  const yolo = agent();
  const prepared = await yolo.enqueue(
    { operationId: OP_A, task: "Do not start with corrupt state." },
    "4f2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c91",
    "corrupt-workspace-hash",
    "identity"
  );
  assert.equal(prepared.created, true);

  const state = Reflect.get(yolo, "state") as Record<string, unknown> & {
    definition: AgentDefinition;
  };
  yolo.setState({
    ...state,
    definition: { ...state.definition, workspace: "/corrupt" },
  } as never);

  await assert.rejects(
    () => yolo.startAdmitted(prepared.run.id, "1:corrupt-workspace"),
    (error: unknown) =>
      error instanceof InvalidWorkspaceError && error.provenNotStarted === true
  );

  const current = yolo.getRun(prepared.run.id);
  assert.equal(current?.status, "queued");
  const currentState = Reflect.get(yolo, "state") as {
    admissionConfirmedAt?: string;
    admissionTokens?: Record<string, string>;
    dispatchClaims?: Record<string, string>;
    runs: CloudRunRecord[];
  };
  const record = currentState.runs.find(
    (candidate) => candidate.run.id === prepared.run.id
  );
  assert.equal(record?.admissionConfirmedAt, undefined);
  assert.equal(currentState.admissionTokens?.[prepared.run.id], undefined);
  assert.equal(currentState.dispatchClaims?.[prepared.run.id], undefined);
  assert.equal(record?.dispatchToken, undefined);
  assert.equal(sandboxGetCount(), 0);
});

test("direct admitted legacy dispatch fails safely before confirmation or execution", async () => {
  resetFiberLog();
  resetDestroyedSandboxes();
  fiberControl.runFibers = false;
  let confirmations = 0;
  let releases = 0;
  const yolo = new YoloAgent(
    undefined as never,
    {
      RunAdmission: {
        getByName: () => ({
          release: () => {
            releases += 1;
            return Promise.resolve(true);
          },
          validateDispatch: () => Promise.resolve(true),
        }),
      },
    } as never
  );
  yolo.configure(definition());
  const prepared = await yolo.enqueue(
    { operationId: OP_A, task: "Reject the legacy runtime." },
    "4f2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c93",
    "legacy-runtime-hash",
    "identity"
  );
  const originalConfirm = yolo.confirmAdmission.bind(yolo);
  yolo.confirmAdmission = (...arguments_) => {
    confirmations += 1;
    return originalConfirm(...arguments_);
  };
  setLegacyRuntime(yolo);

  assert.equal(
    await yolo.startAdmitted(prepared.run.id, "1:legacy-runtime"),
    true
  );

  const failed = yolo.getRun(prepared.run.id);
  assert.equal(failed?.status, "failed");
  assert.deepEqual(failed?.error, {
    code: "harness_unsupported",
    message: "Cloud agents must select a supported harness runtime: copilot.",
    retryable: false,
  });
  assert.equal(failed?.startedAt, null);
  assert.equal(confirmations, 0);
  assert.equal(releases, 1);
  assert.equal(fiberLog.started.length, 0);
  assert.equal(sandboxGetCount(), 0);
});

test("workspace corruption after claim fails and releases the admitted run", async () => {
  resetDestroyedSandboxes();
  fiberControl.runFibers = false;
  let yolo!: YoloAgent;
  const yoloEnv = {
    ...admissionTestEnv(),
    AgentDirectory: {
      getByName: () => ({
        markRunStatus: () => {
          const state = Reflect.get(yolo, "state") as Record<
            string,
            unknown
          > & {
            definition: AgentDefinition;
          };
          yolo.setState({
            ...state,
            definition: { ...state.definition, workspace: "/corrupt" },
          } as never);
          return true;
        },
      }),
    },
  };
  yolo = new YoloAgent(undefined as never, yoloEnv as never);
  yolo.configure(definition());
  const prepared = await yolo.enqueue(
    { operationId: OP_B, task: "Clean up after a late corruption." },
    "4f2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c92",
    "late-corrupt-workspace-hash",
    "identity"
  );

  await assert.rejects(
    () => yolo.startAdmitted(prepared.run.id, "1:late-corrupt-workspace"),
    (error: unknown) =>
      error instanceof InvalidWorkspaceError && error.provenNotStarted === true
  );

  assert.equal(yolo.getRun(prepared.run.id)?.status, "failed");
  assert.equal(sandboxGetCount(), 0);
});

test("an orphaned enqueue is durably cleaned after its preparation deadline", async () => {
  resetDestroyedSandboxes();
  const scheduled: { id: string; payload: unknown }[] = [];
  const yolo = new (class extends YoloAgent {
    schedule<T = string>(
      _when: Date | number | string,
      callback: keyof this,
      scheduledPayload?: T
    ): Promise<{
      id: string;
      callback: string;
      payload: T;
      type: "scheduled";
      time: number;
    }> {
      const result = {
        callback: String(callback),
        id: "pending-admission-1",
        payload: scheduledPayload as T,
        time: Date.now(),
        type: "scheduled" as const,
      };
      scheduled.push({ id: result.id, payload: scheduledPayload });
      return Promise.resolve(result);
    }

    cancelSchedule(): Promise<boolean> {
      return Promise.resolve(true);
    }
  })(
    undefined as never,
    {
      RunAdmission: {
        getByName: () => ({
          getCleanupCapability: testAdmissionCapability,
        }),
      },
    } as never
  );
  yolo.configure(definition());

  const queued = await yolo.enqueue(
    { operationId: OP_A, task: "Recover the crash gap." },
    "4f2a0f4e-1f4d-4a2e-9c1b-7d2f5f4d4a31",
    "crash-gap-hash",
    "identity"
  );
  assert.equal(queued.created, true);
  assert.equal(scheduled.length, 1);
  const state = Reflect.get(yolo, "state") as {
    runs: CloudRunRecord[];
  };
  const record = state.runs.find(
    (candidate) => candidate.run.id === queued.run.id
  );
  assert.ok(
    Number.isFinite(record?.pendingAdmission?.deadlineAt) &&
      (record?.pendingAdmission?.deadlineAt ?? 0) <=
        Date.now() + PENDING_ADMISSION_TIMEOUT_MS
  );

  const expiredState = Reflect.get(yolo, "state") as {
    runs: CloudRunRecord[];
  };
  yolo.setState({
    ...expiredState,
    runs: expiredState.runs.map((candidate) =>
      candidate.run.id === queued.run.id
        ? {
            ...candidate,
            pendingAdmission: {
              ...candidate.pendingAdmission,
              deadlineAt: Date.now() - 1,
            },
          }
        : candidate
    ),
  } as never);
  const orphanPayload = scheduled[0]?.payload as {
    generation: number;
    runId: string;
    token: string;
  };
  assert.equal(
    await yolo.expirePendingAdmission(orphanPayload, {
      id: "pending-admission-1",
    }),
    true
  );
  assert.equal(yolo.getRun(queued.run.id), null);
  assert.deepEqual(destroyedSandboxes(), []);
});

test("expiring one pending admission cannot discard another pending run", async () => {
  const yolo = agent();
  const firstRunId = "4f2a0f4e-1f4d-4a2e-9c1b-7d2f5f4d4a34";
  const secondRunId = "4f2a0f4e-1f4d-4a2e-9c1b-7d2f5f4d4a35";
  const first = await yolo.enqueue(
    { operationId: OP_A, task: "Keep the other pending run." },
    firstRunId,
    "pending-a",
    "identity-a"
  );
  const second = await yolo.enqueue(
    { operationId: OP_B, task: "Expire this pending run." },
    secondRunId,
    "pending-b",
    "identity-b"
  );
  assert.equal(first.created, true);
  assert.equal(second.created, true);

  const state = Reflect.get(yolo, "state") as { runs: CloudRunRecord[] };
  yolo.setState({
    ...state,
    runs: state.runs.map((candidate) =>
      candidate.run.id === secondRunId
        ? {
            ...candidate,
            pendingAdmission: {
              ...candidate.pendingAdmission,
              deadlineAt: Date.now() - 1,
            },
          }
        : candidate
    ),
  } as never);

  assert.equal(await yolo.startAdmitted(secondRunId, "2:expire-second"), false);
  assert.equal(yolo.getRun(firstRunId)?.id, firstRunId);
  assert.equal(yolo.getRun(secondRunId), null);
});

test("a scheduled expiry callback carries the run fence and cannot expire another pending run", async () => {
  const scheduled: { id: string; payload: unknown }[] = [];
  const yolo = new (class extends YoloAgent {
    schedule<T = string>(
      _when: Date | number | string,
      callback: keyof this,
      payload?: T
    ): Promise<{
      id: string;
      callback: string;
      payload: T;
      type: "scheduled";
      time: number;
    }> {
      const result = {
        callback: String(callback),
        id: `pending-admission-${scheduled.length + 1}`,
        payload: payload as T,
        time: Date.now(),
        type: "scheduled" as const,
      };
      scheduled.push({ id: result.id, payload });
      return Promise.resolve(result);
    }

    cancelSchedule(): Promise<boolean> {
      return Promise.resolve(true);
    }
  })(undefined as never, admissionTestEnv() as never);
  yolo.configure(definition());

  const firstRunId = "4f2a0f4e-1f4d-4a2e-9c1b-7d2f5f4d4a36";
  const secondRunId = "4f2a0f4e-1f4d-4a2e-9c1b-7d2f5f4d4a37";
  await yolo.enqueue(
    { operationId: OP_A, task: "Expire only the first run." },
    firstRunId,
    "scheduled-a",
    "identity-a"
  );
  await yolo.enqueue(
    { operationId: OP_B, task: "Keep the second run." },
    secondRunId,
    "scheduled-b",
    "identity-b"
  );
  const state = Reflect.get(yolo, "state") as { runs: CloudRunRecord[] };
  yolo.setState({
    ...state,
    runs: state.runs.map((candidate) =>
      candidate.run.id === firstRunId
        ? {
            ...candidate,
            pendingAdmission: {
              ...candidate.pendingAdmission,
              deadlineAt: Date.now() - 1,
            },
          }
        : candidate
    ),
  } as never);

  const firstPayload = scheduled[0]?.payload as {
    generation: number;
    runId: string;
    token: string;
  };
  const secondScheduleId = scheduled[1]?.id;
  assert.equal(
    await yolo.expirePendingAdmission(firstPayload, { id: secondScheduleId }),
    true
  );
  assert.equal(yolo.getRun(firstRunId)?.id, firstRunId);
  assert.equal(yolo.getRun(secondRunId)?.id, secondRunId);

  assert.equal(
    await yolo.expirePendingAdmission(firstPayload, {
      id: scheduled[0]?.id,
    }),
    true
  );
  assert.equal(yolo.getRun(firstRunId), null);
  assert.equal(yolo.getRun(secondRunId)?.id, secondRunId);
});

test("a stale provisional cleanup cannot discard an agent-confirmed run", async () => {
  const yolo = agent();
  const runId = "4f2a0f4e-1f4d-4a2e-9c1b-7d2f5f4d4a33";
  const requestHash = "confirmed-before-cleanup-hash";
  const prepared = await yolo.enqueue(
    { operationId: OP_A, task: "Keep the confirmed run." },
    runId,
    requestHash,
    "identity"
  );
  assert.equal(prepared.created, true);
  assert.ok(prepared.prepareOwner);

  const confirmation = await yolo.confirmAdmission(runId, OP_A, requestHash, {
    admissionSequence: 1,
    agentId: AGENT_ID,
    operationId: OP_A,
    requestHash,
    runId,
  });
  assert.deepEqual(confirmation, { kind: "confirmed" });
  assert.equal(
    yolo.discardPreparedRun(runId, prepared.prepareOwner ?? ""),
    "confirmed"
  );
  assert.equal(yolo.getRun(runId)?.id, runId);
});

test("a pending-admission schedule failure registers coordinator-owned provisional cleanup", async () => {
  let provisional: unknown[] | undefined;
  const yolo = new (class extends YoloAgent {
    schedule(): Promise<never> {
      return Promise.reject(new Error("schedule unavailable"));
    }
  })(
    undefined as never,
    {
      RunAdmission: {
        getByName: () => ({
          enqueueProvisionalCleanup: (...args: unknown[]) => {
            provisional = args;
            return Promise.resolve();
          },
        }),
      },
    } as never
  );
  yolo.configure(definition());

  const runId = "4f2a0f4e-1f4d-4a2e-9c1b-7d2f5f4d4a32";
  const prepared = await yolo.enqueue(
    { operationId: OP_B, task: "Survive a scheduling outage." },
    runId,
    "schedule-failure-hash",
    "identity"
  );

  assert.equal(prepared.created, true);
  assert.equal(prepared.scheduleFailed, true);
  assert.deepEqual(provisional, [
    AGENT_ID,
    runId,
    prepared.prepareOwner,
    OP_B,
    "schedule-failure-hash",
  ]);
});

test("an expired accepted admission releases its exact capability before discard", async () => {
  resetFiberLog();
  fiberControl.runFibers = false;
  const released: unknown[] = [];
  const runId = "4f2a0f4e-1f4d-4a2e-9c1b-7d2f5f4d4a30";
  const capability = {
    admissionSequence: 19,
    agentId: AGENT_ID,
    dispatchToken: "19:expired",
    operationId: OP_A,
    requestHash: "expired-capability-hash",
    runId,
  };
  const yolo = new YoloAgent(
    undefined as never,
    {
      RunAdmission: {
        getByName: () => ({
          getRecord: () =>
            Promise.resolve({
              agentId: AGENT_ID,
              operationId: OP_A,
              requestHash: capability.requestHash,
              runId,
              state: "active" as const,
            }),
          release: (
            releasedRunId: string,
            dispatchToken?: string,
            admissionSequence?: number
          ) => {
            released.push({
              admissionSequence,
              dispatchToken,
              runId: releasedRunId,
            });
            return Promise.resolve(true);
          },
        }),
      },
    } as never
  );
  yolo.configure(definition());
  const prepared = await yolo.enqueue(
    { operationId: OP_A, task: "Expire accepted provisional work." },
    runId,
    capability.requestHash,
    "identity"
  );
  const state = Reflect.get(yolo, "state") as { runs: CloudRunRecord[] };
  const scheduleToken = state.runs.find(
    (candidate) => candidate.run.id === runId
  )?.pendingAdmission?.scheduleToken;
  yolo.setState({
    ...state,
    runs: state.runs.map((candidate) =>
      candidate.run.id === runId
        ? {
            ...candidate,
            admissionCapability: capability,
            pendingAdmission: {
              ...candidate.pendingAdmission,
              admissionCapability: capability,
              deadlineAt: Date.now() - 1,
            },
          }
        : candidate
    ),
  } as never);

  assert.equal(
    await yolo.expirePendingAdmission({
      admissionSequence: capability.admissionSequence,
      generation: 1,
      runId,
      token: scheduleToken ?? "",
    }),
    true
  );
  assert.deepEqual(released, [
    {
      admissionSequence: capability.admissionSequence,
      dispatchToken: capability.dispatchToken,
      runId,
    },
  ]);
  assert.equal(yolo.getRun(runId), null);
  assert.equal(
    (await yolo.confirmAdmission(runId, OP_A, capability.requestHash)).kind,
    "nonterminal"
  );
  assert.equal(prepared.created, true);
});

test("only the provisional run creator can discard it, and confirmation clears ownership", async () => {
  const yolo = agent();
  const prepared = await yolo.enqueue(
    { operationId: OP_A, task: "Protect the shared preparation." },
    "4f2a0f4e-1f4d-4a2e-9c1b-7d2f5f4d4a32",
    "prepare-owner-hash",
    "identity"
  );

  assert.equal(prepared.created, true);
  assert.ok(prepared.prepareOwner);
  assert.equal(
    yolo.discardRun(prepared.run.id, "not-the-creator"),
    false,
    "a duplicate request must not discard the shared provisional run"
  );
  assert.ok(yolo.getRun(prepared.run.id));

  assert.deepEqual(
    await yolo.confirmAdmission(prepared.run.id, OP_A, "prepare-owner-hash"),
    { kind: "confirmed" }
  );
  const state = Reflect.get(yolo, "state") as {
    runs: CloudRunRecord[];
  };
  assert.equal(
    state.runs.find((candidate) => candidate.run.id === prepared.run.id)
      ?.pendingAdmission,
    undefined,
    "admission confirmation must clear the prepare owner"
  );
  assert.equal(
    yolo.discardRun(prepared.run.id, prepared.prepareOwner),
    false,
    "a confirmed run is no longer discardable by its creator"
  );
});

test("rejectAdmitted terminalizes an exact confirmed queued run without sandbox cleanup", async () => {
  resetDestroyedSandboxes();
  const yolo = agent();
  const prepared = await yolo.enqueue(
    { operationId: OP_A, task: "Reject before dispatch." },
    "4f2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c9e",
    "reject-before-dispatch",
    "identity"
  );
  const capability = {
    ...(await testAdmissionCapability(prepared.run.id, {
      agentId: AGENT_ID,
      operationId: OP_A,
      requestHash: "reject-before-dispatch",
    })),
    dispatchToken: "1:reject-before-dispatch",
  };

  assert.deepEqual(
    await yolo.confirmAdmission(
      prepared.run.id,
      OP_A,
      "reject-before-dispatch",
      capability
    ),
    { kind: "confirmed" }
  );
  const state = Reflect.get(yolo, "state") as {
    definition: AgentDefinition | null;
  };
  yolo.setState({
    ...state,
    definition: {
      ...state.definition,
      workspace: "/mutated",
    },
  } as never);

  assert.equal(yolo.rejectAdmitted(prepared.run.id, capability), true);
  assert.equal(yolo.getRun(prepared.run.id)?.status, "failed");
  assert.deepEqual(destroyedSandboxes(), []);
  assert.equal(
    (Reflect.get(yolo, "ephemeralIdentityTokens") as Map<string, unknown>).size,
    0
  );
});

test("discarding a prepared run removes its ephemeral identity token", async () => {
  const yolo = agent();
  const prepared = await yolo.enqueue(
    { operationId: OP_B, task: "Discard before admission." },
    "4f2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8ca0",
    "discard-before-admission",
    "identity"
  );
  assert.ok(prepared.prepareOwner);
  assert.equal(
    (Reflect.get(yolo, "ephemeralIdentityTokens") as Map<string, unknown>).size,
    1
  );

  assert.equal(
    yolo.discardPreparedRun(prepared.run.id, prepared.prepareOwner ?? ""),
    true
  );
  assert.equal(
    (Reflect.get(yolo, "ephemeralIdentityTokens") as Map<string, unknown>).size,
    0
  );
});

test("admission confirmation atomically wins the orphan timeout and rejects foreign data", async () => {
  const cancelled: string[] = [];
  const yolo = new (class extends YoloAgent {
    schedule<T = string>(
      _when: Date | number | string,
      callback: keyof this,
      payload?: T
    ): Promise<{
      id: string;
      callback: string;
      payload: T;
      type: "scheduled";
      time: number;
    }> {
      return Promise.resolve({
        callback: String(callback),
        id: "pending-admission-2",
        payload: payload as T,
        time: Date.now(),
        type: "scheduled",
      });
    }

    cancelSchedule(id: string): Promise<boolean> {
      cancelled.push(id);
      return Promise.resolve(true);
    }
  })(
    undefined as never,
    {
      RunAdmission: {
        getByName: () => ({
          getCleanupCapability: testAdmissionCapability,
        }),
      },
    } as never
  );
  yolo.configure(definition());
  const queued = await yolo.enqueue(
    { operationId: OP_A, task: "Attach safely." },
    "4f2a0f4e-1f4d-4a2e-9c1b-7d2f5f4d4a32",
    "attach-hash",
    "identity"
  );

  assert.deepEqual(
    await yolo.confirmAdmission(queued.run.id, OP_B, "wrong-hash"),
    { kind: "nonterminal" }
  );
  assert.deepEqual(
    await yolo.confirmAdmission(queued.run.id, OP_A, "attach-hash"),
    { kind: "confirmed" }
  );
  assert.deepEqual(cancelled, ["pending-admission-2"]);
  const state = Reflect.get(yolo, "state") as {
    runs: CloudRunRecord[];
  };
  assert.equal(
    state.runs.find((candidate) => candidate.run.id === queued.run.id)
      ?.pendingAdmission,
    undefined
  );
  assert.equal(
    await yolo.expirePendingAdmission(
      { generation: 1, runId: queued.run.id, token: "stale" },
      { id: "pending-admission-2" }
    ),
    true
  );
  assert.notEqual(yolo.getRun(queued.run.id), null);
});

test("admission capability lookup failure leaves the provisional run pending", async () => {
  const yolo = new YoloAgent(
    undefined as never,
    {
      RunAdmission: {
        getByName: () => ({
          getCleanupCapability: () => {
            throw new Error("admission lookup unavailable");
          },
        }),
      },
    } as never
  );
  yolo.configure(definition());
  const queued = await yolo.enqueue(
    { operationId: OP_A, task: "Retry admission safely." },
    "4f2a0f4e-1f4d-4a2e-9c1b-7d2f5f4d4a33",
    "retry-hash",
    "identity"
  );

  await assert.rejects(
    () => yolo.confirmAdmission(queued.run.id, OP_A, "retry-hash"),
    (error: unknown) =>
      error instanceof Error && error.name === "AdmissionUnavailableError"
  );
  const state = Reflect.get(yolo, "state") as {
    runs: CloudRunRecord[];
  };
  const record = state.runs.find(
    (candidate) => candidate.run.id === queued.run.id
  );
  assert.ok(record?.pendingAdmission);
  assert.equal(record?.admissionConfirmedAt, undefined);
  assert.equal(record?.admissionCapability, undefined);
});

test("stale admission confirmation cannot resurrect a decommissioned run", async () => {
  let lookupStarted!: () => void;
  let finishLookup!: (
    capability: Awaited<ReturnType<typeof testAdmissionCapability>>
  ) => void;
  const started = new Promise<void>((resolve) => {
    lookupStarted = resolve;
  });
  const lookup = new Promise<
    Awaited<ReturnType<typeof testAdmissionCapability>>
  >((resolve) => {
    finishLookup = resolve;
  });
  const yolo = new YoloAgent(
    undefined as never,
    {
      RunAdmission: {
        getByName: () => ({
          getCleanupCapability: () => {
            lookupStarted();
            return lookup;
          },
        }),
      },
    } as never
  );
  yolo.configure(definition());
  const queued = await yolo.enqueue(
    { operationId: OP_A, task: "Do not resurrect me." },
    "4f2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c94",
    "stale-decommission-hash",
    "identity"
  );

  const confirmation = yolo.confirmAdmission(
    queued.run.id,
    OP_A,
    "stale-decommission-hash"
  );
  await started;
  const state = Reflect.get(yolo, "state") as Record<string, unknown> & {
    lifecycle: { generation: number; status: string };
  };
  yolo.setState({
    ...state,
    definition: null,
    lifecycle: {
      generation: state.lifecycle.generation + 1,
      status: "decommissioned",
    },
    runs: [],
  } as never);
  finishLookup(
    await testAdmissionCapability(queued.run.id, {
      agentId: AGENT_ID,
      operationId: OP_A,
      requestHash: "stale-decommission-hash",
    })
  );

  assert.deepEqual(await confirmation, { kind: "lifecycle_pending" });
  assert.equal(yolo.getRun(queued.run.id), null);
});

test("stale admission confirmation cannot resurrect an orphan timed out during lookup", async () => {
  let lookupStarted!: () => void;
  let finishLookup!: (
    capability: Awaited<ReturnType<typeof testAdmissionCapability>>
  ) => void;
  const started = new Promise<void>((resolve) => {
    lookupStarted = resolve;
  });
  const lookup = new Promise<
    Awaited<ReturnType<typeof testAdmissionCapability>>
  >((resolve) => {
    finishLookup = resolve;
  });
  const yolo = new YoloAgent(
    undefined as never,
    {
      RunAdmission: {
        getByName: () => ({
          getCleanupCapability: () => {
            lookupStarted();
            return lookup;
          },
        }),
      },
    } as never
  );
  yolo.configure(definition());
  const queued = await yolo.enqueue(
    { operationId: OP_B, task: "Time out while looking up." },
    "4f2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c95",
    "stale-orphan-hash",
    "identity"
  );

  const confirmation = yolo.confirmAdmission(
    queued.run.id,
    OP_B,
    "stale-orphan-hash"
  );
  await started;
  const state = Reflect.get(yolo, "state") as {
    runs: CloudRunRecord[];
  };
  yolo.setState({
    ...state,
    runs: state.runs.filter((candidate) => candidate.run.id !== queued.run.id),
  } as never);
  finishLookup(
    await testAdmissionCapability(queued.run.id, {
      agentId: AGENT_ID,
      operationId: OP_B,
      requestHash: "stale-orphan-hash",
    })
  );

  assert.equal((await confirmation).kind, "stale_provisional");
  assert.equal(yolo.getRun(queued.run.id), null);
});

test("a direct startAdmitted RPC without an active admission is rejected", async () => {
  resetFiberLog();
  const yolo = new YoloAgent(undefined as never, {} as never);
  yolo.configure(definition());
  const queued = await yolo.enqueue(
    { operationId: OP_A, task: "Bypass admission." },
    "9f2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c96",
    "hash-bypass",
    "identity"
  );

  assert.equal(
    await yolo.startAdmitted(queued.run.id, "1:forged-dispatch"),
    false
  );
  assert.equal(yolo.getRun(queued.run.id)?.status, "queued");
  assert.equal(fiberLog.started.length, 0);
});

test("legacy pre-Task8 state stays active for lifecycle operations", async () => {
  const configured = legacyAgent().configure({
    ...definition(),
    name: "Legacy configured",
  });
  assert.equal(configured.name, "Legacy configured");

  const enqueued = await legacyAgent().enqueue(
    { operationId: OP_A, task: "Legacy enqueue." },
    "3f2a0f4e-1f4d-4a2e-9c1b-7d2f5f4d4a2e",
    "legacy-enqueue",
    "identity"
  );
  assert.equal(enqueued.created, true);

  const started = await admittedStart(
    legacyAgent(),
    { operationId: OP_B, task: "Legacy start." },
    "identity"
  );
  assert.equal(started.created, true);
  assert.equal(started.run.status, "running");

  const warmed = await legacyAgent().warm();
  assert.equal(warmed.status, "provisioning");
});

test("legacy state without decommission fields can still be decommissioned safely", async () => {
  const yolo = legacyAgent();

  await yolo.decommission();

  assert.equal(yolo.snapshot(), null);
  const state = Reflect.get(yolo, "state") as {
    lifecycle: { status: string };
  };
  assert.equal(state.lifecycle.status, "decommissioned");
});

test("legacy stored definitions without warm state normalize on snapshot", () => {
  const yolo = agent();
  const state = Reflect.get(yolo, "state") as {
    definition: AgentDefinition;
  };
  const { owner: _owner, warm: _warm, ...legacyDefinition } = state.definition;
  yolo.setState({ ...state, definition: legacyDefinition } as never);

  assert.deepEqual(yolo.snapshot()?.owner, { kind: "standalone" });
  assert.deepEqual(yolo.snapshot()?.warm, {
    status: "not_started",
    updatedAt: legacyDefinition.updatedAt,
  });
});

test("worker persistence boundaries reject new legacy runtime definitions", () => {
  const legacy = { ...definition(), runtime: "cloud" as const };

  assert.throws(() => directory().upsert(legacy));
  assert.throws(() => agent().configure(legacy));
});

test("stopping an absent run does not require a decommissioned definition", async () => {
  const yolo = new YoloAgent(undefined as never, {} as never);
  const state = Reflect.get(yolo, "state") as Record<string, unknown> & {
    lifecycle: { generation: number; status: string };
  };
  yolo.setState({
    ...state,
    definition: null,
    lifecycle: {
      generation: state.lifecycle.generation + 1,
      status: "decommissioned",
    },
    runs: [],
  } as never);

  assert.equal(await yolo.stop("missing-after-decommission"), null);
});

test("admission accepts a run and dispatches one fiber", async () => {
  const yolo = agent();

  const started = await admittedStart(
    yolo,
    { operationId: OP_A, task: "Fix tests." },
    "identity"
  );

  assert.equal(started.created, true);
  assert.equal(started.run.status, "running");
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

  const first = await admittedStart(
    yolo,
    { operationId: OP_A, task: "Fix tests." },
    "identity"
  );
  const second = await admittedStart(
    yolo,
    { operationId: OP_A, task: "Fix tests." },
    "identity"
  );

  assert.equal(second.run.id, first.run.id);
  assert.equal(second.created, false, "a replay must not create a new run");
  assert.equal(fiberLog.started.length, 1, "no second fiber may be dispatched");
});

test("reusing an operation id for a different task is a conflict", async () => {
  const yolo = agent();
  await admittedStart(
    yolo,
    { operationId: OP_A, task: "Fix tests." },
    "identity"
  );

  await assert.rejects(
    () =>
      admittedStart(
        yolo,
        { operationId: OP_A, task: "Something else." },
        "identity"
      ),
    OperationConflictError
  );
});

test("a second concurrent run is refused", async () => {
  const yolo = agent();
  await admittedStart(
    yolo,
    { operationId: OP_A, task: "Fix tests." },
    "identity"
  );

  await assert.rejects(
    () =>
      admittedStart(
        yolo,
        { operationId: OP_B, task: "Another job." },
        "identity"
      ),
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
    yolo.startAdmitted(first.run.id, "1:first"),
    yolo.startAdmitted(second.run.id, "2:second"),
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
  const state = Reflect.get(yolo, "state") as {
    admissionTokens?: Record<string, string>;
    runs: CloudRunRecord[];
  };
  const losing = state.runs.find(
    (candidate) => candidate.run.id === second.run.id
  );
  assert.equal(losing?.dispatchToken, undefined);
  assert.equal(state.admissionTokens?.[second.run.id], undefined);
});

test("a busy admitted dispatch is proven not started before its token is persisted", async () => {
  resetDestroyedSandboxes();
  const yolo = agent();
  const active = await yolo.enqueue(
    { operationId: OP_A, task: "Active work." },
    "3f2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90",
    "hash-active",
    "identity"
  );
  assert.equal(await yolo.startAdmitted(active.run.id, "1:active"), true);

  const queued = await yolo.enqueue(
    { operationId: OP_B, task: "Queued work." },
    "4f2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c91",
    "hash-queued",
    "identity"
  );

  await assert.rejects(
    () => yolo.startAdmitted(queued.run.id, "2:queued"),
    (error: unknown) =>
      error instanceof AlreadyRunningError &&
      error instanceof Error &&
      error.name === "AgentBusyError" &&
      (error as Error & { code?: string; provenNotStarted?: boolean }).code ===
        "agent_busy" &&
      (error as Error & { code?: string; provenNotStarted?: boolean })
        .provenNotStarted === true
  );

  const state = Reflect.get(yolo, "state") as {
    admissionFences?: Record<string, unknown>;
    admissionTokens?: Record<string, string>;
    dispatchClaims?: Record<string, string>;
    runs: CloudRunRecord[];
  };
  const stillQueued = state.runs.find(
    (candidate) => candidate.run.id === queued.run.id
  );
  assert.equal(stillQueued?.run.status, "queued");
  assert.equal(stillQueued?.dispatchToken, undefined);
  assert.equal(state.admissionTokens?.[queued.run.id], undefined);
  assert.equal(state.dispatchClaims?.[queued.run.id], undefined);
  assert.equal(state.admissionFences?.[queued.run.id], undefined);
  assert.deepEqual(destroyedSandboxes(), []);

  const stopped = await yolo.stop(queued.run.id);
  assert.equal(stopped?.status, "cancelled");
  assert.deepEqual(destroyedSandboxes(), []);
});

test("a fenced and requeued dispatch cannot resume after sandbox ownership wait", async () => {
  resetFiberLog();
  resetDestroyedSandboxes();
  fiberControl.runFibers = false;
  let releaseCancellation!: () => void;
  const cancellation = new Promise<void>((resolve) => {
    releaseCancellation = resolve;
  });
  let cancellationStarted!: () => void;
  const cancellationReady = new Promise<void>((resolve) => {
    cancellationStarted = resolve;
  });
  const yolo = new (class extends YoloAgent {
    override cancelFiberByKey(
      idempotencyKey: string,
      _reason?: string
    ): Promise<boolean> {
      if (idempotencyKey.startsWith("warm")) {
        cancellationStarted();
        return cancellation.then(() => true);
      }
      return Promise.resolve(true);
    }
  })(undefined as never, admissionTestEnv() as never);
  yolo.configure(definition());

  const queued = await yolo.enqueue(
    { operationId: OP_A, task: "Fenced while waiting." },
    "4f2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90",
    "hash-fenced-wait",
    "identity"
  );
  const state = Reflect.get(yolo, "state") as {
    definition: AgentDefinition | null;
    dispatchClaims?: Record<string, string>;
    identityTokens?: Record<string, string>;
    lifecycle: {
      generation: number;
      status: "active" | "decommissioning" | "decommissioned";
    };
    runs: CloudRunRecord[];
  };
  const current = state.runs.find(
    (candidate) => candidate.run.id === queued.run.id
  );
  assert.ok(current);
  const dispatchToken = "1:fenced-wait";
  yolo.setState({
    ...state,
    sandbox: { generation: 1, owner: "warm:waiting" },
  } as never);

  const starting = yolo.startAdmitted(queued.run.id, dispatchToken);
  await cancellationReady;

  assert.equal(yolo.fenceAdmitted(queued.run.id, dispatchToken), true);
  assert.equal(yolo.requeueAdmitted(queued.run.id, dispatchToken), true);
  releaseCancellation();

  await assert.rejects(
    () => starting,
    (error: unknown) =>
      error instanceof AgentBusyError && error.provenNotStarted === true
  );
  assert.equal(fiberLog.started.length, 0);
  assert.equal(yolo.getRun(queued.run.id)?.status, "queued");
  const after = Reflect.get(yolo, "state") as {
    admissionTokens?: Record<string, string>;
    dispatchClaims?: Record<string, string>;
    runs: CloudRunRecord[];
  };
  const stillQueued = after.runs.find(
    (candidate) => candidate.run.id === queued.run.id
  );
  assert.equal(stillQueued?.dispatchToken, undefined);
  assert.equal(after.admissionTokens?.[queued.run.id], undefined);
  assert.equal(after.dispatchClaims?.[queued.run.id], undefined);
  assert.equal(destroyedSandboxes().length, 1);
});

test("cancellation during drive sandbox wait clears ownership before the next run", async () => {
  resetFiberLog();
  resetDestroyedSandboxes();
  fiberControl.runFibers = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ credential: "secret" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      })
    )) as typeof fetch;
  let releaseWarm!: () => void;
  const warmCancellation = new Promise<void>((resolve) => {
    releaseWarm = resolve;
  });
  let warmCancellationStarted!: () => void;
  const warmCancellationReady = new Promise<void>((resolve) => {
    warmCancellationStarted = resolve;
  });
  let injectWarmOwner = true;
  let runFiber!: Promise<void>;
  let runController!: AbortController;
  const yolo = new (class extends YoloAgent {
    override startFiber(
      _name: string,
      fn: Parameters<YoloAgent["startFiber"]>[1]
    ): ReturnType<YoloAgent["startFiber"]> {
      runController = new AbortController();
      if (injectWarmOwner) {
        const state = Reflect.get(this, "state") as {
          definition: AgentDefinition | null;
          lifecycle: {
            generation: number;
            status: "active" | "decommissioning" | "decommissioned";
          };
          runs: CloudRunRecord[];
          sandbox?: { generation: number; owner?: string };
        };
        this.setState({
          ...state,
          sandbox: { generation: 1, owner: "warm:waiting" },
        });
      }
      runFiber = fn({
        id: "fiber:ownership-wait",
        signal: runController.signal,
        snapshot: null,
        stash: () => undefined,
      });
      return Promise.resolve({
        accepted: true,
        createdAt: Date.now(),
        fiberId: "fiber:ownership-wait",
        name: "run:ownership-wait",
        status: "running",
      });
    }

    override cancelFiberByKey(
      idempotencyKey: string,
      reason?: string
    ): Promise<boolean> {
      if (idempotencyKey.startsWith("warm")) {
        runController.abort(reason);
        warmCancellationStarted();
        return warmCancellation.then(() => true);
      }
      return Promise.resolve(true);
    }
  })(
    undefined as never,
    {
      APP_ORIGIN: "https://runner.test",
      RUNNER_SERVICE_TOKEN: "service-token",
      RunAdmission: {
        getByName: () => ({
          getCleanupCapability: testAdmissionCapability,
          release: () => Promise.resolve(true),
          validateDispatch: () => Promise.resolve(true),
        }),
      },
      Sandbox: {},
    } as never
  );
  yolo.configure(definition());

  try {
    const first = await yolo.enqueue(
      { operationId: OP_A, task: "Cancel while acquiring ownership." },
      "4f2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c92",
      "ownership-cancel",
      "identity"
    );
    assert.equal(
      await yolo.startAdmitted(first.run.id, "1:ownership-cancel"),
      true
    );
    await warmCancellationReady;
    releaseWarm();
    await runFiber;

    const afterWait = Reflect.get(yolo, "state") as {
      sandbox?: { owner?: string };
    };
    assert.equal(afterWait.sandbox?.owner, undefined);
    assert.equal(yolo.getRun(first.run.id)?.status, "cancelled");

    assert.equal((await yolo.stop(first.run.id))?.status, "cancelled");
    injectWarmOwner = false;
    const second = await yolo.enqueue(
      { operationId: OP_B, task: "Proceed after cancellation." },
      "4f2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c93",
      "ownership-next",
      "identity"
    );
    assert.equal(
      await yolo.startAdmitted(second.run.id, "2:ownership-next"),
      true
    );
    await runFiber;
    assert.equal(yolo.getRun(second.run.id)?.status, "failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("queued identity capability survives agent rehydration without plaintext state", async () => {
  resetFiberLog();
  fiberControl.runFibers = false;
  const environment = {
    ...admissionTestEnv(),
    RUNNER_SERVICE_TOKEN: "runner-service-secret",
  };
  const first = new YoloAgent(undefined as never, environment as never);
  first.configure(definition());
  const queued = await first.enqueue(
    { operationId: OP_A, task: "Recover the queued identity." },
    "4f2a0f4e-1f4d-4a2e-9c1b-7d2f5f4d4a32",
    "queued-identity-hash",
    "identity-capability"
  );
  const firstState = Reflect.get(first, "state") as {
    identityCapabilities?: Record<string, { ciphertext: string; iv: string }>;
    identityTokens?: Record<string, string>;
  };
  assert.notEqual(
    firstState.identityCapabilities?.[queued.run.id]?.ciphertext,
    "identity-capability"
  );
  assert.equal(firstState.identityTokens?.[queued.run.id], undefined);

  const recovered = new YoloAgent(undefined as never, environment as never);
  recovered.setState(firstState as never);
  assert.equal(
    await recovered.startAdmitted(queued.run.id, "1:rehydrated-dispatch"),
    true
  );
  assert.equal(recovered.getRun(queued.run.id)?.status, "running");
  fiberControl.runFibers = false;
});

test("decommission during sandbox ownership wait cannot let the old start mutate state", async () => {
  resetFiberLog();
  resetDestroyedSandboxes();
  fiberControl.runFibers = false;
  let releaseCancellation!: () => void;
  const cancellation = new Promise<void>((resolve) => {
    releaseCancellation = resolve;
  });
  let cancellationStarted!: () => void;
  const cancellationReady = new Promise<void>((resolve) => {
    cancellationStarted = resolve;
  });
  let warmCancellationCalls = 0;
  const yolo = new (class extends YoloAgent {
    override cancelFiberByKey(
      idempotencyKey: string,
      _reason?: string
    ): Promise<boolean> {
      const firstWarmCancellation =
        idempotencyKey.startsWith("warm") && warmCancellationCalls === 0;
      warmCancellationCalls += 1;
      if (firstWarmCancellation) {
        cancellationStarted();
        return cancellation.then(() => true);
      }
      return Promise.resolve(true);
    }
  })(undefined as never, admissionTestEnv() as never);
  yolo.configure(definition());

  const queued = await yolo.enqueue(
    { operationId: OP_A, task: "Decommission while waiting." },
    "4f2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c91",
    "hash-decommission-wait",
    "identity"
  );
  const state = Reflect.get(yolo, "state") as {
    admissionTokens?: Record<string, string>;
    definition: AgentDefinition | null;
    runs: CloudRunRecord[];
  };
  const current = state.runs.find(
    (candidate) => candidate.run.id === queued.run.id
  );
  assert.ok(current);
  const dispatchToken = "1:decommission-wait";
  yolo.setState({
    ...state,
    admissionTokens: {
      ...(state.admissionTokens ?? {}),
      [queued.run.id]: dispatchToken,
    },
    runs: [
      { ...current, dispatchToken },
      ...state.runs.filter((candidate) => candidate.run.id !== queued.run.id),
    ],
    sandbox: { generation: 1, owner: "warm:waiting" },
  } as never);

  const starting = yolo.startAdmitted(queued.run.id, dispatchToken);
  await cancellationReady;
  const startingOutcome = starting.then(
    () => null,
    (error: unknown) => error
  );
  const decommissioning = yolo.decommission();
  releaseCancellation();

  const [startError] = await Promise.all([startingOutcome, decommissioning]);
  assert.ok(startError instanceof AgentBusyError);
  assert.equal((startError as AgentBusyError).provenNotStarted, true);
  assert.equal(fiberLog.started.length, 0);
  assert.equal(yolo.snapshot(), null);
  const after = Reflect.get(yolo, "state") as {
    lifecycle: { status: string };
    runs: CloudRunRecord[];
  };
  assert.equal(after.lifecycle.status, "decommissioned");
  assert.deepEqual(after.runs, []);
  assert.ok(destroyedSandboxes().length >= 1);
});

test("legacy start returns a retryable decommission result after sandbox cleanup wait", async () => {
  resetFiberLog();
  resetDestroyedSandboxes();
  fiberControl.runFibers = false;
  let releaseCancellation!: () => void;
  const cancellation = new Promise<void>((resolve) => {
    releaseCancellation = resolve;
  });
  let cancellationStarted!: () => void;
  const cancellationReady = new Promise<void>((resolve) => {
    cancellationStarted = resolve;
  });
  let warmCancellationCalls = 0;
  const yolo = new (class extends YoloAgent {
    override cancelFiberByKey(
      idempotencyKey: string,
      _reason?: string
    ): Promise<boolean> {
      const firstWarmCancellation =
        idempotencyKey.startsWith("warm") && warmCancellationCalls === 0;
      if (idempotencyKey.startsWith("warm")) {
        warmCancellationCalls += 1;
      }
      if (firstWarmCancellation) {
        cancellationStarted();
        return cancellation.then(() => true);
      }
      return Promise.resolve(true);
    }
  })(undefined as never, admissionTestEnv() as never);
  yolo.configure(definition());
  await yolo.warm();

  const starting = admittedStart(
    yolo,
    { operationId: OP_A, task: "Legacy cleanup race." },
    "identity"
  );
  await cancellationReady;
  const decommissioning = yolo.decommission();
  releaseCancellation();

  const [startError, decommissionError] = await Promise.all([
    starting.then(
      () => null,
      (error: unknown) => error
    ),
    decommissioning.then(
      () => null,
      (error: unknown) => error
    ),
  ]);
  assert.equal(decommissionError, null);
  assert.ok(startError instanceof AgentBusyError);
  assert.equal(startError?.provenNotStarted, true);
  assert.equal(
    fiberLog.started.some((entry) => entry.key.startsWith("run:")),
    false
  );
  assert.equal(yolo.snapshot(), null);
  assert.deepEqual(
    (Reflect.get(yolo, "state") as { runs: CloudRunRecord[] }).runs,
    []
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

test("an absent run still records a durable fence tombstone", async () => {
  const yolo = agent();
  const queued = await yolo.enqueue(
    { operationId: OP_A, task: "Missing run." },
    "3f2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90",
    "hash-absent",
    "identity"
  );
  const state = Reflect.get(yolo, "state") as {
    definition: AgentDefinition | null;
    identityTokens?: Record<string, string>;
    lifecycle: {
      generation: number;
      status: "active" | "decommissioning" | "decommissioned";
    };
    runs: CloudRunRecord[];
  };
  const current = state.runs.find(
    (candidate) => candidate.run.id === queued.run.id
  );
  assert.ok(current);
  yolo.setState({
    ...state,
    runs: [],
  });

  assert.equal(await yolo.fenceAdmitted(queued.run.id, "4:old"), true);

  const fencedState = Reflect.get(yolo, "state") as typeof state;
  yolo.setState({
    ...fencedState,
    runs: [
      {
        ...current,
        run: { ...current.run, status: "queued" },
      },
    ],
  });
  assert.equal(await yolo.startAdmitted(queued.run.id, "4:late"), false);
  assert.equal(await yolo.startAdmitted(queued.run.id, "5:new"), true);
});

test("admission fence tombstones remain bounded", () => {
  const yolo = agent();
  const state = Reflect.get(yolo, "state") as {
    definition: AgentDefinition | null;
    identityTokens?: Record<string, string>;
    runs: CloudRunRecord[];
  };

  for (let index = 0; index < 160; index += 1) {
    assert.equal(
      yolo.fenceAdmitted(`absent-${index}`, `${index + 1}:old`),
      true
    );
  }

  const fencedState = Reflect.get(yolo, "state") as typeof state & {
    admissionFences?: Record<string, unknown>;
  };
  assert.ok(
    Object.keys(fencedState.admissionFences ?? {}).length <= 128,
    "absent-run fence tombstones must have a hard bound"
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
    () => yolo.startAdmitted(queued.run.id, "1:busy"),
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
          getCleanupCapability: testAdmissionCapability,
          release: (runId: string) => {
            released.push(runId);
            return Promise.resolve(true);
          },
          validateDispatch: () => Promise.resolve(true),
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
    () => yolo.startAdmitted(first.run.id, "1:recovery"),
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
  assert.equal(await yolo.startAdmitted(second.run.id, "2:recovery"), true);
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
  })(undefined as never, admissionTestEnv() as never);
  yolo.configure(definition());
  const queued = await yolo.enqueue(
    { operationId: OP_A, task: "Already accepted work." },
    "8f2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c95",
    "hash-already-accepted",
    "identity"
  );

  assert.equal(
    await yolo.startAdmitted(queued.run.id, "1:already-accepted"),
    false
  );
  assert.equal(yolo.getRun(queued.run.id)?.status, "running");
  assert.equal(fiberLog.started.length, 0);
});

test("a persisted starting intent recovers the same fiber exactly once", async () => {
  resetFiberLog();
  fiberControl.runFibers = false;
  const environment = {
    ...admissionTestEnv(),
    RUNNER_SERVICE_TOKEN: "runner-secret",
  };
  const first = new YoloAgent(undefined as never, environment as never);
  first.configure(definition());
  const prepared = await first.enqueue(
    { operationId: OP_A, task: "Recover before fiber acceptance." },
    "8f2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c96",
    "hash-dispatch-intent",
    "identity"
  );
  const record = first.getRun(prepared.run.id);
  assert.ok(record);
  const { claimRunStart } = first as unknown as {
    claimRunStart: (planned: CloudRunRecord) => CloudRunRecord;
  };
  const firstState = Reflect.get(first, "state") as {
    runs: CloudRunRecord[];
  };
  const tokenized = firstState.runs.map((candidate) =>
    candidate.run.id === prepared.run.id
      ? { ...candidate, dispatchToken: "1:dispatch-intent" }
      : candidate
  );
  first.setState({ ...firstState, runs: tokenized } as never);
  claimRunStart.call(
    first,
    tokenized.find(
      (candidate) => candidate.run.id === prepared.run.id
    ) as CloudRunRecord
  );
  const persisted = structuredClone(
    Reflect.get(first, "state") as Record<string, unknown>
  );
  const recovered = new YoloAgent(undefined as never, environment as never);
  recovered.setState(persisted as never);
  const recoveredState = Reflect.get(recovered, "state") as {
    dispatchIntents?: Record<
      string,
      { fiberKey: string; phase: string; dispatchToken?: string }
    >;
  };
  assert.deepEqual(recoveredState.dispatchIntents?.[prepared.run.id], {
    dispatchToken: "1:dispatch-intent",
    fiberKey: cloudFiberKey(prepared.run.id),
    phase: "starting",
  });

  assert.equal(
    await recovered.ensureAdmittedFiber(prepared.run.id, "1:dispatch-intent"),
    true
  );
  assert.deepEqual(fiberLog.started, [
    {
      key: cloudFiberKey(prepared.run.id),
      name: cloudFiberKey(prepared.run.id),
    },
  ]);
  assert.equal(
    (
      Reflect.get(recovered, "state") as {
        dispatchIntents: Record<string, { phase: string }>;
      }
    ).dispatchIntents[prepared.run.id]?.phase,
    "fiber_started"
  );
  assert.equal(
    await recovered.ensureAdmittedFiber(prepared.run.id, "1:dispatch-intent"),
    true
  );
  assert.equal(
    fiberLog.started.filter(({ key }) => key === cloudFiberKey(prepared.run.id))
      .length,
    1
  );
});

test("legacy starting-intent recovery fails safely before identity, fiber, credential, or provider work", async () => {
  resetFiberLog();
  resetDestroyedSandboxes();
  fiberControl.runFibers = false;
  let identityReads = 0;
  let releases = 0;
  const environment = {
    RUNNER_SERVICE_TOKEN: "runner-secret",
    RunAdmission: {
      getByName: () => ({
        release: () => {
          releases += 1;
          return Promise.resolve(true);
        },
      }),
    },
  };
  const yolo = new YoloAgent(undefined as never, environment as never);
  yolo.configure(definition());
  const prepared = await yolo.enqueue(
    { operationId: OP_B, task: "Recover no legacy work." },
    "8f2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c97",
    "hash-legacy-dispatch-intent",
    "identity"
  );
  const state = Reflect.get(yolo, "state") as { runs: CloudRunRecord[] };
  const tokenized = state.runs.map((candidate) =>
    candidate.run.id === prepared.run.id
      ? { ...candidate, dispatchToken: "1:legacy-dispatch-intent" }
      : candidate
  );
  yolo.setState({ ...state, runs: tokenized } as never);
  const { claimRunStart } = yolo as unknown as {
    claimRunStart: (planned: CloudRunRecord) => CloudRunRecord;
  };
  claimRunStart.call(
    yolo,
    tokenized.find(
      (candidate) => candidate.run.id === prepared.run.id
    ) as CloudRunRecord
  );
  const originalReadIdentity = Reflect.get(yolo, "readIdentityToken") as (
    runId: string
  ) => Promise<string | null>;
  Reflect.set(yolo, "readIdentityToken", async (runId: string) => {
    identityReads += 1;
    return await originalReadIdentity.call(yolo, runId);
  });
  setLegacyRuntime(yolo);

  assert.equal(
    await yolo.ensureAdmittedFiber(prepared.run.id, "1:legacy-dispatch-intent"),
    false
  );

  const failed = yolo.getRun(prepared.run.id);
  assert.equal(failed?.status, "failed");
  assert.deepEqual(failed?.error, {
    code: "harness_unsupported",
    message: "Cloud agents must select a supported harness runtime: copilot.",
    retryable: false,
  });
  assert.equal(identityReads, 0);
  assert.equal(releases, 1);
  assert.equal(fiberLog.started.length, 0);
  assert.equal(sandboxGetCount(), 0);
});

test("legacy recovered fibers terminalize without sandbox cleanup or provider work", async () => {
  resetFiberLog();
  resetDestroyedSandboxes();
  fiberControl.runFibers = false;
  const released: string[] = [];
  const yolo = new YoloAgent(
    undefined as never,
    {
      RunAdmission: {
        getByName: () => ({
          getCleanupCapability: testAdmissionCapability,
          release: (runId: string) => {
            released.push(runId);
            return Promise.resolve(true);
          },
          validateDispatch: () => Promise.resolve(true),
        }),
      },
    } as never
  );
  yolo.configure(definition());
  const prepared = await yolo.enqueue(
    { operationId: OP_A, task: "Recover no legacy fiber." },
    "9f2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c98",
    "hash-legacy-recovered-fiber",
    "identity"
  );
  assert.equal(
    await yolo.startAdmitted(prepared.run.id, "1:legacy-recovered-fiber"),
    true
  );
  setLegacyRuntime(yolo);
  const startedFibers = fiberLog.started.length;

  const result = await yolo.onFiberRecovered({
    createdAt: Date.now(),
    id: "legacy-recovered-fiber",
    metadata: {
      dispatchToken: "1:legacy-recovered-fiber",
      runId: prepared.run.id,
    },
    name: cloudFiberKey(prepared.run.id),
    recoveryReason: "interrupted",
    snapshot: null,
    status: "interrupted",
  });

  assert.deepEqual(result, {
    error: "Cloud agents must select a supported harness runtime: copilot.",
    status: "error",
  });
  assert.deepEqual(yolo.getRun(prepared.run.id)?.error, {
    code: "harness_unsupported",
    message: "Cloud agents must select a supported harness runtime: copilot.",
    retryable: false,
  });
  assert.deepEqual(released, [prepared.run.id]);
  assert.equal(fiberLog.started.length, startedFibers);
  assert.deepEqual(destroyedSandboxes(), []);
  assert.equal(sandboxGetCount(), 0);
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
          getCleanupCapability: testAdmissionCapability,
          release: (runId: string) => {
            released.push(runId);
            return Promise.resolve(true);
          },
          validateDispatch: () => Promise.resolve(true),
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
  assert.equal(await yolo.startAdmitted(first.run.id, "1:recovered"), true);

  const recovery = {
    createdAt: Date.parse("2026-08-26T00:00:00.000Z"),
    id: "fiber-interrupted",
    metadata: { dispatchToken: "1:recovered", runId: first.run.id },
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
  assert.equal(await yolo.startAdmitted(second.run.id, "2:recovered"), true);
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
          getCleanupCapability: testAdmissionCapability,
          release: (runId: string) => {
            released.push(runId);
            return Promise.resolve(true);
          },
          validateDispatch: () => Promise.resolve(true),
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
  assert.equal(await yolo.startAdmitted(queued.run.id, "1:recovery"), true);

  await assert.rejects(
    () =>
      yolo.onFiberRecovered({
        createdAt: Date.now(),
        id: "fiber-interrupted",
        metadata: { dispatchToken: "1:recovery", runId: queued.run.id },
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

test("a post-claim agent-busy error settles the run and releases admission", async () => {
  resetFiberLog();
  fiberControl.runFibers = false;
  let runFiber!: Promise<void>;
  let yolo!: YoloAgent;
  const released: string[] = [];
  const originalFetch = globalThis.fetch;
  yolo = new (class extends YoloAgent {
    override startFiber(
      _name: string,
      fn: Parameters<YoloAgent["startFiber"]>[1]
    ): ReturnType<YoloAgent["startFiber"]> {
      runFiber = fn({
        id: "fiber:post-claim-busy",
        signal: new AbortController().signal,
        snapshot: null,
        stash: () => undefined,
      });
      return Promise.resolve({
        accepted: true,
        createdAt: Date.now(),
        fiberId: "fiber:post-claim-busy",
        name: "run:post-claim-busy",
        status: "running",
      });
    }
  })(
    undefined as never,
    {
      APP_ORIGIN: "https://runner.test",
      RUNNER_SERVICE_TOKEN: "service-token",
      RunAdmission: {
        getByName: () => ({
          getCleanupCapability: testAdmissionCapability,
          release: (runId: string) => {
            released.push(runId);
            return Promise.resolve(true);
          },
          validateDispatch: () => Promise.resolve(true),
        }),
      },
      Sandbox: {},
    } as never
  );
  yolo.configure(definition());
  globalThis.fetch = (() => {
    const state = Reflect.get(yolo, "state") as {
      runs: CloudRunRecord[];
    };
    yolo.setState({
      ...state,
      sandbox: {
        generation: 1,
        owner: "run:other",
        runId: "other-run",
      },
    } as never);
    return Promise.resolve(
      new Response(JSON.stringify({ credential: "secret" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      })
    );
  }) as typeof fetch;

  try {
    const queued = await yolo.enqueue(
      { operationId: OP_A, task: "Busy after claim." },
      "b42a0f4e-1f4d-4a2e-9c1b-7d2f5f4d4a33",
      "busy-after-claim",
      "identity"
    );
    assert.equal(
      await yolo.startAdmitted(queued.run.id, "1:busy-after-claim"),
      true
    );
    await runFiber;

    assert.equal(yolo.getRun(queued.run.id)?.status, "failed");
    assert.deepEqual(released, [queued.run.id]);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
          getCleanupCapability: testAdmissionCapability,
          release: (runId: string) => {
            released.push(runId);
            return Promise.resolve(true);
          },
          validateDispatch: () => Promise.resolve(true),
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
  assert.equal(await yolo.startAdmitted(first.run.id, "1:probe-cleanup"), true);

  await assert.rejects(() => yolo.stop(first.run.id), /sandbox unavailable/);
  assert.equal(yolo.getRun(first.run.id)?.status, "running");
  assert.deepEqual(released, []);

  setSandboxDestroyError(null);
  const cancelled = await yolo.stop(first.run.id);
  assert.equal(cancelled?.status, "cancelled");
  assert.deepEqual(released, [first.run.id]);
});

test("initial probe destroy failure keeps admission active until cleanup succeeds", async () => {
  resetFiberLog();
  resetDestroyedSandboxes();
  fiberControl.runFibers = false;
  setSandboxDestroyError(new Error("probe cleanup unavailable"));
  const originalFetch = globalThis.fetch;
  let probeStarted!: () => void;
  const probe = new Promise<void>((resolve) => {
    probeStarted = resolve;
  });
  setSandboxExec(() => {
    probeStarted();
    return new Promise<never>(() => undefined);
  });
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ credential: "secret" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      })
    )) as typeof fetch;

  let runFiber!: Promise<void>;
  let runController!: AbortController;
  const released: string[] = [];
  const yolo = new (class extends YoloAgent {
    override startFiber(
      _name: string,
      fn: Parameters<YoloAgent["startFiber"]>[1]
    ): ReturnType<YoloAgent["startFiber"]> {
      runController = new AbortController();
      runFiber = fn({
        id: "fiber:probe-cleanup",
        signal: runController.signal,
        snapshot: null,
        stash: () => undefined,
      });
      return Promise.resolve({
        accepted: true,
        createdAt: Date.now(),
        fiberId: "fiber:probe-cleanup",
        name: "run:probe-cleanup",
        status: "running",
      });
    }

    override cancelFiberByKey(
      _idempotencyKey: string,
      reason?: string
    ): Promise<boolean> {
      runController.abort(reason);
      return Promise.resolve(true);
    }
  })(
    undefined as never,
    {
      APP_ORIGIN: "https://runner.test",
      RUNNER_SERVICE_TOKEN: "service-token",
      RunAdmission: {
        getByName: () => ({
          getCleanupCapability: testAdmissionCapability,
          release: (runId: string) => {
            released.push(runId);
            return Promise.resolve(true);
          },
          validateDispatch: () => Promise.resolve(true),
        }),
      },
      Sandbox: {},
    } as never
  );
  yolo.configure(definition());

  try {
    const first = await yolo.enqueue(
      { operationId: OP_A, task: "Probe cleanup failure." },
      "a42a0f4e-1f4d-4a2e-9c1b-7d2f5f4d4a31",
      "probe-cleanup-failure",
      "identity"
    );
    assert.equal(
      await yolo.startAdmitted(first.run.id, "4:probe-cleanup"),
      true
    );
    await probe;
    const fiberFailure = runFiber.catch((error) => error);

    await assert.rejects(
      () => yolo.stop(first.run.id),
      /probe cleanup unavailable/
    );
    await fiberFailure;
    assert.equal(yolo.getRun(first.run.id)?.status, "running");
    assert.deepEqual(released, []);

    const next = await yolo.enqueue(
      { operationId: OP_B, task: "Must wait." },
      "a52a0f4e-1f4d-4a2e-9c1b-7d2f5f4d4a32",
      "probe-cleanup-next",
      "identity"
    );
    await assert.rejects(
      () => yolo.startAdmitted(next.run.id, "5:probe-cleanup-next"),
      AgentBusyError
    );
    assert.equal(yolo.getRun(next.run.id)?.status, "queued");

    setSandboxDestroyError(null);
    const cancelled = await yolo.stop(first.run.id);
    assert.equal(cancelled?.status, "cancelled");
    assert.deepEqual(released, [first.run.id]);
  } finally {
    globalThis.fetch = originalFetch;
    setSandboxDestroyError(null);
    setSandboxExec(() =>
      Promise.reject(new Error("sandbox exec is not configured"))
    );
  }
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
          getCleanupCapability: testAdmissionCapability,
          release: (runId: string) => {
            released.push(runId);
            return Promise.resolve(true);
          },
          validateDispatch: () => Promise.resolve(true),
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
  assert.equal(
    await yolo.startAdmitted(queued.run.id, "1:terminal-report"),
    true
  );

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

test("a credential that resolves after stop cannot resurrect sandbox execution", async () => {
  resetFiberLog();
  resetDestroyedSandboxes();
  fiberControl.runFibers = false;
  const originalFetch = globalThis.fetch;
  let resolveCredential!: (response: Response) => void;
  const credential = new Promise<Response>((resolve) => {
    resolveCredential = resolve;
  });
  globalThis.fetch = (() => credential) as typeof fetch;
  let lateFiber: Promise<void> | undefined;
  const yolo = new (class extends YoloAgent {
    override startFiber(
      _name: string,
      fn: Parameters<YoloAgent["startFiber"]>[1]
    ): ReturnType<YoloAgent["startFiber"]> {
      lateFiber = fn({
        id: "fiber:delayed-credential",
        signal: new AbortController().signal,
        snapshot: null,
        stash: () => undefined,
      });
      return Promise.resolve({
        accepted: true,
        createdAt: Date.now(),
        fiberId: "fiber:delayed-credential",
        name: "run:delayed-credential",
        status: "running",
      });
    }
  })(
    undefined as never,
    {
      APP_ORIGIN: "https://runner.test",
      RUNNER_SERVICE_TOKEN: "service-token",
      RunAdmission: {
        getByName: () => ({
          getCleanupCapability: testAdmissionCapability,
          release: () => Promise.resolve(true),
          validateDispatch: () => Promise.resolve(true),
        }),
      },
      Sandbox: {},
    } as never
  );
  yolo.configure(definition());
  try {
    const queued = await yolo.enqueue(
      { operationId: OP_A, task: "Delayed credential." },
      "df2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8ca0",
      "delayed-credential",
      "identity"
    );
    assert.equal(await yolo.startAdmitted(queued.run.id, "1:delayed"), true);
    await yolo.stop(queued.run.id);
    const getsAfterStop = sandboxGetCount();

    resolveCredential(
      new Response(JSON.stringify({ credential: "secret" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      })
    );
    await lateFiber;

    assert.equal(sandboxGetCount(), getsAfterStop);
    assert.equal(yolo.getRun(queued.run.id)?.status, "cancelled");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("aborting credential lookup records cancellation and releases admission once", async () => {
  resetFiberLog();
  resetDestroyedSandboxes();
  fiberControl.runFibers = false;
  const originalFetch = globalThis.fetch;
  let rejectCredential!: (error: unknown) => void;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      rejectCredential = reject;
      init?.signal?.addEventListener(
        "abort",
        () =>
          reject(
            Object.assign(new Error("lookup aborted"), { name: "AbortError" })
          ),
        { once: true }
      );
    })) as typeof fetch;
  let runFiber!: Promise<void>;
  let runController!: AbortController;
  const released: string[] = [];
  const yolo = new (class extends YoloAgent {
    override startFiber(
      _name: string,
      fn: Parameters<YoloAgent["startFiber"]>[1]
    ): ReturnType<YoloAgent["startFiber"]> {
      runController = new AbortController();
      runFiber = fn({
        id: "fiber:credential-abort",
        signal: runController.signal,
        snapshot: null,
        stash: () => undefined,
      });
      return Promise.resolve({
        accepted: true,
        createdAt: Date.now(),
        fiberId: "fiber:credential-abort",
        name: "run:credential-abort",
        status: "running",
      });
    }
  })(
    undefined as never,
    {
      APP_ORIGIN: "https://runner.test",
      RUNNER_SERVICE_TOKEN: "service-token",
      RunAdmission: {
        getByName: () => ({
          getCleanupCapability: testAdmissionCapability,
          release: (runId: string) => {
            released.push(runId);
            return Promise.resolve(true);
          },
          validateDispatch: () => Promise.resolve(true),
        }),
      },
      Sandbox: {},
    } as never
  );
  yolo.configure(definition());

  try {
    const queued = await yolo.enqueue(
      { operationId: OP_A, task: "Abort credential lookup." },
      "df2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8ca5",
      "credential-abort",
      "identity"
    );
    assert.equal(
      await yolo.startAdmitted(queued.run.id, "1:credential-abort"),
      true
    );

    runController.abort("cancel lookup");
    rejectCredential(
      Object.assign(new Error("lookup aborted"), { name: "AbortError" })
    );
    await runFiber;

    assert.equal(yolo.getRun(queued.run.id)?.status, "cancelled");
    assert.equal(yolo.getRun(queued.run.id)?.error, null);
    assert.deepEqual(released, [queued.run.id]);
    assert.equal((await yolo.stop(queued.run.id))?.status, "cancelled");
    assert.deepEqual(released, [queued.run.id]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("decommission fences delayed runs before cleanup and reset", async () => {
  resetFiberLog();
  resetDestroyedSandboxes();
  fiberControl.runFibers = false;
  const originalFetch = globalThis.fetch;
  let resolveCredential!: (response: Response) => void;
  const credential = new Promise<Response>((resolve) => {
    resolveCredential = resolve;
  });
  globalThis.fetch = (() => credential) as typeof fetch;
  let lateFiber: Promise<void> | undefined;
  const yolo = new (class extends YoloAgent {
    override startFiber(
      _name: string,
      fn: Parameters<YoloAgent["startFiber"]>[1]
    ): ReturnType<YoloAgent["startFiber"]> {
      lateFiber = fn({
        id: "fiber:decommissioned",
        signal: new AbortController().signal,
        snapshot: null,
        stash: () => undefined,
      });
      return Promise.resolve({
        accepted: true,
        createdAt: Date.now(),
        fiberId: "fiber:decommissioned",
        name: "run:decommissioned",
        status: "running",
      });
    }
  })(
    undefined as never,
    {
      APP_ORIGIN: "https://runner.test",
      RUNNER_SERVICE_TOKEN: "service-token",
      RunAdmission: {
        getByName: () => ({
          getCleanupCapability: testAdmissionCapability,
          release: () => Promise.resolve(true),
          validateDispatch: () => Promise.resolve(true),
        }),
      },
      Sandbox: {},
    } as never
  );
  yolo.configure(definition());
  try {
    const queued = await yolo.enqueue(
      { operationId: OP_A, task: "Decommissioned credential." },
      "ef2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8ca1",
      "decommissioned-credential",
      "identity"
    );
    assert.equal(
      await yolo.startAdmitted(queued.run.id, "1:decommission"),
      true
    );
    const decommissioning = yolo.decommission();
    await new Promise<void>((resolve) => setImmediate(resolve));
    resolveCredential(
      new Response(JSON.stringify({ credential: "secret" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      })
    );
    await decommissioning;
    await lateFiber;
    const getsAfterDecommission = sandboxGetCount();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(sandboxGetCount(), getsAfterDecommission);
    assert.equal(yolo.snapshot(), null);
    const state = Reflect.get(yolo, "state") as {
      lifecycle: { status: string };
      runs: CloudRunRecord[];
    };
    assert.equal(state.lifecycle.status, "decommissioned");
    assert.deepEqual(state.runs, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("decommission keeps terminal cleanup durable when admission release fails", async () => {
  resetFiberLog();
  resetDestroyedSandboxes();
  fiberControl.runFibers = false;
  let releaseAttempts = 0;
  let scheduleAttempts = 0;
  const yolo = new (class extends YoloAgent {
    schedule<T = string>(
      _when: Date | number | string,
      callback: keyof this,
      payload?: T
    ): Promise<{
      id: string;
      callback: string;
      payload: T;
      type: "scheduled";
      time: number;
    }> {
      scheduleAttempts += 1;
      return Promise.resolve({
        callback: String(callback),
        id: `decommission-retry-${scheduleAttempts}`,
        payload: payload as T,
        time: Date.now(),
        type: "scheduled",
      });
    }

    cancelSchedule(): Promise<boolean> {
      return Promise.resolve(true);
    }
  })(
    undefined as never,
    {
      RunAdmission: {
        getByName: () => ({
          getCleanupCapability: testAdmissionCapability,
          getRecord: () => Promise.resolve(null),
          release: () => {
            releaseAttempts += 1;
            if (releaseAttempts === 1) {
              return Promise.reject(
                new Error("release unavailable before apply")
              );
            }
            return Promise.resolve(true);
          },
          validateDispatch: () => Promise.resolve(true),
        }),
      },
    } as never
  );
  yolo.configure(definition());

  const queued = await yolo.enqueue(
    { operationId: OP_A, task: "Decommission durably." },
    "ee2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8ca3",
    "decommission-durable",
    "identity"
  );
  assert.equal(
    await yolo.startAdmitted(queued.run.id, "1:decommission-durable"),
    true
  );

  await assert.rejects(
    () => yolo.decommission(),
    (error: unknown) =>
      error instanceof AgentDecommissioningError && error.retryable === true
  );

  const pending = Reflect.get(yolo, "state") as {
    decommission?: {
      admissionReleases: Record<string, { dispatchToken?: string }>;
      retryScheduleId?: string;
    };
    lifecycle: { status: string };
    runs: CloudRunRecord[];
  };
  assert.equal(pending.lifecycle.status, "decommissioning");
  assert.equal(pending.runs[0]?.run.status, "cancelled");
  assert.deepEqual(pending.decommission?.admissionReleases[queued.run.id], {
    admissionSequence: 1,
    dispatchToken: "1:decommission-durable",
  });
  assert.equal(pending.decommission?.retryScheduleId, "decommission-retry-2");
  assert.equal(releaseAttempts, 1);

  await yolo.retryDecommission();

  const completed = Reflect.get(yolo, "state") as {
    lifecycle: { status: string };
    runs: CloudRunRecord[];
  };
  assert.equal(completed.lifecycle.status, "decommissioned");
  assert.equal(yolo.snapshot(), null);
  assert.deepEqual(completed.runs, []);
  assert.equal(releaseAttempts, 2);
  assert.equal(scheduleAttempts, 2);

  assert.equal(
    yolo.fenceAdmitted(queued.run.id, "4:stale-after-decommission"),
    true
  );
  const fenced = Reflect.get(yolo, "state") as {
    admissionFences?: Record<string, unknown>;
  };
  assert.ok(fenced.admissionFences?.[queued.run.id]);
});

test("configure rejects while decommissioning and accepts after completion", async () => {
  resetFiberLog();
  resetDestroyedSandboxes();
  fiberControl.runFibers = false;
  let releaseAttempts = 0;
  const yolo = new (class extends YoloAgent {
    schedule<T = string>(
      _when: Date | number | string,
      callback: keyof this,
      payload?: T
    ): Promise<{
      id: string;
      callback: string;
      payload: T;
      type: "scheduled";
      time: number;
    }> {
      return Promise.resolve({
        callback: String(callback),
        id: "configure-decommission-retry",
        payload: payload as T,
        time: Date.now(),
        type: "scheduled",
      });
    }

    cancelSchedule(): Promise<boolean> {
      return Promise.resolve(true);
    }
  })(
    undefined as never,
    {
      RunAdmission: {
        getByName: () => ({
          getCleanupCapability: testAdmissionCapability,
          getRecord: () => Promise.resolve(null),
          release: () => {
            releaseAttempts += 1;
            if (releaseAttempts === 1) {
              return Promise.reject(new Error("release unavailable"));
            }
            return Promise.resolve(true);
          },
          validateDispatch: () => Promise.resolve(true),
        }),
      },
    } as never
  );
  yolo.configure(definition());
  const queued = await yolo.enqueue(
    { operationId: OP_A, task: "Do not resurrect." },
    "ef2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8ca4",
    "configure-during-decommission",
    "identity"
  );
  await yolo.startAdmitted(queued.run.id, "1:configure");

  await assert.rejects(() => yolo.decommission(), AgentDecommissioningError);
  assert.throws(() => yolo.configure(definition()), AgentDecommissioningError);
  assert.equal(yolo.snapshot()?.name, "Cody");

  await yolo.retryDecommission();
  const updated = { ...definition(), name: "Reconfigured" };
  assert.equal(yolo.configure(updated).name, "Reconfigured");
  assert.equal(yolo.snapshot()?.name, "Reconfigured");
});

test("cloud workspace mutations are rejected before they are stored", () => {
  const yolo = agent();
  const invalid = {
    ...definition(),
    workspace: "/workspace/x; touch /tmp/pwn",
  };

  assert.throws(
    () => yolo.configure(invalid),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "HttpError" &&
      error.message.includes("only use the /workspace")
  );
  assert.equal(yolo.snapshot()?.workspace, undefined);
});

test("queued runs revalidate workspace before admitted dispatch", async () => {
  const yolo = agent();
  const prepared = await yolo.enqueue(
    {
      operationId: OP_A,
      task: "Create notes.md",
    },
    "run-workspace-mutation",
    "workspace-mutation",
    "identity"
  );
  const state = Reflect.get(yolo, "state") as {
    definition: AgentDefinition;
  };
  yolo.setState({
    ...state,
    definition: {
      ...state.definition,
      workspace: "/workspace/x; touch /tmp/pwn",
    },
  } as never);

  await assert.rejects(
    () => yolo.startAdmitted(prepared.run.id, "1:workspace-mutation"),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "HttpError" &&
      error.message.includes("only use the /workspace")
  );
  assert.equal(fiberLog.started.length, 0);
  assert.equal(yolo.getRun(prepared.run.id)?.status, "queued");
});

test("decommission persists cancel failures and retries all cleanup later", async () => {
  resetDestroyedSandboxes();
  fiberControl.runFibers = false;
  let cancelFailures = true;
  const cancelledFibers: string[] = [];
  let scheduleAttempts = 0;
  const yolo = new (class extends YoloAgent {
    override cancelFiberByKey(
      idempotencyKey: string,
      _reason?: string
    ): Promise<boolean> {
      cancelledFibers.push(idempotencyKey);
      return cancelFailures
        ? Promise.reject(new Error("fiber cancellation unavailable"))
        : Promise.resolve(true);
    }

    schedule<T = string>(
      _when: Date | number | string,
      callback: keyof this,
      payload?: T
    ): Promise<{
      id: string;
      callback: string;
      payload: T;
      type: "scheduled";
      time: number;
    }> {
      scheduleAttempts += 1;
      return Promise.resolve({
        callback: String(callback),
        id: `decommission-retry-${scheduleAttempts}`,
        payload: payload as T,
        time: Date.now(),
        type: "scheduled",
      });
    }

    cancelSchedule(): Promise<boolean> {
      return Promise.resolve(true);
    }
  })(undefined as never, { Sandbox: {} } as never);
  yolo.configure(definition());

  await assert.rejects(
    () => yolo.decommission(),
    (error: unknown) =>
      error instanceof AgentDecommissioningError && error.retryable === true
  );
  assert.deepEqual(cancelledFibers, ["warm"]);
  assert.deepEqual(destroyedSandboxes(), []);

  const pending = Reflect.get(yolo, "state") as {
    decommission?: {
      lastError?: string;
      retryScheduleId?: string;
    };
    lifecycle: { status: string };
  };
  assert.equal(pending.lifecycle.status, "decommissioning");
  assert.equal(
    pending.decommission?.lastError,
    "fiber cancellation unavailable"
  );
  assert.equal(pending.decommission?.retryScheduleId, "decommission-retry-1");

  cancelFailures = false;
  await yolo.retryDecommission();

  assert.deepEqual(cancelledFibers, ["warm", "warm"]);
  assert.equal(scheduleAttempts, 1);
  assert.equal(
    (Reflect.get(yolo, "state") as { lifecycle: { status: string } }).lifecycle
      .status,
    "decommissioned"
  );
});

test("consumed cleanup retry schedules rotate before each retry", async () => {
  resetDestroyedSandboxes();
  fiberControl.runFibers = false;
  let scheduleAttempts = 0;
  const scheduledPayloads: unknown[] = [];
  const yolo = new (class extends YoloAgent {
    schedule<T = string>(
      _when: Date | number | string,
      callback: keyof this,
      payload?: T
    ): Promise<{
      id: string;
      callback: string;
      payload: T;
      type: "scheduled";
      time: number;
    }> {
      scheduleAttempts += 1;
      scheduledPayloads.push(payload);
      return Promise.resolve({
        callback: String(callback),
        id: `cleanup-retry-${scheduleAttempts}`,
        payload: payload as T,
        time: Date.now(),
        type: "scheduled",
      });
    }

    cancelSchedule(): Promise<boolean> {
      return Promise.resolve(true);
    }
  })(undefined as never, { Sandbox: {} } as never);
  yolo.configure(definition());
  const state = Reflect.get(yolo, "state") as {
    definition: AgentDefinition | null;
    lifecycle: {
      generation: number;
      status: "active" | "decommissioning" | "decommissioned";
    };
    runs: CloudRunRecord[];
    sandbox: {
      cleanup?: {
        attempts: number;
        finalStatus: "cancelled" | "failed";
        generation: number;
        message: string;
        nextAttemptAt: number;
        owner: string;
      };
      cleanupRetryScheduleId?: string;
      cleanupRetryScheduleGeneration?: number;
      cleanupRetryScheduleToken?: string;
      generation: number;
      owner: string;
    };
  };
  yolo.setState({
    ...state,
    sandbox: {
      cleanup: {
        attempts: 0,
        finalStatus: "failed",
        generation: 1,
        message: "retry cleanup",
        nextAttemptAt: Date.now() - 1,
        owner: "warm:retry",
      },
      cleanupRetryScheduleGeneration: 1,
      cleanupRetryScheduleId: "cleanup-retry-old",
      cleanupRetryScheduleToken: "token-old",
      generation: 1,
      owner: "warm:retry",
    },
  });

  setSandboxDestroyError(new Error("cleanup unavailable"));
  assert.equal(
    await yolo.repairSandboxCleanup(
      { generation: 1, token: "token-old" },
      { id: "cleanup-retry-old" }
    ),
    false
  );
  assert.equal(scheduleAttempts, 1);
  assert.equal(
    (Reflect.get(yolo, "state") as typeof state).sandbox.cleanupRetryScheduleId,
    "cleanup-retry-1"
  );

  const retryOne = scheduledPayloads[0] as {
    generation: number;
    token: string;
  };
  assert.equal(
    await yolo.repairSandboxCleanup(retryOne, { id: "cleanup-retry-1" }),
    false
  );
  assert.equal(scheduleAttempts, 2);
  assert.equal(
    (Reflect.get(yolo, "state") as typeof state).sandbox.cleanupRetryScheduleId,
    "cleanup-retry-2"
  );

  setSandboxDestroyError(null);
  assert.equal(await yolo.repairSandboxCleanup(), true);
  assert.equal(scheduleAttempts, 2);
  assert.equal(
    (Reflect.get(yolo, "state") as typeof state).sandbox.cleanupRetryScheduleId,
    undefined
  );
});

test("stale cleanup callbacks cannot replace the authoritative retry", async () => {
  resetDestroyedSandboxes();
  fiberControl.runFibers = false;
  let scheduleAttempts = 0;
  const scheduledPayloads: unknown[] = [];
  const yolo = new (class extends YoloAgent {
    schedule<T = string>(
      _when: Date | number | string,
      callback: keyof this,
      payload?: T
    ): Promise<{
      id: string;
      callback: string;
      payload: T;
      type: "scheduled";
      time: number;
    }> {
      scheduleAttempts += 1;
      scheduledPayloads.push(payload);
      return Promise.resolve({
        callback: String(callback),
        id: `cleanup-retry-${scheduleAttempts}`,
        payload: payload as T,
        time: Date.now(),
        type: "scheduled",
      });
    }

    cancelSchedule(): Promise<boolean> {
      return Promise.resolve(true);
    }
  })(undefined as never, { Sandbox: {} } as never);
  yolo.configure(definition());
  const state = Reflect.get(yolo, "state") as {
    definition: AgentDefinition | null;
    lifecycle: {
      generation: number;
      status: "active" | "decommissioning" | "decommissioned";
    };
    runs: CloudRunRecord[];
    sandbox: {
      cleanup?: {
        attempts: number;
        finalStatus: "cancelled" | "failed";
        generation: number;
        message: string;
        nextAttemptAt: number;
        owner: string;
      };
      generation: number;
      owner: string;
    };
  };
  yolo.setState({
    ...state,
    sandbox: {
      cleanup: {
        attempts: 0,
        finalStatus: "failed",
        generation: 1,
        message: "retry cleanup",
        nextAttemptAt: Date.now() - 1,
        owner: "warm:retry",
      },
      generation: 1,
      owner: "warm:retry",
    },
  });
  setSandboxDestroyError(new Error("cleanup unavailable"));

  assert.equal(await yolo.repairSandboxCleanup(), false);
  const retryA = scheduledPayloads[0] as {
    generation: number;
    token: string;
  };
  assert.equal(
    await yolo.repairSandboxCleanup(retryA, { id: "cleanup-retry-1" }),
    false
  );
  const retryB = scheduledPayloads[1] as {
    generation: number;
    token: string;
  };
  const beforeStale = Reflect.get(yolo, "state") as {
    sandbox?: { cleanupRetryScheduleId?: string };
  };
  assert.equal(beforeStale.sandbox?.cleanupRetryScheduleId, "cleanup-retry-2");

  assert.equal(
    await yolo.repairSandboxCleanup(retryA, { id: "cleanup-retry-1" }),
    true
  );
  const afterStale = Reflect.get(yolo, "state") as {
    sandbox?: { cleanupRetryScheduleId?: string };
  };
  assert.equal(afterStale.sandbox?.cleanupRetryScheduleId, "cleanup-retry-2");
  assert.equal(scheduleAttempts, 2);
  assert.deepEqual(retryB, scheduledPayloads[1]);

  assert.equal(await yolo.repairSandboxCleanup(), false);
  assert.equal(scheduleAttempts, 2);
});

test("recovered warm ownership retries cleanup before allowing a new warm", async () => {
  resetFiberLog();
  resetDestroyedSandboxes();
  fiberControl.runFibers = false;
  setSandboxExec(() =>
    Promise.resolve({ exitCode: 0, stdout: "copilot 1", success: true })
  );
  const yolo = agent();
  const state = Reflect.get(yolo, "state") as {
    definition: AgentDefinition | null;
    lifecycle: {
      generation: number;
      status: "active" | "decommissioning" | "decommissioned";
    };
    runs: CloudRunRecord[];
    sandbox: { generation: number; owner: string };
  };
  yolo.setState({
    ...state,
    definition: {
      ...state.definition,
      warm: {
        status: "provisioning",
        updatedAt: new Date().toISOString(),
      },
    } as AgentDefinition,
    sandbox: { generation: 1, owner: "warm:recovered" },
  });
  setSandboxDestroyError(new Error("destroy unavailable"));
  await assert.rejects(
    () =>
      yolo.onFiberRecovered({
        createdAt: Date.now(),
        id: "fiber:warm",
        metadata: { kind: "warm" },
        name: "warm",
        recoveryReason: "interrupted",
        snapshot: null,
        status: "interrupted",
      }),
    /destroy unavailable/
  );
  assert.equal(yolo.snapshot()?.warm?.status, "failed");
  assert.ok(
    (Reflect.get(yolo, "state") as { sandbox?: { cleanup?: unknown } }).sandbox
      ?.cleanup
  );

  setSandboxDestroyError(null);
  const recovered = await yolo.onFiberRecovered({
    createdAt: Date.now(),
    id: "fiber:warm",
    metadata: { kind: "warm" },
    name: "warm",
    recoveryReason: "interrupted",
    snapshot: null,
    status: "interrupted",
  });
  assert.equal(recovered?.status, "aborted");
  assert.equal(
    (Reflect.get(yolo, "state") as { sandbox?: { cleanup?: unknown } }).sandbox
      ?.cleanup,
    undefined
  );

  const warming = await yolo.warm();
  assert.equal(warming.status, "provisioning");
  assert.equal(fiberLog.started.at(-1)?.key, "warm:2");
});

test("warm does not start while a run is active", async () => {
  resetFiberLog();
  resetDestroyedSandboxes();
  fiberControl.runFibers = false;
  const yolo = agent();
  const queued = await yolo.enqueue(
    { operationId: OP_A, task: "Active work." },
    "a12a0f4e-1f4d-4a2e-9c1b-7d2f5f4d4a2e",
    "active-warm-block",
    "identity"
  );
  assert.equal(await yolo.startAdmitted(queued.run.id, "1:active-warm"), true);

  await assert.rejects(() => yolo.warm(), AgentBusyError);
  assert.deepEqual(
    fiberLog.started.map((entry) => entry.key),
    [`run:${queued.run.id}`]
  );
});

test("expired warm-up uses a recyclable fiber key for the next attempt", async () => {
  resetFiberLog();
  resetDestroyedSandboxes();
  setSandboxExec(() =>
    Promise.resolve({
      exitCode: 0,
      stderr: "",
      stdout: "copilot 1.0.0\n",
      success: true,
    })
  );
  fiberControl.runFibers = true;
  const seenKeys = new Set<string>();
  const yolo = new (class extends YoloAgent {
    override startFiber(
      name: string,
      fn: Parameters<YoloAgent["startFiber"]>[1],
      options?: Parameters<YoloAgent["startFiber"]>[2]
    ): ReturnType<YoloAgent["startFiber"]> {
      const key = options?.idempotencyKey ?? name;
      if (seenKeys.has(key)) {
        return Promise.resolve({
          accepted: false,
          createdAt: Date.now(),
          fiberId: `fiber:${key}`,
          name,
          status: "completed",
        });
      }
      seenKeys.add(key);
      return super.startFiber(name, fn, options);
    }
  })(undefined as never, admissionTestEnv() as never);
  yolo.configure(definition());

  try {
    assert.equal((await yolo.warm()).status, "provisioning");
    assert.equal(yolo.snapshot()?.warm?.status, "ready");
    const state = Reflect.get(yolo, "state") as {
      definition: AgentDefinition | null;
      lifecycle: {
        generation: number;
        status: "active" | "decommissioning" | "decommissioned";
      };
      runs: CloudRunRecord[];
    };
    yolo.setState({
      ...state,
      definition: {
        ...state.definition,
        warm: {
          status: "ready",
          updatedAt: "2026-08-20T12:00:00.000Z",
        },
      } as AgentDefinition,
    });

    assert.equal((await yolo.warm()).status, "provisioning");
    assert.equal(yolo.snapshot()?.warm?.status, "ready");
    assert.deepEqual(
      fiberLog.started.map((entry) => entry.key),
      ["warm:1", "warm:2"]
    );
    assert.equal(new Set(fiberLog.started.map((entry) => entry.key)).size, 2);
  } finally {
    fiberControl.runFibers = false;
    setSandboxExec(() =>
      Promise.reject(new Error("sandbox exec is not configured"))
    );
  }
});

test("warm dispatch rejection rolls back ownership and provisioning", async () => {
  resetFiberLog();
  resetDestroyedSandboxes();
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
        fiberId: "fiber:warm-rejected",
        name: "warm:rejected",
        status: "completed",
      });
    }
  })(undefined as never, admissionTestEnv() as never);
  yolo.configure(definition());

  const warming = await yolo.warm();

  assert.equal(warming.status, "failed");
  assert.equal(yolo.snapshot()?.warm?.status, "failed");
  assert.equal(destroyedSandboxes().length, 1);
  const state = Reflect.get(yolo, "state") as {
    sandbox?: { cleanup?: unknown; owner?: string };
  };
  assert.equal(state.sandbox?.owner, undefined);
  assert.equal(state.sandbox?.cleanup, undefined);
});

test("a run cancels and cleans a reserved warm before dispatch", async () => {
  resetFiberLog();
  resetDestroyedSandboxes();
  fiberControl.runFibers = false;
  const yolo = agent();

  const warming = await yolo.warm();
  assert.equal(warming.status, "provisioning");
  const before = Reflect.get(yolo, "state") as {
    sandbox?: { generation: number; owner?: string; runId?: string };
  };
  assert.ok(before.sandbox?.owner);
  assert.equal(before.sandbox?.runId, undefined);

  const queued = await yolo.enqueue(
    { operationId: OP_A, task: "Prefer the run." },
    "a22a0f4e-1f4d-4a2e-9c1b-7d2f5f4d4a2f",
    "warm-before-run",
    "identity"
  );
  assert.equal(
    await yolo.startAdmitted(queued.run.id, "2:warm-before-run"),
    true
  );

  assert.deepEqual(
    fiberLog.cancelled.map((entry) => entry.key),
    ["warm:1"]
  );
  assert.equal(destroyedSandboxes().length, 1);
  const after = Reflect.get(yolo, "state") as {
    sandbox?: { owner?: string; cleanup?: unknown };
  };
  assert.equal(after.sandbox?.owner, undefined);
  assert.equal(after.sandbox?.cleanup, undefined);
  assert.equal(yolo.getRun(queued.run.id)?.status, "running");
});

test("simultaneous warm and run calls never share an ownership generation", async () => {
  resetFiberLog();
  resetDestroyedSandboxes();
  fiberControl.runFibers = false;
  const yolo = agent();

  const [warmed, started] = await Promise.allSettled([
    yolo.warm(),
    admittedStart(yolo, { operationId: OP_A, task: "Run now." }, "identity"),
  ]);

  assert.equal(started.status, "fulfilled");
  if (warmed.status === "fulfilled") {
    assert.equal(
      destroyedSandboxes().length,
      1,
      "a warm owner must be cleaned before a simultaneous run"
    );
  } else {
    assert.ok(warmed.reason instanceof AgentBusyError);
  }
  const state = Reflect.get(yolo, "state") as {
    sandbox?: { owner?: string; cleanup?: unknown };
  };
  assert.equal(state.sandbox?.owner, undefined);
  assert.equal(state.sandbox?.cleanup, undefined);
});

test("a timed-out warm keeps admission blocked until cleanup succeeds", async () => {
  resetFiberLog();
  resetDestroyedSandboxes();
  setSandboxExec(() =>
    Promise.reject(new HarnessError("probe timed out", "harness_timeout"))
  );
  setSandboxDestroyError(new Error("cleanup unavailable"));
  const yolo = agent();
  fiberControl.runFibers = true;

  try {
    await yolo.warm();
    const pending = Reflect.get(yolo, "state") as {
      sandbox?: { cleanup?: unknown };
    };
    assert.ok(pending.sandbox?.cleanup);

    const queued = await yolo.enqueue(
      { operationId: OP_A, task: "Wait for cleanup." },
      "a32a0f4e-1f4d-4a2e-9c1b-7d2f5f4d4a30",
      "warm-timeout-cleanup",
      "identity"
    );
    await assert.rejects(
      () => yolo.startAdmitted(queued.run.id, "3:warm-timeout"),
      AgentBusyError
    );
    assert.equal(yolo.getRun(queued.run.id)?.status, "queued");

    setSandboxDestroyError(null);
    fiberControl.runFibers = false;
    assert.equal(
      await yolo.startAdmitted(queued.run.id, "3:warm-timeout"),
      true
    );
    assert.equal(yolo.getRun(queued.run.id)?.status, "running");
  } finally {
    setSandboxDestroyError(null);
    setSandboxExec(() =>
      Promise.reject(new Error("sandbox exec is not configured"))
    );
    fiberControl.runFibers = false;
  }
});

test("requeueAdmitted clears a stale local token without losing its fence", async () => {
  resetFiberLog();
  resetDestroyedSandboxes();
  fiberControl.runFibers = false;
  const yolo = agent();
  const queued = await yolo.enqueue(
    { operationId: OP_A, task: "Requeue stale dispatch." },
    "ff2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8ca2",
    "requeue-stale",
    "identity"
  );
  const state = Reflect.get(yolo, "state") as {
    admissionTokens?: Record<string, string>;
    definition: AgentDefinition | null;
    identityTokens?: Record<string, string>;
    lifecycle: {
      generation: number;
      status: "active" | "decommissioning" | "decommissioned";
    };
    runs: CloudRunRecord[];
  };
  const current = state.runs.find(
    (candidate) => candidate.run.id === queued.run.id
  );
  assert.ok(current);
  yolo.setState({
    ...state,
    admissionTokens: {
      ...(state.admissionTokens ?? {}),
      [queued.run.id]: "7:stale",
    },
    runs: [
      { ...current, dispatchToken: "7:stale" },
      ...state.runs.filter((candidate) => candidate.run.id !== queued.run.id),
    ],
  });

  assert.equal(yolo.requeueAdmitted(queued.run.id, "7:stale"), true);
  const after = Reflect.get(yolo, "state") as {
    admissionFences?: Record<string, { generation?: number }>;
    admissionTokens?: Record<string, string>;
    runs: CloudRunRecord[];
  };
  assert.equal(after.runs[0]?.dispatchToken, undefined);
  assert.equal(after.admissionTokens?.[queued.run.id], undefined);
  assert.equal(after.admissionFences?.[queued.run.id]?.generation, 7);
  assert.equal((await yolo.stop(queued.run.id))?.status, "cancelled");
  assert.deepEqual(destroyedSandboxes(), []);
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
          getCleanupCapability: testAdmissionCapability,
          release: (runId: string, dispatchToken?: string) => {
            released.push({ dispatchToken, runId });
            return Promise.resolve(true);
          },
          validateDispatch: () => Promise.resolve(true),
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
    lifecycle: {
      generation: number;
      status: "active" | "decommissioning" | "decommissioned";
    };
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
    lifecycle: {
      generation: number;
      status: "active" | "decommissioning" | "decommissioned";
    };
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
  const started = await yolo.enqueue(
    { operationId: OP_A, task: "Fix tests." },
    "cc2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c9c",
    "stop-hash",
    "identity"
  );
  assert.equal(await yolo.startAdmitted(started.run.id, "1:stop"), true);

  const stopped = await yolo.stop(started.run.id);

  assert.equal(stopped?.status, "cancelled");
  assert.ok(stopped?.completedAt, "a cancelled run must be closed out");
  assert.deepEqual(
    fiberLog.cancelled.map((entry) => entry.key),
    [`run:${started.run.id}`]
  );
});

test("stop returns a credential-aborted terminal run after cancellation settles first", async () => {
  resetFiberLog();
  resetDestroyedSandboxes();
  const originalFetch = globalThis.fetch;
  let rejectCredential!: (error: unknown) => void;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      rejectCredential = reject;
      init?.signal?.addEventListener(
        "abort",
        () =>
          reject(
            Object.assign(new Error("lookup aborted"), { name: "AbortError" })
          ),
        { once: true }
      );
    })) as typeof fetch;
  let runFiber!: Promise<void>;
  let runController!: AbortController;
  const released: string[] = [];
  const yolo = new (class extends YoloAgent {
    override startFiber(
      _name: string,
      fn: Parameters<YoloAgent["startFiber"]>[1]
    ): ReturnType<YoloAgent["startFiber"]> {
      runController = new AbortController();
      runFiber = fn({
        id: "fiber:stop-after-abort",
        signal: runController.signal,
        snapshot: null,
        stash: () => undefined,
      });
      return Promise.resolve({
        accepted: true,
        createdAt: Date.now(),
        fiberId: "fiber:stop-after-abort",
        name: "run:stop-after-abort",
        status: "running",
      });
    }

    override async cancelFiberByKey(
      idempotencyKey: string,
      reason?: string
    ): Promise<boolean> {
      assert.match(idempotencyKey, /^run:/);
      runController.abort(reason);
      rejectCredential(
        Object.assign(new Error("lookup aborted"), { name: "AbortError" })
      );
      await runFiber;
      return true;
    }
  })(
    undefined as never,
    {
      APP_ORIGIN: "https://runner.test",
      RUNNER_SERVICE_TOKEN: "service-token",
      RunAdmission: {
        getByName: () => ({
          getCleanupCapability: testAdmissionCapability,
          release: (runId: string) => {
            released.push(runId);
            return Promise.resolve(true);
          },
          validateDispatch: () => Promise.resolve(true),
        }),
      },
      Sandbox: {},
    } as never
  );
  yolo.configure(definition());

  try {
    const queued = await yolo.enqueue(
      { operationId: OP_A, task: "Stop after credential abort." },
      "ca2a0f4e-1f4d-4a2e-9c1b-7d2f5f4d4a21",
      "stop-after-abort",
      "identity"
    );
    assert.equal(
      await yolo.startAdmitted(queued.run.id, "1:stop-after-abort"),
      true
    );

    const stopped = await yolo.stop(queued.run.id);

    assert.equal(stopped?.status, "cancelled");
    assert.equal(yolo.getRun(queued.run.id)?.status, "cancelled");
    assert.deepEqual(released, [queued.run.id]);
    assert.deepEqual(destroyedSandboxes(), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stop cleans up a direct fiber dispatch that has not claimed running yet", async () => {
  resetDestroyedSandboxes();
  const yolo = agent();
  const started = await admittedStart(
    yolo,
    { operationId: OP_A, task: "Direct dispatch." },
    "identity"
  );

  const stopped = await yolo.stop(started.run.id);

  assert.equal(stopped?.status, "cancelled");
  assert.deepEqual(
    fiberLog.cancelled.map((entry) => entry.key),
    [`run:${started.run.id}`]
  );
  assert.equal(destroyedSandboxes().length, 1);
});

test("a cancelled run frees the agent for the next one", async () => {
  // Without closing the record, the run stays "running" forever and every
  // later start is refused as already_running.
  const yolo = agent();
  const first = await admittedStart(
    yolo,
    { operationId: OP_A, task: "Fix tests." },
    "identity"
  );
  await yolo.stop(first.run.id);

  const second = await admittedStart(
    yolo,
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
          getCleanupCapability: testAdmissionCapability,
          release: (runId: string) => {
            released.push(runId);
            return Promise.resolve(true);
          },
          validateDispatch: () => Promise.resolve(true),
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

test("cancelling a queued run preserves an active run and shared sandbox", async () => {
  resetFiberLog();
  resetDestroyedSandboxes();
  fiberControl.runFibers = false;
  const released: string[] = [];
  const yolo = new YoloAgent(
    undefined as never,
    {
      RunAdmission: {
        getByName: () => ({
          getCleanupCapability: testAdmissionCapability,
          release: (runId: string) => {
            released.push(runId);
            return Promise.resolve(true);
          },
          validateDispatch: () => Promise.resolve(true),
        }),
      },
    } as never
  );
  yolo.configure(definition());

  const active = await yolo.enqueue(
    { operationId: OP_A, task: "Active work." },
    "9c1b7d2f-5a6b-4c90-8f1a-0f4e1f4d4a2e",
    "active-hash",
    "identity"
  );
  assert.equal(await yolo.startAdmitted(active.run.id, "1:active"), true);

  const queued = await yolo.enqueue(
    { operationId: OP_B, task: "Queued work." },
    "ac2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c9a",
    "queued-hash",
    "identity"
  );

  const stopped = await yolo.stop(queued.run.id);

  assert.equal(stopped?.status, "cancelled");
  assert.equal(yolo.getRun(active.run.id)?.status, "running");
  assert.equal(yolo.snapshot()?.status, "running");
  assert.deepEqual(fiberLog.cancelled, []);
  assert.deepEqual(destroyedSandboxes(), []);
  assert.deepEqual(released, [queued.run.id]);
});

test("queued cancellation fences a dispatch that starts after cancellation", async () => {
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
          validateDispatch: () => Promise.resolve(true),
        }),
      },
    } as never
  );
  yolo.configure(definition());
  const queued = await yolo.enqueue(
    { operationId: OP_A, task: "Racing work." },
    "bc2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c9b",
    "racing-hash",
    "identity"
  );

  const stopping = yolo.stop(queued.run.id);
  const dispatching = yolo.startAdmitted(queued.run.id, "1:racing");
  const [stopped, dispatched] = await Promise.all([stopping, dispatching]);

  assert.equal(stopped?.status, "cancelled");
  assert.equal(dispatched, true);
  assert.equal(fiberLog.started.length, 0);
  assert.deepEqual(fiberLog.cancelled, []);
  assert.deepEqual(destroyedSandboxes(), []);
  assert.deepEqual(released, [queued.run.id]);
});

test("recovery of a never-dispatched cancellation does not destroy the sandbox", async () => {
  resetFiberLog();
  resetDestroyedSandboxes();
  fiberControl.runFibers = false;
  const yolo = agent();
  const queued = await yolo.enqueue(
    { operationId: OP_A, task: "Cancelled before dispatch." },
    "be2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c9f",
    "recovery-hash",
    "identity"
  );
  await yolo.stop(queued.run.id);

  await yolo.onFiberRecovered({
    createdAt: Date.now(),
    id: "fiber-never-dispatched",
    metadata: { runId: queued.run.id },
    name: `run:${queued.run.id}`,
    recoveryReason: "interrupted",
    snapshot: null,
    status: "interrupted",
  });

  assert.deepEqual(destroyedSandboxes(), []);
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
          getCleanupCapability: testAdmissionCapability,
          release: () => Promise.resolve(true),
          validateDispatch: () => Promise.resolve(true),
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
  assert.equal(
    (Reflect.get(yolo, "ephemeralIdentityTokens") as Map<string, unknown>).size,
    0,
    "terminal runs must not retain ephemeral identity tokens"
  );
});

test("stopping a finished run does not rewrite its outcome", async () => {
  const yolo = agent();
  const started = await yolo.enqueue(
    { operationId: OP_A, task: "Fix tests." },
    "dc2a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c9d",
    "finished-hash",
    "identity"
  );
  assert.equal(await yolo.startAdmitted(started.run.id, "1:finished"), true);
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
  const started = await admittedStart(
    yolo,
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
  const started = await admittedStart(
    yolo,
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

test("the directory lists a normalized legacy runtime definition", () => {
  const index = new AgentDirectory(undefined as never, {} as never);
  const legacy = { ...definition(), runtime: "cloud" as const };
  index.setState({ agents: [legacy] });

  assert.equal(index.list("acct_1")[0]?.runtime, "cloud");
});

test("a registered run resolves back to its agent", () => {
  const index = directory();
  assert.deepEqual(index.registerRun(OP_A, AGENT_ID), {
    kind: "registered",
    sequence: 1,
  });

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

test("a stale pending unregister cannot delete a newer registration", () => {
  const index = directory();
  const first = index.registerRun(OP_A, AGENT_ID);
  assert.equal(first.kind, "registered");
  if (first.kind !== "registered") {
    return;
  }
  const firstSequence = first.sequence;

  index.enqueueRunMappingCleanup(OP_A, AGENT_ID, firstSequence);
  const second = index.registerRun(OP_A, AGENT_ID);
  assert.equal(second.kind, "registered");
  if (second.kind !== "registered") {
    return;
  }
  const secondSequence = second.sequence;
  assert.notEqual(secondSequence, firstSequence);

  index.enqueueRunMappingCleanup(OP_A, AGENT_ID, firstSequence);
  index.list("acct_1");

  assert.equal(index.lookupRun(OP_A), AGENT_ID);
  assert.equal(index.unregisterRun(OP_A, AGENT_ID, firstSequence), false);
  assert.equal(index.unregisterRun(OP_A, AGENT_ID, secondSequence), true);
});

test("a stale re-registration cannot downgrade terminal run mappings", () => {
  const index = directory();
  const terminal = index.registerRun(OP_A, AGENT_ID, "terminal");
  assert.deepEqual(terminal, { kind: "registered", sequence: 1 });

  assert.deepEqual(index.registerRun(OP_A, AGENT_ID, "active"), {
    kind: "registered",
    sequence: 1,
  });
  assert.deepEqual(index.registerRun(OP_A, AGENT_ID, "queued"), {
    kind: "registered",
    sequence: 1,
  });

  const state = Reflect.get(index, "state") as {
    runRegistrations?: Record<string, { sequence: number; status: string }>;
  };
  assert.deepEqual(state.runRegistrations?.[OP_A], {
    agentId: AGENT_ID,
    sequence: 1,
    status: "terminal",
  });
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

test("run mappings retain active runs and only the newest terminal history", () => {
  const index = directory();
  const activeRun = "active-run";
  index.registerRun(activeRun, AGENT_ID, "active");

  for (let sequence = 1; sequence <= 1000; sequence += 1) {
    index.registerRun(`terminal-run-${sequence}`, AGENT_ID, "terminal");
  }

  const state = Reflect.get(index, "state") as {
    runs?: Record<string, string>;
  };
  assert.equal(Object.keys(state.runs ?? {}).length, 21);
  assert.equal(index.lookupRun(activeRun), AGENT_ID);
  assert.equal(index.lookupRun("terminal-run-1000"), AGENT_ID);
  assert.equal(index.lookupRun("terminal-run-1"), null);
});

test("run mappings retain every queued run regardless of terminal history size", () => {
  const index = directory();

  for (let sequence = 1; sequence <= 100; sequence += 1) {
    index.registerRun(`queued-run-${sequence}`, AGENT_ID, "queued");
  }

  const state = Reflect.get(index, "state") as {
    runs?: Record<string, string>;
  };
  assert.equal(Object.keys(state.runs ?? {}).length, 100);
  assert.equal(index.lookupRun("queued-run-1"), AGENT_ID);
  assert.equal(index.lookupRun("queued-run-100"), AGENT_ID);
});

test("large legacy run state migrates through bounded state with complete lookup", () => {
  const index = directory();
  const state = Reflect.get(index, "state") as {
    agents: AgentDefinition[];
    pendingUnregisters?: Record<string, string>;
    runs?: Record<string, string>;
  };
  const legacyRuns = Object.fromEntries(
    Array.from({ length: 1000 }, (_, sequence) => [
      `legacy-large-${sequence + 1}`,
      AGENT_ID,
    ])
  );
  index.setState({
    ...state,
    nextRunRegistrationSequence: undefined,
    runRegistrations: undefined,
    runs: legacyRuns,
  } as never);

  assert.equal(index.lookupRun("legacy-large-1"), AGENT_ID);
  const migrated = Reflect.get(index, "state") as {
    runs?: Record<string, string>;
    runRegistrations?: Record<string, unknown>;
  };
  assert.equal(Object.keys(migrated.runs ?? {}).length, 20);
  assert.equal(Object.keys(migrated.runRegistrations ?? {}).length, 20);
  assert.equal(index.unregisterRun("legacy-large-1", AGENT_ID), true);
  assert.equal(index.lookupRun("legacy-large-1"), null);
});

test("terminal status received before registration is applied to the mapping", () => {
  const index = directory();

  assert.equal(
    index.markRunStatus("pending-terminal", AGENT_ID, "terminal"),
    true
  );
  assert.deepEqual(index.registerRun("pending-terminal", AGENT_ID, "active"), {
    kind: "registered",
    sequence: 1,
  });

  const state = Reflect.get(index, "state") as {
    runRegistrations?: Record<string, { status: string }>;
  };
  assert.equal(
    state.runRegistrations?.["pending-terminal"]?.status,
    "terminal"
  );
  assert.equal(
    index.markRunStatus("pending-terminal", AGENT_ID, "active"),
    true
  );
  const afterStaleUpdate = Reflect.get(index, "state") as {
    runRegistrations?: Record<string, { status: string }>;
  };
  assert.equal(
    afterStaleUpdate.runRegistrations?.["pending-terminal"]?.status,
    "terminal"
  );
});

test("legacy run mappings migrate to durable registration sequence metadata", () => {
  const index = directory();
  const state = Reflect.get(index, "state") as {
    agents: AgentDefinition[];
    pendingUnregisters?: Record<string, string>;
    runs?: Record<string, string>;
  };
  index.setState({
    ...state,
    nextRunRegistrationSequence: undefined,
    runRegistrations: undefined,
    runs: {
      "legacy-run-a": AGENT_ID,
      "legacy-run-b": "other-agent",
    },
  } as never);

  assert.equal(index.lookupRun("legacy-run-a"), AGENT_ID);
  const migrated = Reflect.get(index, "state") as {
    nextRunRegistrationSequence?: number;
    runRegistrations?: Record<
      string,
      { agentId: string; sequence: number; status: string }
    >;
  };
  assert.equal(migrated.runRegistrations?.["legacy-run-a"]?.sequence, 1);
  assert.equal(migrated.runRegistrations?.["legacy-run-b"]?.sequence, 2);
  assert.equal(migrated.nextRunRegistrationSequence, 3);
});

test("removing an agent preserves unrelated pending cleanup and run ordering", () => {
  const index = directory();
  index.registerRun(OP_A, AGENT_ID, "terminal");
  index.registerRun("unrelated-run", "other-agent", "terminal");
  index.enqueueRunMappingCleanup("pending-a", "other-agent");

  index.remove(AGENT_ID);

  const state = Reflect.get(index, "state") as {
    pendingUnregisters?: Record<
      string,
      string | { agentId: string; expectedSequence?: number }
    >;
    runs?: Record<string, string>;
    runRegistrations?: Record<string, unknown>;
  };
  assert.deepEqual(state.pendingUnregisters?.["pending-a"], {
    agentId: "other-agent",
    expectedSequence: 0,
  });
  assert.equal(state.runs?.["unrelated-run"], "other-agent");
  assert.ok(state.runRegistrations?.["unrelated-run"]);
});
