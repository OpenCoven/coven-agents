#!/usr/bin/env tsx

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { type CommandRunner, loadBeads, runCommand } from "./beads-project-io";
import {
  BEAD_TYPES,
  type Bead,
  RUNNERS,
  SIZES,
  WORKSTREAMS,
} from "./beads-project-model";
import { validateSafeText } from "./beads-project-policy";

export const EPIC_DEFINITIONS = [
  {
    id: "coven-agents-product",
    workstream: "Product",
  },
  {
    id: "coven-agents-contracts",
    workstream: "Contracts & harnesses",
  },
  {
    id: "coven-agents-cloud",
    workstream: "Cloud runner",
  },
  {
    id: "coven-agents-local",
    workstream: "Local runner",
  },
  {
    id: "coven-agents-data",
    workstream: "Data lifecycle",
  },
  {
    id: "coven-agents-security",
    workstream: "Security & privacy",
  },
  {
    id: "coven-agents-observability",
    workstream: "Observability",
  },
  {
    id: "coven-agents-testing",
    workstream: "Testing & reliability",
  },
  {
    id: "coven-agents-release",
    workstream: "Releases & docs",
  },
  {
    id: "coven-agents-dx",
    workstream: "Developer experience",
  },
] as const satisfies ReadonlyArray<{
  id: string;
  workstream: (typeof WORKSTREAMS)[number];
}>;

const EPIC_BY_ID: ReadonlyMap<string, (typeof EPIC_DEFINITIONS)[number]> =
  new Map(
    EPIC_DEFINITIONS.map((definition) => [definition.id, definition] as const)
  );
const EPIC_IDS = EPIC_DEFINITIONS.map((definition) => definition.id);
const CHILD_SUFFIXES = ["1", "2", "3", "4", "5"] as const;
const ITEM_ID_PATTERN = new RegExp(
  `^(?:${EPIC_IDS.map((id) => id.replaceAll(".", "\\.")).join("|")})(?:\\.[1-5])?$`
);
const INITIAL_PROJECT_STATUSES = ["Todo", "In Progress", "In review"] as const;

type MutableSeedDocument = SeedItem[];

export const seedMetadataSchema = z
  .object({
    projectStatus: z.enum(INITIAL_PROJECT_STATUSES).optional(),
    runner: z.enum(RUNNERS),
    size: z.enum(SIZES),
    workstream: z.enum(WORKSTREAMS),
  })
  .strict();

export const seedItemSchema = z
  .object({
    acceptanceCriteria: z.string().trim().min(1),
    dependsOn: z.array(z.string().trim().min(1)).default([]),
    description: z.string().trim().min(1),
    id: z.string().regex(ITEM_ID_PATTERN, "Invalid seed id"),
    metadata: seedMetadataSchema,
    parent: z.string().trim().min(1).optional(),
    priority: z.number().int().min(0).max(2),
    title: z.string().trim().min(1),
    type: z.enum(BEAD_TYPES),
  })
  .strict();

export const seedSchema = z
  .array(seedItemSchema)
  .length(60, "Seed must contain exactly 60 records");

export type SeedMetadata = z.infer<typeof seedMetadataSchema>;
export type SeedItem = z.infer<typeof seedItemSchema>;
export type SeedDocument = z.infer<typeof seedSchema>;

export type SeedConfig = {
  repositoryRoot: string;
  workspace: string;
};

export type SeedDependencies = {
  readFile: (filePath: string) => Promise<string>;
  runCommand: CommandRunner;
  write: (line: string) => void;
};

type SeedApplicationPlan = {
  createChildren: SeedItem[];
  createEpics: SeedItem[];
  dependencyAdds: Array<{
    blockerId: string;
    childId: string;
  }>;
  exactIds: string[];
};

const defaultDependencies: SeedDependencies = {
  readFile: (filePath) => readFile(filePath, "utf8"),
  runCommand,
  write: console.log,
};

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function sortItemsById(items: readonly SeedItem[]): SeedItem[] {
  return [...items].sort((left, right) => compareStrings(left.id, right.id));
}

function formatIdList(ids: readonly string[]): string {
  return ids.length === 0 ? "-" : ids.join(", ");
}

function metadataSignature(metadata: {
  projectStatus?: Bead["metadata"]["projectStatus"];
  runner: SeedMetadata["runner"];
  size: SeedMetadata["size"];
  workstream: SeedMetadata["workstream"];
}): string {
  return JSON.stringify({
    projectStatus: metadata.projectStatus ?? null,
    runner: metadata.runner,
    size: metadata.size,
    workstream: metadata.workstream,
  });
}

function normalizeBlockingDependencies(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort(compareStrings);
}

function existingBlockingDependencies(bead: Bead): string[] {
  return normalizeBlockingDependencies(
    bead.dependencies
      .filter((dependency) => dependency.type === "blocks")
      .map((dependency) => dependency.depends_on_id)
  );
}

function childItems(items: readonly SeedItem[]): SeedItem[] {
  return items.filter((item) => item.parent !== undefined);
}

function topLevelEpicId(
  item: Pick<SeedItem, "id" | "parent"> | undefined
): string | undefined {
  if (item === undefined) {
    return undefined;
  }

  return item.parent ?? item.id;
}

function crossEpicDependencyCount(items: readonly SeedItem[]): number {
  const byId = new Map(items.map((item) => [item.id, item] as const));

  return childItems(items).reduce((total, item) => {
    const itemEpicId = item.parent;

    return (
      total +
      item.dependsOn.filter((dependsOnId) => {
        const dependencyEpicId = topLevelEpicId(byId.get(dependsOnId));

        return (
          itemEpicId !== undefined &&
          dependencyEpicId !== undefined &&
          dependencyEpicId !== itemEpicId
        );
      }).length
    );
  }, 0);
}

function readyChildCount(items: readonly SeedItem[]): number {
  return childItems(items).filter((item) => item.dependsOn.length === 0).length;
}

function p0ChildCount(items: readonly SeedItem[]): number {
  return childItems(items).filter((item) => item.priority === 0).length;
}

function readChildSuffix(id: string): string | undefined {
  return id.split(".").at(1);
}

function issue(field: string, itemId: string): string {
  return `Seed item ${itemId} has unsafe ${field}`;
}

function collectSeedValidationIssues(items: SeedDocument): string[] {
  const issues: string[] = [];
  const byId = new Map<string, SeedItem>();
  const sortedItems = sortItemsById(items);

  for (const item of sortedItems) {
    if (byId.has(item.id)) {
      issues.push(`Duplicate seed ID: ${item.id}`);
      continue;
    }

    byId.set(item.id, item);
  }

  const epics = sortedItems.filter((item) => item.type === "epic");

  if (epics.length !== EPIC_DEFINITIONS.length) {
    issues.push("Seed must contain exactly 10 epics");
  }

  for (const item of sortedItems) {
    try {
      validateSafeText("title", item.title);
    } catch {
      issues.push(issue("title", item.id));
    }

    try {
      validateSafeText("description", item.description);
    } catch {
      issues.push(issue("description", item.id));
    }

    try {
      validateSafeText("acceptance", item.acceptanceCriteria);
    } catch {
      issues.push(issue("acceptance", item.id));
    }

    if (item.type === "epic") {
      const expectedEpic = EPIC_BY_ID.get(item.id);

      if (expectedEpic === undefined) {
        issues.push(`Invalid seed id: ${item.id}`);
      }

      if (item.parent !== undefined) {
        issues.push(`Epic ${item.id} cannot have a parent`);
      }

      if (item.dependsOn.length > 0) {
        issues.push(`Epic ${item.id} cannot declare blocking dependencies`);
      }

      if (
        expectedEpic !== undefined &&
        item.metadata.workstream !== expectedEpic.workstream
      ) {
        issues.push(`Workstream mismatch for ${item.id}`);
      }

      continue;
    }

    if (item.parent === undefined) {
      issues.push(`missing parent for ${item.id}`);
    }

    const expectedEpic = item.parent ? EPIC_BY_ID.get(item.parent) : undefined;

    if (item.parent !== undefined && expectedEpic === undefined) {
      issues.push(`missing parent ${item.parent} for ${item.id}`);
    }

    if (
      expectedEpic !== undefined &&
      item.metadata.workstream !== expectedEpic.workstream
    ) {
      issues.push(`Workstream mismatch for ${item.id}`);
    }

    const suffix = readChildSuffix(item.id);

    if (
      item.parent !== undefined &&
      (suffix === undefined ||
        !CHILD_SUFFIXES.includes(suffix as (typeof CHILD_SUFFIXES)[number]) ||
        item.id !== `${item.parent}.${suffix}`)
    ) {
      issues.push(`Invalid seed id: ${item.id}`);
    }

    const duplicateDependencyCount =
      item.dependsOn.length - new Set(item.dependsOn).size;

    if (duplicateDependencyCount > 0) {
      issues.push(`Duplicate dependency IDs for ${item.id}`);
    }
  }

  for (const definition of EPIC_DEFINITIONS) {
    const directChildren = sortedItems
      .filter((item) => item.parent === definition.id)
      .map((item) => item.id)
      .sort(compareStrings);
    const expectedChildIds = CHILD_SUFFIXES.map(
      (suffix) => `${definition.id}.${suffix}`
    );

    if (directChildren.length !== CHILD_SUFFIXES.length) {
      issues.push(
        `Epic ${definition.id} must have exactly five direct children`
      );
      continue;
    }

    if (JSON.stringify(directChildren) !== JSON.stringify(expectedChildIds)) {
      issues.push(`Epic ${definition.id} must use child IDs .1 through .5`);
    }
  }

  for (const item of sortedItems) {
    for (const dependsOnId of normalizeBlockingDependencies(item.dependsOn)) {
      if (dependsOnId === item.id) {
        issues.push(`self-dependency is not allowed for ${item.id}`);
      }

      if (!byId.has(dependsOnId)) {
        issues.push(`missing dependency ${dependsOnId} for ${item.id}`);
      }
    }
  }

  if (readyChildCount(sortedItems) < 8) {
    issues.push("Seed must leave at least 8 ready child records");
  }

  if (crossEpicDependencyCount(sortedItems) < 12) {
    issues.push("Seed must contain at least 12 cross-epic dependencies");
  }

  if (p0ChildCount(sortedItems) > 15) {
    issues.push("Seed must contain no more than 15 P0 children");
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (itemId: string): void => {
    if (visiting.has(itemId)) {
      issues.push("Seed blocking dependencies contain a cycle");
      return;
    }

    if (visited.has(itemId)) {
      return;
    }

    visiting.add(itemId);

    const item = byId.get(itemId);

    if (item !== undefined) {
      for (const dependsOnId of normalizeBlockingDependencies(item.dependsOn)) {
        if (byId.has(dependsOnId)) {
          visit(dependsOnId);
        }
      }
    }

    visiting.delete(itemId);
    visited.add(itemId);
  };

  for (const item of sortedItems) {
    visit(item.id);
  }

  return [...new Set(issues)];
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function diffExistingBead(item: SeedItem, bead: Bead): string[] {
  const differences: string[] = [];

  if (bead.title !== item.title) {
    differences.push("title");
  }

  if (bead.description !== item.description) {
    differences.push("description");
  }

  if (bead.acceptance_criteria !== item.acceptanceCriteria) {
    differences.push("acceptance");
  }

  if (bead.issue_type !== item.type) {
    differences.push("type");
  }

  if (bead.priority !== item.priority) {
    differences.push("priority");
  }

  if ((bead.parent ?? null) !== (item.parent ?? null)) {
    differences.push("parent");
  }

  if (metadataSignature(bead.metadata) !== metadataSignature(item.metadata)) {
    differences.push("metadata");
  }

  if (
    !sameStringArray(
      existingBlockingDependencies(bead),
      normalizeBlockingDependencies(item.dependsOn)
    )
  ) {
    differences.push("blocking dependencies");
  }

  return differences.sort(compareStrings);
}

function createSeedApplicationPlan(
  seed: SeedDocument,
  currentBeads: readonly Bead[]
): SeedApplicationPlan {
  const currentById = new Map<string, Bead>();

  for (const bead of currentBeads) {
    if (currentById.has(bead.id)) {
      throw new Error(`Duplicate existing bead ID: ${bead.id}`);
    }

    currentById.set(bead.id, bead);
  }

  const createEpics: SeedItem[] = [];
  const createChildren: SeedItem[] = [];
  const exactIds: string[] = [];

  for (const item of sortItemsById(seed)) {
    const existing = currentById.get(item.id);

    if (existing === undefined) {
      if (item.type === "epic") {
        createEpics.push(item);
      } else {
        createChildren.push(item);
      }

      continue;
    }

    const differences = diffExistingBead(item, existing);

    if (differences.length > 0) {
      throw new Error(
        `Existing bead differs for ${item.id}: ${differences.join(", ")}`
      );
    }

    exactIds.push(item.id);
  }

  const dependencyAdds = [...createEpics, ...createChildren]
    .flatMap((item) =>
      normalizeBlockingDependencies(item.dependsOn).map((blockerId) => ({
        blockerId,
        childId: item.id,
      }))
    )
    .sort(
      (left, right) =>
        compareStrings(left.childId, right.childId) ||
        compareStrings(left.blockerId, right.blockerId)
    );

  return {
    createChildren,
    createEpics,
    dependencyAdds,
    exactIds: exactIds.sort(compareStrings),
  };
}

function createBeadArgs(workspace: string, item: SeedItem): string[] {
  return [
    "-C",
    workspace,
    "create",
    item.title,
    "--id",
    item.id,
    "--type",
    item.type,
    "--priority",
    `P${item.priority}`,
    "--description",
    item.description,
    "--acceptance",
    item.acceptanceCriteria,
    "--metadata",
    JSON.stringify(item.metadata),
    ...(item.parent ? ["--parent", item.parent] : []),
    "--silent",
  ];
}

function dependencyArgs(
  workspace: string,
  childId: string,
  blockerId: string
): string[] {
  return ["-C", workspace, "dep", "add", childId, blockerId];
}

async function runSequentially<T>(
  values: readonly T[],
  run: (value: T) => Promise<unknown>
): Promise<void> {
  const [first, ...rest] = values;

  if (first === undefined) {
    return;
  }

  await run(first);
  await runSequentially(rest, run);
}

function validateSeedPath(inputPath: string, repoRoot: string): string {
  if (!path.isAbsolute(inputPath)) {
    throw new Error(
      "Seed file path must be absolute and outside the repository root"
    );
  }

  if (path.extname(inputPath).toLowerCase() !== ".json") {
    throw new Error("Seed file path must point to a .json file");
  }

  const resolvedPath = path.resolve(inputPath);
  const resolvedRoot = path.resolve(repoRoot);
  const relativePath = path.relative(resolvedRoot, resolvedPath);

  if (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  ) {
    throw new Error(
      "Seed file path must be absolute and outside the repository root"
    );
  }

  return resolvedPath;
}

function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  return message
    .replace(
      /(?:^|[^A-Za-z0-9_])\/(?:Users|home|private|tmp|var|etc|opt|usr|Volumes)\/\S*/g,
      " [redacted-path]"
    )
    .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+\b/gi, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
}

function parseFinalCycles(output: string): unknown[] {
  const parsed = JSON.parse(output);

  if (!Array.isArray(parsed)) {
    throw new Error("Beads dependency cycles response must be an array");
  }

  return parsed;
}

function writeSeedSummary(
  seed: SeedDocument,
  plan: SeedApplicationPlan,
  write: (line: string) => void
): void {
  const sortedSeed = sortItemsById(seed);
  const createIds = [...plan.createEpics, ...plan.createChildren].map(
    (item) => item.id
  );

  write(`records: ${sortedSeed.length}`);
  write(`epic count: ${EPIC_DEFINITIONS.length}`);
  write(`child count: ${childItems(sortedSeed).length}`);
  write(`ready child count: ${readyChildCount(sortedSeed)}`);
  write(`cross-epic dependency count: ${crossEpicDependencyCount(sortedSeed)}`);
  write(`p0 child count: ${p0ChildCount(sortedSeed)}`);
  write(`exact count: ${plan.exactIds.length}`);
  write(`create count: ${createIds.length}`);
  write(`dependency add count: ${plan.dependencyAdds.length}`);
  write(`ids: ${formatIdList(sortedSeed.map((item) => item.id))}`);
}

export function parseSeedJson(input: string): SeedDocument {
  const parsed = seedSchema.parse(JSON.parse(input)) as MutableSeedDocument;
  const issues = collectSeedValidationIssues(parsed);

  if (issues.length > 0) {
    throw new Error(issues.join("; "));
  }

  return parsed;
}

export async function runSeed(
  args: string[],
  config: SeedConfig,
  dependencies: SeedDependencies = defaultDependencies
): Promise<number> {
  const [mode, filePath] = args;

  if (
    (mode !== "preview" && mode !== "apply") ||
    filePath === undefined ||
    args.length !== 2
  ) {
    throw new Error(
      "Usage: pnpm beads:seed <preview|apply> <absolute-json-path>"
    );
  }

  const validatedPath = validateSeedPath(filePath, config.repositoryRoot);

  let rawSeed = "";

  try {
    rawSeed = await dependencies.readFile(validatedPath);
  } catch (error) {
    throw new Error("Unable to read seed file", { cause: error });
  }

  let seed: SeedDocument;

  try {
    seed = parseSeedJson(rawSeed);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Seed file must contain valid JSON", { cause: error });
    }

    throw error;
  }

  const currentBeads = await loadBeads(
    config.workspace,
    dependencies.runCommand
  );
  const plan = createSeedApplicationPlan(seed, currentBeads);

  writeSeedSummary(seed, plan, dependencies.write);

  if (mode === "preview") {
    return 0;
  }

  await runSequentially(plan.createEpics, (item) =>
    dependencies.runCommand("bd", createBeadArgs(config.workspace, item))
  );
  await runSequentially(plan.createChildren, (item) =>
    dependencies.runCommand("bd", createBeadArgs(config.workspace, item))
  );
  await runSequentially(plan.dependencyAdds, (dependency) =>
    dependencies.runCommand(
      "bd",
      dependencyArgs(config.workspace, dependency.childId, dependency.blockerId)
    )
  );

  const finalCycles = parseFinalCycles(
    await dependencies.runCommand("bd", [
      "-C",
      config.workspace,
      "dep",
      "cycles",
      "--json",
    ])
  );

  if (finalCycles.length > 0) {
    throw new Error("Beads dependency graph contains a cycle after apply");
  }

  return 0;
}

const repositoryRoot = path.resolve(
  fileURLToPath(new URL("..", import.meta.url))
);
const isMain =
  process.argv[1] === undefined
    ? false
    : fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  runSeed(process.argv.slice(2), {
    repositoryRoot,
    workspace: process.env.BEADS_WORKSPACE ?? process.cwd(),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(sanitizeErrorMessage(error));
      process.exitCode = 1;
    });
}
