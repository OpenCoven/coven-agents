const MISSING_ABUSE_KEY_SECRET =
  "ABUSE_KEY_SECRET is required when REDIS_URL is configured.";

export function validateAbuseConfig(input: {
  isProduction: boolean;
  keySecret: string | undefined;
  redisUrl: string | undefined;
}): void {
  if (!input.isProduction || !input.redisUrl?.trim()) {
    return;
  }

  requireNonemptyAbuseKeySecret(input.keySecret);
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
