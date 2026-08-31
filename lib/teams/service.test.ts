import assert from "node:assert/strict";
import test from "node:test";
import type { RunnerPrincipal } from "@/lib/runner/types";
import {
  createTeamService,
  type TeamCrudStore,
  type TeamService,
} from "./service";
import type { TeamRecord, TeamSkillRecord } from "./store";

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

function store(overrides: Partial<TeamCrudStore> = {}): TeamCrudStore {
  return {
    createSkill: async () => ({
      kind: "created",
      skill: skillRecord({ version: 0 }),
    }),
    createTeam: async () => ({
      kind: "created",
      team: teamRecord({ version: 0 }),
    }),
    deleteSkill: async () => ({ kind: "deleted" }),
    deleteTeam: async () => ({ kind: "deleted" }),
    getSkill: async () => skillRecord(),
    getTeam: async () => teamRecord(),
    listSkills: async () => [skillRecord()],
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
  overrides: Partial<TeamCrudStore> = {},
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
  } as Partial<TeamCrudStore>);

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
