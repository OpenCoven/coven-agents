export type RunnerAdmissionFailureStage =
  | "admission"
  | "agent_lookup"
  | "run_insert";

export type RunnerAdmissionFailure = Readonly<{
  code: string | null;
  /**
   * The exact database guard that refused the write, present only when a
   * `RAISE EXCEPTION` (SQLSTATE P0001) message matches one of the static
   * trigger messages this repository owns in `lib/db/migrations`. Arbitrary
   * database text is never reported.
   */
  guard?: RunnerDatabaseGuard;
  name: "DrizzleError" | "Error" | "PostgresError" | "TypeError" | "unknown";
  stage: RunnerAdmissionFailureStage;
}>;

const SAFE_ERROR_NAMES = new Set<RunnerAdmissionFailure["name"]>([
  "DrizzleError",
  "Error",
  "PostgresError",
  "TypeError",
]);

/** SQLSTATE for a PL/pgSQL `RAISE EXCEPTION` without an explicit ERRCODE. */
const RAISE_EXCEPTION_CODE = "P0001";

/**
 * Every `RAISE EXCEPTION` message a trigger in `lib/db/migrations` can emit at
 * runtime. Migration-time `DO` block messages are excluded. A unit test keeps
 * this list identical to the migration sources.
 */
export const RUNNER_DATABASE_GUARDS = [
  "GitHub capability authority is immutable",
  "GitHub operation live connection tenant mismatch",
  "GitHub operation pre-send retry transition is invalid",
  "GitHub operation request authority is immutable",
  "GitHub operation status transition is invalid",
  "GitHub provider dispatch transition is invalid",
  "GitHub provider sent timestamp is immutable",
  "GitHub write intent release is invalid",
  "GitHub write intent retry is invalid",
  "Non-GitHub team child cannot persist broker authority",
  "Ordinary runner run cannot persist team broker authority",
  "Project operation requires exact current authority",
  "Read-only GitHub operation dispatch state is immutable",
  "Restricted execution requires a clean sandbox trust profile",
  "Runner execution authority is immutable",
  "Sent GitHub operation dispatch state is immutable",
  "Team child GitHub broker policy conflicts with durable authority",
  "Team child execution permission conflicts with its immutable snapshot",
  "Team child insert requires explicit execution permission",
  "Team child insert requires its exact team step",
  "Team child requires an explicit workspace",
  "Team child requires declared execution permission",
  "Team child requires declared workspace permission",
  "Team child runtime cannot enforce workspace permissions",
  "TenantCredential envelope fields require a new envelopeRevision",
  "Terminal GitHub operation is immutable",
] as const;

export type RunnerDatabaseGuard = (typeof RUNNER_DATABASE_GUARDS)[number];

const RUNNER_DATABASE_GUARD_SET: ReadonlySet<string> = new Set(
  RUNNER_DATABASE_GUARDS
);

function safeErrorDetails(
  error: unknown
): Pick<RunnerAdmissionFailure, "code" | "guard" | "name"> {
  let candidate = error;
  let code: string | null = null;
  let guard: RunnerDatabaseGuard | undefined;
  let name: RunnerAdmissionFailure["name"] = "unknown";
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof candidate !== "object" || candidate === null) {
      break;
    }
    const current = candidate as Readonly<{
      cause?: unknown;
      code?: unknown;
      message?: unknown;
      name?: unknown;
    }>;
    const {
      cause,
      code: currentCode,
      message: currentMessage,
      name: currentName,
    } = current;
    if (typeof currentCode === "string" && /^[0-9A-Z]{5}$/u.test(currentCode)) {
      code = currentCode;
    }
    if (
      currentCode === RAISE_EXCEPTION_CODE &&
      typeof currentMessage === "string" &&
      RUNNER_DATABASE_GUARD_SET.has(currentMessage)
    ) {
      guard = currentMessage as RunnerDatabaseGuard;
    }
    if (
      typeof currentName === "string" &&
      SAFE_ERROR_NAMES.has(currentName as RunnerAdmissionFailure["name"])
    ) {
      name = currentName as RunnerAdmissionFailure["name"];
    }
    if (cause === candidate) {
      break;
    }
    candidate = cause;
  }
  return { code, ...(guard ? { guard } : {}), name };
}

export function runnerAdmissionFailure(
  stage: RunnerAdmissionFailureStage,
  error: unknown
): RunnerAdmissionFailure {
  return {
    ...safeErrorDetails(error),
    stage,
  };
}
