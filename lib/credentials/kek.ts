import "server-only";

import { importKek } from "./envelope";

// Key the cache by the configured value so deployment-time rotation reimports.
let kekCache: { imported: Promise<CryptoKey>; raw: string } | null = null;

export function credentialKek(): Promise<CryptoKey> {
  const raw = process.env.CREDENTIAL_KEK;
  if (!raw) {
    throw new Error(
      "CREDENTIAL_KEK is not set. Refusing to proceed without an explicit " +
        "key-encryption key — there is no default to fall back to."
    );
  }
  if (kekCache?.raw === raw) {
    return kekCache.imported;
  }
  const imported = importKek(raw);
  kekCache = { imported, raw };
  return imported;
}
