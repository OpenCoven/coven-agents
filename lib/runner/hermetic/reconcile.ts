import "server-only";

import type { RunEvent, RunSummary } from "@opencoven/harness";
import type {
  RunnerAttemptLogSnapshot,
  RunnerAttemptSnapshotInput,
  RunnerReconciliationContext,
  RunnerReconciliationProvider,
} from "../attempt-reconcile";
import { daytonaRunSessionName } from "../daytona/names";
import type { RunnerDispatchAuthority, RunnerRunRecord } from "../types";
import { HERMETIC_HOLD_TASK_MARKER } from "./executor";

declare const hermeticReconciliationContextBrand: unique symbol;

type HermeticReconciliationContext = Readonly<{
  attemptId: string;
  held: boolean;
  runId: string;
  readonly [hermeticReconciliationContextBrand]: "HermeticReconciliationContext";
}>;

const EVENT_TIME = "2026-09-01T00:00:00.000Z";

function contextFor(
  run: RunnerRunRecord,
  authority: RunnerDispatchAuthority
): RunnerReconciliationContext | null {
  if (
    !authority.attemptId ||
    run.daytonaAttemptId !== authority.attemptId ||
    !run.daytonaCommandId ||
    run.daytonaSessionId !== daytonaRunSessionName(run.id, authority.attemptId)
  ) {
    return null;
  }
  return {
    attemptId: authority.attemptId,
    held: run.task.includes(HERMETIC_HOLD_TASK_MARKER),
    runId: run.id,
  } as unknown as RunnerReconciliationContext;
}

function verifySnapshotInput(input: RunnerAttemptSnapshotInput): void {
  const context = input.context as unknown as HermeticReconciliationContext;
  if (
    context.runId !== input.runId ||
    context.attemptId !== input.attemptId ||
    !input.commandId.startsWith("hermetic-command-")
  ) {
    throw new Error("Hermetic reconciliation attempt fence was rejected.");
  }
}

function completedEvents(input: RunnerAttemptSnapshotInput): RunEvent[] {
  return [
    {
      at: EVENT_TIME,
      kind: "message",
      model: "hermetic",
      text: "Hermetic runner completed deterministic certification task.",
    },
    {
      at: EVENT_TIME,
      callId: `hermetic-tool-${input.attemptId}`,
      kind: "tool-start",
      summary: "Validate deterministic evidence.",
      tool: "hermetic.verify",
    },
    {
      at: EVENT_TIME,
      callId: `hermetic-tool-${input.attemptId}`,
      kind: "tool-end",
      success: true,
      summary: "Validated deterministic evidence.",
    },
    {
      at: EVENT_TIME,
      kind: "file",
      operation: "modify",
      path: "/workspace/hermetic-proof.txt",
    },
    {
      at: EVENT_TIME,
      exitCode: 0,
      filesModified: ["/workspace/hermetic-proof.txt"],
      kind: "finished",
      sessionId: `hermetic-${input.attemptId}`,
      status: "completed",
    },
  ];
}

function completedSummary(input: RunnerAttemptSnapshotInput): RunSummary {
  return {
    fileOperations: [
      { operation: "modify", path: "/workspace/hermetic-proof.txt" },
    ],
    output: "Hermetic runner completed deterministic certification task.",
    premiumRequests: 0,
    sessionId: `hermetic-${input.attemptId}`,
    status: "completed",
    toolCalls: [
      {
        success: true,
        summary: "Validate deterministic evidence.",
        tool: "hermetic.verify",
      },
    ],
  };
}

function heldSummary(): RunSummary {
  return {
    fileOperations: [],
    output: "Hermetic runner is held for cancellation certification.",
    premiumRequests: 0,
    sessionId: null,
    status: "completed",
    toolCalls: [],
  };
}

function snapshot(input: RunnerAttemptSnapshotInput): RunnerAttemptLogSnapshot {
  verifySnapshotInput(input);
  const events = input.cursor === 0 ? completedEvents(input) : [];
  return {
    cursor: completedEvents(input).length,
    events,
    exitCode: 0,
    logsSettled: true,
    status: "completed",
    summary: completedSummary(input),
  };
}

/**
 * Fake recovery has no provider process or credential storage. Its context is
 * reconstructed from the durable attempt fence, so process restarts remain
 * deterministic and cancellation uses the same generic stop boundary.
 */
export function hermeticReconciliationProvider(): RunnerReconciliationProvider {
  return {
    requiresAttemptRedaction: false,
    resolveExecutionContext: async (run, authority) =>
      contextFor(run, authority),
    snapshot: (input) => {
      verifySnapshotInput(input);
      if ((input.context as unknown as HermeticReconciliationContext).held) {
        return Promise.resolve({
          cursor: input.cursor,
          events: [],
          exitCode: null,
          logsSettled: true,
          status: "running",
          summary: heldSummary(),
        });
      }
      return Promise.resolve(snapshot(input));
    },
    stop: (context, input) => {
      const candidate = context as unknown as HermeticReconciliationContext;
      return Promise.resolve(
        candidate.attemptId === input.attemptId &&
          candidate.runId === input.runId
          ? { kind: "stopped" }
          : { kind: "provider_not_found" }
      );
    },
  };
}
