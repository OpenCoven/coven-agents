import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  AGENT_RUNNER_LIMITS,
  TEAM_LIMITS,
  type TeamHandoff,
} from "@opencoven/agent-contracts";
import { PgDialect } from "drizzle-orm/pg-core";
import type { RunnerPrincipal } from "../runner/types";
import { createTeamStore, type TeamStoreStatement } from "./store";

const principal: RunnerPrincipal = {
  kind: "subscriber",
  tenant: "tenant_a",
  userId: "user_a",
};
const otherPrincipal: RunnerPrincipal = {
  kind: "subscriber",
  tenant: "tenant_b",
  userId: "user_b",
};
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
    completedAt: null,
    createdAt: NOW,
    currentPosition: 0,
    error: null,
    id: TEAM_RUN_A,
    mission: "Ship the approved change.",
    operationId: OPERATION_A,
    requestHash: "a".repeat(64),
    startedAt: null,
    status: "queued",
    steps: [
      {
        agentId: AGENT_A,
        approvalStatus: "not_required",
        completedAt: null,
        createdAt: NOW,
        error: null,
        handoff: null,
        id: TEAM_STEP_A,
        memberId: MEMBER_A,
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
        tenant: principal.tenant,
        updatedAt: NOW,
        version: 0,
      },
      {
        agentId: AGENT_B,
        approvalStatus: "pending",
        completedAt: null,
        createdAt: NOW,
        error: null,
        handoff: null,
        id: TEAM_STEP_B,
        memberId: MEMBER_B,
        position: 1,
        required: false,
        responsibility: "Review the change.",
        runnerRunId: null,
        skillIds: [SKILL_B],
        skillSnapshots: [],
        startedAt: null,
        status: "pending",
        tenant: principal.tenant,
        updatedAt: NOW,
        version: 0,
      },
    ],
    teamId: TEAM_A,
    tenant: principal.tenant,
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
  assert.doesNotMatch(
    migration,
    /accessToken|authorizationHeader|rawResponse/iu
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
});

test("approval decisions require a pending approval and matching version", async () => {
  const pending = {
    ...(teamRunRow().steps as Record<string, unknown>[])[1],
    approvalStatus: "pending",
    version: 5,
  };
  const approved = {
    ...pending,
    approvalStatus: "approved",
    version: 6,
  };
  const { statements, store } = scripted([pending], [approved]);

  const result = await store.decideTeamStepApproval(principal, {
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

  const alreadyDecided = scripted([approved]);
  assert.deepEqual(
    await alreadyDecided.store.decideTeamStepApproval(principal, {
      decision: "reject",
      expectedVersion: 6,
      id: TEAM_STEP_B,
    }),
    { kind: "invalid_transition" }
  );
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
  assert.match(
    queryText(captured(statements, 2)),
    /"status" IN \('pending', 'queued', 'running', 'waiting_approval'\)/u
  );
  for (const statement of statements) {
    assert.equal(statement.args.tenant, principal.tenant);
  }
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
