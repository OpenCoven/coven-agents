// biome-ignore-all lint/suspicious/useAwait: Dependency doubles keep async signatures for readability.
import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_RUNNER_API_VERSION,
  type RunSnapshot,
} from "@opencoven/agent-contracts";
import { RunnerAdmissionError } from "@/lib/runner/admission";
import type { RunnerOperator, RunnerPrincipal } from "@/lib/runner/types";
import { createTeamOrchestrator, teamChildRunnerIds } from "./orchestrate";

const operator: RunnerOperator = { kind: "runner-operator" };
const principal: RunnerPrincipal = {
  kind: "subscriber",
  tenant: "u_9c8589018a57479181fe4c455b099bc9",
  userId: "9c858901-8a57-4791-81fe-4c455b099bc9",
};
const TEAM_RUN_ID = "11111111-1111-4111-8111-111111111111";
const TEAM_STEP_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";

function snapshot(id: string, operationId: string, task: string): RunSnapshot {
  return {
    agentId: AGENT_ID,
    apiVersion: AGENT_RUNNER_API_VERSION,
    commandEvidence: [],
    completedAt: null,
    createdAt: "2026-08-31T00:00:00.000Z",
    error: null,
    fileEvidence: [],
    id,
    operationId,
    output: "",
    startedAt: null,
    status: "queued",
    task,
  };
}

function readyClaim() {
  return {
    agentId: AGENT_ID,
    agentSnapshot: {
      instructions: "Keep execution evidence concise.",
      model: "auto",
      runtime: "copilot" as const,
      workspace: "/workspace/repo",
    },
    authVersion: 7,
    declaredCapabilities: [
      "workspace.read",
      "github.pull_requests.write",
    ] as const,
    kind: "ready" as const,
    mission: "Ship the approved change.",
    principal,
    priorHandoffs: [],
    responsibility: "Implement the change and report bounded evidence.",
    skillSnapshots: [
      {
        instructions: "Run the focused regression tests.",
        name: "Release evidence",
      },
    ],
    teamRunId: TEAM_RUN_ID,
    teamStepId: TEAM_STEP_ID,
    teamStepVersion: 2,
  };
}

test("ready team steps become one deterministic admitted RunnerRun with immutable authority", async () => {
  const calls: unknown[][] = [];
  const ids = teamChildRunnerIds(TEAM_STEP_ID);
  let claimed = false;
  const orchestrator = createTeamOrchestrator({
    admit: async (input) => {
      calls.push(["admit", input]);
      return {
        kind: "created" as const,
        run: snapshot(input.id, input.operationId, input.task),
      };
    },
    cancelRun: async () => ({ kind: "already_terminal" as const }),
    operator,
    store: {
      attachTeamStepRunnerRun: async (_authority, input) => {
        calls.push(["attach", input]);
        return { kind: "attached" as const };
      },
      claimNextTeamStep: async () => {
        if (claimed) {
          return { kind: "idle" as const };
        }
        claimed = true;
        return readyClaim();
      },
      failTeamStepAdmission: async () => ({ kind: "failed" as const }),
      findNextCancelledTeamChild: async () => ({ kind: "idle" as const }),
      projectNextTerminalTeamStep: async () => ({ kind: "idle" as const }),
    },
  });

  const result = await orchestrator.claimReadySteps();

  assert.deepEqual(result, {
    admitted: 1,
    claimedDispatches: [],
    deferred: 0,
    failures: 0,
    waitingApproval: 0,
  });
  assert.equal(calls.length, 2);
  const admission = calls[0]?.[1] as Record<string, unknown>;
  assert.equal(admission.id, ids.runId);
  assert.equal(admission.operationId, ids.operationId);
  assert.equal(admission.agentId, AGENT_ID);
  assert.equal(admission.authVersion, 7);
  assert.deepEqual(admission.principal, principal);
  assert.deepEqual(admission.agentSnapshot, readyClaim().agentSnapshot);
  assert.match(String(admission.task), /Ship the approved change/u);
  assert.match(String(admission.task), /Implement the change/u);
  assert.match(String(admission.task), /Keep execution evidence concise/u);
  assert.match(String(admission.task), /Release evidence/u);
  assert.match(String(admission.task), /Scope: read and write/u);
  assert.deepEqual(calls[1], [
    "attach",
    {
      expectedVersion: 2,
      operationId: ids.operationId,
      runnerRunId: ids.runId,
      teamStepId: TEAM_STEP_ID,
    },
  ]);
});

test("write-capable pending steps wait for approval without runner admission", async () => {
  let admissions = 0;
  let claimed = false;
  const orchestrator = createTeamOrchestrator({
    admit: async () => {
      admissions += 1;
      throw new Error("pending approval must not be admitted");
    },
    cancelRun: async () => ({ kind: "already_terminal" as const }),
    operator,
    store: {
      attachTeamStepRunnerRun: async () => ({ kind: "attached" as const }),
      claimNextTeamStep: async () => {
        if (claimed) {
          return { kind: "idle" as const };
        }
        claimed = true;
        return { kind: "waiting_approval" as const, teamRunId: TEAM_RUN_ID };
      },
      failTeamStepAdmission: async () => ({ kind: "failed" as const }),
      findNextCancelledTeamChild: async () => ({ kind: "idle" as const }),
      projectNextTerminalTeamStep: async () => ({ kind: "idle" as const }),
    },
  });

  assert.deepEqual(await orchestrator.claimReadySteps(), {
    admitted: 0,
    claimedDispatches: [],
    deferred: 0,
    failures: 0,
    waitingApproval: 1,
  });
  assert.equal(admissions, 0);
});

test("duplicate admission safely reattaches the same deterministic child", async () => {
  const ids = teamChildRunnerIds(TEAM_STEP_ID);
  let claimed = false;
  let attachedRunId: string | null = null;
  const orchestrator = createTeamOrchestrator({
    admit: async (input) => ({
      kind: "duplicate" as const,
      run: snapshot(input.id, input.operationId, input.task),
    }),
    cancelRun: async () => ({ kind: "already_terminal" as const }),
    operator,
    store: {
      attachTeamStepRunnerRun: async (_authority, input) => {
        attachedRunId = input.runnerRunId;
        return { kind: "duplicate" as const };
      },
      claimNextTeamStep: async () => {
        if (claimed) {
          return { kind: "idle" as const };
        }
        claimed = true;
        return readyClaim();
      },
      failTeamStepAdmission: async () => ({ kind: "failed" as const }),
      findNextCancelledTeamChild: async () => ({ kind: "idle" as const }),
      projectNextTerminalTeamStep: async () => ({ kind: "idle" as const }),
    },
  });

  const result = await orchestrator.claimReadySteps();

  assert.equal(attachedRunId, ids.runId);
  assert.equal(result.admitted, 1);
  assert.equal(result.failures, 0);
});

test("projection retries cancellation for only the recorded team child", async () => {
  const calls: unknown[][] = [];
  let cancellationScanned = false;
  let projectionScanned = false;
  const orchestrator = createTeamOrchestrator({
    admit: async () => {
      throw new Error("projection must not admit");
    },
    cancelRun: async (authority, runId) => {
      calls.push(["cancel", authority, runId]);
      return { kind: "stopped" as const };
    },
    operator,
    store: {
      attachTeamStepRunnerRun: async () => ({ kind: "attached" as const }),
      claimNextTeamStep: async () => ({ kind: "idle" as const }),
      failTeamStepAdmission: async () => ({ kind: "failed" as const }),
      findNextCancelledTeamChild: async () => {
        if (cancellationScanned) {
          return { kind: "idle" as const };
        }
        cancellationScanned = true;
        return {
          kind: "found" as const,
          principal,
          runnerRunId: "44444444-4444-4444-8444-444444444444",
          teamRunId: TEAM_RUN_ID,
        };
      },
      projectNextTerminalTeamStep: async () => {
        if (projectionScanned) {
          return { kind: "idle" as const };
        }
        projectionScanned = true;
        return { kind: "projected" as const, teamRunId: TEAM_RUN_ID };
      },
    },
  });

  assert.deepEqual(await orchestrator.projectTerminalSteps(), {
    cancellationDeferred: 0,
    cancellationRequested: 1,
    failures: 0,
    projected: 1,
  });
  assert.deepEqual(calls, [
    ["cancel", principal, "44444444-4444-4444-8444-444444444444"],
  ]);
});

test("nonretryable admission failure terminalizes one team and continues unrelated claims", async () => {
  const failedStepId = TEAM_STEP_ID;
  const nextStepId = "55555555-5555-4555-8555-555555555555";
  const claims = [
    readyClaim(),
    {
      ...readyClaim(),
      teamRunId: "66666666-6666-4666-8666-666666666666",
      teamStepId: nextStepId,
    },
  ];
  const failed: unknown[] = [];
  const orchestrator = createTeamOrchestrator({
    admit: async (input) =>
      input.id === teamChildRunnerIds(failedStepId).runId
        ? {
            error: new RunnerAdmissionError(
              "agent_not_found",
              "The snapshotted agent no longer exists.",
              false
            ),
            kind: "refused" as const,
          }
        : {
            kind: "created" as const,
            run: snapshot(input.id, input.operationId, input.task),
          },
    cancelRun: async () => ({ kind: "already_terminal" as const }),
    operator,
    store: {
      attachTeamStepRunnerRun: async () => ({ kind: "attached" as const }),
      claimNextTeamStep: async () =>
        claims.shift() ?? { kind: "idle" as const },
      failTeamStepAdmission: async (_authority, input) => {
        failed.push(input);
        return { kind: "failed" as const };
      },
      findNextCancelledTeamChild: async () => ({ kind: "idle" as const }),
      projectNextTerminalTeamStep: async () => ({ kind: "idle" as const }),
    },
  });

  const result = await orchestrator.claimReadySteps();

  assert.equal(result.admitted, 1);
  assert.equal(result.failures, 1);
  assert.deepEqual(failed, [
    {
      error: {
        code: "agent_not_found",
        message: "The snapshotted runner agent is unavailable.",
        retryable: false,
      },
      expectedVersion: 2,
      teamStepId: failedStepId,
    },
  ]);
});

test("a cancellation race durably attaches and stops the just-admitted child", async () => {
  const ids = teamChildRunnerIds(TEAM_STEP_ID);
  const cancellations: unknown[][] = [];
  let claimed = false;
  const orchestrator = createTeamOrchestrator({
    admit: async (input) => ({
      kind: "created" as const,
      run: snapshot(input.id, input.operationId, input.task),
    }),
    cancelRun: async (...args) => {
      cancellations.push(args);
      return { kind: "stopped" as const };
    },
    operator,
    store: {
      attachTeamStepRunnerRun: async () => ({
        kind: "cancel_required" as const,
      }),
      claimNextTeamStep: async () => {
        if (claimed) {
          return { kind: "idle" as const };
        }
        claimed = true;
        return readyClaim();
      },
      failTeamStepAdmission: async () => ({ kind: "failed" as const }),
      findNextCancelledTeamChild: async () => ({ kind: "idle" as const }),
      projectNextTerminalTeamStep: async () => ({ kind: "idle" as const }),
    },
  });

  const result = await orchestrator.claimReadySteps();

  assert.equal(result.admitted, 0);
  assert.equal(result.failures, 0);
  assert.deepEqual(cancellations, [[principal, ids.runId]]);
});

test("retryable admission defers one team without aborting a later ready team", async () => {
  const deferredStepId = TEAM_STEP_ID;
  const readyStepId = "55555555-5555-4555-8555-555555555555";
  const claims = [
    readyClaim(),
    {
      ...readyClaim(),
      teamRunId: "66666666-6666-4666-8666-666666666666",
      teamStepId: readyStepId,
    },
  ];
  const orchestrator = createTeamOrchestrator({
    admit: async (input) =>
      input.id === teamChildRunnerIds(deferredStepId).runId
        ? {
            error: new RunnerAdmissionError(
              "tenant_queue_full",
              "The tenant queue is full.",
              true
            ),
            kind: "refused" as const,
          }
        : {
            kind: "created" as const,
            run: snapshot(input.id, input.operationId, input.task),
          },
    cancelRun: async () => ({ kind: "already_terminal" as const }),
    operator,
    store: {
      attachTeamStepRunnerRun: async () => ({ kind: "attached" as const }),
      claimNextTeamStep: async () =>
        claims.shift() ?? { kind: "idle" as const },
      failTeamStepAdmission: async () => ({ kind: "failed" as const }),
      findNextCancelledTeamChild: async () => ({ kind: "idle" as const }),
      projectNextTerminalTeamStep: async () => ({ kind: "idle" as const }),
    },
  });

  const result = await orchestrator.claimReadySteps();

  assert.equal(result.admitted, 1);
  assert.equal(result.deferred, 1);
  assert.equal(result.failures, 0);
});

test("deferred cancellation does not abort another cancelled team child", async () => {
  const firstRunId = "77777777-7777-4777-8777-777777777777";
  const secondRunId = "88888888-8888-4888-8888-888888888888";
  const candidates = [
    {
      kind: "found" as const,
      principal,
      runnerRunId: firstRunId,
      teamRunId: TEAM_RUN_ID,
    },
    {
      kind: "found" as const,
      principal,
      runnerRunId: secondRunId,
      teamRunId: "99999999-9999-4999-8999-999999999999",
    },
  ];
  const cancellationCalls: string[] = [];
  const orchestrator = createTeamOrchestrator({
    admit: async () => {
      throw new Error("cancellation pass must not admit");
    },
    cancelRun: async (_authority, runId) => {
      cancellationCalls.push(runId);
      return {
        kind: runId === firstRunId ? "unavailable" : "stopped",
      };
    },
    operator,
    store: {
      attachTeamStepRunnerRun: async () => ({ kind: "attached" as const }),
      claimNextTeamStep: async () => ({ kind: "idle" as const }),
      failTeamStepAdmission: async () => ({ kind: "failed" as const }),
      findNextCancelledTeamChild: async () =>
        candidates.shift() ?? { kind: "idle" as const },
      projectNextTerminalTeamStep: async () => ({ kind: "idle" as const }),
    },
  });

  const result = await orchestrator.projectTerminalSteps();

  assert.deepEqual(cancellationCalls, [firstRunId, secondRunId]);
  assert.equal(result.cancellationDeferred, 1);
  assert.equal(result.cancellationRequested, 1);
});
