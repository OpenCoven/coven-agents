// biome-ignore-all lint/suspicious/useAwait: Dependency doubles keep async signatures for readability.
import assert from "node:assert/strict";
import test from "node:test";
import { TEAM_LIMITS } from "@opencoven/agent-contracts";
import type { RunnerPrincipal } from "@/lib/runner/types";
import {
  createTeamService,
  type TeamService,
  type TeamServiceStore,
} from "./service";
import type { TeamRecord, TeamRunRecord, TeamSkillRecord } from "./store";

const USER_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";
const TENANT = "u_9c8589018a57479181fe4c455b099bc9";
const OTHER_TENANT = "u_11111111111111111111111111111111";
const SKILL_ID = "11111111-1111-4111-8111-111111111111";
const TEAM_ID = "22222222-2222-4222-8222-222222222222";
const MEMBER_A = "33333333-3333-4333-8333-333333333333";
const MEMBER_B = "44444444-4444-4444-8444-444444444444";
const AGENT_A = "55555555-5555-4555-8555-555555555555";
const AGENT_B = "66666666-6666-4666-8666-666666666666";
const NOW = new Date("2026-08-30T12:00:00.000Z");
const TEAM_RUN_ID = "77777777-7777-4777-8777-777777777777";
const TEAM_STEP_A = "88888888-8888-4888-8888-888888888888";
const TEAM_STEP_B = "99999999-9999-4999-8999-999999999999";
const OPERATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHILD_RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const principal: RunnerPrincipal = {
  kind: "subscriber",
  tenant: TENANT,
  userId: USER_ID,
};
const otherPrincipal: RunnerPrincipal = {
  ...principal,
  tenant: OTHER_TENANT,
};

function skillRecord(
  overrides: Partial<TeamSkillRecord> = {}
): TeamSkillRecord {
  return {
    createdAt: NOW,
    description: "Requires focused regression evidence.",
    id: SKILL_ID,
    instructions: "Run the smallest regression test that proves the change.",
    name: "Release evidence",
    requiredCapabilities: ["workspace.read"],
    tenant: TENANT,
    updatedAt: NOW,
    version: 2,
    ...overrides,
  };
}

function teamRecord(overrides: Partial<TeamRecord> = {}): TeamRecord {
  return {
    createdAt: NOW,
    description: "Moves approved work through delivery.",
    id: TEAM_ID,
    members: [
      {
        agentId: AGENT_A,
        id: MEMBER_A,
        position: 0,
        required: true,
        responsibility: "Implement the approved change.",
        skillIds: [SKILL_ID],
      },
      {
        agentId: AGENT_B,
        id: MEMBER_B,
        position: 1,
        required: false,
        responsibility: "Review the resulting change.",
        skillIds: [],
      },
    ],
    name: "Delivery team",
    tenant: TENANT,
    updatedAt: NOW,
    version: 3,
    ...overrides,
  };
}

function teamRunRecord(overrides: Partial<TeamRunRecord> = {}): TeamRunRecord {
  return {
    authVersion: 7,
    completedAt: null,
    createdAt: NOW,
    createdByUserId: USER_ID,
    currentPosition: 0,
    error: null,
    id: TEAM_RUN_ID,
    mission: "Deliver the approved issue.",
    operationId: OPERATION_ID,
    requestHash: "a".repeat(64),
    startedAt: null,
    status: "queued",
    steps: [
      {
        agentId: AGENT_A,
        agentInstructions: "Keep evidence concise.",
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
        responsibility: "Implement the change.",
        runnerRunId: null,
        skillIds: [SKILL_ID],
        skillSnapshots: [],
        startedAt: null,
        status: "pending",
        teamRunId: TEAM_RUN_ID,
        tenant: TENANT,
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
        responsibility: "Review the result.",
        runnerRunId: null,
        skillIds: [],
        skillSnapshots: [],
        startedAt: null,
        status: "pending",
        teamRunId: TEAM_RUN_ID,
        tenant: TENANT,
        updatedAt: NOW,
        version: 0,
      },
    ],
    teamId: TEAM_ID,
    tenant: TENANT,
    updatedAt: NOW,
    version: 0,
    ...overrides,
  };
}

function store(overrides: Partial<TeamServiceStore> = {}): TeamServiceStore {
  return {
    cancelTeamRun: async () => ({
      childRunId: null,
      kind: "updated",
      value: teamRunRecord({ status: "cancelled", version: 1 }),
    }),
    createSkill: async () => ({
      kind: "created",
      skill: skillRecord({ version: 0 }),
    }),
    createTeam: async () => ({
      kind: "created",
      team: teamRecord({ version: 0 }),
    }),
    createTeamRun: async () => ({
      kind: "created",
      run: teamRunRecord(),
    }),
    decideTeamStepApproval: async () => ({
      kind: "updated",
      value: teamRunRecord().steps[1],
    }),
    deleteSkill: async () => ({ kind: "deleted" }),
    deleteTeam: async () => ({ kind: "deleted" }),
    getSkill: async () => skillRecord(),
    getTeam: async () => teamRecord(),
    getTeamRun: async () => teamRunRecord(),
    listSkills: async () => [skillRecord()],
    listTeamRuns: async () => [teamRunRecord()],
    listTeams: async () => [teamRecord()],
    updateSkill: async () => ({
      kind: "updated",
      value: skillRecord({ name: "Updated", version: 3 }),
    }),
    updateTeam: async () => ({
      kind: "updated",
      value: teamRecord({ name: "Updated", version: 4 }),
    }),
    ...overrides,
  };
}

function service(
  overrides: Partial<TeamServiceStore> = {},
  ids: string[] = [SKILL_ID, TEAM_ID, MEMBER_A, MEMBER_B]
): TeamService {
  return createTeamService({
    createId: () => {
      const id = ids.shift();
      assert.ok(id, "fixture exhausted generated IDs");
      return id;
    },
    store: store(overrides),
  });
}

const validSkill = {
  description: "Requires focused regression evidence.",
  instructions: "Run the smallest regression test that proves the change.",
  name: "Release evidence",
  requiredCapabilities: ["workspace.read"] as const,
};

const validTeam = {
  description: "Moves approved work through delivery.",
  members: [
    {
      agentId: AGENT_A,
      required: true,
      responsibility: "Implement the approved change.",
      skillIds: [SKILL_ID],
    },
    {
      agentId: AGENT_B,
      required: false,
      responsibility: "Review the resulting change.",
      skillIds: [],
    },
  ],
  name: "Delivery team",
};

test("skill CRUD projects tenant-free resources and passes only authenticated authority", async () => {
  const calls: unknown[][] = [];
  const teamService = service({
    createSkill: (...args) => {
      calls.push(["create", ...args]);
      return Promise.resolve({
        kind: "created",
        skill: skillRecord({ version: 0 }),
      });
    },
    deleteSkill: (...args) => {
      calls.push(["delete", ...args]);
      return Promise.resolve({ kind: "deleted" });
    },
    getSkill: (...args) => {
      calls.push(["get", ...args]);
      return Promise.resolve(skillRecord());
    },
    listSkills: (...args) => {
      calls.push(["list", ...args]);
      return Promise.resolve([skillRecord()]);
    },
    updateSkill: (...args) => {
      calls.push(["update", ...args]);
      return Promise.resolve({
        kind: "updated",
        value: skillRecord({ name: "Updated", version: 3 }),
      });
    },
  });

  const listed = await teamService.listSkills(principal);
  const found = await teamService.getSkill(principal, SKILL_ID);
  const created = await teamService.createSkill(principal, validSkill);
  const updated = await teamService.updateSkill(principal, SKILL_ID, {
    ...validSkill,
    expectedVersion: 2,
    name: "Updated",
  });
  const deleted = await teamService.deleteSkill(principal, SKILL_ID, 3);

  assert.equal(listed[0]?.name, "Release evidence");
  assert.equal(found.kind, "found");
  assert.equal(created.kind, "created");
  assert.equal(updated.kind, "updated");
  assert.deepEqual(deleted, { kind: "deleted" });
  for (const value of [listed, found, created, updated]) {
    assert.equal(JSON.stringify(value).includes(TENANT), false);
  }
  assert.deepEqual(calls, [
    ["list", principal],
    ["get", principal, SKILL_ID],
    ["create", principal, { ...validSkill, id: SKILL_ID }],
    [
      "update",
      principal,
      {
        ...validSkill,
        expectedVersion: 2,
        id: SKILL_ID,
        name: "Updated",
      },
    ],
    ["delete", principal, { expectedVersion: 3, id: SKILL_ID }],
  ]);
});

test("team CRUD generates member IDs, preserves order, and maps ownership failures", async () => {
  let createInput: unknown;
  let updateInput: unknown;
  const teamService = service(
    {
      createTeam: (_principal, input) => {
        createInput = input;
        return Promise.resolve({
          kind: "created",
          team: teamRecord({ version: 0 }),
        });
      },
      updateTeam: (_principal, input) => {
        updateInput = input;
        return Promise.resolve({ kind: "not_found" });
      },
    },
    [TEAM_ID, MEMBER_A, MEMBER_B, MEMBER_A, MEMBER_B]
  );

  const created = await teamService.createTeam(principal, validTeam);
  const updated = await teamService.updateTeam(principal, TEAM_ID, {
    ...validTeam,
    expectedVersion: 3,
  });

  assert.equal(created.kind, "created");
  assert.deepEqual(updated, { kind: "not_found" });
  assert.deepEqual(createInput, {
    ...validTeam,
    id: TEAM_ID,
    members: [
      { ...validTeam.members[0], id: MEMBER_A },
      { ...validTeam.members[1], id: MEMBER_B },
    ],
  });
  assert.deepEqual(updateInput, {
    ...validTeam,
    expectedVersion: 3,
    id: TEAM_ID,
    members: [
      { ...validTeam.members[0], id: MEMBER_A },
      { ...validTeam.members[1], id: MEMBER_B },
    ],
  });
  assert.deepEqual(
    created.kind === "created"
      ? created.team.members.map(({ agentId }) => agentId)
      : [],
    [AGENT_A, AGENT_B]
  );
  assert.equal(JSON.stringify(created).includes(TENANT), false);
});

test("creation keys produce stable resource and member IDs across crash retries", async () => {
  const skillIds: string[] = [];
  const teamIds: string[] = [];
  const memberIds: string[][] = [];
  const retryStore = store({
    createSkill: (_principal, input) => {
      skillIds.push(input.id);
      return Promise.resolve({
        kind: "created",
        skill: skillRecord({
          ...input,
          createdAt: NOW,
          description: input.description ?? "",
          requiredCapabilities: input.requiredCapabilities ?? [],
          tenant: TENANT,
          updatedAt: NOW,
          version: 0,
        }),
      });
    },
    createTeam: (_principal, input) => {
      teamIds.push(input.id);
      memberIds.push(input.members.map(({ id }) => id));
      return Promise.resolve({
        kind: "created",
        team: teamRecord({
          createdAt: NOW,
          description: input.description ?? "",
          id: input.id,
          members: input.members.map((member, position) => ({
            agentId: member.agentId,
            id: member.id,
            position,
            required: member.required ?? true,
            responsibility: member.responsibility,
            skillIds: [...(member.skillIds ?? [])].sort(),
          })),
          name: input.name,
          tenant: TENANT,
          updatedAt: NOW,
          version: 0,
        }),
      });
    },
  });
  const first = createTeamService({ store: retryStore });
  const retry = createTeamService({ store: retryStore });

  await first.createSkill(principal, validSkill, "coven_stable_create");
  await retry.createSkill(principal, validSkill, "coven_stable_create");
  await first.createTeam(principal, validTeam, "coven_stable_create");
  await retry.createTeam(principal, validTeam, "coven_stable_create");

  assert.equal(skillIds[0], skillIds[1]);
  assert.equal(teamIds[0], teamIds[1]);
  assert.deepEqual(memberIds[0], memberIds[1]);
  assert.notEqual(skillIds[0], teamIds[0]);
  assert.ok(memberIds[0]?.every((id) => id !== teamIds[0]));
});

test("strict invalid service inputs do not reach the store", async () => {
  let calls = 0;
  const unavailable = () => {
    calls += 1;
    return Promise.reject(new Error("store must not be called"));
  };
  const teamService = service({
    createSkill: unavailable,
    createTeam: unavailable,
    updateSkill: unavailable,
    updateTeam: unavailable,
  } as Partial<TeamServiceStore>);

  assert.deepEqual(
    await teamService.createSkill(principal, {
      ...validSkill,
      tenant: OTHER_TENANT,
    }),
    { kind: "invalid" }
  );
  assert.deepEqual(
    await teamService.updateSkill(principal, SKILL_ID, {
      ...validSkill,
      expectedVersion: -1,
    }),
    { kind: "invalid" }
  );
  assert.deepEqual(
    await teamService.createTeam(principal, {
      ...validTeam,
      members: [...validTeam.members].reverse().slice(0, 1),
    }),
    { kind: "invalid" }
  );
  assert.deepEqual(
    await teamService.updateTeam(principal, TEAM_ID, {
      ...validTeam,
      expectedVersion: 3,
      tenant: OTHER_TENANT,
    }),
    { kind: "invalid" }
  );
  assert.equal(calls, 0);
});

test("service maps duplicate, stale, reference conflict, missing, and tenant-isolated outcomes", async () => {
  const teamService = service({
    createSkill: async () => ({ kind: "conflict" }),
    deleteSkill: async () => ({ kind: "conflict" }),
    deleteTeam: async () => ({ kind: "stale_version" }),
    getSkill: async (authority) =>
      authority.tenant === OTHER_TENANT ? null : skillRecord(),
    getTeam: async () => null,
    updateSkill: async () => ({ kind: "stale_version" }),
  });

  assert.deepEqual(await teamService.createSkill(principal, validSkill), {
    kind: "conflict",
  });
  assert.deepEqual(await teamService.deleteSkill(principal, SKILL_ID, 2), {
    kind: "conflict",
  });
  assert.deepEqual(await teamService.deleteTeam(principal, TEAM_ID, 3), {
    kind: "stale_version",
  });
  assert.deepEqual(
    await teamService.updateSkill(principal, SKILL_ID, {
      ...validSkill,
      expectedVersion: 2,
    }),
    { kind: "stale_version" }
  );
  assert.deepEqual(await teamService.getSkill(otherPrincipal, SKILL_ID), {
    kind: "not_found",
  });
  assert.deepEqual(await teamService.getTeam(principal, TEAM_ID), {
    kind: "not_found",
  });
});

test("malformed IDs are safe not-found results without store access", async () => {
  let calls = 0;
  const teamService = service({
    getSkill: () => {
      calls += 1;
      return Promise.resolve(skillRecord());
    },
    getTeam: () => {
      calls += 1;
      return Promise.resolve(teamRecord());
    },
  });

  assert.deepEqual(await teamService.getSkill(principal, "not-an-id"), {
    kind: "not_found",
  });
  assert.deepEqual(await teamService.getTeam(principal, "not-an-id"), {
    kind: "not_found",
  });
  assert.equal(calls, 0);
});

test("team run creation snapshots authenticated authority with stable run and step ids", async () => {
  const inputs: unknown[] = [];
  const teamService = createTeamService({
    store: store({
      createTeamRun: async (_authority, storedInput) => {
        inputs.push(storedInput);
        return {
          kind: inputs.length === 1 ? "created" : "duplicate",
          run: teamRunRecord({
            authVersion: storedInput.authVersion,
            id: storedInput.id,
            mission: storedInput.mission,
            operationId: storedInput.operationId,
            requestHash: storedInput.requestHash,
            steps: teamRunRecord().steps.map((step, position) => ({
              ...step,
              id: storedInput.stepIds[position] ?? step.id,
              teamRunId: storedInput.id,
            })),
          }),
        };
      },
    }),
  });
  const input = {
    operationId: OPERATION_ID,
    task: "Deliver the approved issue.",
  };

  const first = await teamService.createRun(principal, 7, TEAM_ID, input);
  const duplicate = await teamService.createRun(principal, 7, TEAM_ID, input);

  assert.equal(first.kind, "created");
  assert.equal(duplicate.kind, "duplicate");
  assert.equal(JSON.stringify(first).includes(TENANT), false);
  assert.deepEqual(inputs[0], inputs[1]);
  const stored = inputs[0] as {
    authVersion: number;
    id: string;
    mission: string;
    stepIds: string[];
  };
  assert.equal(stored.authVersion, 7);
  assert.equal(stored.mission, input.task);
  assert.equal(stored.stepIds.length, 2);
  assert.notEqual(stored.id, stored.stepIds[0]);
  assert.notEqual(stored.stepIds[0], stored.stepIds[1]);
});

test("team run reads are tenant-free and expose optimistic versions", async () => {
  const record = teamRunRecord({
    steps: teamRunRecord().steps.map((step, index) =>
      index === 0
        ? {
            ...step,
            skillSnapshots: [
              {
                description: "Applies a bounded approved issue update.",
                id: SKILL_ID,
                instructions: "Apply only the approved GitHub issue update.",
                name: "Issue update",
                requiredCapabilities: [
                  "github.issues.read",
                  "github.issues.write",
                ],
              },
            ],
          }
        : step
    ),
  });
  const teamService = createTeamService({
    store: store({
      getTeamRun: async () => record,
      listTeamRuns: async () => [record],
    }),
  });

  const found = await teamService.getRun(principal, TEAM_RUN_ID);
  const listed = await teamService.listRuns(principal, TEAM_ID);

  assert.equal(found.kind, "found");
  assert.equal(found.kind === "found" && found.teamRun.version, 0);
  assert.equal(found.kind === "found" && found.teamRun.steps[0]?.version, 0);
  assert.deepEqual(
    found.kind === "found" ? found.teamRun.steps[0]?.approvalCapabilities : [],
    ["github.issues.write"]
  );
  assert.equal(listed.kind, "found");
  assert.equal(listed.kind === "found" && listed.teamRuns[0]?.id, TEAM_RUN_ID);
  assert.equal(listed.kind === "found" && listed.nextCursor, null);
  assert.equal(JSON.stringify({ found, listed }).includes(TENANT), false);
  assert.equal(JSON.stringify({ found, listed }).includes(USER_ID), false);
});

test("team run listing returns one bounded page and an opaque continuation cursor", async () => {
  let observedCursor: string | null | undefined;
  const records = Array.from(
    { length: TEAM_LIMITS.maxTeamRunsPerPage + 1 },
    (_, index) =>
      teamRunRecord({
        id: `70000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      })
  );
  const teamService = createTeamService({
    store: store({
      listTeamRuns: async (_principal, _teamId, cursor) => {
        observedCursor = cursor;
        return records;
      },
    }),
  });

  const result = await teamService.listRuns(principal, TEAM_ID, TEAM_RUN_ID);

  assert.equal(result.kind, "found");
  assert.equal(observedCursor, TEAM_RUN_ID);
  assert.equal(
    result.kind === "found" && result.teamRuns.length,
    TEAM_LIMITS.maxTeamRunsPerPage
  );
  assert.equal(
    result.kind === "found" && result.nextCursor,
    records[TEAM_LIMITS.maxTeamRunsPerPage - 1]?.id
  );
});

test("team run listing returns not found for a missing or cross-tenant parent", async () => {
  const teamService = createTeamService({
    store: store({
      getTeam: async () => null,
      listTeamRuns: async () => {
        throw new Error("child rows must not be queried");
      },
    }),
  });

  assert.deepEqual(await teamService.listRuns(principal, TEAM_ID), {
    kind: "not_found",
  });
});

test("approval targets only the current waiting step and preserves actor authority", async () => {
  const calls: unknown[][] = [];
  const waiting = teamRunRecord({
    currentPosition: 1,
    status: "waiting_approval",
    steps: teamRunRecord().steps.map((step, index) =>
      index === 1
        ? {
            ...step,
            approvalStatus: "pending",
            status: "waiting_approval",
            version: 4,
          }
        : step
    ),
  });
  const approved = teamRunRecord({
    ...waiting,
    status: "queued",
    steps: waiting.steps.map((step, index) =>
      index === 1
        ? {
            ...step,
            approvalActorUserId: USER_ID,
            approvalDecidedAt: NOW,
            approvalStatus: "approved",
            approvedCapabilities: ["github.pull_requests.write"],
            version: 5,
          }
        : step
    ),
  });
  let reads = 0;
  const teamService = createTeamService({
    store: store({
      decideTeamStepApproval: async (...args) => {
        calls.push(args);
        return { kind: "updated", value: approved.steps[1] };
      },
      getTeamRun: async () => {
        reads += 1;
        return reads === 1 ? waiting : approved;
      },
    }),
  });

  const result = await teamService.approveRun(principal, TEAM_RUN_ID, {
    capabilities: ["github.pull_requests.write"],
    decision: "approve",
    expectedVersion: 4,
  });

  assert.equal(result.kind, "approved");
  assert.deepEqual(calls, [
    [
      principal,
      {
        capabilities: ["github.pull_requests.write"],
        decision: "approve",
        expectedVersion: 4,
        id: TEAM_STEP_B,
      },
    ],
  ]);
  assert.deepEqual(
    await teamService.approveRun(principal, TEAM_RUN_ID, {
      decision: "reject",
      expectedVersion: 5,
    }),
    { kind: "invalid_transition" }
  );
  assert.equal(calls.length, 1);
});

test("public rejection persists the actor decision and returns required failure", async () => {
  const calls: unknown[][] = [];
  const waiting = teamRunRecord({
    status: "waiting_approval",
    steps: teamRunRecord().steps.map((step, index) =>
      index === 0
        ? {
            ...step,
            approvalStatus: "pending",
            status: "waiting_approval",
            version: 4,
          }
        : step
    ),
  });
  const rejected = teamRunRecord({
    ...waiting,
    completedAt: NOW,
    error: {
      code: "approval_rejected",
      message: "GitHub operation approval was rejected.",
      retryable: false,
    },
    status: "failed",
    steps: waiting.steps.map((step, index) =>
      index === 0
        ? {
            ...step,
            approvalActorUserId: USER_ID,
            approvalDecidedAt: NOW,
            approvalStatus: "rejected",
            completedAt: NOW,
            error: {
              code: "approval_rejected",
              message: "GitHub operation approval was rejected.",
              retryable: false,
            },
            status: "failed",
            version: 5,
          }
        : step
    ),
  });
  let reads = 0;
  const teamService = createTeamService({
    store: store({
      decideTeamStepApproval: async (...args) => {
        calls.push(args);
        return { kind: "updated", value: rejected.steps[0] };
      },
      getTeamRun: async (authority) => {
        assert.equal(authority.tenant, TENANT);
        reads += 1;
        return reads === 1 ? waiting : rejected;
      },
    }),
  });

  const result = await teamService.approveRun(principal, TEAM_RUN_ID, {
    decision: "reject",
    expectedVersion: 4,
  });

  assert.equal(result.kind, "rejected");
  assert.equal(result.kind === "rejected" && result.teamRun.status, "failed");
  assert.deepEqual(calls, [
    [
      principal,
      {
        capabilities: [],
        decision: "reject",
        expectedVersion: 4,
        id: TEAM_STEP_A,
      },
    ],
  ]);
});

test("optional rejection returns completed_with_warnings and stale or cross-tenant decisions stay fenced", async () => {
  const waiting = teamRunRecord({
    currentPosition: 1,
    status: "waiting_approval",
    steps: teamRunRecord().steps.map((step, index) =>
      index === 1
        ? {
            ...step,
            approvalStatus: "pending",
            status: "waiting_approval",
            version: 4,
          }
        : step
    ),
  });
  const rejected = teamRunRecord({
    ...waiting,
    completedAt: NOW,
    status: "completed_with_warnings",
    steps: waiting.steps.map((step, index) =>
      index === 1
        ? {
            ...step,
            approvalActorUserId: USER_ID,
            approvalDecidedAt: NOW,
            approvalStatus: "rejected",
            completedAt: NOW,
            error: {
              code: "approval_rejected",
              message: "GitHub operation approval was rejected.",
              retryable: false,
            },
            status: "failed",
            version: 5,
          }
        : step
    ),
  });
  let reads = 0;
  const optional = createTeamService({
    store: store({
      decideTeamStepApproval: async () => ({
        kind: "updated",
        value: rejected.steps[1],
      }),
      getTeamRun: async () => {
        reads += 1;
        return reads === 1 ? waiting : rejected;
      },
    }),
  });
  const optionalResult = await optional.approveRun(principal, TEAM_RUN_ID, {
    capabilities: [],
    decision: "reject",
    expectedVersion: 4,
  });
  assert.equal(
    optionalResult.kind === "rejected" && optionalResult.teamRun.status,
    "completed_with_warnings"
  );

  const stale = createTeamService({
    store: store({
      decideTeamStepApproval: async () => ({ kind: "stale_version" }),
      getTeamRun: async (authority) =>
        authority.tenant === TENANT ? waiting : null,
    }),
  });
  assert.deepEqual(
    await stale.approveRun(principal, TEAM_RUN_ID, {
      decision: "reject",
      expectedVersion: 3,
    }),
    { kind: "stale_version" }
  );
  assert.deepEqual(
    await stale.approveRun(otherPrincipal, TEAM_RUN_ID, {
      decision: "reject",
      expectedVersion: 4,
    }),
    { kind: "not_found" }
  );
});

test("stopping persists team cancellation before targeting only its attached child", async () => {
  const calls: string[] = [];
  const cancelled = teamRunRecord({
    completedAt: NOW,
    status: "cancelled",
    steps: teamRunRecord().steps.map((step, index) =>
      index === 0
        ? {
            ...step,
            completedAt: NOW,
            runnerRunId: CHILD_RUN_ID,
            status: "cancelled",
          }
        : { ...step, completedAt: NOW, status: "skipped" }
    ),
    version: 4,
  });
  const teamService = createTeamService({
    cancelChild: async (authority, runId) => {
      calls.push(`child:${authority.tenant}:${runId}`);
      return { kind: "stopped" };
    },
    store: store({
      cancelTeamRun: async () => {
        calls.push("persist");
        return {
          childRunId: CHILD_RUN_ID,
          kind: "updated",
          value: cancelled,
        };
      },
    }),
  });

  const result = await teamService.stopRun(principal, TEAM_RUN_ID, 3);

  assert.equal(result.kind, "stopped");
  assert.equal(
    result.kind === "stopped" && result.scheduleReconciliation,
    true
  );
  assert.deepEqual(calls, ["persist", `child:${TENANT}:${CHILD_RUN_ID}`]);
});

test("repeated stop safely returns the tenant-fenced terminal team run", async () => {
  const cancelled = teamRunRecord({
    completedAt: NOW,
    status: "cancelled",
    version: 4,
  });
  let reads = 0;
  const teamService = createTeamService({
    store: store({
      cancelTeamRun: async () => ({ kind: "already_terminal" }),
      getTeamRun: async () => {
        reads += 1;
        return cancelled;
      },
    }),
  });

  const result = await teamService.stopRun(principal, TEAM_RUN_ID, 4);

  assert.equal(result.kind, "stopped");
  assert.equal(
    result.kind === "stopped" && result.cancellation,
    "not_required"
  );
  assert.equal(result.kind === "stopped" && result.teamRun.status, "cancelled");
  assert.equal(reads, 1);
});
