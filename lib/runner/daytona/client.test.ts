import assert from "node:assert/strict";
import test from "node:test";
import type { DaytonaConfig } from "@daytona/sdk";
import {
  daytonaClient,
  daytonaRunnerConfiguration,
  resetDaytonaClientForTest,
} from "./client";

const environment = (): NodeJS.ProcessEnv => ({
  DAYTONA_API_KEY: "test-daytona-key",
  DAYTONA_API_URL: "https://daytona.test/api",
  DAYTONA_SNAPSHOT: "coven-agents-copilot-1",
  DAYTONA_TARGET: "us",
  NODE_ENV: "test",
});

test("Daytona client configuration validates a bounded request timeout", () => {
  assert.equal(
    daytonaRunnerConfiguration(environment()).requestTimeoutMs,
    30_000
  );
  assert.equal(
    daytonaRunnerConfiguration({
      ...environment(),
      DAYTONA_REQUEST_TIMEOUT_MS: "120000",
    }).requestTimeoutMs,
    120_000
  );
  assert.throws(
    () =>
      daytonaRunnerConfiguration({
        ...environment(),
        DAYTONA_REQUEST_TIMEOUT_MS: "120001",
      }),
    /DAYTONA_REQUEST_TIMEOUT_MS/u
  );
});

test("client construction accepts the same blank defaults as snapshot parsing", () => {
  const configured = daytonaRunnerConfiguration({
    ...environment(),
    DAYTONA_API_URL: " ",
    DAYTONA_TARGET: "",
  });
  const configurations: DaytonaConfig[] = [];

  daytonaClient(
    {
      ...environment(),
      DAYTONA_API_URL: " ",
      DAYTONA_TARGET: "",
    },
    (configuration) => {
      configurations.push(configuration);
      return {} as never;
    }
  );

  assert.equal(configured.apiUrl, "https://app.daytona.io/api");
  assert.equal(configured.target, "us");
  assert.deepEqual(configurations, [
    {
      apiKey: "test-daytona-key",
      apiUrl: configured.apiUrl,
      requestTimeoutMs: configured.requestTimeoutMs,
      target: configured.target,
    },
  ]);
});

test("Daytona client caches production construction and permits injected factories", () => {
  resetDaytonaClientForTest();
  let calls = 0;
  const configurations: DaytonaConfig[] = [];
  const factory = (configuration: DaytonaConfig) => {
    calls += 1;
    configurations.push(configuration);
    return { source: calls } as never;
  };
  const first = daytonaClient(environment(), factory);
  const second = daytonaClient(environment(), factory);

  assert.equal(calls, 2);
  assert.notEqual(first, second);
  assert.deepEqual(configurations[0], {
    apiKey: "test-daytona-key",
    apiUrl: "https://daytona.test/api",
    requestTimeoutMs: 30_000,
    target: "us",
  });

  resetDaytonaClientForTest();
  const cachedFirst = daytonaClient(environment());
  const cachedSecond = daytonaClient(environment());
  assert.equal(cachedFirst, cachedSecond);
  resetDaytonaClientForTest();
});
