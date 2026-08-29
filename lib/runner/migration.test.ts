import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

test("migration 0015 adds nullable fail-closed run authority without a default", () => {
  const directory = new URL("../db/migrations/", import.meta.url);
  const migrationName = readdirSync(directory).find((name) =>
    name.startsWith("0015_")
  );

  assert.ok(migrationName, "migration 0015 must exist");
  const migration = readFileSync(new URL(migrationName, directory), "utf8");
  assert.match(
    migration,
    /ALTER TABLE "RunnerRun" ADD COLUMN "authVersion" integer/
  );
  assert.doesNotMatch(migration, /"authVersion"[^;]*DEFAULT/i);
  assert.match(migration, /RunnerRun_authVersion_valid/);
  assert.match(
    migration,
    /"RunnerRun"\."authVersion" is null or "RunnerRun"\."authVersion" >= 0/i
  );
});
