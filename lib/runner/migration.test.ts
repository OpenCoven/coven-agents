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
  const journalEntry = journal.entries.find((entry) => entry.idx === 16);
  assert.deepEqual(journalEntry, {
    ...journalEntry,
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

test("generated migration 0017 persists the exact sandbox warm attempt version", () => {
  const directory = new URL("../db/migrations/", import.meta.url);
  const migrationName = readdirSync(directory).find((name) =>
    name.startsWith("0017_")
  );

  assert.ok(migrationName, "migration 0017 must exist");
  const migration = readFileSync(new URL(migrationName, directory), "utf8");
  assert.match(
    migration,
    /ADD COLUMN "warmAttemptVersion" integer DEFAULT 0 NOT NULL/
  );
  assert.match(migration, /RunnerAgent_warmAttemptVersion_nonnegative/);

  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", directory), "utf8")
  ) as { entries: { idx: number; tag: string }[] };
  const journalEntry = journal.entries.find((entry) => entry.idx === 17);
  assert.deepEqual(journalEntry, {
    ...journalEntry,
    idx: 17,
    tag: migrationName.replace(/\.sql$/u, ""),
  });

  const snapshot = readFileSync(
    new URL("meta/0017_snapshot.json", directory),
    "utf8"
  );
  assert.match(snapshot, /"warmAttemptVersion"/u);
});

test("generated migration 0018 indexes the independent stale warm recovery lane", () => {
  const directory = new URL("../db/migrations/", import.meta.url);
  const migrationName = readdirSync(directory).find((name) =>
    name.startsWith("0018_")
  );

  assert.ok(migrationName, "migration 0018 must exist");
  const migration = readFileSync(new URL(migrationName, directory), "utf8");
  assert.match(migration, /RunnerAgent_warm_recovery_idx/u);
  assert.match(migration, /"warmUpdatedAt","id"/u);
  assert.match(migration, /"sandboxLifecycle" = 'ready'/u);
  assert.match(migration, /"warmStatus" = 'provisioning'/u);

  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", directory), "utf8")
  ) as { entries: { idx: number; tag: string }[] };
  const journalEntry = journal.entries.find((entry) => entry.idx === 18);
  assert.deepEqual(journalEntry, {
    ...journalEntry,
    idx: 18,
    tag: migrationName.replace(/\.sql$/u, ""),
  });

  const snapshot = readFileSync(
    new URL("meta/0018_snapshot.json", directory),
    "utf8"
  );
  assert.match(snapshot, /"RunnerAgent_warm_recovery_idx"/u);
});

test("generated migration 0019 normalizes legacy agents before replacing the runtime constraint", () => {
  const directory = new URL("../db/migrations/", import.meta.url);
  const migrationName = readdirSync(directory).find((name) =>
    name.startsWith("0019_")
  );

  assert.ok(migrationName, "migration 0019 must exist");
  const migration = readFileSync(new URL(migrationName, directory), "utf8");
  const retiredRuntime = ["cl", "oud"].join("");
  const update = `UPDATE "RunnerAgent" SET "runtime" = 'copilot', "model" = CASE WHEN "model" IN ('auto', 'claude-sonnet-4.5', 'gpt-5', 'gpt-5-mini') THEN "model" ELSE 'auto' END WHERE "runtime" = '${retiredRuntime}'`;
  const drop = 'ALTER TABLE "RunnerAgent" DROP CONSTRAINT';

  assert.ok(migration.includes(update));
  assert.ok(migration.indexOf(update) < migration.indexOf(drop));
  assert.doesNotMatch(migration, /gpt-5\.1/u);
  assert.match(
    migration,
    /RunnerAgent_runtime_valid" CHECK \("RunnerAgent"\."runtime" in \('codex', 'claude', 'copilot'\)\)/u
  );

  const previousSnapshot = readFileSync(
    new URL("meta/0018_snapshot.json", directory),
    "utf8"
  );
  assert.match(
    previousSnapshot,
    /"RunnerAgent_runtime_valid"[\s\S]*?'cloud', 'codex', 'claude', 'copilot'/u,
    "the pre-migration schema must already accept the copilot target so old code can read migrated rows"
  );

  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", directory), "utf8")
  ) as { entries: { idx: number; tag: string }[] };
  const journalEntry = journal.entries.find((entry) => entry.idx === 19);
  assert.deepEqual(journalEntry, {
    ...journalEntry,
    idx: 19,
    tag: migrationName.replace(/\.sql$/u, ""),
  });

  const snapshot = readFileSync(
    new URL("meta/0019_snapshot.json", directory),
    "utf8"
  );
  const parsedSnapshot = JSON.parse(snapshot) as {
    tables: {
      "public.RunnerAgent": {
        checkConstraints: Record<string, { value: string }>;
      };
    };
  };
  assert.equal(
    parsedSnapshot.tables["public.RunnerAgent"].checkConstraints
      .RunnerAgent_runtime_valid?.value,
    `"RunnerAgent"."runtime" in ('codex', 'claude', 'copilot')`
  );
  assert.equal(snapshot.includes(`'${retiredRuntime}'`), false);
});
