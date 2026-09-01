import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrations = new URL("../db/migrations/", import.meta.url);

test("0026 adds exact runner broker authority without rewriting old migrations", async () => {
  const [migration, migration24, migration25] = await Promise.all([
    readFile(new URL("0026_github_tool_gateway.sql", migrations), "utf8"),
    readFile(
      new URL("0024_runner_execution_permissions.sql", migrations),
      "utf8"
    ),
    readFile(new URL("0025_fearless_otto_octavius.sql", migrations), "utf8"),
  ]);

  assert.doesNotMatch(migration24, /githubBrokerPolicy|github_only/u);
  assert.doesNotMatch(migration25, /githubBrokerPolicy|github_only/u);
  assert.match(migration, /0026 cannot migrate pre-gateway GitHub authority/u);
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

test("0026 metadata is last and models gateway columns and checks", async () => {
  const [journalText, snapshotText] = await Promise.all([
    readFile(new URL("meta/_journal.json", migrations), "utf8"),
    readFile(new URL("meta/0026_snapshot.json", migrations), "utf8"),
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
  const entry = journal.entries.find(({ idx }) => idx === 26);
  assert.deepEqual(entry, {
    breakpoints: true,
    idx: 26,
    tag: "0026_github_tool_gateway",
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

test("0027 globally fences tenant operation ids and actor-bound policy metadata", async () => {
  const [migration, journalText, snapshotText] = await Promise.all([
    readFile(
      new URL("0027_gateway_operation_identity.sql", migrations),
      "utf8"
    ),
    readFile(new URL("meta/_journal.json", migrations), "utf8"),
    readFile(new URL("meta/0027_snapshot.json", migrations), "utf8"),
  ]);
  assert.match(
    migration,
    /RGHOp_tenant_operation_uq[\s\S]*"tenant","operationId"/u
  );
  assert.match(migration, /actorUserId/u);

  const journal = JSON.parse(journalText) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const entry = journal.entries.find(({ idx }) => idx === 27);
  assert.equal(entry?.idx, 27);
  assert.equal(entry?.tag, "0027_gateway_operation_identity");
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

test("0028 adds database-level capability, marker, mapping, expiry, and immutability fences", async () => {
  const migration = await readFile(
    new URL("0028_gateway_security_fences.sql", migrations),
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

test("0029 preserves immutable operation receipts while live connections can be deleted", async () => {
  const [migration, snapshotText] = await Promise.all([
    readFile(
      new URL("0029_preserve_github_operation_receipts.sql", migrations),
      "utf8"
    ),
    readFile(new URL("meta/0029_snapshot.json", migrations), "utf8"),
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
    /issue\.create|pull\.create|project\.item/u
  );
});
