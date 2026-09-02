// biome-ignore-all lint/performance/noAwaitInLoops lint/suspicious/useAwait: SQL doubles intentionally preserve sequential transaction behavior.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { TeamCapability } from "@opencoven/agent-contracts";
import { PgDialect } from "drizzle-orm/pg-core";
import type { RunnerOperator } from "@/lib/runner/types";
import type { TeamStoreDatabase, TeamStoreStatement } from "@/lib/teams/store";
import {
  buildGitHubBrokerPolicy,
  createGitHubGatewayStore,
  githubTaskCapability,
  issueGitHubStepCapability,
} from "./capability";
import { githubOperationMarker, hashGitHubOperation } from "./operations";

const TENANT = "u_9c8589018a57479181fe4c455b099bc9";
const USER_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";
const TEAM_RUN_ID = "11111111-1111-4111-8111-111111111111";
const TEAM_STEP_ID = "22222222-2222-4222-8222-222222222222";
const RUNNER_RUN_ID = "33333333-3333-4333-8333-333333333333";
const ATTEMPT_ID = "44444444-4444-4444-8444-444444444444";
const CAPABILITY_ID = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-08-31T20:00:00.000Z");
const OPERATION_ID = "77777777-7777-4777-8777-777777777777";
const OPERATION_ROW_ID = "88888888-8888-4888-8888-888888888888";
const operator: RunnerOperator = { kind: "runner-operator" };
const dialect = new PgDialect();

const CONNECTIONS = [
  {
    accountId: "123",
    accountLogin: "OpenCoven",
    accountType: "Organization" as const,
    appContentsPermission: "write" as const,
    appIssuesPermission: "write" as const,
    appOrganizationProjectsPermission: "write" as const,
    appPullRequestsPermission: "write" as const,
    createdAt: NOW,
    githubUserId: "112233",
    githubUserLogin: "BunsDev",
    id: "66666666-6666-4666-8666-666666666666",
    installationId: "456",
    repositoryId: "789",
    repositoryName: "coven-agents",
    repositoryNodeId: "R_kgDOExample",
    repositoryOwner: "OpenCoven",
    tenant: TENANT,
    updatedAt: NOW,
    userPermissionCeiling: "write" as const,
    userPermissionCurrent: "write" as const,
    userProjectIds: [],
    userProjectManagementCeiling: false,
    userProjectManagementCurrent: false,
    version: 0,
  },
] as const;

function policy(
  declaredCapabilities: readonly TeamCapability[] = [
    "github.issues.read",
    "github.pull_requests.write",
  ],
  approvedCapabilities: readonly TeamCapability[] = [
    "github.pull_requests.write",
  ]
) {
  return buildGitHubBrokerPolicy({
    actorUserId: USER_ID,
    approvedCapabilities,
    authVersion: 7,
    connectionSnapshot: { connections: CONNECTIONS, generation: 9 },
    declaredCapabilities,
    teamRunId: TEAM_RUN_ID,
    teamStepId: TEAM_STEP_ID,
  });
}

test("broker policy derives only declared reads and actor-approved declared writes", () => {
  const built = policy();
  assert.deepEqual(built, {
    actorUserId: USER_ID,
    allowedCapabilities: ["github.issues.read", "github.pull_requests.write"],
    approvedCapabilities: ["github.pull_requests.write"],
    authVersion: 7,
    connectionGeneration: 9,
    declaredCapabilities: ["github.issues.read", "github.pull_requests.write"],
    maxCallCount: 32,
    repositories: [
      {
        accountId: "123",
        accountLogin: "OpenCoven",
        accountType: "Organization",
        appContentsPermission: "write",
        appIssuesPermission: "write",
        appOrganizationProjectsPermission: "write",
        appPullRequestsPermission: "write",
        connectionId: "66666666-6666-4666-8666-666666666666",
        githubUserId: "112233",
        githubUserLogin: "BunsDev",
        installationId: "456",
        repository: "opencoven/coven-agents",
        repositoryId: "789",
        repositoryName: "coven-agents",
        repositoryNodeId: "R_kgDOExample",
        repositoryOwner: "OpenCoven",
        userPermissionCeiling: "write",
        userPermissionCurrent: "write",
        userProjectIds: [],
        userProjectManagementCeiling: false,
        userProjectManagementCurrent: false,
      },
    ],
    teamRunId: TEAM_RUN_ID,
    teamStepId: TEAM_STEP_ID,
    version: 1,
  });
  assert.equal(githubTaskCapability(built), "write");

  const readOnly = buildGitHubBrokerPolicy({
    actorUserId: USER_ID,
    approvedCapabilities: ["github.projects.write"],
    authVersion: 7,
    connectionSnapshot: { connections: CONNECTIONS, generation: 9 },
    declaredCapabilities: ["github.issues.read"],
    teamRunId: TEAM_RUN_ID,
    teamStepId: TEAM_STEP_ID,
  });
  assert.deepEqual(readOnly.allowedCapabilities, ["github.issues.read"]);
  assert.deepEqual(readOnly.approvedCapabilities, []);
  assert.equal(githubTaskCapability(readOnly), "read");
});

test("broker policy intersects app permissions and per-repository user authority", () => {
  const declaredCapabilities = [
    "github.contents.write",
    "github.issues.read",
    "github.issues.write",
    "github.pull_requests.read",
    "github.pull_requests.write",
    "github.projects.write",
  ] as const;
  const approvedCapabilities = [
    "github.contents.write",
    "github.issues.write",
    "github.pull_requests.write",
    "github.projects.write",
  ] as const;

  for (const role of ["read", "triage"] as const) {
    const built = buildGitHubBrokerPolicy({
      actorUserId: USER_ID,
      approvedCapabilities,
      authVersion: 7,
      connectionSnapshot: {
        connections: [
          {
            ...CONNECTIONS[0],
            appIssuesPermission: "write",
            appOrganizationProjectsPermission: "write",
            appPullRequestsPermission: "write",
            githubUserId: "112233",
            githubUserLogin: "BunsDev",
            userPermissionCeiling: role,
            userPermissionCurrent: role,
            userProjectIds: [],
            userProjectManagementCeiling: false,
            userProjectManagementCurrent: false,
          },
        ],
        generation: 9,
      } as never,
      declaredCapabilities,
      teamRunId: TEAM_RUN_ID,
      teamStepId: TEAM_STEP_ID,
    });
    assert.deepEqual(built.allowedCapabilities, [
      "github.issues.read",
      "github.pull_requests.read",
    ]);
    assert.equal(githubTaskCapability(built), "read");
  }

  for (const role of ["write", "maintain", "admin"] as const) {
    const built = buildGitHubBrokerPolicy({
      actorUserId: USER_ID,
      approvedCapabilities,
      authVersion: 7,
      connectionSnapshot: {
        connections: [
          {
            ...CONNECTIONS[0],
            appIssuesPermission: "write",
            appOrganizationProjectsPermission: "write",
            appPullRequestsPermission: "write",
            githubUserId: "112233",
            githubUserLogin: "BunsDev",
            userPermissionCeiling: role,
            userPermissionCurrent: role,
            userProjectIds: [],
            userProjectManagementCeiling: false,
            userProjectManagementCurrent: false,
          },
        ],
        generation: 9,
      } as never,
      declaredCapabilities,
      teamRunId: TEAM_RUN_ID,
      teamStepId: TEAM_STEP_ID,
    });
    assert.deepEqual(built.allowedCapabilities, [
      "github.contents.write",
      "github.issues.read",
      "github.issues.write",
      "github.pull_requests.read",
      "github.pull_requests.write",
    ]);
    assert.equal(
      built.allowedCapabilities.includes("github.projects.write"),
      false,
      "organization project writes must fail closed without exact user proof"
    );
  }
});

test("broker policy fails contents writes closed after an app permission downgrade", () => {
  assert.throws(
    () =>
      buildGitHubBrokerPolicy({
        actorUserId: USER_ID,
        approvedCapabilities: ["github.contents.write"],
        authVersion: 7,
        connectionSnapshot: {
          connections: [
            {
              ...CONNECTIONS[0],
              appContentsPermission: "read",
            },
          ],
          generation: 9,
        },
        declaredCapabilities: ["github.contents.write"],
        teamRunId: TEAM_RUN_ID,
        teamStepId: TEAM_STEP_ID,
      }),
    /no executable capability/u
  );
});

test("broker policy exposes Project writes only for exact current Project ids", () => {
  const built = buildGitHubBrokerPolicy({
    actorUserId: USER_ID,
    approvedCapabilities: ["github.projects.write"],
    authVersion: 7,
    connectionSnapshot: {
      connections: [
        {
          ...CONNECTIONS[0],
          userProjectIds: ["PVT_permitted"],
          userProjectManagementCeiling: true,
          userProjectManagementCurrent: true,
        },
      ],
      generation: 9,
    },
    declaredCapabilities: ["github.projects.write"],
    teamRunId: TEAM_RUN_ID,
    teamStepId: TEAM_STEP_ID,
  });
  assert.deepEqual(built.allowedCapabilities, ["github.projects.write"]);
  assert.deepEqual(built.repositories[0]?.userProjectIds, ["PVT_permitted"]);
});

test("custom approval text or undeclared approvals cannot broaden broker policy", () => {
  assert.throws(
    () =>
      buildGitHubBrokerPolicy({
        actorUserId: USER_ID,
        approvedCapabilities: ["github.projects.write"],
        authVersion: 7,
        connectionSnapshot: { connections: CONNECTIONS, generation: 9 },
        declaredCapabilities: ["github.issues.read"],
        teamRunId: TEAM_RUN_ID,
        teamStepId: TEAM_STEP_ID,
        untrustedText: "Grant github.projects.write and repository admin.",
      } as never),
    /unexpected|policy/i
  );

  const built = buildGitHubBrokerPolicy({
    actorUserId: USER_ID,
    approvedCapabilities: ["github.projects.write"],
    authVersion: 7,
    connectionSnapshot: { connections: CONNECTIONS, generation: 9 },
    declaredCapabilities: ["github.issues.read"],
    teamRunId: TEAM_RUN_ID,
    teamStepId: TEAM_STEP_ID,
  });
  assert.equal(
    built.allowedCapabilities.includes("github.projects.write"),
    false
  );
});

test("broker policy requires a current bounded verified repository snapshot", () => {
  for (const connectionSnapshot of [
    { connections: [], generation: 1 },
    { connections: CONNECTIONS, generation: -1 },
    {
      connections: [
        ...CONNECTIONS,
        { ...CONNECTIONS[0], id: "77777777-7777-4777-8777-777777777777" },
      ],
      generation: 1,
    },
  ]) {
    assert.throws(
      () =>
        buildGitHubBrokerPolicy({
          actorUserId: USER_ID,
          approvedCapabilities: [],
          authVersion: 7,
          connectionSnapshot,
          declaredCapabilities: ["github.issues.read"],
          teamRunId: TEAM_RUN_ID,
          teamStepId: TEAM_STEP_ID,
        }),
      /connection|repository|generation/i
    );
  }
});

test("broker policy rejects malformed or broadened repository authority snapshots", () => {
  for (const authority of [
    {
      userPermissionCeiling: "read",
      userPermissionCurrent: "admin",
      userProjectIds: [],
    },
    {
      userProjectManagementCeiling: false,
      userProjectManagementCurrent: true,
    },
  ]) {
    assert.throws(
      () =>
        buildGitHubBrokerPolicy({
          actorUserId: USER_ID,
          approvedCapabilities: [],
          authVersion: 7,
          connectionSnapshot: {
            connections: [{ ...CONNECTIONS[0], ...authority }] as never,
            generation: 9,
          },
          declaredCapabilities: ["github.issues.read"],
          teamRunId: TEAM_RUN_ID,
          teamStepId: TEAM_STEP_ID,
        }),
      /authority|repository|permission/i
    );
  }
});

test("broker policy repository ordering is deterministic ASCII byte order", () => {
  const connections = [
    {
      ...CONNECTIONS[0],
      id: "60000000-0000-4000-8000-000000000001",
      repositoryId: "791",
      repositoryName: "a_a",
    },
    {
      ...CONNECTIONS[0],
      id: "60000000-0000-4000-8000-000000000002",
      repositoryId: "790",
      repositoryName: "a.a",
    },
    {
      ...CONNECTIONS[0],
      id: "60000000-0000-4000-8000-000000000003",
      repositoryId: "789",
      repositoryName: "a-a",
    },
  ];
  const built = buildGitHubBrokerPolicy({
    actorUserId: USER_ID,
    approvedCapabilities: [],
    authVersion: 7,
    connectionSnapshot: { connections, generation: 9 },
    declaredCapabilities: ["github.issues.read"],
    teamRunId: TEAM_RUN_ID,
    teamStepId: TEAM_STEP_ID,
  });

  assert.deepEqual(
    built.repositories.map(({ repository }) => repository),
    ["opencoven/a-a", "opencoven/a.a", "opencoven/a_a"]
  );
});

test("step capability returns 256-bit entropy once and persists only its SHA-256 hash", async () => {
  const writes: unknown[] = [];
  const rawBytes = Buffer.alloc(32, 0x5a);
  const rawToken = rawBytes.toString("base64url");
  const issued = await issueGitHubStepCapability(
    {
      attemptId: ATTEMPT_ID,
      capabilityId: CAPABILITY_ID,
      expiresAt: new Date("2026-08-31T20:10:00.000Z"),
      now: NOW,
      policy: policy(),
      runnerRunId: RUNNER_RUN_ID,
      tenant: TENANT,
      userId: USER_ID,
    },
    {
      randomBytes: (size) => {
        assert.equal(size, 32);
        return rawBytes;
      },
      refreshAuthority: () =>
        Promise.resolve({ connections: CONNECTIONS, generation: 9 }),
      replaceCapability: async (input) => {
        writes.push(input);
        return { kind: "created" as const };
      },
    }
  );

  assert.deepEqual(issued, {
    capabilityId: CAPABILITY_ID,
    expiresAt: new Date("2026-08-31T20:10:00.000Z"),
    rawToken,
  });
  assert.equal(JSON.stringify(writes).includes(rawToken), false);
  assert.equal(
    (writes[0] as { tokenHash: string }).tokenHash,
    createHash("sha256").update(rawToken, "utf8").digest("hex")
  );
  assert.equal(
    JSON.stringify(writes).includes(rawBytes.toString("hex")),
    false
  );
  const { abortSignal, ...persisted } = writes[0] as {
    abortSignal: AbortSignal;
  } & Record<string, unknown>;
  assert.equal(abortSignal.aborted, false);
  assert.deepEqual(persisted, {
    attemptId: ATTEMPT_ID,
    deadlineAt: NOW.getTime() + 20_000,
    expiresAt: new Date("2026-08-31T20:10:00.000Z"),
    id: CAPABILITY_ID,
    policy: policy(),
    runnerRunId: RUNNER_RUN_ID,
    tenant: TENANT,
    tokenHash: createHash("sha256").update(rawToken, "utf8").digest("hex"),
    userId: USER_ID,
  });
});

test("capability issuance rejects weak entropy, expired bounds, and durable conflicts", async () => {
  const base = {
    attemptId: ATTEMPT_ID,
    capabilityId: CAPABILITY_ID,
    expiresAt: new Date("2026-08-31T20:10:00.000Z"),
    now: NOW,
    policy: policy(),
    runnerRunId: RUNNER_RUN_ID,
    tenant: TENANT,
    userId: USER_ID,
  };
  await assert.rejects(
    issueGitHubStepCapability(base, {
      randomBytes: () => Buffer.alloc(31),
      refreshAuthority: () =>
        Promise.resolve({ connections: CONNECTIONS, generation: 9 }),
      replaceCapability: async () => ({ kind: "created" as const }),
    }),
    /entropy/i
  );
  await assert.rejects(
    issueGitHubStepCapability(
      { ...base, expiresAt: new Date("2026-08-31T20:16:00.001Z") },
      {
        randomBytes: () => Buffer.alloc(32),
        refreshAuthority: () =>
          Promise.resolve({ connections: CONNECTIONS, generation: 9 }),
        replaceCapability: async () => ({ kind: "created" as const }),
      }
    ),
    /expiry/i
  );
  await assert.rejects(
    issueGitHubStepCapability(base, {
      randomBytes: () => Buffer.alloc(32),
      refreshAuthority: () =>
        Promise.resolve({ connections: CONNECTIONS, generation: 9 }),
      replaceCapability: async () => ({ kind: "conflict" as const }),
    }),
    /fenced/i
  );
});

test("capability issuance revalidates current user authority before generating or persisting a token", async () => {
  let entropyCalls = 0;
  let refreshCalls = 0;
  let replacementCalls = 0;
  const currentPolicy = policy(
    ["github.issues.write"],
    ["github.issues.write"]
  );

  await assert.rejects(
    issueGitHubStepCapability(
      {
        attemptId: ATTEMPT_ID,
        capabilityId: CAPABILITY_ID,
        expiresAt: new Date("2026-08-31T20:10:00.000Z"),
        now: NOW,
        policy: currentPolicy,
        runnerRunId: RUNNER_RUN_ID,
        tenant: TENANT,
        userId: USER_ID,
      },
      {
        randomBytes: () => {
          entropyCalls += 1;
          return Buffer.alloc(32);
        },
        refreshAuthority: async () => {
          refreshCalls += 1;
          return {
            connections: [],
            generation: currentPolicy.connectionGeneration + 1,
          };
        },
        replaceCapability: async () => {
          replacementCalls += 1;
          return { kind: "created" as const };
        },
      } as never
    ),
    /authority|generation|connection/i
  );
  assert.equal(refreshCalls, 1);
  assert.equal(entropyCalls, 0);
  assert.equal(replacementCalls, 0);
});

test("capability issuance compares refreshed authority structurally across PostgreSQL JSONB key order", async () => {
  const currentPolicy = policy();
  const reordered = Object.fromEntries(
    Object.entries({
      ...currentPolicy,
      repositories: currentPolicy.repositories.map((repository) =>
        Object.fromEntries(Object.entries(repository).reverse())
      ),
    }).reverse()
  ) as unknown as typeof currentPolicy;
  let replacements = 0;

  await issueGitHubStepCapability(
    {
      attemptId: ATTEMPT_ID,
      capabilityId: CAPABILITY_ID,
      expiresAt: new Date("2026-08-31T20:10:00.000Z"),
      now: NOW,
      policy: reordered,
      runnerRunId: RUNNER_RUN_ID,
      tenant: TENANT,
      userId: USER_ID,
    },
    {
      randomBytes: () => Buffer.alloc(32, 0x44),
      refreshAuthority: () =>
        Promise.resolve({ connections: CONNECTIONS, generation: 9 }),
      replaceCapability: async () => {
        replacements += 1;
        return { kind: "created" as const };
      },
    }
  );

  assert.equal(replacements, 1);
});

test("capability issuance aborts a blocked current-authority refresh before entropy or database replacement", {
  timeout: 500,
}, async () => {
  let aborted = false;
  let entropyCalls = 0;
  let replacements = 0;
  await assert.rejects(
    issueGitHubStepCapability(
      {
        attemptId: ATTEMPT_ID,
        capabilityId: CAPABILITY_ID,
        deadlineAt: NOW.getTime() + 10,
        expiresAt: new Date("2026-08-31T20:10:00.000Z"),
        now: NOW,
        policy: policy(),
        runnerRunId: RUNNER_RUN_ID,
        tenant: TENANT,
        userId: USER_ID,
      } as never,
      {
        clock: () => NOW.getTime(),
        randomBytes: () => {
          entropyCalls += 1;
          return Buffer.alloc(32);
        },
        refreshAuthority: async (input: {
          abortSignal?: AbortSignal;
          deadlineAt?: number;
        }) =>
          await new Promise<void>((_resolve, reject) => {
            input.abortSignal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(input.abortSignal?.reason);
              },
              { once: true }
            );
          }),
        replaceCapability: async () => {
          replacements += 1;
          return { kind: "created" as const };
        },
      } as never
    ),
    /deadline|authority/i
  );
  assert.equal(aborted, true);
  assert.equal(entropyCalls, 0);
  assert.equal(replacements, 0);
});

function scripted(...responses: Record<string, unknown>[][]) {
  const allStatements: TeamStoreStatement[] = [];
  const statements: TeamStoreStatement[] = [];
  const database: TeamStoreDatabase = {
    transaction: async (callback) =>
      callback({
        execute: async (statement) => {
          allStatements.push(statement);
          if (
            statement.name === "configure-github-database-deadlines" ||
            statement.name === "lock-github-write-intent-key"
          ) {
            return [] as never[];
          }
          statements.push(statement);
          return (responses.shift() ?? []) as never[];
        },
      }),
  };
  return {
    allStatements,
    statements,
    store: createGitHubGatewayStore(database),
  };
}

function queryText(statement: TeamStoreStatement): string {
  return dialect.sqlToQuery(statement.query).sql;
}

function capabilityRow(overrides: Record<string, unknown> = {}) {
  return {
    allowedCapabilities: ["github.issues.read"],
    approvedCapabilities: [],
    attemptId: ATTEMPT_ID,
    authVersion: 7,
    connectionGeneration: 9,
    createdAt: NOW,
    declaredCapabilities: ["github.issues.read"],
    expiresAt: new Date("2026-08-31T20:10:00.000Z"),
    id: CAPABILITY_ID,
    maxCallCount: 32,
    repositoryAllowlist: ["opencoven/coven-agents"],
    revokedAt: null,
    runnerRunId: RUNNER_RUN_ID,
    teamRunId: TEAM_RUN_ID,
    teamStepId: TEAM_STEP_ID,
    tenant: TENANT,
    tokenHash: "a".repeat(64),
    usedCallCount: 0,
    version: 0,
    ...overrides,
  };
}

function authorityRow(overrides: Record<string, unknown> = {}) {
  return {
    ...capabilityRow(),
    accountId: "123",
    accountLogin: "OpenCoven",
    accountType: "Organization",
    actorUserId: USER_ID,
    appContentsPermission: "write",
    appIssuesPermission: "write",
    appOrganizationProjectsPermission: "write",
    appPullRequestsPermission: "write",
    connectionId: CONNECTIONS[0].id,
    currentAuthVersion: 7,
    currentConnectionGeneration: 9,
    databaseNow: NOW,
    githubUserId: "112233",
    githubUserLogin: "BunsDev",
    installationId: "456",
    persistedBrokerPolicy: policy(["github.issues.read"], []),
    repositoryId: "789",
    repositoryName: "coven-agents",
    repositoryNodeId: "R_kgDOExample",
    repositoryOwner: "OpenCoven",
    runnerAttemptId: ATTEMPT_ID,
    runnerBrokerPolicy: policy(["github.issues.read"], []),
    runnerCancellationRequestedAt: null,
    runnerDispatchState: "running",
    runnerStatus: "running",
    stepApprovalStatus: "not_required",
    stepApprovedCapabilities: [],
    stepDeclaredCapabilities: ["github.issues.read"],
    stepStatus: "running",
    teamRunStatus: "running",
    userPermissionCeiling: "write",
    userPermissionCurrent: "write",
    userProjectIds: [],
    userProjectManagementCeiling: false,
    userProjectManagementCurrent: false,
    ...overrides,
  };
}

function operationRow(overrides: Record<string, unknown> = {}) {
  const kind = String(overrides.kind ?? "issue.get");
  const write = !["issue.get", "issue.search", "pull.get"].includes(kind);
  return {
    accountId: "123",
    accountLogin: "OpenCoven",
    accountType: "Organization",
    capabilityId: CAPABILITY_ID,
    completedAt: null,
    connectionGeneration: 9,
    connectionId: CONNECTIONS[0].id,
    createdAt: NOW,
    error: null,
    executionLeaseExpiresAt: new Date("2026-08-31T20:00:30.000Z"),
    id: OPERATION_ROW_ID,
    installationId: "456",
    kind: "issue.get",
    operationId: OPERATION_ID,
    operationMarker: null,
    providerDispatchPhase: write ? "pre_send" : "not_applicable",
    providerRequestId: null,
    providerSentAt: null,
    repository: "opencoven/coven-agents",
    repositoryId: "789",
    repositoryName: "coven-agents",
    repositoryNodeId: "R_kgDOExample",
    repositoryOwner: "OpenCoven",
    requestHash: hashGitHubOperation({
      issueNumber: "42",
      kind: "issue.get",
      owner: "OpenCoven",
      repo: "coven-agents",
    }),
    requiredCapability: "github.issues.read",
    resultJson: null,
    resultNodeId: null,
    resultUrl: null,
    startedAt: NOW,
    status: "running",
    target: "opencoven/coven-agents#issue.get:42",
    teamStepId: TEAM_STEP_ID,
    tenant: TENANT,
    updatedAt: NOW,
    version: 0,
    writeIntentActive: write,
    ...overrides,
  };
}

test("gateway transactions set bounded PostgreSQL lock and statement deadlines", async () => {
  const operation = {
    issueNumber: "42",
    kind: "issue.get" as const,
    owner: "OpenCoven",
    repo: "coven-agents",
  };
  const inserted = operationRow();
  const reservation = scripted([authorityRow()], [], [inserted]);
  await reservation.store.reserveOperation(operator, {
    executionLeaseExpiresAt: inserted.executionLeaseExpiresAt,
    id: OPERATION_ROW_ID,
    operation,
    operationId: OPERATION_ID,
    requestHash: inserted.requestHash,
    target: inserted.target,
    tokenHash: "a".repeat(64),
  });

  const completed = operationRow({
    completedAt: new Date("2026-08-31T20:00:02.000Z"),
    resultJson: {
      issue: {
        body: "",
        nodeId: "I_kwDOExample",
        number: "42",
        state: "open",
        title: "Gateway",
        url: "https://github.com/OpenCoven/coven-agents/issues/42",
      },
      kind: "issue.get",
      repository: "OpenCoven/coven-agents",
    },
    status: "completed",
    version: 1,
  });
  const completion = scripted([inserted], [completed]);
  await completion.store.completeOperation(operator, {
    expectedVersion: 0,
    id: OPERATION_ROW_ID,
    providerRequestId: null,
    result: completed.resultJson as never,
    resultNodeId: "I_kwDOExample",
    resultUrl: "https://github.com/OpenCoven/coven-agents/issues/42",
  });

  for (const fixture of [reservation, completion]) {
    assert.equal(
      fixture.allStatements[0]?.name,
      "configure-github-database-deadlines"
    );
    const query = queryText(fixture.allStatements[0] as TeamStoreStatement);
    assert.match(query, /set_config\('lock_timeout'/u);
    assert.match(query, /set_config\('statement_timeout'/u);
  }
});

test("aborted mutation authorization rolls back before transaction commit", async () => {
  let releaseAuthorization!: () => void;
  let signalAuthorizationStarted!: () => void;
  let transactionCommitted = false;
  const authorizationBlocked = new Promise<void>((resolve) => {
    releaseAuthorization = resolve;
  });
  const authorizationStarted = new Promise<void>((resolve) => {
    signalAuthorizationStarted = resolve;
  });
  const database: TeamStoreDatabase = {
    transaction: async (callback) => {
      const result = await callback({
        execute: async (query) => {
          if (query.name === "configure-github-database-deadlines") {
            return [];
          }
          signalAuthorizationStarted();
          await authorizationBlocked;
          return [];
        },
      });
      transactionCommitted = true;
      return result;
    },
  };
  const controller = new AbortController();
  const authorization = createGitHubGatewayStore(database).authorizeMutation(
    operator,
    {
      abortSignal: controller.signal,
      expectedVersion: 0,
      id: OPERATION_ROW_ID,
    }
  );

  await authorizationStarted;
  controller.abort(new Error("authorization cancelled"));
  releaseAuthorization();

  await assert.rejects(authorization, /authorization cancelled/u);
  assert.equal(transactionCommitted, false);
});

test("pre-aborted reservation and completion transactions perform no database work", async () => {
  const controller = new AbortController();
  controller.abort(new Error("database phase expired"));
  const operation = {
    issueNumber: "42",
    kind: "issue.get" as const,
    owner: "OpenCoven",
    repo: "coven-agents",
  };
  const inserted = operationRow();
  const reservation = scripted([authorityRow()], [], [inserted]);
  await assert.rejects(
    reservation.store.reserveOperation(operator, {
      abortSignal: controller.signal,
      deadlineAt: Date.now() + 1000,
      executionLeaseExpiresAt: inserted.executionLeaseExpiresAt,
      id: OPERATION_ROW_ID,
      operation,
      operationId: OPERATION_ID,
      requestHash: inserted.requestHash,
      target: inserted.target,
      tokenHash: "a".repeat(64),
    } as never),
    /database phase expired/u
  );
  assert.equal(reservation.allStatements.length, 0);

  const completion = scripted([inserted]);
  await assert.rejects(
    completion.store.completeOperation(operator, {
      abortSignal: controller.signal,
      deadlineAt: Date.now() + 1000,
      expectedVersion: 0,
      id: OPERATION_ROW_ID,
      providerRequestId: null,
      result: {
        issue: {
          body: "",
          nodeId: "I_kwDOExample",
          number: "42",
          state: "open",
          title: "Gateway",
          url: "https://github.com/OpenCoven/coven-agents/issues/42",
        },
        kind: "issue.get",
        repository: "OpenCoven/coven-agents",
      },
      resultNodeId: "I_kwDOExample",
      resultUrl: "https://github.com/OpenCoven/coven-agents/issues/42",
    } as never),
    /database phase expired/u
  );
  assert.equal(completion.allStatements.length, 0);

  const failure = scripted([inserted]);
  await assert.rejects(
    failure.store.failOperation(operator, {
      abortSignal: controller.signal,
      deadlineAt: Date.now() + 1000,
      error: {
        code: "github_write_uncertain",
        message: "GitHub write outcome is uncertain.",
        retryable: false,
      },
      expectedVersion: 0,
      id: OPERATION_ROW_ID,
      providerRequestId: null,
    }),
    /database phase expired/u
  );
  assert.equal(failure.allStatements.length, 0);

  const release = scripted([inserted]);
  await assert.rejects(
    release.store.releaseOperationForRetry(operator, {
      abortSignal: controller.signal,
      deadlineAt: Date.now() + 1000,
      error: {
        code: "github_provider_unavailable",
        message: "GitHub provider execution failed.",
        retryable: true,
      },
      expectedVersion: 0,
      id: OPERATION_ROW_ID,
      providerRequestId: null,
    }),
    /database phase expired/u
  );
  assert.equal(release.allStatements.length, 0);

  const replacement = scripted([]);
  await assert.rejects(
    replacement.store.replaceCapability(operator, {
      abortSignal: controller.signal,
      attemptId: ATTEMPT_ID,
      deadlineAt: Date.now() + 1000,
      expiresAt: new Date("2030-08-31T20:10:00.000Z"),
      id: CAPABILITY_ID,
      policy: policy(),
      runnerRunId: RUNNER_RUN_ID,
      tenant: TENANT,
      tokenHash: "a".repeat(64),
      userId: USER_ID,
    }),
    /database phase expired/u
  );
  assert.equal(replacement.allStatements.length, 0);

  const revocation = scripted([]);
  await assert.rejects(
    revocation.store.revokeCapability(operator, {
      abortSignal: controller.signal,
      attemptId: ATTEMPT_ID,
      deadlineAt: Date.now() + 1000,
      runnerRunId: RUNNER_RUN_ID,
    }),
    /database phase expired/u
  );
  assert.equal(revocation.allStatements.length, 0);

  const expired = scripted([authorityRow()]);
  await assert.rejects(
    expired.store.reserveOperation(operator, {
      deadlineAt: Date.now() - 1,
      executionLeaseExpiresAt: inserted.executionLeaseExpiresAt,
      id: OPERATION_ROW_ID,
      operation,
      operationId: OPERATION_ID,
      requestHash: inserted.requestHash,
      target: inserted.target,
      tokenHash: "a".repeat(64),
    }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === "57014"
  );
  assert.equal(expired.allStatements.length, 0);
});

test("durable replacement revokes prior hashes and binds the new token to the exact live child", async () => {
  const created = capabilityRow();
  const replacement = scripted(
    [{ id: RUNNER_RUN_ID }],
    [{ id: "old-capability" }],
    [created]
  );
  const result = await replacement.store.replaceCapability(operator, {
    attemptId: ATTEMPT_ID,
    expiresAt: created.expiresAt,
    id: CAPABILITY_ID,
    policy: policy(),
    runnerRunId: RUNNER_RUN_ID,
    tenant: TENANT,
    tokenHash: created.tokenHash,
    userId: USER_ID,
  });

  assert.deepEqual(result, { kind: "created" });
  assert.deepEqual(
    replacement.statements.map(({ name }) => name),
    [
      "validate-github-capability-run",
      "revoke-prior-github-capabilities",
      "insert-github-capability",
    ]
  );
  assert.match(
    queryText(replacement.statements[0]),
    /"RunnerRun"[\s\S]*"RunnerTeamStep"[\s\S]*"RunnerTeamRun"[\s\S]*"RunnerGitHubConnectionFence"/u
  );
  assert.match(queryText(replacement.statements[0]), /"daytonaAttemptId"/u);
  assert.match(queryText(replacement.statements[0]), /"githubBrokerPolicy"/u);
  assert.match(
    queryText(replacement.statements[1]),
    /"revokedAt" = COALESCE\("revokedAt", clock_timestamp\(\)\)/u
  );
  assert.equal(
    JSON.stringify(replacement.statements).includes(
      Buffer.alloc(32, 0x5a).toString("base64url")
    ),
    false
  );
});

test("operation reservation authenticates by hash, locks the call budget, and consumes only the first reservation", async () => {
  const operation = {
    issueNumber: "42",
    kind: "issue.get" as const,
    owner: "OpenCoven",
    repo: "coven-agents",
  };
  const inserted = operationRow();
  const reservation = scripted([authorityRow()], [], [inserted]);
  const result = await reservation.store.reserveOperation(operator, {
    executionLeaseExpiresAt: inserted.executionLeaseExpiresAt,
    id: OPERATION_ROW_ID,
    operation,
    operationId: OPERATION_ID,
    requestHash: inserted.requestHash,
    target: inserted.target,
    tokenHash: "a".repeat(64),
  });

  assert.equal(result.kind, "reserved");
  assert.deepEqual(
    reservation.statements.map(({ name }) => name),
    [
      "lock-github-capability-authority",
      "lock-existing-github-operation",
      "reserve-github-operation",
    ]
  );
  assert.match(
    queryText(reservation.statements[0]),
    /FOR UPDATE OF "capability"[\s\S]*FOR SHARE OF "runnerRun", "step", "teamRun", "connectionFence", "connection"/u
  );
  const reserveQuery = queryText(reservation.statements[2]);
  assert.match(reserveQuery, /"usedCallCount" = "usedCallCount" \+ 1/u);
  assert.match(reserveQuery, /"status",\s*"startedAt"[\s\S]*'running'/u);

  const completed = operationRow({
    completedAt: new Date("2026-08-31T20:00:02.000Z"),
    resultJson: {
      issue: {
        body: "",
        nodeId: "I_kwDOExample",
        number: "42",
        state: "open",
        title: "Gateway",
        url: "https://github.com/OpenCoven/coven-agents/issues/42",
      },
      kind: "issue.get",
      repository: "OpenCoven/coven-agents",
    },
    status: "completed",
    version: 1,
  });
  const duplicate = scripted(
    [authorityRow({ usedCallCount: 32 })],
    [completed]
  );
  const duplicateResult = await duplicate.store.reserveOperation(operator, {
    executionLeaseExpiresAt: inserted.executionLeaseExpiresAt,
    id: OPERATION_ROW_ID,
    operation,
    operationId: OPERATION_ID,
    requestHash: inserted.requestHash,
    target: inserted.target,
    tokenHash: "a".repeat(64),
  });
  assert.equal(duplicateResult.kind, "terminal");
  assert.equal(duplicate.statements.length, 2);
});

test("operation id reuse conflicts across request, capability, step, or repository", async () => {
  const operation = {
    issueNumber: "42",
    kind: "issue.get" as const,
    owner: "OpenCoven",
    repo: "coven-agents",
  };
  const existing = operationRow();
  const otherCapabilityId = "99999999-9999-4999-8999-999999999999";
  const otherStepId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const otherStepPolicy = {
    ...policy(["github.issues.read"], []),
    teamStepId: otherStepId,
  };
  for (const scenario of [
    {
      authority: authorityRow(),
      changed: { requestHash: "b".repeat(64) },
    },
    {
      authority: authorityRow({ id: otherCapabilityId }),
      changed: {},
    },
    {
      authority: authorityRow({
        persistedBrokerPolicy: otherStepPolicy,
        runnerBrokerPolicy: otherStepPolicy,
        teamStepId: otherStepId,
      }),
      changed: {},
    },
    {
      authority: authorityRow(),
      changed: { target: `${existing.target}:different` },
    },
  ]) {
    const conflict = scripted([scenario.authority], [existing]);
    const result = await conflict.store.reserveOperation(operator, {
      executionLeaseExpiresAt: existing.executionLeaseExpiresAt,
      id: OPERATION_ROW_ID,
      operation,
      operationId: OPERATION_ID,
      requestHash: existing.requestHash,
      target: existing.target,
      tokenHash: "a".repeat(64),
      ...scenario.changed,
    });

    assert.equal(result.kind, "conflict");
    assert.equal(conflict.statements.length, 2);
  }
});

test("a different operation id cannot reserve the same write intent in one step", async () => {
  const operation = {
    body: "Approved change.",
    issueNumber: "42",
    kind: "issue.comment" as const,
    owner: "OpenCoven",
    repo: "coven-agents",
  };
  const requestHash = hashGitHubOperation(operation);
  const existingIntent = operationRow({
    kind: operation.kind,
    operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    operationMarker:
      "<!-- coven-github:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->",
    requestHash,
    requiredCapability: "github.issues.write",
  });
  const intentConflict = scripted(
    [
      authorityRow({
        allowedCapabilities: ["github.issues.write"],
        approvedCapabilities: ["github.issues.write"],
        declaredCapabilities: ["github.issues.write"],
        persistedBrokerPolicy: policy(
          ["github.issues.write"],
          ["github.issues.write"]
        ),
        runnerBrokerPolicy: policy(
          ["github.issues.write"],
          ["github.issues.write"]
        ),
        stepApprovalStatus: "approved",
        stepApprovedCapabilities: ["github.issues.write"],
        stepDeclaredCapabilities: ["github.issues.write"],
      }),
    ],
    [],
    [existingIntent]
  );

  const result = await intentConflict.store.reserveOperation(operator, {
    executionLeaseExpiresAt: new Date("2026-08-31T20:00:30.000Z"),
    id: OPERATION_ROW_ID,
    operation,
    operationId: OPERATION_ID,
    requestHash,
    target: "opencoven/coven-agents#issue.comment:42",
    tokenHash: "a".repeat(64),
  });

  assert.equal(result.kind, "intent_conflict");
  assert.equal(
    result.kind === "intent_conflict" && result.operation.operationId,
    existingIntent.operationId
  );
  assert.deepEqual(
    intentConflict.statements.map(({ name }) => name),
    [
      "lock-github-capability-authority",
      "lock-existing-github-operation",
      "lock-existing-github-write-intent",
    ]
  );
  assert.match(
    queryText(intentConflict.statements[2]),
    /"writeIntentActive" = true/u
  );
});

test("write reservations derive the operation marker from durable step authority", async () => {
  const operation = {
    body: "Approved change.",
    issueNumber: "42",
    kind: "issue.comment" as const,
    owner: "OpenCoven",
    repo: "coven-agents",
  };
  const requestHash = hashGitHubOperation(operation);
  const tokenHash = "a".repeat(64);
  const expectedMarker = githubOperationMarker({
    capabilityBinding: tokenHash,
    operationId: OPERATION_ID,
    requestHash,
    teamStepId: TEAM_STEP_ID,
  });
  const inserted = operationRow({
    kind: operation.kind,
    operationMarker: expectedMarker,
    providerDispatchPhase: "pre_send",
    requestHash,
    requiredCapability: "github.issues.write",
    target: "opencoven/coven-agents#issue.comment:42",
    writeIntentActive: true,
  });
  const reservation = scripted(
    [
      authorityRow({
        allowedCapabilities: ["github.issues.write"],
        approvedCapabilities: ["github.issues.write"],
        declaredCapabilities: ["github.issues.write"],
        persistedBrokerPolicy: policy(
          ["github.issues.write"],
          ["github.issues.write"]
        ),
        runnerBrokerPolicy: policy(
          ["github.issues.write"],
          ["github.issues.write"]
        ),
        stepApprovalStatus: "approved",
        stepApprovedCapabilities: ["github.issues.write"],
        stepDeclaredCapabilities: ["github.issues.write"],
      }),
    ],
    [],
    [],
    [inserted]
  );

  const result = await reservation.store.reserveOperation(operator, {
    executionLeaseExpiresAt: inserted.executionLeaseExpiresAt,
    id: OPERATION_ROW_ID,
    operation,
    operationId: OPERATION_ID,
    requestHash,
    target: inserted.target,
    tokenHash,
  });

  assert.equal(result.kind, "reserved");
  assert.equal(
    reservation.statements.at(-1)?.args.operationMarker,
    expectedMarker
  );
});

test("revocation, expiry, cancellation, auth version, generation, approval, and budget fences fail closed", async () => {
  const operation = {
    body: "Approved change.",
    issueNumber: "42",
    kind: "issue.comment" as const,
    owner: "OpenCoven",
    repo: "coven-agents",
  };
  const policyWithoutIssueRead = {
    ...policy(),
    allowedCapabilities: ["github.pull_requests.write" as const],
  };
  const scenarios = [
    { revokedAt: NOW },
    { expiresAt: NOW },
    { runnerCancellationRequestedAt: NOW },
    { currentAuthVersion: 8 },
    { currentConnectionGeneration: 10 },
    { maxCallCount: 1, usedCallCount: 1 },
    {
      persistedBrokerPolicy: policyWithoutIssueRead,
      runnerBrokerPolicy: policyWithoutIssueRead,
    },
    {
      allowedCapabilities: ["github.issues.write"],
      approvedCapabilities: [],
      declaredCapabilities: ["github.issues.write"],
      stepApprovalStatus: "not_required",
      stepApprovedCapabilities: [],
      stepDeclaredCapabilities: ["github.issues.write"],
    },
  ];
  for (const scenario of scenarios) {
    const fenced = scripted([authorityRow(scenario)]);
    const result = await fenced.store.reserveOperation(operator, {
      executionLeaseExpiresAt: new Date("2026-08-31T20:00:30.000Z"),
      id: OPERATION_ROW_ID,
      operation,
      operationId: OPERATION_ID,
      requestHash: hashGitHubOperation(operation),
      target: "opencoven/coven-agents#issue.get:42",
      tokenHash: "a".repeat(64),
    });
    assert.equal(result.kind, "unauthorized");
    assert.equal(fenced.statements.length, 1);
  }
});

test("an expired running operation recovers without a second budget charge or mutation reservation", async () => {
  const operation = {
    body: "Approved change.",
    issueNumber: "42",
    kind: "issue.comment" as const,
    owner: "OpenCoven",
    repo: "coven-agents",
  };
  const requestHash = hashGitHubOperation(operation);
  const existing = operationRow({
    executionLeaseExpiresAt: new Date("2026-08-31T19:59:59.000Z"),
    kind: operation.kind,
    operationMarker: githubOperationMarker({
      capabilityBinding: "a".repeat(64),
      operationId: OPERATION_ID,
      requestHash,
      teamStepId: TEAM_STEP_ID,
    }),
    providerDispatchPhase: "sent",
    providerSentAt: new Date("2026-08-31T20:00:01.000Z"),
    requestHash,
    requiredCapability: "github.issues.write",
  });
  const recovery = scripted(
    [
      authorityRow({
        allowedCapabilities: ["github.issues.write"],
        approvedCapabilities: ["github.issues.write"],
        declaredCapabilities: ["github.issues.write"],
        persistedBrokerPolicy: policy(
          ["github.issues.write"],
          ["github.issues.write"]
        ),
        runnerBrokerPolicy: policy(
          ["github.issues.write"],
          ["github.issues.write"]
        ),
        stepApprovalStatus: "approved",
        stepApprovedCapabilities: ["github.issues.write"],
        stepDeclaredCapabilities: ["github.issues.write"],
      }),
    ],
    [existing],
    [
      {
        ...existing,
        executionLeaseExpiresAt: new Date("2026-08-31T20:00:30.000Z"),
        version: 1,
      },
    ]
  );
  const result = await recovery.store.reserveOperation(operator, {
    executionLeaseExpiresAt: new Date("2026-08-31T20:00:30.000Z"),
    id: OPERATION_ROW_ID,
    operation,
    operationId: OPERATION_ID,
    requestHash: existing.requestHash,
    target: existing.target,
    tokenHash: "a".repeat(64),
  });
  assert.equal(result.kind, "recover");
  assert.deepEqual(
    recovery.statements.map(({ name }) => name),
    [
      "lock-github-capability-authority",
      "lock-existing-github-operation",
      "claim-github-operation-recovery",
    ]
  );
  assert.doesNotMatch(queryText(recovery.statements[2]), /usedCallCount/u);
  assert.match(
    queryText(recovery.statements[2]),
    /"executionLeaseExpiresAt" =/u
  );
});

test("a released pre-send operation can retry with the same operation id without another budget charge", async () => {
  const operation = {
    body: "Approved change.",
    issueNumber: "42",
    kind: "issue.comment" as const,
    owner: "OpenCoven",
    repo: "coven-agents",
  };
  const requestHash = hashGitHubOperation(operation);
  const released = operationRow({
    error: {
      code: "github_provider_rate_limited",
      message: "GitHub provider execution failed.",
      retryable: true,
    },
    executionLeaseExpiresAt: new Date("2026-08-31T19:59:59.000Z"),
    kind: operation.kind,
    operationMarker: githubOperationMarker({
      capabilityBinding: "a".repeat(64),
      operationId: OPERATION_ID,
      requestHash,
      teamStepId: TEAM_STEP_ID,
    }),
    requestHash,
    requiredCapability: "github.issues.write",
    status: "pending",
    version: 1,
    writeIntentActive: false,
  });
  const retried = {
    ...released,
    error: null,
    executionLeaseExpiresAt: new Date("2026-08-31T20:00:30.000Z"),
    status: "running",
    version: 2,
    writeIntentActive: true,
  };
  const retry = scripted(
    [
      authorityRow({
        allowedCapabilities: ["github.issues.write"],
        approvedCapabilities: ["github.issues.write"],
        declaredCapabilities: ["github.issues.write"],
        persistedBrokerPolicy: policy(
          ["github.issues.write"],
          ["github.issues.write"]
        ),
        runnerBrokerPolicy: policy(
          ["github.issues.write"],
          ["github.issues.write"]
        ),
        stepApprovalStatus: "approved",
        stepApprovedCapabilities: ["github.issues.write"],
        stepDeclaredCapabilities: ["github.issues.write"],
      }),
    ],
    [released],
    [retried]
  );

  const result = await retry.store.reserveOperation(operator, {
    executionLeaseExpiresAt: retried.executionLeaseExpiresAt,
    id: OPERATION_ROW_ID,
    operation,
    operationId: OPERATION_ID,
    requestHash: released.requestHash,
    target: released.target,
    tokenHash: "a".repeat(64),
  });

  assert.equal(result.kind, "reserved");
  assert.deepEqual(
    retry.statements.map(({ name }) => name),
    [
      "lock-github-capability-authority",
      "lock-existing-github-operation",
      "claim-github-operation-pre-send-retry",
    ]
  );
  assert.doesNotMatch(queryText(retry.statements[2]), /usedCallCount/u);
});

test("provider mutation authorization rechecks every live fence immediately before the write", async () => {
  const sent = operationRow({
    kind: "issue.comment",
    operationMarker:
      "<!-- coven-github:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->",
    providerDispatchPhase: "sent",
    providerSentAt: new Date("2026-08-31T20:00:01.000Z"),
    requiredCapability: "github.issues.write",
    version: 1,
  });
  const authorized = scripted([sent]);
  const authorization = await authorized.store.authorizeMutation(operator, {
    expectedVersion: 0,
    id: OPERATION_ROW_ID,
  });
  assert.equal(authorization.kind, "authorized");
  assert.equal(
    authorization.kind === "authorized" &&
      authorization.operation.providerDispatchPhase,
    "sent"
  );
  assert.equal(
    authorization.kind === "authorized" && authorization.operation.version,
    sent.version
  );
  const query = queryText(authorized.statements[0]);
  assert.match(query, /UPDATE "RunnerGitHubOperation"/u);
  assert.match(query, /"providerDispatchPhase" = 'sent'/u);
  assert.match(query, /"providerSentAt" = clock_timestamp\(\)/u);
  assert.match(
    query,
    /'github\.contents\.write'\s+AND "connection"\."appContentsPermission" = 'write'/u
  );
  assert.match(query, /'appContentsPermission'/u);
  for (const fence of [
    '"operation"."status" = \'running\'',
    '"capability"."revokedAt" IS NULL',
    '"capability"."expiresAt" > clock_timestamp()',
    '"runnerRun"."cancellationRequestedAt" IS NULL',
    '"runnerRun"."status" = \'running\'',
    '"runnerRun"."dispatchState" = \'running\'',
    '"runnerRun"."daytonaAttemptId" =\\s*"capability"."attemptId"::text',
    '"actor"."authVersion" = "capability"."authVersion"',
    '"connectionFence"."generation" =\\s*"capability"."connectionGeneration"',
    '"step"."status" = \'running\'',
    '"teamRun"."status" = \'running\'',
  ]) {
    assert.match(query, new RegExp(fence, "u"));
  }

  const revoked = scripted([]);
  assert.deepEqual(
    await revoked.store.authorizeMutation(operator, {
      expectedVersion: 0,
      id: OPERATION_ROW_ID,
    }),
    { kind: "unauthorized" }
  );
});

test("retryable pre-send failure persistence releases only the write-intent fence", async () => {
  const running = operationRow({
    kind: "issue.comment",
    operationMarker:
      "<!-- coven-github:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->",
    requiredCapability: "github.issues.write",
  });
  const released = operationRow({
    ...running,
    error: {
      code: "github_provider_rate_limited",
      message: "GitHub provider execution failed.",
      retryable: true,
    },
    status: "pending",
    version: 1,
    writeIntentActive: false,
  });
  const fixture = scripted([running], [released]);
  const store = fixture.store as typeof fixture.store & {
    releaseOperationForRetry: (
      operator: RunnerOperator,
      input: {
        error: {
          code: string;
          message: string;
          retryable: true;
        };
        expectedVersion: number;
        id: string;
        providerRequestId: string | null;
      }
    ) => Promise<
      { kind: "released"; operation: typeof released } | { kind: "stale" }
    >;
  };
  assert.equal(typeof store.releaseOperationForRetry, "function");
  const result = await store.releaseOperationForRetry(operator, {
    error: released.error as never,
    expectedVersion: 0,
    id: OPERATION_ROW_ID,
    providerRequestId: null,
  });
  assert.equal(result.kind, "released");
  assert.match(
    queryText(fixture.statements[1]),
    /"status" = 'pending'[\s\S]*"writeIntentActive" = false/u
  );
});

test("attempt cleanup revokes only the exact active runner capability and is idempotent", async () => {
  const revoked = scripted([{ id: CAPABILITY_ID }]);
  assert.deepEqual(
    await revoked.store.revokeCapability(operator, {
      attemptId: ATTEMPT_ID,
      runnerRunId: RUNNER_RUN_ID,
    }),
    { kind: "revoked" }
  );
  const query = queryText(revoked.statements[0]);
  assert.match(query, /"runnerRunId" =/u);
  assert.match(query, /"attemptId" =/u);
  assert.match(query, /"revokedAt" IS NULL/u);
  assert.match(
    query,
    /"revokedAt" = COALESCE\("revokedAt", clock_timestamp\(\)\)/u
  );

  const duplicate = scripted([]);
  assert.deepEqual(
    await duplicate.store.revokeCapability(operator, {
      attemptId: ATTEMPT_ID,
      runnerRunId: RUNNER_RUN_ID,
    }),
    { kind: "not_found" }
  );
});

test("operation completion persists only a strict bounded result while uncertainty is terminal failure", async () => {
  const resultJson = {
    issue: {
      body: "",
      nodeId: "I_kwDOExample",
      number: "42",
      state: "open" as const,
      title: "Gateway",
      url: "https://github.com/OpenCoven/coven-agents/issues/42",
    },
    kind: "issue.get" as const,
    repository: "OpenCoven/coven-agents",
  };
  const running = operationRow();
  const completed = operationRow({
    completedAt: new Date("2026-08-31T20:00:02.000Z"),
    providerRequestId: "ABC1:DEF2",
    resultJson,
    resultNodeId: "I_kwDOExample",
    resultUrl: resultJson.issue.url,
    status: "completed",
    version: 1,
  });
  const completion = scripted([running], [completed]);
  const completedResult = await completion.store.completeOperation(operator, {
    expectedVersion: 0,
    id: OPERATION_ROW_ID,
    providerRequestId: "ABC1:DEF2",
    result: resultJson,
    resultNodeId: "I_kwDOExample",
    resultUrl: resultJson.issue.url,
  });
  assert.equal(completedResult.kind, "completed");
  assert.deepEqual(completion.statements[1].args.result, resultJson);

  const uncertain = operationRow({
    completedAt: new Date("2026-08-31T20:00:30.000Z"),
    error: {
      code: "github_write_uncertain",
      message: "GitHub may have accepted the write; it was not replayed.",
      retryable: false,
    },
    status: "failed",
    version: 1,
  });
  const failure = scripted([running], [uncertain]);
  const failedResult = await failure.store.failOperation(operator, {
    error: uncertain.error as never,
    expectedVersion: 0,
    id: OPERATION_ROW_ID,
    providerRequestId: null,
  });
  assert.equal(failedResult.kind, "failed");
  assert.equal(
    (failedResult.kind === "failed" && failedResult.operation.result) || null,
    null
  );
});
