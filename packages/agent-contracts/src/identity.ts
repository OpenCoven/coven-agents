import { z } from "zod";

/**
 * Deliberately not a JWT: a JWT header declares its own algorithm, and that
 * self-declaration is the root cause of `alg: none` and HS256-for-RS256
 * substitution attacks — a verifier that trusts the token to name its own
 * algorithm can be tricked into checking the signature the wrong way. This
 * format has exactly one algorithm, hardcoded on both sides, and no header
 * segment for a caller to lie in. That class of attack has no field to land
 * in.
 */
export const TOKEN_ALGORITHM = "Ed25519";

/**
 * 15 minutes. There is no revocation list, so expiry is the only way a
 * compromised or stale token stops working; the lifetime has to be short
 * enough that "wait it out" is an acceptable incident response.
 */
export const TOKEN_LIFETIME_SECONDS = 900;
/**
 * No implicit clock skew: a token is expired when
 * `exp + TOKEN_CLOCK_SKEW_SECONDS <= floor(now seconds)`.
 */
export const TOKEN_CLOCK_SKEW_SECONDS = 0;
export const MAX_RUNNER_TOKEN_BYTES = 8192;
export const MAX_RUNNER_TOKEN_SEGMENT_BYTES = 6144;
export const MAX_RUNNER_PAYLOAD_BYTES = 4096;
export const MAX_AUTH_VERSION = 2_147_483_647;
export const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The one definition of a legal tenant id, shared by the issuer and the
 * verifier.
 *
 * It lives here because both sides already depend on this package, and because
 * the alternative failed in production: the worker enforced this charset when
 * deriving a sandbox key while the app minted `user:${uuid}`, and the contract
 * between them checked only length. Every cloud run was issued a token the
 * worker would accept and then refuse to build a sandbox from, so the run died
 * after auth with zero commands and zero file operations.
 *
 * The charset is narrow because `-` separates the parts of a sandbox key: if a
 * tenant id could contain one, tenant `a` with agent `b-c` and tenant `a-b`
 * with agent `c` would derive the same key, and the two would share a
 * container.
 */
export const TENANT_ID_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

export const runnerRunScopeSchema = z
  .object({
    agentId: z.string().uuid(),
    harnessId: z.string().trim().min(1).max(64),
    operationId: z.string().uuid(),
  })
  .strict();

export const runnerClaimsSchema = z
  .object({
    authVersion: z.number().int().nonnegative().max(MAX_AUTH_VERSION),
    exp: z.number().int().positive(),
    kid: z.string().regex(KEY_ID_PATTERN),
    plan: z.enum(["demo", "subscriber"]),
    run: runnerRunScopeSchema.optional(),
    sub: z.string().min(1).max(128),
    tenant: z.string().regex(TENANT_ID_PATTERN),
  })
  .strict();

export type RunnerClaims = z.infer<typeof runnerClaimsSchema>;
export type RunnerRunScope = z.infer<typeof runnerRunScopeSchema>;

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/[=]+$/, "");
}

/**
 * Throws on input that is not valid base64url, unlike `splitToken`, which
 * returns null. A caller decoding the signature or payload segment of an
 * attacker-supplied token must handle that throw itself.
 */
export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = padded.length % 4;
  const withPadding =
    remainder === 0 ? padded : padded + "=".repeat(4 - remainder);
  const binary = atob(withPadding);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Returns null instead of throwing so a caller handling an attacker-supplied
 * token cannot forget a try/catch and end up crashing the request path.
 */
export function splitToken(
  token: string
): { payload: string; signature: string } | null {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > MAX_RUNNER_TOKEN_BYTES
  ) {
    return null;
  }
  const segments = token.split(".");
  if (segments.length !== 2) {
    return null;
  }
  const [payload, signature] = segments;
  if (
    payload.length === 0 ||
    signature.length === 0 ||
    payload.length > MAX_RUNNER_TOKEN_SEGMENT_BYTES ||
    signature.length > MAX_RUNNER_TOKEN_SEGMENT_BYTES ||
    !/^[A-Za-z0-9_-]+$/.test(payload) ||
    !/^[A-Za-z0-9_-]+$/.test(signature)
  ) {
    return null;
  }
  return { payload, signature };
}
