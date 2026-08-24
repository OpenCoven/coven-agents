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

export const runnerClaimsSchema = z
  .object({
    exp: z.number().int().positive(),
    plan: z.enum(["demo", "subscriber"]),
    sub: z.string().min(1).max(128),
    tenant: z.string().min(1).max(64),
  })
  .strict();

export type RunnerClaims = z.infer<typeof runnerClaimsSchema>;

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
export function base64UrlDecode(value: string): Uint8Array {
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
  const segments = token.split(".");
  if (segments.length !== 2) {
    return null;
  }
  const [payload, signature] = segments;
  if (payload.length === 0 || signature.length === 0) {
    return null;
  }
  return { payload, signature };
}
