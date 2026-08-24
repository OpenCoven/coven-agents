/**
 * Paths that stay reachable while the beta gate is closed.
 *
 * `/api/internal` is the important one: the Cloudflare Worker calls it with a
 * service token and a signed Ed25519 identity claim and carries no NextAuth
 * cookie, so gating it would break every run instead of closing the beta. It
 * is not a hole — that route authenticates itself, and more strictly than this
 * gate does.
 *
 * `/login`, `/api/auth` and `/ping` keep the gate escapable and the health
 * check honest. `/register` is deliberately absent: an open registration route
 * hands a stranger the very account the gate exists to withhold.
 */
const EXEMPT_PREFIXES = ["/api/auth", "/api/internal", "/login", "/ping"];

export type BetaGate = {
  allowlist: string[];
  enabled: boolean;
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
  BETA_MODE?: string;
}): BetaGate {
  return {
    allowlist: (env.BETA_ALLOWLIST ?? "")
      .split(",")
      .map(normalizeEmail)
      .filter(Boolean),
    enabled: env.BETA_MODE === "on",
  };
}

/**
 * Prefix match anchored on a segment boundary, so `/api/internalish` does not
 * inherit `/api/internal`'s exemption.
 */
export function isBetaExempt(pathname: string): boolean {
  return EXEMPT_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

/**
 * Whether this request may proceed while the beta is closed.
 *
 * An enabled gate with an empty allowlist denies everyone. That is the whole
 * point of failing closed: an unset or mistyped `BETA_ALLOWLIST` must lock the
 * door rather than remove it, because the opposite default silently publishes
 * the app to anyone holding the URL.
 *
 * A signed-out visitor is denied. The demo session is stateless and needs no
 * sign-in, so without this the beta would not be closed at all — anyone
 * reaching the deployment would be handed a demo tenant.
 */
export function betaVerdict(
  gate: BetaGate,
  pathname: string,
  email: string | null | undefined
): "allow" | "deny" {
  if (!gate.enabled) {
    return "allow";
  }

  if (isBetaExempt(pathname)) {
    return "allow";
  }

  if (!email) {
    return "deny";
  }

  // Exact match on the normalized address. A substring test would let
  // `me@example.com.attacker.test` through.
  return gate.allowlist.includes(normalizeEmail(email)) ? "allow" : "deny";
}
