import {
  importVerifyKey,
  importVerifyKeyRing,
  type RunnerVerificationKeyRing,
  TOKEN_CLOCK_SKEW_SECONDS,
  TOKEN_LIFETIME_SECONDS,
} from "@opencoven/agent-contracts";

export type RunnerKeyRing = {
  current: {
    id: string;
    privateKey: CryptoKey;
    publicKey: CryptoKey;
  };
  previous?: {
    id: string;
    publicKey: CryptoKey;
    lastSignedAt: Date;
    retireAt: Date;
  };
};

export type RunnerKeyRingConfig = {
  currentId: string;
  currentPrivateKey: string;
  currentPublicKey: string;
  previousId?: string;
  previousPublicKey?: string;
  previousLastSignedAt?: string;
  previousRetireAt?: string;
};

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_KEY_MATERIAL_LENGTH = 4096;
let signingKeyRingCache: {
  configKey: string;
  ring: RunnerKeyRing;
} | null = null;
let verificationKeyRingCache: {
  configKey: string;
  ring: RunnerVerificationKeyRing;
} | null = null;

function requireKeyMaterial(value: string, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_KEY_MATERIAL_LENGTH
  ) {
    throw new Error(`${name} is missing or too large.`);
  }
  return value;
}

function requireKeyId(value: string, name: string): string {
  if (typeof value !== "string" || !KEY_ID_PATTERN.test(value)) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function parseTimestamp(value: string, name: string): Date {
  const retireAt = new Date(value);
  if (Number.isNaN(retireAt.getTime())) {
    throw new Error(`${name} must be a valid timestamp.`);
  }
  return retireAt;
}

function validateRetirementWindow(lastSignedAt: Date, retireAt: Date): void {
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
}

function optionalEnvironment(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

export async function parseRunnerKeyRing(
  config: RunnerKeyRingConfig,
  _now = new Date()
): Promise<RunnerKeyRing> {
  const currentId = requireKeyId(config.currentId, "Runner current key id");
  const currentPrivateKey = requireKeyMaterial(
    config.currentPrivateKey,
    "Runner current signing key"
  );
  const currentPublicKey = requireKeyMaterial(
    config.currentPublicKey,
    "Runner current public key"
  );
  const previousId = optionalEnvironment(config.previousId);
  const previousPublicKeyText = optionalEnvironment(config.previousPublicKey);
  const previousLastSignedAt = optionalEnvironment(config.previousLastSignedAt);
  const previousRetireAt = optionalEnvironment(config.previousRetireAt);

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    decodeKey(currentPrivateKey),
    { name: "Ed25519" },
    false,
    ["sign"]
  );
  const publicKey = await importVerifyKey(currentPublicKey);

  const probe = new TextEncoder().encode(`coven-key-ring:${currentId}`);
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    probe
  );
  const matches = await crypto.subtle.verify(
    { name: "Ed25519" },
    publicKey,
    signature,
    probe
  );
  if (!matches) {
    throw new Error("Runner signing and public keys do not match.");
  }

  const hasPrevious = [
    previousId,
    previousPublicKeyText,
    previousLastSignedAt,
    previousRetireAt,
  ].some((value) => value !== undefined);
  if (!hasPrevious) {
    return { current: { id: currentId, privateKey, publicKey } };
  }

  if (
    !previousId ||
    !previousPublicKeyText ||
    !previousLastSignedAt ||
    !previousRetireAt
  ) {
    throw new Error("Runner previous key configuration is incomplete.");
  }
  if (previousId === currentId) {
    throw new Error("Runner current and previous key ids must differ.");
  }
  const previousPublicKey = await importVerifyKey(
    requireKeyMaterial(previousPublicKeyText, "Runner previous public key")
  );
  const lastSignedAt = parseTimestamp(
    previousLastSignedAt,
    "Runner previous last-signed-at"
  );
  const retireAt = parseTimestamp(
    previousRetireAt,
    "Runner previous retirement"
  );
  const checkedPreviousId = requireKeyId(previousId, "Runner previous key id");
  validateRetirementWindow(lastSignedAt, retireAt);

  return {
    current: { id: currentId, privateKey, publicKey },
    previous: {
      id: checkedPreviousId,
      lastSignedAt,
      publicKey: previousPublicKey,
      retireAt,
    },
  };
}

export async function runnerKeyRingFromEnvironment(
  environment: Record<string, string | undefined> = process.env
): Promise<RunnerKeyRing> {
  const signingKeyId = optionalEnvironment(environment.RUNNER_SIGNING_KEY_ID);
  const signingPublicKey = optionalEnvironment(
    environment.RUNNER_SIGNING_PUBLIC_KEY
  );
  const legacyVerifyKey = optionalEnvironment(environment.RUNNER_VERIFY_KEY);
  const legacyConfiguration =
    signingKeyId === undefined &&
    signingPublicKey === undefined &&
    legacyVerifyKey !== undefined;
  const currentId = legacyConfiguration ? "legacy" : signingKeyId;
  const currentPrivateKey = environment.RUNNER_SIGNING_KEY;
  const currentPublicKey = legacyConfiguration
    ? legacyVerifyKey
    : signingPublicKey;
  if (!(currentId && currentPrivateKey && currentPublicKey)) {
    throw new Error(
      legacyConfiguration
        ? "RUNNER_SIGNING_KEY is required."
        : "RUNNER_SIGNING_KEY_ID, RUNNER_SIGNING_KEY, and RUNNER_SIGNING_PUBLIC_KEY are required."
    );
  }

  const config = {
    currentId,
    currentPrivateKey,
    currentPublicKey,
    previousId: optionalEnvironment(environment.RUNNER_VERIFY_PREVIOUS_KEY_ID),
    previousLastSignedAt: optionalEnvironment(
      environment.RUNNER_VERIFY_PREVIOUS_LAST_SIGNED_AT
    ),
    previousPublicKey: optionalEnvironment(
      environment.RUNNER_VERIFY_PREVIOUS_KEY
    ),
    previousRetireAt: optionalEnvironment(
      environment.RUNNER_VERIFY_PREVIOUS_RETIRE_AT
    ),
  };
  const configKey = JSON.stringify(config);
  if (signingKeyRingCache?.configKey === configKey) {
    return signingKeyRingCache.ring;
  }

  const ring = await parseRunnerKeyRing(config);
  signingKeyRingCache = { configKey, ring };
  return ring;
}

export async function runnerVerificationKeyRingFromEnvironment(
  environment: Record<string, string | undefined> = process.env
): Promise<RunnerVerificationKeyRing> {
  const signingKeyId = optionalEnvironment(environment.RUNNER_SIGNING_KEY_ID);
  const signingPublicKey = optionalEnvironment(
    environment.RUNNER_SIGNING_PUBLIC_KEY
  );
  const legacyVerifyKeyId = optionalEnvironment(
    environment.RUNNER_VERIFY_KEY_ID
  );
  const legacyVerifyKey = optionalEnvironment(environment.RUNNER_VERIFY_KEY);
  const hasVersionedAppKey =
    signingKeyId !== undefined || signingPublicKey !== undefined;
  let currentId: string | undefined;
  let currentPublicKey: string | undefined;
  if (hasVersionedAppKey) {
    if (legacyVerifyKeyId !== undefined || legacyVerifyKey !== undefined) {
      throw new Error(
        "Runner app and legacy verification key configuration cannot be mixed."
      );
    }
    currentId = signingKeyId;
    currentPublicKey = signingPublicKey;
  } else if (legacyVerifyKeyId === undefined) {
    currentId = "legacy";
    currentPublicKey = legacyVerifyKey;
  } else {
    currentId = legacyVerifyKeyId;
    currentPublicKey = legacyVerifyKey;
  }
  if (!(currentId && currentPublicKey)) {
    throw new Error(
      "A complete versioned runner verification key configuration is required."
    );
  }
  const config = {
    currentId,
    currentPublicKey,
    previousId: optionalEnvironment(environment.RUNNER_VERIFY_PREVIOUS_KEY_ID),
    previousLastSignedAt: optionalEnvironment(
      environment.RUNNER_VERIFY_PREVIOUS_LAST_SIGNED_AT
    ),
    previousPublicKey: optionalEnvironment(
      environment.RUNNER_VERIFY_PREVIOUS_KEY
    ),
    previousRetireAt: optionalEnvironment(
      environment.RUNNER_VERIFY_PREVIOUS_RETIRE_AT
    ),
  };
  const configKey = JSON.stringify(config);
  if (verificationKeyRingCache?.configKey === configKey) {
    return verificationKeyRingCache.ring;
  }
  const ring = await importVerifyKeyRing(config);
  verificationKeyRingCache = { configKey, ring };
  return ring;
}

function decodeKey(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error("Runner key encoding is invalid.");
  }
  const remainder = normalized.length % 4;
  const padded =
    remainder === 0 ? normalized : normalized + "=".repeat(4 - remainder);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function verificationRingFromKeyRing(
  ring: RunnerKeyRing
): RunnerVerificationKeyRing {
  return {
    current: { id: ring.current.id, publicKey: ring.current.publicKey },
    previous: ring.previous,
  };
}
