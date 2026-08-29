import {
  importVerifyKeyRing,
  type RunnerVerificationKeyRing,
} from "@opencoven/agent-contracts";

let verificationKeyRingCache: {
  configKey: string;
  ring: RunnerVerificationKeyRing;
} | null = null;

function optionalEnvironment(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

export async function runnerVerificationKeyRingFromEnvironment(
  environment: Record<string, string | undefined> = process.env
): Promise<RunnerVerificationKeyRing> {
  const compatibilityKeyId = optionalEnvironment(
    environment.RUNNER_SIGNING_KEY_ID
  );
  const compatibilityPublicKey = optionalEnvironment(
    environment.RUNNER_SIGNING_PUBLIC_KEY
  );
  const verifyKeyId = optionalEnvironment(environment.RUNNER_VERIFY_KEY_ID);
  const verifyKey = optionalEnvironment(environment.RUNNER_VERIFY_KEY);
  const hasCompatibilityKey =
    compatibilityKeyId !== undefined || compatibilityPublicKey !== undefined;

  let currentId: string | undefined;
  let currentPublicKey: string | undefined;
  if (hasCompatibilityKey) {
    if (verifyKeyId !== undefined || verifyKey !== undefined) {
      throw new Error(
        "Runner compatibility and verification key configuration cannot be mixed."
      );
    }
    currentId = compatibilityKeyId;
    currentPublicKey = compatibilityPublicKey;
  } else if (verifyKeyId === undefined) {
    currentId = "legacy";
    currentPublicKey = verifyKey;
  } else {
    currentId = verifyKeyId;
    currentPublicKey = verifyKey;
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
