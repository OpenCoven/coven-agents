import { createHash, randomBytes } from "node:crypto";

export const ownerCredentialScopes = [
  "run:start",
  "run:read",
  "run:events",
  "run:stop",
  "sandbox:inspect",
] as const;

export type OwnerCredentialScope = (typeof ownerCredentialScopes)[number];
export const ownerCredentialLifetimeMs = 60 * 60 * 1000;

const prefix = "coven_run_owner_v1_";
const bearerPattern = /^Bearer (coven_run_owner_v1_[A-Za-z0-9_-]{43})$/i;

function digest(secret: string) {
  return createHash("sha256").update(secret, "ascii").digest("hex");
}

export function issueOwnerSecret() {
  const secret = prefix + randomBytes(32).toString("base64url");
  return { digest: digest(secret), secret };
}

export function ownerBearerDigest(header: string | null) {
  if (!header || header.length !== 7 + prefix.length + 43) {
    return null;
  }
  const secret = bearerPattern.exec(header)?.[1];
  return secret?.startsWith(prefix) ? digest(secret) : null;
}
