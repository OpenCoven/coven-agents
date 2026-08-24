import assert from "node:assert/strict";
import test from "node:test";
import type { Bead } from "./beads-project-model";
import {
  EPIC_DEFINITIONS,
  formatSeedCliError,
  parseSeedJson,
  runSeed,
  type SeedConfig,
  type SeedDocument,
  type SeedItem,
  seedItemSchema,
  seedSchema,
} from "./beads-roadmap-seed";

const config: SeedConfig = {
  repositoryRoot:
    "/Users/buns/Documents/GitHub/OpenCoven/coven-agents/.worktrees/chore-beads-project-board",
  workspace: "/private/beads",
};

const externalSeedPath = "/private/coven-agents-roadmap.private.json";

type CommandCall = {
  args: string[];
  command: string;
  input?: string;
};

function makeValidSeed(): SeedDocument {
  const items: SeedItem[] = [];

  EPIC_DEFINITIONS.forEach(({ id, workstream }, epicIndex) => {
    items.push({
      acceptanceCriteria:
        "The epic has a measurable outcome, clear scope, and approved review checkpoints.",
      dependsOn: [],
      description:
        "Coordinate this roadmap area with clear milestones and explicit boundaries. Track progress with measurable outcomes that stay safe for private planning use.",
      id,
      metadata: {
        owner: "BunsDev",
        projectStatus: "Todo",
        runner: epicIndex % 2 === 0 ? "Shared" : "Control plane",
        size: "L",
        wave: "4 - Platform",
        workstream,
      },
      priority: 1,
      title: `Plan ${workstream} roadmap`,
      type: "epic",
    });

    const childPrefix = id;
    const previousEpic = EPIC_DEFINITIONS[epicIndex - 1];
    const twoBackEpic = EPIC_DEFINITIONS[epicIndex - 2];

    items.push(
      {
        acceptanceCriteria:
          "The capability works in the target runner and has a repeatable verification path.",
        dependsOn: [],
        description:
          "Deliver the first scoped capability for this workstream with an explicit success signal. Keep the initial slice ready to start without blocking dependencies.",
        id: `${childPrefix}.1`,
        metadata: {
          owner: "Copilot",
          projectStatus: "Todo",
          runner: "Shared",
          size: "M",
          wave: "4 - Platform",
          workstream,
        },
        parent: id,
        priority: 0,
        title: `Deliver ${workstream} milestone 1`,
        type: "feature",
      },
      {
        acceptanceCriteria:
          "The follow-on task depends only on validated earlier work and can be demoed independently.",
        dependsOn: [
          `${childPrefix}.1`,
          ...(previousEpic ? [`${previousEpic.id}.1`] : []),
        ],
        description:
          "Sequence the second milestone after the first verified capability. Reuse one earlier cross-epic dependency where coordination is required.",
        id: `${childPrefix}.2`,
        metadata: {
          owner: "Copilot",
          projectStatus: "In Progress",
          runner: "Cloud",
          size: "S",
          wave: "4 - Platform",
          workstream,
        },
        parent: id,
        priority: 1,
        title: `Deliver ${workstream} milestone 2`,
        type: "task",
      },
      {
        acceptanceCriteria:
          "The task closes with observable evidence and leaves the workstream ready for the next increment.",
        dependsOn: [
          `${childPrefix}.2`,
          ...(twoBackEpic ? [`${twoBackEpic.id}.2`] : []),
        ],
        description:
          "Complete the third milestone after the second and any required reused capability. Keep the dependency chain forward-only to preserve an acyclic roadmap.",
        id: `${childPrefix}.3`,
        metadata: {
          owner: "Copilot",
          runner: "Local",
          size: "M",
          wave: "5 - Product data",
          workstream,
        },
        parent: id,
        priority: 1,
        title: `Deliver ${workstream} milestone 3`,
        type: "task",
      },
      {
        acceptanceCriteria:
          "The bug fix removes the known failure mode and includes a reproducible verification path.",
        dependsOn: [`${childPrefix}.1`],
        description:
          "Address a known reliability gap after the first milestone is present. Keep the work independently verifiable within the same workstream.",
        id: `${childPrefix}.4`,
        metadata: {
          owner: "Joint",
          projectStatus: "Todo",
          runner: "Local",
          size: "S",
          wave: "5 - Product data",
          workstream,
        },
        parent: id,
        priority: 2,
        title: `Stabilize ${workstream} milestone 4`,
        type: "bug",
      },
      {
        acceptanceCriteria:
          "The closing milestone integrates earlier work and proves the workstream is ready for handoff.",
        dependsOn: [
          `${childPrefix}.3`,
          ...(previousEpic ? [`${previousEpic.id}.4`] : []),
        ],
        description:
          "Finish the fifth milestone after the third milestone and one earlier cross-epic prerequisite. Keep the finish criteria explicit enough for a private seed review.",
        id: `${childPrefix}.5`,
        metadata: {
          owner: "Joint",
          projectStatus: "In review",
          runner: "Cloud",
          size: "M",
          wave: "6 - Operations",
          workstream,
        },
        parent: id,
        priority: 2,
        title: `Complete ${workstream} milestone 5`,
        type: "feature",
      }
    );
  });

  return items;
}

function makeCurrentBead(item: SeedItem): Bead {
  return {
    acceptance_criteria: item.acceptanceCriteria,
    dependencies: [
      ...(item.parent
        ? [
            {
              depends_on_id: item.parent,
              issue_id: item.id,
              type: "parent-child",
            },
          ]
        : []),
      ...item.dependsOn.map((dependsOnId) => ({
        depends_on_id: dependsOnId,
        issue_id: item.id,
        type: "blocks",
      })),
    ],
    description: item.description,
    id: item.id,
    issue_type: item.type,
    metadata: item.metadata,
    parent: item.parent,
    priority: item.priority,
    status: item.status ?? "open",
    title: item.title,
  };
}

function makeRunner(
  currentBeads: Bead[],
  finalCycles: unknown[] = []
): {
  calls: CommandCall[];
  runCommand: (command: string, args: string[]) => Promise<string>;
  runInputCommand: (
    command: string,
    args: string[],
    input: string
  ) => Promise<string>;
} {
  const calls: CommandCall[] = [];

  const mergeImportedBeads = (input: string): void => {
    for (const line of input.split(/\r?\n/)) {
      if (line.trim() === "") {
        continue;
      }

      const imported = JSON.parse(line) as Bead;
      const existingIndex = currentBeads.findIndex(
        (bead) => bead.id === imported.id
      );

      if (existingIndex >= 0) {
        currentBeads[existingIndex] = imported;
        continue;
      }

      currentBeads.push(imported);
    }
  };

  return {
    calls,
    runCommand: (command, args) => {
      calls.push({ args, command });

      if (
        command === "bd" &&
        args.join(" ") ===
          `-C ${config.workspace} --readonly list --all --limit 0 --json`
      ) {
        return Promise.resolve(JSON.stringify(currentBeads));
      }

      if (
        command === "bd" &&
        args.join(" ") === `-C ${config.workspace} dep cycles --json`
      ) {
        return Promise.resolve(JSON.stringify(finalCycles));
      }

      return Promise.resolve("");
    },
    runInputCommand: (command, args, input) => {
      calls.push({ args, command, input });
      mergeImportedBeads(input);
      return Promise.resolve("");
    },
  };
}

function importCalls(calls: readonly CommandCall[]): CommandCall[] {
  return calls.filter((call) => call.args[2] === "import");
}

function parseImportPayload(call: CommandCall): Bead[] {
  return (call.input ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Bead);
}

function writeNothing(_line: string): void {
  // Intentionally silent in tests.
}

function passthroughRealpath(filePath: string): Promise<string> {
  return Promise.resolve(filePath);
}

test("exports strict schemas and parses a valid roadmap seed", () => {
  const seed = makeValidSeed();

  assert.ok(seedItemSchema);
  assert.ok(seedSchema);
  assert.equal(parseSeedJson(JSON.stringify(seed)).length, 60);
});

test("rejects a seed with anything other than 60 records", () => {
  const seed = makeValidSeed().slice(0, 59);

  assert.throws(
    () => parseSeedJson(JSON.stringify(seed)),
    /exactly 60 records/i
  );
});

test("rejects a seed with anything other than 10 epics", () => {
  const seed = makeValidSeed();
  seed[0] = {
    ...seed[0],
    type: "task",
  };

  assert.throws(() => parseSeedJson(JSON.stringify(seed)), /exactly 10 epics/i);
});

test("rejects an epic without exactly five direct children", () => {
  const seed = makeValidSeed();
  const movedChildIndex = seed.findIndex(
    (item) => item.id === "coven-agents-product.5"
  );

  seed[movedChildIndex] = {
    ...seed[movedChildIndex],
    parent: undefined,
  };

  assert.throws(
    () => parseSeedJson(JSON.stringify(seed)),
    /five direct children/i
  );
});

test("rejects duplicate IDs and invalid hierarchy IDs", () => {
  const duplicateSeed = makeValidSeed();
  const lastSeedItem = duplicateSeed.at(-1);

  assert.ok(lastSeedItem);
  duplicateSeed[duplicateSeed.length - 1] = {
    ...lastSeedItem,
    id: "coven-agents-product.1",
    parent: "coven-agents-product",
  };

  assert.throws(
    () => parseSeedJson(JSON.stringify(duplicateSeed)),
    /duplicate seed id/i
  );

  const invalidIdSeed = makeValidSeed();
  invalidIdSeed[1] = {
    ...invalidIdSeed[1],
    id: "coven-agents-product.6",
  };

  assert.throws(
    () => parseSeedJson(JSON.stringify(invalidIdSeed)),
    /invalid seed id/i
  );
});

test("rejects missing parents, missing dependencies, and self dependencies", () => {
  const missingParentSeed = makeValidSeed();
  missingParentSeed[1] = {
    ...missingParentSeed[1],
    parent: "coven-agents-missing",
  };

  assert.throws(
    () => parseSeedJson(JSON.stringify(missingParentSeed)),
    /missing parent/i
  );

  const missingDependencySeed = makeValidSeed();
  const dependencyIndex = missingDependencySeed.findIndex(
    (item) => item.id === "coven-agents-cloud.2"
  );
  missingDependencySeed[dependencyIndex] = {
    ...missingDependencySeed[dependencyIndex],
    dependsOn: ["coven-agents-missing"],
  };

  assert.throws(
    () => parseSeedJson(JSON.stringify(missingDependencySeed)),
    /missing dependency/i
  );

  const selfDependencySeed = makeValidSeed();
  const selfDependencyIndex = selfDependencySeed.findIndex(
    (item) => item.id === "coven-agents-cloud.2"
  );
  selfDependencySeed[selfDependencyIndex] = {
    ...selfDependencySeed[selfDependencyIndex],
    dependsOn: ["coven-agents-cloud.2"],
  };

  assert.throws(
    () => parseSeedJson(JSON.stringify(selfDependencySeed)),
    /self-dependency/i
  );
});

test("rejects dependency cycles and unsafe private content", () => {
  const cycleSeed = makeValidSeed();
  const secondIndex = cycleSeed.findIndex(
    (item) => item.id === "coven-agents-product.2"
  );
  const thirdIndex = cycleSeed.findIndex(
    (item) => item.id === "coven-agents-product.3"
  );
  cycleSeed[secondIndex] = {
    ...cycleSeed[secondIndex],
    dependsOn: ["coven-agents-product.3"],
  };
  cycleSeed[thirdIndex] = {
    ...cycleSeed[thirdIndex],
    dependsOn: ["coven-agents-product.2"],
  };

  assert.throws(() => parseSeedJson(JSON.stringify(cycleSeed)), /cycle/i);

  const unsafeSeed = makeValidSeed();
  unsafeSeed[1] = {
    ...unsafeSeed[1],
    description: "Authorization: hidden-value",
  };

  assert.throws(() => parseSeedJson(JSON.stringify(unsafeSeed)), /unsafe/i);
  assert.doesNotMatch(
    (() => {
      try {
        parseSeedJson(JSON.stringify(unsafeSeed));
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })(),
    /hidden-value/
  );
});

test("rejects invalid P0, cross-epic, and ready thresholds", () => {
  const p0Seed = makeValidSeed();
  for (const item of p0Seed) {
    if (
      item.parent &&
      Number.parseInt(item.id.split(".").at(-1) ?? "0", 10) <= 2
    ) {
      item.priority = 0;
    }
  }

  assert.throws(() => parseSeedJson(JSON.stringify(p0Seed)), /p0/i);

  const crossEpicSeed = makeValidSeed();
  for (const item of crossEpicSeed) {
    const parentId = item.parent;

    if (parentId) {
      item.dependsOn = item.dependsOn.filter((dependsOn) =>
        dependsOn.startsWith(parentId)
      );
    }
  }

  assert.throws(
    () => parseSeedJson(JSON.stringify(crossEpicSeed)),
    /cross-epic/i
  );

  const readySeed = makeValidSeed();
  for (const item of readySeed) {
    if (item.parent && item.dependsOn.length === 0) {
      item.dependsOn = [item.parent];
    }
  }

  assert.throws(() => parseSeedJson(JSON.stringify(readySeed)), /ready/i);
});

test("preview prints IDs and counts only and performs no writes", async () => {
  const seed = makeValidSeed();
  const output: string[] = [];
  const { calls, runCommand, runInputCommand } = makeRunner([]);

  await runSeed(["preview", externalSeedPath], config, {
    readFile: async () => JSON.stringify(seed),
    realpath: passthroughRealpath,
    runCommand,
    runInputCommand,
    write: (line) => {
      output.push(line);
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, "bd");
  assert.match(output.join("\n"), /records: 60/);
  assert.match(output.join("\n"), /create count: 60/);
  assert.match(output.join("\n"), /exact count: 0/);
  assert.match(output.join("\n"), /coven-agents-product/);
  assert.doesNotMatch(output.join("\n"), /Plan Product roadmap/);
  assert.doesNotMatch(output.join("\n"), /clear milestones/);
  assert.doesNotMatch(output.join("\n"), /measurable outcome/);
});

test("apply is an exact idempotent no-op when every bead already matches", async () => {
  const seed = makeValidSeed();
  const { calls, runCommand, runInputCommand } = makeRunner(
    seed.map(makeCurrentBead)
  );

  await runSeed(["apply", externalSeedPath], config, {
    readFile: async () => JSON.stringify(seed),
    realpath: passthroughRealpath,
    runCommand,
    runInputCommand,
    write: writeNothing,
  });

  assert.deepEqual(
    calls.map((call) => call.args.join(" ")),
    [
      `-C ${config.workspace} --readonly list --all --limit 0 --json`,
      `-C ${config.workspace} dep cycles --json`,
    ]
  );
});

test("apply fails before writes when an existing bead differs", async () => {
  const seed = makeValidSeed();
  const current = seed.map(makeCurrentBead);
  current[0] = {
    ...current[0],
    title: "Existing private title that must stay hidden",
  };
  const { calls, runCommand, runInputCommand } = makeRunner(current);

  await assert.rejects(
    () =>
      runSeed(["apply", externalSeedPath], config, {
        readFile: async () => JSON.stringify(seed),
        realpath: passthroughRealpath,
        runCommand,
        runInputCommand,
        write: writeNothing,
      }),
    /differs/i
  );

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.args.join(" "),
    `-C ${config.workspace} --readonly list --all --limit 0 --json`
  );
  await assert.rejects(
    () =>
      runSeed(["apply", externalSeedPath], config, {
        readFile: async () => JSON.stringify(seed),
        realpath: passthroughRealpath,
        runCommand,
        runInputCommand,
        write: writeNothing,
      }),
    (error: unknown) =>
      error instanceof Error &&
      !error.message.includes("Existing private title that must stay hidden")
  );
});

test("apply sends private canonical JSONL through stdin only", async () => {
  const seed = makeValidSeed();
  const targetId = "coven-agents-product.2";
  const seedTargetIndex = seed.findIndex((item) => item.id === targetId);
  assert.ok(seedTargetIndex >= 0);
  seed[seedTargetIndex] = {
    ...seed[seedTargetIndex],
    acceptanceCriteria:
      "Meet the private review gate with measurable evidence.",
    description:
      "Coordinate the private roadmap without exposing it through process arguments.",
    metadata: {
      ...seed[seedTargetIndex].metadata,
      runner: "Shared",
    },
    title: "Private roadmap task",
  };
  const target = seed.find((item) => item.id === targetId);
  assert.ok(target);
  const current = seed.map((item) => makeCurrentBead(item));
  const targetIndex = current.findIndex((item) => item.id === targetId);
  assert.ok(targetIndex >= 0);
  current[targetIndex] = {
    ...current[targetIndex],
    dependencies: current[targetIndex].dependencies.filter(
      (dependency) =>
        !(
          dependency.type === "blocks" &&
          dependency.depends_on_id === target.dependsOn.at(-1)
        )
    ),
  };
  const { calls, runCommand, runInputCommand } = makeRunner(current);

  await runSeed(["apply", externalSeedPath], config, {
    readFile: async () => JSON.stringify(seed),
    realpath: passthroughRealpath,
    runCommand,
    runInputCommand,
    write: writeNothing,
  });

  const imports = importCalls(calls);

  assert.equal(imports.length, 1);
  assert.deepEqual(imports[0]?.args, [
    "-C",
    config.workspace,
    "import",
    "-",
    "--json",
  ]);
  assert.doesNotMatch(imports[0]?.args.join(" ") ?? "", /Private roadmap task/);
  assert.doesNotMatch(
    imports[0]?.args.join(" ") ?? "",
    /Coordinate the private roadmap/
  );
  assert.doesNotMatch(
    imports[0]?.args.join(" ") ?? "",
    /Meet the private review gate/
  );
  assert.doesNotMatch(imports[0]?.args.join(" ") ?? "", /"runner":"Shared"/);

  const [payload] = imports.map(parseImportPayload);

  assert.equal(payload.length, 1);
  assert.equal(payload[0]?.id, targetId);
  assert.equal(payload[0]?.title, target.title);
  assert.equal(payload[0]?.description, target.description);
  assert.equal(payload[0]?.acceptance_criteria, target.acceptanceCriteria);
  assert.equal(payload[0]?.status, "open");
  assert.deepEqual(
    payload[0]?.dependencies.filter(
      (dependency) => dependency.type === "blocks"
    ),
    target.dependsOn.map((dependsOnId) => ({
      depends_on_id: dependsOnId,
      issue_id: target.id,
      type: "blocks",
    }))
  );
});

test("apply rejects extra blocking dependencies before import", async () => {
  const seed = makeValidSeed();
  const current = seed.map(makeCurrentBead);
  const targetId = "coven-agents-product.2";
  const targetIndex = current.findIndex((item) => item.id === targetId);
  assert.ok(targetIndex >= 0);
  current[targetIndex] = {
    ...current[targetIndex],
    dependencies: [
      ...current[targetIndex].dependencies,
      {
        depends_on_id: "coven-agents-product.5",
        issue_id: targetId,
        type: "blocks",
      },
    ],
  };
  const { calls, runCommand, runInputCommand } = makeRunner(current);

  await assert.rejects(
    () =>
      runSeed(["apply", externalSeedPath], config, {
        readFile: async () => JSON.stringify(seed),
        realpath: passthroughRealpath,
        runCommand,
        runInputCommand,
        write: writeNothing,
      }),
    /blocking dependencies/i
  );

  assert.equal(importCalls(calls).length, 0);
  assert.equal(calls.length, 1);
});

test("apply refuses healing beads with unmodeled mutable fields before import", async () => {
  const seed = makeValidSeed();
  const healId = "coven-agents-dx.5";
  const desiredHeal = seed.find((item) => item.id === healId);
  assert.ok(desiredHeal);
  const missingDependencyId = desiredHeal.dependsOn.at(-1);
  assert.ok(missingDependencyId);

  await Promise.all(
    (
      [
        ["notes", "Keep this private note"],
        ["labels", ["private", "seed"]],
        ["custom_field", "unexpected mutable state"],
      ] as const
    ).map(async ([fieldName, value]) => {
      const current = seed.map(makeCurrentBead);
      const healIndex = current.findIndex((item) => item.id === healId);
      assert.ok(healIndex >= 0);
      current[healIndex] = {
        ...current[healIndex],
        [fieldName]: value,
        dependencies: current[healIndex].dependencies.filter(
          (dependency) =>
            !(
              dependency.type === "blocks" &&
              dependency.depends_on_id === missingDependencyId
            )
        ),
      };
      const runner = makeRunner(current);

      await assert.rejects(
        () =>
          runSeed(["apply", externalSeedPath], config, {
            readFile: async () => JSON.stringify(seed),
            realpath: passthroughRealpath,
            runCommand: runner.runCommand,
            runInputCommand: runner.runInputCommand,
            write: writeNothing,
          }),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes("unmodeled mutable fields") &&
          error.message.includes(fieldName)
      );

      assert.equal(importCalls(runner.calls).length, 0);
      assert.deepEqual(
        runner.calls.map((call) => call.args.join(" ")),
        [`-C ${config.workspace} --readonly list --all --limit 0 --json`]
      );
    })
  );
});

test("apply can resume missing creations and dependency healing", async () => {
  const seed = makeValidSeed();
  const current = seed
    .map(makeCurrentBead)
    .filter(
      (item) =>
        item.id !== "coven-agents-testing.4" &&
        item.id !== "coven-agents-release.5"
    );
  const healId = "coven-agents-dx.5";
  const healIndex = current.findIndex((item) => item.id === healId);
  const desiredHeal = seed.find((item) => item.id === healId);
  assert.ok(healIndex >= 0);
  assert.ok(desiredHeal);
  current[healIndex] = {
    ...current[healIndex],
    dependencies: current[healIndex].dependencies.filter(
      (dependency) =>
        !(
          dependency.type === "blocks" &&
          dependency.depends_on_id === desiredHeal.dependsOn.at(-1)
        )
    ),
  };
  const runner = makeRunner(current);

  await runSeed(["apply", externalSeedPath], config, {
    readFile: async () => JSON.stringify(seed),
    realpath: passthroughRealpath,
    runCommand: runner.runCommand,
    runInputCommand: runner.runInputCommand,
    write: writeNothing,
  });

  const [firstImport] = importCalls(runner.calls);
  assert.ok(firstImport);
  assert.deepEqual(
    parseImportPayload(firstImport)
      .map((bead) => bead.id)
      .sort(),
    ["coven-agents-dx.5", "coven-agents-release.5", "coven-agents-testing.4"]
  );

  runner.calls.length = 0;

  await runSeed(["apply", externalSeedPath], config, {
    readFile: async () => JSON.stringify(seed),
    realpath: passthroughRealpath,
    runCommand: runner.runCommand,
    runInputCommand: runner.runInputCommand,
    write: writeNothing,
  });

  assert.equal(importCalls(runner.calls).length, 0);
});

test("apply rejects a non-empty final dependency cycle check", async () => {
  const seed = makeValidSeed();
  const { runCommand, runInputCommand } = makeRunner(
    [],
    [["coven-agents-product.2"]]
  );

  await assert.rejects(
    () =>
      runSeed(["apply", externalSeedPath], config, {
        readFile: async () => JSON.stringify(seed),
        realpath: passthroughRealpath,
        runCommand,
        runInputCommand,
        write: writeNothing,
      }),
    /cycle/i
  );
});

test("uses an explicit beads workspace outside the repository", async () => {
  const calls: CommandCall[] = [];

  await runSeed(
    ["preview", externalSeedPath],
    { ...config, workspace: "/private/beads-link" },
    {
      readFile: async () => JSON.stringify(makeValidSeed()),
      realpath: (filePath) => {
        if (filePath === "/private/beads-link") {
          return Promise.resolve("/private/beads-real");
        }

        return Promise.resolve(filePath);
      },
      runCommand: (command, args) => {
        calls.push({ args, command });

        if (
          command === "bd" &&
          args.join(" ") ===
            "-C /private/beads-real --readonly list --all --limit 0 --json"
        ) {
          return Promise.resolve(JSON.stringify([]));
        }

        return Promise.resolve("");
      },
      runInputCommand: (command, args, input) => {
        calls.push({ args, command, input });
        return Promise.resolve("");
      },
      write: writeNothing,
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]?.args.join(" "),
    "-C /private/beads-real --readonly list --all --limit 0 --json"
  );
});

test("rejects missing or unsafe beads workspaces before subprocess calls", async () => {
  const scenarios: Array<{
    config: SeedConfig;
    message: RegExp;
    realpath: (filePath: string) => Promise<string>;
  }> = [
    {
      config: { ...config, workspace: undefined },
      message: /BEADS_WORKSPACE must be configured/i,
      realpath: passthroughRealpath,
    },
    {
      config: { ...config, workspace: "   " },
      message: /BEADS_WORKSPACE must be configured/i,
      realpath: passthroughRealpath,
    },
    {
      config: {
        ...config,
        workspace: `${config.repositoryRoot}/.gitignored/beads`,
      },
      message: /outside the repository root/i,
      realpath: passthroughRealpath,
    },
    {
      config: { ...config, workspace: "/private/repo-beads-link" },
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
      let readFileCalled = false;
      let runCommandCalled = false;
      let runInputCommandCalled = false;

      await assert.rejects(
        () =>
          runSeed(["preview", externalSeedPath], scenario.config, {
            readFile: () => {
              readFileCalled = true;
              return Promise.resolve(JSON.stringify(makeValidSeed()));
            },
            realpath: scenario.realpath,
            runCommand: () => {
              runCommandCalled = true;
              return Promise.resolve(JSON.stringify([]));
            },
            runInputCommand: () => {
              runInputCommandCalled = true;
              return Promise.resolve("");
            },
            write: writeNothing,
          }),
        scenario.message
      );

      assert.equal(readFileCalled, false);
      assert.equal(runCommandCalled, false);
      assert.equal(runInputCommandCalled, false);
    })
  );
});

test("rejects invalid and in-repository seed paths", async () => {
  const deps = {
    readFile: async () => JSON.stringify(makeValidSeed()),
    realpath: passthroughRealpath,
    runCommand: async () => JSON.stringify([]),
    runInputCommand: async () => "",
    write: writeNothing,
  };

  await assert.rejects(() => runSeed(["preview"], config, deps), /usage/i);
  await assert.rejects(
    () => runSeed(["preview", "relative.json"], config, deps),
    /absolute/i
  );
  await assert.rejects(
    () =>
      runSeed(
        [
          "preview",
          `${config.repositoryRoot}/.gitignored/private-roadmap.json`,
        ],
        config,
        deps
      ),
    /outside the repository root/i
  );
});

test("rejects lexical seed symlinks that resolve into the repository", async () => {
  const symlinkPath = "/private/repo-seed-link.json";
  let readFileCalled = false;

  await assert.rejects(
    () =>
      runSeed(["preview", symlinkPath], config, {
        readFile: () => {
          readFileCalled = true;
          return Promise.resolve(JSON.stringify(makeValidSeed()));
        },
        realpath: (filePath) => {
          if (filePath === symlinkPath) {
            return Promise.resolve(
              `${config.repositoryRoot}/.gitignored/private-roadmap.json`
            );
          }

          return Promise.resolve(filePath);
        },
        runCommand: async () => JSON.stringify([]),
        runInputCommand: async () => "",
        write: writeNothing,
      }),
    /outside the repository root/i
  );

  assert.equal(readFileCalled, false);
});

test("workspace validation errors use a fixed seed category", () => {
  assert.equal(
    formatSeedCliError(
      new Error("BEADS_WORKSPACE must be outside the repository root")
    ),
    "Invalid BEADS_WORKSPACE."
  );
});

test("top-level seed errors use fixed categories without leaking spaced paths", () => {
  const message = formatSeedCliError(
    new Error(
      "ENOENT: no such file or directory, open '/Users/test/Secret Folder/private roadmap.json'"
    )
  );

  assert.equal(message, "Roadmap seed failed.");
  assert.doesNotMatch(message, /Users|Secret|Folder|private roadmap\.json/);
});
