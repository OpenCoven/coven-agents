import type { JWT } from "next-auth/jwt";
import {
  authVersionMatches,
  validAuthVersion,
} from "./auth/session-revocation";
import { ChatbotError } from "./errors";
import { isCanonicalUuid } from "./session";
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

type StoredUserClaims = {
  authVersion: number;
  image: string | null;
  subscribedUntil: Date | null;
};

export function claimsFromStoredUser(
  token: JWT,
  user: StoredUserClaims,
  now: Date
): JWT {
  return {
    ...token,
    authVersion: user.authVersion,
    picture: user.image,
    subscribedUntil: user.subscribedUntil?.toISOString() ?? null,
    type: userTypeFor(user, now),
  };
}

/**
 * Reloads an update from storage without trusting any authority or presentation
 * field in the browser payload. Returning null is Auth.js' instruction to
 * clear an invalid or revoked JWT. A classified database outage instead keeps
 * the exact old token: no claim is promoted, while Auth.js also avoids
 * mistaking an unavailable lookup for a broken cookie and deleting it.
 */
export async function refreshClaimsForSessionUpdate(
  token: JWT,
  _clientUpdate: unknown,
  findUser: (userId: string) => Promise<StoredUserClaims | null>,
  now: Date
): Promise<JWT | null> {
  const userId = token.id;
  if (
    typeof userId !== "string" ||
    !isCanonicalUuid(userId) ||
    !validAuthVersion(token.authVersion)
  ) {
    return null;
  }

  let user: StoredUserClaims | null;
  try {
    user = await findUser(userId);
  } catch (error) {
    if (error instanceof ChatbotError && error.surface === "database") {
      return token;
    }
    throw error;
  }
  if (!user || !authVersionMatches(user.authVersion, token.authVersion)) {
    return null;
  }

  return claimsFromStoredUser(token, user, now);
}
