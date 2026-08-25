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

type SourceLine = {
  content: string;
  end: number;
  start: number;
};

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;

  while (start <= source.length) {
    const lineFeed = source.indexOf("\n", start);

    if (lineFeed === -1) {
      lines.push({
        content: source.slice(start),
        end: source.length,
        start,
      });
      break;
    }

    const end =
      lineFeed > start && source[lineFeed - 1] === "\r"
        ? lineFeed - 1
        : lineFeed;

    lines.push({
      content: source.slice(start, end),
      end,
      start,
    });
    start = lineFeed + 1;
  }

  return lines;
}

function findStatusBlock(source: string): MarkerRange {
  const lines = sourceLines(source);
  const starts = lines.filter((line) => line.content === ROADMAP_STATUS_START);
  const ends = lines.filter((line) => line.content === ROADMAP_STATUS_END);

  if (starts.length !== 1 || ends.length !== 1) {
    throw new Error("Expected exactly one roadmap status marker pair");
  }

  const [startLine] = starts;
  const [endLine] = ends;

  if (
    startLine === undefined ||
    endLine === undefined ||
    startLine.start >= endLine.start
  ) {
    throw new Error("Roadmap status markers are not correctly ordered");
  }

  return { end: endLine.start, start: startLine.start };
}

function sumStatuses(summary: RoadmapSummary["byStatus"]): number {
  let total = 0;

  for (const status of PROJECT_STATUSES) {
    total += summary[status];
  }

  return total;
}

function validateRoadmapSummary(summary: RoadmapSummary): RoadmapSummary {
  if (sumStatuses(summary.byStatus) !== summary.totalCount) {
    throw new Error("Roadmap status counts do not equal the total count");
  }

  if (summary.blockedCount > summary.totalCount) {
    throw new Error("Roadmap blocked count exceeds the total count");
  }

  let waveTotal = 0;
  let waveBlockedTotal = 0;

  for (const wave of WAVES) {
    const waveSummary = summary.byWave[wave];

    if (sumStatuses(waveSummary.byStatus) !== waveSummary.total) {
      throw new Error(`Roadmap status counts do not equal total for ${wave}`);
    }

    if (waveSummary.blockedCount > waveSummary.total) {
      throw new Error(`Roadmap blocked count exceeds total for ${wave}`);
    }

    waveTotal += waveSummary.total;
    waveBlockedTotal += waveSummary.blockedCount;
  }

  if (waveTotal !== summary.totalCount) {
    throw new Error("Roadmap wave totals do not equal the total count");
  }

  if (waveBlockedTotal !== summary.blockedCount) {
    throw new Error(
      "Roadmap wave blocked counts do not equal the blocked count"
    );
  }

  return summary;
}

export function renderRoadmapStatusBlock(
  summary: RoadmapSummary,
  refreshedAt: string
): string {
  const parsedSummary = validateRoadmapSummary(
    roadmapSummarySchema.parse(summary)
  );
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
  const records = sourceLines(source).filter(
    (line) =>
      line.content.startsWith(ROADMAP_STATUS_DATA_PREFIX) &&
      line.content.endsWith(HIDDEN_RECORD_END)
  );

  if (records.length !== 1) {
    throw new Error("Expected exactly one roadmap status data record");
  }

  const [recordLine] = records;

  if (recordLine === undefined) {
    throw new Error("Roadmap status data record is missing");
  }

  const record = recordLine.content;
  const statusBlockStart = statusBlock.start + ROADMAP_STATUS_START.length;

  if (recordLine.start < statusBlockStart || recordLine.end > statusBlock.end) {
    throw new Error("Roadmap status data record is malformed");
  }

  const jsonStart = ROADMAP_STATUS_DATA_PREFIX.length;
  const jsonEnd = record.length - HIDDEN_RECORD_END.length;

  return validateRoadmapSummary(
    roadmapSummarySchema.parse(JSON.parse(record.slice(jsonStart, jsonEnd)))
  );
}

export function replaceRoadmapStatusBlock(
  source: string,
  replacement: string
): string {
  const sourceRange = findStatusBlock(source);
  const replacementWithoutTrailingNewlines = replacement.replace(
    /(?:\r\n|\n)+$/u,
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

  return `${source.slice(0, sourceRange.start)}${replacementWithoutTrailingNewlines}${suffix}`;
}
