import assert from "node:assert/strict";
import test from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const databaseUrl = process.env.GITHUB_TOOL_POSTGRES_TEST_URL;

test("disconnect advances generation, revokes capability, and preserves an immutable receipt", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  const sql = postgres(databaseUrl, {
    max: 1,
    onnotice: () => undefined,
  });
  const tenant = "tenant_github_lifecycle";
  const userId = "10000000-0000-4000-8000-000000000001";
  const agentId = "10000000-0000-4000-8000-000000000002";
  const teamId = "10000000-0000-4000-8000-000000000003";
  const teamRunId = "10000000-0000-4000-8000-000000000004";
  const teamStepId = "10000000-0000-4000-8000-000000000005";
  const memberId = "10000000-0000-4000-8000-000000000006";
  const runnerRunId = "10000000-0000-4000-8000-000000000007";
  const runnerOperationId = "10000000-0000-4000-8000-000000000008";
  const attemptId = "10000000-0000-4000-8000-000000000009";
  const connectionId = "10000000-0000-4000-8000-000000000010";
  const capabilityId = "10000000-0000-4000-8000-000000000011";
  const operationId = "10000000-0000-4000-8000-000000000012";
  const releasedWriteId = "10000000-0000-4000-8000-000000000017";
  const freshWriteId = "10000000-0000-4000-8000-000000000018";
  const writeRequestHash = "e".repeat(64);
  const installationId = "456";
  const accountId = "123";
  const repositoryId = "789";
  const tokenHash = "a".repeat(64);
  const requestHash = "b".repeat(64);
  const policy = {
    actorUserId: userId,
    allowedCapabilities: ["github.issues.read", "github.issues.write"],
    approvedCapabilities: ["github.issues.write"],
    authVersion: 7,
    connectionGeneration: 0,
    declaredCapabilities: ["github.issues.read", "github.issues.write"],
    maxCallCount: 32,
    repositories: [
      {
        accountId,
        accountLogin: "OpenCoven",
        accountType: "Organization",
        connectionId,
        installationId,
        repository: "opencoven/coven-agents",
        repositoryId,
        repositoryName: "coven-agents",
        repositoryNodeId: "R_kgDOExample",
        repositoryOwner: "OpenCoven",
      },
    ],
    teamRunId,
    teamStepId,
    version: 1,
  };
  const skillSnapshots = [
    {
      description: "",
      id: "10000000-0000-4000-8000-000000000013",
      instructions: "Read issues.",
      name: "Issue reader",
      requiredCapabilities: ["github.issues.read", "github.issues.write"],
    },
  ];

  try {
    await sql.begin(async (transaction) => {
      await transaction`
          INSERT INTO "User" ("id", "email", "authVersion")
          VALUES (${userId}, 'gateway-lifecycle@example.invalid', 7)
        `;
      await transaction`
          INSERT INTO "RunnerAgent" (
            "id", "tenant", "instructions", "model", "name", "runtime"
          ) VALUES (
            ${agentId}, ${tenant}, 'Read issues.', 'auto',
            'Lifecycle agent', 'copilot'
          )
        `;
      await transaction`
          INSERT INTO "RunnerTeam" ("id", "tenant", "name")
          VALUES (${teamId}, ${tenant}, 'Lifecycle team')
        `;
      await transaction`
          INSERT INTO "RunnerTeamRun" (
            "id", "tenant", "teamId", "createdByUserId", "authVersion",
            "operationId", "requestHash", "mission", "status", "startedAt"
          ) VALUES (
            ${teamRunId}, ${tenant}, ${teamId}, ${userId}, 7,
            '10000000-0000-4000-8000-000000000014', ${"c".repeat(64)},
            'Verify disconnect lifecycle.', 'running', clock_timestamp()
          )
        `;
      await transaction`
          INSERT INTO "RunnerTeamStep" (
            "id", "tenant", "teamRunId", "memberId", "agentId", "position",
            "required", "responsibility", "skillIds", "skillSnapshots",
            "agentInstructions", "agentModel", "agentRuntime",
            "approvalStatus", "approvedCapabilities", "approvalActorUserId",
            "approvalDecidedAt", "status", "startedAt",
            "plannedOperationId", "plannedRunnerRunId"
          ) VALUES (
            ${teamStepId}, ${tenant}, ${teamRunId}, ${memberId}, ${agentId}, 0,
            true, 'Read one issue.', ${transaction.json([])},
            ${transaction.json(skillSnapshots)}, 'Read issues.', 'auto',
            'copilot', 'approved',
            ${transaction.json(["github.issues.write"])}, ${userId},
            clock_timestamp(), 'running',
            clock_timestamp(), ${runnerOperationId}, ${runnerRunId}
          )
        `;
      await transaction`
          INSERT INTO "RunnerGitHubConnectionFence" ("tenant", "generation")
          VALUES (${tenant}, 0)
        `;
      await transaction`
          INSERT INTO "RunnerGitHubConnection" (
            "id", "tenant", "accountId", "accountLogin", "accountType",
            "installationId", "repositoryId", "repositoryName",
            "repositoryNodeId", "repositoryOwner"
          ) VALUES (
            ${connectionId}, ${tenant}, ${accountId}, 'OpenCoven',
            'Organization', ${installationId}, ${repositoryId},
            'coven-agents', 'R_kgDOExample', 'OpenCoven'
          )
        `;
      await transaction`
          INSERT INTO "RunnerRun" (
            "id", "agentId", "tenant", "agentInstructions", "agentModel",
            "agentRuntime", "authVersion", "operationId", "requestHash",
            "task", "executionPermission", "teamStepId", "githubBrokerPolicy"
          ) VALUES (
            ${runnerRunId}, ${agentId}, ${tenant}, 'Read issues.', 'auto',
            'copilot', 7, ${runnerOperationId}, ${"d".repeat(64)},
            'Read one issue.', 'github_only', ${teamStepId},
            ${transaction.json(policy)}
          )
        `;
      await transaction`
          UPDATE "RunnerRun"
          SET "status" = 'running',
              "dispatchState" = 'running',
              "startedAt" = clock_timestamp(),
              "daytonaAttemptId" = ${attemptId},
              "dispatchLeaseToken" = 'lifecycle-lease',
              "dispatchLeaseExpiresAt" = clock_timestamp() + interval '10 minutes'
          WHERE "id" = ${runnerRunId}
        `;
      await transaction`
          UPDATE "RunnerTeamStep"
          SET "runnerRunId" = ${runnerRunId}
          WHERE "id" = ${teamStepId}
        `;
      await transaction`
          INSERT INTO "RunnerGitHubCapability" (
            "id", "tenant", "teamStepId", "teamRunId", "runnerRunId",
            "attemptId", "authVersion", "connectionGeneration", "tokenHash",
            "expiresAt", "declaredCapabilities", "approvedCapabilities",
            "allowedCapabilities", "repositoryAllowlist", "maxCallCount"
          ) VALUES (
            ${capabilityId}, ${tenant}, ${teamStepId}, ${teamRunId},
            ${runnerRunId}, ${attemptId}, 7, 0, ${tokenHash},
            clock_timestamp() + interval '10 minutes',
            ${transaction.json(["github.issues.read", "github.issues.write"])},
            ${transaction.json(["github.issues.write"])},
            ${transaction.json(["github.issues.read", "github.issues.write"])},
            ${transaction.json(["opencoven/coven-agents"])}, 32
          )
        `;
      await transaction`
          INSERT INTO "RunnerGitHubOperation" (
            "id", "tenant", "teamStepId", "capabilityId", "operationId",
            "kind", "requestHash", "target", "repository",
            "requiredCapability", "connectionId", "connectionGeneration",
            "operationMarker", "status", "startedAt", "completedAt",
            "executionLeaseExpiresAt", "resultJson", "resultNodeId",
            "resultUrl", "accountId", "accountLogin", "accountType",
            "installationId", "repositoryId", "repositoryName",
            "repositoryNodeId", "repositoryOwner"
          ) VALUES (
            ${operationId}, ${tenant}, ${teamStepId}, ${capabilityId},
            '10000000-0000-4000-8000-000000000015', 'issue.get',
            ${requestHash}, 'opencoven/coven-agents#issue.get:42',
            'opencoven/coven-agents', 'github.issues.read', ${connectionId}, 0,
            NULL, 'running', clock_timestamp(), NULL,
            clock_timestamp() + interval '1 minute', NULL, NULL, NULL,
            ${accountId}, 'OpenCoven', 'Organization', ${installationId},
            ${repositoryId}, 'coven-agents', 'R_kgDOExample', 'OpenCoven'
          )
        `;
      await transaction`
          UPDATE "RunnerGitHubOperation"
          SET "status" = 'completed',
              "completedAt" = clock_timestamp(),
              "resultJson" = ${transaction.json({
                issue: {
                  body: "",
                  nodeId: "I_kwDOExample",
                  number: "42",
                  state: "open",
                  title: "Lifecycle",
                  url: "https://github.com/OpenCoven/coven-agents/issues/42",
                },
                kind: "issue.get",
                repository: "OpenCoven/coven-agents",
              })},
              "resultNodeId" = 'I_kwDOExample',
              "resultUrl" =
                'https://github.com/OpenCoven/coven-agents/issues/42'
          WHERE "id" = ${operationId}
        `;
      await transaction`
          INSERT INTO "RunnerGitHubOperation" (
            "id", "tenant", "teamStepId", "capabilityId", "operationId",
            "kind", "requestHash", "target", "repository",
            "requiredCapability", "connectionId", "connectionGeneration",
            "operationMarker", "status", "startedAt",
            "executionLeaseExpiresAt", "accountId", "accountLogin",
            "accountType", "installationId", "repositoryId",
            "repositoryName", "repositoryNodeId", "repositoryOwner",
            "providerDispatchPhase", "writeIntentActive"
          ) VALUES (
            ${releasedWriteId}, ${tenant}, ${teamStepId}, ${capabilityId},
            '10000000-0000-4000-8000-000000000019', 'issue.comment',
            ${writeRequestHash}, 'opencoven/coven-agents#issue.comment:42',
            'opencoven/coven-agents', 'github.issues.write', ${connectionId}, 0,
            '<!-- coven-github:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->',
            'running', clock_timestamp(), clock_timestamp() + interval '1 minute',
            ${accountId}, 'OpenCoven', 'Organization', ${installationId},
            ${repositoryId}, 'coven-agents', 'R_kgDOExample', 'OpenCoven',
            'pre_send', true
          )
        `;
      await transaction`
          UPDATE "RunnerGitHubOperation"
          SET "status" = 'pending',
              "error" = ${transaction.json({
                code: "github_provider_rate_limited",
                message: "GitHub provider execution failed.",
                retryable: true,
              })},
              "writeIntentActive" = false,
              "updatedAt" = clock_timestamp(),
              "version" = "version" + 1
          WHERE "id" = ${releasedWriteId}
        `;
      await transaction`
          INSERT INTO "RunnerGitHubOperation" (
            "id", "tenant", "teamStepId", "capabilityId", "operationId",
            "kind", "requestHash", "target", "repository",
            "requiredCapability", "connectionId", "connectionGeneration",
            "operationMarker", "status", "startedAt",
            "executionLeaseExpiresAt", "accountId", "accountLogin",
            "accountType", "installationId", "repositoryId",
            "repositoryName", "repositoryNodeId", "repositoryOwner",
            "providerDispatchPhase", "writeIntentActive"
          ) VALUES (
            ${freshWriteId}, ${tenant}, ${teamStepId}, ${capabilityId},
            '10000000-0000-4000-8000-000000000020', 'issue.comment',
            ${writeRequestHash}, 'opencoven/coven-agents#issue.comment:42',
            'opencoven/coven-agents', 'github.issues.write', ${connectionId}, 0,
            '<!-- coven-github:v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb -->',
            'running', clock_timestamp(), clock_timestamp() + interval '1 minute',
            ${accountId}, 'OpenCoven', 'Organization', ${installationId},
            ${repositoryId}, 'coven-agents', 'R_kgDOExample', 'OpenCoven',
            'pre_send', true
          )
        `;
    });

    const [capabilityModule, teamStoreModule] = await Promise.all([
      import("./capability"),
      import("@/lib/teams/store"),
    ]);
    const operator = { kind: "runner-operator" as const };
    const store = capabilityModule.createGitHubGatewayStore(
      teamStoreModule.drizzleTeamStoreDatabase(drizzle(sql))
    );
    const dispatched = await store.authorizeMutation(operator, {
      expectedVersion: 0,
      id: freshWriteId,
    });
    assert.equal(dispatched.kind, "authorized");
    assert.equal(
      dispatched.kind === "authorized" &&
        dispatched.operation.providerDispatchPhase,
      "sent"
    );
    assert.equal(
      dispatched.kind === "authorized" && dispatched.operation.version,
      1
    );

    await assert.rejects(
      sql`
          UPDATE "RunnerGitHubOperation"
          SET "status" = 'pending',
              "error" = jsonb_build_object(
                'code', 'github_provider_rate_limited',
                'message', 'GitHub provider execution failed.',
                'retryable', true
              ),
              "writeIntentActive" = false
          WHERE "id" = ${freshWriteId}
        `,
      /Sent GitHub operation dispatch state is immutable/u
    );
    const writeStates = await sql<
      {
        id: string;
        providerDispatchPhase: string;
        status: string;
        writeIntentActive: boolean;
      }[]
    >`
        SELECT "id", "providerDispatchPhase", "status", "writeIntentActive"
        FROM "RunnerGitHubOperation"
        WHERE "id" IN (${releasedWriteId}, ${freshWriteId})
        ORDER BY "id"
    `;
    assert.deepEqual(
      [...writeStates],
      [
        {
          id: releasedWriteId,
          providerDispatchPhase: "pre_send",
          status: "pending",
          writeIntentActive: false,
        },
        {
          id: freshWriteId,
          providerDispatchPhase: "sent",
          status: "running",
          writeIntentActive: true,
        },
      ]
    );

    await sql`
        UPDATE "RunnerGitHubConnectionFence"
        SET "generation" = 1, "updatedAt" = clock_timestamp()
        WHERE "tenant" = ${tenant}
      `;
    const deleted = await sql`
        DELETE FROM "RunnerGitHubConnection"
        WHERE "id" = ${connectionId} AND "tenant" = ${tenant}
        RETURNING "id"
      `;
    assert.equal(deleted.length, 1);

    const [state] = await sql<
      {
        connectionGeneration: string;
        connectionId: string | null;
        installationId: string;
        repositoryId: string;
        resultJson: unknown;
        revokedAt: Date | null;
      }[]
    >`
        SELECT
          "capability"."revokedAt",
          "operation"."connectionId",
          "operation"."connectionGeneration",
          "operation"."installationId",
          "operation"."repositoryId",
          "operation"."resultJson"
        FROM "RunnerGitHubCapability" AS "capability"
        JOIN "RunnerGitHubOperation" AS "operation"
          ON "operation"."capabilityId" = "capability"."id"
        WHERE "capability"."id" = ${capabilityId}
          AND "operation"."id" = ${operationId}
      `;
    assert.ok(state?.revokedAt);
    assert.equal(state.connectionId, null);
    assert.equal(Number(state.connectionGeneration), 0);
    assert.equal(state.installationId, installationId);
    assert.equal(state.repositoryId, repositoryId);
    assert.deepEqual(state.resultJson, {
      issue: {
        body: "",
        nodeId: "I_kwDOExample",
        number: "42",
        state: "open",
        title: "Lifecycle",
        url: "https://github.com/OpenCoven/coven-agents/issues/42",
      },
      kind: "issue.get",
      repository: "OpenCoven/coven-agents",
    });

    const stale = await store.reserveOperation(operator, {
      executionLeaseExpiresAt: new Date(Date.now() + 30_000),
      id: "10000000-0000-4000-8000-000000000016",
      operation: {
        issueNumber: "42",
        kind: "issue.get",
        owner: "OpenCoven",
        repo: "coven-agents",
      },
      operationId: "10000000-0000-4000-8000-000000000015",
      requestHash,
      target: "opencoven/coven-agents#issue.get:42",
      tokenHash,
    });
    assert.deepEqual(stale, { kind: "unauthorized" });
  } finally {
    await sql.end({ timeout: 5 });
  }
});
