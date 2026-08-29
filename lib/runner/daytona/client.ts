import "server-only";

import { Daytona, type DaytonaConfig } from "@daytona/sdk";
import {
  DAYTONA_MIN_REQUEST_TIMEOUT_MS,
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

export function daytonaClientForDeadline(
  deadline: number,
  options: Readonly<{
    environment?: NodeJS.ProcessEnv;
    factory?: DaytonaClientFactory;
    now?: () => number;
  }> = {}
): Daytona {
  const environment = options.environment ?? process.env;
  const configuration = daytonaRunnerConfiguration(environment);
  const remainingMs = deadline - (options.now ?? Date.now)();
  if (remainingMs <= 0) {
    throw new Error("Daytona request deadline has elapsed.");
  }
  const requestTimeoutMs = Math.min(
    configuration.requestTimeoutMs,
    Math.max(DAYTONA_MIN_REQUEST_TIMEOUT_MS, Math.ceil(remainingMs))
  );
  const factory = options.factory ?? ((value) => new Daytona(value));
  return factory(
    daytonaRunnerClientConfiguration({
      ...configuration,
      requestTimeoutMs,
    })
  );
}

/** Test-only cache reset; production code must retain one client per process. */
export function resetDaytonaClientForTest(): void {
  cachedClient = undefined;
}
