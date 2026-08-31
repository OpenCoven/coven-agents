import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  AGENT_RUNNER_LIMITS,
  TEAM_LIMITS,
  type TeamHandoff,
} from "@opencoven/agent-contracts";
import { PgDialect } from "drizzle-orm/pg-core";
import type { RunnerOperator, RunnerPrincipal } from "../runner/types";
import { teamChildRunnerIds } from "./orchestrate";
import { createTeamStore, type TeamStoreStatement } from "./store";

const principal: RunnerPrincipal = {
  kind: "subscriber",
  tenant: "tenant_a",
  userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
const otherPrincipal: RunnerPrincipal = {
  kind: "subscriber",
  tenant: "tenant_b",
  userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};
const operator: RunnerOperator = { kind: "runner-operator" };
const dialect = new PgDialect();

const AGENT_A = "00000000-0000-4000-8000-000000000001";
const AGENT_B = "00000000-0000-4000-8000-000000000002";
const SKILL_A = "10000000-0000-4000-8000-000000000001";
const SKILL_B = "10000000-0000-4000-8000-000000000002";
const TEAM_A = "20000000-0000-4000-8000-000000000001";
const MEMBER_A = "30000000-0000-4000-8000-000000000001";
const MEMBER_B = "30000000-0000-4000-8000-000000000002";
const TEAM_RUN_A = "40000000-0000-4000-8000-000000000001";
const TEAM_STEP_A = "50000000-0000-4000-8000-000000000001";
const TEAM_STEP_B = "50000000-0000-4000-8000-000000000002";
const OPERATION_A = "60000000-0000-4000-8000-000000000001";
const CONNECTION_A = "70000000-0000-4000-8000-000000000001";
const CAPABILITY_A = "80000000-0000-4000-8000-000000000001";
const CAPABILITY_B = "80000000-0000-4000-8000-000000000002";
const GITHUB_OPERATION_A = "90000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-08-31T00:00:00.000Z");

function queryText(statement: TeamStoreStatement): string {
  return dialect.sqlToQuery(statement.query).sql;
}

function captured(
  statements: readonly TeamStoreStatement[],
  index: number
): TeamStoreStatement {
  const statement = statements[index];
  assert.ok(statement);
  return statement;
}

function scripted(...responses: Record<string, unknown>[][]) {
  const statements: TeamStoreStatement[] = [];
  const store = createTeamStore({
    transaction: (callback) =>
      callback({
        execute: <Row extends Record<string, unknown>>(
          statement: TeamStoreStatement
        ) => {
          statements.push(statement);
          return Promise.resolve((responses.shift() ?? []) as Row[]);
        },
      }),
  });
  return { statements, store };
}

function skillRow(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    createdAt: NOW,
    description: "Requires release evidence.",
    id: SKILL_A,
    instructions: "Run the build and focused tests.",
    name: "Release evidence",
    requiredCapabilities: ["workspace.read", "workspace.write"],
    tenant: principal.tenant,
    updatedAt: NOW,
    version: 0,
    ...overrides,
  };
}

function teamRow(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    createdAt: NOW,
    description: "Ships approved work.",
    id: TEAM_A,
    members: [
      {
        agentId: AGENT_A,
        id: MEMBER_A,
        position: 0,
        required: true,
        responsibility: "Build the change.",
        skillIds: [SKILL_A],
      },
      {
        agentId: AGENT_B,
        id: MEMBER_B,
        position: 1,
        required: false,
        responsibility: "Review the change.",
        skillIds: [SKILL_B],
      },
    ],
    name: "Delivery team",
    tenant: principal.tenant,
    updatedAt: NOW,
    version: 0,
    ...overrides,
  };
}

function teamRunRow(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    authVersion: 7,
    completedAt: null,
    createdAt: NOW,
    createdByUserId: principal.userId,
    currentPosition: 0,
    error: null,
    id: TEAM_RUN_A,
    liveChildRunId: null,
    mission: "Ship the approved change.",
    operationId: OPERATION_A,
    requestHash: "a".repeat(64),
    startedAt: null,
    status: "queued",
    steps: [
      {
        agentId: AGENT_A,
        agentInstructions: "Keep execution evidence concise.",
        agentModel: "auto",
        agentRuntime: "copilot",
        agentWorkspace: "/workspace/repo",
        approvalActorUserId: null,
        approvalDecidedAt: null,
        approvalStatus: "not_required",
        approvedCapabilities: [],
        completedAt: null,
        createdAt: NOW,
        error: null,
        handoff: null,
        id: TEAM_STEP_A,
        memberId: MEMBER_A,
        plannedOperationId: null,
        plannedRunnerRunId: null,
        position: 0,
        required: true,
        responsibility: "Build the change.",
        runnerRunId: null,
        skillIds: [SKILL_A],
        skillSnapshots: [
          {
            description: "Requires release evidence.",
            id: SKILL_A,
            instructions: "Run the build and focused tests.",
            name: "Release evidence",
            requiredCapabilities: ["workspace.read", "workspace.write"],
          },
        ],
        startedAt: null,
        status: "pending",
        teamRunId: TEAM_RUN_A,
        tenant: principal.tenant,
        updatedAt: NOW,
        version: 0,
      },
      {
        agentId: AGENT_B,
        agentInstructions: "Review the result.",
        agentModel: "auto",
        agentRuntime: "copilot",
        agentWorkspace: null,
        approvalActorUserId: null,
        approvalDecidedAt: null,
        approvalStatus: "pending",
        approvedCapabilities: [],
        completedAt: null,
        createdAt: NOW,
        error: null,
        handoff: null,
        id: TEAM_STEP_B,
        memberId: MEMBER_B,
        plannedOperationId: null,
        plannedRunnerRunId: null,
        position: 1,
        required: false,
        responsibility: "Review the change.",
        runnerRunId: null,
        skillIds: [SKILL_B],
        skillSnapshots: [],
        startedAt: null,
        status: "pending",
        teamRunId: TEAM_RUN_A,
        tenant: principal.tenant,
        updatedAt: NOW,
        version: 0,
      },
    ],
    teamId: TEAM_A,
    tenant: principal.tenant,
    terminalChildRunId: null,
    updatedAt: NOW,
    version: 0,
    ...overrides,
  };
}

test("schema and generated migration contain all nine tenant-safe tables", async () => {
  const schema = await readFile(
    new URL("../db/schema.ts", import.meta.url),
    "utf8"
  );
  const migration = await readFile(
    new URL("../db/migrations/0020_coordinated_teams.sql", import.meta.url),
    "utf8"
  );

  for (const table of [
    "RunnerSkill",
    "RunnerTeam",
    "RunnerTeamMember",
    "RunnerTeamMemberSkill",
    "RunnerTeamRun",
    "RunnerTeamStep",
    "RunnerGitHubConnection",
    "RunnerGitHubCapability",
    "RunnerGitHubOperation",
  ]) {
    assert.match(schema, new RegExp(`"${table}"`, "u"));
    assert.match(migration, new RegExp(`"${table}"`, "u"));
  }

  assert.match(migration, /UNIQUE\("id","tenant"\)/u);
  assert.match(migration, /"responsibility"/u);
  assert.match(migration, /"position"/u);
  assert.match(migration, /jsonb_typeof/u);
  assert.match(
    migration,
    /"currentPosition" >= 0 and "RunnerTeamRun"\."currentPosition" <= 8/u
  );
  assert.match(
    migration,
    /octet_length\("RunnerTeamStep"\."handoff"::text\) <= 16384/u
  );
  assert.match(
    migration,
    /FOREIGN KEY \("capabilityId","tenant","teamStepId"\).*"RunnerGitHubCapability"\("id","tenant","teamStepId"\)/u
  );
  assert.ok(
    migration.indexOf(
      'ALTER TABLE "RunnerRun" ADD CONSTRAINT "RunnerRun_id_tenant_key"'
    ) <
      migration.indexOf(
        'ALTER TABLE "RunnerTeamStep" ADD CONSTRAINT "RTStep_runnerRun_fk"'
      ),
    "the referenced RunnerRun tenant key must exist before its team-step foreign key"
  );
  assert.doesNotMatch(
    migration,
    /accessToken|authorizationHeader|rawResponse/iu
  );
});

test("forward migration persists team authority, approval audit, and execution snapshots", async () => {
  const schema = await readFile(
    new URL("../db/schema.ts", import.meta.url),
    "utf8"
  );
  const migrationDirectory = new URL("../db/migrations/", import.meta.url);
  const { readdir } = await import("node:fs/promises");
  const migrationName = (await readdir(migrationDirectory)).find((name) =>
    name.startsWith("0021_")
  );
  assert.ok(migrationName, "Task 5 must add a forward 0021 migration");
  const authorityMigration = await readFile(
    new URL(migrationName, migrationDirectory),
    "utf8"
  );
  const reservationMigrationName = (await readdir(migrationDirectory)).find(
    (name) => name.startsWith("0022_")
  );
  assert.ok(
    reservationMigrationName,
    "planned child reservations must advance through migration 0022"
  );
  const reservationMigration = await readFile(
    new URL(reservationMigrationName, migrationDirectory),
    "utf8"
  );

  for (const field of [
    "createdByUserId",
    "authVersion",
    "agentInstructions",
    "agentModel",
    "agentRuntime",
    "agentWorkspace",
    "approvedCapabilities",
    "approvalActorUserId",
    "approvalDecidedAt",
  ]) {
    assert.match(schema, new RegExp(field, "u"));
    assert.match(authorityMigration, new RegExp(`"${field}"`, "u"));
  }
  for (const field of ["plannedOperationId", "plannedRunnerRunId"]) {
    assert.match(schema, new RegExp(field, "u"));
    assert.match(reservationMigration, new RegExp(`"${field}"`, "u"));
  }
  assert.match(authorityMigration, /RTRun_authVersion_valid/u);
  assert.match(authorityMigration, /RTStep_approval_audit_valid/u);
  assert.match(authorityMigration, /RTStep_approvedCapabilities_valid/u);
  assert.match(reservationMigration, /RTStep_plannedOperation_uq/u);
  assert.match(reservationMigration, /RTStep_plannedRunnerRun_uq/u);
  assert.match(reservationMigration, /RTStep_childReservation_valid/u);
  assert.match(authorityMigration, /RunnerRun_agentSnapshot_valid/u);
  assert.match(
    authorityMigration,
    /RTStep_handoff_bounded[\s\S]*octet_length\("RunnerTeamStep"\."handoff"::text\) <= 24576/u
  );
  assert.match(
    authorityMigration,
    /FOREIGN KEY \("createdByUserId"\).*"User"\("id"\)/u
  );
  assert.match(
    authorityMigration,
    /FOREIGN KEY \("approvalActorUserId"\).*"User"\("id"\)/u
  );
  assert.doesNotMatch(
    reservationMigration,
    /FOREIGN KEY \("plannedRunnerRunId"[^)]*\).*"RunnerRun"/u
  );
});

test("skill CRUD always binds tenant and hides cross-tenant rows", async () => {
  const created = scripted([skillRow()]);
  const result = await created.store.createSkill(principal, {
    description: "Requires release evidence.",
    id: SKILL_A,
    instructions: "Run the build and focused tests.",
    name: "Release evidence",
    requiredCapabilities: ["workspace.read", "workspace.write"],
  });

  assert.equal(result.kind, "created");
  assert.equal(created.statements[0]?.args.tenant, principal.tenant);
  assert.match(queryText(captured(created.statements, 0)), /"tenant"/u);

  const hidden = scripted([]);
  assert.equal(await hidden.store.getSkill(otherPrincipal, SKILL_A), null);
  assert.equal(hidden.statements[0]?.args.tenant, otherPrincipal.tenant);
  assert.match(
    queryText(captured(hidden.statements, 0)),
    /WHERE "id" = \$\d+ AND "tenant" = \$\d+/u
  );
});

test("skill creation retries return an identical deterministic resource", async () => {
  const duplicate = scripted([], [skillRow({ version: 0 })]);
  const result = await duplicate.store.createSkill(principal, {
    description: "Requires release evidence.",
    id: SKILL_A,
    instructions: "Run the build and focused tests.",
    name: "Release evidence",
    requiredCapabilities: ["workspace.read", "workspace.write"],
  });

  assert.equal(result.kind, "duplicate");
  assert.equal(result.kind === "duplicate" ? result.skill.id : null, SKILL_A);
  assert.deepEqual(
    duplicate.statements.map(({ name }) => name),
    ["create-skill", "get-duplicate-skill"]
  );
});

test("referenced skill deletion returns conflict and is version fenced", async () => {
  const referenced = scripted(
    [skillRow({ version: 3 })],
    [{ memberId: MEMBER_A }]
  );
  assert.deepEqual(
    await referenced.store.deleteSkill(principal, {
      expectedVersion: 3,
      id: SKILL_A,
    }),
    { kind: "conflict" }
  );
  assert.equal(referenced.statements[1]?.name, "find-skill-reference");
  assert.equal(referenced.statements[1]?.args.tenant, principal.tenant);

  const stale = scripted([skillRow({ version: 4 })]);
  assert.deepEqual(
    await stale.store.deleteSkill(principal, {
      expectedVersion: 3,
      id: SKILL_A,
    }),
    { kind: "stale_version" }
  );
  assert.equal(stale.statements.length, 1);
});

test("team creation validates tenant ownership and persists ordered members atomically", async () => {
  const created = scripted(
    [{ id: AGENT_A }, { id: AGENT_B }],
    [{ id: SKILL_A }, { id: SKILL_B }],
    [teamRow({ members: undefined })],
    [
      {
        agentId: AGENT_A,
        id: MEMBER_A,
        position: 0,
        required: true,
        responsibility: "Build the change.",
      },
      {
        agentId: AGENT_B,
        id: MEMBER_B,
        position: 1,
        required: false,
        responsibility: "Review the change.",
      },
    ],
    []
  );

  const result = await created.store.createTeam(principal, {
    description: "Ships approved work.",
    id: TEAM_A,
    members: [
      {
        agentId: AGENT_A,
        id: MEMBER_A,
        required: true,
        responsibility: "Build the change.",
        skillIds: [SKILL_A],
      },
      {
        agentId: AGENT_B,
        id: MEMBER_B,
        required: false,
        responsibility: "Review the change.",
        skillIds: [SKILL_B],
      },
    ],
    name: "Delivery team",
  });

  assert.equal(result.kind, "created");
  assert.deepEqual(
    result.kind === "created"
      ? result.team.members.map(({ position }) => position)
      : [],
    [0, 1]
  );
  assert.deepEqual(
    created.statements.map(({ name }) => name),
    [
      "validate-team-agents",
      "validate-team-skills",
      "insert-team",
      "insert-team-members",
      "insert-team-member-skills",
    ]
  );
  assert.deepEqual(created.statements[3]?.args.positions, [0, 1]);
  for (const statement of created.statements) {
    assert.equal(statement.args.tenant, principal.tenant);
  }
});

test("team creation fails closed when any agent or skill belongs elsewhere", async () => {
  const missingAgent = scripted([{ id: AGENT_A }]);
  assert.deepEqual(
    await missingAgent.store.createTeam(principal, {
      description: "",
      id: TEAM_A,
      members: [
        {
          agentId: AGENT_A,
          id: MEMBER_A,
          required: true,
          responsibility: "Build.",
          skillIds: [SKILL_A],
        },
        {
          agentId: AGENT_B,
          id: MEMBER_B,
          required: true,
          responsibility: "Review.",
          skillIds: [],
        },
      ],
      name: "Delivery",
    }),
    { kind: "not_found" }
  );
  assert.equal(missingAgent.statements.length, 1);

  const missingSkill = scripted([{ id: AGENT_A }, { id: AGENT_B }], []);
  assert.deepEqual(
    await missingSkill.store.createTeam(principal, {
      description: "",
      id: TEAM_A,
      members: [
        {
          agentId: AGENT_A,
          id: MEMBER_A,
          required: true,
          responsibility: "Build.",
          skillIds: [SKILL_A],
        },
        {
          agentId: AGENT_B,
          id: MEMBER_B,
          required: true,
          responsibility: "Review.",
          skillIds: [],
        },
      ],
      name: "Delivery",
    }),
    { kind: "not_found" }
  );
  assert.equal(missingSkill.statements.length, 2);
});

test("team creation retries return an identical deterministic resource", async () => {
  const duplicate = scripted(
    [{ id: AGENT_A }, { id: AGENT_B }],
    [{ id: SKILL_A }, { id: SKILL_B }],
    [],
    [teamRow()]
  );

  const result = await duplicate.store.createTeam(principal, {
    description: "Ships approved work.",
    id: TEAM_A,
    members: [
      {
        agentId: AGENT_A,
        id: MEMBER_A,
        required: true,
        responsibility: "Build the change.",
        skillIds: [SKILL_A],
      },
      {
        agentId: AGENT_B,
        id: MEMBER_B,
        required: false,
        responsibility: "Review the change.",
        skillIds: [SKILL_B],
      },
    ],
    name: "Delivery team",
  });

  assert.equal(result.kind, "duplicate");
  assert.equal(result.kind === "duplicate" ? result.team.id : null, TEAM_A);
  assert.deepEqual(
    duplicate.statements.map(({ name }) => name),
    [
      "validate-team-agents",
      "validate-team-skills",
      "insert-team",
      "get-duplicate-team",
    ]
  );
});

test("team hydration is stable by member position and skill id", async () => {
  const unordered = teamRow({
    members: [
      {
        agentId: AGENT_B,
        id: MEMBER_B,
        position: 1,
        required: false,
        responsibility: "Review the change.",
        skillIds: [SKILL_B, SKILL_A],
      },
      {
        agentId: AGENT_A,
        id: MEMBER_A,
        position: 0,
        required: true,
        responsibility: "Build the change.",
        skillIds: [SKILL_B, SKILL_A],
      },
    ],
  });
  const { statements, store } = scripted([unordered]);

  const team = await store.getTeam(principal, TEAM_A);

  assert.deepEqual(
    team?.members.map(({ position }) => position),
    [0, 1]
  );
  assert.deepEqual(team?.members[0]?.skillIds, [SKILL_A, SKILL_B]);
  assert.match(
    queryText(captured(statements, 0)),
    /ORDER BY "member"\."position"/u
  );
  assert.equal(statements[0]?.args.tenant, principal.tenant);
});

test("team updates replace ordered membership inside one fenced transaction", async () => {
  const current = teamRow({ version: 2 });
  const updated = teamRow({
    members: undefined,
    name: "Delivery team v2",
    version: 3,
  });
  const { statements, store } = scripted(
    [current],
    [{ id: AGENT_B }, { id: AGENT_A }],
    [{ id: SKILL_A }],
    [updated],
    [],
    [],
    [
      {
        agentId: AGENT_B,
        id: MEMBER_B,
        position: 0,
        required: true,
        responsibility: "Review first.",
      },
      {
        agentId: AGENT_A,
        id: MEMBER_A,
        position: 1,
        required: true,
        responsibility: "Build second.",
      },
    ],
    []
  );

  const result = await store.updateTeam(principal, {
    description: "Ships approved work.",
    expectedVersion: 2,
    id: TEAM_A,
    members: [
      {
        agentId: AGENT_B,
        id: MEMBER_B,
        required: true,
        responsibility: "Review first.",
        skillIds: [],
      },
      {
        agentId: AGENT_A,
        id: MEMBER_A,
        required: true,
        responsibility: "Build second.",
        skillIds: [SKILL_A],
      },
    ],
    name: "Delivery team v2",
  });

  assert.equal(result.kind, "updated");
  assert.deepEqual(statements[6]?.args.positions, [0, 1]);
  assert.deepEqual(
    statements.map(({ name }) => name),
    [
      "lock-team-for-update",
      "validate-team-agents",
      "validate-team-skills",
      "update-team",
      "delete-team-member-skills",
      "delete-team-members",
      "insert-team-members",
      "insert-team-member-skills",
    ]
  );
});

test("team updates report nondisclosing not_found and stale_version outcomes", async () => {
  const notFound = scripted([]);
  const input = {
    description: "",
    expectedVersion: 1,
    id: TEAM_A,
    members: [],
    name: "Delivery",
  };
  assert.deepEqual(await notFound.store.updateTeam(otherPrincipal, input), {
    kind: "not_found",
  });

  const stale = scripted([teamRow({ version: 2 })]);
  assert.deepEqual(await stale.store.updateTeam(principal, input), {
    kind: "stale_version",
  });
});

test("team deletion locks before checking run references", async () => {
  const { statements, store } = scripted(
    [teamRow({ version: 2 })],
    [],
    [{ id: TEAM_A }]
  );

  assert.deepEqual(
    await store.deleteTeam(principal, {
      expectedVersion: 2,
      id: TEAM_A,
    }),
    { kind: "deleted" }
  );
  assert.deepEqual(
    statements.map(({ name }) => name),
    ["lock-team-for-delete", "find-team-run-reference", "delete-team"]
  );
  assert.match(queryText(captured(statements, 0)), /FOR UPDATE/u);
  for (const statement of statements) {
    assert.equal(statement.args.tenant, principal.tenant);
  }
});

test("team run creation copies immutable ordered member and skill snapshots", async () => {
  const snapshots = [
    {
      agentId: AGENT_A,
      agentInstructions: "Keep execution evidence concise.",
      agentModel: "auto",
      agentRuntime: "copilot",
      agentWorkspace: "/workspace/repo",
      memberId: MEMBER_A,
      position: 0,
      required: true,
      responsibility: "Build the change.",
      skillIds: [SKILL_A],
      skillSnapshots: [
        {
          description: "Requires release evidence.",
          id: SKILL_A,
          instructions: "Run the build and focused tests.",
          name: "Release evidence",
          requiredCapabilities: ["workspace.read", "workspace.write"],
        },
      ],
    },
    {
      agentId: AGENT_B,
      agentInstructions: "Review the result.",
      agentModel: "auto",
      agentRuntime: "copilot",
      agentWorkspace: null,
      memberId: MEMBER_B,
      position: 1,
      required: false,
      responsibility: "Review the change.",
      skillIds: [SKILL_B],
      skillSnapshots: [],
    },
  ];
  const created = scripted(
    [{ id: TEAM_A }],
    [],
    snapshots,
    [teamRunRow({ steps: undefined })],
    teamRunRow().steps as Record<string, unknown>[]
  );

  const result = await created.store.createTeamRun(principal, {
    authVersion: 7,
    id: TEAM_RUN_A,
    mission: "Ship the approved change.",
    operationId: OPERATION_A,
    requestHash: "a".repeat(64),
    stepIds: [TEAM_STEP_A, TEAM_STEP_B],
    teamId: TEAM_A,
  });

  assert.equal(result.kind, "created");
  assert.deepEqual(
    result.kind === "created"
      ? result.run.steps.map(({ memberId, position, responsibility }) => ({
          memberId,
          position,
          responsibility,
        }))
      : [],
    [
      {
        memberId: MEMBER_A,
        position: 0,
        responsibility: "Build the change.",
      },
      {
        memberId: MEMBER_B,
        position: 1,
        responsibility: "Review the change.",
      },
    ]
  );
  assert.equal(created.statements[4]?.args.tenant, principal.tenant);
  assert.equal(created.statements[3]?.args.createdByUserId, principal.userId);
  assert.equal(created.statements[3]?.args.authVersion, 7);
  assert.deepEqual(created.statements[4]?.args.stepIds, [
    TEAM_STEP_A,
    TEAM_STEP_B,
  ]);
  assert.match(
    queryText(captured(created.statements, 4)),
    /ORDER BY "position"/u
  );
});

test("team run operation replay is idempotent and hash conflicts fail closed", async () => {
  const duplicate = scripted([{ id: TEAM_A }], [teamRunRow()]);
  const duplicateResult = await duplicate.store.createTeamRun(principal, {
    authVersion: 7,
    id: TEAM_RUN_A,
    mission: "Ship the approved change.",
    operationId: OPERATION_A,
    requestHash: "a".repeat(64),
    stepIds: [TEAM_STEP_A, TEAM_STEP_B],
    teamId: TEAM_A,
  });
  assert.equal(duplicateResult.kind, "duplicate");
  assert.equal(duplicate.statements.length, 2);

  const conflict = scripted(
    [{ id: TEAM_A }],
    [teamRunRow({ requestHash: "b".repeat(64) })]
  );
  const conflictResult = await conflict.store.createTeamRun(principal, {
    authVersion: 7,
    id: TEAM_RUN_A,
    mission: "Different request.",
    operationId: OPERATION_A,
    requestHash: "a".repeat(64),
    stepIds: [TEAM_STEP_A, TEAM_STEP_B],
    teamId: TEAM_A,
  });
  assert.equal(conflictResult.kind, "conflict");
  assert.equal(conflict.statements.length, 2);
});

test("team step updates are tenant scoped, monotonic, and version fenced", async () => {
  const runningStep = {
    ...(teamRunRow().steps as Record<string, unknown>[])[0],
    status: "running",
    version: 3,
  };
  const invalid = scripted([runningStep]);
  assert.deepEqual(
    await invalid.store.updateTeamStep(principal, {
      approvalStatus: "not_required",
      error: null,
      expectedVersion: 3,
      handoff: null,
      id: TEAM_STEP_A,
      runnerRunId: null,
      status: "queued",
    }),
    { kind: "invalid_transition" }
  );
  assert.equal(invalid.statements.length, 1);

  const stale = scripted([runningStep]);
  assert.deepEqual(
    await stale.store.updateTeamStep(principal, {
      approvalStatus: "not_required",
      error: null,
      expectedVersion: 2,
      handoff: null,
      id: TEAM_STEP_A,
      runnerRunId: null,
      status: "completed",
    }),
    { kind: "stale_version" }
  );

  const completedStep = {
    ...runningStep,
    completedAt: NOW,
    handoff: { commandEvidence: [], fileEvidence: [], output: "Done." },
    status: "completed",
    version: 4,
  };
  const updated = scripted([runningStep], [completedStep]);
  const result = await updated.store.updateTeamStep(principal, {
    approvalStatus: "not_required",
    error: null,
    expectedVersion: 3,
    handoff: { commandEvidence: [], fileEvidence: [], output: "Done." },
    id: TEAM_STEP_A,
    runnerRunId: null,
    status: "completed",
  });
  assert.equal(result.kind, "updated");
  assert.equal(updated.statements[1]?.args.tenant, principal.tenant);
  assert.match(
    queryText(captured(updated.statements, 1)),
    /"version" = \$\d+/u
  );
  assert.match(
    queryText(captured(updated.statements, 0)),
    /WITH "lockedTeamRun" AS MATERIALIZED/u
  );
  assert.match(
    queryText(captured(updated.statements, 0)),
    /FOR UPDATE OF "teamRun"/u
  );
});

test("approval decisions require a pending approval and matching version", async () => {
  const pending = {
    ...(teamRunRow().steps as Record<string, unknown>[])[1],
    approvalStatus: "pending",
    skillSnapshots: [
      {
        description: "",
        id: SKILL_B,
        instructions: "Review pull requests.",
        name: "Reviewer",
        requiredCapabilities: ["github.pull_requests.write"],
      },
    ],
    version: 5,
  };
  const approved = {
    ...pending,
    approvalActorUserId: principal.userId,
    approvalDecidedAt: NOW,
    approvalStatus: "approved",
    approvedCapabilities: ["github.pull_requests.write"],
    version: 6,
  };
  const { statements, store } = scripted([pending], [approved]);

  const result = await store.decideTeamStepApproval(principal, {
    capabilities: ["github.pull_requests.write"],
    decision: "approve",
    expectedVersion: 5,
    id: TEAM_STEP_B,
  });

  assert.equal(result.kind, "updated");
  assert.equal(statements[1]?.args.tenant, principal.tenant);
  assert.match(
    queryText(captured(statements, 1)),
    /"approvalStatus" = 'pending'/u
  );
  assert.equal(statements[1]?.args.approvalActorUserId, principal.userId);
  assert.deepEqual(statements[1]?.args.capabilities, [
    "github.pull_requests.write",
  ]);
  assert.match(
    queryText(captured(statements, 1)),
    /skillSnapshots[\s\S]*requiredCapabilities/u
  );
  assert.match(queryText(captured(statements, 1)), /"approvalDecidedAt"/u);

  const alreadyDecided = scripted([approved]);
  assert.deepEqual(
    await alreadyDecided.store.decideTeamStepApproval(principal, {
      capabilities: [],
      decision: "reject",
      expectedVersion: 6,
      id: TEAM_STEP_B,
    }),
    { kind: "invalid_transition" }
  );
});

test("approval rejects undeclared or read-only capability escalation before mutation", async () => {
  const pending = {
    ...(teamRunRow().steps as Record<string, unknown>[])[1],
    approvalStatus: "pending",
    skillSnapshots: [
      {
        description: "",
        id: SKILL_B,
        instructions: "Review pull requests.",
        name: "Reviewer",
        requiredCapabilities: ["github.pull_requests.write"],
      },
    ],
    status: "waiting_approval",
    version: 5,
  };
  for (const capabilities of [
    ["github.issues.write"],
    ["github.pull_requests.read"],
  ] as const) {
    const attempt = scripted([pending]);
    // biome-ignore lint/performance/noAwaitInLoops: Each capability is verified against an isolated transaction.
    const result = await attempt.store.decideTeamStepApproval(principal, {
      capabilities: [...capabilities],
      decision: "approve",
      expectedVersion: 5,
      id: TEAM_STEP_B,
    });
    assert.deepEqual(result, { kind: "invalid_capabilities" });
    assert.equal(attempt.statements.length, 1);
  }
});

test("rejected required approval is actor-attributed and fails the run through normal progression", async () => {
  const pending = {
    ...(teamRunRow().steps as Record<string, unknown>[])[0],
    approvalStatus: "pending",
    skillSnapshots: [
      {
        description: "",
        id: SKILL_A,
        instructions: "Create the approved pull request.",
        name: "Pull request delivery",
        requiredCapabilities: ["github.pull_requests.write"],
      },
    ],
    status: "waiting_approval",
    version: 5,
  };
  const rejected = {
    ...pending,
    approvalActorUserId: principal.userId,
    approvalDecidedAt: NOW,
    approvalStatus: "rejected",
    completedAt: NOW,
    error: {
      code: "approval_rejected",
      message: "GitHub operation approval was rejected.",
      retryable: false,
    },
    status: "failed",
    version: 6,
  };
  const decision = scripted([pending], [rejected], [], []);

  const result = await decision.store.decideTeamStepApproval(principal, {
    capabilities: [],
    decision: "reject",
    expectedVersion: 5,
    id: TEAM_STEP_A,
  });

  assert.equal(result.kind, "updated");
  assert.deepEqual(
    decision.statements.map(({ name }) => name),
    [
      "lock-team-step-for-approval",
      "decide-team-step-approval",
      "skip-team-steps-after-approval-rejection",
      "advance-team-run-after-approval-rejection",
    ]
  );
  assert.equal(
    decision.statements[1]?.args.approvalActorUserId,
    principal.userId
  );
  assert.deepEqual(decision.statements[1]?.args.capabilities, []);
  assert.match(
    queryText(captured(decision.statements, 3)),
    /WHEN "step"\."required" THEN 'failed'/u
  );
});

test("rejected optional approval advances to completed_with_warnings without granting capabilities", async () => {
  const pending = {
    ...(teamRunRow().steps as Record<string, unknown>[])[1],
    approvalStatus: "pending",
    required: false,
    skillSnapshots: [
      {
        description: "",
        id: SKILL_B,
        instructions: "Review pull requests.",
        name: "Reviewer",
        requiredCapabilities: ["github.pull_requests.write"],
      },
    ],
    status: "waiting_approval",
    version: 5,
  };
  const rejected = {
    ...pending,
    approvalActorUserId: principal.userId,
    approvalDecidedAt: NOW,
    approvalStatus: "rejected",
    approvedCapabilities: [],
    completedAt: NOW,
    error: {
      code: "approval_rejected",
      message: "GitHub operation approval was rejected.",
      retryable: false,
    },
    status: "failed",
    version: 6,
  };
  const decision = scripted([pending], [rejected], [], []);

  const result = await decision.store.decideTeamStepApproval(principal, {
    capabilities: [],
    decision: "reject",
    expectedVersion: 5,
    id: TEAM_STEP_B,
  });

  assert.equal(result.kind, "updated");
  assert.deepEqual(decision.statements[1]?.args.capabilities, []);
  assert.match(
    queryText(captured(decision.statements, 3)),
    /ELSE 'completed_with_warnings'/u
  );
  assert.match(
    queryText(captured(decision.statements, 3)),
    /WHEN "step"\."required" THEN "step"\."error"[\s\S]*ELSE NULL/u
  );
});

test("child attachment is tenant-fenced, idempotent, and immutable", async () => {
  const runnerRunId = "aaaaaaaa-0000-4000-8000-000000000001";
  const operationId = "aaaaaaaa-0000-4000-8000-000000000010";
  const current = {
    ...(teamRunRow().steps as Record<string, unknown>[])[0],
    plannedOperationId: operationId,
    plannedRunnerRunId: runnerRunId,
    status: "queued",
    teamRunStatus: "running",
    version: 2,
  };
  const attached = {
    ...current,
    runnerRunId,
    status: "running",
    version: 3,
  };
  const created = scripted([current], [{ id: runnerRunId }], [attached]);
  assert.deepEqual(
    await created.store.attachTeamStepRunnerRun(operator, {
      expectedVersion: 2,
      operationId,
      runnerRunId,
      teamStepId: TEAM_STEP_A,
    }),
    { kind: "attached" }
  );
  assert.match(
    queryText(captured(created.statements, 0)),
    /FOR UPDATE OF "teamRun", "step"/u
  );
  assert.match(
    queryText(captured(created.statements, 1)),
    /"RunnerRun"[\s\S]*"tenant" = "step"\."tenant"/u
  );
  assert.match(
    queryText(captured(created.statements, 1)),
    /"runnerRun"\."operationId" =/u
  );
  assert.match(queryText(captured(created.statements, 2)), /AND "tenant" =/u);

  const duplicate = scripted([attached]);
  assert.equal(
    (
      await duplicate.store.attachTeamStepRunnerRun(operator, {
        expectedVersion: 2,
        operationId,
        runnerRunId,
        teamStepId: TEAM_STEP_A,
      })
    ).kind,
    "duplicate"
  );

  const changed = scripted([attached]);
  assert.deepEqual(
    await changed.store.attachTeamStepRunnerRun(operator, {
      expectedVersion: 3,
      operationId,
      runnerRunId: "aaaaaaaa-0000-4000-8000-000000000002",
      teamStepId: TEAM_STEP_A,
    }),
    { kind: "invalid_transition" }
  );
});

test("an exact reserved child may attach after it terminalizes", async () => {
  const runnerRunId = "aaaaaaaa-0000-4000-8000-000000000001";
  const operationId = "aaaaaaaa-0000-4000-8000-000000000010";
  const current = {
    ...(teamRunRow().steps as Record<string, unknown>[])[0],
    plannedOperationId: operationId,
    plannedRunnerRunId: runnerRunId,
    status: "queued",
    teamRunStatus: "running",
    version: 2,
  };
  const attached = {
    ...current,
    runnerRunId,
    status: "running",
    version: 3,
  };
  const terminal = scripted([current], [{ id: runnerRunId }], [attached]);

  assert.deepEqual(
    await terminal.store.attachTeamStepRunnerRun(operator, {
      expectedVersion: 2,
      operationId,
      runnerRunId,
      teamStepId: TEAM_STEP_A,
    }),
    { kind: "attached" }
  );
  assert.match(
    queryText(captured(terminal.statements, 1)),
    /"runnerRun"\."status" IN \(\s*'queued',\s*'running',\s*'completed',\s*'failed',\s*'cancelled'\s*\)/u
  );
  assert.match(
    queryText(captured(terminal.statements, 2)),
    /SET "runnerRunId" = [^,]+,\s*"status" = 'running'/u
  );
});

test("child attachment refuses identifiers outside the durable reservation", async () => {
  const planned = {
    operationId: "aaaaaaaa-0000-4000-8000-000000000010",
    runnerRunId: "aaaaaaaa-0000-4000-8000-000000000001",
  };
  const current = {
    ...(teamRunRow().steps as Record<string, unknown>[])[0],
    plannedOperationId: planned.operationId,
    plannedRunnerRunId: planned.runnerRunId,
    status: "queued",
    teamRunStatus: "running",
    version: 2,
  };
  const mismatch = scripted([current]);

  assert.deepEqual(
    await mismatch.store.attachTeamStepRunnerRun(operator, {
      expectedVersion: 2,
      operationId: planned.operationId,
      runnerRunId: "aaaaaaaa-0000-4000-8000-000000000002",
      teamStepId: TEAM_STEP_A,
    }),
    { kind: "invalid_transition" }
  );
  assert.equal(mismatch.statements.length, 1);
});

test("a cancellation race attaches the admitted child for durable exact cleanup", async () => {
  const runnerRunId = "aaaaaaaa-0000-4000-8000-000000000001";
  const operationId = "aaaaaaaa-0000-4000-8000-000000000010";
  const cancelled = {
    ...(teamRunRow().steps as Record<string, unknown>[])[0],
    plannedOperationId: operationId,
    plannedRunnerRunId: runnerRunId,
    runnerRunId: null,
    status: "skipped",
    teamRunStatus: "cancelled",
    version: 3,
  };
  const attached = {
    ...cancelled,
    runnerRunId,
    status: "cancelled",
    version: 4,
  };
  const race = scripted([cancelled], [{ id: runnerRunId }], [attached]);

  assert.deepEqual(
    await race.store.attachTeamStepRunnerRun(operator, {
      expectedVersion: 2,
      operationId,
      runnerRunId,
      teamStepId: TEAM_STEP_A,
    }),
    { kind: "cancel_required" }
  );
  assert.match(
    queryText(captured(race.statements, 2)),
    /"status" = 'cancelled'/u
  );
  assert.match(
    queryText(captured(race.statements, 2)),
    /"runnerRunId" IS NULL/u
  );
});

test("nonretryable admission failure follows required failure progression under the parent lock", async () => {
  const current = {
    ...(teamRunRow().steps as Record<string, unknown>[])[0],
    hasLaterStep: true,
    status: "queued",
    version: 2,
  };
  const failure = scripted([current], [{ id: TEAM_STEP_A }], [], []);
  const error = {
    code: "agent_not_found",
    message: "The snapshotted runner agent is unavailable.",
    retryable: false,
  };

  assert.deepEqual(
    await failure.store.failTeamStepAdmission(operator, {
      error,
      expectedVersion: 2,
      teamStepId: TEAM_STEP_A,
    }),
    { kind: "failed" }
  );
  assert.deepEqual(
    failure.statements.map(({ name }) => name),
    [
      "lock-team-step-for-admission-failure",
      "fail-team-step-admission",
      "skip-team-steps-after-admission-failure",
      "fail-team-run-after-admission-failure",
    ]
  );
  assert.deepEqual(failure.statements[3]?.args.error, error);
  assert.equal(failure.statements[3]?.args.status, "failed");
});

test("team step claiming uses database locks and never queues pending write approval", async () => {
  const idle = scripted([]);
  assert.deepEqual(await idle.store.claimNextTeamStep(operator), {
    kind: "idle",
  });
  assert.match(
    queryText(captured(idle.statements, 0)),
    /FOR UPDATE OF "teamRun", "step" SKIP LOCKED/u
  );
  assert.match(
    queryText(captured(idle.statements, 0)),
    /"step"\."position" = "teamRun"\."currentPosition"/u
  );
  assert.match(
    queryText(captured(idle.statements, 0)),
    /"step"\."runnerRunId" IS NULL/u
  );
});

test("team step claiming returns immutable authority and snapshots after a fenced queue transition", async () => {
  const planned = teamChildRunnerIds(TEAM_STEP_A);
  const candidate = {
    ...(teamRunRow().steps as Record<string, unknown>[])[0],
    authVersion: 7,
    createdByUserId: principal.userId,
    mission: "Ship the approved change.",
    priorHandoffs: [],
  };
  const claimed = scripted(candidate ? [candidate] : [], [{ version: 1 }], []);

  const result = await claimed.store.claimNextTeamStep(operator);

  assert.equal(result.kind, "ready");
  assert.deepEqual(
    result.kind === "ready"
      ? {
          agentSnapshot: result.agentSnapshot,
          authVersion: result.authVersion,
          declaredCapabilities: result.declaredCapabilities,
          plannedOperationId: result.plannedOperationId,
          plannedRunnerRunId: result.plannedRunnerRunId,
          principal: result.principal,
          teamStepVersion: result.teamStepVersion,
        }
      : null,
    {
      agentSnapshot: {
        instructions: "Keep execution evidence concise.",
        model: "auto",
        runtime: "copilot",
        workspace: "/workspace/repo",
      },
      authVersion: 7,
      declaredCapabilities: [],
      plannedOperationId: planned.operationId,
      plannedRunnerRunId: planned.runId,
      principal,
      teamStepVersion: 1,
    }
  );
  assert.deepEqual(
    claimed.statements.map(({ name }) => name),
    [
      "lock-next-team-step-for-claim",
      "queue-team-step-for-admission",
      "mark-team-run-running",
    ]
  );
  assert.equal(
    claimed.statements[1]?.args.plannedOperationId,
    planned.operationId
  );
  assert.equal(claimed.statements[1]?.args.plannedRunnerRunId, planned.runId);
  assert.match(
    queryText(captured(claimed.statements, 1)),
    /"plannedOperationId"/u
  );
  assert.match(
    queryText(captured(claimed.statements, 1)),
    /"plannedRunnerRunId"/u
  );
});

test("approved team claims use only the durable approved capability subset", async () => {
  const candidate = {
    ...(teamRunRow().steps as Record<string, unknown>[])[0],
    approvalActorUserId: principal.userId,
    approvalDecidedAt: NOW,
    approvalStatus: "approved",
    approvedCapabilities: ["github.issues.write"],
    authVersion: 7,
    createdByUserId: principal.userId,
    mission: "Ship the approved change.",
    plannedOperationId: teamChildRunnerIds(TEAM_STEP_A).operationId,
    plannedRunnerRunId: teamChildRunnerIds(TEAM_STEP_A).runId,
    priorHandoffs: [],
    skillSnapshots: [
      {
        description: "",
        id: SKILL_A,
        instructions: "Modify issues and pull requests.",
        name: "GitHub delivery",
        requiredCapabilities: [
          "github.issues.write",
          "github.pull_requests.write",
        ],
      },
    ],
    status: "queued",
    version: 2,
  };
  const claim = scripted([candidate], []);

  const result = await claim.store.claimNextTeamStep(operator);

  assert.equal(result.kind, "ready");
  assert.deepEqual(result.kind === "ready" ? result.declaredCapabilities : [], [
    "github.issues.write",
  ]);
  assert.deepEqual(result.kind === "ready" ? result.skillSnapshots : [], []);
});

test("deferred queued claims rotate their parent row with database time", async () => {
  const candidate = {
    ...(teamRunRow().steps as Record<string, unknown>[])[0],
    authVersion: 7,
    createdByUserId: principal.userId,
    mission: "Ship the approved change.",
    priorHandoffs: [],
    status: "queued",
    version: 2,
  };
  const claim = scripted([candidate], [{ version: 3 }], []);

  const result = await claim.store.claimNextTeamStep(operator);
  assert.equal(result.kind, "ready");
  assert.equal(result.kind === "ready" && result.teamStepVersion, 3);
  assert.deepEqual(
    claim.statements.map(({ name }) => name),
    [
      "lock-next-team-step-for-claim",
      "reserve-team-step-child",
      "mark-team-run-running",
    ]
  );
  assert.doesNotMatch(
    queryText(captured(claim.statements, 2)),
    /"status" <> 'running'/u
  );
});

test("duplicate queued claims reuse the exact persisted child reservation", async () => {
  const planned = teamChildRunnerIds(TEAM_STEP_A);
  const candidate = {
    ...(teamRunRow().steps as Record<string, unknown>[])[0],
    authVersion: 7,
    createdByUserId: principal.userId,
    mission: "Ship the approved change.",
    plannedOperationId: planned.operationId,
    plannedRunnerRunId: planned.runId,
    priorHandoffs: [],
    status: "queued",
    version: 3,
  };
  const claim = scripted([candidate], []);

  const result = await claim.store.claimNextTeamStep(operator);

  assert.equal(result.kind, "ready");
  assert.deepEqual(
    result.kind === "ready"
      ? {
          plannedOperationId: result.plannedOperationId,
          plannedRunnerRunId: result.plannedRunnerRunId,
          teamStepVersion: result.teamStepVersion,
        }
      : null,
    {
      plannedOperationId: planned.operationId,
      plannedRunnerRunId: planned.runId,
      teamStepVersion: 3,
    }
  );
  assert.deepEqual(
    claim.statements.map(({ name }) => name),
    ["lock-next-team-step-for-claim", "mark-team-run-running"]
  );
});

test("cancelled child scans rotate the parent before external cancellation", async () => {
  const row = {
    createdByUserId: principal.userId,
    runnerRunId: "aaaaaaaa-0000-4000-8000-000000000001",
    teamRunId: TEAM_RUN_A,
    tenant: principal.tenant,
  };
  const scan = scripted([row], []);

  assert.equal(
    (await scan.store.findNextCancelledTeamChild(operator)).kind,
    "found"
  );
  assert.deepEqual(
    scan.statements.map(({ name }) => name),
    ["find-next-cancelled-team-child", "rotate-cancelled-team-child"]
  );
  assert.match(
    queryText(captured(scan.statements, 0)),
    /COALESCE\(\s*"step"\."runnerRunId",\s*"step"\."plannedRunnerRunId"\s*\)/u
  );
  assert.match(
    queryText(captured(scan.statements, 1)),
    /"updatedAt" = now\(\)/u
  );
});

test("pending write approval becomes waiting without entering the runner queue", async () => {
  const candidate = {
    ...(teamRunRow().steps as Record<string, unknown>[])[1],
    authVersion: 7,
    createdByUserId: principal.userId,
    mission: "Ship the approved change.",
    priorHandoffs: [],
  };
  const waiting = scripted([candidate], [], []);

  assert.deepEqual(await waiting.store.claimNextTeamStep(operator), {
    kind: "waiting_approval",
    teamRunId: TEAM_RUN_A,
  });
  assert.deepEqual(
    waiting.statements.map(({ name }) => name),
    [
      "lock-next-team-step-for-claim",
      "mark-team-step-waiting-approval",
      "mark-team-run-waiting-approval",
    ]
  );
  assert.doesNotMatch(
    waiting.statements.map(queryText).join("\n"),
    /INSERT INTO "RunnerRun"/u
  );
});

test("terminal child success projects one bounded handoff and advances one position", async () => {
  const candidate = {
    ...(teamRunRow().steps as Record<string, unknown>[])[0],
    hasLaterStep: true,
    hasOptionalFailure: false,
    priorHandoffs: [],
    runnerCommandEvidence: [],
    runnerError: null,
    runnerFileEvidence: [],
    runnerOutput: "Completed without private metadata.",
    runnerRunId: "aaaaaaaa-0000-4000-8000-000000000001",
    runnerStatus: "completed",
    status: "running",
  };
  const projected = scripted([candidate], [{ id: TEAM_STEP_A }], []);

  assert.deepEqual(
    await projected.store.projectNextTerminalTeamStep(operator),
    {
      kind: "projected",
      teamRunId: TEAM_RUN_A,
    }
  );
  assert.deepEqual(
    projected.statements.map(({ name }) => name),
    [
      "lock-next-terminal-team-step",
      "project-terminal-team-step",
      "advance-team-run-after-terminal-child",
    ]
  );
  assert.equal(
    (
      captured(projected.statements, 1).args.handoff as {
        output: string;
      }
    ).output,
    "Completed without private metadata."
  );
  assert.equal(projected.statements[2]?.args.nextPosition, 1);
  assert.equal(projected.statements[2]?.args.status, "queued");

  const duplicate = scripted([]);
  assert.deepEqual(
    await duplicate.store.projectNextTerminalTeamStep(operator),
    { kind: "idle" }
  );
  assert.equal(duplicate.statements.length, 1);
});

test("required child failure fails the run and skips every later pending step", async () => {
  const error = {
    code: "runner_failed",
    message: "The required child failed.",
    retryable: false,
  };
  const candidate = {
    ...(teamRunRow().steps as Record<string, unknown>[])[0],
    hasLaterStep: true,
    hasOptionalFailure: false,
    priorHandoffs: [],
    runnerCommandEvidence: [],
    runnerError: error,
    runnerFileEvidence: [],
    runnerOutput: "",
    runnerRunId: "aaaaaaaa-0000-4000-8000-000000000001",
    runnerStatus: "failed",
    status: "running",
  };
  const projected = scripted([candidate], [{ id: TEAM_STEP_A }], [], []);

  assert.equal(
    (await projected.store.projectNextTerminalTeamStep(operator)).kind,
    "projected"
  );
  assert.deepEqual(
    projected.statements.map(({ name }) => name),
    [
      "lock-next-terminal-team-step",
      "project-terminal-team-step",
      "skip-team-steps-after-required-failure",
      "advance-team-run-after-terminal-child",
    ]
  );
  assert.equal(projected.statements[3]?.args.nextPosition, 0);
  assert.equal(projected.statements[3]?.args.status, "failed");
  assert.deepEqual(projected.statements[3]?.args.error, error);
});

test("optional final child failure completes the run with warnings", async () => {
  const candidate = {
    ...(teamRunRow().steps as Record<string, unknown>[])[1],
    hasLaterStep: false,
    hasOptionalFailure: false,
    priorHandoffs: [],
    runnerCommandEvidence: [],
    runnerError: null,
    runnerFileEvidence: [],
    runnerOutput: "",
    runnerRunId: "aaaaaaaa-0000-4000-8000-000000000002",
    runnerStatus: "failed",
    status: "running",
  };
  const projected = scripted([candidate], [{ id: TEAM_STEP_B }], []);

  assert.equal(
    (await projected.store.projectNextTerminalTeamStep(operator)).kind,
    "projected"
  );
  assert.equal(projected.statements[2]?.args.nextPosition, 2);
  assert.equal(projected.statements[2]?.args.status, "completed_with_warnings");
  assert.equal(projected.statements[2]?.args.error, null);
});

test("ordinary step updates cannot self-approve a GitHub write", async () => {
  const pending = {
    ...(teamRunRow().steps as Record<string, unknown>[])[1],
    approvalStatus: "pending",
    status: "waiting_approval",
    version: 5,
  };
  const { statements, store } = scripted([pending]);

  assert.deepEqual(
    await store.updateTeamStep(principal, {
      approvalStatus: "approved",
      error: null,
      expectedVersion: 5,
      handoff: null,
      id: TEAM_STEP_B,
      runnerRunId: null,
      status: "waiting_approval",
    }),
    { kind: "invalid_transition" }
  );
  assert.equal(statements.length, 1);
});

test("a pending approval cannot be bypassed by completing the step", async () => {
  const pending = {
    ...(teamRunRow().steps as Record<string, unknown>[])[1],
    approvalStatus: "pending",
    status: "waiting_approval",
    version: 5,
  };
  const { statements, store } = scripted([pending]);

  assert.deepEqual(
    await store.updateTeamStep(principal, {
      approvalStatus: "pending",
      error: null,
      expectedVersion: 5,
      handoff: { commandEvidence: [], fileEvidence: [], output: "Done." },
      id: TEAM_STEP_B,
      runnerRunId: null,
      status: "completed",
    }),
    { kind: "invalid_transition" }
  );
  assert.equal(statements.length, 1);
});

test("a pending approval cannot enter the execution queue", async () => {
  const pending = {
    ...(teamRunRow().steps as Record<string, unknown>[])[1],
    approvalStatus: "pending",
    status: "pending",
    version: 5,
  };
  const { statements, store } = scripted([pending]);

  assert.deepEqual(
    await store.updateTeamStep(principal, {
      approvalStatus: "pending",
      error: null,
      expectedVersion: 5,
      handoff: null,
      id: TEAM_STEP_B,
      runnerRunId: null,
      status: "queued",
    }),
    { kind: "invalid_transition" }
  );
  assert.equal(statements.length, 1);
});

test("cancelling a team run fences version and cancels only live steps", async () => {
  const cancelled = teamRunRow({
    completedAt: NOW,
    status: "cancelled",
    version: 4,
  });
  const { statements, store } = scripted(
    [teamRunRow({ version: 3 })],
    [cancelled],
    [],
    [cancelled]
  );

  const result = await store.cancelTeamRun(principal, {
    expectedVersion: 3,
    id: TEAM_RUN_A,
  });

  assert.equal(result.kind, "updated");
  assert.equal(result.kind === "updated" && result.childRunId, null);
  assert.match(
    queryText(captured(statements, 0)),
    /COALESCE\(\s*"step"\."runnerRunId",\s*"step"\."plannedRunnerRunId"\s*\)/u
  );
  assert.match(
    queryText(captured(statements, 2)),
    /"status" IN \('pending', 'queued', 'running', 'waiting_approval'\)/u
  );
  assert.match(
    queryText(captured(statements, 2)),
    /COALESCE\(\s*"runnerRunId",\s*"plannedRunnerRunId"\s*\)/u
  );
  for (const statement of statements) {
    assert.equal(statement.args.tenant, principal.tenant);
  }
});

test("cancellation projects an already-terminal attached child before skipping later steps", async () => {
  const childRunId = "aaaaaaaa-0000-4000-8000-000000000001";
  const current = teamRunRow({
    terminalChildRunId: childRunId,
    version: 3,
  });
  const terminalChild = {
    ...(teamRunRow().steps as Record<string, unknown>[])[0],
    priorHandoffs: [],
    runnerCommandEvidence: [],
    runnerError: null,
    runnerFileEvidence: [],
    runnerOutput: "Completed before cancellation.",
    runnerRunId: childRunId,
    runnerStatus: "completed",
    status: "running",
  };
  const cancelled = teamRunRow({
    completedAt: NOW,
    status: "cancelled",
    steps: [
      {
        ...(teamRunRow().steps as Record<string, unknown>[])[0],
        completedAt: NOW,
        handoff: {
          commandEvidence: [],
          fileEvidence: [],
          output: "Completed before cancellation.",
        },
        runnerRunId: childRunId,
        status: "completed",
      },
      {
        ...(teamRunRow().steps as Record<string, unknown>[])[1],
        completedAt: NOW,
        status: "skipped",
      },
    ],
    version: 4,
  });
  const cancellation = scripted(
    [current],
    [terminalChild],
    [{ id: TEAM_STEP_A }],
    [cancelled],
    [],
    [cancelled]
  );

  const result = await cancellation.store.cancelTeamRun(principal, {
    expectedVersion: 3,
    id: TEAM_RUN_A,
  });

  assert.equal(result.kind, "updated");
  assert.deepEqual(
    cancellation.statements.map(({ name }) => name),
    [
      "lock-team-run-for-cancel",
      "lock-terminal-team-child-before-cancel",
      "project-terminal-team-child-before-cancel",
      "cancel-team-run",
      "cancel-team-run-steps",
      "get-cancelled-team-run",
    ]
  );
  assert.equal(
    (
      captured(cancellation.statements, 2).args.handoff as {
        output: string;
      }
    ).output,
    "Completed before cancellation."
  );
  assert.equal(result.kind === "updated" && result.childRunId, null);
});

test("cancellation projects an exact terminal reserved queued child before skipping later steps", async () => {
  const childRunId = "aaaaaaaa-0000-4000-8000-000000000001";
  const operationId = "aaaaaaaa-0000-4000-8000-000000000010";
  const current = teamRunRow({
    terminalChildRunId: childRunId,
    version: 3,
  });
  const terminalChild = {
    ...(teamRunRow().steps as Record<string, unknown>[])[0],
    plannedOperationId: operationId,
    plannedRunnerRunId: childRunId,
    priorHandoffs: [],
    runnerCommandEvidence: [],
    runnerError: null,
    runnerFileEvidence: [],
    runnerOperationId: operationId,
    runnerOutput: "Completed before attachment.",
    runnerRunId: null,
    runnerStatus: "completed",
    status: "queued",
  };
  const cancelled = teamRunRow({
    completedAt: NOW,
    status: "cancelled",
    version: 4,
  });
  const cancellation = scripted(
    [current],
    [terminalChild],
    [{ id: TEAM_STEP_A }],
    [cancelled],
    [],
    [cancelled]
  );

  const result = await cancellation.store.cancelTeamRun(principal, {
    expectedVersion: 3,
    id: TEAM_RUN_A,
  });

  assert.equal(result.kind, "updated");
  const lockSql = queryText(captured(cancellation.statements, 1));
  assert.match(lockSql, /"runnerRun"\."agentId" = "step"\."agentId"/u);
  assert.match(
    lockSql,
    /"step"\."plannedOperationId" = "runnerRun"\."operationId"/u
  );
  assert.match(lockSql, /"step"\."plannedRunnerRunId" = "runnerRun"\."id"/u);
  const projectionSql = queryText(captured(cancellation.statements, 2));
  assert.match(projectionSql, /"runnerRunId" = COALESCE/u);
  assert.match(projectionSql, /"plannedRunnerRunId" =/u);
  assert.match(projectionSql, /"plannedOperationId" =/u);
  assert.match(projectionSql, /"status" IN \('queued', 'running'\)/u);
  assert.equal(
    captured(cancellation.statements, 2).args.runnerRunId,
    childRunId
  );
});

test("handoff validation rejects over-limit persisted text before querying", async () => {
  const { statements, store } = scripted();
  const handoff: TeamHandoff = {
    commandEvidence: [],
    fileEvidence: [],
    output: "x".repeat(TEAM_LIMITS.maxHandoffLength + 1),
  };

  await assert.rejects(
    store.updateTeamStep(principal, {
      approvalStatus: "not_required",
      error: null,
      expectedVersion: 0,
      handoff,
      id: TEAM_STEP_A,
      runnerRunId: null,
      status: "completed",
    }),
    /handoff/i
  );
  assert.equal(statements.length, 0);
});

test("handoff validation bounds the complete serialized payload", async () => {
  const { statements, store } = scripted();
  const handoff: TeamHandoff = {
    commandEvidence: [
      {
        command: "pnpm test",
        exitCode: 0,
        stderr: "",
        stdout: "x".repeat(TEAM_LIMITS.maxHandoffLength),
      },
    ],
    fileEvidence: [],
    output: "Done.",
  };

  await assert.rejects(
    store.updateTeamStep(principal, {
      approvalStatus: "not_required",
      error: null,
      expectedVersion: 0,
      handoff,
      id: TEAM_STEP_A,
      runnerRunId: null,
      status: "completed",
    }),
    /serialized value is too large/i
  );
  assert.equal(statements.length, 0);
});

test("team handoff aggregate overflow is distinct from a stale version", async () => {
  const runningStep = {
    ...(teamRunRow().steps as Record<string, unknown>[])[0],
    status: "running",
    version: 3,
  };
  const { store } = scripted([runningStep], []);

  assert.deepEqual(
    await store.updateTeamStep(principal, {
      approvalStatus: "not_required",
      error: null,
      expectedVersion: 3,
      handoff: { commandEvidence: [], fileEvidence: [], output: "Done." },
      id: TEAM_STEP_A,
      runnerRunId: null,
      status: "completed",
    }),
    { kind: "handoff_limit" }
  );
});

test("GitHub capability persistence accepts only hashes, bounded budgets, and allowlists", async () => {
  const createdAt = NOW;
  const expiresAt = new Date("2026-08-31T00:05:00.000Z");
  const row = {
    approvedCapabilities: ["github.issues.read", "github.pull_requests.write"],
    createdAt,
    expiresAt,
    id: CAPABILITY_A,
    maxCallCount: 3,
    repositoryAllowlist: ["OpenCoven/coven-agents"],
    revokedAt: null,
    teamStepId: TEAM_STEP_A,
    tenant: principal.tenant,
    tokenHash: "c".repeat(64),
    usedCallCount: 0,
    version: 0,
  };
  const created = scripted([{ id: TEAM_STEP_A }], [row]);

  const result = await created.store.createGitHubCapability(principal, {
    approvedCapabilities: ["github.issues.read", "github.pull_requests.write"],
    expiresAt,
    id: CAPABILITY_A,
    maxCallCount: 3,
    repositoryAllowlist: ["OpenCoven/coven-agents"],
    teamStepId: TEAM_STEP_A,
    tokenHash: "c".repeat(64),
  });

  assert.equal(result.kind, "created");
  assert.equal(created.statements[1]?.args.tokenHash, "c".repeat(64));
  assert.doesNotMatch(
    JSON.stringify(created.statements[1]?.args),
    /plaintext|accessToken|authorization/iu
  );
  assert.match(
    queryText(captured(created.statements, 0)),
    /"step"\."status" IN \('queued', 'running'\)/u
  );
  assert.match(
    queryText(captured(created.statements, 0)),
    /"step"\."skillSnapshots"/u
  );
  assert.match(
    queryText(captured(created.statements, 0)),
    /"teamRun"\."status" IN \('queued', 'running'\)/u
  );
  assert.match(
    queryText(captured(created.statements, 0)),
    /"step"\."approvalStatus" = 'approved'/u
  );
  assert.match(
    queryText(captured(created.statements, 0)),
    /"step"\."approvedCapabilities" @>/u
  );

  const invalid = scripted();
  await assert.rejects(
    invalid.store.createGitHubCapability(principal, {
      approvedCapabilities: ["workspace.write"],
      expiresAt,
      id: CAPABILITY_A,
      maxCallCount: 0,
      repositoryAllowlist: ["OpenCoven/coven-agents"],
      teamStepId: TEAM_STEP_A,
      tokenHash: "not-a-hash",
    }),
    /capability|hash|call count/i
  );
  assert.equal(invalid.statements.length, 0);
});

test("GitHub connection stores decimal metadata without an access token field", async () => {
  const row = {
    accountId: "18446744073709551615",
    accountLogin: "OpenCoven",
    accountType: "Organization" as const,
    createdAt: NOW,
    id: CONNECTION_A,
    installationId: "18446744073709551614",
    repositoryId: "18446744073709551613",
    repositoryName: "coven-agents",
    repositoryNodeId: "R_kgDOExample",
    repositoryOwner: "OpenCoven",
    tenant: principal.tenant,
    updatedAt: NOW,
    version: 0,
  };
  const { statements, store } = scripted([row]);

  const result = await store.upsertGitHubConnection(principal, {
    accountId: row.accountId,
    accountLogin: row.accountLogin,
    accountType: row.accountType,
    id: CONNECTION_A,
    installationId: row.installationId,
    repositoryId: row.repositoryId,
    repositoryName: row.repositoryName,
    repositoryNodeId: row.repositoryNodeId,
    repositoryOwner: row.repositoryOwner,
  });

  assert.equal(result.connection.installationId, row.installationId);
  assert.doesNotMatch(
    JSON.stringify(statements[0]?.args),
    /token|authorization/iu
  );
});

test("GitHub operations are idempotent by operation id and sanitized request hash", async () => {
  const operation = {
    capabilityId: CAPABILITY_A,
    completedAt: null,
    createdAt: NOW,
    error: null,
    id: GITHUB_OPERATION_A,
    kind: "pull.create",
    operationId: OPERATION_A,
    providerRequestId: null,
    requestHash: "d".repeat(64),
    resultNodeId: null,
    resultUrl: null,
    startedAt: null,
    status: "pending",
    target: "OpenCoven/coven-agents:feature/team",
    teamStepId: TEAM_STEP_A,
    tenant: principal.tenant,
    updatedAt: NOW,
    version: 0,
  };
  const created = scripted([], [{ id: TEAM_STEP_A }], [operation]);
  const createdResult = await created.store.beginGitHubOperation(principal, {
    capabilityId: CAPABILITY_A,
    id: GITHUB_OPERATION_A,
    kind: "pull.create",
    operationId: OPERATION_A,
    repository: "OpenCoven/coven-agents",
    requestHash: "d".repeat(64),
    target: "OpenCoven/coven-agents:feature/team",
    teamStepId: TEAM_STEP_A,
  });
  assert.equal(createdResult.kind, "created");
  assert.equal(
    created.statements[1]?.args.repository,
    "OpenCoven/coven-agents"
  );
  assert.match(
    queryText(captured(created.statements, 1)),
    /"repositoryAllowlist" @>/u
  );
  assert.match(
    queryText(captured(created.statements, 1)),
    /FOR UPDATE OF "capability"/u
  );
  assert.match(
    queryText(captured(created.statements, 1)),
    /"step"\."status" = 'running'/u
  );
  assert.match(
    queryText(captured(created.statements, 1)),
    /"teamRun"\."status" = 'running'/u
  );
  assert.match(
    queryText(captured(created.statements, 1)),
    /"step"\."skillSnapshots"/u
  );
  assert.match(
    queryText(captured(created.statements, 1)),
    /"step"\."approvalStatus" = 'approved'/u
  );

  const duplicate = scripted([operation]);
  assert.equal(
    (
      await duplicate.store.beginGitHubOperation(principal, {
        capabilityId: CAPABILITY_A,
        id: GITHUB_OPERATION_A,
        kind: "pull.create",
        operationId: OPERATION_A,
        repository: "OpenCoven/coven-agents",
        requestHash: "d".repeat(64),
        target: "OpenCoven/coven-agents:feature/team",
        teamStepId: TEAM_STEP_A,
      })
    ).kind,
    "duplicate"
  );

  const conflict = scripted([operation]);
  assert.equal(
    (
      await conflict.store.beginGitHubOperation(principal, {
        capabilityId: CAPABILITY_A,
        id: GITHUB_OPERATION_A,
        kind: "pull.create",
        operationId: OPERATION_A,
        repository: "OpenCoven/coven-agents",
        requestHash: "e".repeat(64),
        target: "OpenCoven/coven-agents:other",
        teamStepId: TEAM_STEP_A,
      })
    ).kind,
    "conflict"
  );

  const differentCapability = scripted([operation]);
  assert.equal(
    (
      await differentCapability.store.beginGitHubOperation(principal, {
        capabilityId: CAPABILITY_B,
        id: GITHUB_OPERATION_A,
        kind: "pull.create",
        operationId: OPERATION_A,
        repository: "OpenCoven/coven-agents",
        requestHash: "d".repeat(64),
        target: "OpenCoven/coven-agents:feature/team",
        teamStepId: TEAM_STEP_A,
      })
    ).kind,
    "conflict"
  );
});

test("GitHub operation completion stores only bounded receipt columns", async () => {
  const running = {
    capabilityId: CAPABILITY_A,
    completedAt: null,
    createdAt: NOW,
    error: null,
    id: GITHUB_OPERATION_A,
    kind: "pull.create",
    operationId: OPERATION_A,
    providerRequestId: null,
    requestHash: "d".repeat(64),
    resultNodeId: null,
    resultUrl: null,
    startedAt: NOW,
    status: "running",
    target: "OpenCoven/coven-agents:feature/team",
    teamStepId: TEAM_STEP_A,
    tenant: principal.tenant,
    updatedAt: NOW,
    version: 1,
  };
  const completed = {
    ...running,
    completedAt: NOW,
    providerRequestId: "req_123",
    resultNodeId: "PR_kwDOExample",
    resultUrl: "https://github.com/OpenCoven/coven-agents/pull/123",
    status: "completed",
    version: 2,
  };
  const { statements, store } = scripted([running], [completed]);

  const result = await store.completeGitHubOperation(principal, {
    error: null,
    expectedVersion: 1,
    id: GITHUB_OPERATION_A,
    providerRequestId: "req_123",
    resultNodeId: "PR_kwDOExample",
    resultUrl: "https://github.com/OpenCoven/coven-agents/pull/123",
    status: "completed",
  });

  assert.equal(result.kind, "updated");
  assert.deepEqual(Object.keys(captured(statements, 1).args).sort(), [
    "error",
    "expectedVersion",
    "id",
    "providerRequestId",
    "resultNodeId",
    "resultUrl",
    "status",
    "tenant",
  ]);
  assert.ok(
    String(statements[1]?.args.resultUrl).length <= 2048,
    "result URL remains bounded"
  );
});

test("GitHub operation completion rejects oversized receipt fields", async () => {
  const { statements, store } = scripted();

  await assert.rejects(
    store.completeGitHubOperation(principal, {
      error: {
        code: "github_failed",
        details: "x".repeat(AGENT_RUNNER_LIMITS.maxDetailsLength + 1),
        message: "Provider request failed.",
        retryable: false,
      },
      expectedVersion: 1,
      id: GITHUB_OPERATION_A,
      providerRequestId: null,
      resultNodeId: null,
      resultUrl: null,
      status: "failed",
    }),
    /error|details/i
  );
  assert.equal(statements.length, 0);
});
