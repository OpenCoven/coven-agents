import "server-only";

import { Daytona, type DaytonaConfig } from "@daytona/sdk";
import {
  type DaytonaSnapshotConfiguration,
  daytonaClientConfiguration,
  daytonaSnapshotConfiguration,
} from "./image";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const MIN_REQUEST_TIMEOUT_MS = 1000;

export type DaytonaRunnerConfiguration = DaytonaSnapshotConfiguration &
  Readonly<{ requestTimeoutMs: number }>;

export type DaytonaClientFactory = (configuration: DaytonaConfig) => Daytona;

let cachedClient: Daytona | undefined;

function configuredRequestTimeout(environment: NodeJS.ProcessEnv): number {
  const raw =
    environment.DAYTONA_REQUEST_TIMEOUT_MS?.trim() ??
    String(DEFAULT_REQUEST_TIMEOUT_MS);
  if (!/^\d+$/u.test(raw)) {
    throw new Error(
      `DAYTONA_REQUEST_TIMEOUT_MS must be an integer between ${MIN_REQUEST_TIMEOUT_MS} and ${MAX_REQUEST_TIMEOUT_MS}.`
    );
  }
  const timeout = Number(raw);
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < MIN_REQUEST_TIMEOUT_MS ||
    timeout > MAX_REQUEST_TIMEOUT_MS
  ) {
    throw new Error(
      `DAYTONA_REQUEST_TIMEOUT_MS must be an integer between ${MIN_REQUEST_TIMEOUT_MS} and ${MAX_REQUEST_TIMEOUT_MS}.`
    );
  }
  return timeout;
}

/**
 * Uses Task 5's validation for the API endpoint, key, target, and snapshot.
 * It intentionally returns configuration only; callers must not log it.
 */
export function daytonaRunnerConfiguration(
  environment: NodeJS.ProcessEnv = process.env
): DaytonaRunnerConfiguration {
  return {
    ...daytonaSnapshotConfiguration(environment),
    requestTimeoutMs: configuredRequestTimeout(environment),
  };
}

export function daytonaRunnerClientConfiguration(
  configuration: DaytonaRunnerConfiguration
): DaytonaConfig {
  return {
    ...daytonaClientConfiguration(configuration),
    requestTimeoutMs: configuration.requestTimeoutMs,
  };
}

/**
 * Returns the process-wide SDK client. Supplying a factory bypasses the cache,
 * keeping provider tests and explicitly isolated callers injectable.
 */
export function daytonaClient(
  environment: NodeJS.ProcessEnv = process.env,
  factory?: DaytonaClientFactory
): Daytona {
  const configuration = daytonaRunnerClientConfiguration(
    daytonaRunnerConfiguration(environment)
  );
  if (factory) {
    return factory(configuration);
  }
  cachedClient ??= new Daytona(configuration);
  return cachedClient;
}

/** Test-only cache reset; production code must retain one client per process. */
export function resetDaytonaClientForTest(): void {
  cachedClient = undefined;
}
