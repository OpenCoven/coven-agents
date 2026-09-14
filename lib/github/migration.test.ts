import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import test from "node:test";
import {
  GITHUB_NODE_ID_MAX_LENGTH,
  GITHUB_NODE_ID_MIN_LENGTH,
  GITHUB_NODE_ID_PATTERN,
} from "@opencoven/agent-contracts";
import { is, sql } from "drizzle-orm";
import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core";
// biome-ignore lint/performance/noNamespaceImport: the snapshot test must enumerate every exported table
import * as schema from "../db/schema";
import {
  excessiveRegexBounds,
  latestSnapshotName,
  migrations,
  POSTGRES_REGEX_REPETITION_LIMIT,
  readJournal,
  readMigration,
  readSnapshot,
  regexRepetitionBounds,
  snapshotCheckText,
} from "./migration-test-helpers";

const GATEWAY_MIGRATION = "0032_github_tool_gateway.sql";
const GATEWAY_SNAPSHOT = "meta/0032_snapshot.json";
const PROJECT_AUTHORITY_MIGRATION = "0035_spicy_hammerhead.sql";
const PROJECT_AUTHORITY_TRIGGER_MIGRATION =
  "0036_project_authority_trigger.sql";

test("current main and the GitHub gateway form one migration lineage", async () => {
  const names = await readdir(migrations);
  const last = (await readJournal()).entries.at(-1);
  assert.ok(last);
  for (let index = 25; index <= last.idx; index += 1) {
    const prefix = `${String(index).padStart(4, "0")}_`;
    assert.equal(
      names.filter((name) => name.startsWith(prefix) && name.endsWith(".sql"))
        .length,
      1,
      `${prefix} must identify exactly one migration`
    );
  }
});

test("0042 preserves every prior immutable field and adds both Project bindings", async () => {
  const [previous, migration] = await Promise.all([
    readMigration(GATEWAY_MIGRATION),
    readMigration("0042_github_operation_project_immutable.sql"),
  ]);
  const previousGuard = previous.match(
    /CREATE OR REPLACE FUNCTION "RunnerGitHubOperation_reject_request_change"[\s\S]*?\$\$ LANGUAGE plpgsql/u
  )?.[0];
  assert.ok(previousGuard);
  for (const [predicate] of previousGuard.matchAll(
    /NEW\."\w+" IS DISTINCT FROM OLD\."\w+"/gu
  )) {
    assert.ok(migration.includes(predicate), predicate);
  }
  for (const field of ["projectId", "projectAuthorityBound"]) {
    assert.ok(
      migration.includes(`NEW."${field}" IS DISTINCT FROM OLD."${field}"`)
    );
  }
  assert.match(
    migration,
    /OLD\."connectionId" IS NOT NULL\s+AND NEW\."connectionId" IS NULL/u
  );
});

test("shared node-id limits match both SQL spellings at every boundary", () => {
  assert.equal(GITHUB_NODE_ID_MIN_LENGTH, 1);
  assert.equal(GITHUB_NODE_ID_MAX_LENGTH, 256);
  for (const length of [0, 1, 255, 256, 257]) {
    assert.equal(
      GITHUB_NODE_ID_PATTERN.test("A".repeat(length)),
      length >= GITHUB_NODE_ID_MIN_LENGTH && length <= GITHUB_NODE_ID_MAX_LENGTH
    );
  }
  for (const value of ["P_valid-id=", "invalid!", "A\n"]) {
    assert.equal(GITHUB_NODE_ID_PATTERN.test(value), value === "P_valid-id=");
  }
  const dialect = new PgDialect();
  const connection = getTableConfig(schema.runnerGitHubConnection);
  const operation = getTableConfig(schema.runnerGitHubOperation);
  const authority = connection.checks.find(
    (check) => check.name === "RGHConn_authority_valid"
  );
  const snapshot = operation.checks.find(
    (check) => check.name === "RGHOp_connectionSnapshot_valid"
  );
  assert.ok(authority && snapshot);
  assert.ok(
    dialect
      .sqlToQuery(authority.value)
      .sql.includes(
        `{${GITHUB_NODE_ID_MIN_LENGTH},${GITHUB_NODE_ID_MAX_LENGTH - 1}}[A-Za-z0-9_=-]?`
      )
  );
  assert.ok(
    dialect
      .sqlToQuery(snapshot.value)
      .sql.includes(
        `between ${GITHUB_NODE_ID_MIN_LENGTH} and ${GITHUB_NODE_ID_MAX_LENGTH}`
      )
  );
});

test("0043 applies exactly the new authority snapshots without rewriting 0035 semantics", async () => {
  const [migration, snapshot, historical] = await Promise.all([
    readMigration("0043_github_authority_fail_closed.sql"),
    readSnapshot("meta/0043_snapshot.json"),
    readMigration(PROJECT_AUTHORITY_MIGRATION),
  ]);
  for (const [table, name] of [
    ["RunnerGitHubConnection", "RGHConn_authority_valid"],
    ["RunnerGitHubOperation", "RGHOp_connectionSnapshot_valid"],
  ]) {
    const { value } = snapshot.tables[`public.${table}`].checkConstraints[name];
    assert.ok(migration.includes(`ADD CONSTRAINT "${name}" CHECK (${value});`));
  }
  assert.match(
    historical,
    /^-- Historical in-place regex rewrite: 0035 had never been applied;/u
  );
  assert.match(historical, /'\{\}'::jsonb, true/u);
  assert.doesNotMatch(migration, /'\{\}'::jsonb, true/u);
});

test("0032 adds durable immutable and current repository user-authority ceilings", async () => {
  const migrationUrl = new URL(GATEWAY_MIGRATION, migrations);
  assert.equal(existsSync(migrationUrl), true);
  const migration = await readMigration(GATEWAY_MIGRATION);
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

  const [journal, snapshot] = await Promise.all([
    readJournal(),
    readSnapshot(GATEWAY_SNAPSHOT),
  ]);
  const gatewayEntry = journal.entries.find((entry) => entry.idx === 32);
  assert.equal(gatewayEntry?.tag, "0032_github_tool_gateway");
  assert.equal(gatewayEntry?.version, "7");
  assert.ok(
    snapshot.tables["public.RunnerGitHubConnection"]?.columns
      .userPermissionCeiling
  );
});

test("0035 fails closed while preserving existing GitHub connections", async () => {
  const migration = await readMigration(PROJECT_AUTHORITY_MIGRATION);
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
  const migration = await readMigration(PROJECT_AUTHORITY_MIGRATION);
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
  const migration = await readMigration(PROJECT_AUTHORITY_MIGRATION);

  assert.match(
    migration,
    /like_regex "\^\[A-Za-z0-9_=-\]\{1,255\}\[A-Za-z0-9_=-\]\?\$"/u
  );
  assert.match(
    migration,
    /strict \$\[\*\] \? \(@\.type\(\) != "string" \|\| !\(@ like_regex/u
  );
  assert.match(
    migration,
    /and \(coalesce\(\("RunnerGitHubConnection"\."userProjectManagementCurrent" and/u
  );
  assert.match(
    migration,
    /interval '15 minutes'\), false\) or \(not "RunnerGitHubConnection"\."userProjectManagementCurrent"/u
  );
  assert.match(
    migration,
    /"projectAuthorityBound" and "RunnerGitHubOperation"\."projectId" is not null and char_length\("RunnerGitHubOperation"\."projectId"\) between 1 and 256 and "RunnerGitHubOperation"\."projectId" ~ '\^\[A-Za-z0-9_=-\]\+\$'/u
  );
  assert.doesNotMatch(migration, /\{1,256\}/u);
});

test("the regex bound scanner reads only regex operands and every quantifier shape", () => {
  assert.deepEqual(
    regexRepetitionBounds(
      `x ~ '^a{256,}$' and y ~* '^[a]{1,256}$' and z !~ '^b{255}$' and like_regex "^c{0,19}$"`
    ).map((entry) => entry.bounds),
    [[256], [1, 256], [255], [0, 19]]
  );
  assert.deepEqual(
    regexRepetitionBounds(
      `DEFAULT '{300,600}' -- limits {1,1000} '{}'::jsonb "a{4}"`
    ),
    []
  );
  assert.deepEqual(
    excessiveRegexBounds(`a ~ '^x{256,}$'`).map((entry) => entry.operand),
    ["^x{256,}$"]
  );
  assert.deepEqual(
    excessiveRegexBounds(`a ~ '^x{255}$' and b ~ '^y{1,255}$'`),
    []
  );
});

test("regex scanner recognizes bounded PostgreSQL regex syntax without LIKE or comment false positives", () => {
  for (const expression of [
    "regexp_like(value, '^a{256}$')",
    "regexp_like(coalesce(value, ''), E'^a{256}$', 'i')",
    "value SIMILAR TO $$a{256}$$",
    "value NOT SIMILAR TO E'a{256}'",
    "substring(value from '^a{256}$')",
    "substring(coalesce(value, '') from $pattern$a{256}$pattern$)",
    "value ~ E'^a{256}$'",
    String.raw`value ~ E'^a\x7b256\x7d$'`,
    String.raw`value ~ E'^a\u007b256\u007d$'`,
    String.raw`value ~ E'^a\U0000007b256\U0000007d$'`,
    String.raw`value ~ E'^a\173256\175$'`,
    String.raw`jsonb_path_exists(value, '$ ? (@ like_regex "^a\u007b256\u007d$")')`,
    "value !~* $$^a{256}$'$$",
    "DO $$ BEGIN PERFORM value ~ '^a{256}$'; END $$;",
  ]) {
    assert.equal(excessiveRegexBounds(expression).length, 1, expression);
  }
  for (const expression of [
    "value ~~ 'a{256}'",
    "value !~~* 'a{256}'",
    "-- value ~ 'a{256}'\n SELECT 1",
    "/* regexp_like(v, 'a{256}') /* nested */ */ SELECT 1",
    "SELECT 'a ~ ''b{256}'''",
    "value ~ '^a{255}$'",
    "value ~ E'^a\\\\{256}$'",
    "/* ' */ value ~ '^a{255}$' -- '",
    "value ~ '[a{256}]'",
  ]) {
    assert.deepEqual(excessiveRegexBounds(expression), [], expression);
  }
  const rendered = new PgDialect().sqlToQuery(
    sql`value ~ ${sql.raw("'a{256}'")}`
  ).sql;
  assert.equal(excessiveRegexBounds(rendered).length, 1);
  assert.throws(
    () => excessiveRegexBounds(" ".repeat(2_000_001)),
    /scanner input limit/u
  );
});

test("current Project authority checks are strict and fail closed as a whole", () => {
  const dialect = new PgDialect();
  for (const [table, name] of [
    [schema.runnerGitHubConnection, "RGHConn_authority_valid"],
    [schema.runnerGitHubOperation, "RGHOp_connectionSnapshot_valid"],
  ] as const) {
    const check = getTableConfig(table).checks.find(
      (entry) => entry.name === name
    );
    assert.ok(check);
    const text = dialect.sqlToQuery(check.value).sql;
    assert.match(text, /^\([\s\S]*\) is true$/iu);
    assert.doesNotMatch(text, /'\{\}'::jsonb,\s*true/u);
  }
});

test("regex scanner unwraps nested literal parentheses across operators and functions", () => {
  for (const expression of [
    "value ~ ('a{256}')",
    "value !~* (((E'^a{256}$')))",
    "value SIMILAR TO (($regex$a{256}$regex$))",
    "regexp_like(coalesce(value, ''), (('^a{256}$')), 'i')",
    "regexp_like(\",\", ('^a{256}$'))",
    "substring(\"from\" from (('^a{256}$')))",
    `jsonb_path_exists(value, ('$ ? (@ like_regex "^a{256}$")'))`,
  ]) {
    assert.equal(excessiveRegexBounds(expression).length, 1, expression);
    const rendered = new PgDialect().sqlToQuery(
      sql`${sql.raw(expression)}`
    ).sql;
    assert.equal(excessiveRegexBounds(rendered).length, 1, rendered);
  }
  for (const expression of [
    "value ~ ('^' || 'a{256}$')",
    "regexp_like(value, (prefix || 'a{256}$'))",
    "value SIMILAR TO ((computed_pattern))",
  ]) {
    assert.deepEqual(excessiveRegexBounds(expression), [], expression);
  }
});

test("regex scanner joins SQL newline-continuation literals with PostgreSQL quote semantics", () => {
  for (const expression of [
    "value ~ '^'\n'a{256}$'",
    "value ~ '^a{25'\r\n'6}$'",
    "value ~ '^' -- comment containing 'quotes'\n'a{256}$'",
    "value ~ '^' -- comment\r'a{256}$'",
    "regexp_like(value, ('^'\n'a{256}$'))",
    "value SIMILAR TO (('^'\n'a{256}$'))",
    "substring(value from ('^'\n'a{256}$'))",
    String.raw`value ~ E'^'
'a\x7b256\x7d$'`,
    "value ~ E'^'\n'a\\'{256}$'",
    "value ~ '^'\n'a''{256}$'",
    `jsonb_path_exists(value, ('$ ? (@ like_regex "^a{25'\n'6}$")'))`,
  ]) {
    assert.equal(excessiveRegexBounds(expression).length, 1, expression);
    const rendered = new PgDialect().sqlToQuery(
      sql`${sql.raw(expression)}`
    ).sql;
    assert.equal(excessiveRegexBounds(rendered).length, 1, rendered);
  }
  for (const expression of [
    "value ~ '^' 'a{256}$'",
    "value ~ '^' /* comment */\n'a{256}$'",
    "value ~ '^' /*\ncomment */ 'a{256}$'",
    "value ~ '^'\n/* comment */ 'a{256}$'",
    "value ~ '^'\nE'a{256}$'",
    "value ~ $$^$$\n'a{256}$'",
    "value ~ '^'\n$$a{256}$$",
    "value ~ E'^a\\\\'\n'{256}$'",
    "value ~ '^' -- a{256}\n'a{255}$'",
  ]) {
    assert.deepEqual(excessiveRegexBounds(expression), [], expression);
  }
});

test("no migration, snapshot, or schema regex uses a repetition bound Postgres rejects", async () => {
  const [names, metaNames] = await Promise.all([
    readdir(migrations),
    readdir(new URL("meta/", migrations)),
  ]);
  const sources = await Promise.all([
    ...names
      .filter((name) => name.endsWith(".sql"))
      .map((name) =>
        readMigration(name).then((text) => ({
          name,
          text,
        }))
      ),
    ...metaNames
      .filter((name) => name.endsWith("_snapshot.json"))
      .map((name) =>
        readSnapshot(`meta/${name}`).then((snapshot) => ({
          name: `meta/${name}`,
          text: snapshotCheckText(snapshot),
        }))
      ),
  ]);
  const dialect = new PgDialect();
  for (const table of Object.values(schema)) {
    if (is(table, PgTable)) {
      const config = getTableConfig(table);
      for (const check of config.checks) {
        sources.push({
          name: `rendered schema: ${config.name}.${check.name}`,
          text: dialect.sqlToQuery(check.value).sql,
        });
      }
    }
  }
  assert.ok(sources.length > 30);
  for (const { name, text } of sources) {
    assert.deepEqual(
      excessiveRegexBounds(text),
      [],
      `${name} uses a regex bound above ${POSTGRES_REGEX_REPETITION_LIMIT}`
    );
  }
});

test("0035 snapshots carry the exact CHECK text that 0035 applies", async () => {
  const [migration, ...snapshots] = await Promise.all([
    readMigration(PROJECT_AUTHORITY_MIGRATION),
    readSnapshot("meta/0035_snapshot.json"),
    readSnapshot("meta/0036_snapshot.json"),
  ]);
  for (const snapshot of snapshots) {
    for (const [tableName, constraintName] of [
      ["RunnerGitHubConnection", "RGHConn_authority_valid"],
      ["RunnerGitHubOperation", "RGHOp_connectionSnapshot_valid"],
    ]) {
      const value =
        snapshot.tables[`public.${tableName}`]?.checkConstraints?.[
          constraintName
        ]?.value;
      assert.ok(value, `${constraintName} must be recorded in the snapshot`);
      assert.ok(
        migration.includes(
          `ALTER TABLE "${tableName}" ADD CONSTRAINT "${constraintName}" CHECK (${value});`
        ),
        `${constraintName} snapshot text must match the 0035 SQL`
      );
    }
  }
});

test("schema.ts CHECK constraints render exactly as the latest snapshot records them", async () => {
  const snapshot = await readSnapshot(await latestSnapshotName());
  const dialect = new PgDialect();
  let compared = 0;
  for (const table of Object.values(schema)) {
    if (!is(table, PgTable)) {
      continue;
    }
    const config = getTableConfig(table);
    for (const check of config.checks) {
      const recorded =
        snapshot.tables[`public.${config.name}`]?.checkConstraints?.[check.name]
          ?.value;
      assert.equal(
        dialect.sqlToQuery(check.value).sql,
        recorded,
        `${config.name}.${check.name} drifted from the snapshot`
      );
      compared += 1;
    }
  }
  assert.ok(compared >= 100, `expected many CHECKs, compared ${compared}`);
});

test("0036 reconstructs exact runner policy authority from the applied 0035 shape", async () => {
  const migration = await readMigration(PROJECT_AUTHORITY_TRIGGER_MIGRATION);

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
    readMigration(GATEWAY_MIGRATION),
    readMigration("0024_runner_execution_permissions.sql"),
    readMigration("0025_cynical_scourge.sql"),
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
  const [journal, snapshot] = await Promise.all([
    readJournal(),
    readSnapshot(GATEWAY_SNAPSHOT),
  ]);
  const entry = journal.entries.find(({ idx }) => idx === 32);
  assert.deepEqual(entry, {
    breakpoints: true,
    idx: 32,
    tag: "0032_github_tool_gateway",
    version: "7",
    when: entry?.when,
  });

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
  const [migration, journal, snapshot] = await Promise.all([
    readMigration(GATEWAY_MIGRATION),
    readJournal(),
    readSnapshot(GATEWAY_SNAPSHOT),
  ]);
  assert.match(
    migration,
    /RGHOp_tenant_operation_uq[\s\S]*"tenant","operationId"/u
  );
  assert.match(migration, /actorUserId/u);

  const entry = journal.entries.find(({ idx }) => idx === 32);
  assert.equal(entry?.idx, 32);
  assert.equal(entry?.tag, "0032_github_tool_gateway");
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
  const migration = await readMigration(GATEWAY_MIGRATION);
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
  const [migration, snapshot] = await Promise.all([
    readMigration(GATEWAY_MIGRATION),
    readSnapshot(GATEWAY_SNAPSHOT),
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
  const [migration, journal, snapshot] = await Promise.all([
    readMigration(GATEWAY_MIGRATION),
    readJournal(),
    readSnapshot(GATEWAY_SNAPSHOT),
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
  const [migration, journal, snapshot] = await Promise.all([
    readMigration(GATEWAY_MIGRATION),
    readJournal(),
    readSnapshot(GATEWAY_SNAPSHOT),
  ]);

  assert.match(
    migration,
    /ORDER BY lower\("connection"\."repositoryOwner"\) COLLATE "C",\s*lower\("connection"\."repositoryName"\) COLLATE "C"/u
  );
  assert.doesNotMatch(
    migration,
    /ALTER TABLE "RunnerGitHubConnection".*COLLATE/u
  );

  const entry = journal.entries.find(({ idx }) => idx === 32);
  assert.equal(entry?.tag, "0032_github_tool_gateway");
  assert.equal(entry?.version, "7");

  assert.ok(snapshot.tables["public.RunnerRun"]);
});
