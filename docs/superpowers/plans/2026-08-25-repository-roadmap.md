# Repository Roadmap and Delivery Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a public, evidence-backed repository roadmap that safely summarizes the private Beads plan, defines Phase 0/Now/Next execution gates, and keeps delivery status reviewable without copying private task content into git.

**Architecture:** Private Beads/DoltHub remains authoritative and Project #10 remains its generated private view. A field-only GitHub GraphQL reader requests only Bead ID, Status, Wave, and Blocked values, converts them into a validated aggregate, and atomically refreshes a marked block in `ROADMAP.md`; focused companion documents own current state, implementation sequence, governance, verification, and release readiness.

**Tech Stack:** TypeScript, Node.js `node:test`, Zod, GitHub GraphQL through the existing `runGraphql` boundary, pnpm, Beads/DoltHub, Markdown.

---

## Scope boundary

This plan implements one coherent roadmap-governance system. It does not
implement the 58 unfinished private roadmap items. Phase 0, Wave 1, and Wave 2
receive detailed public execution lanes; later waves remain outcome-level.

The private roadmap may contain sensitive descriptions and acceptance
criteria. Never paste output from `bd show`, `bd list`, Project item content,
or issue bodies into a checked-in document. Bead IDs and aggregate enum counts
are the only task-level data allowed in the public projection.

Every commit in this plan must be signed and pushed:

```bash
git commit -S ...
git push
```

## File structure

### Create

- `ROADMAP.md` — public strategic spine and generated aggregate block.
- `docs/roadmap/current-state.md` — dated repository audit and risk register.
- `docs/roadmap/implementation-sequence.md` — detailed Phase 0/Now/Next lanes
  and outcome-level later waves.
- `docs/roadmap/delivery-governance.md` — authority, reconciliation, worktree,
  issue, PR, and promotion rules.
- `docs/roadmap/verification-matrix.md` — implemented/verified/certified
  evidence matrix.
- `docs/roadmap/release-readiness.md` — go/no-go, rollback, and recovery gates.
- `scripts/roadmap-status-model.ts` — strict roadmap item and aggregate model.
- `scripts/roadmap-status-model.test.ts` — aggregate, duplicate, and enum tests.
- `scripts/roadmap-project-status.ts` — field-only Project GraphQL query and
  pagination.
- `scripts/roadmap-project-status.test.ts` — privacy, pagination, and malformed
  response tests.
- `scripts/roadmap-status-block.ts` — deterministic Markdown rendering and
  marker replacement.
- `scripts/roadmap-status-block.test.ts` — marker, rendering, and preservation
  tests.
- `scripts/roadmap-status.ts` — `preview`, `check`, and `apply` CLI.
- `scripts/roadmap-status.test.ts` — CLI no-op, stale, atomic-write, and safe
  error tests.

### Modify

- `package.json` — add the `roadmap:status` command.
- `README.md` — add the roadmap documentation entry point.
- `CLAUDE.md` — add the planning authority and roadmap refresh workflow.

## Task 1: Restore and reconcile the planning baseline

This task changes private planning state and GitHub issue state, not source
files. Stop rather than inventing data if required credentials are unavailable.

- [ ] **Step 1: Confirm the implementation worktree and signing setup**

Run:

```bash
git status --short --branch
pnpm hygiene doctor
```

Expected:

- the current branch is `docs/repository-roadmap`;
- the worktree contains only intentional plan/spec changes; and
- signing reports `Signing configured`.

- [ ] **Step 2: Verify the private planning prerequisites without printing secrets**

Run:

```bash
export BEADS_WORKSPACE="$HOME/.local/share/opencoven/coven-agents-beads"
export COVEN_PROJECT_OWNER=OpenCoven
export COVEN_PROJECT_NUMBER=10
export DOLT_REMOTE_URL=https://doltremoteapi.dolthub.com/OpenCoven/coven-agents-beads

test -n "$DOLT_REMOTE_USER"
test -n "$DOLT_REMOTE_PASSWORD"
test -n "$GH_TOKEN"
bd version
dolt version
gh --version | head -1
node --version
pnpm --version
```

Expected:

- each `test -n` exits 0 without printing the value;
- Beads is `1.2.2`;
- Dolt is `2.x`;
- `gh`, Node, and pnpm satisfy `docs/beads-project-sync.md`.

If any credential test fails, mark this task blocked and do not substitute
Project #10 for the authoritative Beads database.

- [ ] **Step 3: Restore or initialize the private Beads workspace**

Run:

```bash
mkdir -p "$BEADS_WORKSPACE"
if [ ! -d "$BEADS_WORKSPACE/.git" ]; then
  git -C "$BEADS_WORKSPACE" init --quiet
fi
if [ ! -d "$BEADS_WORKSPACE/.beads" ]; then
  bd -C "$BEADS_WORKSPACE" init \
    --non-interactive \
    --prefix coven-agents \
    --remote "$DOLT_REMOTE_URL" \
    --skip-agents \
    --skip-hooks
fi
bd -C "$BEADS_WORKSPACE" dolt remote list
bd -C "$BEADS_WORKSPACE" dolt pull
bd -C "$BEADS_WORKSPACE" dolt status
```

Expected: the configured remote is present, pull succeeds, and the workspace is
readable.

- [ ] **Step 4: Review aggregate authoritative state without logging private text**

Run:

```bash
bd -C "$BEADS_WORKSPACE" --readonly list --all --limit 0 --json |
  jq '{
    total: length,
    by_status: (group_by(.status) | map({status: .[0].status, count: length})),
    by_wave: (
      group_by(.metadata.wave) |
      map({wave: .[0].metadata.wave, count: length})
    )
  }'
```

Expected: `total` is 60 and every item has an approved status and wave.

- [ ] **Step 5: Reconcile shipped work in Beads**

Inspect only the relevant records locally:

```bash
bd -C "$BEADS_WORKSPACE" show \
  coven-agents-cloud.2 \
  coven-agents-product.3 \
  coven-agents-security.2 \
  coven-agents-dx.2 \
  --json >"$BEADS_WORKSPACE/reconcile-review.json"
```

Compare their acceptance criteria with merged evidence:

- tenant isolation: PRs `#46`, `#52`, `#53`, `#54`, and `#58`;
- recorded demo: PR `#62`;
- subscriber boundary and billing enforcement: PRs `#76` and `#77`;
- git lifecycle controls: merged hygiene and planning work through PR `#56`.

For each record whose acceptance criteria are fully met, close it with a
non-sensitive reason:

```bash
for id in coven-agents-product.3 coven-agents-security.2; do
  status="$(
    bd -C "$BEADS_WORKSPACE" show "$id" --json |
      jq -r 'if type == "array" then .[0].status else .status end'
  )"
  if [ "$status" != "closed" ]; then
    bd -C "$BEADS_WORKSPACE" close "$id" \
      --reason "Merged and verified on main."
  fi
done
rm -f -- "$BEADS_WORKSPACE/reconcile-review.json"
```

If an acceptance criterion is not met, leave that bead open and record the gap
in `docs/roadmap/current-state.md` during Task 7.

- [ ] **Step 6: Commit and push the private Dolt change**

Run:

```bash
bd -C "$BEADS_WORKSPACE" dolt status
bd -C "$BEADS_WORKSPACE" dolt commit \
  --message "Reconcile shipped roadmap outcomes"
bd -C "$BEADS_WORKSPACE" dolt push
```

Expected: the private database has no uncommitted changes after the push.

- [ ] **Step 7: Reconcile Project #10 and prove idempotency**

Run:

```bash
pnpm beads:sync preview
pnpm beads:sync apply
pnpm beads:sync apply
pnpm beads:sync preview
```

Expected after the second apply:

```text
create count: 0
update count: 0
orphaned count: 0
unchanged count: 60
```

- [ ] **Step 8: Reconcile implementation issues**

Close only issues whose outcome is fully represented on `main`:

```bash
gh issue close 47 --comment "Implemented by #46, #52, #53, #54, and #58; tracked as delivered in the authoritative roadmap."
gh issue close 48 --comment "Implemented by #62; tracked as delivered in the authoritative roadmap."
gh issue close 49 --comment "Implemented by #76 and #77; tracked as delivered in the authoritative roadmap."
```

Leave `#50` and `#51` open because product authority and full production E2E
remain roadmap outcomes.

- [ ] **Step 9: Restore repository hygiene**

Run:

```bash
pnpm hygiene reap
pnpm hygiene reap --yes
git push
pnpm hygiene
```

Expected: no worktree is `AT RISK` and the secondary count is at or below 3.

## Task 2: Add the strict roadmap aggregate model

**Files:**

- Create: `scripts/roadmap-status-model.ts`
- Create: `scripts/roadmap-status-model.test.ts`

- [ ] **Step 1: Write the failing aggregate tests**

Create `scripts/roadmap-status-model.test.ts` with:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  sameRoadmapSummary,
  summarizeRoadmap,
  type RoadmapProjectItem,
} from "./roadmap-status-model";

function item(
  id: string,
  overrides: Partial<RoadmapProjectItem> = {}
): RoadmapProjectItem {
  return {
    beadId: id,
    blocked: "No",
    status: "Todo",
    wave: "1 - Now",
    ...overrides,
  };
}

test("summarizes status, wave, and blocked counts deterministically", () => {
  const summary = summarizeRoadmap(
    [
      item("coven-agents-product.1"),
      item("coven-agents-cloud.2", {
        blocked: "Yes",
        status: "Done",
        wave: "0 - Delivered",
      }),
    ],
    2
  );

  assert.equal(summary.totalCount, 2);
  assert.equal(summary.blockedCount, 1);
  assert.equal(summary.byStatus.Done, 1);
  assert.equal(summary.byStatus.Todo, 1);
  assert.equal(summary.byWave["0 - Delivered"].byStatus.Done, 1);
  assert.equal(summary.byWave["1 - Now"].total, 1);
});

test("rejects duplicate bead ids", () => {
  assert.throws(
    () =>
      summarizeRoadmap(
        [item("coven-agents-product.1"), item("coven-agents-product.1")],
        2
      ),
    /Duplicate roadmap bead ID/
  );
});

test("rejects an unexpected managed inventory count", () => {
  assert.throws(
    () => summarizeRoadmap([item("coven-agents-product.1")], 60),
    /Expected 60 managed roadmap items, received 1/
  );
});

test("compares summaries structurally", () => {
  const left = summarizeRoadmap([item("coven-agents-product.1")], 1);
  const right = summarizeRoadmap([item("coven-agents-product.1")], 1);

  assert.equal(sameRoadmapSummary(left, right), true);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
pnpm exec tsx --test scripts/roadmap-status-model.test.ts
```

Expected: FAIL because `roadmap-status-model.ts` does not exist.

- [ ] **Step 3: Implement the model**

Create `scripts/roadmap-status-model.ts`:

```ts
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
  blockedCount: number;
  byStatus: Record<ProjectStatus, number>;
  total: number;
};

export type RoadmapSummary = {
  blockedCount: number;
  byStatus: Record<ProjectStatus, number>;
  byWave: Record<RoadmapWave, WaveSummary>;
  totalCount: number;
};

const statusCountsSchema = z.object({
  Done: z.number().int().nonnegative(),
  "In Progress": z.number().int().nonnegative(),
  "In review": z.number().int().nonnegative(),
  Todo: z.number().int().nonnegative(),
}).strict();

const waveSummarySchema = z.object({
  blockedCount: z.number().int().nonnegative(),
  byStatus: statusCountsSchema,
  total: z.number().int().nonnegative(),
}).strict();

export const roadmapSummarySchema = z.object({
  blockedCount: z.number().int().nonnegative(),
  byStatus: statusCountsSchema,
  byWave: z.object(
    Object.fromEntries(WAVES.map((wave) => [wave, waveSummarySchema])) as Record<
      RoadmapWave,
      typeof waveSummarySchema
    >
  ).strict(),
  totalCount: z.number().int().nonnegative(),
}).strict();

function emptyStatusCounts(): Record<ProjectStatus, number> {
  return {
    Done: 0,
    "In Progress": 0,
    "In review": 0,
    Todo: 0,
  };
}

function emptyWaveSummary(): Record<RoadmapWave, WaveSummary> {
  return Object.fromEntries(
    WAVES.map((wave) => [
      wave,
      { blockedCount: 0, byStatus: emptyStatusCounts(), total: 0 },
    ])
  ) as Record<RoadmapWave, WaveSummary>;
}

export function summarizeRoadmap(
  items: readonly RoadmapProjectItem[],
  expectedCount = ROADMAP_EXPECTED_ITEM_COUNT
): RoadmapSummary {
  if (items.length !== expectedCount) {
    throw new Error(
      `Expected ${expectedCount} managed roadmap items, received ${items.length}`
    );
  }

  const seen = new Set<string>();
  const summary: RoadmapSummary = {
    blockedCount: 0,
    byStatus: emptyStatusCounts(),
    byWave: emptyWaveSummary(),
    totalCount: items.length,
  };

  for (const item of [...items].sort((a, b) =>
    a.beadId.localeCompare(b.beadId)
  )) {
    if (!BEAD_ID_PATTERN.test(item.beadId)) {
      throw new Error(`Invalid roadmap bead ID: ${item.beadId}`);
    }
    if (seen.has(item.beadId)) {
      throw new Error(`Duplicate roadmap bead ID: ${item.beadId}`);
    }
    seen.add(item.beadId);

    summary.byStatus[item.status] += 1;
    const wave = summary.byWave[item.wave];
    wave.byStatus[item.status] += 1;
    wave.total += 1;

    if (item.blocked === "Yes") {
      summary.blockedCount += 1;
      wave.blockedCount += 1;
    }
  }

  return roadmapSummarySchema.parse(summary);
}

export function sameRoadmapSummary(
  left: RoadmapSummary,
  right: RoadmapSummary
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
```

- [ ] **Step 4: Run the focused test**

Run:

```bash
pnpm exec tsx --test scripts/roadmap-status-model.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit and push**

```bash
git add scripts/roadmap-status-model.ts scripts/roadmap-status-model.test.ts
git commit -S -m "feat(roadmap): model aggregate project status" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push
```

## Task 3: Add the field-only Project reader

**Files:**

- Create: `scripts/roadmap-project-status.ts`
- Create: `scripts/roadmap-project-status.test.ts`

- [ ] **Step 1: Write failing privacy and parsing tests**

The test file must cover:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  ROADMAP_STATUS_QUERY,
  loadRoadmapProjectItems,
} from "./roadmap-project-status";

const projectFields = {
  beadIdField: {
    __typename: "ProjectV2Field",
    dataType: "TEXT",
    name: "Bead ID",
  },
  blockedField: {
    __typename: "ProjectV2SingleSelectField",
    name: "Blocked",
    options: [{ name: "No" }, { name: "Yes" }],
  },
  statusField: {
    __typename: "ProjectV2SingleSelectField",
    name: "Status",
    options: [
      { name: "Todo" },
      { name: "In Progress" },
      { name: "In review" },
      { name: "Done" },
    ],
  },
  waveField: {
    __typename: "ProjectV2SingleSelectField",
    name: "Wave",
    options: [
      { name: "0 - Delivered" },
      { name: "1 - Now" },
      { name: "2 - Next" },
      { name: "3 - Certify" },
      { name: "4 - Platform" },
      { name: "5 - Product data" },
      { name: "6 - Operations" },
    ],
  },
};

test("the query never requests Project content", () => {
  assert.match(ROADMAP_STATUS_QUERY, /fieldValueByName/);
  assert.doesNotMatch(
    ROADMAP_STATUS_QUERY,
    /\b(content|title|body|description|acceptance)\b/i
  );
});

test("loads only managed items and follows item pagination", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const responses = [
    {
      data: {
        organization: {
          projectV2: {
            ...projectFields,
            items: {
              nodes: [{
                id: "PVTI_1",
                beadId: { text: "coven-agents-product.1" },
                blocked: { name: "No" },
                status: { name: "Todo" },
                wave: { name: "1 - Now" },
              }],
              pageInfo: { endCursor: "cursor-1", hasNextPage: true },
            },
          },
        },
      },
    },
    {
      data: {
        organization: {
          projectV2: {
            ...projectFields,
            items: {
              nodes: [{
                id: "PVTI_unmanaged",
                beadId: null,
                blocked: null,
                status: { name: "Todo" },
                wave: null,
              }],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        },
      },
    },
  ];

  const items = await loadRoadmapProjectItems("OpenCoven", 10, async (
    _query,
    variables
  ) => {
    calls.push(variables);
    return responses[calls.length - 1] ?? {};
  });

  assert.deepEqual(items, [{
    beadId: "coven-agents-product.1",
    blocked: "No",
    status: "Todo",
    wave: "1 - Now",
  }]);
  assert.deepEqual(calls, [
    { after: null, number: 10, owner: "OpenCoven" },
    { after: "cursor-1", number: 10, owner: "OpenCoven" },
  ]);
});

test("rejects a partially managed item", async () => {
  await assert.rejects(
    () =>
      loadRoadmapProjectItems("OpenCoven", 10, async () => ({
        data: {
          organization: {
            projectV2: {
              ...projectFields,
              items: {
                nodes: [{
                  id: "PVTI_1",
                  beadId: { text: "coven-agents-product.1" },
                  blocked: null,
                  status: { name: "Todo" },
                  wave: { name: "1 - Now" },
                }],
                pageInfo: { endCursor: null, hasNextPage: false },
              },
            },
          },
        },
      })),
    /missing Blocked/
  );
});

test("rejects an incomplete managed field schema", async () => {
  await assert.rejects(
    () =>
      loadRoadmapProjectItems("OpenCoven", 10, async () => ({
        data: {
          organization: {
            projectV2: {
              ...projectFields,
              statusField: {
                ...projectFields.statusField,
                options: [{ name: "Todo" }],
              },
              items: {
                nodes: [],
                pageInfo: { endCursor: null, hasNextPage: false },
              },
            },
          },
        },
      })),
    /Status has incorrect options/
  );
});

test("rejects GraphQL errors without echoing server messages", async () => {
  await assert.rejects(
    () =>
      loadRoadmapProjectItems("OpenCoven", 10, async () => ({
        errors: [{ message: "private server detail" }],
      })),
    /^Error: GitHub roadmap query failed with 1 error/
  );
});
```

- [ ] **Step 2: Run the test and verify failure**

```bash
pnpm exec tsx --test scripts/roadmap-project-status.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the field-only query and strict parser**

Create `scripts/roadmap-project-status.ts` with these public exports:

```ts
import { z } from "zod";
import type { GraphqlRunner } from "./beads-project-io";
import { runGraphql } from "./beads-project-io";
import {
  BLOCKED_OPTIONS,
  type RoadmapProjectItem,
} from "./roadmap-status-model";
import { PROJECT_STATUSES, WAVES } from "./beads-project-model";

export const ROADMAP_STATUS_QUERY = `
  query RoadmapProjectStatus(
    $owner: String!
    $number: Int!
    $after: String
  ) {
    organization(login: $owner) {
      projectV2(number: $number) {
        beadIdField: field(name: "Bead ID") {
          __typename
          ... on ProjectV2Field { name dataType }
        }
        statusField: field(name: "Status") {
          __typename
          ... on ProjectV2SingleSelectField { name options { name } }
        }
        waveField: field(name: "Wave") {
          __typename
          ... on ProjectV2SingleSelectField { name options { name } }
        }
        blockedField: field(name: "Blocked") {
          __typename
          ... on ProjectV2SingleSelectField { name options { name } }
        }
        items(first: 100, after: $after) {
          nodes {
            id
            beadId: fieldValueByName(name: "Bead ID") {
              ... on ProjectV2ItemFieldTextValue { text }
            }
            status: fieldValueByName(name: "Status") {
              ... on ProjectV2ItemFieldSingleSelectValue { name }
            }
            wave: fieldValueByName(name: "Wave") {
              ... on ProjectV2ItemFieldSingleSelectValue { name }
            }
            blocked: fieldValueByName(name: "Blocked") {
              ... on ProjectV2ItemFieldSingleSelectValue { name }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

const namedValueSchema = z.object({ name: z.string() }).strict().nullable();
const textValueSchema = z.object({ text: z.string() }).strict().nullable();
const textFieldSchema = z.object({
  __typename: z.literal("ProjectV2Field"),
  dataType: z.literal("TEXT"),
  name: z.literal("Bead ID"),
}).strict().nullable();
const selectFieldSchema = z.object({
  __typename: z.literal("ProjectV2SingleSelectField"),
  name: z.string(),
  options: z.array(z.object({ name: z.string() }).strict()),
}).strict().nullable();
const pageSchema = z.object({
  nodes: z.array(z.object({
    id: z.string().min(1),
    beadId: textValueSchema,
    blocked: namedValueSchema,
    status: namedValueSchema,
    wave: namedValueSchema,
  }).strict()),
  pageInfo: z.object({
    endCursor: z.string().nullable(),
    hasNextPage: z.boolean(),
  }).strict(),
}).strict();

const dataSchema = z.object({
  organization: z.object({
    projectV2: z.object({
      beadIdField: textFieldSchema,
      blockedField: selectFieldSchema,
      items: pageSchema,
      statusField: selectFieldSchema,
      waveField: selectFieldSchema,
    }).strict().nullable(),
  }).strict().nullable(),
}).strict();

function assertOptions(
  field: z.infer<typeof selectFieldSchema>,
  name: string,
  expected: readonly string[]
): void {
  if (field === null || field.name !== name) {
    throw new Error(`Project field ${name} is missing or invalid`);
  }
  const actual = field.options.map((option) => option.name).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`Project field ${name} has incorrect options`);
  }
}

function validateProjectFields(
  project: NonNullable<
    NonNullable<z.infer<typeof dataSchema>["organization"]>["projectV2"]
  >
): void {
  if (project.beadIdField === null) {
    throw new Error("Project field Bead ID is missing or invalid");
  }
  assertOptions(project.blockedField, "Blocked", BLOCKED_OPTIONS);
  assertOptions(project.statusField, "Status", PROJECT_STATUSES);
  assertOptions(project.waveField, "Wave", WAVES);
}

function managedItem(node: z.infer<typeof pageSchema>["nodes"][number]):
  RoadmapProjectItem | null {
  if (node.beadId === null) {
    return null;
  }
  if (node.blocked === null) {
    throw new Error(`Managed roadmap item ${node.id} is missing Blocked`);
  }
  if (node.status === null) {
    throw new Error(`Managed roadmap item ${node.id} is missing Status`);
  }
  if (node.wave === null) {
    throw new Error(`Managed roadmap item ${node.id} is missing Wave`);
  }

  return {
    beadId: node.beadId.text,
    blocked: z.enum(BLOCKED_OPTIONS).parse(node.blocked.name),
    status: z.enum(PROJECT_STATUSES).parse(node.status.name),
    wave: z.enum(WAVES).parse(node.wave.name),
  };
}

export async function loadRoadmapProjectItems(
  owner: string,
  projectNumber: number,
  graphql: GraphqlRunner = runGraphql
): Promise<RoadmapProjectItem[]> {
  const items: RoadmapProjectItem[] = [];
  let after: string | null = null;

  do {
    const payload = await graphql(ROADMAP_STATUS_QUERY, {
      after,
      number: projectNumber,
      owner,
    });

    if ((payload.errors?.length ?? 0) > 0) {
      throw new Error(
        `GitHub roadmap query failed with ${payload.errors?.length} error(s)`
      );
    }

    const data = dataSchema.parse(payload.data);
    const project = data.organization?.projectV2;
    if (project === null || project === undefined) {
      throw new Error(`Project ${owner}#${projectNumber} was not found`);
    }
    validateProjectFields(project);

    for (const node of project.items.nodes) {
      const item = managedItem(node);
      if (item !== null) {
        items.push(item);
      }
    }

    if (!project.items.pageInfo.hasNextPage) {
      after = null;
      break;
    }
    after = project.items.pageInfo.endCursor;
    if (after === null) {
      throw new Error("Roadmap Project pagination is missing endCursor");
    }
  } while (after !== null);

  return items;
}
```

Do not replace `fieldValueByName` with `fieldValues`; the latter downloads
unapproved fields.

- [ ] **Step 4: Run focused tests**

```bash
pnpm exec tsx --test scripts/roadmap-project-status.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit and push**

```bash
git add scripts/roadmap-project-status.ts scripts/roadmap-project-status.test.ts
git commit -S -m "feat(roadmap): read safe project aggregates" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push
```

## Task 4: Add deterministic Markdown block rendering

**Files:**

- Create: `scripts/roadmap-status-block.ts`
- Create: `scripts/roadmap-status-block.test.ts`

- [ ] **Step 1: Write failing marker and rendering tests**

Cover these behaviors:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { summarizeRoadmap } from "./roadmap-status-model";
import {
  extractRoadmapSummary,
  renderRoadmapStatusBlock,
  replaceRoadmapStatusBlock,
} from "./roadmap-status-block";

const summary = summarizeRoadmap([{
  beadId: "coven-agents-product.1",
  blocked: "No",
  status: "Todo",
  wave: "1 - Now",
}], 1);

test("renders a deterministic aggregate-only block", () => {
  const block = renderRoadmapStatusBlock(
    summary,
    "2026-08-25T12:00:00.000Z"
  );

  assert.match(block, /Last refreshed: 2026-08-25T12:00:00.000Z/);
  assert.match(block, /\| 1 - Now \| 1 \| 0 \| 0 \| 0 \| 1 \| 0 \|/);
  assert.doesNotMatch(block, /coven-agents-product\.1/);
});

test("extracts the hidden canonical summary", () => {
  assert.deepEqual(
    extractRoadmapSummary(renderRoadmapStatusBlock(
      summary,
      "2026-08-25T12:00:00.000Z"
    )),
    summary
  );
});

test("replaces only the single marked block", () => {
  const source = `before\n${renderRoadmapStatusBlock(
    summary,
    "2026-08-25T12:00:00.000Z"
  )}\nafter\n`;
  const next = replaceRoadmapStatusBlock(
    source,
    renderRoadmapStatusBlock(summary, "2026-08-26T12:00:00.000Z")
  );

  assert.match(next, /^before\n/);
  assert.match(next, /\nafter\n$/);
  assert.match(next, /2026-08-26/);
});

test("rejects missing or duplicate markers", () => {
  assert.throws(
    () => replaceRoadmapStatusBlock("no markers", "replacement"),
    /exactly one roadmap status block/
  );
});
```

- [ ] **Step 2: Run and verify failure**

```bash
pnpm exec tsx --test scripts/roadmap-status-block.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement rendering and replacement**

Create `scripts/roadmap-status-block.ts` with:

```ts
import { PROJECT_STATUSES, WAVES } from "./beads-project-model";
import {
  type RoadmapSummary,
  roadmapSummarySchema,
} from "./roadmap-status-model";

export const ROADMAP_STATUS_START =
  "<!-- coven-agents-roadmap-status:v1:start -->";
export const ROADMAP_STATUS_END =
  "<!-- coven-agents-roadmap-status:v1:end -->";
const DATA_PREFIX = "<!-- coven-agents-roadmap-status-data:v1 ";
const DATA_SUFFIX = " -->";

export function renderRoadmapStatusBlock(
  summary: RoadmapSummary,
  refreshedAt: string
): string {
  const validated = roadmapSummarySchema.parse(summary);
  const lines = [
    ROADMAP_STATUS_START,
    `${DATA_PREFIX}${JSON.stringify(validated)}${DATA_SUFFIX}`,
    "",
    `_Last refreshed: ${refreshedAt} from private Project #10._`,
    "",
    `Managed items: **${validated.totalCount}** · Blocked: **${validated.blockedCount}**`,
    "",
    "| Wave | Total | Done | In Progress | In review | Todo | Blocked |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const wave of WAVES) {
    const row = validated.byWave[wave];
    lines.push(
      `| ${wave} | ${row.total} | ${row.byStatus.Done} | ` +
      `${row.byStatus["In Progress"]} | ${row.byStatus["In review"]} | ` +
      `${row.byStatus.Todo} | ${row.blockedCount} |`
    );
  }

  lines.push(
    "",
    "| Status | Count |",
    "| --- | ---: |",
    ...PROJECT_STATUSES.map(
      (status) => `| ${status} | ${validated.byStatus[status]} |`
    ),
    ROADMAP_STATUS_END
  );

  return `${lines.join("\n")}\n`;
}

export function extractRoadmapSummary(source: string): RoadmapSummary {
  const lines = source.split("\n").filter((line) =>
    line.startsWith(DATA_PREFIX)
  );
  if (lines.length !== 1) {
    throw new Error("Expected exactly one roadmap status data record");
  }
  const json = lines[0]?.slice(DATA_PREFIX.length, -DATA_SUFFIX.length);
  return roadmapSummarySchema.parse(JSON.parse(json ?? ""));
}

export function replaceRoadmapStatusBlock(
  source: string,
  replacement: string
): string {
  const start = source.indexOf(ROADMAP_STATUS_START);
  const end = source.indexOf(ROADMAP_STATUS_END);
  const duplicateStart = source.indexOf(ROADMAP_STATUS_START, start + 1);
  const duplicateEnd = source.indexOf(ROADMAP_STATUS_END, end + 1);

  if (
    start < 0 ||
    end < start ||
    duplicateStart >= 0 ||
    duplicateEnd >= 0
  ) {
    throw new Error("Expected exactly one roadmap status block");
  }

  const after = end + ROADMAP_STATUS_END.length;
  return `${source.slice(0, start)}${replacement.trimEnd()}${source.slice(after)}`;
}
```

- [ ] **Step 4: Run focused tests**

```bash
pnpm exec tsx --test scripts/roadmap-status-block.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit and push**

```bash
git add scripts/roadmap-status-block.ts scripts/roadmap-status-block.test.ts
git commit -S -m "feat(roadmap): render deterministic status block" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push
```

## Task 5: Add the preview/check/apply CLI

**Files:**

- Create: `scripts/roadmap-status.ts`
- Create: `scripts/roadmap-status.test.ts`

- [ ] **Step 1: Write failing CLI tests**

Test these exact outcomes with injected dependencies:

- unchanged `preview`, `check`, and `apply` return 0 and never write;
- stale `preview` prints aggregate-only old/new counts and returns 0;
- stale `check` returns 1 and writes nothing;
- stale `apply` performs one write with the injected timestamp;
- loader and writer failures return 1 through `executeRoadmapStatus`;
- error output never contains an injected private error message;
- invalid usage returns 2.

Use a fixture shaped like:

```ts
const config = {
  expectedCount: 1,
  owner: "OpenCoven",
  projectNumber: 10,
  roadmapPath: "/repo/ROADMAP.md",
};

const dependencies = {
  loadItems: async () => [{
    beadId: "coven-agents-product.1",
    blocked: "No" as const,
    status: "Todo" as const,
    wave: "1 - Now" as const,
  }],
  now: () => new Date("2026-08-25T12:00:00.000Z"),
  readFile: async () => existingRoadmap,
  stderr: (line: string) => errors.push(line),
  stdout: (line: string) => output.push(line),
  writeAtomic: async (path: string, contents: string) => {
    writes.push({ path, contents });
  },
};
```

- [ ] **Step 2: Run and verify failure**

```bash
pnpm exec tsx --test scripts/roadmap-status.test.ts
```

Expected: FAIL because the CLI module does not exist.

- [ ] **Step 3: Implement the CLI**

Create `scripts/roadmap-status.ts` with these interfaces and behavior:

```ts
#!/usr/bin/env tsx

import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRoadmapProjectItems } from "./roadmap-project-status";
import {
  extractRoadmapSummary,
  renderRoadmapStatusBlock,
  replaceRoadmapStatusBlock,
} from "./roadmap-status-block";
import {
  ROADMAP_EXPECTED_ITEM_COUNT,
  sameRoadmapSummary,
  summarizeRoadmap,
  type RoadmapProjectItem,
} from "./roadmap-status-model";

export type RoadmapStatusConfig = {
  expectedCount: number;
  owner: string;
  projectNumber: number;
  roadmapPath: string;
};

export type RoadmapStatusDependencies = {
  loadItems: (owner: string, projectNumber: number) =>
    Promise<RoadmapProjectItem[]>;
  now: () => Date;
  readFile: (path: string) => Promise<string>;
  stderr: (line: string) => void;
  stdout: (line: string) => void;
  writeAtomic: (path: string, contents: string) => Promise<void>;
};

async function writeAtomic(path: string, contents: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

const defaultDependencies: RoadmapStatusDependencies = {
  loadItems: loadRoadmapProjectItems,
  now: () => new Date(),
  readFile: (path) => readFile(path, "utf8"),
  stderr: (line) => process.stderr.write(line),
  stdout: (line) => process.stdout.write(line),
  writeAtomic,
};

export async function runRoadmapStatus(
  args: readonly string[],
  config: RoadmapStatusConfig,
  dependencies: RoadmapStatusDependencies = defaultDependencies
): Promise<number> {
  const [mode] = args;
  if (
    args.length !== 1 ||
    (mode !== "preview" && mode !== "check" && mode !== "apply")
  ) {
    dependencies.stderr(
      "Usage: pnpm roadmap:status <preview|check|apply>\n"
    );
    return 2;
  }
  if (
    !Number.isInteger(config.projectNumber) ||
    config.projectNumber <= 0 ||
    !Number.isInteger(config.expectedCount) ||
    config.expectedCount <= 0
  ) {
    dependencies.stderr("Invalid roadmap status configuration.\n");
    return 2;
  }

  const [items, source] = await Promise.all([
    dependencies.loadItems(config.owner, config.projectNumber),
    dependencies.readFile(config.roadmapPath),
  ]);
  const next = summarizeRoadmap(items, config.expectedCount);
  const current = extractRoadmapSummary(source);

  if (sameRoadmapSummary(current, next)) {
    dependencies.stdout("roadmap status: unchanged\n");
    return 0;
  }

  if (mode === "preview") {
    dependencies.stdout(
      `roadmap status: changed (${current.totalCount} -> ${next.totalCount} managed, ` +
      `${current.blockedCount} -> ${next.blockedCount} blocked)\n`
    );
    return 0;
  }

  if (mode === "check") {
    dependencies.stderr("ROADMAP.md aggregate status is stale.\n");
    return 1;
  }

  const block = renderRoadmapStatusBlock(
    next,
    dependencies.now().toISOString()
  );
  const updated = replaceRoadmapStatusBlock(source, block);
  await dependencies.writeAtomic(config.roadmapPath, updated);
  dependencies.stdout("roadmap status: updated\n");
  return 0;
}

export function formatRoadmapStatusError(error: unknown): string {
  if (error instanceof Error && error.name === "ZodError") {
    return "Roadmap Project data failed validation.";
  }
  if (error instanceof Error && error.message.startsWith("Expected ")) {
    return error.message;
  }
  return "Roadmap status update failed.";
}

export async function executeRoadmapStatus(
  args: readonly string[],
  config: RoadmapStatusConfig,
  dependencies: RoadmapStatusDependencies = defaultDependencies
): Promise<number> {
  try {
    return await runRoadmapStatus(args, config, dependencies);
  } catch (error) {
    dependencies.stderr(`${formatRoadmapStatusError(error)}\n`);
    return 1;
  }
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  executeRoadmapStatus(process.argv.slice(2), {
    expectedCount: ROADMAP_EXPECTED_ITEM_COUNT,
    owner: process.env.COVEN_PROJECT_OWNER ?? "OpenCoven",
    projectNumber: Number.parseInt(
      process.env.COVEN_PROJECT_NUMBER ?? "10",
      10
    ),
    roadmapPath: resolve(
      fileURLToPath(new URL("..", import.meta.url)),
      "ROADMAP.md"
    ),
  }).then((code) => {
    process.exitCode = code;
  });
}
```

- [ ] **Step 4: Run focused tests**

```bash
pnpm exec tsx --test scripts/roadmap-status.test.ts
```

Expected: all CLI tests pass.

- [ ] **Step 5: Commit and push**

```bash
git add scripts/roadmap-status.ts scripts/roadmap-status.test.ts
git commit -S -m "feat(roadmap): add safe status refresh cli" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push
```

## Task 6: Add the public roadmap and wire the command

**Files:**

- Create: `ROADMAP.md`
- Modify: `package.json`

- [ ] **Step 1: Add the package command**

Add beside `beads:sync`:

```json
"roadmap:status": "tsx scripts/roadmap-status.ts",
```

- [ ] **Step 2: Create the strategic roadmap spine**

Create `ROADMAP.md` with these sections and exact authority language:

````markdown
# Coven Agents Roadmap

This is the public strategic view of delivery. Private Beads/DoltHub data is
the task-level source of truth; OpenCoven Project #10 is its generated private
view. This file contains outcomes, gates, aggregate counts, and evidence links.
It does not duplicate private task descriptions or acceptance criteria.

## Current gate

Phase 0 must be green before Wave 1 advances: authoritative planning restored,
Project and issue state reconciled, no at-risk worktrees, and all five local
quality gates passing.

## Aggregate status

<!-- coven-agents-roadmap-status:v1:start -->
<!-- coven-agents-roadmap-status-data:v1 {"blockedCount":37,"byStatus":{"Done":2,"In Progress":6,"In review":2,"Todo":50},"byWave":{"0 - Delivered":{"blockedCount":0,"byStatus":{"Done":2,"In Progress":0,"In review":0,"Todo":0},"total":2},"1 - Now":{"blockedCount":0,"byStatus":{"Done":0,"In Progress":4,"In review":2,"Todo":3},"total":9},"2 - Next":{"blockedCount":7,"byStatus":{"Done":0,"In Progress":1,"In review":0,"Todo":14},"total":15},"3 - Certify":{"blockedCount":11,"byStatus":{"Done":0,"In Progress":1,"In review":0,"Todo":12},"total":13},"4 - Platform":{"blockedCount":6,"byStatus":{"Done":0,"In Progress":0,"In review":0,"Todo":7},"total":7},"5 - Product data":{"blockedCount":6,"byStatus":{"Done":0,"In Progress":0,"In review":0,"Todo":6},"total":6},"6 - Operations":{"blockedCount":7,"byStatus":{"Done":0,"In Progress":0,"In review":0,"Todo":8},"total":8}},"totalCount":60} -->

_Last refreshed: 2026-08-25T05:56:18.818Z from private Project #10._

Managed items: **60** · Blocked: **37**

| Wave | Total | Done | In Progress | In review | Todo | Blocked |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 - Delivered | 2 | 2 | 0 | 0 | 0 | 0 |
| 1 - Now | 9 | 0 | 4 | 2 | 3 | 0 |
| 2 - Next | 15 | 0 | 1 | 0 | 14 | 7 |
| 3 - Certify | 13 | 0 | 1 | 0 | 12 | 11 |
| 4 - Platform | 7 | 0 | 0 | 0 | 7 | 6 |
| 5 - Product data | 6 | 0 | 0 | 0 | 6 | 6 |
| 6 - Operations | 8 | 0 | 0 | 0 | 8 | 7 |

| Status | Count |
| --- | ---: |
| Todo | 50 |
| In Progress | 6 |
| In review | 2 |
| Done | 2 |
<!-- coven-agents-roadmap-status:v1:end -->

## Delivery sequence

### Phase 0 — Trustworthy baseline

Restore planning authority, reconcile state, preserve all work remotely, and
keep hygiene, lint, types, unit tests, and production build green.

### Wave 0 — Delivered foundations

Tenant/credential isolation and repository lifecycle controls are delivered.

### Wave 1 — Now

Clarify product authority, prevent secret leakage, document trust boundaries,
accept the demo path, and make planning/operator workflows dependable.

### Wave 2 — Next

Stabilize shared execution semantics, authorization, output safety, lifecycle
ownership, persistence, cancellation, logs, and initial observability.

### Wave 3 — Certify

Certify demo, subscriber, local, and cloud journeys with current end-to-end
evidence.

### Wave 4 — Platform

Add harness breadth, capacity controls, stronger isolation, security scanning,
bootstrap automation, and ownership controls.

### Wave 5 — Product data

Deliver consistent lifecycle state, durable history, retention, auditability,
safe archives, and generated interface documentation.

### Wave 6 — Operations

Operationalize migrations, staged releases, compatibility, health, day-two
operation, and recovery.

## Promotion rules

No phase advances with an unmet exit gate, at-risk worktree, failed required
check, unresolved P0 dependency, stale aggregate snapshot, red certification
row, or discrepancy between Beads and Project status.

## Evidence and operating documents

- [Current state](docs/roadmap/current-state.md)
- [Implementation sequence](docs/roadmap/implementation-sequence.md)
- [Delivery governance](docs/roadmap/delivery-governance.md)
- [Verification matrix](docs/roadmap/verification-matrix.md)
- [Release readiness](docs/roadmap/release-readiness.md)

## Refreshing status

Authorized maintainers run:

```bash
pnpm roadmap:status preview
pnpm roadmap:status check
pnpm roadmap:status apply
```

The command requests only Bead ID, Status, Wave, and Blocked Project fields.
````

- [ ] **Step 3: Refresh from live Project state**

Run:

```bash
pnpm roadmap:status preview
pnpm roadmap:status apply
pnpm roadmap:status check
```

Expected:

- preview reports aggregate change or unchanged;
- apply updates only the marked block;
- check reports `roadmap status: unchanged`.

- [ ] **Step 4: Run focused tests and formatting**

```bash
pnpm exec tsx --test \
  scripts/roadmap-status-model.test.ts \
  scripts/roadmap-project-status.test.ts \
  scripts/roadmap-status-block.test.ts \
  scripts/roadmap-status.test.ts
pnpm check
```

Expected: all focused tests pass and formatting reports no issues.

- [ ] **Step 5: Commit and push**

```bash
git add ROADMAP.md package.json
git commit -S -m "docs(roadmap): add strategic delivery spine" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push
```

## Task 7: Add the audited state and implementation sequence

**Files:**

- Create: `docs/roadmap/current-state.md`
- Create: `docs/roadmap/implementation-sequence.md`

- [ ] **Step 1: Write `current-state.md`**

Use the audited commit at execution time, not `65b4a1f` if `main` has advanced.
The document must contain:

1. **Snapshot metadata:** date, commit SHA, branch, Project refresh date.
2. **Implemented surfaces:** control plane, auth/account, demo, shared
   contracts/harness, local runner, cloud runner, credentials, subscriptions,
   planning automation.
3. **Validation evidence:** exact results for `pnpm hygiene`, `pnpm check`,
   `pnpm typecheck`, `pnpm test:unit`, and `pnpm build`.
4. **Planning evidence:** Beads total, Project total, status counts, blocked
   count, and idempotent sync result.
5. **Risk register** with columns:
   `Risk`, `Severity`, `Owner role`, `Blocking gate`, `Mitigation`,
   `Closure evidence`.
6. **Known gaps:** only evidence-backed gaps; do not infer private task detail.

The first risk rows must cover:

- unavailable or stale Beads workspace;
- Beads/Project/issue drift;
- work existing only on one machine;
- disabled remote checks;
- stale generated Next.js types;
- missing production-E2E certification.

- [ ] **Step 2: Write `implementation-sequence.md`**

Define three detailed lanes:

### Phase 0 lanes

- **Planning authority:** restore/pull/push Beads, sync Project twice, reconcile
  issues.
- **Repository integrity:** no at-risk worktree, signed commits, all gates.
- **Evidence baseline:** current-state snapshot and verification matrix.

### Wave 1 lanes

- **Product authority and evaluation:** product role, demo acceptance.
- **Security posture:** pre-commit secret prevention and threat model.
- **Operator/contributor workflow:** planning sync, setup, account, and console
  reliability.

### Wave 2 lanes

- **Contracts and capabilities:** versioned contracts and declared harness
  capabilities.
- **Execution safety:** subscriber authorization, output redaction, network
  policy.
- **Runner lifecycle:** sandbox/process ownership, streaming, cancellation.
- **Durability:** run journal and shared persisted records.
- **Explainability:** structured logs and initial observability.

For every lane include:

- entry conditions;
- public outcome;
- allowed Bead IDs;
- owner role (`BunsDev`, `Copilot`, or `Joint`);
- required predecessor lanes;
- review checkpoint;
- exit evidence;
- rollback/recovery expectation.

Add outcome-only sections for Certify, Platform, Product data, and Operations.

- [ ] **Step 3: Check for private text and broken links**

Run:

```bash
rg -n 'acceptance_criteria|Private acceptance|Authorization:|/Users/|ghp_|github_pat_' \
  ROADMAP.md docs/roadmap
```

Expected: no matches.

Run:

```bash
for file in ROADMAP.md docs/roadmap/*.md; do
  test -s "$file"
done
```

Expected: all files exist and are non-empty.

- [ ] **Step 4: Commit and push**

```bash
git add docs/roadmap/current-state.md docs/roadmap/implementation-sequence.md
git commit -S -m "docs(roadmap): record state and execution sequence" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push
```

## Task 8: Add governance, verification, and release documents

**Files:**

- Create: `docs/roadmap/delivery-governance.md`
- Create: `docs/roadmap/verification-matrix.md`
- Create: `docs/roadmap/release-readiness.md`
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Write delivery governance**

`docs/roadmap/delivery-governance.md` must state:

- Beads is task authority; Project is generated; ROADMAP is aggregate/outcome
  communication; issues/PRs are delivery artifacts.
- One task uses one `<type>/<short-slug>` branch and one worktree.
- Work is pushed before idle.
- A merge is followed by Beads, Project, and issue reconciliation.
- Roadmap refresh triggers are material Beads changes, roadmap PRs, wave
  promotion, release review, and restored CI.
- Specs/plans are historical and receive correction notes rather than silent
  rewrites.
- Promotion and demotion use the gates from `ROADMAP.md`.
- Actions remain disabled until a separate approved decision changes that.

- [ ] **Step 2: Write the verification matrix**

`docs/roadmap/verification-matrix.md` must use these states:

- `Not implemented`
- `Implemented`
- `Verified`
- `Certified`
- `Blocked`

Create rows for:

- recorded demo load and playback;
- subscriber sign-in and eligibility;
- tenant credential store and redaction;
- cloud agent create/run/delete;
- local agent create/run/cancel/delete;
- shared contract conformance;
- persisted run recovery;
- browser failure/accessibility behavior;
- deployment preflight;
- production smoke and rollback.

Columns:

`Capability`, `Path`, `State`, `Environment`, `Commit`, `Procedure`,
`Artifact/link`, `Verified at`, `Owner role`, `Blocking gap`.

Do not mark a row Certified without dated end-to-end evidence.

- [ ] **Step 3: Write release readiness**

`docs/roadmap/release-readiness.md` must include:

- required environment variables by app, worker, and local runner;
- database migration preflight;
- Beads/Project reconciliation;
- all five repository gates;
- demo, subscriber, local, and cloud smoke procedures;
- Stripe webhook delivery check;
- credential and identity isolation check;
- observability and diagnostics evidence;
- rollback triggers and responsible role;
- data recovery expectations;
- go/no-go sign-off table.

An unresolved P0, red required verification row, stale roadmap snapshot, or
at-risk worktree is an automatic no-go.

- [ ] **Step 4: Add documentation entry points**

In `README.md`, add a `## Roadmap and delivery` section immediately before
`## Verify`:

````markdown
## Roadmap and delivery

Start with [`ROADMAP.md`](ROADMAP.md) for public outcomes, current waves, and
promotion gates. Detailed current-state, execution, governance, verification,
and release evidence lives under [`docs/roadmap/`](docs/roadmap/).

Private Beads/DoltHub data remains the task-level source of truth. Authorized
maintainers can verify the aggregate snapshot with:

```bash
pnpm roadmap:status check
```
````

In `CLAUDE.md`, add before the Next.js generated block:

````markdown
## Planning authority

Private Beads/DoltHub data is the task-level source of truth. Project #10 is
its generated private view. `ROADMAP.md` contains public outcomes and aggregate
status only.

After merged work changes roadmap status:

```bash
pnpm beads:sync preview
pnpm beads:sync apply
pnpm roadmap:status apply
pnpm roadmap:status check
```

Never copy private Beads descriptions or acceptance criteria into git.
````

- [ ] **Step 5: Run documentation checks**

```bash
pnpm check
git diff --check
rg -n 'TBD|TODO|FIXME|implement later|fill in' \
  ROADMAP.md docs/roadmap README.md CLAUDE.md
```

Expected: lint and diff checks pass; placeholder search has no matches except
the legitimate Project status word `Todo` inside the generated aggregate.

- [ ] **Step 6: Commit and push**

```bash
git add \
  docs/roadmap/delivery-governance.md \
  docs/roadmap/verification-matrix.md \
  docs/roadmap/release-readiness.md \
  README.md \
  CLAUDE.md
git commit -S -m "docs(roadmap): add delivery evidence and governance" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push
```

## Task 9: Verify the complete roadmap system

**Files:**

- Modify only files changed by formatting or corrections found in this task.

- [ ] **Step 1: Prove the safe query against live Project #10**

Run:

```bash
pnpm roadmap:status preview
pnpm roadmap:status check
```

Expected: both commands print aggregate-only output and exit 0.

Capture the command output in the PR verification notes, not in a new committed
artifact.

- [ ] **Step 2: Prove deterministic apply**

Run:

```bash
before="$(git hash-object ROADMAP.md)"
pnpm roadmap:status apply
after_first="$(git hash-object ROADMAP.md)"
pnpm roadmap:status apply
after_second="$(git hash-object ROADMAP.md)"
test "$after_first" = "$after_second"
printf 'before=%s\nafter_first=%s\nafter_second=%s\n' \
  "$before" "$after_first" "$after_second"
```

Expected: the second and third hashes match. If the first differs because
Project state changed, stage the refreshed aggregate.

- [ ] **Step 3: Run all focused script tests**

```bash
pnpm exec tsx --test \
  scripts/roadmap-status-model.test.ts \
  scripts/roadmap-project-status.test.ts \
  scripts/roadmap-status-block.test.ts \
  scripts/roadmap-status.test.ts
```

Expected: all roadmap tests pass.

- [ ] **Step 4: Run the repository gate set**

Run in this order:

```bash
pnpm check
pnpm typecheck
pnpm test:unit
pnpm build
```

Expected: all commands pass.

If typecheck references removed routes under `.next/dev/types`, confirm no
`next dev` process is running, remove only `.next/dev`, and rerun:

```bash
node -e 'require("node:fs").rmSync(require("node:path").resolve(".next/dev"), { recursive: true, force: true })'
pnpm typecheck
pnpm build
```

- [ ] **Step 5: Run privacy and placeholder scans**

```bash
rg -n 'acceptance_criteria|Private acceptance|Authorization:|BEGIN (RSA|OPENSSH) PRIVATE KEY|ghp_|github_pat_|/Users/' \
  ROADMAP.md docs/roadmap scripts/roadmap-*.ts

rg -n 'TBD|FIXME|implement later|fill in details|similar to Task' \
  ROADMAP.md docs/roadmap scripts/roadmap-*.ts
```

Expected: no matches.

- [ ] **Step 6: Commit any final generated or formatting correction**

If Task 9 changed tracked files:

```bash
git add ROADMAP.md docs/roadmap scripts package.json README.md CLAUDE.md
git commit -S -m "chore(roadmap): finalize verified status" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push
```

If there are no tracked changes, do not create an empty commit.

- [ ] **Step 7: Verify signatures, remote preservation, and hygiene**

```bash
git log origin/main..HEAD --pretty='%h %G? %s'
git status --short --branch
git push
pnpm hygiene
```

Expected:

- every new commit reports `G`;
- the branch tracks `origin/docs/repository-roadmap`;
- the worktree is clean;
- hygiene reports no `AT RISK` worktrees.

- [ ] **Step 8: Prepare the pull request**

Use:

```bash
gh pr create \
  --base main \
  --head docs/repository-roadmap \
  --title "docs: add repository roadmap and delivery governance" \
  --body "$(cat <<'EOF'
## What changed

- added the public roadmap and Phase 0/Now/Next delivery sequence
- added safe aggregate Project status preview/check/apply tooling
- added current-state, governance, verification, and release-readiness docs

## Why

The private Beads roadmap remains authoritative, but maintainers and
stakeholders need a public, evidence-backed view that cannot expose private task
content.

## Verification

- pnpm hygiene
- pnpm check
- pnpm typecheck
- pnpm test:unit
- pnpm build
- pnpm roadmap:status check
- deterministic second roadmap apply
EOF
)"
```

Expected: the PR opens against `main` from `docs/repository-roadmap`.
