import {
  base64UrlDecode,
  type RunnerClaims,
  runnerClaimsSchema,
  splitToken,
  TOKEN_ALGORITHM,
} from "@opencoven/agent-contracts";

/**
 * Imports an SPKI public key for verification only. There is deliberately no
 * counterpart here that imports a signing key: the worker holds a public key
 * and nothing else, so compromising it cannot let an attacker mint a claim,
 * only check one someone else already signed.
 */
export async function importVerifyKey(spki: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "spki",
    new Uint8Array(base64UrlDecode(spki)),
    { name: TOKEN_ALGORITHM },
    false,
    ["verify"]
  );
}

/**
 * Verifies a runner token against a public key and returns its claims, or
 * `null` for any failure. Never throws: a caller handling an attacker-supplied
 * token must not be able to mistake "verification errored" for "verification
 * passed" by forgetting a try/catch.
 *
 * The order below is a security requirement, not a style preference. The
 * signature is checked over the raw payload bytes before that payload is
 * decoded, parsed, or trusted in any way — an attacker-controlled string never
 * reaches JSON.parse or the schema until it has been proven to be what the
 * key holder actually signed. Expiry is checked last, once the claims are
 * already known to be authentic.
 */
export async function verifyRunnerToken(
  token: string,
  publicKey: CryptoKey
): Promise<RunnerClaims | null> {
  const parts = splitToken(token);
  if (!parts) {
    return null;
  }

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64UrlDecode(parts.signature);
  } catch {
    return null;
  }

  const verified = await crypto.subtle.verify(
    { name: TOKEN_ALGORITHM },
    publicKey,
    new Uint8Array(signatureBytes),
    new TextEncoder().encode(parts.payload)
  );
  if (!verified) {
    return null;
  }

  let claims: RunnerClaims;
  try {
    const payloadBytes = base64UrlDecode(parts.payload);
    const payloadText = new TextDecoder().decode(payloadBytes);
    claims = runnerClaimsSchema.parse(JSON.parse(payloadText));
  } catch {
    return null;
  }

  if (claims.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }

  return claims;
}
