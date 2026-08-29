import "server-only";

import type { RunnerDispatchResult } from "./admission";
import type { RunnerScheduledStartResult, RunnerStartResult } from "./service";
import type { RunnerClaimedDispatch } from "./types";

export type RunnerTaskScheduler = (
  callback: () => void | Promise<void>
) => void;

export type AdmitAndScheduleRunnerRunDependencies = Readonly<{
  dispatchClaim: (
    claimed: RunnerClaimedDispatch
  ) => Promise<RunnerDispatchResult>;
  reconcile: () => Promise<unknown>;
  schedule: RunnerTaskScheduler;
}>;

async function safely(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch {
    // Durable dispatch leases and recurring reconciliation recover the run.
  }
}

function scheduleSafely(
  schedule: RunnerTaskScheduler,
  operation: () => Promise<unknown>
): void {
  try {
    schedule(() => safely(operation));
  } catch {
    // Scheduling is a latency optimization; durable reconciliation remains.
  }
}

export function admitAndScheduleRunnerRun(
  result: RunnerStartResult,
  dependencies: AdmitAndScheduleRunnerRunDependencies
): RunnerScheduledStartResult {
  if (result.kind !== "accepted") {
    return result;
  }

  const { admission } = result;
  switch (admission) {
    case "claimed":
      scheduleSafely(dependencies.schedule, () =>
        dependencies.dispatchClaim(result.claimed)
      );
      break;
    case "created":
      scheduleSafely(dependencies.schedule, dependencies.reconcile);
      break;
    case "duplicate":
      break;
    default: {
      const unsupported: never = admission;
      throw new Error(`Unsupported runner admission result: ${unsupported}`);
    }
  }

  return { kind: "accepted", run: result.run };
}
