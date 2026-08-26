export type WorkerRouteClass = "mutation" | "read" | "run";
export type WorkerAbuseStage = "source" | "tenant";

export type WorkerAbuseDecision =
  | { kind: "allowed" }
  | { kind: "limited"; retryAfterSeconds: 60 }
  | { kind: "unavailable" };

type WorkerAbuseEnvironment = {
  EDGE_ABUSE_KEY_SECRET?: string;
  EDGE_REQUEST_LIMITER?: RateLimit;
  TENANT_MUTATION_LIMITER?: RateLimit;
  TENANT_RUN_LIMITER?: RateLimit;
};

const RETRY_AFTER_SECONDS = 60;
const RUN_START_PATH = /^\/api\/agents\/[^/]+\/runs\/?$/;
const SANDBOX_DIAGNOSTIC_PATH = /^\/api\/diagnostics\/sandbox\/?$/;
// Prewarm boots a container just like a run does, so it spends the run
// budget rather than the cheaper mutation one — the limiter exists to bound
// container churn, and this is container churn.
const PREWARM_PATH = /^\/api\/tenant\/prewarm\/?$/;

export function workerRouteClass(
  method: string,
  pathname: string
): WorkerRouteClass {
  const normalizedMethod = method.toUpperCase();
  if (
    normalizedMethod === "POST" &&
    (RUN_START_PATH.test(pathname) ||
      SANDBOX_DIAGNOSTIC_PATH.test(pathname) ||
      PREWARM_PATH.test(pathname))
  ) {
    return "run";
  }
  return normalizedMethod === "GET" ? "read" : "mutation";
}

export async function enforceWorkerEdgeLimit(input: {
  env: WorkerAbuseEnvironment;
  ip: string | null;
  routeClass: WorkerRouteClass;
  stage: WorkerAbuseStage;
  tenant?: string;
}): Promise<WorkerAbuseDecision> {
  if (input.stage === "tenant" && input.routeClass === "read") {
    return { kind: "allowed" };
  }

  const secret = input.env.EDGE_ABUSE_KEY_SECRET?.trim();
  if (!secret) {
    return { kind: "unavailable" };
  }

  const limiter =
    input.stage === "source"
      ? input.env.EDGE_REQUEST_LIMITER
      : tenantLimiter(input.env, input.routeClass);
  if (!limiter) {
    return { kind: "unavailable" };
  }

  const subject =
    input.stage === "source"
      ? sourceSubject(input.ip)
      : tenantSubject(input.tenant);
  if (!subject) {
    return { kind: "unavailable" };
  }

  try {
    const key = await pseudonymousKey(secret, `${input.stage}:${subject}`);
    const outcome = await limiter.limit({ key });
    return outcome.success
      ? { kind: "allowed" }
      : { kind: "limited", retryAfterSeconds: RETRY_AFTER_SECONDS };
  } catch {
    return { kind: "unavailable" };
  }
}

function tenantLimiter(
  env: WorkerAbuseEnvironment,
  routeClass: WorkerRouteClass
): RateLimit | undefined {
  return routeClass === "run"
    ? env.TENANT_RUN_LIMITER
    : env.TENANT_MUTATION_LIMITER;
}

function sourceSubject(value: string | null): string | null {
  const normalized = value?.trim() || "unknown";
  return normalized.length <= 256 ? normalized : null;
}

function tenantSubject(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized && normalized.length <= 256 ? normalized : null;
}

async function pseudonymousKey(
  secret: string,
  subject: string
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(subject))
  );
  return `v1:${[...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
