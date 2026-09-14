#!/usr/bin/env tsx
import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { HARNESS_SPECS } from "@opencoven/harness";
import {
  applicationTableInventory,
  seedHermeticUsers,
} from "../tests/e2e/hermetic-db";
import {
  migrateDisposableDatabase,
  withDisposableDatabase,
} from "./disposable-postgres";

export {
  DOCKER_COMMAND_TIMEOUT_MS,
  dockerRunArguments,
  hermeticDatabaseUrl,
  mappedPort,
} from "./disposable-postgres";

export const PORT_ALLOCATION_TIMEOUT_MS = 5000;
const TEST_KEK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const HARNESS_AUTH_ENVIRONMENT_VARIABLES = [
  ...new Set(HARNESS_SPECS.flatMap((spec) => spec.authEnvVars)),
];
const EXAMPLE_ENVIRONMENT_VARIABLES = [
  "AI_GATEWAY_API_KEY",
  "AUTH_GITHUB_ID",
  "AUTH_GITHUB_SECRET",
  "AUTH_SECRET",
  "AUTH_URL",
  "ABUSE_CONTROL",
  "ABUSE_KEY_SECRET",
  "ADMIN_EMAILS",
  "APP_ORIGIN",
  "BETA_ALLOWLIST",
  "BETA_CAMPAIGN_ENABLED",
  "BETA_CAMPAIGN_GRANT_DAYS",
  "BETA_CAMPAIGN_MAX_ACCOUNTS",
  "BETA_CAMPAIGN_MINUTES",
  "BETA_CAMPAIGN_MIN_ACCOUNT_AGE_DAYS",
  "BETA_CAMPAIGN_RUN_MINUTES",
  "BETA_MODE",
  "BLOB_READ_WRITE_TOKEN",
  "CRON_SECRET",
  "CREDENTIAL_AAD_WRITES_ENABLED",
  "CREDENTIAL_KEK",
  "CREDENTIAL_KEK_CURRENT_VERSION",
  "CREDENTIAL_KEK_V1",
  "CREDENTIAL_KEK_V2",
  "DAYTONA_API_KEY",
  "DAYTONA_API_URL",
  "DAYTONA_AUTO_ARCHIVE_MINUTES",
  "DAYTONA_AUTO_STOP_MINUTES",
  "DAYTONA_DOMAIN_ALLOW_LIST",
  "DAYTONA_SNAPSHOT",
  "DAYTONA_TARGET",
  "DEMO_RECORDER_ACCOUNT_EMAIL",
  "DEMO_RECORDING_CREDENTIAL",
  "DEMO_RECORDING_TIMEOUT_MS",
  "GLOBAL_DAILY_RUN_CAP",
  "MINUTE_PACK_PRICES",
  "OPERATOR_DIAGNOSTIC_TOKEN",
  "POSTGRES_URL",
  "REDIS_URL",
  "RELEASE_AUDIENCE",
  "RUN_ADMISSION_CONSECUTIVE_MAX",
  "RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX",
  "RUN_ADMISSION_MODE",
  "RUN_ADMISSION_TENANT_ACTIVE_MAX",
  "RUN_ADMISSION_TENANT_QUEUE_MAX",
  "RUNNER_MANUAL_RECONCILE_SECRET",
  "STRIPE_PRICE_ID",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "SUBSCRIPTION_CHECKOUT_ENABLED",
] as const;
const EXTERNAL_ENVIRONMENT_PREFIXES = [
  "AI_",
  "ANTHROPIC_",
  "AWS_",
  "AZURE_",
  "BLOB_",
  "COHERE_",
  "CREDENTIAL_KEK",
  "DATABASE_",
  "DAYTONA_",
  "DEEPSEEK_",
  "E2E_",
  "FIREWORKS_",
  "GITHUB_",
  "GOOGLE_",
  "GROQ_",
  "MISTRAL_",
  "NEON_",
  "NEXT_PUBLIC_",
  "OPENAI_",
  "PERPLEXITY_",
  "PINECONE_",
  "POSTGRES_",
  "QDRANT_",
  "R2_",
  "REDIS_",
  "S3_",
  "STRIPE_",
  "SUPABASE_",
  "TOGETHER_",
  "TURSO_",
  "UPSTASH_",
  "VERCEL_",
  "WEAVIATE_",
  "XAI_",
] as const;

type Environment = Readonly<Record<string, string | undefined>>;
type PlaywrightChild = EventEmitter;

function localOrigin(port: number): string {
  return `http://localhost:${port}`;
}

function executable(name: string): string {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

export function explicitHermeticPort(
  environment: Environment = process.env
): number | undefined {
  const value = environment.E2E_HERMETIC_PORT;
  if (value === undefined) {
    return undefined;
  }
  if (!/^[1-9]\d{0,4}$/u.test(value)) {
    throw new Error(
      "E2E_HERMETIC_PORT must be a decimal loopback port from 1 through 65535."
    );
  }
  const port = Number(value);
  if (port > 65_535) {
    throw new Error(
      "E2E_HERMETIC_PORT must be a decimal loopback port from 1 through 65535."
    );
  }
  return port;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function unavailablePortError(
  requestedPort: number,
  host: string,
  cause: unknown
): Error {
  return new Error(
    requestedPort
      ? `E2E_HERMETIC_PORT ${requestedPort} is unavailable on ${host}.`
      : "Could not allocate a free hermetic loopback port.",
    { cause }
  );
}

async function closeServer(
  server: ReturnType<typeof createServer>
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (errorCode(error) === "ERR_SERVER_NOT_RUNNING") {
        resolve();
        return;
      }
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function listenOnLoopback(
  server: ReturnType<typeof createServer>,
  host: string,
  port: number,
  deadline: number
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    };
    timeout = setTimeout(
      () => {
        server.off("error", onError);
        reject(
          new Error(
            `Timed out while reserving hermetic loopback port ${port || "automatically"}.`
          )
        );
      },
      Math.max(1, deadline - Date.now())
    );
    server.once("error", onError);
    server.listen({ host, ipv6Only: host === "::1", port }, () => {
      clearTimeout(timeout);
      server.off("error", onError);
      resolve();
    });
  });
}

async function bindAvailableLoopbackPort(
  requestedPort: number
): Promise<number> {
  const deadline = Date.now() + PORT_ALLOCATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ipv4 = createServer();
    const ipv6 = createServer();
    try {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: Retry only after releasing a port unavailable on IPv6.
        await listenOnLoopback(ipv4, "127.0.0.1", requestedPort, deadline);
      } catch (error) {
        throw unavailablePortError(requestedPort, "127.0.0.1", error);
      }
      const address = ipv4.address();
      if (!address || typeof address === "string" || address.port < 1) {
        throw new Error("Could not allocate a usable hermetic loopback port.");
      }
      const { port } = address;
      try {
        await listenOnLoopback(ipv6, "::1", port, deadline);
      } catch (error) {
        if (errorCode(error) === "EAFNOSUPPORT") {
          return port;
        }
        if (!requestedPort && errorCode(error) === "EADDRINUSE") {
          continue;
        }
        throw unavailablePortError(requestedPort, "::1", error);
      }
      return port;
    } finally {
      await Promise.all([closeServer(ipv4), closeServer(ipv6)]);
    }
  }
  throw new Error("Could not allocate a free hermetic loopback port.");
}

export function allocateHermeticPort(
  environment: Environment = process.env
): Promise<number> {
  return bindAvailableLoopbackPort(explicitHermeticPort(environment) ?? 0);
}

function isExternalEnvironmentVariable(name: string): boolean {
  return EXTERNAL_ENVIRONMENT_PREFIXES.some((prefix) =>
    name.startsWith(prefix)
  );
}

export function hermeticEnvironment(
  url: string,
  inherited: Environment = process.env,
  port = 3100
): NodeJS.ProcessEnv {
  const environment = { ...inherited } as NodeJS.ProcessEnv;
  for (const name of Object.keys(environment)) {
    if (isExternalEnvironmentVariable(name)) {
      environment[name] = "";
    }
  }
  for (const name of EXAMPLE_ENVIRONMENT_VARIABLES) {
    environment[name] = "";
  }
  for (const name of HARNESS_AUTH_ENVIRONMENT_VARIABLES) {
    environment[name] = "";
  }
  const origin = localOrigin(port);
  return {
    ...environment,
    ABUSE_CONTROL: "",
    ABUSE_KEY_SECRET: "test-hermetic-abuse",
    APP_ORIGIN: origin,
    AUTH_SECRET: "test-hermetic-auth",
    AUTH_URL: origin,
    COVEN_HERMETIC_RUNNER: "1",
    CREDENTIAL_KEK_CURRENT_VERSION: "v1",
    CREDENTIAL_KEK_V1: TEST_KEK,
    CRON_SECRET: "test-hermetic-cron",
    E2E_HERMETIC_RUNNER: "1",
    GLOBAL_DAILY_RUN_CAP: "1500",
    IS_DEMO: "",
    NEXT_TELEMETRY_DISABLED: "1",
    NEXTAUTH_URL: origin,
    NODE_ENV: "development",
    OPERATOR_DIAGNOSTIC_TOKEN: "test-hermetic-diagnostic",
    PORT: String(port),
    POSTGRES_URL: url,
    REDIS_URL: "",
    RUN_ADMISSION_CONSECUTIVE_MAX: "2",
    RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX: "25",
    RUN_ADMISSION_MODE: "queue",
    RUN_ADMISSION_TENANT_ACTIVE_MAX: "2",
    RUN_ADMISSION_TENANT_QUEUE_MAX: "10",
    RUNNER_ATTEMPT_LEASE_MS: "",
    RUNNER_LIVE_TAIL_MS: "",
    RUNNER_LIVE_VIEW: "",
    RUNNER_MANUAL_RECONCILE_SECRET: "test-hermetic-manual",
  };
}

export function waitForPlaywrightExit(
  file: string,
  child: PlaywrightChild
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Focused Playwright test ${file} failed${signal ? ` from ${signal}` : ` with exit code ${code ?? "unknown"}`}; its output is shown above.`
        )
      );
    });
  });
}

async function playwright(
  file: string,
  environment: NodeJS.ProcessEnv
): Promise<void> {
  const child = spawn(
    executable("pnpm"),
    ["exec", "playwright", "test", file, "--project=e2e", "--workers=1"],
    {
      detached: false,
      env: environment,
      stdio: "inherit",
    }
  );
  let childExited = child.exitCode !== null || child.signalCode !== null;
  const markChildExited = () => {
    childExited = true;
  };
  const forwardSignal = (signal: NodeJS.Signals) => {
    if (!childExited) {
      child.kill(signal);
    }
  };

  child.once("exit", markChildExited);
  process.on("SIGINT", forwardSignal);
  process.on("SIGTERM", forwardSignal);
  try {
    await waitForPlaywrightExit(file, child);
  } finally {
    process.off("SIGINT", forwardSignal);
    process.off("SIGTERM", forwardSignal);
    child.off("exit", markChildExited);
  }
}

async function removePlaywrightArtifacts(): Promise<void> {
  await Promise.all(
    ["playwright-report", "test-results"].map(async (path) =>
      rm(path, { force: true, recursive: true })
    )
  );
}

export async function runHermeticE2E(
  environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
  await withDisposableDatabase(environment, async (url) => {
    try {
      await migrateDisposableDatabase(
        url,
        hermeticEnvironment(url, environment)
      );
      await seedHermeticUsers(url);
      // Allocate immediately before Playwright starts its owned web server, which
      // minimizes the unavoidable release-to-bind race for a dynamically chosen port.
      const port = await allocateHermeticPort(environment);
      const testEnvironment = hermeticEnvironment(url, environment, port);
      await playwright("tests/e2e/chat.test.ts", testEnvironment);
      await playwright(
        "tests/e2e/subscriber-hermetic.test.ts",
        testEnvironment
      );
      await seedHermeticUsers(url);
      await playwright(
        "tests/e2e/session-revocation-hermetic.test.ts",
        testEnvironment
      );

      const beforeDemo = await applicationTableInventory(url);
      await playwright("tests/e2e/demo.test.ts", {
        ...testEnvironment,
        IS_DEMO: "1",
      });
      const afterDemo = await applicationTableInventory(url);
      if (JSON.stringify(beforeDemo) !== JSON.stringify(afterDemo)) {
        throw new Error(
          "Anonymous demo replay wrote to the hermetic database."
        );
      }

      await playwright("tests/e2e/session-revocation-hermetic.test.ts", {
        ...testEnvironment,
        IS_DEMO: "1",
      });

      const beforeAdversarial = await applicationTableInventory(url);
      await playwright("tests/e2e/demo-adversarial.test.ts", testEnvironment);
      const afterAdversarial = await applicationTableInventory(url);
      if (
        JSON.stringify(beforeAdversarial) !== JSON.stringify(afterAdversarial)
      ) {
        throw new Error(
          "Anonymous adversarial demo probes wrote to the hermetic database."
        );
      }
    } finally {
      await removePlaywrightArtifacts();
    }
  });
}

async function main(): Promise<void> {
  try {
    await runHermeticE2E();
    process.stdout.write("Hermetic browser certification passed.\n");
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Hermetic browser certification failed."}\n`
    );
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("e2e-hermetic.ts")) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Hermetic browser certification failed."}\n`
    );
    process.exitCode = 1;
  });
}
