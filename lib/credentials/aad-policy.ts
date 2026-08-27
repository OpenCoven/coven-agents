import type { EnvelopeAadContext } from "./envelope";

export function credentialAadContextForWrite(
  tenant: string,
  harnessId: string
): EnvelopeAadContext | undefined {
  const enabled = process.env.CREDENTIAL_AAD_WRITES_ENABLED;
  if (enabled === undefined || enabled === "" || enabled === "false") {
    return undefined;
  }
  if (enabled !== "true") {
    throw new Error('CREDENTIAL_AAD_WRITES_ENABLED must be "true" or "false".');
  }
  return { harnessId, kind: "credential", tenant };
}
