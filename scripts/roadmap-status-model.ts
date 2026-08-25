import { z } from "zod";
import {
  BEAD_ID_PATTERN,
  PROJECT_STATUSES,
  WAVES,
} from "./beads-project-model";

export const BLOCKED_OPTIONS = ["No", "Yes"] as const;
export const ROADMAP_EXPECTED_ITEM_COUNT = 60;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export type RoadmapWave = (typeof WAVES)[number];

export type RoadmapProjectItem = {
  beadId: string;
  blocked: (typeof BLOCKED_OPTIONS)[number];
  status: ProjectStatus;
  wave: RoadmapWave;
};

export type WaveSummary = {
  blocked: number;
  byStatus: Record<ProjectStatus, number>;
  total: number;
};

export type RoadmapSummary = {
  blocked: number;
  byStatus: Record<ProjectStatus, number>;
  byWave: Record<RoadmapWave, WaveSummary>;
  total: number;
};

const countSchema = z.number().int().nonnegative();

const statusCountsShape = Object.fromEntries(
  PROJECT_STATUSES.map((status) => [status, countSchema])
) as Record<ProjectStatus, typeof countSchema>;

const statusCountsSchema = z.object(statusCountsShape).strict();

const waveSummarySchema = z
  .object({
    blocked: countSchema,
    byStatus: statusCountsSchema,
    total: countSchema,
  })
  .strict();

const waveSummariesShape = Object.fromEntries(
  WAVES.map((wave) => [wave, waveSummarySchema])
) as Record<RoadmapWave, typeof waveSummarySchema>;

export const roadmapSummarySchema = z
  .object({
    blocked: countSchema,
    byStatus: statusCountsSchema,
    byWave: z.object(waveSummariesShape).strict(),
    total: countSchema,
  })
  .strict();

const roadmapProjectItemSchema = z
  .object({
    beadId: z.string(),
    blocked: z.enum(BLOCKED_OPTIONS),
    status: z.enum(PROJECT_STATUSES),
    wave: z.enum(WAVES),
  })
  .strict();

function emptyStatusCounts(): Record<ProjectStatus, number> {
  return Object.fromEntries(
    PROJECT_STATUSES.map((status) => [status, 0])
  ) as Record<ProjectStatus, number>;
}

function emptyWaveSummaries(): Record<RoadmapWave, WaveSummary> {
  return Object.fromEntries(
    WAVES.map((wave) => [
      wave,
      {
        blocked: 0,
        byStatus: emptyStatusCounts(),
        total: 0,
      },
    ])
  ) as Record<RoadmapWave, WaveSummary>;
}

export function summarizeRoadmap(
  items: readonly RoadmapProjectItem[],
  expectedCount = ROADMAP_EXPECTED_ITEM_COUNT
): RoadmapSummary {
  if (items.length !== expectedCount) {
    throw new Error(
      `Expected ${expectedCount} roadmap items, received ${items.length}`
    );
  }

  const summary: RoadmapSummary = {
    blocked: 0,
    byStatus: emptyStatusCounts(),
    byWave: emptyWaveSummaries(),
    total: items.length,
  };
  const beadIds = new Set<string>();

  for (const input of items) {
    const item = roadmapProjectItemSchema.parse(input);

    if (!BEAD_ID_PATTERN.test(item.beadId)) {
      throw new Error(`Invalid roadmap bead ID: ${item.beadId}`);
    }

    if (beadIds.has(item.beadId)) {
      throw new Error(`Duplicate roadmap bead ID: ${item.beadId}`);
    }

    beadIds.add(item.beadId);
    summary.byStatus[item.status] += 1;
    summary.byWave[item.wave].byStatus[item.status] += 1;
    summary.byWave[item.wave].total += 1;

    if (item.blocked === "Yes") {
      summary.blocked += 1;
      summary.byWave[item.wave].blocked += 1;
    }
  }

  return roadmapSummarySchema.parse(summary);
}

export function sameRoadmapSummary(
  left: RoadmapSummary,
  right: RoadmapSummary
): boolean {
  if (left.total !== right.total || left.blocked !== right.blocked) {
    return false;
  }

  for (const status of PROJECT_STATUSES) {
    if (left.byStatus[status] !== right.byStatus[status]) {
      return false;
    }
  }

  for (const wave of WAVES) {
    const leftWave = left.byWave[wave];
    const rightWave = right.byWave[wave];

    if (
      leftWave.total !== rightWave.total ||
      leftWave.blocked !== rightWave.blocked
    ) {
      return false;
    }

    for (const status of PROJECT_STATUSES) {
      if (leftWave.byStatus[status] !== rightWave.byStatus[status]) {
        return false;
      }
    }
  }

  return true;
}
