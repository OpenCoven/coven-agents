import { expect, test } from "@playwright/test";
import { subscriberCookies } from "./session";

const NOW = "2026-08-31T15:00:00.000Z";
const AGENT_A = "11111111-1111-4111-8111-111111111111";
const AGENT_B = "22222222-2222-4222-8222-222222222222";
const SKILL_ID = "33333333-3333-4333-8333-333333333333";
const TEAM_ID = "44444444-4444-4444-8444-444444444444";
const MEMBER_A = "55555555-5555-4555-8555-555555555555";
const MEMBER_B = "66666666-6666-4666-8666-666666666666";
const TEAM_RUN_ID = "77777777-7777-4777-8777-777777777777";
const TEAM_STEP_ID = "88888888-8888-4888-8888-888888888888";
const RUNNER_RUN_ID = "99999999-9999-4999-8999-999999999999";
const OPERATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const agents = [
  {
    backend: "cloud",
    createdAt: NOW,
    description: "Surveys the repository and returns bounded findings.",
    id: AGENT_A,
    instructions: "Inspect first and report evidence without editing.",
    lastRunAt: null,
    model: "auto",
    name: "Scout",
    owner: {
      kind: "tenant",
      tenantId: "u_00000000000040008000000000000001",
    },
    runtime: "copilot",
    status: "idle",
    updatedAt: NOW,
    warm: { status: "ready", updatedAt: NOW },
  },
  {
    backend: "cloud",
    createdAt: NOW,
    description: "Implements an approved bounded change.",
    id: AGENT_B,
    instructions: "Implement the requested change and prove it.",
    lastRunAt: null,
    model: "auto",
    name: "Builder",
    owner: {
      kind: "tenant",
      tenantId: "u_00000000000040008000000000000001",
    },
    runtime: "copilot",
    status: "idle",
    updatedAt: NOW,
    warm: { status: "ready", updatedAt: NOW },
  },
] as const;

const skill = {
  createdAt: NOW,
  description: "Apply an approved issue update after verification.",
  id: SKILL_ID,
  instructions:
    "Inspect the issue, verify the requested change, then apply only the approved update.",
  name: "Approved issue update",
  requiredCapabilities: ["github.issues.read", "github.issues.write"],
  updatedAt: NOW,
  version: 0,
} as const;

const team = {
  createdAt: NOW,
  description: "Coordinates issue triage and bounded implementation.",
  id: TEAM_ID,
  members: [
    {
      agentId: AGENT_A,
      id: MEMBER_A,
      position: 0,
      required: true,
      responsibility: "Triage the issue and return a bounded handoff.",
      skillIds: [SKILL_ID],
    },
    {
      agentId: AGENT_B,
      id: MEMBER_B,
      position: 1,
      required: true,
      responsibility: "Implement the approved bounded change.",
      skillIds: [],
    },
  ],
  name: "Issue delivery",
  updatedAt: NOW,
  version: 0,
} as const;

function waitingRun() {
  return {
    completedAt: null,
    createdAt: NOW,
    currentPosition: 0,
    error: null,
    id: TEAM_RUN_ID,
    mission: "Resolve the approved issue and return verified evidence.",
    operationId: OPERATION_ID,
    startedAt: null,
    status: "waiting_approval",
    steps: [
      {
        agentId: AGENT_A,
        approvalCapabilities: ["github.issues.write"],
        approvalStatus: "pending",
        completedAt: null,
        createdAt: NOW,
        error: null,
        handoff: null,
        id: TEAM_STEP_ID,
        position: 0,
        required: true,
        responsibility: "Triage the issue and return a bounded handoff.",
        runnerRunId: null,
        skillIds: [SKILL_ID],
        startedAt: null,
        status: "waiting_approval",
        updatedAt: NOW,
        version: 1,
      },
    ],
    teamId: TEAM_ID,
    updatedAt: NOW,
    version: 1,
  } as const;
}

function completedRun() {
  return {
    ...waitingRun(),
    completedAt: NOW,
    currentPosition: 1,
    startedAt: NOW,
    status: "completed",
    steps: [
      {
        ...waitingRun().steps[0],
        approvalStatus: "approved",
        completedAt: NOW,
        handoff: {
          commandEvidence: [
            {
              command: "pnpm test:unit",
              exitCode: 0,
              stderr: "",
              stdout: "All focused tests passed.",
            },
          ],
          fileEvidence: [
            {
              operation: "modify",
              path: "src/issues.ts",
            },
          ],
          output: "Issue update completed with focused verification.",
        },
        runnerRunId: RUNNER_RUN_ID,
        startedAt: NOW,
        status: "completed",
        version: 2,
      },
    ],
    updatedAt: NOW,
    version: 2,
  } as const;
}

test.describe("Team console", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("creates a reusable skill and ordered team, then approves and reports a run", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies());
    let approved = false;
    let markPollStarted: (() => void) | undefined;
    let markRunListStarted: (() => void) | undefined;
    let markSkillCreateStarted: (() => void) | undefined;
    let releaseRunList: (() => void) | undefined;
    let releaseSkillCreate: (() => void) | undefined;
    let releaseStalePoll: (() => void) | undefined;
    const pollStarted = new Promise<void>((resolve) => {
      markPollStarted = resolve;
    });
    const stalePollReleased = new Promise<void>((resolve) => {
      releaseStalePoll = resolve;
    });
    const runListStarted = new Promise<void>((resolve) => {
      markRunListStarted = resolve;
    });
    const runListReleased = new Promise<void>((resolve) => {
      releaseRunList = resolve;
    });
    const skillCreateStarted = new Promise<void>((resolve) => {
      markSkillCreateStarted = resolve;
    });
    const skillCreateReleased = new Promise<void>((resolve) => {
      releaseSkillCreate = resolve;
    });

    await page.route("**/api/tenant/prewarm", (route) =>
      route.fulfill({ status: 204 })
    );
    await page.route("**/api/credentials", (route) =>
      route.fulfill({ json: { harnessIds: ["copilot"] } })
    );
    await page.route(/\/api\/(?:agents|runs)(?:\/|$)/, (route) => {
      const { pathname } = new URL(route.request().url());
      return route.fulfill(
        pathname === "/api/agents"
          ? { json: { agents } }
          : { json: { apiVersion: "1.0", runs: [] } }
      );
    });
    await page.route("**/api/skills", async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({ json: { skills: [] } });
      }
      expect(await route.request().postDataJSON()).toMatchObject({
        name: skill.name,
        requiredCapabilities: skill.requiredCapabilities,
      });
      markSkillCreateStarted?.();
      await skillCreateReleased;
      return route.fulfill({ json: { skill }, status: 201 });
    });
    await page.route("**/api/teams", async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({ json: { teams: [] } });
      }
      expect(await route.request().postDataJSON()).toMatchObject({
        members: [
          {
            agentId: AGENT_A,
            required: true,
            skillIds: [SKILL_ID],
          },
          {
            agentId: AGENT_B,
            required: true,
            skillIds: [],
          },
        ],
        name: team.name,
      });
      return route.fulfill({ json: { team }, status: 201 });
    });
    await page.route(`**/api/teams/${TEAM_ID}/runs`, async (route) => {
      if (route.request().method() === "GET") {
        markRunListStarted?.();
        await runListReleased;
        return route.fulfill({
          json: { nextCursor: null, teamRuns: [] },
        });
      }
      expect(await route.request().postDataJSON()).toMatchObject({
        task: "Resolve the approved issue and return verified evidence.",
      });
      return route.fulfill({
        json: { teamRun: waitingRun() },
        status: 201,
      });
    });
    await page.route(`**/api/team-runs/${TEAM_RUN_ID}`, async (route) => {
      if (!approved) {
        markPollStarted?.();
        await stalePollReleased;
      }
      return route.fulfill({
        json: { teamRun: approved ? completedRun() : waitingRun() },
      });
    });
    await page.route(
      `**/api/team-runs/${TEAM_RUN_ID}/approve`,
      async (route) => {
        expect(await route.request().postDataJSON()).toEqual({
          capabilities: ["github.issues.write"],
          decision: "approve",
          expectedVersion: 1,
        });
        approved = true;
        return route.fulfill({ json: { teamRun: completedRun() } });
      }
    );

    await page.goto("/agents");
    await page.getByRole("button", { name: "Teams" }).click();
    await expect(page.getByText("Saved teams")).toBeVisible();

    await page.getByRole("button", { name: "Create reusable skill" }).click();
    const skillForm = page.locator(".oc-team-form");
    await expect(
      skillForm.getByText(
        "GitHub Project capabilities appear only while exact user Project-management authority remains current."
      )
    ).toBeVisible();
    await expect(skillForm.getByLabel("github.projects.write")).toHaveCount(0);
    await skillForm.getByLabel("Name").fill(skill.name);
    await skillForm.getByLabel("Description").fill(skill.description);
    await skillForm.getByLabel("Instructions").fill(skill.instructions);
    await skillForm.getByLabel("github.issues.read").check();
    await skillForm.getByLabel("github.issues.write").check();
    await skillForm.getByRole("button", { name: "Save skill" }).click();
    await skillCreateStarted;
    await expect(
      page.locator("header").getByRole("button", { name: "Runs" })
    ).toBeDisabled();
    const backToRuns = page.getByRole("link", { name: "Back to runs" });
    await expect(backToRuns).toHaveAttribute("aria-disabled", "true");
    await backToRuns.click({ force: true });
    await expect(page.getByRole("heading", { name: "Teams" })).toBeVisible();
    releaseSkillCreate?.();
    await expect(page.getByText("Skill saved for reuse.")).toBeVisible();

    await page.getByRole("button", { name: "Create team" }).click();
    const teamForm = page.locator(".oc-team-form");
    await expect(
      teamForm.getByRole("button", { name: "Move Scout up" })
    ).toBeVisible();
    await expect(
      teamForm.getByRole("button", { name: "Move Builder down" })
    ).toBeVisible();
    await expect(
      teamForm.getByRole("button", { name: "Remove Scout" })
    ).toBeVisible();
    await expect(
      teamForm.getByRole("group", { name: "Team member 1: Scout" })
    ).toBeVisible();
    await expect(teamForm.getByLabel("Agent for team member 1")).toHaveValue(
      AGENT_A
    );
    await teamForm.getByLabel("Name").fill(team.name);
    await teamForm.getByLabel("Description").fill(team.description);
    await teamForm
      .getByLabel("Responsibility for member 1")
      .fill(team.members[0].responsibility);
    await teamForm
      .getByLabel("Responsibility for member 2")
      .fill(team.members[1].responsibility);
    await teamForm.getByLabel(`Attach ${skill.name} to Scout`).check();
    await teamForm.getByRole("button", { name: "Create team" }).click();

    await expect(
      page.getByRole("heading", { exact: true, name: team.name })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "The handoff, before you launch",
      })
    ).toBeVisible();
    await expect(page.locator(".oc-team-sequence__card")).toHaveCount(2);

    await page
      .getByLabel("Mission")
      .fill("Resolve the approved issue and return verified evidence.");
    await runListStarted;
    const startRunButton = page.getByRole("button", {
      name: "Start coordinated run",
    });
    await expect(startRunButton).toBeDisabled();
    releaseRunList?.();
    await expect(startRunButton).toBeEnabled();
    await expect(page.getByText("No runs yet")).toBeVisible();
    await startRunButton.click();
    await expect(page.getByText("Approval required")).toBeVisible();
    await expect(page.getByText("github.issues.write")).toBeVisible();
    await pollStarted;

    await page.getByRole("button", { name: "Approve changes" }).click();
    await expect(
      page.getByText("approval approved", { exact: true })
    ).toBeVisible();
    releaseStalePoll?.();
    await page.waitForTimeout(100);
    await expect(
      page.getByRole("button", { name: "Approve changes" })
    ).toHaveCount(0);
    await page.getByText("Handoff · 1 commands · 1 files").click();
    await expect(
      page.getByText("Issue update completed with focused verification.")
    ).toBeVisible();
    await expect(page.getByText("Runner run ID")).toBeVisible();
    await expect(page.getByText(RUNNER_RUN_ID)).toBeVisible();
    await expect(page.getByText("pnpm test:unit")).toBeVisible();
    await expect(page.getByText("src/issues.ts")).toBeVisible();
    await expect(page.getByText("Could not load teams.")).toHaveCount(0);

    await page.setViewportSize({ height: 844, width: 390 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= globalThis.innerWidth
      )
    ).toBe(true);
  });
});
