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

test("migration 0028 backfills only the latest matching subscription override audit before constraining its marker", () => {
  const directory = new URL("../db/migrations/", import.meta.url);
  const migrationName = readdirSync(directory).find((name) =>
    name.startsWith("0028_")
  );
  assert.ok(migrationName, "migration 0028 must exist");
  const migration = readFileSync(new URL(migrationName, directory), "utf8");
  const update = 'UPDATE "User" AS "user"';
  const constraint =
    'ALTER TABLE "User" ADD CONSTRAINT "User_subscriptionOverride_shape"';

  assert.match(
    migration,
    /SELECT DISTINCT ON \("userId"\)[\s\S]*FROM "SubscriptionOverrideAudit"[\s\S]*ORDER BY "userId", "createdAt" DESC, "id" DESC/u
  );
  assert.match(
    migration,
    /SET "subscriptionOverrideAction" = "audit"\."action",\s+"subscriptionOverrideAt" = "audit"\."createdAt"/u
  );
  assert.match(
    migration,
    /"user"\."authVersion" = "audit"\."newAuthVersion"[\s\S]*"user"\."subscribedUntil" IS NOT DISTINCT FROM "audit"\."newSubscribedUntil"/u
  );
  assert.ok(migration.indexOf(update) < migration.indexOf(constraint));
  assert.doesNotMatch(migration, /\bemail\b/iu);
});

test("migration 0026 adds nullable, strict execution provenance without history rewrites", () => {
  const migrationDirectory = new URL("../db/migrations/", import.meta.url);
  const provenanceMigrationName = readdirSync(migrationDirectory).find((name) =>
    name.startsWith("0026_")
  );
  assert.ok(
    provenanceMigrationName,
    "execution provenance requires migration 0026"
  );
  const provenanceMigration = readFileSync(
    new URL(provenanceMigrationName, migrationDirectory),
    "utf8"
  );

  assert.match(
    provenanceMigration,
    /ALTER TABLE "RunnerRun" ADD COLUMN "executionProvenance" jsonb/u
  );
  assert.match(provenanceMigration, /RunnerRun_executionProvenance_valid/u);
  assert.match(
    provenanceMigration,
    /productExecutionClass.*provider.*pinnedSnapshot/u
  );
  assert.match(provenanceMigration, /"executionProvenance" is null/u);
  assert.doesNotMatch(
    provenanceMigration,
    /"executionProvenance"[^;]*DEFAULT/iu
  );
  assert.doesNotMatch(provenanceMigration, /UPDATE "RunnerRun"/u);
  assert.doesNotMatch(provenanceMigration, /apiKey|apiUrl|secret|token/iu);

  const provenanceJournal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", migrationDirectory), "utf8")
  ) as { entries: { idx: number; tag: string }[] };
  const provenanceEntry = provenanceJournal.entries.find(
    (candidate) => candidate.idx === 26
  );
  assert.deepEqual(provenanceEntry, {
    ...provenanceEntry,
    idx: 26,
    tag: provenanceMigrationName.replace(/\.sql$/u, ""),
  });

  const provenanceSnapshot = readFileSync(
    new URL("meta/0026_snapshot.json", migrationDirectory),
    "utf8"
  );
  assert.match(provenanceSnapshot, /"executionProvenance"/u);
  assert.match(provenanceSnapshot, /RunnerRun_executionProvenance_valid/u);
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

test("billing migration 0021 stays immutable and team migrations advance through 0023", () => {
  const directory = new URL("../db/migrations/", import.meta.url);
  const migrationNames = readdirSync(directory);
  assert.deepEqual(
    migrationNames.filter((name) => name.startsWith("0021_")),
    ["0021_lovely_loners.sql"],
    "billing migration 0021 must remain the only migration at position 21"
  );

  const migration21 = readFileSync(
    new URL("0021_lovely_loners.sql", directory),
    "utf8"
  );
  const snapshot21 = readFileSync(
    new URL("meta/0021_snapshot.json", directory),
    "utf8"
  );
  assert.equal(
    sha256(migration21),
    "76ad7a4b2c322498eda12b7397ab52c5027e17ed9a4eb3ef81333020a056bdb0"
  );
  assert.equal(
    sha256(snapshot21),
    "09c44b63ee96620f880411b50b0a86160a2cb63290f9690be665579022e27faf"
  );

  const migration22 = readFileSync(
    new URL("0022_salty_the_stranger.sql", directory),
    "utf8"
  );
  assert.match(
    migration22,
    /0022 cannot reconstruct initiating authority for existing team runs/u
  );
  assert.match(migration22, /ADD COLUMN "createdByUserId" uuid/u);
  assert.match(migration22, /ADD COLUMN "authVersion" integer/u);
  assert.match(migration22, /ADD COLUMN "agentInstructions" varchar\(12000\)/u);
  assert.match(migration22, /ADD COLUMN "approvalActorUserId" uuid/u);
  assert.match(migration22, /UPDATE "RunnerRun" AS "run"/u);
  assert.match(migration22, /UPDATE "RunnerTeamStep" AS "step"/u);
  assert.doesNotMatch(migration22, /plannedOperationId|plannedRunnerRunId/u);
  assert.doesNotMatch(migration22, /StripeReconciliation/u);

  const migration23 = readFileSync(
    new URL("0023_jittery_cardiac.sql", directory),
    "utf8"
  );
  assert.match(migration23, /ADD COLUMN "plannedOperationId" uuid/u);
  assert.match(migration23, /ADD COLUMN "plannedRunnerRunId" uuid/u);
  assert.match(migration23, /RTStep_plannedOperation_uq/u);
  assert.match(migration23, /RTStep_plannedRunnerRun_uq/u);
  assert.match(migration23, /RTStep_childReservation_valid/u);
  assert.doesNotMatch(
    migration23,
    /createdByUserId|authVersion|agentInstructions|approvalActorUserId|StripeReconciliation/u
  );

  const journalSource = readFileSync(
    new URL("meta/_journal.json", directory),
    "utf8"
  );
  const authoritativeJournalEntry21 = `    {
      "idx": 21,
      "version": "7",
      "when": 1788180027719,
      "tag": "0021_lovely_loners",
      "breakpoints": true
    }`;
  assert.ok(
    journalSource.includes(authoritativeJournalEntry21),
    "the billing 0021 journal entry must remain byte-for-byte authoritative"
  );
  const journal = JSON.parse(journalSource) as {
    entries: { idx: number; tag: string }[];
  };
  assert.deepEqual(
    journal.entries.slice(21, 24).map(({ idx, tag }) => ({ idx, tag })),
    [
      { idx: 21, tag: "0021_lovely_loners" },
      { idx: 22, tag: "0022_salty_the_stranger" },
      { idx: 23, tag: "0023_jittery_cardiac" },
    ]
  );

  const parsedSnapshots = [21, 22, 23].map((index) =>
    JSON.parse(
      readFileSync(new URL(`meta/00${index}_snapshot.json`, directory), "utf8")
    )
  ) as { id: string; prevId: string }[];
  assert.equal(parsedSnapshots[1]?.prevId, parsedSnapshots[0]?.id);
  assert.equal(parsedSnapshots[2]?.prevId, parsedSnapshots[1]?.id);

  const snapshot22 = readFileSync(
    new URL("meta/0022_snapshot.json", directory),
    "utf8"
  );
  assert.match(snapshot22, /"agentInstructions"/u);
  assert.match(snapshot22, /"approvalActorUserId"/u);
  assert.doesNotMatch(snapshot22, /"plannedOperationId"|"plannedRunnerRunId"/u);

  const snapshot23 = readFileSync(
    new URL("meta/0023_snapshot.json", directory),
    "utf8"
  );
  assert.match(snapshot23, /"plannedOperationId"/u);
  assert.match(snapshot23, /"plannedRunnerRunId"/u);
  assert.match(snapshot23, /"RTStep_childReservation_valid"/u);
});

test("migration 0024 adds fail-closed runner execution permission after existing history", () => {
  const directory = new URL("../db/migrations/", import.meta.url);
  const migrationNames = readdirSync(directory);
  const migrationName = migrationNames.find((name) => name.startsWith("0024_"));
  assert.ok(
    migrationName,
    "runner execution permission requires migration 0024"
  );

  const migration = readFileSync(new URL(migrationName, directory), "utf8");
  const addNullable = 'ADD COLUMN "executionPermission" varchar(32);';
  const rejectUnsafe = "0024 cannot safely migrate live team children";
  const backfillTeam = 'UPDATE "RunnerRun" AS "run"';
  const backfillOrdinary =
    'UPDATE "RunnerRun" SET "executionPermission" = \'unrestricted\'';
  const setDefault =
    'ALTER TABLE "RunnerRun" ALTER COLUMN "executionPermission" SET DEFAULT \'unrestricted\'';
  const setNotNull =
    'ALTER TABLE "RunnerRun" ALTER COLUMN "executionPermission" SET NOT NULL';
  assert.ok(migration.includes(addNullable));
  assert.match(migration, new RegExp(rejectUnsafe, "u"));
  assert.match(
    migration,
    /CREATE TRIGGER "RunnerRun_team_execution_permission_guard"/u
  );
  assert.match(
    migration,
    /NEW\."executionPermission" IS NULL[\s\S]*NEW\."executionPermission" = 'unrestricted'[\s\S]*RAISE EXCEPTION/u
  );
  assert.match(migration, /NEW\."executionPermission" <> "teamPermission"/u);
  assert.match(migration, /"run"\."status" IN \('queued', 'running'\)/u);
  assert.match(migration, /"run"\."daytonaAttemptId" IS NOT NULL/u);
  const migrationGuard = migration.slice(
    migration.indexOf("DO $$"),
    migration.indexOf("END $$") + "END $$".length
  );
  assert.doesNotMatch(
    migrationGuard,
    /agentRuntime|agentWorkspace|requiredCapabilities/u
  );
  assert.match(migration, /jsonb_array_elements\("step"\."skillSnapshots"\)/u);
  assert.match(migration, /\? 'workspace\.write'/u);
  assert.match(migration, /\? 'workspace\.read'/u);
  assert.match(
    migration,
    /UPDATE "RunnerRun" AS "run"\s+SET "executionPermission" = 'unrestricted'\s+FROM "RunnerTeamStep"/u
  );
  assert.match(
    migration,
    /ALTER TABLE "RunnerAgent" ADD COLUMN "sandboxTrust" varchar\(16\)/u
  );
  assert.match(
    migration,
    /UPDATE "RunnerAgent" AS "agent"[\s\S]*"daytonaSandboxId" IS NOT NULL[\s\S]*"sandboxLifecycle" <> 'unprovisioned'[\s\S]*THEN 'unrestricted'[\s\S]*ELSE 'clean'/u
  );
  assert.match(
    migration,
    /SET "sandboxTrust" = 'unrestricted',\s+"updatedAt" = clock_timestamp\(\),\s+"version" = "version" \+ 1/u
  );
  assert.match(
    migration,
    /SET "sandboxTrust" = 'restricted',\s+"updatedAt" = clock_timestamp\(\),\s+"version" = "version" \+ 1/u
  );
  const insertTriggerFunction = migration.slice(
    migration.indexOf(
      'CREATE FUNCTION "RunnerRun_enforce_team_execution_permission"'
    ),
    migration.indexOf("$$ LANGUAGE plpgsql") + "$$ LANGUAGE plpgsql".length
  );
  assert.doesNotMatch(
    insertTriggerFunction,
    /NEW\."executionPermission" = 'unrestricted'[\s\S]*SET "sandboxTrust" = 'unrestricted'/u
  );
  assert.match(
    migration,
    /CREATE FUNCTION "RunnerRun_mark_launched_sandbox_trust"[\s\S]*OLD\."daytonaSessionId" IS NULL[\s\S]*NEW\."daytonaSessionId" IS NOT NULL/u
  );
  assert.match(migration, /RunnerAgent_sandboxTrust_valid/u);
  assert.ok(migration.includes(backfillTeam));
  assert.ok(migration.includes(backfillOrdinary));
  assert.ok(migration.includes(setDefault));
  assert.ok(migration.includes(setNotNull));
  assert.ok(migration.indexOf(addNullable) < migration.indexOf(rejectUnsafe));
  assert.ok(migration.indexOf(rejectUnsafe) < migration.indexOf(backfillTeam));
  assert.ok(
    migration.indexOf(backfillTeam) < migration.indexOf(backfillOrdinary)
  );
  assert.ok(
    migration.indexOf(backfillOrdinary) < migration.indexOf(setDefault)
  );
  assert.ok(migration.indexOf(setDefault) < migration.indexOf(setNotNull));
  assert.match(migration, /RunnerRun_executionPermission_valid/u);
  assert.match(
    migration,
    /"RunnerRun"\."executionPermission" in \('unrestricted', 'workspace_read', 'workspace_write'\)/u
  );

  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", directory), "utf8")
  ) as { entries: { idx: number; tag: string }[] };
  const journalEntry = journal.entries.find(
    (entry) => entry.tag === migrationName.replace(/\.sql$/u, "")
  );
  assert.deepEqual(journalEntry, {
    ...journalEntry,
    idx: 24,
    tag: migrationName.replace(/\.sql$/u, ""),
  });

  const snapshot23 = JSON.parse(
    readFileSync(new URL("meta/0023_snapshot.json", directory), "utf8")
  ) as { id: string };
  const snapshot24Source = readFileSync(
    new URL("meta/0024_snapshot.json", directory),
    "utf8"
  );
  const snapshot24 = JSON.parse(snapshot24Source) as {
    prevId: string;
    tables: {
      "public.RunnerAgent": {
        columns: Record<string, { default?: string; notNull: boolean }>;
      };
      "public.RunnerRun": {
        checkConstraints: Record<string, { value: string }>;
        columns: Record<string, { default?: string; notNull: boolean }>;
      };
    };
  };
  assert.equal(snapshot24.prevId, snapshot23.id);
  assert.deepEqual(
    snapshot24.tables["public.RunnerRun"].columns.executionPermission,
    {
      ...snapshot24.tables["public.RunnerRun"].columns.executionPermission,
      default: "'unrestricted'",
      notNull: true,
    }
  );
  assert.equal(
    snapshot24.tables["public.RunnerRun"].checkConstraints
      .RunnerRun_executionPermission_valid?.value,
    `"RunnerRun"."executionPermission" in ('unrestricted', 'workspace_read', 'workspace_write')`
  );
  assert.deepEqual(
    snapshot24.tables["public.RunnerAgent"].columns.sandboxTrust,
    {
      ...snapshot24.tables["public.RunnerAgent"].columns.sandboxTrust,
      default: "'clean'",
      notNull: true,
    }
  );
});
