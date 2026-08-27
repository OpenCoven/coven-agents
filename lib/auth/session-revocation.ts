import { MAX_AUTH_VERSION } from "@opencoven/agent-contracts";
import { isSubscribedAt } from "@/lib/subscription";

export type SessionAuthority = {
  authVersion: number;
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
 * still be on the current session version, and the database subscription must
 * still be active. Invalid values intentionally fail closed.
 */
export function sessionAuthorityMatches(input: {
  database: SessionAuthority;
  tokenAuthVersion: number;
  now: Date;
}): boolean {
  return (
    authVersionMatches(input.database.authVersion, input.tokenAuthVersion) &&
    isSubscribedAt(input.database, input.now)
  );
}
