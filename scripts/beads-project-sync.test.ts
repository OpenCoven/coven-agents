import assert from "node:assert/strict";
import test from "node:test";
import type {
  ProjectSnapshot,
  ReconciliationMutationStats,
} from "./beads-project-io";
import type { Bead, ProjectItem } from "./beads-project-model";
import { MARKER_PREFIX } from "./beads-project-policy";
import {
  formatSyncCliError,
  runSync,
  type SyncConfig,
} from "./beads-project-sync";

const config: SyncConfig = {
  beadsDirectory: "/private/beads",
  owner: "OpenCoven",
  projectNumber: 10,
  repositoryRoot:
    "/Users/buns/Documents/GitHub/OpenCoven/coven-agents/.worktrees/chore-beads-project-board",
};

const emptyProject: ProjectSnapshot = {
  fields: {},
  items: [],
  projectId: "PVT_project",
  rateLimit: {
    cost: 1,
    remaining: 5000,
    resetAt: "2026-08-24T00:00:00Z",
  },
};

function managedBody(beadId: string, body = "Body"): string {
  return `${MARKER_PREFIX}${beadId} -->\n\n${body}`;
}

function safeBead(overrides: Partial<Bead> = {}): Bead {
  const { metadata: overrideMetadata, ...rest } = overrides;

  return {
    acceptance_criteria: "Private acceptance text for the roadmap item.",
    dependencies: [],
    description: "Add a bounded control for the planning workflow.",
    id: "coven-agents-security.1",
    issue_type: "task",
    metadata: {
      owner: "Copilot",
      runner: "Shared",
      size: "S",
      wave: "1 - Now",
      workstream: "Security & privacy",
      ...overrideMetadata,
    },
    priority: 0,
    status: "open",
    title: "Add staged secret scanning",
    ...rest,
  };
}

function passthroughRealpath(filePath: string): Promise<string> {
  return Promise.resolve(filePath);
}

function unsafeBead(): Bead {
  return safeBead({
    description: "Authorization: hidden-value",
  });
}

function projectItem(
  beadId: string,
  overrides: Partial<ProjectItem> = {}
): ProjectItem {
  return {
    content: {
      body: managedBody(beadId, "Stored body"),
      title: `Stored ${beadId}`,
      type: "DraftIssue",
      ...(overrides.content ?? {}),
    },
    fields: {
      "Bead ID": beadId,
      "Bead Type": "task",
      Blocked: "No",
      Owner: "Copilot",
      Priority: "P0",
      Runner: "Shared",
      Size: "S",
      Status: "Todo",
      Wave: "1 - Now",
      Workstream: "Security & privacy",
      ...(overrides.fields ?? {}),
    },
    id: `${beadId}-item`,
    ...overrides,
  };
}

test("preview never calls the applier", async () => {
  let applied = false;

  const code = await runSync(["preview"], config, {
    apply: () => {
      applied = true;

      return Promise.resolve({
        contentUpdateCount: 0,
        createCount: 0,
        createRequests: 0,
        fieldUpdateCount: 0,
        totalMutationOperations: 0,
        totalMutationRequests: 0,
        updateRequests: 0,
      });
    },
    loadBeads: async () => [safeBead()],
    loadDependencyCycles: async () => [],
    loadProject: async () => emptyProject,
    realpath: passthroughRealpath,
    validateProject: () => undefined,
    write: () => undefined,
  });

  assert.equal(code, 0);
  assert.equal(applied, false);
});

test("apply validates the complete plan before writing", async () => {
  let applied = false;

  await assert.rejects(
    () =>
      runSync(["apply"], config, {
        apply: () => {
          applied = true;

          return Promise.resolve({
            contentUpdateCount: 0,
            createCount: 0,
            createRequests: 0,
            fieldUpdateCount: 0,
            totalMutationOperations: 0,
            totalMutationRequests: 0,
            updateRequests: 0,
          });
        },
        loadBeads: async () => [unsafeBead()],
        loadDependencyCycles: async () => [],
        loadProject: async () => emptyProject,
        realpath: passthroughRealpath,
        validateProject: () => undefined,
        write: () => undefined,
      }),
    /unsafe/i
  );
  assert.equal(applied, false);
});

test("validates the project schema before planning", async () => {
  await assert.rejects(
    () =>
      runSync(["preview"], config, {
        apply: async () => ({
          contentUpdateCount: 0,
          createCount: 0,
          createRequests: 0,
          fieldUpdateCount: 0,
          totalMutationOperations: 0,
          totalMutationRequests: 0,
          updateRequests: 0,
        }),
        loadBeads: async () => [safeBead()],
        loadDependencyCycles: async () => [],
        loadProject: async () => ({
          ...emptyProject,
          items: [
            projectItem("coven-agents-security.1", {
              content: {
                body: "<!-- coven-agents-bead-sync:v2 id=coven-agents-security.1 -->",
                title: "Malformed managed item",
                type: "DraftIssue",
              },
            }),
          ],
        }),
        realpath: passthroughRealpath,
        validateProject: () => {
          throw new Error("schema rejected");
        },
        write: () => undefined,
      }),
    /schema rejected/
  );
});

test("rejects dependency cycles before apply", async () => {
  let validated = false;

  await assert.rejects(
    () =>
      runSync(["apply"], config, {
        apply: async () => ({
          contentUpdateCount: 0,
          createCount: 0,
          createRequests: 0,
          fieldUpdateCount: 0,
          totalMutationOperations: 0,
          totalMutationRequests: 0,
          updateRequests: 0,
        }),
        loadBeads: async () => [safeBead()],
        loadDependencyCycles: async () => [["coven-agents-security.1"]],
        loadProject: async () => emptyProject,
        realpath: passthroughRealpath,
        validateProject: () => {
          validated = true;
        },
        write: () => undefined,
      }),
    /cycle/i
  );
  assert.equal(validated, false);
});

test("rejects invalid graph relationships before projection", async () => {
  const scenarios: Array<{
    beadFactory: () => Bead[];
    message: RegExp;
  }> = [
    {
      beadFactory: () => [safeBead(), safeBead()],
      message: /duplicate bead id/i,
    },
    {
      beadFactory: () => [
        safeBead({
          id: "coven-agents-security.2",
          parent: "coven-agents-security",
        }),
      ],
      message: /missing parent/i,
    },
    {
      beadFactory: () => [
        safeBead({
          dependencies: [
            {
              depends_on_id: "coven-agents-security",
              issue_id: "coven-agents-security.1",
              type: "blocks",
            },
          ],
        }),
      ],
      message: /missing dependency/i,
    },
    {
      beadFactory: () => [
        safeBead({
          dependencies: [
            {
              depends_on_id: "coven-agents-security",
              issue_id: "coven-agents-security.other",
              type: "blocks",
            },
          ],
        }),
        safeBead({
          id: "coven-agents-security",
          issue_type: "epic",
          metadata: {
            owner: "Copilot",
            runner: "Shared",
            size: "M",
            wave: "4 - Platform",
            workstream: "Security & privacy",
          },
          priority: 1,
          title: "Parent bead",
        }),
      ],
      message: /issue_id/i,
    },
    {
      beadFactory: () => [
        safeBead({
          dependencies: [],
          id: "coven-agents-security.2",
          parent: "coven-agents-security",
        }),
        safeBead({
          id: "coven-agents-security",
          issue_type: "epic",
          metadata: {
            owner: "Copilot",
            runner: "Shared",
            size: "M",
            wave: "4 - Platform",
            workstream: "Security & privacy",
          },
          priority: 1,
          title: "Parent bead",
        }),
      ],
      message: /parent-child relation/i,
    },
    {
      beadFactory: () => [
        safeBead({
          dependencies: [
            {
              depends_on_id: "coven-agents-security",
              issue_id: "coven-agents-security.3",
              type: "parent-child",
            },
          ],
          id: "coven-agents-security.3",
        }),
        safeBead({
          id: "coven-agents-security",
          issue_type: "epic",
          metadata: {
            owner: "Copilot",
            runner: "Shared",
            size: "M",
            wave: "4 - Platform",
            workstream: "Security & privacy",
          },
          priority: 1,
          title: "Parent bead",
        }),
      ],
      message: /parent-child relation/i,
    },
  ];

  await Promise.all(
    scenarios.map(async (scenario) =>
      assert.rejects(
        () =>
          runSync(["preview"], config, {
            apply: async () => ({
              contentUpdateCount: 0,
              createCount: 0,
              createRequests: 0,
              fieldUpdateCount: 0,
              totalMutationOperations: 0,
              totalMutationRequests: 0,
              updateRequests: 0,
            }),
            loadBeads: async () => scenario.beadFactory(),
            loadDependencyCycles: async () => [],
            loadProject: async () => emptyProject,
            realpath: passthroughRealpath,
            validateProject: () => undefined,
            write: () => undefined,
          }),
        scenario.message
      )
    )
  );
});

test("output contains counts and bead IDs but not private fields", async () => {
  const lines: string[] = [];
  const createBead = safeBead({
    id: "coven-agents-security.4",
    title: "Create bead title",
  });
  const updateBead = safeBead({
    dependencies: [
      {
        depends_on_id: "coven-agents-security",
        issue_id: "coven-agents-security.2",
        type: "parent-child",
      },
    ],
    id: "coven-agents-security.2",
    parent: "coven-agents-security",
    title: "Update bead title",
  });
  const unchangedBead = safeBead({
    dependencies: [
      {
        depends_on_id: "coven-agents-security",
        issue_id: "coven-agents-security.3",
        type: "parent-child",
      },
    ],
    id: "coven-agents-security.3",
    parent: "coven-agents-security",
    title: "Unchanged bead title",
  });
  const parentBead = safeBead({
    id: "coven-agents-security",
    issue_type: "epic",
    metadata: {
      owner: "BunsDev",
      runner: "Shared",
      size: "M",
      wave: "1 - Now",
      workstream: "Security & privacy",
    },
    priority: 1,
    title: "Security epic",
  });
  const unchangedManagedBody = [
    `${MARKER_PREFIX}coven-agents-security.3 -->`,
    "",
    "## Objective",
    "",
    unchangedBead.description,
    "",
    "## Acceptance criteria",
    "",
    unchangedBead.acceptance_criteria,
    "",
    "## Tracking",
    "",
    "- Bead: `coven-agents-security.3`",
    "- Owner: Copilot",
    "- Wave: 1 - Now",
    "- Parent: `coven-agents-security`",
    "- Active dependencies: None",
  ].join("\n");

  await runSync(["preview"], config, {
    apply: async () => ({
      contentUpdateCount: 0,
      createCount: 0,
      createRequests: 0,
      fieldUpdateCount: 0,
      totalMutationOperations: 0,
      totalMutationRequests: 0,
      updateRequests: 0,
    }),
    loadBeads: async () => [createBead, unchangedBead, updateBead, parentBead],
    loadDependencyCycles: async () => [],
    loadProject: async () => ({
      ...emptyProject,
      items: [
        projectItem("coven-agents-security.2", {
          content: {
            body: managedBody(
              "coven-agents-security.2",
              "Stored private body that must not be printed."
            ),
            title: "Outdated title",
            type: "DraftIssue",
          },
        }),
        projectItem("coven-agents-security.3", {
          content: {
            body: unchangedManagedBody,
            title: unchangedBead.title,
            type: "DraftIssue",
          },
          fields: {
            "Bead ID": "coven-agents-security.3",
            "Bead Type": "task",
            Blocked: "No",
            Owner: "Copilot",
            Priority: "P0",
            Runner: "Shared",
            Size: "S",
            Status: "Todo",
            Wave: "1 - Now",
            Workstream: "Security & privacy",
          },
        }),
        projectItem("coven-agents-security.5"),
        {
          content: {
            body: "Keep this unmanaged note private.",
            title: "Unmanaged note",
            type: "DraftIssue",
          },
          fields: {
            Notes: "Unmanaged",
          },
          id: "unmanaged-item",
        },
      ],
    }),
    realpath: passthroughRealpath,
    validateProject: () => undefined,
    write: (line) => {
      lines.push(line);
    },
  });

  const output = lines.join("\n");

  assert.match(output, /create count: 2/);
  assert.match(output, /update count: 1/);
  assert.match(output, /unchanged count: 1/);
  assert.match(output, /orphaned count: 1/);
  assert.match(output, /unmanaged count: 1/);
  assert.match(
    output,
    /create ids: coven-agents-security(?:, )?coven-agents-security\.4/
  );
  assert.match(output, /update ids: coven-agents-security\.2/);
  assert.match(output, /unchanged ids: coven-agents-security\.3/);
  assert.match(output, /orphaned ids: coven-agents-security\.5/);
  assert.doesNotMatch(output, /Private acceptance text/);
  assert.doesNotMatch(output, /bounded control/);
  assert.doesNotMatch(output, /Stored private body/);
  assert.doesNotMatch(
    output,
    /Create bead title|Update bead title|Unchanged bead title/
  );
});

test("apply outputs aggregate mutation stats and the remaining rate budget", async () => {
  const lines: string[] = [];
  let appliedPlanSize = 0;
  const stats: ReconciliationMutationStats = {
    contentUpdateCount: 2,
    createCount: 1,
    createRequests: 1,
    fieldUpdateCount: 8,
    totalMutationOperations: 11,
    totalMutationRequests: 2,
    updateRequests: 1,
  };

  await runSync(["apply"], config, {
    apply: (plan, project) => {
      appliedPlanSize = plan.actions.length;
      project.rateLimit.remaining = 321;

      return Promise.resolve(stats);
    },
    loadBeads: async () => [safeBead()],
    loadDependencyCycles: async () => [],
    loadProject: async () => ({
      ...emptyProject,
      rateLimit: {
        cost: 1,
        remaining: 500,
        resetAt: "2026-08-24T00:00:00Z",
      },
    }),
    realpath: passthroughRealpath,
    validateProject: () => undefined,
    write: (line) => {
      lines.push(line);
    },
  });

  const output = lines.join("\n");

  assert.equal(appliedPlanSize, 1);
  assert.match(output, /mutation createCount: 1/);
  assert.match(output, /mutation contentUpdateCount: 2/);
  assert.match(output, /mutation fieldUpdateCount: 8/);
  assert.match(output, /mutation totalMutationOperations: 11/);
  assert.match(output, /mutation createRequests: 1/);
  assert.match(output, /mutation updateRequests: 1/);
  assert.match(output, /mutation totalMutationRequests: 2/);
  assert.match(output, /rate remaining: 321/);
  assert.doesNotMatch(output, /Private acceptance text|bounded control/);
});

test("rejects invalid arguments and project numbers", async () => {
  const deps = {
    apply: async () => ({
      contentUpdateCount: 0,
      createCount: 0,
      createRequests: 0,
      fieldUpdateCount: 0,
      totalMutationOperations: 0,
      totalMutationRequests: 0,
      updateRequests: 0,
    }),
    loadBeads: async () => [safeBead()],
    loadDependencyCycles: async () => [],
    loadProject: async () => emptyProject,
    realpath: passthroughRealpath,
    validateProject: () => undefined,
    write: () => undefined,
  };

  await assert.rejects(() => runSync([], config, deps), /usage/i);
  await assert.rejects(
    () => runSync(["preview", "extra"], config, deps),
    /usage/i
  );
  await assert.rejects(() => runSync(["dry-run"], config, deps), /usage/i);
  await assert.rejects(
    () => runSync(["preview"], { ...config, projectNumber: 0 }, deps),
    /positive integer/i
  );
  await assert.rejects(
    () => runSync(["preview"], { ...config, projectNumber: Number.NaN }, deps),
    /positive integer/i
  );
});

test("uses an explicit beads workspace outside the repository", async () => {
  const directories: string[] = [];
  let loadedProject = false;

  await runSync(
    ["preview"],
    { ...config, beadsDirectory: "/private/beads-link" },
    {
      apply: async () => ({
        contentUpdateCount: 0,
        createCount: 0,
        createRequests: 0,
        fieldUpdateCount: 0,
        totalMutationOperations: 0,
        totalMutationRequests: 0,
        updateRequests: 0,
      }),
      loadBeads: (directory) => {
        directories.push(directory);
        return Promise.resolve([safeBead()]);
      },
      loadDependencyCycles: (directory) => {
        directories.push(directory);
        return Promise.resolve([]);
      },
      loadProject: () => {
        loadedProject = true;
        return Promise.resolve(emptyProject);
      },
      realpath: (filePath) => {
        if (filePath === "/private/beads-link") {
          return Promise.resolve("/private/beads-real");
        }

        return Promise.resolve(filePath);
      },
      validateProject: () => undefined,
      write: () => undefined,
    }
  );

  assert.deepEqual(directories, ["/private/beads-real", "/private/beads-real"]);
  assert.equal(loadedProject, true);
});

test("rejects missing or unsafe beads workspaces before subprocess calls", async () => {
  const scenarios: Array<{
    config: SyncConfig;
    message: RegExp;
    realpath: (filePath: string) => Promise<string>;
  }> = [
    {
      config: { ...config, beadsDirectory: undefined },
      message: /BEADS_WORKSPACE must be configured/i,
      realpath: passthroughRealpath,
    },
    {
      config: { ...config, beadsDirectory: "   " },
      message: /BEADS_WORKSPACE must be configured/i,
      realpath: passthroughRealpath,
    },
    {
      config: {
        ...config,
        beadsDirectory: `${config.repositoryRoot}/.gitignored/beads`,
      },
      message: /outside the repository root/i,
      realpath: passthroughRealpath,
    },
    {
      config: { ...config, beadsDirectory: "/private/repo-beads-link" },
      message: /outside the repository root/i,
      realpath: (filePath) => {
        if (filePath === "/private/repo-beads-link") {
          return Promise.resolve(`${config.repositoryRoot}/.gitignored/beads`);
        }

        return Promise.resolve(filePath);
      },
    },
    {
      config: { ...config, repositoryRoot: undefined },
      message: /repositoryRoot must be configured/i,
      realpath: passthroughRealpath,
    },
  ];

  await Promise.all(
    scenarios.map(async (scenario) => {
      let called = false;

      await assert.rejects(
        () =>
          runSync(["preview"], scenario.config, {
            apply: async () => ({
              contentUpdateCount: 0,
              createCount: 0,
              createRequests: 0,
              fieldUpdateCount: 0,
              totalMutationOperations: 0,
              totalMutationRequests: 0,
              updateRequests: 0,
            }),
            loadBeads: () => {
              called = true;
              return Promise.resolve([safeBead()]);
            },
            loadDependencyCycles: () => {
              called = true;
              return Promise.resolve([]);
            },
            loadProject: () => {
              called = true;
              return Promise.resolve(emptyProject);
            },
            realpath: scenario.realpath,
            validateProject: () => undefined,
            write: () => undefined,
          }),
        scenario.message
      );

      assert.equal(called, false);
    })
  );
});

test("workspace validation errors use a fixed sync category", () => {
  assert.equal(
    formatSyncCliError(
      new Error("BEADS_WORKSPACE must be outside the repository root")
    ),
    "Invalid BEADS_WORKSPACE."
  );
});

test("top-level sync errors use fixed categories without leaking spaced paths", () => {
  const message = formatSyncCliError(
    new Error(
      "open /Users/test/Secret Folder/project export.json: permission denied"
    )
  );

  assert.equal(message, "Project sync failed.");
  assert.doesNotMatch(message, /Users|Secret|Folder|project export\.json/);
});
