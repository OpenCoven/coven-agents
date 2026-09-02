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
import {
  HERMETIC_EXECUTION_PROVENANCE,
  HERMETIC_HOLD_TASK_MARKER,
  hermeticCommandId,
} from "./executor";

declare const hermeticReconciliationContextBrand: unique symbol;

type HermeticReconciliationContext = Readonly<{
  attemptId: string;
  commandId: string;
  held: boolean;
  runId: string;
  sessionId: string;
  readonly [hermeticReconciliationContextBrand]: "HermeticReconciliationContext";
}>;

const EVENT_TIME = "2026-09-01T00:00:00.000Z";

function unavailable(message: string): Error {
  return new Error(`Hermetic reconciliation is unavailable: ${message}.`);
}

function hasExactHermeticProvenance(run: RunnerRunRecord): boolean {
  const provenance = run.executionProvenance;
  const expectedEntries = Object.entries(HERMETIC_EXECUTION_PROVENANCE);
  return (
    provenance !== null &&
    Object.keys(provenance).length === expectedEntries.length &&
    expectedEntries.every(
      ([key, value]) => provenance[key as keyof typeof provenance] === value
    )
  );
}

function contextFor(
  run: RunnerRunRecord,
  authority: RunnerDispatchAuthority
): RunnerReconciliationContext | null {
  const { attemptId } = authority;
  if (
    !attemptId ||
    !hasExactHermeticProvenance(run) ||
    run.daytonaAttemptId !== attemptId
  ) {
    throw unavailable("attempt ownership is ambiguous");
  }
  if (run.daytonaSessionId === null && run.daytonaCommandId === null) {
    return null;
  }
  if (
    run.daytonaCommandId !== hermeticCommandId(run.id, attemptId) ||
    run.daytonaSessionId !== daytonaRunSessionName(run.id, attemptId)
  ) {
    throw unavailable("attempt ownership is ambiguous");
  }
  return Object.freeze({
    attemptId,
    commandId: hermeticCommandId(run.id, attemptId),
    held: run.task.includes(HERMETIC_HOLD_TASK_MARKER),
    runId: run.id,
    sessionId: daytonaRunSessionName(run.id, attemptId),
  } as unknown as RunnerReconciliationContext);
}

function verifySnapshotInput(
  input: RunnerAttemptSnapshotInput,
  contexts: WeakSet<RunnerReconciliationContext>
): void {
  const context = input.context as unknown as HermeticReconciliationContext;
  if (
    !contexts.has(input.context) ||
    context.runId !== input.runId ||
    context.attemptId !== input.attemptId ||
    context.commandId !== hermeticCommandId(input.runId, input.attemptId) ||
    context.sessionId !== daytonaRunSessionName(input.runId, input.attemptId) ||
    input.commandId !== context.commandId
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
  const contexts = new WeakSet<RunnerReconciliationContext>();
  return {
    requiresAttemptRedaction: false,
    resolveExecutionContext: (run, authority) => {
      try {
        const context = contextFor(run, authority);
        if (context) {
          contexts.add(context);
        }
        return Promise.resolve(context);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    snapshot: (input) => {
      verifySnapshotInput(input, contexts);
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
        contexts.has(context) &&
          candidate.attemptId === input.attemptId &&
          candidate.runId === input.runId &&
          candidate.commandId ===
            hermeticCommandId(input.runId, input.attemptId) &&
          candidate.sessionId ===
            daytonaRunSessionName(input.runId, input.attemptId)
          ? { kind: "stopped" }
          : { kind: "provider_unavailable" }
      );
    },
  };
}
