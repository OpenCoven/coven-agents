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
const RUNTIME_INTEGER_DEFAULTS = {
  DAYTONA_AUTO_ARCHIVE_MINUTES: "10080",
  DAYTONA_AUTO_STOP_MINUTES: "15",
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

  for (const [name, defaultValue] of Object.entries(RUNTIME_INTEGER_DEFAULTS)) {
    validatePositiveIntegerSetting(name, environment[name], defaultValue);
  }
}

function validateDaytonaTarget(configured: string | undefined): void {
  const normalized = configured === undefined ? "us" : configured.trim();
  if (normalized !== "us" && normalized !== "eu") {
    throw new Error('DAYTONA_TARGET must be "us" or "eu".');
  }
}

function validatePositiveIntegerSetting(
  name: string,
  configured: string | undefined,
  defaultValue: string
): number {
  const value = (configured === undefined ? defaultValue : configured).trim();
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive integer.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Runtime configuration is invalid."}\n`
  );
  process.exit(1);
});
