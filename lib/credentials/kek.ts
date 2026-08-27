import "server-only";

import { credentialKekRingFromEnvironment } from "./key-ring";

export async function credentialKek(version?: string): Promise<CryptoKey> {
  const ring = await credentialKekRingFromEnvironment();
  return version === undefined ? ring.current : ring.keyFor(version);
}

export async function credentialKekVersion(): Promise<string> {
  return (await credentialKekRingFromEnvironment()).currentVersion;
}
