import { validateAbuseConfig } from "../lib/abuse/config";
import { credentialKekRingFromEnvironment } from "../lib/credentials/key-ring";

const BETA_EMAIL = /^[^\s@,]+@[^\s@,]+$/;

function isProductionRelease(
  env: NodeJS.ProcessEnv,
  explicitRelease: boolean
): boolean {
  if (explicitRelease) {
    return true;
  }

  // Vercel previews use NODE_ENV=production for optimized builds, but they are
  // not the separately approved production audience decision.
  if (env.VERCEL_ENV === "preview" || env.VERCEL_ENV === "development") {
    return false;
  }

  return env.VERCEL_ENV === "production" || env.NODE_ENV === "production";
}

function validateReleaseAudience(
  env: NodeJS.ProcessEnv,
  explicitRelease: boolean
): void {
  if (!isProductionRelease(env, explicitRelease)) {
    return;
  }

  if (
    env.RELEASE_AUDIENCE !== "closed-beta" &&
    env.RELEASE_AUDIENCE !== "public"
  ) {
    throw new Error(
      'RELEASE_AUDIENCE must be exactly "closed-beta" or "public" for production validation.'
    );
  }

  if (env.RELEASE_AUDIENCE === "public") {
    if (env.BETA_MODE !== "off") {
      throw new Error("Public release requires BETA_MODE=off.");
    }
    return;
  }

  if (env.BETA_MODE !== "on") {
    throw new Error("Closed beta requires BETA_MODE=on.");
  }

  const allowlist = (env.BETA_ALLOWLIST ?? "")
    .split(",")
    .map((email) => email.trim());
  if (
    allowlist.length === 0 ||
    allowlist.some((email) => !email || !BETA_EMAIL.test(email))
  ) {
    throw new Error(
      "Closed beta requires BETA_ALLOWLIST to contain only valid email addresses."
    );
  }
}

function hasCredentialKekConfiguration(
  environment: NodeJS.ProcessEnv
): boolean {
  return Object.keys(environment).some(
    (name) => name === "CREDENTIAL_KEK" || name.startsWith("CREDENTIAL_KEK_")
  );
}

export async function validateRuntimeConfig(
  env: NodeJS.ProcessEnv,
  explicitRelease: boolean
): Promise<void> {
  validateReleaseAudience(env, explicitRelease);

  validateAbuseConfig({
    globalDailyRunCap: env.GLOBAL_DAILY_RUN_CAP,
    isProduction: true,
    keySecret: env.ABUSE_KEY_SECRET,
    redisUrl: env.REDIS_URL,
  });

  if (hasCredentialKekConfiguration(env)) {
    await credentialKekRingFromEnvironment(env);
  }
}
