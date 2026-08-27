import type { RunnerClaims } from "./identity";
import {
  base64UrlDecode,
  KEY_ID_PATTERN,
  MAX_RUNNER_PAYLOAD_BYTES,
  runnerClaimsSchema,
  splitToken,
  TOKEN_ALGORITHM,
  TOKEN_CLOCK_SKEW_SECONDS,
  TOKEN_LIFETIME_SECONDS,
} from "./identity";

const MAX_VERIFY_KEY_MATERIAL_LENGTH = 4096;

export type RunnerVerificationKeyRing = {
  current: { id: string; publicKey: CryptoKey };
  previous?: {
    id: string;
    lastSignedAt: Date;
    publicKey: CryptoKey;
    retireAt: Date;
  };
};

export type RunnerVerificationKeyConfig = {
  currentId: string;
  currentPublicKey: string;
  previousId?: string;
  previousPublicKey?: string;
  previousLastSignedAt?: string;
  previousRetireAt?: string;
};

/**
 * Imports an SPKI public key for verification only. There is deliberately no
 * counterpart here that imports a signing key: the worker holds a public key
 * and nothing else, so compromising it cannot let an attacker mint a claim,
 * only check one someone else already signed.
 */
export async function importVerifyKey(spki: string): Promise<CryptoKey> {
  if (
    typeof spki !== "string" ||
    spki.length === 0 ||
    spki.length > MAX_VERIFY_KEY_MATERIAL_LENGTH
  ) {
    throw new Error("Runner verify key is missing or too large.");
  }
  return await crypto.subtle.importKey(
    "spki",
    base64UrlDecode(spki),
    { name: TOKEN_ALGORITHM },
    false,
    ["verify"]
  );
}

export async function importVerifyKeyRing(
  config: RunnerVerificationKeyConfig,
  _now = new Date()
): Promise<RunnerVerificationKeyRing> {
  const currentId =
    typeof config.currentId === "string" ? config.currentId.trim() : "";
  const previousId = optionalConfig(config.previousId);
  const previousPublicKeyText = optionalConfig(config.previousPublicKey);
  const previousLastSignedAt = optionalConfig(config.previousLastSignedAt);
  const previousRetireAt = optionalConfig(config.previousRetireAt);
  if (typeof config.currentId !== "string" || !KEY_ID_PATTERN.test(currentId)) {
    throw new Error("Runner current key id is invalid.");
  }
  const currentPublicKey = await importVerifyKey(config.currentPublicKey);

  const hasPrevious = [
    previousId,
    previousPublicKeyText,
    previousLastSignedAt,
    previousRetireAt,
  ].some((value) => value !== undefined);
  if (!hasPrevious) {
    return { current: { id: currentId, publicKey: currentPublicKey } };
  }
  if (
    !previousId ||
    !previousPublicKeyText ||
    !previousLastSignedAt ||
    !previousRetireAt ||
    !KEY_ID_PATTERN.test(previousId) ||
    previousId === currentId
  ) {
    throw new Error("Runner previous key configuration is invalid.");
  }
  const lastSignedAt = new Date(previousLastSignedAt);
  const retireAt = new Date(previousRetireAt);
  if (
    Number.isNaN(lastSignedAt.getTime()) ||
    Number.isNaN(retireAt.getTime())
  ) {
    throw new Error("Runner previous key timestamps are invalid.");
  }
  const minimumRetireAt =
    lastSignedAt.getTime() +
    (TOKEN_LIFETIME_SECONDS + TOKEN_CLOCK_SKEW_SECONDS) * 1000;
  if (
    !Number.isFinite(minimumRetireAt) ||
    retireAt.getTime() < minimumRetireAt
  ) {
    throw new Error(
      "Runner previous key retirement is earlier than the last-signed token lifetime."
    );
  }
  const previousPublicKey = await importVerifyKey(previousPublicKeyText);
  return {
    current: { id: currentId, publicKey: currentPublicKey },
    previous: {
      id: previousId,
      lastSignedAt,
      publicKey: previousPublicKey,
      retireAt,
    },
  };
}

function optionalConfig(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
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
  keyOrRing: CryptoKey | RunnerVerificationKeyRing,
  now = new Date()
): Promise<RunnerClaims | null> {
  const parts = splitToken(token);
  if (!parts) {
    return null;
  }

  let payloadBytes: Uint8Array;
  let kid: string;
  try {
    payloadBytes = base64UrlDecode(parts.payload);
    if (payloadBytes.byteLength > MAX_RUNNER_PAYLOAD_BYTES) {
      return null;
    }
    const payloadText = new TextDecoder("utf-8", { fatal: true }).decode(
      payloadBytes
    );
    // This is deliberately only a routing hint. Full JSON and schema parsing
    // happens below, after signature verification.
    const match = /"kid"\s*:\s*"([A-Za-z0-9][A-Za-z0-9._-]{0,63})"/.exec(
      payloadText
    );
    const [, matchedKid] = match ?? [];
    if (!matchedKid) {
      return null;
    }
    kid = matchedKid;
  } catch {
    return null;
  }

  const ring: RunnerVerificationKeyRing =
    keyOrRing instanceof CryptoKey
      ? { current: { id: kid, publicKey: keyOrRing } }
      : keyOrRing;
  const candidate =
    ring.current.id === kid
      ? ring.current
      : ring.previous?.id === kid
        ? ring.previous
        : null;
  if (!candidate) {
    return null;
  }
  const { previous } = ring;
  if (
    previous &&
    candidate.id === previous.id &&
    now.getTime() > previous.retireAt.getTime()
  ) {
    return null;
  }

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64UrlDecode(parts.signature);
  } catch {
    return null;
  }

  let verified: boolean;
  try {
    verified = await crypto.subtle.verify(
      { name: TOKEN_ALGORITHM },
      candidate.publicKey,
      // Re-wrapped rather than passed straight through. TypeScript 7 types a
      // `Uint8Array` by its backing buffer, and `base64UrlDecode` yields
      // `Uint8Array<ArrayBufferLike>` -- which `BufferSource` does not accept,
      // because `ArrayBufferLike` admits a `SharedArrayBuffer`. The copy pins it
      // to a plain `ArrayBuffer`.
      new Uint8Array(signatureBytes),
      new TextEncoder().encode(parts.payload)
    );
  } catch {
    return null;
  }
  if (!verified) {
    return null;
  }

  let claims: RunnerClaims;
  try {
    const payloadText = new TextDecoder().decode(payloadBytes);
    claims = runnerClaimsSchema.parse(JSON.parse(payloadText));
  } catch {
    return null;
  }

  if (
    claims.kid !== kid ||
    claims.exp + TOKEN_CLOCK_SKEW_SECONDS < Math.floor(now.getTime() / 1000)
  ) {
    return null;
  }

  return claims;
}
