import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import postgres from "postgres";

const executeFile = promisify(execFile);
export const DOCKER_COMMAND_TIMEOUT_MS = 10_000;
const DATABASE_READY_TIMEOUT_MS = 30_000;
const POSTGRES_DATABASE = "coven_hermetic_e2e";
const POSTGRES_PASSWORD = "test-hermetic-postgres";
const POSTGRES_USER = "postgres";

type DisposableDatabase = Readonly<{
  cleanup: () => Promise<void>;
  url: string;
}>;

export async function databaseCommand(
  binary: string,
  args: readonly string[],
  options: Readonly<{
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeout?: number;
  }> = {}
): Promise<string> {
  const result = await executeFile(
    process.platform === "win32" ? `${binary}.cmd` : binary,
    [...args],
    {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
      ...options,
    }
  );
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  return result.stdout;
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
    "postgres:16-alpine",
  ];
}

export function hermeticDatabaseUrl(value: string): string {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("Disposable database URL must use PostgreSQL.");
  }
  if (decodeURIComponent(url.username).includes("\0")) {
    throw new Error(
      "Disposable database URL username cannot contain a startup delimiter."
    );
  }
  for (const [name, parameter] of url.searchParams) {
    if (["database", "dbname", "db"].includes(name.toLowerCase())) {
      throw new Error(
        "Disposable database URL query cannot override database selection."
      );
    }
    // postgres.js forwards query extras into NUL-delimited startup fields.
    if (name.includes("\0") || parameter.includes("\0")) {
      throw new Error(
        "Disposable database URL query cannot contain a startup delimiter."
      );
    }
  }
  const existingOptions = url.searchParams.getAll("options").at(-1)?.trim();
  url.searchParams.set(
    "options",
    [existingOptions, "-c search_path=public", "-c timezone=UTC"]
      .filter(Boolean)
      .join(" ")
  );
  return url.toString();
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
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: bounded sequential readiness probe.
      await databaseCommand(
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
        { timeout: DOCKER_COMMAND_TIMEOUT_MS }
      );
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(
    "Disposable PostgreSQL did not become ready within the bounded timeout.",
    {
      cause: lastError,
    }
  );
}

async function createChildDatabase(
  external: string
): Promise<DisposableDatabase> {
  const admin = postgres(hermeticDatabaseUrl(external), {
    connect_timeout: 10,
    max: 1,
  });
  const name = `coven_test_${process.pid}_${randomBytes(8).toString("hex")}`;
  try {
    await admin`CREATE DATABASE ${admin(name)}`;
  } finally {
    await admin.end();
  }
  const url = new URL(hermeticDatabaseUrl(external));
  url.pathname = `/${name}`;
  return {
    cleanup: async () => {
      const connection = postgres(hermeticDatabaseUrl(external), {
        connect_timeout: 10,
        max: 1,
      });
      try {
        // Only this invocation's generated name can reach DROP DATABASE.
        await connection`DROP DATABASE ${connection(name)} WITH (FORCE)`;
      } finally {
        await connection.end();
      }
    },
    url: url.toString(),
  };
}

export async function createDisposableDatabase(
  environment: NodeJS.ProcessEnv
): Promise<DisposableDatabase> {
  const external = environment.E2E_POSTGRES_URL?.trim();
  if (external) {
    if (environment.E2E_POSTGRES_DISPOSABLE !== "1") {
      throw new Error(
        "E2E_POSTGRES_URL requires E2E_POSTGRES_DISPOSABLE=1; refusing an unconfirmed database."
      );
    }
    return createChildDatabase(external);
  }

  const name = `coven-hermetic-e2e-${process.pid}-${randomBytes(8).toString("hex")}`;
  const options = { timeout: DOCKER_COMMAND_TIMEOUT_MS };
  await databaseCommand("docker", ["info"], options);
  const cleanup = async () => {
    await databaseCommand("docker", ["rm", "--force", name], options);
  };
  try {
    await databaseCommand("docker", dockerRunArguments(name), options);
    await waitForPostgres(name);
    const output = await databaseCommand(
      "docker",
      ["port", name, "5432/tcp"],
      options
    );
    return {
      cleanup,
      url: hermeticDatabaseUrl(
        `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${mappedPort(output)}/${POSTGRES_DATABASE}`
      ),
    };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      // biome-ignore lint/style/useErrorCause: AggregateError retains both failures and the cleanup cause.
      throw new AggregateError(
        [error, cleanupError],
        "Disposable PostgreSQL startup and cleanup failed.",
        { cause: cleanupError }
      );
    }
    throw error;
  }
}

export async function withDisposableDatabase<T>(
  environment: NodeJS.ProcessEnv,
  run: (url: string) => Promise<T>
): Promise<T> {
  const database = await createDisposableDatabase(environment);
  let result: T;
  try {
    result = await run(database.url);
  } catch (error) {
    try {
      await database.cleanup();
    } catch (cleanupError) {
      // biome-ignore lint/style/useErrorCause: AggregateError retains both failures with the callback as primary cause.
      throw new AggregateError(
        [error, cleanupError],
        "Disposable PostgreSQL callback and cleanup failed.",
        { cause: error }
      );
    }
    throw error;
  }
  await database.cleanup();
  return result;
}

export async function migrateDisposableDatabase(
  url: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<void> {
  await databaseCommand(
    "pnpm",
    ["exec", "tsx", "lib/db/migrate.ts", "--strict"],
    {
      env: { ...environment, COVEN_HERMETIC_RUNNER: "1", POSTGRES_URL: url },
      signal,
    }
  );
}
