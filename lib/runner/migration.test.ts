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

test("generated migration 0016 adds the fenced reconciliation lease consistently", () => {
  const directory = new URL("../db/migrations/", import.meta.url);
  const migrationName = readdirSync(directory).find((name) =>
    name.startsWith("0016_")
  );

  assert.ok(migrationName, "migration 0016 must exist");
  const migration = readFileSync(new URL(migrationName, directory), "utf8");
  assert.match(
    migration,
    /ADD COLUMN "reconciliationLeaseExpiresAt" timestamp/
  );
  assert.match(
    migration,
    /ADD COLUMN "reconciliationLeaseFence" bigint DEFAULT 0 NOT NULL/
  );
  assert.match(
    migration,
    /ADD COLUMN "reconciliationLeaseOwner" varchar\(128\)/
  );
  assert.match(
    migration,
    /RunnerScheduler_reconciliationLeaseFence_nonnegative/
  );
  assert.match(migration, /RunnerScheduler_reconciliationLease_pair/);

  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", directory), "utf8")
  ) as { entries: { idx: number; tag: string }[] };
  assert.deepEqual(journal.entries.at(-1), {
    ...journal.entries.at(-1),
    idx: 16,
    tag: migrationName.replace(/\.sql$/u, ""),
  });

  const snapshot = readFileSync(
    new URL("meta/0016_snapshot.json", directory),
    "utf8"
  );
  for (const field of [
    "reconciliationLeaseExpiresAt",
    "reconciliationLeaseFence",
    "reconciliationLeaseOwner",
  ]) {
    assert.match(snapshot, new RegExp(`"${field}"`, "u"));
  }
});
