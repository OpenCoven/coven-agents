import { createHash } from "node:crypto";
import { importKek, KEK_VERSION_PATTERN } from "./envelope";

const MAX_KEY_MATERIAL_LENGTH = 2_000_000;
const SUPPORTED_VERSIONS = ["v1", "v2"] as const;
const CONFIGURATION_KEYS = new Set([
  "CREDENTIAL_KEK",
  "CREDENTIAL_KEK_CURRENT_VERSION",
  "CREDENTIAL_KEK_V1",
  "CREDENTIAL_KEK_V2",
]);

export type CredentialKekVersion = (typeof SUPPORTED_VERSIONS)[number];

export type CredentialKekEnvironment = Record<string, string | undefined>;

export type CredentialKekRing = {
  current: CryptoKey;
  currentVersion: CredentialKekVersion;
  keyFor: (version: string) => CryptoKey;
  versions: readonly CredentialKekVersion[];
};

let keyRingCache: {
  configKey: string;
  ring: Promise<CredentialKekRing>;
} | null = null;

function optionalEnvironment(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function requireVersion(value: string | undefined): CredentialKekVersion {
  if (!(value && KEK_VERSION_PATTERN.test(value))) {
    throw new Error(
      "CREDENTIAL_KEK_CURRENT_VERSION must be a valid configured version."
    );
  }
  if (!SUPPORTED_VERSIONS.includes(value as CredentialKekVersion)) {
    throw new Error("CREDENTIAL_KEK_CURRENT_VERSION is not supported.");
  }
  return value as CredentialKekVersion;
}

function requireKeyMaterial(
  value: string | undefined,
  name: string
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.length > MAX_KEY_MATERIAL_LENGTH) {
    throw new Error(`${name} is too large.`);
  }
  return value;
}

function configuredKeys(
  environment: CredentialKekEnvironment
): Record<CredentialKekVersion, string | undefined> {
  const legacy = requireKeyMaterial(
    optionalEnvironment(environment.CREDENTIAL_KEK),
    "CREDENTIAL_KEK"
  );
  const v1 = requireKeyMaterial(
    optionalEnvironment(environment.CREDENTIAL_KEK_V1),
    "CREDENTIAL_KEK_V1"
  );
  const v2 = requireKeyMaterial(
    optionalEnvironment(environment.CREDENTIAL_KEK_V2),
    "CREDENTIAL_KEK_V2"
  );

  if (legacy && v1 && legacy !== v1) {
    throw new Error(
      "CREDENTIAL_KEK and CREDENTIAL_KEK_V1 conflict; refusing ambiguous legacy configuration."
    );
  }

  return { v1: v1 ?? legacy, v2 };
}

async function parseRing(
  environment: CredentialKekEnvironment
): Promise<CredentialKekRing> {
  const currentVersion = requireVersion(
    optionalEnvironment(environment.CREDENTIAL_KEK_CURRENT_VERSION)
  );
  const configured = configuredKeys(environment);
  const imported = new Map<CredentialKekVersion, CryptoKey>();

  const configuredEntries = SUPPORTED_VERSIONS.map((version) => ({
    raw: configured[version],
    version,
  })).filter(
    (entry): entry is { raw: string; version: CredentialKekVersion } =>
      entry.raw !== undefined
  );
  const importedEntries = await Promise.all(
    configuredEntries.map(async ({ raw, version }) => ({
      key: await importKek(raw),
      version,
    }))
  );
  for (const entry of importedEntries) {
    imported.set(entry.version, entry.key);
  }

  if (!imported.has(currentVersion)) {
    throw new Error(
      `CREDENTIAL_KEK_${currentVersion.toUpperCase()} is required for the current version.`
    );
  }

  return {
    current: imported.get(currentVersion) as CryptoKey,
    currentVersion,
    keyFor(version: string): CryptoKey {
      if (!KEK_VERSION_PATTERN.test(version)) {
        throw new Error("Credential KEK version is invalid.");
      }
      if (!SUPPORTED_VERSIONS.includes(version as CredentialKekVersion)) {
        throw new Error("Credential KEK version is not configured.");
      }
      const key = imported.get(version as CredentialKekVersion);
      if (!key) {
        throw new Error("Credential KEK version is not configured.");
      }
      return key;
    },
    versions: SUPPORTED_VERSIONS.filter((version) => imported.has(version)),
  };
}

/**
 * Loads the explicitly configured credential KEK registry.
 *
 * The legacy unversioned secret is accepted only as an explicit v1 alias
 * during migration. Environment variables are read from a fixed allowlist so
 * an unrelated process variable can never become a decryption key by naming
 * convention.
 */
export function credentialKekRingFromEnvironment(
  environment: CredentialKekEnvironment = process.env
): Promise<CredentialKekRing> {
  let configKey: string;
  try {
    configKey = configurationFingerprint(environment);
  } catch (error) {
    return Promise.reject(error);
  }
  if (keyRingCache?.configKey === configKey) {
    return keyRingCache.ring;
  }

  const ring = parseRing(environment);
  keyRingCache = { configKey, ring };
  return ring;
}

function configurationFingerprint(
  environment: CredentialKekEnvironment
): string {
  const names = Object.keys(environment)
    .filter(
      (name) => name === "CREDENTIAL_KEK" || name.startsWith("CREDENTIAL_KEK_")
    )
    .sort();

  for (const name of names) {
    if (!CONFIGURATION_KEYS.has(name)) {
      throw new Error(`Unsupported credential KEK configuration: ${name}.`);
    }
  }

  const input = names
    .map((name) => `${name}\0${environment[name] ?? "\0"}`)
    .join("\0");
  return createHash("sha256").update(input, "utf8").digest("hex");
}
