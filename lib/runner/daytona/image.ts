import "server-only";

import {
  type DaytonaConfig,
  DaytonaNotFoundError,
  Image,
  SnapshotState,
} from "@daytona/sdk";

export const DAYTONA_COPILOT_IMAGE_BASE = "node:22-bookworm-slim";
export const DAYTONA_COPILOT_SNAPSHOT_NAME = "coven-agents-copilot-1";
export const COPILOT_CLI_VERSION = "1.0.80";
export const PNPM_VERSION = "10.32.1";
export const WORKSPACE_DIRECTORY = "/workspace";

const VERSIONED_SNAPSHOT_NAME = /^coven-agents-copilot-\d+$/u;
const SENSITIVE_LOG_VALUE =
  /\b(?:api[-_]?key|token|secret|password|credential)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/giu;
const AUTHORIZATION_HEADER_VALUE =
  /(^|[^A-Za-z0-9-])(authorization)([ \t]*:[ \t]*)[^\r\n]*/gimu;

export type DaytonaSnapshotConfiguration = Readonly<{
  apiKey: string;
  apiUrl: string;
  snapshotName: string;
  target: "eu" | "us";
}>;

export type DaytonaSnapshot = Readonly<{
  name: string;
  state: string;
}>;

export type DaytonaSnapshotService = Readonly<{
  create: (
    parameters: Readonly<{ image: Image; name: string }>,
    options: Readonly<{ onLogs: (chunk: string) => void }>
  ) => Promise<DaytonaSnapshot>;
  get: (name: string) => Promise<DaytonaSnapshot>;
}>;

export type DaytonaSnapshotProvisioningDependencies = Readonly<{
  image?: Image;
  log: (message: string) => void;
  snapshot: DaytonaSnapshotService;
}>;

function configuredValue(
  environment: NodeJS.ProcessEnv,
  name:
    | "DAYTONA_API_KEY"
    | "DAYTONA_API_URL"
    | "DAYTONA_SNAPSHOT"
    | "DAYTONA_TARGET"
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`Missing required Daytona environment variable: ${name}.`);
  }
  return value;
}

/**
 * Validates the configuration consumed by the snapshot command without
 * importing the production runtime validator, which is a CLI entrypoint.
 */
export function daytonaSnapshotConfiguration(
  environment: NodeJS.ProcessEnv
): DaytonaSnapshotConfiguration {
  const apiKey = configuredValue(environment, "DAYTONA_API_KEY");
  const apiUrl = configuredValue(environment, "DAYTONA_API_URL");
  const snapshotName = configuredValue(environment, "DAYTONA_SNAPSHOT");
  const target = configuredValue(environment, "DAYTONA_TARGET");

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

export function daytonaClientConfiguration(
  configuration: DaytonaSnapshotConfiguration
): DaytonaConfig {
  return {
    apiKey: configuration.apiKey,
    apiUrl: configuration.apiUrl,
    target: configuration.target,
  };
}

export function createDaytonaCopilotImage(): Image {
  return Image.base(DAYTONA_COPILOT_IMAGE_BASE)
    .runCommands(
      `npm install --global pnpm@${PNPM_VERSION} @github/copilot@${COPILOT_CLI_VERSION}`,
      `mkdir --parents ${WORKSPACE_DIRECTORY}`
    )
    .workdir(WORKSPACE_DIRECTORY);
}

export function createDaytonaSnapshotDefinition(
  configuration: Pick<DaytonaSnapshotConfiguration, "snapshotName">
): Readonly<{ image: Image; name: string }> {
  return {
    image: createDaytonaCopilotImage(),
    name: configuration.snapshotName,
  };
}

export function sanitizeDaytonaBuildLog(chunk: string, apiKey: string): string {
  return chunk
    .replaceAll(apiKey, "[REDACTED]")
    .replace(SENSITIVE_LOG_VALUE, (match) => {
      const separator = match.includes("=") ? "=" : ":";
      return `${match.slice(0, match.indexOf(separator) + 1)} [REDACTED]`;
    })
    .replace(
      AUTHORIZATION_HEADER_VALUE,
      (_match, prefix: string, headerName: string, separator: string) =>
        `${prefix}${headerName}${separator}[REDACTED]`
    );
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof DaytonaNotFoundError ||
    (typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      error.statusCode === 404)
  );
}

function snapshotState(state: string): string {
  return Object.values(SnapshotState).includes(
    state as (typeof SnapshotState)[keyof typeof SnapshotState]
  )
    ? state
    : "unknown";
}

/**
 * Creates an immutable, versioned snapshot only when its name is unused.
 * It never activates, deletes, or otherwise changes existing snapshots.
 */
export async function provisionDaytonaSnapshot(
  configuration: DaytonaSnapshotConfiguration,
  dependencies: DaytonaSnapshotProvisioningDependencies
): Promise<DaytonaSnapshot> {
  let snapshotAlreadyExists = false;
  try {
    await dependencies.snapshot.get(configuration.snapshotName);
    snapshotAlreadyExists = true;
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw new Error(
        `Unable to determine whether Daytona snapshot "${configuration.snapshotName}" exists.`,
        { cause: error }
      );
    }
  }
  if (snapshotAlreadyExists) {
    throw new Error(
      `Daytona snapshot "${configuration.snapshotName}" already exists; refusing to recreate it.`
    );
  }

  try {
    await dependencies.snapshot.create(
      {
        image: dependencies.image ?? createDaytonaCopilotImage(),
        name: configuration.snapshotName,
      },
      {
        onLogs: (chunk) => {
          dependencies.log(
            sanitizeDaytonaBuildLog(chunk, configuration.apiKey)
          );
        },
      }
    );
  } catch (error) {
    throw new Error(
      `Failed to create Daytona snapshot "${configuration.snapshotName}".`,
      { cause: error }
    );
  }

  let snapshot: DaytonaSnapshot;
  try {
    snapshot = await dependencies.snapshot.get(configuration.snapshotName);
  } catch (error) {
    throw new Error(
      `Unable to verify Daytona snapshot "${configuration.snapshotName}" after creation.`,
      { cause: error }
    );
  }

  if (
    snapshot.name !== configuration.snapshotName ||
    snapshot.state !== SnapshotState.ACTIVE
  ) {
    throw new Error(
      `Daytona snapshot "${configuration.snapshotName}" is not active after creation (state: ${snapshotState(snapshot.state)}).`
    );
  }
  return snapshot;
}
