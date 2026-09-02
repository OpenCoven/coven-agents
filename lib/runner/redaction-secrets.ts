const PREFIX = "coven-redaction:v1:";
const MAX_SECRETS = 8;
const MAX_ENCODED_BYTES = 16_384;
const MAX_SECRET_BYTES = 4096;

export function encodeRunnerAttemptRedactionSecrets(
  secrets: readonly string[]
): string {
  if (
    secrets.length < 1 ||
    secrets.length > MAX_SECRETS ||
    new Set(secrets).size !== secrets.length ||
    secrets.some(
      (secret) =>
        !secret ||
        /\p{Cc}/u.test(secret) ||
        Buffer.byteLength(secret, "utf8") > MAX_SECRET_BYTES
    )
  ) {
    throw new Error("Runner attempt redaction secrets are invalid.");
  }
  const encoded = `${PREFIX}${Buffer.from(
    JSON.stringify(secrets),
    "utf8"
  ).toString("base64url")}`;
  if (Buffer.byteLength(encoded, "utf8") > MAX_ENCODED_BYTES) {
    throw new Error("Runner attempt redaction secrets are too large.");
  }
  return encoded;
}

export function decodeRunnerAttemptRedactionSecrets(value: string): string[] {
  if (!value.startsWith(PREFIX)) {
    return value ? [value] : [];
  }
  try {
    const decoded = JSON.parse(
      Buffer.from(value.slice(PREFIX.length), "base64url").toString("utf8")
    ) as unknown;
    if (
      !Array.isArray(decoded) ||
      decoded.length < 1 ||
      decoded.length > MAX_SECRETS ||
      decoded.some(
        (secret) =>
          typeof secret !== "string" ||
          !secret ||
          /\p{Cc}/u.test(secret) ||
          Buffer.byteLength(secret, "utf8") > MAX_SECRET_BYTES
      ) ||
      new Set(decoded).size !== decoded.length
    ) {
      return [value];
    }
    return decoded;
  } catch {
    return [value];
  }
}
