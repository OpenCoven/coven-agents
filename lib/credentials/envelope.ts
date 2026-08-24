import { base64UrlDecode, base64UrlEncode } from "@opencoven/agent-contracts";

/**
 * Envelope encryption, not a single key over every credential.
 *
 * Each credential gets its own random AES-GCM data key (DEK), and the DEK is
 * wrapped by one shared AES-KW key-encryption key (KEK). Rotating the KEK is
 * then a rewrap of small wrapped keys instead of re-encrypting every stored
 * credential, and revoking one tenant's credential is deleting one row rather
 * than something that could leak into another tenant's data.
 *
 * AES-GCM is authenticated, so a tampered ciphertext fails to decrypt instead
 * of silently producing garbage plaintext.
 *
 * WebCrypto only (`crypto.subtle`) — no Node `crypto`, no `Buffer` — so this
 * stays portable to the Cloudflare Worker that later borrows the plaintext.
 */

const DEK_ALGORITHM = "AES-GCM";
const DEK_LENGTH_BITS = 256;
const KEK_ALGORITHM = "AES-KW";
const KEK_LENGTH_BITS = 256;
const IV_LENGTH_BYTES = 12;

export type SealedCredential = {
  ciphertext: string;
  iv: string;
  wrappedKey: string;
};

/** Generates a fresh, extractable key-encryption key for wrapping data keys. */
export function generateKek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { length: KEK_LENGTH_BITS, name: KEK_ALGORITHM },
    true,
    ["wrapKey", "unwrapKey"]
  );
}

/**
 * Imports a previously exported KEK from its base64url raw bytes.
 *
 * Non-extractable: once a KEK is loaded this way there is no code path that
 * can read its raw bytes back out, only use it to wrap and unwrap data keys.
 */
export function importKek(raw: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    base64UrlDecode(raw),
    { name: KEK_ALGORITHM },
    false,
    ["wrapKey", "unwrapKey"]
  );
}

/**
 * Encrypts a credential under a fresh, per-credential data key, then wraps
 * that data key with the KEK. The DEK itself is never returned or stored —
 * only its wrapped form and the ciphertext it produced.
 */
export async function encryptCredential(
  plaintext: string,
  kek: CryptoKey
): Promise<SealedCredential> {
  const dek = await crypto.subtle.generateKey(
    { length: DEK_LENGTH_BITS, name: DEK_ALGORITHM },
    true,
    ["encrypt", "decrypt"]
  );

  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));

  const ciphertext = await crypto.subtle.encrypt(
    { iv, name: DEK_ALGORITHM },
    dek,
    new TextEncoder().encode(plaintext)
  );

  const wrappedKey = await crypto.subtle.wrapKey(
    "raw",
    dek,
    kek,
    KEK_ALGORITHM
  );

  return {
    ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
    iv: base64UrlEncode(iv),
    wrappedKey: base64UrlEncode(new Uint8Array(wrappedKey)),
  };
}

/**
 * Unwraps the per-credential data key with the KEK and decrypts. Both steps
 * throw on failure — a wrong KEK fails to unwrap, and a tampered ciphertext
 * fails GCM authentication — rather than returning something falsy that a
 * caller could mistake for "no credential."
 */
export async function decryptCredential(
  sealed: SealedCredential,
  kek: CryptoKey
): Promise<string> {
  const dek = await crypto.subtle.unwrapKey(
    "raw",
    base64UrlDecode(sealed.wrappedKey),
    kek,
    KEK_ALGORITHM,
    { name: DEK_ALGORITHM },
    false,
    ["decrypt"]
  );

  const plaintext = await crypto.subtle.decrypt(
    { iv: base64UrlDecode(sealed.iv), name: DEK_ALGORITHM },
    dek,
    base64UrlDecode(sealed.ciphertext)
  );

  return new TextDecoder().decode(plaintext);
}
