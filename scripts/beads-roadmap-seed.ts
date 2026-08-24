#!/usr/bin/env tsx

import { realpath as fsRealpath, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  type CommandRunner,
  type InputCommandRunner,
  loadBeads,
  runCommand,
  runInputCommand,
} from "./beads-project-io";
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
  realpath?: (filePath: string) => Promise<string>;
  runCommand: CommandRunner;
  runInputCommand: InputCommandRunner;
  write: (line: string) => void;
};

type SeedImportTarget = {
  item: SeedItem;
  kind: "create" | "heal";
  missingBlockingDependencyIds: string[];
};

type SeedApplicationPlan = {
  createIds: string[];
  dependencyAdds: Array<{
    blockerId: string;
    childId: string;
  }>;
  exactIds: string[];
  healIds: string[];
  importTargets: SeedImportTarget[];
};

const defaultDependencies = {
  readFile: (filePath) => readFile(filePath, "utf8"),
  realpath: (filePath) => fsRealpath(filePath),
  runCommand,
  runInputCommand,
  write: console.log,
} satisfies Required<SeedDependencies>;

const CANONICAL_SEED_BEAD_KEYS = new Set<string>([
  "acceptance_criteria",
  "dependencies",
  "description",
  "id",
  "issue_type",
  "metadata",
  "parent",
  "priority",
  "status",
  "title",
]);

const READONLY_EXISTING_BEAD_KEYS = new Set<string>([
  "_type",
  "comment_count",
  "created_at",
  "created_by",
  "dependency_count",
  "dependent_count",
  "owner",
  "updated_at",
]);

const HEAL_SAFE_EXISTING_BEAD_KEYS = new Set<string>([
  ...CANONICAL_SEED_BEAD_KEYS,
  ...READONLY_EXISTING_BEAD_KEYS,
]);

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

function canonicalDependencies(item: SeedItem): Bead["dependencies"] {
  return [
    ...(item.parent === undefined
      ? []
      : [
          {
            depends_on_id: item.parent,
            issue_id: item.id,
            type: "parent-child",
          } as const,
        ]),
    ...normalizeBlockingDependencies(item.dependsOn).map((dependsOnId) => ({
      depends_on_id: dependsOnId,
      issue_id: item.id,
      type: "blocks" as const,
    })),
  ];
}

function canonicalBead(item: SeedItem): Bead {
  return {
    acceptance_criteria: item.acceptanceCriteria,
    dependencies: canonicalDependencies(item),
    description: item.description,
    id: item.id,
    issue_type: item.type,
    metadata: item.metadata,
    ...(item.parent === undefined ? {} : { parent: item.parent }),
    priority: item.priority,
    status: "open",
    title: item.title,
  };
}

function desiredBlockingDependencies(item: SeedItem): string[] {
  return normalizeBlockingDependencies(item.dependsOn);
}

function existingDependencyKinds(
  bead: Bead
): Record<"blocks" | "parent-child", string[]> {
  const kinds: Record<"blocks" | "parent-child", string[]> = {
    blocks: [],
    "parent-child": [],
  };

  for (const dependency of bead.dependencies) {
    if (dependency.type === "blocks" || dependency.type === "parent-child") {
      kinds[dependency.type].push(dependency.depends_on_id);
    }
  }

  return {
    blocks: kinds.blocks,
    "parent-child": kinds["parent-child"],
  };
}

function hasUnexpectedDependencyShape(bead: Bead): boolean {
  const dependencyKinds = existingDependencyKinds(bead);

  return (
    bead.dependencies.some(
      (dependency) =>
        dependency.issue_id !== bead.id &&
        (dependency.type === "blocks" || dependency.type === "parent-child")
    ) ||
    bead.dependencies.some(
      (dependency) =>
        dependency.type !== "blocks" && dependency.type !== "parent-child"
    ) ||
    dependencyKinds.blocks.length !== new Set(dependencyKinds.blocks).size ||
    dependencyKinds["parent-child"].length !==
      new Set(dependencyKinds["parent-child"]).size
  );
}

function existingBlockingDependencies(bead: Bead): string[] {
  return normalizeBlockingDependencies(existingDependencyKinds(bead).blocks);
}

function existingParentDependencies(bead: Bead): string[] {
  return [...existingDependencyKinds(bead)["parent-child"]].sort(
    compareStrings
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

function unmodeledMutableFieldNames(bead: Bead): string[] {
  return Object.keys(bead)
    .filter((key) => !HEAL_SAFE_EXISTING_BEAD_KEYS.has(key))
    .sort(compareStrings);
}

function diffExistingBead(
  item: SeedItem,
  bead: Bead
): {
  differences: string[];
  missingBlockingDependencyIds: string[];
} {
  const desired = canonicalBead(item);
  const differences: string[] = [];

  if (bead.title !== desired.title) {
    differences.push("title");
  }

  if (bead.description !== desired.description) {
    differences.push("description");
  }

  if (bead.acceptance_criteria !== desired.acceptance_criteria) {
    differences.push("acceptance");
  }

  if (bead.issue_type !== desired.issue_type) {
    differences.push("type");
  }

  if (bead.priority !== desired.priority) {
    differences.push("priority");
  }

  if (bead.status !== desired.status) {
    differences.push("status");
  }

  if ((bead.parent ?? null) !== (desired.parent ?? null)) {
    differences.push("parent");
  }

  if (
    metadataSignature(bead.metadata) !== metadataSignature(desired.metadata)
  ) {
    differences.push("metadata");
  }

  if (hasUnexpectedDependencyShape(bead)) {
    differences.push("dependency records");
  }

  const expectedParentDependencies =
    desired.parent === undefined ? [] : [desired.parent];

  if (
    !sameStringArray(
      existingParentDependencies(bead),
      expectedParentDependencies
    )
  ) {
    differences.push("parent-child relation");
  }

  const currentBlockingDependencies = existingBlockingDependencies(bead);
  const desiredBlockingDependencyIds = desiredBlockingDependencies(item);
  const missingBlockingDependencyIds = desiredBlockingDependencyIds.filter(
    (blockerId) => !currentBlockingDependencies.includes(blockerId)
  );
  const extraBlockingDependencies = currentBlockingDependencies.filter(
    (blockerId) => !desiredBlockingDependencyIds.includes(blockerId)
  );

  if (extraBlockingDependencies.length > 0) {
    differences.push("blocking dependencies");
  }

  return {
    differences: [...new Set(differences)].sort(compareStrings),
    missingBlockingDependencyIds,
  };
}

function compareImportTargets(
  left: SeedImportTarget,
  right: SeedImportTarget
): number {
  return (
    Number(left.item.parent !== undefined) -
      Number(right.item.parent !== undefined) ||
    compareStrings(left.item.id, right.item.id)
  );
}

function sortImportTargets(
  targets: readonly SeedImportTarget[]
): SeedImportTarget[] {
  const targetById = new Map(
    targets.map((target) => [target.item.id, target] as const)
  );
  const pendingDependencies = new Map<string, Set<string>>();

  for (const target of targets) {
    const dependencies = new Set<string>();

    if (
      target.kind === "create" &&
      target.item.parent !== undefined &&
      targetById.has(target.item.parent)
    ) {
      dependencies.add(target.item.parent);
    }

    for (const blockerId of desiredBlockingDependencies(target.item)) {
      if (targetById.has(blockerId)) {
        dependencies.add(blockerId);
      }
    }

    pendingDependencies.set(target.item.id, dependencies);
  }

  const ready = targets
    .filter(
      (target) => (pendingDependencies.get(target.item.id)?.size ?? 0) === 0
    )
    .sort(compareImportTargets);
  const ordered: SeedImportTarget[] = [];
  const emitted = new Set<string>();

  while (ready.length > 0) {
    const next = ready.shift();

    if (next === undefined || emitted.has(next.item.id)) {
      continue;
    }

    emitted.add(next.item.id);
    ordered.push(next);

    for (const candidate of targets) {
      if (emitted.has(candidate.item.id)) {
        continue;
      }

      const dependencies = pendingDependencies.get(candidate.item.id);

      if (dependencies === undefined) {
        continue;
      }

      dependencies.delete(next.item.id);

      if (
        dependencies.size === 0 &&
        !ready.some((target) => target.item.id === candidate.item.id)
      ) {
        ready.push(candidate);
        ready.sort(compareImportTargets);
      }
    }
  }

  if (ordered.length !== targets.length) {
    throw new Error("Seed blocking dependencies contain a cycle");
  }

  return ordered;
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

  const createIds: string[] = [];
  const exactIds: string[] = [];
  const healIds: string[] = [];
  const importTargets: SeedImportTarget[] = [];

  for (const item of sortItemsById(seed)) {
    const existing = currentById.get(item.id);

    if (existing === undefined) {
      createIds.push(item.id);
      importTargets.push({
        item,
        kind: "create",
        missingBlockingDependencyIds: desiredBlockingDependencies(item),
      });

      continue;
    }

    const { differences, missingBlockingDependencyIds } = diffExistingBead(
      item,
      existing
    );

    if (differences.length > 0) {
      throw new Error(
        `Existing bead differs for ${item.id}: ${differences.join(", ")}`
      );
    }

    if (missingBlockingDependencyIds.length > 0) {
      const mutableFieldNames = unmodeledMutableFieldNames(existing);

      if (mutableFieldNames.length > 0) {
        throw new Error(
          `Existing bead contains unmodeled mutable fields for ${item.id}: ${mutableFieldNames.join(", ")}`
        );
      }

      healIds.push(item.id);
      importTargets.push({
        item,
        kind: "heal",
        missingBlockingDependencyIds,
      });
      continue;
    }

    exactIds.push(item.id);
  }

  const dependencyAdds = importTargets
    .flatMap((target) =>
      target.missingBlockingDependencyIds.map((blockerId) => ({
        blockerId,
        childId: target.item.id,
      }))
    )
    .sort(
      (left, right) =>
        compareStrings(left.childId, right.childId) ||
        compareStrings(left.blockerId, right.blockerId)
    );

  return {
    createIds: createIds.sort(compareStrings),
    dependencyAdds,
    exactIds: exactIds.sort(compareStrings),
    healIds: healIds.sort(compareStrings),
    importTargets: sortImportTargets(importTargets),
  };
}

function isInsideRoot(candidatePath: string, rootPath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);

  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

async function validateSeedPath(
  inputPath: string,
  repoRoot: string,
  realpath: (filePath: string) => Promise<string>
): Promise<string> {
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

  if (isInsideRoot(resolvedPath, resolvedRoot)) {
    throw new Error(
      "Seed file path must be absolute and outside the repository root"
    );
  }

  const realRoot = await realpath(resolvedRoot);
  let realCandidatePath = "";

  try {
    realCandidatePath = await realpath(resolvedPath);
  } catch (error) {
    throw new Error("Unable to read seed file", { cause: error });
  }

  if (isInsideRoot(realCandidatePath, realRoot)) {
    throw new Error(
      "Seed file path must be absolute and outside the repository root"
    );
  }

  return realCandidatePath;
}

function buildImportJsonl(targets: readonly SeedImportTarget[]): string {
  return targets
    .map((target) => JSON.stringify(canonicalBead(target.item)))
    .join("\n");
}

export function formatSeedCliError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (message.startsWith("Usage: pnpm beads:seed")) {
    return "Invalid beads:seed arguments.";
  }

  if (message.startsWith("Seed file path must")) {
    return "Invalid seed file path.";
  }

  if (message === "Unable to read seed file") {
    return "Unable to read seed file.";
  }

  if (message === "Seed file must contain valid JSON") {
    return "Seed file must contain valid JSON.";
  }

  if (
    message.startsWith("Seed ") ||
    message.startsWith("Duplicate seed ID") ||
    message.startsWith("Invalid seed id") ||
    message.startsWith("Workstream mismatch") ||
    message.startsWith("Epic ") ||
    message.startsWith("missing parent") ||
    message.startsWith("missing dependency") ||
    message.startsWith("self-dependency")
  ) {
    return "Seed validation failed.";
  }

  if (
    message.startsWith("Duplicate existing bead ID") ||
    message.startsWith("Existing bead differs") ||
    message.startsWith("Existing bead contains unmodeled mutable fields")
  ) {
    return "Existing Beads state does not match the seed.";
  }

  if (message.includes("Beads dependency graph contains a cycle")) {
    return "Beads dependency cycle check failed.";
  }

  if (message.startsWith("bd command failed")) {
    return "Beads command failed.";
  }

  return "Roadmap seed failed.";
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

  write(`records: ${sortedSeed.length}`);
  write(`epic count: ${EPIC_DEFINITIONS.length}`);
  write(`child count: ${childItems(sortedSeed).length}`);
  write(`ready child count: ${readyChildCount(sortedSeed)}`);
  write(`cross-epic dependency count: ${crossEpicDependencyCount(sortedSeed)}`);
  write(`p0 child count: ${p0ChildCount(sortedSeed)}`);
  write(`exact count: ${plan.exactIds.length}`);
  write(`create count: ${plan.createIds.length}`);
  write(`heal count: ${plan.healIds.length}`);
  write(`import count: ${plan.importTargets.length}`);
  write(`dependency add count: ${plan.dependencyAdds.length}`);
  write(`ids: ${formatIdList(sortedSeed.map((item) => item.id))}`);
  write(`create ids: ${formatIdList(plan.createIds)}`);
  write(`heal ids: ${formatIdList(plan.healIds)}`);
  write(`exact ids: ${formatIdList(plan.exactIds)}`);
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

  const resolveRealpath = dependencies.realpath ?? defaultDependencies.realpath;
  const validatedPath = await validateSeedPath(
    filePath,
    config.repositoryRoot,
    resolveRealpath
  );

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

  if (plan.importTargets.length > 0) {
    await dependencies.runInputCommand(
      "bd",
      ["-C", config.workspace, "import", "-", "--json"],
      buildImportJsonl(plan.importTargets)
    );
  }

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
      console.error(formatSeedCliError(error));
      process.exitCode = 1;
    });
}
