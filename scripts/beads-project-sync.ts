#!/usr/bin/env tsx

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyReconciliation,
  loadBeads,
  loadDependencyCycles,
  loadProject,
  type ProjectSnapshot,
  type ReconciliationMutationStats,
  validateProjectSchema,
} from "./beads-project-io";
import type { Bead } from "./beads-project-model";
import { projectBead } from "./beads-project-policy";
import {
  planReconciliation,
  type ReconciliationPlan,
} from "./beads-project-reconcile";

export type SyncConfig = {
  beadsDirectory: string;
  owner: string;
  projectNumber: number;
};

export type SyncDependencies = {
  apply: (
    plan: ReconciliationPlan,
    project: ProjectSnapshot
  ) => Promise<ReconciliationMutationStats>;
  loadBeads: (directory: string) => Promise<Bead[]>;
  loadDependencyCycles: (directory: string) => Promise<unknown[]>;
  loadProject: (
    owner: string,
    projectNumber: number
  ) => Promise<ProjectSnapshot>;
  validateProject: (project: ProjectSnapshot) => void;
  write: (line: string) => void;
};

const defaultDependencies: SyncDependencies = {
  apply: applyReconciliation,
  loadBeads,
  loadDependencyCycles,
  loadProject,
  validateProject: validateProjectSchema,
  write: console.log,
};

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function formatIdList(ids: readonly string[]): string {
  return ids.length === 0 ? "-" : ids.join(", ");
}

export function formatSyncCliError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (message.startsWith("Usage: pnpm beads:sync")) {
    return "Invalid beads:sync arguments.";
  }

  if (message === "COVEN_PROJECT_NUMBER must be a positive integer") {
    return "Invalid COVEN_PROJECT_NUMBER.";
  }

  if (message.includes("Beads dependency graph contains a cycle")) {
    return "Beads dependency cycle check failed.";
  }

  if (
    message.startsWith("missing Project field") ||
    message.startsWith("Project field ")
  ) {
    return "Project schema validation failed.";
  }

  if (
    message.startsWith("Duplicate bead ID") ||
    message.startsWith("missing parent") ||
    message.startsWith("missing dependency") ||
    message.startsWith("dependency issue_id mismatch") ||
    message.startsWith("parent-child relation mismatch")
  ) {
    return "Beads graph validation failed.";
  }

  if (
    message.startsWith("GitHub GraphQL") ||
    message.startsWith("gh graphql failed") ||
    message.startsWith("gh command failed")
  ) {
    return "GitHub project sync failed.";
  }

  return "Project sync failed.";
}

function validateBeadGraph(beads: readonly Bead[]): Map<string, Bead> {
  const byId = new Map<string, Bead>();

  for (const bead of beads) {
    if (byId.has(bead.id)) {
      throw new Error(`Duplicate bead ID: ${bead.id}`);
    }

    byId.set(bead.id, bead);
  }

  for (const bead of beads) {
    const parentChildDependencies = bead.dependencies.filter(
      (dependency) => dependency.type === "parent-child"
    );

    if (bead.parent !== undefined && !byId.has(bead.parent)) {
      throw new Error(`missing parent ${bead.parent} for ${bead.id}`);
    }

    for (const dependency of bead.dependencies) {
      if (dependency.issue_id !== bead.id) {
        throw new Error(`dependency issue_id mismatch for ${bead.id}`);
      }

      if (!byId.has(dependency.depends_on_id)) {
        throw new Error(
          `missing dependency ${dependency.depends_on_id} for ${bead.id}`
        );
      }
    }

    const parentMatches =
      bead.parent === undefined
        ? parentChildDependencies.length === 0
        : parentChildDependencies.length === 1 &&
          parentChildDependencies[0]?.depends_on_id === bead.parent;

    if (!parentMatches) {
      throw new Error(`parent-child relation mismatch for ${bead.id}`);
    }
  }

  return byId;
}

function unchangedIds(
  desiredIds: readonly string[],
  plan: ReconciliationPlan
): string[] {
  const changedIds = new Set(
    plan.actions.map((action) => action.desired.beadId)
  );

  return desiredIds.filter((id) => !changedIds.has(id));
}

function writePlanSummary(
  plan: ReconciliationPlan,
  desiredIds: readonly string[],
  write: (line: string) => void
): void {
  const createIds = plan.actions
    .filter((action) => action.kind === "create")
    .map((action) => action.desired.beadId);
  const updateIds = plan.actions
    .filter((action) => action.kind === "update")
    .map((action) => action.desired.beadId);
  const stableUnchangedIds = unchangedIds(desiredIds, plan);

  write(`create count: ${createIds.length}`);
  write(`update count: ${updateIds.length}`);
  write(`unchanged count: ${stableUnchangedIds.length}`);
  write(`orphaned count: ${plan.orphaned.length}`);
  write(`unmanaged count: ${plan.unmanaged}`);
  write(`create ids: ${formatIdList(createIds)}`);
  write(`update ids: ${formatIdList(updateIds)}`);
  write(`unchanged ids: ${formatIdList(stableUnchangedIds)}`);
  write(`orphaned ids: ${formatIdList(plan.orphaned)}`);
}

function writeMutationStats(
  stats: ReconciliationMutationStats,
  project: ProjectSnapshot,
  write: (line: string) => void
): void {
  write(`mutation createCount: ${stats.createCount}`);
  write(`mutation contentUpdateCount: ${stats.contentUpdateCount}`);
  write(`mutation fieldUpdateCount: ${stats.fieldUpdateCount}`);
  write(`mutation totalMutationOperations: ${stats.totalMutationOperations}`);
  write(`mutation createRequests: ${stats.createRequests}`);
  write(`mutation updateRequests: ${stats.updateRequests}`);
  write(`mutation totalMutationRequests: ${stats.totalMutationRequests}`);
  write(`rate remaining: ${project.rateLimit.remaining}`);
}

export async function runSync(
  args: string[],
  config: SyncConfig,
  dependencies: SyncDependencies = defaultDependencies
): Promise<number> {
  const [mode] = args;

  if ((mode !== "preview" && mode !== "apply") || args.length !== 1) {
    throw new Error("Usage: pnpm beads:sync <preview|apply>");
  }

  if (!Number.isInteger(config.projectNumber) || config.projectNumber <= 0) {
    throw new Error("COVEN_PROJECT_NUMBER must be a positive integer");
  }

  const [beads, cycles, project] = await Promise.all([
    dependencies.loadBeads(config.beadsDirectory),
    dependencies.loadDependencyCycles(config.beadsDirectory),
    dependencies.loadProject(config.owner, config.projectNumber),
  ]);

  if (cycles.length > 0) {
    throw new Error("Beads dependency graph contains a cycle");
  }

  dependencies.validateProject(project);

  const byId = validateBeadGraph(beads);
  const desired = [...beads]
    .sort((left, right) => compareStrings(left.id, right.id))
    .map((bead) => projectBead(bead, byId));
  const desiredIds = desired.map((item) => item.beadId);
  const plan = planReconciliation(desired, project.items);

  writePlanSummary(plan, desiredIds, dependencies.write);

  if (mode === "preview") {
    return 0;
  }

  const stats = await dependencies.apply(plan, project);
  writeMutationStats(stats, project, dependencies.write);

  return 0;
}

const isMain =
  process.argv[1] === undefined
    ? false
    : fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  runSync(process.argv.slice(2), {
    beadsDirectory: process.env.BEADS_WORKSPACE ?? process.cwd(),
    owner: process.env.COVEN_PROJECT_OWNER ?? "OpenCoven",
    projectNumber: Number.parseInt(
      process.env.COVEN_PROJECT_NUMBER ?? "10",
      10
    ),
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(formatSyncCliError(error));
      process.exitCode = 1;
    });
}
