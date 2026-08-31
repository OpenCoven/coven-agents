import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

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

test("migration 0021 is immutable and planned child reservations advance through 0022", () => {
  const directory = new URL("../db/migrations/", import.meta.url);
  const migration21 = readFileSync(
    new URL("0021_salty_the_stranger.sql", directory),
    "utf8"
  );
  const snapshot21 = readFileSync(
    new URL("meta/0021_snapshot.json", directory),
    "utf8"
  );
  assert.equal(
    sha256(migration21),
    "70d3f8a15cf5fb0d9742846696d76b5d48b9b077e0f5ad6c3840e80045cb6c35"
  );
  assert.equal(
    sha256(snapshot21),
    "f88d1d1be4e466b1e04d881e07307ec5a3814ca2140a0115bac114e5570231bc"
  );

  const migrationName22 = readdirSync(directory).find((name) =>
    name.startsWith("0022_")
  );
  assert.ok(
    migrationName22,
    "planned child reservations require migration 0022"
  );
  const migration22 = readFileSync(new URL(migrationName22, directory), "utf8");
  assert.match(migration22, /ADD COLUMN "plannedOperationId" uuid/u);
  assert.match(migration22, /ADD COLUMN "plannedRunnerRunId" uuid/u);
  assert.match(migration22, /RTStep_plannedOperation_uq/u);
  assert.match(migration22, /RTStep_plannedRunnerRun_uq/u);
  assert.match(migration22, /RTStep_childReservation_valid/u);
  assert.doesNotMatch(
    migration22,
    /createdByUserId|authVersion|agentInstructions|approvalActorUserId/u
  );

  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", directory), "utf8")
  ) as { entries: { idx: number; tag: string }[] };
  assert.equal(
    journal.entries.find((entry) => entry.idx === 21)?.tag,
    "0021_salty_the_stranger"
  );
  assert.equal(
    journal.entries.find((entry) => entry.idx === 22)?.tag,
    migrationName22.replace(/\.sql$/u, "")
  );

  const snapshot22 = readFileSync(
    new URL("meta/0022_snapshot.json", directory),
    "utf8"
  );
  assert.match(snapshot22, /"plannedOperationId"/u);
  assert.match(snapshot22, /"plannedRunnerRunId"/u);
  assert.match(snapshot22, /"RTStep_childReservation_valid"/u);
});
