#!/usr/bin/env tsx
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import {
  applicationTableInventory,
  seedHermeticUsers,
} from "../tests/e2e/hermetic-db";

const executeFile = promisify(execFile);
const COMMAND_TIMEOUT_MS = 120_000;
const DATABASE_READY_TIMEOUT_MS = 30_000;
const POSTGRES_IMAGE = "postgres:16-alpine";
const POSTGRES_DATABASE = "coven_hermetic_e2e";
const POSTGRES_PASSWORD = "test-hermetic-postgres";
const POSTGRES_USER = "postgres";
const TEST_KEK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

type CommandOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  timeout?: number;
}>;

function executable(name: string): string {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

async function command(
  binary: string,
  args: readonly string[],
  options: CommandOptions = {}
): Promise<string> {
  try {
    const result = await executeFile(binary, [...args], {
      encoding: "utf8",
      env: options.env,
      maxBuffer: 1024 * 1024,
      timeout: options.timeout ?? COMMAND_TIMEOUT_MS,
    });
    return result.stdout;
  } catch (error) {
    throw new Error(
      `Hermetic E2E command failed: ${binary} ${args[0] ?? ""}.`,
      { cause: error }
    );
  }
}

function containerName(random = () => randomBytes(8).toString("hex")): string {
  return `coven-hermetic-e2e-${process.pid}-${random()}`;
}

export function dockerRunArguments(name: string): readonly string[] {
  return [
    "run",
    "--detach",
    "--name",
    name,
    "--env",
    `POSTGRES_DB=${POSTGRES_DATABASE}`,
    "--env",
    `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
    "--env",
    `POSTGRES_USER=${POSTGRES_USER}`,
    "--publish",
    "127.0.0.1::5432",
    POSTGRES_IMAGE,
  ];
}

function postgresUrl(port: number): string {
  return `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${port}/${POSTGRES_DATABASE}`;
}

export function mappedPort(output: string): number {
  const match = /:(\d+)\s*$/u.exec(output.trim());
  const port = Number(match?.[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Docker returned no usable mapped PostgreSQL port.");
  }
  return port;
}

async function waitForPostgres(name: string): Promise<void> {
  const deadline = Date.now() + DATABASE_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Readiness checks must be sequential and bounded.
      await command(
        "docker",
        [
          "exec",
          name,
          "pg_isready",
          "--username",
          POSTGRES_USER,
          "--dbname",
          POSTGRES_DATABASE,
        ],
        { timeout: 5000 }
      );
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(
    "Disposable PostgreSQL did not become ready within the bounded timeout."
  );
}

export function hermeticEnvironment(
  url: string,
  inherited: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...inherited,
    ABUSE_CONTROL: undefined,
    ABUSE_KEY_SECRET: "test-hermetic-abuse",
    APP_ORIGIN: "http://localhost:3100",
    AUTH_SECRET: "test-hermetic-auth",
    AUTH_URL: "http://localhost:3100",
    COVEN_HERMETIC_RUNNER: "1",
    CREDENTIAL_KEK: undefined,
    CREDENTIAL_KEK_CURRENT_VERSION: "v1",
    CREDENTIAL_KEK_V1: TEST_KEK,
    CREDENTIAL_KEK_V2: undefined,
    CRON_SECRET: "test-hermetic-cron",
    E2E_HERMETIC_RUNNER: "1",
    E2E_PRODUCTION: undefined,
    GLOBAL_DAILY_RUN_CAP: "100",
    IS_DEMO: undefined,
    NEXT_TELEMETRY_DISABLED: "1",
    NEXTAUTH_URL: "http://localhost:3100",
    NODE_ENV: "development",
    OPERATOR_DIAGNOSTIC_TOKEN: "test-hermetic-diagnostic",
    PORT: "3100",
    POSTGRES_URL: url,
    REDIS_URL: undefined,
    RUN_ADMISSION_CONSECUTIVE_MAX: "2",
    RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX: "25",
    RUN_ADMISSION_MODE: "queue",
    RUN_ADMISSION_TENANT_ACTIVE_MAX: "2",
    RUN_ADMISSION_TENANT_QUEUE_MAX: "10",
    RUNNER_MANUAL_RECONCILE_SECRET: "test-hermetic-manual",
  };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("DAYTONA_")) {
      environment[name] = undefined;
    }
  }
  return environment;
}

async function migrate(
  url: string,
  environment: NodeJS.ProcessEnv
): Promise<void> {
  await command(executable("pnpm"), ["exec", "tsx", "lib/db/migrate.ts"], {
    env: hermeticEnvironment(url, environment),
  });
}

async function playwright(
  file: string,
  environment: NodeJS.ProcessEnv
): Promise<void> {
  await command(
    executable("pnpm"),
    ["exec", "playwright", "test", file, "--project=e2e", "--workers=1"],
    { env: environment, timeout: COMMAND_TIMEOUT_MS }
  );
}

async function removePlaywrightArtifacts(): Promise<void> {
  await Promise.all(
    ["playwright-report", "test-results"].map(async (path) =>
      rm(path, { force: true, recursive: true })
    )
  );
}

async function createDisposableDatabase(
  environment: NodeJS.ProcessEnv
): Promise<Readonly<{ cleanup: () => Promise<void>; url: string }>> {
  const external = environment.E2E_POSTGRES_URL?.trim();
  if (external) {
    if (environment.E2E_POSTGRES_DISPOSABLE !== "1") {
      throw new Error(
        "E2E_POSTGRES_URL requires E2E_POSTGRES_DISPOSABLE=1; refusing an unconfirmed database."
      );
    }
    return { cleanup: async () => undefined, url: external };
  }

  const name = containerName();
  try {
    await command("docker", dockerRunArguments(name), { timeout: 30_000 });
  } catch (error) {
    throw new Error(
      "Could not start disposable PostgreSQL. Ensure Docker is running and postgres:16-alpine is available.",
      { cause: error }
    );
  }
  try {
    await waitForPostgres(name);
    const output = await command("docker", ["port", name, "5432/tcp"]);
    return {
      cleanup: async () => {
        await command("docker", ["rm", "--force", name]);
      },
      url: postgresUrl(mappedPort(output)),
    };
  } catch (error) {
    try {
      await command("docker", ["rm", "--force", name]);
    } catch {
      // A failed cleanup must not replace the actionable start-up error.
    }
    throw error;
  }
}

export async function runHermeticE2E(
  environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const database = await createDisposableDatabase(environment);
  try {
    const testEnvironment = hermeticEnvironment(database.url, environment);
    await migrate(database.url, environment);
    await seedHermeticUsers(database.url);
    await playwright("tests/e2e/subscriber-hermetic.test.ts", testEnvironment);

    const beforeDemo = await applicationTableInventory(database.url);
    await playwright("tests/e2e/demo.test.ts", {
      ...testEnvironment,
      IS_DEMO: "1",
    });
    const afterDemo = await applicationTableInventory(database.url);
    if (JSON.stringify(beforeDemo) !== JSON.stringify(afterDemo)) {
      throw new Error("Anonymous demo replay wrote to the hermetic database.");
    }
  } finally {
    await removePlaywrightArtifacts();
    await database.cleanup();
  }
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
