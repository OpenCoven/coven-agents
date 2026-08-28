import "server-only";

import { Daytona, type DaytonaConfig } from "@daytona/sdk";
import {
  type DaytonaSnapshotConfiguration,
  daytonaRequestTimeout,
  daytonaSnapshotConfiguration,
} from "./config";
import { daytonaClientConfiguration } from "./image";

export type DaytonaRunnerConfiguration = DaytonaSnapshotConfiguration &
  Readonly<{ requestTimeoutMs: number }>;

export type DaytonaClientFactory = (configuration: DaytonaConfig) => Daytona;

let cachedClient: Daytona | undefined;

/**
 * Uses Task 5's validation for the API endpoint, key, target, and snapshot.
 * It intentionally returns configuration only; callers must not log it.
 */
export function daytonaRunnerConfiguration(
  environment: NodeJS.ProcessEnv = process.env
): DaytonaRunnerConfiguration {
  return {
    ...daytonaSnapshotConfiguration(environment),
    requestTimeoutMs: daytonaRequestTimeout(environment),
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
