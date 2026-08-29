export type ApplicationRunnerStatusKind =
  | "connected"
  | "connecting"
  | "rate_limited"
  | "signed_out"
  | "subscription_required"
  | "unavailable";

export function applicationRunnerStatusFromError(error: {
  code: string;
  status: number;
}): Exclude<ApplicationRunnerStatusKind, "connected" | "connecting"> | null {
  if (error.status === 401 || error.code === "unauthorized") {
    return "signed_out";
  }
  if (error.status === 403 || error.code === "subscription_required") {
    return "subscription_required";
  }
  if (error.status === 429 || error.code === "rate_limited") {
    return "rate_limited";
  }
  return error.status >= 500 ? "unavailable" : null;
}

const APPLICATION_RUNNER_MESSAGES: Record<ApplicationRunnerStatusKind, string> =
  {
    connected: "The Daytona runner answered for this authenticated session.",
    connecting: "Connecting to the Daytona runner…",
    rate_limited: "Rate limited — access will be retried automatically.",
    signed_out: "Sign in to use the Daytona runner.",
    subscription_required: "An active subscription is required to run agents.",
    unavailable:
      "The Daytona runner is temporarily unavailable. Try again shortly.",
  };

export function applicationRunnerMessage(
  kind: ApplicationRunnerStatusKind
): string {
  return APPLICATION_RUNNER_MESSAGES[kind];
}
