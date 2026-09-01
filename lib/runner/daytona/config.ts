import { approvedApplicationOrigin } from "@/lib/auth/application-origin";

export const DAYTONA_DEFAULT_API_URL = "https://app.daytona.io/api";
export const DAYTONA_DEFAULT_TARGET = "us";
export const DAYTONA_DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DAYTONA_MAX_REQUEST_TIMEOUT_MS = 120_000;
export const DAYTONA_MIN_REQUEST_TIMEOUT_MS = 1000;

const VERSIONED_SNAPSHOT_NAME = /^coven-agents-copilot-\d+$/u;

export type DaytonaSnapshotConfiguration = Readonly<{
  apiKey: string;
  apiUrl: string;
  snapshotName: string;
  target: "eu" | "us";
}>;

function configuredValue(
  environment: NodeJS.ProcessEnv,
  name: "DAYTONA_API_KEY" | "DAYTONA_SNAPSHOT"
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`Missing required Daytona environment variable: ${name}.`);
  }
  return value;
}

function configuredDefault(
  environment: NodeJS.ProcessEnv,
  name: "DAYTONA_API_URL" | "DAYTONA_TARGET",
  defaultValue: string
): string {
  return environment[name]?.trim() || defaultValue;
}

/**
 * Validates the Daytona settings shared by production preflight, image
 * provisioning, and runtime SDK construction.
 */
export function daytonaSnapshotConfiguration(
  environment: NodeJS.ProcessEnv = process.env
): DaytonaSnapshotConfiguration {
  const apiKey = configuredValue(environment, "DAYTONA_API_KEY");
  const apiUrl = configuredDefault(
    environment,
    "DAYTONA_API_URL",
    DAYTONA_DEFAULT_API_URL
  );
  const snapshotName = configuredValue(environment, "DAYTONA_SNAPSHOT");
  const target = configuredDefault(
    environment,
    "DAYTONA_TARGET",
    DAYTONA_DEFAULT_TARGET
  );

  let parsedApiUrl: URL;
  try {
    parsedApiUrl = new URL(apiUrl);
  } catch (error) {
    throw new Error("DAYTONA_API_URL must be an absolute HTTPS URL.", {
      cause: error,
    });
  }
  if (parsedApiUrl.protocol !== "https:") {
    throw new Error("DAYTONA_API_URL must be an absolute HTTPS URL.");
  }
  if (target !== "eu" && target !== "us") {
    throw new Error('DAYTONA_TARGET must be "us" or "eu".');
  }
  if (!VERSIONED_SNAPSHOT_NAME.test(snapshotName)) {
    throw new Error(
      "DAYTONA_SNAPSHOT must be a versioned coven-agents-copilot-N name."
    );
  }

  return { apiKey, apiUrl: parsedApiUrl.toString(), snapshotName, target };
}

/** Shared client/preflight parser for Daytona's bounded request timeout. */
export function daytonaRequestTimeout(
  environment: NodeJS.ProcessEnv = process.env
): number {
  const raw =
    environment.DAYTONA_REQUEST_TIMEOUT_MS?.trim() ??
    String(DAYTONA_DEFAULT_REQUEST_TIMEOUT_MS);
  if (!/^\d+$/u.test(raw)) {
    throw new Error(
      `DAYTONA_REQUEST_TIMEOUT_MS must be an integer between ${DAYTONA_MIN_REQUEST_TIMEOUT_MS} and ${DAYTONA_MAX_REQUEST_TIMEOUT_MS}.`
    );
  }
  const timeout = Number(raw);
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < DAYTONA_MIN_REQUEST_TIMEOUT_MS ||
    timeout > DAYTONA_MAX_REQUEST_TIMEOUT_MS
  ) {
    throw new Error(
      `DAYTONA_REQUEST_TIMEOUT_MS must be an integer between ${DAYTONA_MIN_REQUEST_TIMEOUT_MS} and ${DAYTONA_MAX_REQUEST_TIMEOUT_MS}.`
    );
  }
  return timeout;
}

/**
 * Daytona accepts domain names, not URLs. Normalize once before config reaches
 * the SDK so production sandbox creation cannot silently become unrestricted.
 */
export function daytonaDomainAllowList(
  environment: NodeJS.ProcessEnv = process.env
): string | undefined {
  const configured = environment.DAYTONA_DOMAIN_ALLOW_LIST;
  if (!configured?.trim()) {
    if (environment.NODE_ENV === "production") {
      throw new Error(
        "Missing required Daytona environment variable: DAYTONA_DOMAIN_ALLOW_LIST."
      );
    }

    return undefined;
  }
  if (containsControlCharacter(configured)) {
    throw new Error(
      "DAYTONA_DOMAIN_ALLOW_LIST must be a comma-separated list of domain names without URL schemes, paths, or ports."
    );
  }
  const domains = configured.split(",").map((entry) => entry.trim());
  if (
    domains.some(
      (domain) =>
        !domain ||
        /[:/]/u.test(domain) ||
        !/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(
          domain
        )
    )
  ) {
    throw new Error(
      "DAYTONA_DOMAIN_ALLOW_LIST must be a comma-separated list of domain names without URL schemes, paths, or ports."
    );
  }
  return [...new Set(domains.map((domain) => domain.toLowerCase()))].join(",");
}

export function daytonaGitHubGatewayHostname(
  environment: NodeJS.ProcessEnv = process.env,
  configuredAllowList = daytonaDomainAllowList(environment)
): string | undefined {
  if (
    environment.GITHUB_TEAMS_ENABLED !== "on" ||
    configuredAllowList === undefined
  ) {
    return undefined;
  }
  const { hostname } = new URL(approvedApplicationOrigin(environment));
  if (!configuredAllowList.split(",").includes(hostname)) {
    throw new Error(
      "DAYTONA_DOMAIN_ALLOW_LIST must include the APP_ORIGIN hostname when GitHub teams are enabled."
    );
  }
  return hostname;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}
