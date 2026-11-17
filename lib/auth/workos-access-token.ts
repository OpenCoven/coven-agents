import {
  createRemoteJWKSet,
  errors,
  type JWTVerifyGetKey,
  jwtVerify,
} from "jose";
import { z } from "zod";

/**
 * Verification of WorkOS AuthKit session access tokens presented as a bearer
 * credential by a non-browser client.
 *
 * A verified token identifies a WorkOS user and nothing more. It carries no
 * tenant, entitlement, or account version: those stay application-owned and
 * are resolved from the local account after verification. Sources:
 * https://workos.com/docs/reference/authkit/session-tokens/jwks and
 * https://workos.com/docs/reference/authkit/user
 */
export const WORKOS_ISSUER = "https://api.workos.com";
const WORKOS_API_ORIGIN = "https://api.workos.com";
const CLIENT_ID = /^client_[A-Za-z0-9]{1,120}$/u;
const USER_ID = /^user_[A-Za-z0-9]{1,120}$/u;
const SESSION_ID = /^session_[A-Za-z0-9]{1,120}$/u;
const MAX_TOKEN_LENGTH = 8192;
/** Session access tokens last minutes; anything longer-lived is refused. */
const MAX_TOKEN_LIFETIME_SECONDS = 60 * 60;
const CLOCK_TOLERANCE_SECONDS = 5;
const USER_LOOKUP_TIMEOUT_MS = 10_000;

export type WorkOSTokenConfiguration = Readonly<{
  apiKey: string;
  clientId: string;
}>;

/**
 * Returns null unless both server-only values are present and well formed.
 * A missing or malformed configuration makes the bearer path unavailable; it
 * never falls back to another credential.
 */
export function readWorkOSTokenConfiguration(
  environment: Readonly<Record<string, string | undefined>>
): WorkOSTokenConfiguration | null {
  const apiKey = environment.WORKOS_API_KEY?.trim();
  const clientId = environment.WORKOS_CLIENT_ID?.trim();
  if (!(apiKey && clientId && CLIENT_ID.test(clientId))) {
    return null;
  }
  return { apiKey, clientId };
}

export function workosJwksUrl(clientId: string): URL {
  if (!CLIENT_ID.test(clientId)) {
    throw new Error("WorkOS client ID is malformed.");
  }
  return new URL(`${WORKOS_API_ORIGIN}/sso/jwks/${clientId}`);
}

/** Reads exactly one compact JWT from `Authorization: Bearer`; never a cookie. */
export function bearerAccessToken(request: Request): string | null {
  const match =
    /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u.exec(
      request.headers.get("authorization") ?? ""
    );
  const token = match?.[1] ?? null;
  return token && token.length <= MAX_TOKEN_LENGTH ? token : null;
}

export type WorkOSAccessTokenResult =
  | Readonly<{ kind: "verified"; sessionId: string; userId: string }>
  | Readonly<{ kind: "rejected" | "unavailable" }>;

export type WorkOSAccessTokenVerifier = (
  token: string
) => Promise<WorkOSAccessTokenResult>;

const claimsSchema = z.object({
  client_id: z.string(),
  exp: z.number().int(),
  iat: z.number().int(),
  sid: z.string().regex(SESSION_ID),
  sub: z.string().regex(USER_ID),
});

function isTokenFault(error: unknown): boolean {
  return (
    error instanceof errors.JWTExpired ||
    error instanceof errors.JWTClaimValidationFailed ||
    error instanceof errors.JWTInvalid ||
    error instanceof errors.JWSInvalid ||
    error instanceof errors.JWSSignatureVerificationFailed ||
    error instanceof errors.JWKSNoMatchingKey ||
    error instanceof errors.JWKSMultipleMatchingKeys ||
    error instanceof errors.JOSEAlgNotAllowed ||
    error instanceof errors.JOSENotSupported
  );
}

/**
 * Signature, issuer, expiry, and client are all required. The algorithm is
 * pinned so a token cannot select `none` or a symmetric scheme. A failure to
 * obtain the key set is `unavailable`, never a pass.
 */
export function createWorkOSAccessTokenVerifier(
  configuration: WorkOSTokenConfiguration,
  options: Readonly<{ keys?: JWTVerifyGetKey; now?: () => Date }> = {}
): WorkOSAccessTokenVerifier {
  const keys =
    options.keys ??
    createRemoteJWKSet(workosJwksUrl(configuration.clientId), {
      cooldownDuration: 30_000,
      timeoutDuration: 5000,
    });
  return async (token) => {
    if (!token || token.length > MAX_TOKEN_LENGTH) {
      return { kind: "rejected" };
    }
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        algorithms: ["RS256"],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        currentDate: options.now?.(),
        issuer: [WORKOS_ISSUER, `${WORKOS_ISSUER}/`],
        requiredClaims: ["client_id", "exp", "iat", "sid", "sub"],
      }));
    } catch (error) {
      return { kind: isTokenFault(error) ? "rejected" : "unavailable" };
    }
    const claims = claimsSchema.safeParse(payload);
    const nowSeconds = Math.floor(
      (options.now?.() ?? new Date()).getTime() / 1000
    );
    if (
      !claims.success ||
      claims.data.client_id !== configuration.clientId ||
      // The lifetime cap only means something when the issue time is not in
      // the future; otherwise a token could claim any later window.
      claims.data.iat > nowSeconds + CLOCK_TOLERANCE_SECONDS ||
      claims.data.exp - claims.data.iat > MAX_TOKEN_LIFETIME_SECONDS ||
      // `act` marks an impersonated session; it may not act as the owner.
      payload.act !== undefined
    ) {
      return { kind: "rejected" };
    }
    return {
      kind: "verified",
      sessionId: claims.data.sid,
      userId: claims.data.sub,
    };
  };
}

const userSchema = z.object({
  email: z.string().trim().toLowerCase().max(64).pipe(z.email()),
  email_verified: z.literal(true),
  id: z.string().regex(USER_ID),
});

export type WorkOSUserResult =
  | Readonly<{ email: string; kind: "verified" }>
  | Readonly<{ kind: "rejected" | "unavailable" }>;

/**
 * Resolves the verified email of one WorkOS user with the server API key.
 * The access token has no email claim, and the local account is keyed on a
 * verified email. Errors are reduced to a fixed outcome because an upstream
 * failure can echo the request, including the key.
 */
export async function fetchVerifiedWorkOSUser(
  userId: string,
  configuration: WorkOSTokenConfiguration,
  request: typeof fetch = fetch
): Promise<WorkOSUserResult> {
  if (!USER_ID.test(userId)) {
    return { kind: "rejected" };
  }
  let response: Response;
  try {
    response = await request(
      `${WORKOS_API_ORIGIN}/user_management/users/${userId}`,
      {
        cache: "no-store",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${configuration.apiKey}`,
        },
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(USER_LOOKUP_TIMEOUT_MS),
      }
    );
  } catch {
    return { kind: "unavailable" };
  }
  if (response.status === 404) {
    return { kind: "rejected" };
  }
  if (!response.ok) {
    return { kind: "unavailable" };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "unavailable" };
  }
  const user = userSchema.safeParse(body);
  if (!user.success || user.data.id !== userId) {
    return { kind: "rejected" };
  }
  return { email: user.data.email, kind: "verified" };
}
