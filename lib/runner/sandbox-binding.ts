import "server-only";

import {
  RUN_SANDBOX_BINDING_REFUSAL_CODE,
  type RunSandboxBindingRefusalReason,
} from "@opencoven/agent-contracts";
import type { RunnerAgentRecord, RunnerSandboxBinding } from "./types";

export const SANDBOX_BINDING_REFUSAL_CODE = RUN_SANDBOX_BINDING_REFUSAL_CODE;
export const SANDBOX_BINDING_REFUSAL_MESSAGE =
  "The run's sandbox binding did not match the agent's recorded sandbox; nothing was created or changed.";

export type SandboxBindingRefusalReason = RunSandboxBindingRefusalReason;

/**
 * Compares a run's binding with the durable agent record. A binding is an
 * expectation that can only refuse: this never records, adopts, or selects a
 * sandbox. Returns null when the record still matches.
 */
export function sandboxBindingRecordRefusal(
  agent: Pick<
    RunnerAgentRecord,
    "daytonaSandboxId" | "sandboxGeneration" | "sandboxLifecycle"
  >,
  binding: RunnerSandboxBinding
): Extract<
  SandboxBindingRefusalReason,
  | "generation_mismatch"
  | "lifecycle_not_ready"
  | "no_recorded_sandbox"
  | "sandbox_id_mismatch"
> | null {
  if (!agent.daytonaSandboxId) {
    return "no_recorded_sandbox";
  }
  if (agent.daytonaSandboxId !== binding.expectedSandboxId) {
    return "sandbox_id_mismatch";
  }
  if (agent.sandboxGeneration !== binding.expectedGeneration) {
    return "generation_mismatch";
  }
  if (agent.sandboxLifecycle !== "ready") {
    return "lifecycle_not_ready";
  }
  return null;
}
