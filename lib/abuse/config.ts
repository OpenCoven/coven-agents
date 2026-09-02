const MISSING_ABUSE_KEY_SECRET =
  "ABUSE_KEY_SECRET is required when REDIS_URL or GLOBAL_DAILY_RUN_CAP is configured.";
const INVALID_GLOBAL_DAILY_RUN_CAP =
  "GLOBAL_DAILY_RUN_CAP must be a positive integer.";

/**
 * Whether reservation and abuse configuration is enforced for a given runtime.
 *
 * This is deliberately NODE_ENV rather than the release audience. A Vercel
 * preview builds and boots with NODE_ENV=production, so `register()` enforces
 * these rules there, even though `isProductionRelease` treats a preview as not
 * production because it is not the approved production audience. Startup and
 * validation must read this the same way: if validation used the release
 * notion instead, a preview would build clean and then fail at boot.
 */
export function enforcesProductionAbuseConfig(
  nodeEnv: string | undefined
): boolean {
  return nodeEnv === "production";
}

export function validateAbuseConfig(input: {
  globalDailyRunCap: string | undefined;
  isProduction: boolean;
  keySecret: string | undefined;
  redisUrl: string | undefined;
}): void {
  if (!input.isProduction) {
    return;
  }

  if (input.globalDailyRunCap?.trim()) {
    globalDailyRunCapFromEnv(input.globalDailyRunCap);
    requireNonemptyAbuseKeySecret(input.keySecret);
  } else if (input.redisUrl?.trim()) {
    requireNonemptyAbuseKeySecret(input.keySecret);
  }
}

export function globalDailyRunCapFromEnv(
  configured: string | undefined
): number {
  const value = configured?.trim() ?? "";
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(INVALID_GLOBAL_DAILY_RUN_CAP);
  }

  const cap = Number(value);
  if (!Number.isSafeInteger(cap)) {
    throw new Error(INVALID_GLOBAL_DAILY_RUN_CAP);
  }
  return cap;
}

export function requireAbuseKeySecret(
  redisUrl: string | undefined,
  keySecret: string | undefined
): string | undefined {
  if (!redisUrl?.trim()) {
    return undefined;
  }

  return requireNonemptyAbuseKeySecret(keySecret);
}

export function requireNonemptyAbuseKeySecret(
  keySecret: string | undefined
): string {
  if (typeof keySecret !== "string" || !keySecret.trim()) {
    throw new Error(MISSING_ABUSE_KEY_SECRET);
  }

  return keySecret;
}
