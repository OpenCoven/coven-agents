/**
 * The shared definition of a legal tenant id. The conservative alphabet keeps
 * tenant values safe in durable records and provider resource names without
 * lossy sanitization that could collapse two external identifiers.
 */
export const TENANT_ID_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

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

/** Decodes unpadded base64url material used by credential envelopes. */
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
