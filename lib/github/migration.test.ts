import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const migrations = new URL("../db/migrations/", import.meta.url);

const GATEWAY_MIGRATION = "0032_github_tool_gateway.sql";
const GATEWAY_SNAPSHOT = "meta/0032_snapshot.json";
const PROJECT_AUTHORITY_MIGRATION = "0035_spicy_hammerhead.sql";
const PROJECT_AUTHORITY_TRIGGER_MIGRATION =
  "0036_project_authority_trigger.sql";
// PostgreSQL rejects regex repetition counts above 255 (DUPMAX in regguts.h).
const POSTGRES_REGEX_REPETITION_LIMIT = 255;

test("current main and the GitHub gateway form one migration lineage", async () => {
  const names = await readdir(migrations);
  for (let index = 25; index <= 36; index += 1) {
    const prefix = `${String(index).padStart(4, "0")}_`;
    assert.equal(
      names.filter((name) => name.startsWith(prefix) && name.endsWith(".sql"))
        .length,
      1,
      `${prefix} must identify exactly one migration`
    );
  }
});

test("0032 adds durable immutable and current repository user-authority ceilings", async () => {
  const migrationUrl = new URL(GATEWAY_MIGRATION, migrations);
  assert.equal(existsSync(migrationUrl), true);
  const migration = await readFile(migrationUrl, "utf8");
  for (const column of [
    "githubUserId",
    "githubUserLogin",
    "userPermissionCeiling",
    "userPermissionCurrent",
    "userProjectManagementCeiling",
    "userProjectManagementCurrent",
    "appIssuesPermission",
    "appPullRequestsPermission",
    "appOrganizationProjectsPermission",
  ]) {
    assert.match(
      migration,
      new RegExp(
        `ALTER TABLE "RunnerGitHubConnection" ADD COLUMN "${column}"`,
        "u"
      )
    );
  }
  assert.match(migration, /UPDATE "RunnerGitHubConnectionFence"/u);
  assert.match(migration, /UPDATE "RunnerGitHubCapability"[\s\S]*"revokedAt"/u);
  assert.match(migration, /DELETE FROM "RunnerGitHubConnection"/u);
  assert.match(migration, /RunnerRun_enforce_team_execution_permission/u);
  assert.match(
    migration,
    /ORDER BY \(\s*lower\("connection"\."repositoryOwner"\) \|\| '\/' \|\|\s*lower\("connection"\."repositoryName"\)\s*\) COLLATE "C"/u
  );

  const [journalText, snapshotText] = await Promise.all([
    readFile(new URL("meta/_journal.json", migrations), "utf8"),
    readFile(new URL(GATEWAY_SNAPSHOT, migrations), "utf8"),
  ]);
  const journal = JSON.parse(journalText) as {
    entries: Array<{ idx: number; tag: string; version: string }>;
  };
  const gatewayEntry = journal.entries.find((entry) => entry.idx === 32);
  assert.equal(gatewayEntry?.tag, "0032_github_tool_gateway");
  assert.equal(gatewayEntry?.version, "7");
  const snapshot = JSON.parse(snapshotText) as {
    tables: Record<string, { columns: Record<string, unknown> }>;
  };
  assert.ok(
    snapshot.tables["public.RunnerGitHubConnection"]?.columns
      .userPermissionCeiling
  );
});

test("0035 fails closed while preserving existing GitHub connections", async () => {
  const migration = await readFile(
    new URL(PROJECT_AUTHORITY_MIGRATION, migrations),
    "utf8"
  );
  assert.match(
    migration,
    /ADD COLUMN "userProjectIds" jsonb DEFAULT '\[\]'::jsonb NOT NULL/u
  );
  assert.doesNotMatch(migration, /ALTER COLUMN "userProjectIds" DROP DEFAULT/u);
  assert.match(
    migration,
    /UPDATE "RunnerGitHubConnection"[\s\S]*"userProjectManagementCurrent" = false/u
  );
  assert.match(
    migration,
    /UPDATE "RunnerGitHubConnectionFence"[\s\S]*"generation" = "generation" \+ 1/u
  );
  assert.match(
    migration,
    /UPDATE "RunnerGitHubCapability"[\s\S]*"revokedAt" = COALESCE\("revokedAt", clock_timestamp\(\)\)/u
  );
  assert.match(migration, /jsonb_path_exists/u);
  assert.match(migration, /userProjectManagementCurrent/u);
});

test("0035 persists bounded Project proof bindings and exact operation Project ids", async () => {
  const migration = await readFile(
    new URL(PROJECT_AUTHORITY_MIGRATION, migrations),
    "utf8"
  );
  for (const column of [
    "userProjectAuthorityAuthVersion",
    "userProjectAuthorityConnectionGeneration",
    "userProjectAuthorityExpiresAt",
    "userProjectAuthorityIssuedAt",
  ]) {
    assert.match(
      migration,
      new RegExp(
        `ALTER TABLE "RunnerGitHubConnection" ADD COLUMN "${column}"`,
        "u"
      )
    );
  }
  assert.match(
    migration,
    /"userProjectAuthorityExpiresAt" timestamp with time zone/u
  );
  assert.match(
    migration,
    /"userProjectAuthorityIssuedAt" timestamp with time zone/u
  );
  assert.match(
    migration,
    /"userProjectAuthorityExpiresAt" <= "RunnerGitHubConnection"\."userProjectAuthorityIssuedAt" \+ interval '15 minutes'/u
  );
  assert.match(
    migration,
    /ALTER TABLE "RunnerGitHubOperation" ADD COLUMN "projectId" varchar\(256\)/u
  );
  assert.match(
    migration,
    /ADD COLUMN "projectAuthorityBound" boolean DEFAULT false NOT NULL/u
  );
  assert.doesNotMatch(
    migration,
    /ALTER COLUMN "projectAuthorityBound" DROP DEFAULT/u
  );
  assert.match(
    migration,
    /CREATE TRIGGER "RGHConn_normalize_project_authority"/u
  );
  assert.match(migration, /NEW\."userProjectManagementCurrent" := false/u);
  assert.match(migration, /NOT COALESCE\([\s\S]*false\) THEN/u);
  assert.match(
    migration,
    /CREATE TRIGGER "RGHOp_require_current_project_authority"/u
  );
  assert.match(
    migration,
    /NEW\."projectAuthorityBound" = false[\s\S]*RAISE EXCEPTION/u
  );
  assert.match(migration, /project\.item\.field\.update/u);
});

test("0035 bounds Project ids without exceeding the Postgres regex repetition limit", async () => {
  const migration = await readFile(
    new URL(PROJECT_AUTHORITY_MIGRATION, migrations),
    "utf8"
  );

  assert.match(
    migration,
    /like_regex "\^\[A-Za-z0-9_=-\]\{1,255\}\[A-Za-z0-9_=-\]\?\$"/u
  );
  assert.match(
    migration,
    /char_length\("RunnerGitHubOperation"\."projectId"\) between 1 and 256 and "RunnerGitHubOperation"\."projectId" ~ '\^\[A-Za-z0-9_=-\]\+\$'/u
  );
  assert.match(
    migration,
    /"projectAuthorityBound" and "RunnerGitHubOperation"\."projectId" is not null and char_length/u
  );
  assert.doesNotMatch(migration, /\{1,256\}/u);
});

test("the regex bound scanner catches every quantifier shape Postgres limits", () => {
  const bounds = (text: string) =>
    [...text.matchAll(/\{(\d+)(?:,(\d*))?\}/gu)]
      .flatMap((match) => match.slice(1))
      .filter((bound) => bound !== undefined && bound !== "")
      .map(Number);
  assert.deepEqual(
    bounds("a{255} b{1,255} c{256,} d{1,256} e{0,19}"),
    [255, 1, 255, 256, 1, 256, 0, 19]
  );
  assert.ok(
    bounds("x{256,}").some((bound) => bound > POSTGRES_REGEX_REPETITION_LIMIT)
  );
  assert.ok(
    bounds("x{1,256}").some((bound) => bound > POSTGRES_REGEX_REPETITION_LIMIT)
  );
  assert.ok(
    bounds("x{255} y{1,255}").every(
      (bound) => bound <= POSTGRES_REGEX_REPETITION_LIMIT
    )
  );
});

test("no migration or schema regex uses a repetition bound Postgres rejects", async () => {
  const names = await readdir(migrations);
  const sources = await Promise.all([
    ...names
      .filter((name) => name.endsWith(".sql"))
      .map(async (name) => ({
        name,
        text: await readFile(new URL(name, migrations), "utf8"),
      })),
    {
      name: "schema.ts",
      text: await readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    },
  ]);
  for (const { name, text } of sources) {
    for (const match of text.matchAll(/\{(\d+)(?:,(\d*))?\}/gu)) {
      for (const bound of match.slice(1)) {
        if (bound !== undefined && bound !== "") {
          assert.ok(
            Number(bound) <= POSTGRES_REGEX_REPETITION_LIMIT,
            `${name} uses regex bound ${match[0]} above Postgres limit ${POSTGRES_REGEX_REPETITION_LIMIT}`
          );
        }
      }
    }
  }
});

test("0036 reconstructs exact runner policy authority from the applied 0035 shape", async () => {
  const migration = await readFile(
    new URL(PROJECT_AUTHORITY_TRIGGER_MIGRATION, migrations),
    "utf8"
  );

  assert.match(
    migration,
    /pg_get_functiondef\(\s*'"RunnerRun_enforce_team_execution_permission"\(\)'::regprocedure/u
  );
  assert.match(
    migration,
    /"userProjectAuthorityAuthVersion" = "stepAuthVersion"/u
  );
  assert.match(
    migration,
    /"userProjectAuthorityConnectionGeneration" = COALESCE/u
  );
  assert.match(
    migration,
    /"userProjectAuthorityIssuedAt" <= clock_timestamp\(\)/u
  );
  assert.match(
    migration,
    /"userProjectAuthorityExpiresAt" > clock_timestamp\(\)/u
  );
  for (const field of [
    "appContentsPermission",
    "tenant",
    "userProjectAuthorityAuthVersion",
    "userProjectAuthorityConnectionGeneration",
    "userProjectAuthorityExpiresAt",
    "userProjectAuthorityIssuedAt",
    "userProjectIds",
  ]) {
    assert.match(migration, new RegExp(`'${field}'`, "u"));
  }
  assert.match(
    migration,
    /NEW\."githubBrokerPolicy"->>'tenant' IS DISTINCT FROM NEW\."tenant"/u
  );
  assert.match(
    migration,
    /0036 could not locate the current Project authority branch/u
  );
  assert.match(
    migration,
    /0036 could not locate the broker repository projection/u
  );
  assert.match(
    migration,
    /0036 could not locate the broker policy key allowlist/u
  );
  assert.match(
    migration,
    /0036 could not locate the broker policy tenant check/u
  );
});

test("0032 adds exact runner broker authority without rewriting old migrations", async () => {
  const [migration, migration24, migration25] = await Promise.all([
    readFile(new URL(GATEWAY_MIGRATION, migrations), "utf8"),
    readFile(
      new URL("0024_runner_execution_permissions.sql", migrations),
      "utf8"
    ),
    readFile(new URL("0025_cynical_scourge.sql", migrations), "utf8"),
  ]);

  assert.doesNotMatch(migration24, /githubBrokerPolicy|github_only/u);
  assert.doesNotMatch(migration25, /githubBrokerPolicy|github_only/u);
  assert.match(migration, /0032 cannot migrate pre-gateway GitHub authority/u);
  assert.match(
    migration,
    /ALTER TABLE "RunnerRun" ADD COLUMN "teamStepId" uuid/u
  );
  assert.match(
    migration,
    /ALTER TABLE "RunnerRun" ADD COLUMN "githubBrokerPolicy" jsonb/u
  );
  assert.match(migration, /github_only/u);
  for (const column of [
    "attemptId",
    "authVersion",
    "connectionGeneration",
    "declaredCapabilities",
    "runnerRunId",
    "teamRunId",
  ]) {
    assert.match(
      migration,
      new RegExp(
        `ALTER TABLE "RunnerGitHubCapability" ADD COLUMN "${column}"`,
        "u"
      )
    );
  }
  for (const column of [
    "connectionGeneration",
    "connectionId",
    "executionLeaseExpiresAt",
    "operationMarker",
    "repository",
    "requiredCapability",
    "resultJson",
  ]) {
    assert.match(
      migration,
      new RegExp(
        `ALTER TABLE "RunnerGitHubOperation" ADD COLUMN "${column}"`,
        "u"
      )
    );
  }
  assert.match(
    migration,
    /RunnerGitHubCapability_runnerRun_fk[\s\S]*RunnerRun/u
  );
  assert.match(
    migration,
    /RunnerGitHubCapability_teamRun_fk[\s\S]*RunnerTeamRun/u
  );
  assert.match(
    migration,
    /RunnerGitHubOperation_connection_fk[\s\S]*RunnerGitHubConnection/u
  );
  assert.match(
    migration,
    /RunnerRun_enforce_team_execution_permission[\s\S]*githubBrokerPolicy/u
  );
  for (const trigger of [
    "RunnerGitHubCapability_revoke_runner_terminal",
    "RunnerGitHubCapability_revoke_step_terminal",
    "RunnerGitHubCapability_revoke_auth_version",
    "RunnerGitHubCapability_revoke_connection_generation",
  ]) {
    assert.match(migration, new RegExp(trigger, "u"));
  }
});

test("0032 metadata is last and models gateway columns and checks", async () => {
  const [journalText, snapshotText] = await Promise.all([
    readFile(new URL("meta/_journal.json", migrations), "utf8"),
    readFile(new URL(GATEWAY_SNAPSHOT, migrations), "utf8"),
  ]);
  const journal = JSON.parse(journalText) as {
    entries: Array<{
      breakpoints: boolean;
      idx: number;
      tag: string;
      version: string;
      when: number;
    }>;
  };
  const entry = journal.entries.find(({ idx }) => idx === 32);
  assert.deepEqual(entry, {
    breakpoints: true,
    idx: 32,
    tag: "0032_github_tool_gateway",
    version: "7",
    when: entry?.when,
  });

  const snapshot = JSON.parse(snapshotText) as {
    tables: Record<
      string,
      {
        columns: Record<string, unknown>;
        checkConstraints: Record<string, { value: string }>;
      }
    >;
  };
  const runnerRun = snapshot.tables["public.RunnerRun"];
  const capability = snapshot.tables["public.RunnerGitHubCapability"];
  const operation = snapshot.tables["public.RunnerGitHubOperation"];
  assert.ok(runnerRun.columns.teamStepId);
  assert.ok(runnerRun.columns.githubBrokerPolicy);
  assert.match(
    runnerRun.checkConstraints.RunnerRun_executionPermission_valid.value,
    /github_only/u
  );
  assert.ok(capability.columns.runnerRunId);
  assert.ok(capability.columns.connectionGeneration);
  assert.ok(operation.columns.resultJson);
  assert.ok(operation.columns.executionLeaseExpiresAt);
});

test("0032 globally fences tenant operation ids and actor-bound policy metadata", async () => {
  const [migration, journalText, snapshotText] = await Promise.all([
    readFile(new URL(GATEWAY_MIGRATION, migrations), "utf8"),
    readFile(new URL("meta/_journal.json", migrations), "utf8"),
    readFile(new URL(GATEWAY_SNAPSHOT, migrations), "utf8"),
  ]);
  assert.match(
    migration,
    /RGHOp_tenant_operation_uq[\s\S]*"tenant","operationId"/u
  );
  assert.match(migration, /actorUserId/u);

  const journal = JSON.parse(journalText) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const entry = journal.entries.find(({ idx }) => idx === 32);
  assert.equal(entry?.idx, 32);
  assert.equal(entry?.tag, "0032_github_tool_gateway");
  const snapshot = JSON.parse(snapshotText) as {
    tables: Record<
      string,
      {
        checkConstraints: Record<string, { value: string }>;
        uniqueConstraints: Record<string, { columns: string[] }>;
      }
    >;
  };
  assert.deepEqual(
    snapshot.tables["public.RunnerGitHubOperation"].uniqueConstraints
      .RGHOp_tenant_operation_uq.columns,
    ["tenant", "operationId"]
  );
  assert.match(
    snapshot.tables["public.RunnerRun"].checkConstraints
      .RunnerRun_githubBrokerPolicy_valid.value,
    /actorUserId/u
  );
});

test("0032 adds database-level capability, marker, mapping, expiry, and immutability fences", async () => {
  const migration = await readFile(
    new URL(GATEWAY_MIGRATION, migrations),
    "utf8"
  );
  for (const constraint of [
    "RGHCap_caps_valid",
    "RGHCap_timestamps_valid",
    "RGHOp_capability_mapping_valid",
    "RGHOp_marker_valid",
  ]) {
    assert.match(migration, new RegExp(constraint, "u"));
  }
  assert.match(migration, /interval '15 minutes'/u);
  assert.match(migration, /github\.issues\.write/u);
  assert.match(migration, /coven-github:v1/u);
  for (const trigger of [
    "RunnerRun_github_authority_immutable",
    "RunnerGitHubCapability_authority_immutable",
    "RunnerGitHubOperation_request_immutable",
  ]) {
    assert.match(migration, new RegExp(trigger, "u"));
  }
});

test("0032 preserves immutable operation receipts while live connections can be deleted", async () => {
  const [migration, snapshotText] = await Promise.all([
    readFile(new URL(GATEWAY_MIGRATION, migrations), "utf8"),
    readFile(new URL(GATEWAY_SNAPSHOT, migrations), "utf8"),
  ]);
  for (const column of [
    "accountId",
    "accountLogin",
    "accountType",
    "installationId",
    "repositoryId",
    "repositoryName",
    "repositoryNodeId",
    "repositoryOwner",
  ]) {
    assert.match(
      migration,
      new RegExp(
        `ALTER TABLE "RunnerGitHubOperation" ADD COLUMN "${column}"`,
        "u"
      )
    );
  }
  assert.match(
    migration,
    /DROP CONSTRAINT "RunnerGitHubOperation_connection_fk"/u
  );
  assert.match(migration, /ALTER COLUMN "connectionId" DROP NOT NULL/u);
  assert.match(migration, /ON DELETE set null/iu);
  assert.match(
    migration,
    /RunnerGitHubOperation_validate_live_connection[\s\S]*"tenant" = NEW\."tenant"/u
  );
  assert.match(migration, /RGHOp_step_write_intent_uq/u);
  assert.match(
    migration,
    /CREATE OR REPLACE FUNCTION "RunnerGitHubOperation_reject_request_change"/u
  );
  const requestGuard =
    migration.match(
      /CREATE OR REPLACE FUNCTION "RunnerGitHubOperation_reject_request_change"[\s\S]*?\$\$ LANGUAGE plpgsql/u
    )?.[0] ?? "";
  assert.match(
    requestGuard,
    /OLD\."connectionId" IS NOT NULL[\s\S]*NEW\."connectionId" IS NULL/u
  );
  assert.match(
    migration,
    /CREATE OR REPLACE FUNCTION "RunnerGitHubOperation_enforce_terminal_state"[\s\S]*to_jsonb\(NEW\) - 'connectionId'/u
  );

  const snapshot = JSON.parse(snapshotText) as {
    tables: Record<
      string,
      {
        columns: Record<string, { notNull: boolean }>;
        foreignKeys: Record<string, { onDelete: string }>;
        indexes: Record<string, { isUnique: boolean; where?: string }>;
      }
    >;
  };
  const operation = snapshot.tables["public.RunnerGitHubOperation"];
  const capability = snapshot.tables["public.RunnerGitHubCapability"];
  assert.equal(capability.columns.updatedAt.notNull, true);
  assert.equal(operation.columns.connectionId.notNull, false);
  assert.equal(operation.columns.installationId.notNull, true);
  assert.equal(
    operation.foreignKeys.RunnerGitHubOperation_connection_fk.onDelete,
    "set null"
  );
  assert.equal(operation.indexes.RGHOp_step_write_intent_uq.isUnique, true);
  assert.match(
    operation.indexes.RGHOp_step_write_intent_uq.where ?? "",
    /writeIntentActive/u
  );
});

test("0032 persists pre-send versus sent provider dispatch and releasable write intents", async () => {
  const migrationUrl = new URL(GATEWAY_MIGRATION, migrations);
  assert.equal(existsSync(migrationUrl), true);
  const [migration, journalText, snapshotText] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(new URL("meta/_journal.json", migrations), "utf8"),
    readFile(new URL(GATEWAY_SNAPSHOT, migrations), "utf8"),
  ]);

  for (const column of [
    "providerDispatchPhase",
    "providerSentAt",
    "writeIntentActive",
  ]) {
    assert.match(
      migration,
      new RegExp(
        `ALTER TABLE "RunnerGitHubOperation" ADD COLUMN "${column}"`,
        "u"
      )
    );
  }
  assert.match(
    migration,
    /UPDATE "RunnerGitHubOperation"[\s\S]*"providerDispatchPhase" = 'sent'[\s\S]*"providerSentAt" = COALESCE\("startedAt", "createdAt"\)/u
  );
  assert.match(
    migration,
    /DROP INDEX "RGHOp_step_write_intent_uq"[\s\S]*WHERE[^\n]*"writeIntentActive"/u
  );
  assert.match(migration, /RGHOp_dispatch_phase_valid/u);
  assert.match(
    migration,
    /OLD\."providerDispatchPhase" = 'pre_send'[\s\S]*NEW\."status" = 'pending'/u
  );

  const journal = JSON.parse(journalText) as {
    entries: Array<{
      breakpoints: boolean;
      idx: number;
      tag: string;
      version: string;
      when: number;
    }>;
  };
  assert.deepEqual(
    journal.entries.find(({ idx }) => idx === 32),
    {
      breakpoints: true,
      idx: 32,
      tag: "0032_github_tool_gateway",
      version: "7",
      when: journal.entries.find(({ idx }) => idx === 32)?.when,
    }
  );

  const snapshot = JSON.parse(snapshotText) as {
    tables: Record<
      string,
      {
        columns: Record<string, { notNull: boolean }>;
        indexes: Record<string, { isUnique: boolean; where?: string }>;
      }
    >;
  };
  const operation = snapshot.tables["public.RunnerGitHubOperation"];
  assert.equal(operation.columns.providerDispatchPhase.notNull, true);
  assert.equal(operation.columns.providerSentAt.notNull, false);
  assert.equal(operation.columns.writeIntentActive.notNull, true);
  assert.equal(operation.indexes.RGHOp_step_write_intent_uq.isUnique, true);
  assert.match(
    operation.indexes.RGHOp_step_write_intent_uq.where ?? "",
    /writeIntentActive/u
  );
});

test("0032 makes durable repository ordering use C collation", async () => {
  const migrationUrl = new URL(GATEWAY_MIGRATION, migrations);
  assert.equal(existsSync(migrationUrl), true);
  const [migration, journalText, snapshotText] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(new URL("meta/_journal.json", migrations), "utf8"),
    readFile(new URL(GATEWAY_SNAPSHOT, migrations), "utf8"),
  ]);

  assert.match(
    migration,
    /ORDER BY lower\("connection"\."repositoryOwner"\) COLLATE "C",\s*lower\("connection"\."repositoryName"\) COLLATE "C"/u
  );
  assert.doesNotMatch(
    migration,
    /ALTER TABLE "RunnerGitHubConnection".*COLLATE/u
  );

  const journal = JSON.parse(journalText) as {
    entries: Array<{ idx: number; tag: string; version: string }>;
  };
  const entry = journal.entries.find(({ idx }) => idx === 32);
  assert.equal(entry?.tag, "0032_github_tool_gateway");
  assert.equal(entry?.version, "7");

  const snapshot = JSON.parse(snapshotText) as {
    tables: Record<string, unknown>;
  };
  assert.ok(snapshot.tables["public.RunnerRun"]);
});
