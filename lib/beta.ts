/**
 * Paths that stay reachable while the beta gate is closed.
 *
 * `/api/internal` is the important one: the Cloudflare Worker calls it with a
 * service token and a signed Ed25519 identity claim and carries no NextAuth
 * cookie, so gating it would break every run instead of closing the beta. It
 * is not a hole — that route authenticates itself, and more strictly than this
 * gate does.
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
  "/api/internal",
  "/api/stripe",
  "/login",
  "/ping",
  "/security",
];

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

  return (
    Boolean(email) && gate.allowlist.includes(normalizeEmail(email as string))
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
