import assert from "node:assert/strict";
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  latestSnapshotName,
  type Snapshot,
} from "../lib/github/migration-test-helpers";

async function driftGate() {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  );
  assert.match(manifest.scripts["db:check"], /scripts\/db-drift\.ts/u);
  assert.match(manifest.scripts.check, /pnpm db:check/u);
  return import("./db-drift");
}

test("DB-free drift gate leaves the real migration tree unchanged", async () => {
  const { verifyMigrationDrift } = await driftGate();
  const before = await readdir("lib/db/migrations", { recursive: true });
  await verifyMigrationDrift();
  assert.deepEqual(
    await readdir("lib/db/migrations", { recursive: true }),
    before
  );
});

for (const area of ["columns", "indexes", "foreignKeys"] as const) {
  test(`DB-free drift gate detects ${area} changes and cleans failed generation`, async () => {
    const { verifyMigrationDrift } = await driftGate();
    const directory = await mkdtemp(join(tmpdir(), "coven-drift-fixture-"));
    const migrationsFolder = join(directory, "migrations");
    try {
      await cp("lib/db/migrations", migrationsFolder, { recursive: true });
      const snapshotPath = join(migrationsFolder, await latestSnapshotName());
      const snapshot = JSON.parse(
        await readFile(snapshotPath, "utf8")
      ) as Snapshot;
      const removed = {
        columns: "providerRequestId",
        foreignKeys: "RunnerGitHubOperation_connection_fk",
        indexes: "RGHOp_status_updated_idx",
      }[area];
      Reflect.deleteProperty(
        snapshot.tables["public.RunnerGitHubOperation"][area],
        removed
      );
      await writeFile(snapshotPath, JSON.stringify(snapshot));
      await assert.rejects(
        verifyMigrationDrift({
          migrationsFolder,
          schemaPath: resolve("lib/db/schema.ts"),
          temporaryRoot: directory,
        }),
        /schema drift.*migration/iu
      );
      assert.deepEqual(await readdir(directory), ["migrations"]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
}
