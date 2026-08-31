import { base64UrlDecode, base64UrlEncode } from "@opencoven/agent-contracts";

const HMAC_ALGORITHM = "HMAC";
const HMAC_HASH = "SHA-256";

export async function createDeviceFlowBinding(
  secret: string,
  userId: string,
  deviceCode: string
): Promise<string> {
  const key = await importBindingKey(secret, ["sign"]);
  const signature = await crypto.subtle.sign(
    HMAC_ALGORITHM,
    key,
    bindingPayload(userId, deviceCode)
  );
  return base64UrlEncode(new Uint8Array(signature));
}

export async function verifyDeviceFlowBinding(
  secret: string,
  userId: string,
  deviceCode: string,
  binding: string
): Promise<boolean> {
  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = base64UrlDecode(binding);
  } catch {
    return false;
  }
  const key = await importBindingKey(secret, ["verify"]);
  return crypto.subtle.verify(
    HMAC_ALGORITHM,
    key,
    signature,
    bindingPayload(userId, deviceCode)
  );
}

function bindingPayload(
  userId: string,
  deviceCode: string
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify(["opencoven-device-flow-v1", userId, deviceCode])
  );
}

function importBindingKey(
  secret: string,
  usages: KeyUsage[]
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: HMAC_HASH, name: HMAC_ALGORITHM },
    false,
    usages
  );
}
