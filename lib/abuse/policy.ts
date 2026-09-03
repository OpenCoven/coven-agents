import type { AbusePolicy, AbuseRoute } from "./types";

type RateClass = Pick<AbusePolicy, "burst" | "sustained">;

const PUBLIC_READ = rateClass(120, 60, 1200, 3600);
const STANDARD_READ = rateClass(60, 60, 600, 3600);
const EXPENSIVE_READ = rateClass(20, 60, 100, 3600);
const STANDARD_WRITE = rateClass(20, 60, 100, 3600);
const SENSITIVE_READ = rateClass(30, 60, 200, 3600);
const SENSITIVE_WRITE = rateClass(10, 60, 40, 3600);
const DESTRUCTIVE_WRITE = rateClass(5, 60, 20, 3600);
// Session reads reach Auth.js' JWE decoder even when a cookie is malformed.
// Gate every source first while leaving ample headroom for shared NATs.
const AUTH_SESSION_READ_IP = rateClass(600, 60, 10_000, 3600);
// Session-update POSTs are tiny, but they reach Auth.js' CSRF/JWE machinery.
// Admit every source before body or cookie work, while leaving enough room
// for many normal clients behind one NAT. Verified users keep the stricter
// existing 20/minute and 100/hour write budget below.
const AUTH_SESSION_UPDATE_IP = rateClass(120, 60, 1200, 3600);
// Subscription status is a cheap account read, but JWT verification is not.
// Gate every source before JWE work with ample shared-NAT headroom; verified
// users retain the existing 60/minute and 600/hour budget below.
const SUBSCRIPTION_READ_IP = rateClass(600, 60, 10_000, 3600);
// One GitHub device flow can poll 180 times at the normal five-second cadence.
// The start policy caps a subject at five attempts/hour, so 1200 polls leaves
// 300 requests of retry/reconnect headroom over five complete flows. The
// 90/minute window admits those flows behind one IP with 50% burst headroom.
const CREDENTIAL_DEVICE_POLL = rateClass(90, 60, 1200, 3600);
// Stripe retries and renewal batches can legitimately share an egress IP.
// This route still has its own IP-only budget and a bounded 256 KiB reader.
const WEBHOOK_WRITE = rateClass(600, 60, 10_000, 3600);
const GITHUB_TOOL_IP = rateClass(600, 60, 10_000, 3600);

const POLICIES = Object.freeze({
  analytics_read: closedPolicy(["ip", "user"], 0, EXPENSIVE_READ),
  auth_callback: closedPolicy(["ip"], 16_384, rateClass(10, 60, 40, 3600)),
  auth_session_read_ip: closedPolicy(["ip"], 0, AUTH_SESSION_READ_IP),
  // Auth.js session-update and CSRF JSON is normally under 1 KiB. A 16 KiB
  // raw-byte ceiling leaves generous protocol headroom without allowing its
  // internal parser to buffer an attacker-controlled body.
  auth_session_update: closedPolicy(["user"], 16_384, STANDARD_WRITE),
  auth_session_update_ip: closedPolicy(["ip"], 16_384, AUTH_SESSION_UPDATE_IP),
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
    CREDENTIAL_DEVICE_POLL
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
  github_callback: closedPolicy(["ip", "user"], 0, rateClass(10, 60, 40, 3600)),
  github_connection_delete: closedPolicy(
    ["ip", "tenant"],
    0,
    DESTRUCTIVE_WRITE
  ),
  github_connection_read: closedPolicy(["ip", "user"], 0, SENSITIVE_READ),
  github_install: closedPolicy(["ip", "user"], 0, rateClass(2, 300, 5, 3600)),
  github_tool: closedPolicy(["ip"], 524_288, GITHUB_TOOL_IP),
  history_delete: closedPolicy(["ip", "user"], 0, DESTRUCTIVE_WRITE),
  history_read: closedPolicy(["ip", "user"], 0, STANDARD_READ),
  internal_credential: closedPolicy(
    ["ip", "tenant"],
    8192,
    rateClass(10, 60, 60, 3600)
  ),
  messages_read: closedPolicy(["ip", "user"], 0, STANDARD_READ),
  // A top-up is a one-time payment; a few per hour is generous for a person.
  minute_pack_checkout: closedPolicy(
    ["ip", "user"],
    1024,
    rateClass(3, 300, 6, 3600)
  ),
  model_list: closedPolicy(["ip"], 0, PUBLIC_READ),
  run_start: closedPolicy(
    ["ip", "tenant"],
    64_000,
    rateClass(5, 60, 25, 86_400)
  ),
  runner_diagnostic: closedPolicy(["ip"], 1024, rateClass(2, 300, 10, 86_400)),
  runner_public_read: closedPolicy(["ip"], 0, PUBLIC_READ),
  runner_read: closedPolicy(["ip", "user"], 0, STANDARD_READ),
  runner_reconcile: closedPolicy(["ip"], 1024, rateClass(120, 60, 1200, 3600)),
  runner_run_start: closedPolicy(
    ["ip", "tenant"],
    64_000,
    rateClass(5, 60, 25, 86_400)
  ),
  runner_stop: closedPolicy(["ip", "tenant"], 1024, DESTRUCTIVE_WRITE),
  runner_write: closedPolicy(["ip", "user"], 64_000, SENSITIVE_WRITE),
  skill_delete: closedPolicy(["ip", "tenant"], 0, DESTRUCTIVE_WRITE),
  skill_read: closedPolicy(["ip", "user"], 0, STANDARD_READ),
  skill_write: closedPolicy(["ip", "tenant"], 8192, SENSITIVE_WRITE),
  // Scheduled repair does no request parsing and is bounded by its DB lease.
  stripe_reconcile: closedPolicy(["ip"], 0, rateClass(120, 60, 1200, 3600)),
  // Admission runs before the signed raw body is read.
  stripe_webhook: closedPolicy(["ip"], 262_144, WEBHOOK_WRITE),
  subscription_read: closedPolicy(["user"], 0, STANDARD_READ),
  subscription_read_ip: closedPolicy(["ip"], 0, SUBSCRIPTION_READ_IP),
  suggestions_read: closedPolicy(["ip", "user"], 0, STANDARD_READ),
  team_delete: closedPolicy(["ip", "tenant"], 0, DESTRUCTIVE_WRITE),
  team_read: closedPolicy(["ip", "user"], 0, STANDARD_READ),
  team_run_approve: closedPolicy(["ip", "tenant"], 4096, SENSITIVE_WRITE),
  team_run_read: closedPolicy(["ip", "user"], 0, STANDARD_READ),
  team_run_start: closedPolicy(
    ["ip", "tenant"],
    64_000,
    rateClass(5, 60, 25, 86_400)
  ),
  team_run_stop: closedPolicy(["ip", "tenant"], 1024, DESTRUCTIVE_WRITE),
  team_write: closedPolicy(["ip", "tenant"], 131_072, SENSITIVE_WRITE),
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
