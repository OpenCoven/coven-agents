import { validateAbuseConfig } from "../lib/abuse/config";
import { credentialKekRingFromEnvironment } from "../lib/credentials/key-ring";

const REQUIRED_PRODUCTION_VARIABLES = [
  "DAYTONA_API_KEY",
  "DAYTONA_SNAPSHOT",
  "REDIS_URL",
  "ABUSE_KEY_SECRET",
  "RUNNER_RECONCILE_SECRET",
  "OPERATOR_DIAGNOSTIC_TOKEN",
] as const;
const DAYTONA_INTERVAL_DEFAULTS = {
  DAYTONA_AUTO_ARCHIVE_MINUTES: "10080",
  DAYTONA_AUTO_STOP_MINUTES: "15",
} as const;
const ADMISSION_LIMIT_MAXIMUMS = {
  RUN_ADMISSION_CONSECUTIVE_MAX: "2",
  RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX: "25",
  RUN_ADMISSION_TENANT_ACTIVE_MAX: "2",
  RUN_ADMISSION_TENANT_QUEUE_MAX: "10",
} as const;

async function main() {
  validateProductionRuntimeConfig(process.env);
  validateAbuseConfig({
    globalDailyRunCap: process.env.GLOBAL_DAILY_RUN_CAP,
    isProduction: true,
    keySecret: process.env.ABUSE_KEY_SECRET,
    redisUrl: process.env.REDIS_URL,
  });
  if (hasCredentialKekConfiguration(process.env)) {
    await credentialKekRingFromEnvironment();
  }
}

function hasCredentialKekConfiguration(
  environment: NodeJS.ProcessEnv
): boolean {
  return Object.keys(environment).some(
    (name) => name === "CREDENTIAL_KEK" || name.startsWith("CREDENTIAL_KEK_")
  );
}

function validateProductionRuntimeConfig(environment: NodeJS.ProcessEnv): void {
  const missing = REQUIRED_PRODUCTION_VARIABLES.filter(
    (name) => !environment[name]?.trim()
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing required production environment variables: ${missing.join(", ")}.`
    );
  }

  validateDaytonaTarget(environment.DAYTONA_TARGET);

  for (const [name, defaultValue] of Object.entries(
    DAYTONA_INTERVAL_DEFAULTS
  )) {
    validateNonNegativeSafeIntegerSetting(
      name,
      environment[name],
      defaultValue
    );
  }

  for (const [name, maximum] of Object.entries(ADMISSION_LIMIT_MAXIMUMS)) {
    validateBoundedNonNegativeSafeIntegerSetting(
      name,
      environment[name],
      maximum
    );
  }
}

function validateDaytonaTarget(configured: string | undefined): void {
  const normalized = configured === undefined ? "us" : configured.trim();
  if (normalized !== "us" && normalized !== "eu") {
    throw new Error('DAYTONA_TARGET must be "us" or "eu".');
  }
}

function parseConfiguredNumber(
  configured: string | undefined,
  defaultValue: string
): number {
  const value = (configured === undefined ? defaultValue : configured).trim();
  return Number(value);
}

function validateNonNegativeSafeIntegerSetting(
  name: string,
  configured: string | undefined,
  defaultValue: string,
  errorMessage = `${name} must be a non-negative safe integer.`
): number {
  const value = (configured === undefined ? defaultValue : configured).trim();
  if (!/^\d+$/.test(value)) {
    throw new Error(errorMessage);
  }

  const parsed = parseConfiguredNumber(configured, defaultValue);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(errorMessage);
  }
  return parsed;
}

function validateBoundedNonNegativeSafeIntegerSetting(
  name: string,
  configured: string | undefined,
  maximum: string
): number {
  const errorMessage = `${name} must be a non-negative safe integer no greater than ${maximum}.`;
  const parsed = validateNonNegativeSafeIntegerSetting(
    name,
    configured,
    maximum,
    errorMessage
  );
  const parsedMaximum = Number(maximum);
  if (parsed > parsedMaximum) {
    throw new Error(errorMessage);
  }
  return parsed;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Runtime configuration is invalid."}\n`
  );
  process.exit(1);
});
