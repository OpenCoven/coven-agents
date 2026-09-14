import type { JWT } from "next-auth/jwt";
import {
  authVersionMatches,
  validAuthVersion,
} from "./auth/session-revocation";
import { ChatbotError } from "./errors";
import { isCanonicalUuid } from "./session";
import { userTypeFor } from "./subscription";

type RefreshableToken = {
  campaignExpiresAt?: string | null;
  campaignGrantedAt?: string | null;
  subscribedUntil?: string | null;
  type?: unknown;
};

function claimDate(raw: string | null | undefined): Date | null {
  const parsed = raw ? new Date(raw) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
}

/**
 * Recomputes a token's plan from the entitlement dates it carries.
 *
 * `type` used to be written once, when `jwt()` received a `user` — that is,
 * only at sign-in. Nothing recomputed it afterwards, so a subscription that
 * lapsed left the holder with subscriber entitlements until their token
 * happened to expire. A subscriber session is what may write to the owner's
 * database, so that was access outliving payment.
 *
 * Carrying the dates in the token and deriving `type` from them on every
 * callback makes expiry exact and costs no database read. The dates are the
 * source of truth; a `type` already in the token is never trusted, because a
 * stale one is precisely the bug being fixed.
 *
 * The campaign grant is carried for the same reason and decays the same way.
 * Omitting it here would be the identical bug in the other direction: a
 * participant's session would fall back to `demo` on the first callback after
 * sign-in, losing the tenant their run history lives under.
 *
 * This fixes expiry in the token. Mid-session subscription upgrades are
 * rendered from server-page database authority instead of rewriting the
 * Auth.js cookie in the background.
 */
export function refreshTokenType<T extends RefreshableToken>(
  token: T,
  now: Date
): T & { type: "demo" | "subscriber" } {
  return {
    ...token,
    type: userTypeFor(
      {
        campaignExpiresAt: claimDate(token.campaignExpiresAt),
        campaignGrantedAt: claimDate(token.campaignGrantedAt),
        subscribedUntil: claimDate(token.subscribedUntil),
      },
      now
    ),
  };
}

type StoredUserClaims = {
  authVersion: number;
  /**
   * Optional so that every caller constructing a claims object does not have
   * to name a field it has no opinion on. Absent reads the same as an
   * unenrolled account, which is what a caller that does not know about the
   * campaign means.
   */
  campaignExpiresAt?: Date | null;
  campaignGrantedAt?: Date | null;
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
    campaignExpiresAt: user.campaignExpiresAt?.toISOString() ?? null,
    campaignGrantedAt: user.campaignGrantedAt?.toISOString() ?? null,
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

/**
 * Auth.js GET session reads must enforce revocation too. Unlike an explicit
 * update, a read must not import a newer plan into the cookie. Page/API
 * authority still comes from storage. An outage retains the exact old token.
 */
export async function validateSessionToken(
  token: JWT,
  findUser: (userId: string) => Promise<StoredUserClaims | null>,
  now: Date
): Promise<JWT | null> {
  const checked = await refreshClaimsForSessionUpdate(
    token,
    undefined,
    findUser,
    now
  );
  if (checked === null || checked === token) {
    return checked;
  }
  return refreshTokenType(token, now);
}
