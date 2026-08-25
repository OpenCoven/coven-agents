import { z } from "zod";
import { PROJECT_STATUSES, WAVES } from "./beads-project-model";
import {
  type RoadmapSummary,
  roadmapSummarySchema,
} from "./roadmap-status-model";

export const ROADMAP_STATUS_START =
  "<!-- coven-agents-roadmap-status:v1:start -->";
export const ROADMAP_STATUS_END = "<!-- coven-agents-roadmap-status:v1:end -->";

const ROADMAP_STATUS_DATA_PREFIX = "<!-- coven-agents-roadmap-status-data:v1 ";
const HIDDEN_RECORD_END = " -->";
const refreshedAtSchema = z.iso.datetime({ offset: true });

type MarkerRange = {
  end: number;
  start: number;
};

function findAll(source: string, marker: string): number[] {
  const positions: number[] = [];
  let offset = 0;

  while (offset <= source.length - marker.length) {
    const position = source.indexOf(marker, offset);

    if (position === -1) {
      break;
    }

    positions.push(position);
    offset = position + marker.length;
  }

  return positions;
}

function findStatusBlock(source: string): MarkerRange {
  const starts = findAll(source, ROADMAP_STATUS_START);
  const ends = findAll(source, ROADMAP_STATUS_END);

  if (starts.length !== 1 || ends.length !== 1) {
    throw new Error("Expected exactly one roadmap status marker pair");
  }

  const [start] = starts;
  const [end] = ends;

  if (start === undefined || end === undefined || start >= end) {
    throw new Error("Roadmap status markers are not correctly ordered");
  }

  return { end, start };
}

export function renderRoadmapStatusBlock(
  summary: RoadmapSummary,
  refreshedAt: string
): string {
  const parsedSummary = roadmapSummarySchema.parse(summary);
  const parsedRefreshedAt = refreshedAtSchema.parse(refreshedAt);
  const waveRows = WAVES.map((wave) => {
    const waveSummary = parsedSummary.byWave[wave];

    return `| ${wave} | ${waveSummary.total} | ${waveSummary.byStatus.Done} | ${waveSummary.byStatus["In Progress"]} | ${waveSummary.byStatus["In review"]} | ${waveSummary.byStatus.Todo} | ${waveSummary.blockedCount} |`;
  });
  const statusRows = PROJECT_STATUSES.map(
    (status) => `| ${status} | ${parsedSummary.byStatus[status]} |`
  );

  return [
    ROADMAP_STATUS_START,
    `${ROADMAP_STATUS_DATA_PREFIX}${JSON.stringify(parsedSummary)}${HIDDEN_RECORD_END}`,
    `_Refreshed: ${parsedRefreshedAt} · Total: ${parsedSummary.totalCount} · Blocked: ${parsedSummary.blockedCount}_`,
    "",
    "| Wave | Total | Done | In Progress | In review | Todo | Blocked |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...waveRows,
    "",
    "| Project status | Total |",
    "| --- | ---: |",
    ...statusRows,
    ROADMAP_STATUS_END,
    "",
  ].join("\n");
}

export function extractRoadmapSummary(source: string): RoadmapSummary {
  const statusBlock = findStatusBlock(source);
  const records = findAll(source, ROADMAP_STATUS_DATA_PREFIX);

  if (records.length !== 1) {
    throw new Error("Expected exactly one roadmap status data record");
  }

  const [recordStart] = records;

  if (recordStart === undefined) {
    throw new Error("Roadmap status data record is missing");
  }

  const lineStart =
    Math.max(
      source.lastIndexOf("\n", recordStart - 1),
      source.lastIndexOf("\r", recordStart - 1)
    ) + 1;
  const nextLineFeed = source.indexOf("\n", recordStart);
  const nextCarriageReturn = source.indexOf("\r", recordStart);
  const lineEnd = Math.min(
    nextLineFeed === -1 ? source.length : nextLineFeed,
    nextCarriageReturn === -1 ? source.length : nextCarriageReturn
  );
  const record = source.slice(lineStart, lineEnd);
  const statusBlockStart = statusBlock.start + ROADMAP_STATUS_START.length;

  if (
    recordStart !== lineStart ||
    lineStart < statusBlockStart ||
    lineEnd > statusBlock.end ||
    !record.endsWith(HIDDEN_RECORD_END)
  ) {
    throw new Error("Roadmap status data record is malformed");
  }

  const jsonStart = ROADMAP_STATUS_DATA_PREFIX.length;
  const jsonEnd = record.length - HIDDEN_RECORD_END.length;

  return roadmapSummarySchema.parse(
    JSON.parse(record.slice(jsonStart, jsonEnd))
  );
}

export function replaceRoadmapStatusBlock(
  source: string,
  replacement: string
): string {
  const sourceRange = findStatusBlock(source);
  const replacementWithoutTrailingNewlines = replacement.replace(
    /[\r\n]+$/u,
    ""
  );
  const replacementRange = findStatusBlock(replacementWithoutTrailingNewlines);
  const replacementEnd = replacementRange.end + ROADMAP_STATUS_END.length;

  if (
    replacementRange.start !== 0 ||
    replacementEnd !== replacementWithoutTrailingNewlines.length
  ) {
    throw new Error(
      "Replacement must contain exactly the roadmap status block"
    );
  }

  extractRoadmapSummary(replacementWithoutTrailingNewlines);

  const sourceEnd = sourceRange.end + ROADMAP_STATUS_END.length;
  const suffix = source.slice(sourceEnd);
  const replacementSeparator = /^[\r\n]/u.test(suffix) ? "" : "\n";

  return `${source.slice(0, sourceRange.start)}${replacementWithoutTrailingNewlines}${replacementSeparator}${suffix}`;
}
