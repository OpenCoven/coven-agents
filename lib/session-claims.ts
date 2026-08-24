import { userTypeFor } from "./subscription";

type RefreshableToken = {
  subscribedUntil?: string | null;
  type?: unknown;
};

/**
 * Recomputes a token's plan from the subscription date it carries.
 *
 * `type` used to be written once, when `jwt()` received a `user` — that is,
 * only at sign-in. Nothing recomputed it afterwards, so a subscription that
 * lapsed left the holder with subscriber entitlements until their token
 * happened to expire. A subscriber session is what may write to the owner's
 * database, so that was access outliving payment.
 *
 * Carrying `subscribedUntil` in the token and deriving `type` from it on every
 * callback makes expiry exact and costs no database read. The date is the
 * source of truth; a `type` already in the token is never trusted, because a
 * stale one is precisely the bug being fixed.
 *
 * This fixes expiry, not upgrade: a user who pays mid-session still carries an
 * old date until their session refreshes. That belongs with checkout, which
 * knows when payment succeeded and can refresh deliberately, rather than being
 * approximated here by polling the database on every request.
 */
export function refreshTokenType<T extends RefreshableToken>(
  token: T,
  now: Date
): T & { type: "demo" | "subscriber" } {
  const raw = token.subscribedUntil;
  const parsed = raw ? new Date(raw) : null;
  const subscribedUntil =
    parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;

  return { ...token, type: userTypeFor({ subscribedUntil }, now) };
}
