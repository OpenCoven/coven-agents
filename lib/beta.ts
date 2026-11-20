import { isCanonicalUuid } from "./session";

/**
 * Paths that stay reachable while the beta gate is closed.
 *
 * `/api/health` is the unauthenticated Agent Runner v1 health contract. It
 * serves a static capability descriptor under its own IP policy, so an Auth.js
 * login redirect would violate the machine-client contract.
 *
 * `/api/diagnostics/sandbox` is an operator route authorized by its dedicated
 * `OPERATOR_DIAGNOSTIC_TOKEN`, not an Auth.js cookie. Its exact exemption lets
 * the route enforce that authority itself without opening descendants or
 * future `/api/diagnostics/*` routes.
 *
 * `/api/internal/runner-reconcile`,
 * `/api/internal/runner-resource-inventory`, and
 * `/api/internal/runner-resource-repair`, and
 * `/api/internal/stripe-reconcile` are machine-triggered routes that carry no
 * Auth.js cookie. Gating them would disable recovery or operator inventory
 * instead of closing the beta. Each authenticates itself with its
 * route-specific machine credential. No other `/api/internal/*` route inherits
 * this exemption.
 *
 * `/api/internal/github-tool` is the exact cookieless agent gateway. Proxy
 * must let the route enforce its step capability instead of redirecting it to
 * browser login. Siblings, descendants, and lookalikes remain gated.
 *
 * `/api/stripe` is exempt for the same reason and is not optional: Stripe does
 * not follow redirects when delivering a webhook, so a gated endpoint turns
 * every event into a delivery failure and subscriptions silently stop being
 * recorded. That route authenticates by signature, which is stronger than the
 * gate it is skipping.
 *
 * `/login`, `/api/auth` and `/ping` keep the gate escapable and the health
 * check honest. `/register` is deliberately absent: an open registration route
 * hands a stranger the very account the gate exists to withhold.
 *
 * `/security` is public on purpose: it is the outward statement of the
 * execution boundary, and a security posture only readable by people already
 * inside the gate persuades nobody. The page is a static distillation — it
 * names the guarantees, never the internals.
 */
const EXEMPT_PREFIXES = [
  "/api/auth",
  "/api/stripe",
  "/login",
  "/ping",
  "/security",
];
const EXEMPT_PATHS = new Set([
  "/api/diagnostics/sandbox",
  "/api/health",
  "/api/internal/github-tool",
  "/api/internal/runner-reconcile",
  "/api/internal/runner-resource-inventory",
  "/api/internal/runner-resource-repair",
  "/api/internal/stripe-reconcile",
]);

export type BetaGate = {
  allowlist: string[];
  enabled: boolean;
  /**
   * Whether the open beta campaign is admitting people. When it is, any signed
   * in identity is invited and the allowlist stops being the guest list.
   *
   * Read from the campaign's own switch rather than a third `BETA_MODE` value,
   * because two flags can disagree and this pair would disagree expensively:
   * a campaign granting minutes behind a closed allowlist would hand people
   * free run time and then bounce them at the door.
   */
  open: boolean;
};

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Reads the gate from the environment.
 *
 * Enabling requires `BETA_MODE` to be exactly `on`. Truthiness would read the
 * string `"false"` as enabled, which is how a config typo becomes a lockout.
 *
 * The gate is off when unset, because a gate that switched itself on the
 * moment this merged would brick every existing checkout. Once on, though, it
 * fails closed — see `betaVerdict`.
 */
export function readBetaGate(env: {
  BETA_ALLOWLIST?: string;
  BETA_CAMPAIGN_ENABLED?: string;
  BETA_MODE?: string;
}): BetaGate {
  return {
    allowlist: (env.BETA_ALLOWLIST ?? "")
      .split(",")
      .map(normalizeEmail)
      .filter(Boolean),
    enabled:
      env.BETA_MODE === "on" || env.BETA_CAMPAIGN_ENABLED === "invite-only",
    open: env.BETA_CAMPAIGN_ENABLED === "on",
  };
}

/**
 * Prefix exemptions are anchored on a segment boundary; exact exemptions do
 * not authorize descendants or lookalike paths.
 */
function applicationPath(pathname: string, basePath: string): string {
  return basePath && pathname.startsWith(`${basePath}/`)
    ? pathname.slice(basePath.length)
    : pathname;
}

export function isCookielessGitHubToolRoute(
  pathname: string,
  basePath = ""
): boolean {
  return applicationPath(pathname, basePath) === "/api/internal/github-tool";
}

/** These handlers enforce the credential scope and the current owner's beta eligibility. */
export function isOwnerCredentialRoute(
  pathname: string,
  method: string,
  basePath = ""
) {
  const parts = applicationPath(pathname, basePath).split("/");
  if (
    parts[0] !== "" ||
    parts[1] !== "api" ||
    !isCanonicalUuid(parts[3] ?? "")
  ) {
    return false;
  }
  const [, , resource, , action, detail] = parts;
  if (resource === "agents" && method === "POST") {
    return (
      (parts.length === 5 && action === "runs") ||
      (parts.length === 6 && action === "sandbox" && detail === "inspection")
    );
  }
  if (resource !== "runs") {
    return false;
  }
  if (method === "GET") {
    return parts.length === 4 || (parts.length === 5 && action === "events");
  }
  return method === "POST" && parts.length === 5 && action === "stop";
}

export function isBetaExempt(pathname: string, basePath = ""): boolean {
  const path = applicationPath(pathname, basePath);
  return (
    EXEMPT_PATHS.has(path) ||
    EXEMPT_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`)
    )
  );
}

/**
 * Whether this identity is admitted at all, independent of the path.
 *
 * Separate from `betaVerdict` because the proxy needs both questions and they
 * are not the same one. "May this request proceed?" is true for `/login` even
 * when the person is not invited — otherwise the gate would be inescapable.
 * "Is this person invited?" is what decides whether signing in should bounce
 * them onward.
 *
 * Conflating the two is a redirect loop: a signed-in stranger is refused at
 * `/`, sent to `/login`, bounced back to `/` for being signed in, and so on.
 */
export function isAllowedIdentity(
  gate: BetaGate,
  email: string | null | undefined
): boolean {
  if (!gate.enabled) {
    return true;
  }

  if (gate.open) {
    return Boolean(email);
  }

  return (
    Boolean(email) && gate.allowlist.includes(normalizeEmail(email as string))
  );
}

/**
 * Whether this request may proceed while the beta is closed.
 *
 * An enabled gate with an empty allowlist denies everyone, unless the open
 * campaign is running. That is the whole point of failing closed: an unset or
 * mistyped `BETA_ALLOWLIST` must lock the door rather than remove it, because
 * the opposite default silently publishes the app to anyone holding the URL.
 * Opening the door to everyone is a deliberate act with its own switch, its
 * own account cap and its own minute budget — never the consequence of a typo.
 *
 * A signed-out visitor is denied. The demo session is stateless and needs no
 * sign-in, so without this the beta would not be closed at all — anyone
 * reaching the deployment would be handed a demo tenant.
 */
export function betaVerdict(
  gate: BetaGate,
  pathname: string,
  email: string | null | undefined,
  basePath = ""
): "allow" | "deny" {
  if (!gate.enabled) {
    return "allow";
  }

  if (isBetaExempt(pathname, basePath)) {
    return "allow";
  }

  if (!email) {
    return "deny";
  }

  // An open campaign invites everyone who signed in. The gate is still closed
  // to signed-out visitors: the campaign hands out minutes per account, and an
  // account is the only thing those minutes can be counted against.
  if (gate.open) {
    return "allow";
  }

  // Exact match on the normalized address. A substring test would let
  // `me@example.com.attacker.test` through.
  return gate.allowlist.includes(normalizeEmail(email)) ? "allow" : "deny";
}
