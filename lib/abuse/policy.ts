import type { AbusePolicy, AbuseRoute } from "./types";

type RateClass = Pick<AbusePolicy, "burst" | "sustained">;

const PUBLIC_READ = rateClass(120, 60, 1200, 3600);
const STANDARD_READ = rateClass(60, 60, 600, 3600);
const EXPENSIVE_READ = rateClass(20, 60, 100, 3600);
const STANDARD_WRITE = rateClass(20, 60, 100, 3600);
const SENSITIVE_READ = rateClass(30, 60, 200, 3600);
const SENSITIVE_WRITE = rateClass(10, 60, 40, 3600);
const DESTRUCTIVE_WRITE = rateClass(5, 60, 20, 3600);
const WEBHOOK_WRITE = rateClass(60, 60, 600, 3600);

const POLICIES = Object.freeze({
  analytics_read: closedPolicy(["ip", "user"], 0, EXPENSIVE_READ),
  auth_callback: closedPolicy(["ip"], 16_384, rateClass(10, 60, 40, 3600)),
  auth_start: closedPolicy(["ip"], 0, rateClass(5, 60, 20, 3600)),
  avatar_read: closedPolicy(["ip", "user"], 0, STANDARD_READ),
  avatar_write: closedPolicy(["ip", "user"], 8192, SENSITIVE_WRITE),
  chat: closedPolicy(["ip", "user"], 64_000, rateClass(4, 60, 60, 3600)),
  chat_delete: closedPolicy(["ip", "user"], 0, DESTRUCTIVE_WRITE),
  checkout: closedPolicy(["ip", "user"], 8192, rateClass(2, 300, 3, 3600)),
  credential_delete: closedPolicy(["ip", "user"], 8192, SENSITIVE_WRITE),
  credential_device_poll: closedPolicy(
    ["ip", "user"],
    8192,
    rateClass(12, 60, 60, 3600)
  ),
  credential_device_start: closedPolicy(
    ["ip", "user"],
    0,
    rateClass(2, 300, 5, 3600)
  ),
  credential_list: closedPolicy(["ip", "user"], 0, SENSITIVE_READ),
  credential_write: closedPolicy(["ip", "user"], 16_384, SENSITIVE_WRITE),
  document_delete: closedPolicy(["ip", "user"], 0, DESTRUCTIVE_WRITE),
  document_read: closedPolicy(["ip", "user"], 0, STANDARD_READ),
  document_write: closedPolicy(["ip", "user"], 262_144, STANDARD_WRITE),
  history_delete: closedPolicy(["ip", "user"], 0, DESTRUCTIVE_WRITE),
  history_read: closedPolicy(["ip", "user"], 0, STANDARD_READ),
  internal_credential: closedPolicy(
    ["ip", "tenant"],
    8192,
    rateClass(10, 60, 60, 3600)
  ),
  messages_read: closedPolicy(["ip", "user"], 0, STANDARD_READ),
  model_list: closedPolicy(["ip"], 0, PUBLIC_READ),
  run_start: closedPolicy(
    ["ip", "tenant"],
    64_000,
    rateClass(5, 60, 25, 86_400)
  ),
  runner_connection: closedPolicy(
    ["ip", "user"],
    0,
    rateClass(10, 60, 60, 3600)
  ),
  runner_token: closedPolicy(["ip", "user"], 0, rateClass(10, 60, 60, 3600)),
  stripe_webhook: closedPolicy(["ip"], 262_144, WEBHOOK_WRITE),
  suggestions_read: closedPolicy(["ip", "user"], 0, STANDARD_READ),
  upload: closedPolicy(["ip", "user"], 5_250_000, rateClass(2, 60, 20, 3600)),
  usage_read: closedPolicy(["ip", "user"], 0, STANDARD_READ),
  vote_read: closedPolicy(["ip", "user"], 0, STANDARD_READ),
  vote_write: closedPolicy(["ip", "user"], 8192, STANDARD_WRITE),
} satisfies Record<AbuseRoute, AbusePolicy>);

export function abusePolicyFor(route: unknown): AbusePolicy {
  if (typeof route !== "string" || !Object.hasOwn(POLICIES, route)) {
    const renderedRoute =
      typeof route === "string" ? JSON.stringify(route) : `<${typeof route}>`;
    throw new Error(`No abuse policy for ${renderedRoute}.`);
  }

  return POLICIES[route as AbuseRoute];
}

function rateClass(
  burstLimit: number,
  burstWindowSeconds: number,
  sustainedLimit: number,
  sustainedWindowSeconds: number
): RateClass {
  return Object.freeze({
    burst: Object.freeze({
      limit: burstLimit,
      windowSeconds: burstWindowSeconds,
    }),
    sustained: Object.freeze({
      limit: sustainedLimit,
      windowSeconds: sustainedWindowSeconds,
    }),
  });
}

function closedPolicy(
  subjects: AbusePolicy["subjects"],
  bodyBytes: number,
  rates: RateClass
): AbusePolicy {
  return Object.freeze({
    bodyBytes,
    burst: Object.freeze({ ...rates.burst }),
    failureMode: "closed",
    subjects: Object.freeze([...subjects]),
    sustained: Object.freeze({ ...rates.sustained }),
  });
}
