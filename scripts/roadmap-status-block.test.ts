import assert from "node:assert/strict";
import test from "node:test";
import { PROJECT_STATUSES } from "./beads-project-model";
import {
  extractRoadmapSummary,
  ROADMAP_STATUS_END,
  ROADMAP_STATUS_START,
  renderRoadmapStatusBlock,
  replaceRoadmapStatusBlock,
} from "./roadmap-status-block";
import type { RoadmapSummary } from "./roadmap-status-model";

const START = "<!-- coven-agents-roadmap-status:v1:start -->";
const END = "<!-- coven-agents-roadmap-status:v1:end -->";
const DATA_PREFIX = "<!-- coven-agents-roadmap-status-data:v1 ";
const REFRESHED_AT = "2026-08-25T21:45:46.673Z";

function summary(): RoadmapSummary {
  return {
    blockedCount: 3,
    byStatus: {
      Done: 1,
      "In Progress": 3,
      "In review": 2,
      Todo: 4,
    },
    byWave: {
      "0 - Delivered": {
        blockedCount: 0,
        byStatus: {
          Done: 1,
          "In Progress": 0,
          "In review": 0,
          Todo: 0,
        },
        total: 1,
      },
      "1 - Now": {
        blockedCount: 2,
        byStatus: {
          Done: 0,
          "In Progress": 1,
          "In review": 1,
          Todo: 1,
        },
        total: 3,
      },
      "2 - Next": {
        blockedCount: 1,
        byStatus: {
          Done: 0,
          "In Progress": 1,
          "In review": 0,
          Todo: 1,
        },
        total: 2,
      },
      "3 - Certify": {
        blockedCount: 0,
        byStatus: {
          Done: 0,
          "In Progress": 0,
          "In review": 1,
          Todo: 0,
        },
        total: 1,
      },
      "4 - Platform": {
        blockedCount: 0,
        byStatus: {
          Done: 0,
          "In Progress": 0,
          "In review": 0,
          Todo: 1,
        },
        total: 1,
      },
      "5 - Product data": {
        blockedCount: 0,
        byStatus: {
          Done: 0,
          "In Progress": 1,
          "In review": 0,
          Todo: 0,
        },
        total: 1,
      },
      "6 - Operations": {
        blockedCount: 0,
        byStatus: {
          Done: 0,
          "In Progress": 0,
          "In review": 0,
          Todo: 1,
        },
        total: 1,
      },
    },
    totalCount: 10,
  };
}

function sourceWithSummary(value: RoadmapSummary): string {
  return `${START}
${DATA_PREFIX}${JSON.stringify(value)} -->
${END}`;
}

function assertSummaryRejected(value: RoadmapSummary): void {
  assert.throws(() => renderRoadmapStatusBlock(value, REFRESHED_AT));
  assert.throws(() => extractRoadmapSummary(sourceWithSummary(value)));
}

test("renders a deterministic exact roadmap status snapshot", () => {
  assert.equal(ROADMAP_STATUS_START, START);
  assert.equal(ROADMAP_STATUS_END, END);
  assert.equal(
    renderRoadmapStatusBlock(summary(), REFRESHED_AT),
    `${START}
${DATA_PREFIX}{"blockedCount":3,"byStatus":{"Todo":4,"In Progress":3,"In review":2,"Done":1},"byWave":{"0 - Delivered":{"blockedCount":0,"byStatus":{"Todo":0,"In Progress":0,"In review":0,"Done":1},"total":1},"1 - Now":{"blockedCount":2,"byStatus":{"Todo":1,"In Progress":1,"In review":1,"Done":0},"total":3},"2 - Next":{"blockedCount":1,"byStatus":{"Todo":1,"In Progress":1,"In review":0,"Done":0},"total":2},"3 - Certify":{"blockedCount":0,"byStatus":{"Todo":0,"In Progress":0,"In review":1,"Done":0},"total":1},"4 - Platform":{"blockedCount":0,"byStatus":{"Todo":1,"In Progress":0,"In review":0,"Done":0},"total":1},"5 - Product data":{"blockedCount":0,"byStatus":{"Todo":0,"In Progress":1,"In review":0,"Done":0},"total":1},"6 - Operations":{"blockedCount":0,"byStatus":{"Todo":1,"In Progress":0,"In review":0,"Done":0},"total":1}},"totalCount":10} -->
_Last refreshed: ${REFRESHED_AT} from private Project #10._

| Wave | Total | Done | In Progress | In review | Todo | Blocked |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 - Delivered | 1 | 1 | 0 | 0 | 0 | 0 |
| 1 - Now | 3 | 0 | 1 | 1 | 1 | 2 |
| 2 - Next | 2 | 0 | 1 | 0 | 1 | 1 |
| 3 - Certify | 1 | 0 | 0 | 1 | 0 | 0 |
| 4 - Platform | 1 | 0 | 0 | 0 | 1 | 0 |
| 5 - Product data | 1 | 0 | 1 | 0 | 0 | 0 |
| 6 - Operations | 1 | 0 | 0 | 0 | 1 | 0 |

| Project status | Total |
| --- | ---: |
| Todo | 4 |
| In Progress | 3 |
| In review | 2 |
| Done | 1 |
${END}
`
  );
});

test("does not leak bead IDs into rendered output", () => {
  const output = renderRoadmapStatusBlock(summary(), REFRESHED_AT);

  assert.doesNotMatch(output, /coven-agents-product\.\d+/);
  assert.equal(output.split(DATA_PREFIX).length - 1, 1);
});

test("rejects invalid summaries and non-ISO refreshed timestamps", () => {
  assert.throws(() =>
    renderRoadmapStatusBlock(
      {
        ...summary(),
        unexpected: "coven-agents-product.1",
      } as RoadmapSummary,
      REFRESHED_AT
    )
  );

  for (const refreshedAt of [
    "2026-08-25",
    "2026-08-25T21:45:46",
    "2026-13-25T21:45:46.673Z",
    `${REFRESHED_AT} trailing`,
  ]) {
    assert.throws(() => renderRoadmapStatusBlock(summary(), refreshedAt));
  }
});

test("rejects every arithmetic summary imbalance", () => {
  const topStatusMismatch = summary();
  topStatusMismatch.byStatus.Todo += 1;

  const waveTotalMismatch = summary();
  waveTotalMismatch.byWave["6 - Operations"].byStatus.Todo += 1;
  waveTotalMismatch.byWave["6 - Operations"].total += 1;

  const waveBlockedMismatch = summary();
  waveBlockedMismatch.byWave["3 - Certify"].blockedCount += 1;

  const waveStatusMismatch = summary();
  waveStatusMismatch.byWave["6 - Operations"].byStatus.Todo += 1;

  const topBlockedOverflow = summary();
  topBlockedOverflow.blockedCount = topBlockedOverflow.totalCount + 1;

  const waveBlockedOverflow = summary();
  waveBlockedOverflow.byWave["0 - Delivered"].blockedCount = 2;
  waveBlockedOverflow.blockedCount = 5;

  for (const value of [
    topStatusMismatch,
    waveTotalMismatch,
    waveBlockedMismatch,
    waveStatusMismatch,
    topBlockedOverflow,
    waveBlockedOverflow,
  ]) {
    assertSummaryRejected(value);
  }
});

test("rejects top-level status totals that differ from wave totals", () => {
  for (const [index, status] of PROJECT_STATUSES.entries()) {
    const value = summary();
    const otherStatus = PROJECT_STATUSES[(index + 1) % PROJECT_STATUSES.length];

    assert.ok(otherStatus);
    value.byStatus[status] += 1;
    value.byStatus[otherStatus] -= 1;

    assertSummaryRejected(value);
  }
});

test("extracts the rendered roadmap summary round-trip", () => {
  const expected = summary();

  assert.deepEqual(
    extractRoadmapSummary(
      `authored prefix\n${renderRoadmapStatusBlock(expected, REFRESHED_AT)}authored suffix`
    ),
    expected
  );
});

test("rejects visible table count or label tampering", () => {
  const rendered = renderRoadmapStatusBlock(summary(), REFRESHED_AT);

  for (const source of [
    rendered.replace(
      "| 1 - Now | 3 | 0 | 1 | 1 | 1 | 2 |",
      "| 1 - Now | 4 | 0 | 1 | 1 | 1 | 2 |"
    ),
    rendered.replace("| Todo | 4 |", "| Todo | 5 |"),
    rendered.replace("| Project status | Total |", "| Status | Count |"),
  ]) {
    assert.throws(() => extractRoadmapSummary(source));
  }
});

test("rejects timestamp line tampering and malformed timestamps", () => {
  const rendered = renderRoadmapStatusBlock(summary(), REFRESHED_AT);
  const timestampLine = `_Last refreshed: ${REFRESHED_AT} from private Project #10._`;

  for (const source of [
    rendered.replace(
      timestampLine,
      `_Refreshed: ${REFRESHED_AT} from private Project #10._`
    ),
    rendered.replace(
      timestampLine,
      "_Last refreshed: 2026-08-25 from private Project #10._"
    ),
    rendered.replace(
      timestampLine,
      `_Last refreshed: ${REFRESHED_AT} from private Project #10. (edited)_`
    ),
  ]) {
    assert.throws(() => extractRoadmapSummary(source));
  }
});

test("rejects extra arbitrary or private content inside the status block", () => {
  const rendered = renderRoadmapStatusBlock(summary(), REFRESHED_AT);

  for (const extraLine of [
    "Arbitrary roadmap note",
    "Private item coven-agents-product.123",
  ]) {
    assert.throws(() =>
      extractRoadmapSummary(rendered.replace(END, `${extraLine}\n${END}`))
    );
  }
});

test("rejects missing canonical blank lines", () => {
  const rendered = renderRoadmapStatusBlock(summary(), REFRESHED_AT);
  const timestampLine = `_Last refreshed: ${REFRESHED_AT} from private Project #10._`;

  assert.throws(() =>
    extractRoadmapSummary(
      rendered.replace(`${timestampLine}\n\n`, `${timestampLine}\n`)
    )
  );
});

test("rejects missing or reordered table rows", () => {
  const rendered = renderRoadmapStatusBlock(summary(), REFRESHED_AT);
  const firstRow = "| 0 - Delivered | 1 | 1 | 0 | 0 | 0 | 0 |";
  const secondRow = "| 1 - Now | 3 | 0 | 1 | 1 | 1 | 2 |";

  assert.throws(() =>
    extractRoadmapSummary(rendered.replace(`${firstRow}\n`, ""))
  );
  assert.throws(() =>
    extractRoadmapSummary(
      rendered.replace(`${firstRow}\n${secondRow}`, `${secondRow}\n${firstRow}`)
    )
  );
});

test("rejects hidden records without exactly one ordered marker pair", () => {
  const record = `${DATA_PREFIX}${JSON.stringify(summary())} -->`;

  for (const source of [
    record,
    `${START}\n${record}`,
    `${record}\n${END}`,
    `${END}\n${record}\n${START}`,
    `${START}\n${START}\n${record}\n${END}\n${END}`,
  ]) {
    assert.throws(() => extractRoadmapSummary(source));
  }
});

test("rejects hidden records outside the marked block", () => {
  const record = `${DATA_PREFIX}${JSON.stringify(summary())} -->`;

  assert.throws(() =>
    extractRoadmapSummary(`${record}\n${START}\nauthored\n${END}`)
  );
  assert.throws(() =>
    extractRoadmapSummary(`${START}\nauthored\n${END}\n${record}`)
  );
  assert.throws(() =>
    extractRoadmapSummary(`${record}\n${START}\n${record}\n${END}`)
  );
});

test("rejects hidden records with leading or trailing line junk", () => {
  const record = `${DATA_PREFIX}${JSON.stringify(summary())} -->`;

  assert.throws(() =>
    extractRoadmapSummary(`${START}\nleading ${record}\n${END}`)
  );
  assert.throws(() =>
    extractRoadmapSummary(`${START}\n${record} trailing\n${END}`)
  );
});

test("ignores marker and data substrings embedded in authored lines", () => {
  const expected = summary();
  const rendered = renderRoadmapStatusBlock(expected, REFRESHED_AT).trimEnd();
  const prefix = `Authored ${START} inline
Authored ${DATA_PREFIX}inline`;
  const suffix = `Authored ${END} inline`;
  const source = `${prefix}
${rendered}
${suffix}`;

  assert.deepEqual(extractRoadmapSummary(source), expected);

  const replacement = renderRoadmapStatusBlock(
    expected,
    "2026-08-26T02:00:00-05:00"
  ).trimEnd();

  assert.equal(
    replaceRoadmapStatusBlock(source, replacement),
    `${prefix}
${replacement}
${suffix}`
  );
});

test("rejects markers with leading or trailing line junk", () => {
  const record = `${DATA_PREFIX}${JSON.stringify(summary())} -->`;

  for (const source of [
    `leading ${START}\n${record}\n${END}`,
    `${START} trailing\n${record}\n${END}`,
    `${START}\n${record}\nleading ${END}`,
    `${START}\n${record}\n${END} trailing`,
  ]) {
    assert.throws(() => extractRoadmapSummary(source));
    assert.throws(() =>
      replaceRoadmapStatusBlock(
        source,
        renderRoadmapStatusBlock(summary(), REFRESHED_AT)
      )
    );
  }
});

test("rejects missing or duplicate hidden data records", () => {
  const rendered = renderRoadmapStatusBlock(summary(), REFRESHED_AT);
  const recordStart = rendered.indexOf(DATA_PREFIX);
  const recordEnd = rendered.indexOf(" -->", recordStart) + " -->".length;
  const record = rendered.slice(recordStart, recordEnd);

  assert.throws(() => extractRoadmapSummary(`${START}\n${END}`));
  assert.throws(() => extractRoadmapSummary(rendered.replace(record, "")));
  assert.throws(() =>
    extractRoadmapSummary(rendered.replace(record, `${record}\n${record}`))
  );
});

test("rejects malformed hidden JSON and strict schema violations", () => {
  assert.throws(() =>
    extractRoadmapSummary(
      `${START}\n${DATA_PREFIX}{"blockedCount": -->\n${END}`
    )
  );
  assert.throws(() =>
    extractRoadmapSummary(
      `${START}\n${DATA_PREFIX}${JSON.stringify({
        ...summary(),
        unexpected: true,
      })} -->\n${END}`
    )
  );
  assert.throws(() =>
    extractRoadmapSummary(
      `${START}\n${DATA_PREFIX}${JSON.stringify({
        ...summary(),
        totalCount: "10",
      })} -->\n${END}`
    )
  );
});

test("replaces only the marked block and preserves authored bytes", () => {
  const prefix = "Title \t\r\n  authored prefix\t\r\n";
  const suffix = "\r\n \tAUTHORED suffix\r\n";
  const oldBlock = renderRoadmapStatusBlock(summary(), REFRESHED_AT).trimEnd();
  const nextSummary = summary();
  nextSummary.blockedCount = 4;
  nextSummary.byWave["3 - Certify"].blockedCount = 1;
  const replacement = renderRoadmapStatusBlock(
    nextSummary,
    "2026-08-26T02:00:00-05:00"
  );

  const result = replaceRoadmapStatusBlock(
    `${prefix}${oldBlock}${suffix}`,
    `${replacement}\n\n`
  );

  assert.equal(result, `${prefix}${replacement.trimEnd()}${suffix}`);
  assert.equal(result.slice(0, prefix.length), prefix);
  assert.equal(result.slice(-suffix.length), suffix);
});

test("extracts CRLF canonical source and preserves surrounding CRLF bytes", () => {
  const expected = summary();
  const oldBlock = renderRoadmapStatusBlock(expected, REFRESHED_AT)
    .trimEnd()
    .replaceAll("\n", "\r\n");
  const prefix = "Authored prefix\r\n";
  const suffix = "\r\nAuthored suffix\r\n";
  const source = `${prefix}${oldBlock}${suffix}`;

  assert.deepEqual(extractRoadmapSummary(source), expected);

  const replacement = renderRoadmapStatusBlock(
    expected,
    "2026-08-26T02:00:00-05:00"
  ).trimEnd();
  const result = replaceRoadmapStatusBlock(source, replacement);

  assert.equal(result, `${prefix}${replacement}${suffix}`);
  assert.equal(result.slice(0, prefix.length), prefix);
  assert.equal(result.slice(-suffix.length), suffix);
});

test("preserves an existing newline after the end marker", () => {
  const oldBlock = renderRoadmapStatusBlock(summary(), REFRESHED_AT).trimEnd();
  const replacement = renderRoadmapStatusBlock(
    summary(),
    "2026-08-26T02:00:00-05:00"
  );
  const suffix = "\r\nAuthored suffix\n";

  const result = replaceRoadmapStatusBlock(
    `Authored prefix\n${oldBlock}${suffix}`,
    replacement
  );

  assert.equal(result, `Authored prefix\n${replacement.trimEnd()}${suffix}`);
});

test("repeated replacement does not accumulate blank lines", () => {
  const oldBlock = renderRoadmapStatusBlock(summary(), REFRESHED_AT).trimEnd();
  const replacement = renderRoadmapStatusBlock(
    summary(),
    "2026-08-26T02:00:00-05:00"
  );
  const source = `Authored prefix\n${oldBlock}\nAuthored suffix\n`;

  const once = replaceRoadmapStatusBlock(source, replacement);
  const twice = replaceRoadmapStatusBlock(once, replacement);

  assert.equal(twice, once);
  assert.equal(
    once,
    `Authored prefix\n${replacement.trimEnd()}\nAuthored suffix\n`
  );
});

test("rejects source text with missing markers", () => {
  for (const source of ["", START, END, `prefix ${START} suffix`]) {
    assert.throws(() => replaceRoadmapStatusBlock(source, `${START}\n${END}`));
  }
});

test("rejects source text with duplicate markers", () => {
  assert.throws(() =>
    replaceRoadmapStatusBlock(
      `${START}\n${END}\n${START}\n${END}`,
      `${START}\n${END}`
    )
  );
  assert.throws(() =>
    replaceRoadmapStatusBlock(`${START}\n${START}\n${END}`, `${START}\n${END}`)
  );
  assert.throws(() =>
    replaceRoadmapStatusBlock(`${START}\n${END}\n${END}`, `${START}\n${END}`)
  );
});

test("rejects reversed source markers", () => {
  assert.throws(() =>
    replaceRoadmapStatusBlock(`${END}\nauthored\n${START}`, `${START}\n${END}`)
  );
});

test("rejects nested source markers", () => {
  assert.throws(() =>
    replaceRoadmapStatusBlock(
      `${START}\n${START}\nnested\n${END}\n${END}`,
      `${START}\n${END}`
    )
  );
});

test("rejects replacements without one exact marker pair", () => {
  const source = renderRoadmapStatusBlock(summary(), REFRESHED_AT).trimEnd();

  for (const replacement of [
    "",
    "replacement",
    `${START}\nmissing end`,
    `missing start\n${END}`,
    `prefix\n${START}\n${END}`,
    `${START}\n${END}\nsuffix`,
    `${START}\n${START}\n${END}\n${END}`,
  ]) {
    assert.throws(() => replaceRoadmapStatusBlock(source, replacement));
  }
});

test("rejects replacements without one canonical hidden data record", () => {
  const source = renderRoadmapStatusBlock(summary(), REFRESHED_AT).trimEnd();
  const record = `${DATA_PREFIX}${JSON.stringify(summary())} -->`;

  for (const replacement of [
    `${START}\n${END}`,
    `${START}\nleading ${record}\n${END}`,
    `${START}\n${record} trailing\n${END}`,
    `${START}\n${DATA_PREFIX}{}\n${END}`,
  ]) {
    assert.throws(() => replaceRoadmapStatusBlock(source, replacement));
  }
});
