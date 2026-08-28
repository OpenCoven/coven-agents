import { base64UrlDecode, base64UrlEncode } from "@opencoven/agent-contracts";

/**
 * Envelope encryption, not a single key over every credential.
 *
 * Each credential gets its own random AES-GCM data key (DEK), and the DEK is
 * wrapped by one versioned AES-KW key-encryption key (KEK). Rotating the KEK
 * is then a rewrap of small values instead of re-encrypting every stored
 * credential.
 *
 * WebCrypto only (`crypto.subtle`) — no Node `crypto`, no `Buffer` — so this
 * stays portable to the Cloudflare Worker that later borrows the plaintext.
 */

const DEK_ALGORITHM = "AES-GCM";
const DEK_LENGTH_BITS = 256;
const KEK_ALGORITHM = "AES-KW";
const KEK_LENGTH_BITS = 256;
const IV_LENGTH_BYTES = 12;
const WRAPPED_DEK_LENGTH_BYTES = 40;
const GCM_TAG_LENGTH_BYTES = 16;
const MAX_FIELD_LENGTH = 2_000_000;
const MAX_PLAINTEXT_BYTES = 1_000_000;
export const KEK_VERSION_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const BASE64_KEY_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;
export const LEGACY_AAD_VERSION = 0;
export const BOUND_AAD_VERSION = 1;

export type CredentialEnvelopeV2 = {
  aadVersion: number;
  ciphertext: string;
  iv: string;
  kekVersion: string;
  wrappedKey: string;
};

export type SealedCredential = CredentialEnvelopeV2;

export type EnvelopeAadContext =
  | {
      harnessId: string;
      kind: "credential";
      tenant: string;
    }
  | {
      keyHash?: string;
      kind: "idempotency";
      operation: string;
      ownerId: string;
    }
  | {
      attemptId: string;
      kind: "runner_attempt_redaction";
      runId: string;
      tenant: string;
    };

export function validateKekVersion(
  value: unknown,
  name = "kekVersion"
): string {
  if (typeof value !== "string" || !KEK_VERSION_PATTERN.test(value)) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function decodeEnvelopeField(
  value: unknown,
  name: string
): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_FIELD_LENGTH ||
    !BASE64_URL_PATTERN.test(value) ||
    value.length % 4 === 1
  ) {
    throw new Error(`${name} is invalid.`);
  }

  try {
    return base64UrlDecode(value);
  } catch (error) {
    throw new Error(`${name} is invalid.`, { cause: error });
  }
}

function validateAadVersion(value: unknown): number {
  if (value !== LEGACY_AAD_VERSION && value !== BOUND_AAD_VERSION) {
    throw new Error("aadVersion is invalid.");
  }
  return value;
}

function encodeLengthPrefixedAad(
  context: EnvelopeAadContext
): Uint8Array<ArrayBuffer> {
  const fields =
    context.kind === "credential"
      ? ["credential", context.tenant, context.harnessId]
      : context.kind === "idempotency"
        ? [
            "idempotency",
            context.ownerId,
            context.operation,
            context.keyHash ?? "",
          ]
        : [
            "runner_attempt_redaction",
            context.tenant,
            context.runId,
            context.attemptId,
          ];
  const encoder = new TextEncoder();
  const encodedFields = fields.map((field) => encoder.encode(field));
  const prefix = encoder.encode("opencoven-envelope-aad-v1");
  const totalLength =
    prefix.length +
    encodedFields.reduce((total, field) => total + 4 + field.length, 0);
  const result = new Uint8Array(totalLength) as Uint8Array<ArrayBuffer>;
  let offset = 0;
  result.set(prefix, offset);
  offset += prefix.length;
  const view = new DataView(result.buffer);
  for (const field of encodedFields) {
    view.setUint32(offset, field.length);
    offset += 4;
    result.set(field, offset);
    offset += field.length;
  }
  return result;
}

function additionalData(
  aadVersion: number,
  context: EnvelopeAadContext | undefined
): Uint8Array<ArrayBuffer> | undefined {
  validateAadVersion(aadVersion);
  if (aadVersion === LEGACY_AAD_VERSION) {
    return undefined;
  }
  if (!context) {
    throw new Error("AAD context is required for this envelope.");
  }
  return encodeLengthPrefixedAad(context);
}

export function decodeKekMaterial(value: unknown): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_FIELD_LENGTH ||
    !BASE64_KEY_PATTERN.test(value)
  ) {
    throw new Error("CREDENTIAL_KEK is invalid.");
  }

  const unpadded = value.replace(/[=]+$/u, "");
  if (unpadded.length % 4 === 1) {
    throw new Error("CREDENTIAL_KEK is invalid.");
  }

  try {
    return base64UrlDecode(value);
  } catch (error) {
    throw new Error("CREDENTIAL_KEK is invalid.", { cause: error });
  }
}

function validateEnvelope(sealed: CredentialEnvelopeV2): {
  aadVersion: number;
  ciphertext: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
  wrappedKey: Uint8Array<ArrayBuffer>;
} {
  const aadVersion = validateAadVersion(sealed?.aadVersion);
  validateKekVersion(sealed?.kekVersion);
  const ciphertext = decodeEnvelopeField(sealed?.ciphertext, "ciphertext");
  const iv = decodeEnvelopeField(sealed?.iv, "iv");
  const wrappedKey = decodeEnvelopeField(sealed?.wrappedKey, "wrappedKey");

  if (ciphertext.length < GCM_TAG_LENGTH_BYTES) {
    throw new Error("ciphertext is invalid.");
  }
  if (iv.length !== IV_LENGTH_BYTES) {
    throw new Error("iv is invalid.");
  }
  if (wrappedKey.length !== WRAPPED_DEK_LENGTH_BYTES) {
    throw new Error("wrappedKey is invalid.");
  }

  return { aadVersion, ciphertext, iv, wrappedKey };
}

/** Generates a fresh key for tests and operator-side key generation. */
export function generateKek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { length: KEK_LENGTH_BITS, name: KEK_ALGORITHM },
    true,
    ["wrapKey", "unwrapKey"]
  );
}

/**
 * Imports a previously exported KEK from base64url or standard-base64 raw bytes.
 *
 * Non-extractable: once a KEK is loaded this way there is no code path that
 * can read its raw bytes back out, only use it to wrap and unwrap data keys.
 */
export function importKek(raw: string): Promise<CryptoKey> {
  const bytes = decodeKekMaterial(raw);
  if (bytes.length !== KEK_LENGTH_BITS / 8) {
    throw new Error("CREDENTIAL_KEK has an invalid length.");
  }

  return crypto.subtle.importKey("raw", bytes, { name: KEK_ALGORITHM }, false, [
    "wrapKey",
    "unwrapKey",
  ]);
}

/**
 * Encrypts a credential under a fresh, per-credential data key, then wraps
 * that data key with the named KEK version. The DEK itself is never returned
 * or stored — only its wrapped form and the ciphertext it produced.
 */
export async function encryptCredential(
  plaintext: string,
  kek: CryptoKey,
  kekVersion: string,
  context?: EnvelopeAadContext
): Promise<CredentialEnvelopeV2> {
  validateKekVersion(kekVersion);
  if (typeof plaintext !== "string") {
    throw new Error("credential plaintext is invalid.");
  }
  const plaintextBytes = new TextEncoder().encode(plaintext);
  if (
    plaintextBytes.length === 0 ||
    plaintextBytes.length > MAX_PLAINTEXT_BYTES
  ) {
    throw new Error("credential plaintext is invalid.");
  }

  const dek = await crypto.subtle.generateKey(
    { length: DEK_LENGTH_BITS, name: DEK_ALGORITHM },
    true,
    ["encrypt", "decrypt"]
  );

  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
  const aadVersion = context ? BOUND_AAD_VERSION : LEGACY_AAD_VERSION;
  const ciphertext = await crypto.subtle.encrypt(
    {
      additionalData: additionalData(aadVersion, context),
      iv,
      name: DEK_ALGORITHM,
    },
    dek,
    plaintextBytes
  );
  const wrappedKey = await crypto.subtle.wrapKey(
    "raw",
    dek,
    kek,
    KEK_ALGORITHM
  );

  return {
    aadVersion,
    ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
    iv: base64UrlEncode(iv),
    kekVersion,
    wrappedKey: base64UrlEncode(new Uint8Array(wrappedKey)),
  };
}

/**
 * Unwraps only a per-credential data key. This is intentionally separate from
 * decryption so a KEK rotation can rewrap the same DEK without touching
 * credential plaintext or ciphertext.
 */
export function unwrapDataKey(
  wrappedKey: string,
  kek: CryptoKey
): Promise<CryptoKey> {
  return unwrapDataKeyInternal(wrappedKey, kek, false);
}

function unwrapDataKeyInternal(
  wrappedKey: string,
  kek: CryptoKey,
  extractable: boolean
): Promise<CryptoKey> {
  const encoded = decodeEnvelopeField(wrappedKey, "wrappedKey");
  if (encoded.length !== WRAPPED_DEK_LENGTH_BYTES) {
    throw new Error("wrappedKey is invalid.");
  }

  return crypto.subtle.unwrapKey(
    "raw",
    encoded,
    kek,
    KEK_ALGORITHM,
    { name: DEK_ALGORITHM },
    extractable,
    ["decrypt"]
  );
}

/** Wraps an already-unwrapped DEK without exporting it. */
export async function wrapDataKey(
  dek: CryptoKey,
  kek: CryptoKey
): Promise<string> {
  const wrapped = await crypto.subtle.wrapKey("raw", dek, kek, KEK_ALGORITHM);
  return base64UrlEncode(new Uint8Array(wrapped));
}

/** Rewraps a DEK under a target KEK without decrypting credential plaintext. */
export async function rewrapWrappedKey(
  wrappedKey: string,
  sourceKek: CryptoKey,
  targetKek: CryptoKey
): Promise<string> {
  const dek = await unwrapDataKeyInternal(wrappedKey, sourceKek, true);
  return wrapDataKey(dek, targetKek);
}

/**
 * Unwraps the per-credential data key with the supplied named key and
 * decrypts. Both steps throw on failure rather than returning a falsy value.
 */
export async function decryptCredential(
  sealed: CredentialEnvelopeV2,
  kek: CryptoKey,
  context?: EnvelopeAadContext
): Promise<string> {
  const { aadVersion, ciphertext, iv } = validateEnvelope(sealed);
  const dek = await unwrapDataKey(sealed.wrappedKey, kek);
  const plaintext = await crypto.subtle.decrypt(
    {
      additionalData: additionalData(aadVersion, context),
      iv,
      name: DEK_ALGORITHM,
    },
    dek,
    ciphertext
  );

  return new TextDecoder().decode(plaintext);
}
