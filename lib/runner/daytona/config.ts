export const DAYTONA_DEFAULT_API_URL = "https://app.daytona.io/api";
export const DAYTONA_DEFAULT_TARGET = "us";

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
