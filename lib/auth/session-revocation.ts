import { isEntitledAt } from "@/lib/subscription";

const MAX_AUTH_VERSION = 2_147_483_647;

export type SessionAuthority = {
  authVersion: number;
  campaignExpiresAt?: Date | null;
  campaignGrantedAt?: Date | null;
  subscribedUntil: Date | null;
};

export function validAuthVersion(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_AUTH_VERSION
  );
}

export function authVersionMatches(
  databaseAuthVersion: unknown,
  tokenAuthVersion: unknown
): boolean {
  return (
    validAuthVersion(databaseAuthVersion) &&
    validAuthVersion(tokenAuthVersion) &&
    databaseAuthVersion === tokenAuthVersion
  );
}

/**
 * Subscriber authorization has two independent authorities: the token must
 * still be on the current session version, and the database entitlement must
 * still be live -- a paid subscription, or unexpired campaign minutes.
 * Invalid values intentionally fail closed.
 *
 * Entitlement rather than subscription, because this is the check the runner
 * makes before every dispatch. Asking "is this person paying?" here would
 * revoke a campaign participant's session the instant they tried to spend the
 * minutes they were granted.
 */
export function sessionAuthorityMatches(input: {
  database: SessionAuthority;
  tokenAuthVersion: number;
  now: Date;
}): boolean {
  return (
    authVersionMatches(input.database.authVersion, input.tokenAuthVersion) &&
    isEntitledAt(input.database, input.now)
  );
}
