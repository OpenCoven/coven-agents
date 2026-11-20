import {
  enforcesProductionAbuseConfig,
  validateAbuseConfig,
} from "../lib/abuse/config";
import { approvedApplicationOrigin } from "../lib/auth/application-origin";
import {
  campaignEnabled,
  validateCampaignConfig,
} from "../lib/billing/campaign";
import { validateSubscriptionCheckoutEnvironment } from "../lib/billing/config-core";
import { credentialKekRingFromEnvironment } from "../lib/credentials/key-ring";
import { validateGitHubEnvironment } from "../lib/github/config";
import {
  DAYTONA_SANDBOX_RESOURCE_POLICY_ENVIRONMENT_KEYS,
  daytonaDomainAllowList,
  daytonaGitHubGatewayHostname,
  daytonaRequestTimeout,
  daytonaSandboxResourcePolicy,
  daytonaSnapshotConfiguration,
} from "../lib/runner/daytona/config";
import { hermeticRunnerMode } from "../lib/runner/hermetic/mode";

const BETA_EMAIL = /^[^\s@,]+@[^\s@,]+$/;
const REQUIRED_PRODUCTION_VARIABLES = [
  "APP_ORIGIN",
  "CRON_SECRET",
  "DAYTONA_API_KEY",
  "DAYTONA_DOMAIN_ALLOW_LIST",
  "DAYTONA_SNAPSHOT",
  "REDIS_URL",
  "ABUSE_KEY_SECRET",
  "GLOBAL_DAILY_RUN_CAP",
  "OPERATOR_DIAGNOSTIC_TOKEN",
  "RUNNER_MANUAL_RECONCILE_SECRET",
] as const;
const PRIVILEGED_RUNNER_SECRETS = [
  "CRON_SECRET",
  "OPERATOR_DIAGNOSTIC_TOKEN",
  "RUNNER_MANUAL_RECONCILE_SECRET",
] as const;
const MAX_PRIVILEGED_RUNNER_SECRET_LENGTH = 1024;
const ADMISSION_LIMIT_MAXIMUMS = {
  RUN_ADMISSION_CONSECUTIVE_MAX: "2",
  RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX: "25",
  RUN_ADMISSION_TENANT_ACTIVE_MAX: "2",
  RUN_ADMISSION_TENANT_QUEUE_MAX: "10",
} as const;

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
    if (campaignEnabled(env)) {
      throw new Error(
        "Public release requires BETA_CAMPAIGN_ENABLED=off: the campaign hands " +
          "free run minutes to every new account, which is a beta acquisition " +
          "cost, not a launched pricing model."
      );
    }
    return;
  }

  if (env.BETA_MODE !== "on") {
    throw new Error("Closed beta requires BETA_MODE=on.");
  }

  validateCampaignConfig(env);

  /**
   * An open campaign replaces the allowlist as the guest list, so an empty one
   * is correct rather than a lockout. The campaign has its own bounds -- a
   * global account cap, a per-account minute grant and an expiry -- which
   * `validateCampaignConfig` has already insisted are present and sane.
   */
  if (env.BETA_CAMPAIGN_ENABLED === "on") {
    return;
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

function validateProductionDaytonaConfig(environment: NodeJS.ProcessEnv): void {
  const missing = REQUIRED_PRODUCTION_VARIABLES.filter(
    (name) => !environment[name]?.trim()
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing required production environment variables: ${missing.join(", ")}.`
    );
  }
  validatePrivilegedRunnerSecrets(environment);
  approvedApplicationOrigin(environment);

  daytonaRequestTimeout(environment);
  const domainAllowList = daytonaDomainAllowList(environment);
  daytonaGitHubGatewayHostname(environment, domainAllowList);
  daytonaSandboxResourcePolicy(environment);
  daytonaSnapshotConfiguration(environment);
  validateAdmissionSettings(environment);
}

function validatePrivilegedRunnerSecrets(environment: NodeJS.ProcessEnv): void {
  const configured = new Map<string, string>();
  for (const name of PRIVILEGED_RUNNER_SECRETS) {
    const raw = environment[name];
    if (raw === undefined) {
      continue;
    }
    const value = raw.trim();
    if (!value) {
      throw new Error(`${name} must be nonblank when configured.`);
    }
    if (value.length > MAX_PRIVILEGED_RUNNER_SECRET_LENGTH) {
      throw new Error(
        `${name} must not exceed ${MAX_PRIVILEGED_RUNNER_SECRET_LENGTH} characters.`
      );
    }
    configured.set(name, value);
  }

  for (
    let leftIndex = 0;
    leftIndex < PRIVILEGED_RUNNER_SECRETS.length;
    leftIndex += 1
  ) {
    const left = PRIVILEGED_RUNNER_SECRETS[leftIndex];
    const leftValue = configured.get(left);
    if (!leftValue) {
      continue;
    }
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < PRIVILEGED_RUNNER_SECRETS.length;
      rightIndex += 1
    ) {
      const right = PRIVILEGED_RUNNER_SECRETS[rightIndex];
      const rightValue = configured.get(right);
      if (rightValue && leftValue === rightValue) {
        throw new Error(
          `Privileged runner secrets must be distinct: ${left} aliases ${right}.`
        );
      }
    }
  }
}

function validateConfiguredPreviewDaytonaConfig(
  environment: NodeJS.ProcessEnv
): void {
  if (environment.DAYTONA_REQUEST_TIMEOUT_MS !== undefined) {
    daytonaRequestTimeout(environment);
  }
  if (environment.DAYTONA_DOMAIN_ALLOW_LIST?.trim()) {
    daytonaDomainAllowList(environment);
  }
  if (
    environment.DAYTONA_API_URL !== undefined ||
    environment.DAYTONA_SNAPSHOT !== undefined ||
    environment.DAYTONA_TARGET !== undefined
  ) {
    daytonaSnapshotConfiguration({
      ...environment,
      DAYTONA_API_KEY:
        environment.DAYTONA_API_KEY?.trim() || "preview-validation-key",
      DAYTONA_SNAPSHOT:
        environment.DAYTONA_SNAPSHOT === undefined
          ? "coven-agents-copilot-1"
          : environment.DAYTONA_SNAPSHOT,
    });
  }

  if (
    DAYTONA_SANDBOX_RESOURCE_POLICY_ENVIRONMENT_KEYS.some(
      (name) => environment[name] !== undefined
    )
  ) {
    daytonaSandboxResourcePolicy(environment);
  }
  for (const [name, maximum] of Object.entries(ADMISSION_LIMIT_MAXIMUMS)) {
    if (environment[name] !== undefined) {
      validateBoundedNonNegativeSafeIntegerSetting(
        name,
        environment[name],
        maximum
      );
    }
  }
  if (environment.RUN_ADMISSION_MODE !== undefined) {
    validateRunAdmissionMode(environment.RUN_ADMISSION_MODE);
  }
}

function validateAdmissionSettings(environment: NodeJS.ProcessEnv): void {
  for (const [name, maximum] of Object.entries(ADMISSION_LIMIT_MAXIMUMS)) {
    validateBoundedNonNegativeSafeIntegerSetting(
      name,
      environment[name],
      maximum
    );
  }
  validateRunAdmissionMode(environment.RUN_ADMISSION_MODE);
}

function validateNonNegativeSafeIntegerSetting(
  name: string,
  configured: string | undefined,
  defaultValue: string,
  errorMessage = `${name} must be a non-negative safe integer.`
): number {
  const value = (configured === undefined ? defaultValue : configured).trim();
  if (!/^\d+$/u.test(value)) {
    throw new Error(errorMessage);
  }

  const parsed = Number(value);
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
  if (parsed > Number(maximum)) {
    throw new Error(errorMessage);
  }
  return parsed;
}

function validateRunAdmissionMode(configured: string | undefined): "queue" {
  const normalized = configured?.trim();
  if (normalized === undefined || normalized === "") {
    return "queue";
  }
  if (normalized !== "queue") {
    throw new Error('RUN_ADMISSION_MODE must be "queue" when set.');
  }
  return "queue";
}

export async function validateRuntimeConfig(
  env: NodeJS.ProcessEnv,
  explicitRelease: boolean
): Promise<void> {
  hermeticRunnerMode(env);
  validateSubscriptionCheckoutEnvironment(env);
  validateGitHubEnvironment(env);

  const productionRelease = isProductionRelease(env, explicitRelease);
  validateReleaseAudience(env, explicitRelease);
  if (productionRelease) {
    validateProductionDaytonaConfig(env);
  } else {
    validateConfiguredPreviewDaytonaConfig(env);
    if (env.APP_ORIGIN !== undefined) {
      approvedApplicationOrigin(env);
    }

    if (
      env.GITHUB_TEAMS_ENABLED === "on" &&
      env.DAYTONA_DOMAIN_ALLOW_LIST?.trim()
    ) {
      daytonaGitHubGatewayHostname(env);
    }
  }

  /**
   * Predicts what `register()` will enforce at boot, which is decided by
   * NODE_ENV and not by the release audience. Hardcoding this to true made the
   * validator stricter than the server for local development, and reading it
   * from `productionRelease` instead would make it laxer than the server for
   * Vercel previews, which boot with NODE_ENV=production.
   */
  validateAbuseConfig({
    globalDailyRunCap: env.GLOBAL_DAILY_RUN_CAP,
    isProduction: enforcesProductionAbuseConfig(env.NODE_ENV),
    keySecret: env.ABUSE_KEY_SECRET,
    redisUrl: env.REDIS_URL,
  });

  if (hasCredentialKekConfiguration(env)) {
    await credentialKekRingFromEnvironment(env);
  }
}
