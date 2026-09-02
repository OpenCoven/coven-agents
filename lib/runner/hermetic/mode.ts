export const HERMETIC_RUNNER_FLAG = "COVEN_HERMETIC_RUNNER";
export const HERMETIC_RUNNER_E2E_FLAG = "E2E_HERMETIC_RUNNER";

export type HermeticRunnerMode = "daytona" | "hermetic";
export type HermeticRunnerEnvironment = Readonly<
  Record<string, string | undefined>
>;

/**
 * The hermetic adapter is an E2E-only server composition. It is deliberately
 * not a browser or request setting: production and malformed selections fail
 * before a provider client can be composed.
 */
export function hermeticRunnerMode(
  environment: HermeticRunnerEnvironment = process.env
): HermeticRunnerMode {
  const selection = environment[HERMETIC_RUNNER_FLAG];
  if (selection === undefined) {
    return "daytona";
  }
  if (selection !== "1") {
    throw new Error(`${HERMETIC_RUNNER_FLAG} must be exactly "1" when set.`);
  }
  if (environment.NODE_ENV === "production") {
    throw new Error(
      `${HERMETIC_RUNNER_FLAG} is unavailable when NODE_ENV is production.`
    );
  }
  if (environment[HERMETIC_RUNNER_E2E_FLAG] !== "1") {
    throw new Error(
      `${HERMETIC_RUNNER_FLAG} requires ${HERMETIC_RUNNER_E2E_FLAG}=1.`
    );
  }
  return "hermetic";
}
