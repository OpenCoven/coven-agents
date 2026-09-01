import type { RunnerDispatchState } from "./types";

export const RUNNER_MID_RUN_ENTITLEMENT_POLICY = Object.freeze({
  maxDurationMs: 15 * 60_000,
  postLaunch: "finish_current",
  preLaunch: "revalidate_before_effects",
} as const);

export type RunnerMidRunEntitlementPolicy = Readonly<{
  maxDurationMs: number;
  postLaunch: "finish_current";
  preLaunch: "revalidate_before_effects";
}>;

export type RunnerEntitlementContinuation =
  | "finish_current"
  | "max_duration_elapsed"
  | RunnerMidRunEntitlementPolicy["preLaunch"];

export function runnerEntitlementContinuation(
  input: Readonly<{
    dispatchState: RunnerDispatchState;
    hasDurablyAuthorizedLaunch: boolean;
    now: Date;
    startedAt: Date | null;
    policy?: RunnerMidRunEntitlementPolicy;
  }>
): RunnerEntitlementContinuation {
  const policy = input.policy ?? RUNNER_MID_RUN_ENTITLEMENT_POLICY;
  if (input.dispatchState !== "running" || !input.hasDurablyAuthorizedLaunch) {
    return "revalidate_before_effects";
  }
  if (
    input.startedAt === null ||
    Number.isNaN(input.startedAt.valueOf()) ||
    Number.isNaN(input.now.valueOf()) ||
    input.now.getTime() - input.startedAt.getTime() >= policy.maxDurationMs
  ) {
    return "max_duration_elapsed";
  }
  return policy.postLaunch;
}
