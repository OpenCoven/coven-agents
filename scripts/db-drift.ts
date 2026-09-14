#!/usr/bin/env tsx
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { databaseCommand } from "./disposable-postgres";

export async function verifyMigrationDrift(
  options: Readonly<{
    migrationsFolder?: string;
    schemaPath?: string;
    temporaryRoot?: string;
  }> = {}
): Promise<void> {
  const directory = await mkdtemp(
    join(options.temporaryRoot ?? tmpdir(), "coven-db-drift-")
  );
  try {
    const output = join(directory, "migrations");
    await cp(options.migrationsFolder ?? "lib/db/migrations", output, {
      recursive: true,
    });
    const before = await readdir(output, { recursive: true });
    // Explicit CLI config avoids dotenv and needs no database connection.
    const generated = await databaseCommand("pnpm", [
      "exec",
      "drizzle-kit",
      "generate",
      "--dialect",
      "postgresql",
      "--schema",
      resolve(options.schemaPath ?? "lib/db/schema.ts"),
      "--out",
      relative(process.cwd(), output),
      "--name",
      "unexpected_drift",
    ]);
    const added = (await readdir(output, { recursive: true })).filter(
      (name) => !before.includes(name)
    );
    if (added.length > 0) {
      throw new Error(
        `Database schema drift requires a migration: ${added.join(", ")}. Run pnpm db:generate and review the forward migration.`
      );
    }
    if (!generated.includes("No schema changes, nothing to migrate")) {
      throw new Error(
        `Drizzle did not confirm a drift-free schema: ${generated}`
      );
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

if (process.argv[1]?.endsWith("db-drift.ts")) {
  verifyMigrationDrift().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
