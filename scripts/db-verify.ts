#!/usr/bin/env tsx
import {
  databaseCommand,
  migrateDisposableDatabase,
  withDisposableDatabase,
} from "./disposable-postgres";

export async function runDatabaseVerification(
  environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    await withDisposableDatabase(environment, async (url) => {
      controller.signal.throwIfAborted();
      await migrateDisposableDatabase(url, environment, controller.signal);
      const output = await databaseCommand(
        "pnpm",
        [
          "exec",
          "tsx",
          "--conditions=react-server",
          "--test",
          "--test-reporter=tap",
          "lib/db/minute-pack-postgres.test.ts",
          "lib/db/owner-credential-postgres.test.ts",
          "lib/db/owner-credential-http-postgres.test.ts",
          "lib/db/run-reservation-postgres.test.ts",
          "lib/db/sandbox-binding-postgres.test.ts",
          "lib/db/stripe-reconciliation-postgres.test.ts",
          "lib/github/postgres-lifecycle.test.ts",
          "lib/runner/sandbox-binding-postgres.test.ts",
        ],
        {
          env: {
            ...environment,
            COVEN_HERMETIC_RUNNER: "1",
            GITHUB_TOOL_POSTGRES_TEST_REQUIRED: "1",
            GITHUB_TOOL_POSTGRES_TEST_URL: url,
            MINUTE_PACK_POSTGRES_TEST_URL: url,
            NODE_TEST_CONTEXT: undefined,
            OWNER_CREDENTIAL_TEST_URL: url,
            POSTGRES_URL: url,
            RUN_RESERVATION_POSTGRES_TEST_URL: url,
            RUN_SANDBOX_BINDING_POSTGRES_TEST_REQUIRED: "1",
            RUN_SANDBOX_BINDING_POSTGRES_TEST_URL: url,
            SANDBOX_BINDING_POSTGRES_TEST_URL: url,
            STRIPE_RECONCILIATION_POSTGRES_TEST_URL: url,
          },
          signal: controller.signal,
        }
      );
      process.stdout.write(output);
      const count = Number(/^# tests (\d+)$/mu.exec(output)?.[1]);
      const passed = Number(/^# pass (\d+)$/mu.exec(output)?.[1]);
      const skipped = Number(/^# skipped (\d+)$/mu.exec(output)?.[1]);
      if (!(count > 0 && passed === count && skipped === 0)) {
        throw new Error(
          "PostgreSQL lifecycle gate requires passing tests with zero skips."
        );
      }
    });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

if (process.argv[1]?.endsWith("db-verify.ts")) {
  runDatabaseVerification().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
