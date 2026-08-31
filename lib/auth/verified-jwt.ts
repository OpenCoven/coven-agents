import "server-only";

import { getToken, type JWT } from "next-auth/jwt";
import { isCanonicalUuid } from "@/lib/session";
import { validAuthVersion } from "./session-revocation";

type AuthEnvironment = Readonly<{
  AUTH_SECRET?: string;
  AUTH_URL?: string;
  NEXTAUTH_SECRET?: string;
  NEXTAUTH_URL?: string;
}>;

export type VerifiedJwtIdentity = Readonly<{
  authVersion: number;
  userId: string;
}>;

type VerifiedJwtOptions = Readonly<{
  environment?: AuthEnvironment;
  readToken?: typeof getToken;
}>;

export function identityFromVerifiedJwt(
  token: JWT | null
): VerifiedJwtIdentity | null {
  const userId = token?.id;
  const authVersion = token?.authVersion;
  if (
    typeof userId !== "string" ||
    !isCanonicalUuid(userId) ||
    !validAuthVersion(authVersion)
  ) {
    return null;
  }

  return { authVersion, userId };
}

/**
 * Reads only Auth.js' encrypted session cookie. `getToken` performs the JWE
 * decryption and expiry validation without invoking callbacks or touching the
 * database; stripping every other request header also avoids introducing
 * bearer-token authority where the application previously used its cookie.
 */
export async function verifiedJwtIdentity(
  request: Request,
  options: VerifiedJwtOptions = {}
): Promise<VerifiedJwtIdentity | null> {
  const cookie = request.headers.get("cookie");
  if (!cookie) {
    return null;
  }

  const environment = options.environment ?? process.env;
  const secret = environment.AUTH_SECRET ?? environment.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error("Auth.js session verification is not configured.");
  }

  const configuredUrl = environment.AUTH_URL ?? environment.NEXTAUTH_URL;
  const authUrl = configuredUrl ? new URL(configuredUrl) : new URL(request.url);
  const headers = new Headers();
  headers.set("cookie", cookie);
  const token = await (options.readToken ?? getToken)({
    req: { headers },
    secret,
    secureCookie: authUrl.protocol === "https:",
  });

  return identityFromVerifiedJwt(token);
}
