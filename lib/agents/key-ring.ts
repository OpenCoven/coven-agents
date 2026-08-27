import {
  importVerifyKey,
  importVerifyKeyRing,
  type RunnerVerificationKeyRing,
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
    retireAt: Date;
  };
};

export type RunnerKeyRingConfig = {
  currentId: string;
  currentPrivateKey: string;
  currentPublicKey: string;
  previousId?: string;
  previousPublicKey?: string;
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

function parseRetireAt(value: string, now: Date): Date {
  const retireAt = new Date(value);
  if (Number.isNaN(retireAt.getTime()) || retireAt.getTime() <= now.getTime()) {
    throw new Error("Runner previous key retirement must be in the future.");
  }
  return retireAt;
}

export async function parseRunnerKeyRing(
  config: RunnerKeyRingConfig,
  now = new Date()
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
    config.previousId,
    config.previousPublicKey,
    config.previousRetireAt,
  ].some((value) => value !== undefined);
  if (!hasPrevious) {
    return { current: { id: currentId, privateKey, publicKey } };
  }

  if (
    !config.previousId ||
    !config.previousPublicKey ||
    !config.previousRetireAt
  ) {
    throw new Error("Runner previous key configuration is incomplete.");
  }
  const previousId = requireKeyId(config.previousId, "Runner previous key id");
  if (previousId === currentId) {
    throw new Error("Runner current and previous key ids must differ.");
  }
  const previousPublicKey = await importVerifyKey(
    requireKeyMaterial(config.previousPublicKey, "Runner previous public key")
  );
  const retireAt = parseRetireAt(config.previousRetireAt, now);

  return {
    current: { id: currentId, privateKey, publicKey },
    previous: { id: previousId, publicKey: previousPublicKey, retireAt },
  };
}

export async function runnerKeyRingFromEnvironment(
  environment: Record<string, string | undefined> = process.env
): Promise<RunnerKeyRing> {
  const legacyConfiguration =
    environment.RUNNER_SIGNING_KEY_ID === undefined &&
    environment.RUNNER_SIGNING_PUBLIC_KEY === undefined &&
    Boolean(environment.RUNNER_VERIFY_KEY);
  const currentId = legacyConfiguration
    ? "legacy"
    : environment.RUNNER_SIGNING_KEY_ID;
  const currentPrivateKey = environment.RUNNER_SIGNING_KEY;
  const currentPublicKey = legacyConfiguration
    ? environment.RUNNER_VERIFY_KEY
    : environment.RUNNER_SIGNING_PUBLIC_KEY;
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
    previousId: environment.RUNNER_VERIFY_PREVIOUS_KEY_ID,
    previousPublicKey: environment.RUNNER_VERIFY_PREVIOUS_KEY,
    previousRetireAt: environment.RUNNER_VERIFY_PREVIOUS_RETIRE_AT,
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
  const hasVersionedAppKey =
    environment.RUNNER_SIGNING_KEY_ID !== undefined ||
    environment.RUNNER_SIGNING_PUBLIC_KEY !== undefined;
  let currentId: string | undefined;
  let currentPublicKey: string | undefined;
  if (hasVersionedAppKey) {
    if (
      environment.RUNNER_VERIFY_KEY_ID !== undefined ||
      environment.RUNNER_VERIFY_KEY !== undefined
    ) {
      throw new Error(
        "Runner app and legacy verification key configuration cannot be mixed."
      );
    }
    currentId = environment.RUNNER_SIGNING_KEY_ID;
    currentPublicKey = environment.RUNNER_SIGNING_PUBLIC_KEY;
  } else if (environment.RUNNER_VERIFY_KEY_ID === undefined) {
    currentId = "legacy";
    currentPublicKey = environment.RUNNER_VERIFY_KEY;
  } else {
    currentId = environment.RUNNER_VERIFY_KEY_ID;
    currentPublicKey = environment.RUNNER_VERIFY_KEY;
  }
  if (!(currentId && currentPublicKey)) {
    throw new Error(
      "A complete versioned runner verification key configuration is required."
    );
  }
  const config = {
    currentId,
    currentPublicKey,
    previousId: environment.RUNNER_VERIFY_PREVIOUS_KEY_ID,
    previousPublicKey: environment.RUNNER_VERIFY_PREVIOUS_KEY,
    previousRetireAt: environment.RUNNER_VERIFY_PREVIOUS_RETIRE_AT,
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
