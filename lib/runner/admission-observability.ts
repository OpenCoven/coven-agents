export type RunnerAdmissionFailureStage =
  | "admission"
  | "agent_lookup"
  | "run_insert";

export type RunnerAdmissionFailure = Readonly<{
  code: string | null;
  name: "DrizzleError" | "Error" | "PostgresError" | "TypeError" | "unknown";
  stage: RunnerAdmissionFailureStage;
}>;

const SAFE_ERROR_NAMES = new Set<RunnerAdmissionFailure["name"]>([
  "DrizzleError",
  "Error",
  "PostgresError",
  "TypeError",
]);

function safeErrorDetails(
  error: unknown
): Pick<RunnerAdmissionFailure, "code" | "name"> {
  let candidate = error;
  let code: string | null = null;
  let name: RunnerAdmissionFailure["name"] = "unknown";
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof candidate !== "object" || candidate === null) {
      break;
    }
    const current = candidate as Readonly<{
      cause?: unknown;
      code?: unknown;
      name?: unknown;
    }>;
    const { cause, code: currentCode, name: currentName } = current;
    if (typeof currentCode === "string" && /^[0-9A-Z]{5}$/u.test(currentCode)) {
      code = currentCode;
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
  return { code, name };
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
