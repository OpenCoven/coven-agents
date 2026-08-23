# Beads Project Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a private, durable Beads roadmap for `coven-agents` and an idempotent one-way synchronization into private OpenCoven Project #10.

**Architecture:** A private DoltHub-backed Beads database is authoritative. Public TypeScript tooling reads Beads JSON, rejects unsafe content, computes a deterministic reconciliation plan, and uses the `gh project` CLI to upsert private draft items without committing roadmap data. A scheduled/manual workflow runs only from protected `main`.

**Tech Stack:** TypeScript, `tsx`, `node:test`, Zod, Beads CLI 1.2.2, Dolt/DoltHub, GitHub CLI, GitHub Projects v2, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-23-beads-project-board-design.md`

---

## Scope Boundary

This plan implements one planning system. The 60-record private roadmap is data
loaded through that system, not a second application. Exact bead descriptions
and acceptance criteria are created in a private, untracked seed file during
Task 8; only the public-safe taxonomy and coverage requirements appear here.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/beads-project-model.ts` | Parse and validate Beads JSON and Project CLI JSON into strict internal types. |
| `scripts/beads-project-model.test.ts` | Source parsing, metadata, status, and malformed-input tests. |
| `scripts/beads-project-policy.ts` | Fail-closed privacy checks and Project draft rendering. |
| `scripts/beads-project-policy.test.ts` | Secret, path, size, and safe-rendering tests. |
| `scripts/beads-project-reconcile.ts` | Pure duplicate detection and create/update/no-op planning. |
| `scripts/beads-project-reconcile.test.ts` | Reconciliation, idempotency, blocked-state, and orphan tests. |
| `scripts/beads-project-io.ts` | All `bd` and `gh` subprocess calls plus Project mutation execution. |
| `scripts/beads-project-io.test.ts` | Command construction and fail-closed subprocess tests. |
| `scripts/beads-project-sync.ts` | `preview` / `apply` CLI and aggregate-only output. |
| `scripts/beads-project-sync.test.ts` | CLI behavior with injected adapters. |
| `scripts/beads-roadmap-seed.ts` | Validate a private seed JSON file and create beads/dependencies idempotently. |
| `scripts/beads-roadmap-seed.test.ts` | Seed schema, count, hierarchy, and cycle-prevention tests. |
| `.github/workflows/beads-project-sync.yml` | Pinned scheduled/manual sync from the private DoltHub remote. |
| `docs/beads-project-sync.md` | Operator setup, credentials, recovery, privacy, and verification. |
| `.gitignore` | Prevent local Beads databases and private seed files from being tracked. |
| `package.json` | Add `beads:sync` and `beads:seed` commands. |

The pure model, policy, and reconciliation modules must not spawn processes or
read environment variables. The I/O module is the only subprocess boundary.

---

### Task 1: Parse and validate Beads data

**Files:**
- Create: `scripts/beads-project-model.ts`
- Test: `scripts/beads-project-model.test.ts`

- [ ] **Step 1: Write the failing model tests**

Create `scripts/beads-project-model.test.ts` with tests that use this fixture:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseBeadsJson,
  parseProjectJson,
  type Bead,
} from "./beads-project-model";

const beadJson = JSON.stringify([
  {
    id: "coven-agents-security.1",
    title: "Add staged secret scanning",
    description: "Reject recognized credentials before commit.",
    acceptance_criteria: "A staged fixture containing a token is blocked.",
    status: "open",
    priority: 0,
    issue_type: "task",
    metadata: {
      projectStatus: "Todo",
      runner: "Shared",
      size: "S",
      workstream: "Security & privacy",
    },
    dependencies: [
      {
        issue_id: "coven-agents-security.1",
        depends_on_id: "coven-agents-security",
        type: "parent-child",
      },
    ],
    parent: "coven-agents-security",
  },
]);

test("parses supported Beads JSON", () => {
  const beads = parseBeadsJson(beadJson);

  assert.equal(beads.length, 1);
  assert.equal(beads[0]?.id, "coven-agents-security.1");
  assert.equal(beads[0]?.metadata.size, "S");
  assert.equal(beads[0]?.parent, "coven-agents-security");
});

test("rejects priorities not represented on the board", () => {
  const raw = JSON.parse(beadJson) as Array<Record<string, unknown>>;
  raw[0]!.priority = 4;

  assert.throws(() => parseBeadsJson(JSON.stringify(raw)), /priority/i);
});

test("rejects unsupported issue types and metadata", () => {
  const raw = JSON.parse(beadJson) as Array<Record<string, unknown>>;
  raw[0]!.issue_type = "decision";

  assert.throws(() => parseBeadsJson(JSON.stringify(raw)), /issue_type/i);
});

test("parses draft Project items and fields case-insensitively", () => {
  const project = parseProjectJson(
    JSON.stringify({
      items: [
        {
          "bead ID": "coven-agents-security.1",
          blocked: "No",
          content: {
            body: "<!-- coven-agents-bead-sync:v1 id=coven-agents-security.1 -->",
            title: "Add staged secret scanning",
            type: "DraftIssue",
          },
          id: "PVTI_item",
          priority: "P0",
          runner: "Shared",
          size: "S",
          status: "Todo",
          type: "task",
          workstream: "Security & privacy",
        },
      ],
      totalCount: 1,
    })
  );

  assert.equal(project[0]?.fields["Bead ID"], "coven-agents-security.1");
  assert.equal(project[0]?.content.type, "DraftIssue");
});

test("exports a strict Bead type", () => {
  const bead: Bead = parseBeadsJson(beadJson)[0]!;
  assert.equal(bead.status, "open");
});
```

- [ ] **Step 2: Run the tests and verify the expected failure**

Run:

```bash
pnpm exec tsx --test scripts/beads-project-model.test.ts
```

Expected: FAIL because `scripts/beads-project-model.ts` does not exist.

- [ ] **Step 3: Implement strict source models**

Create `scripts/beads-project-model.ts` with:

```ts
import { z } from "zod";

export const RUNNERS = [
  "Cloud",
  "Local",
  "Control plane",
  "Shared",
] as const;
export const SIZES = ["XS", "S", "M", "L", "XL"] as const;
export const WORKSTREAMS = [
  "Product",
  "Contracts & harnesses",
  "Cloud runner",
  "Local runner",
  "Data lifecycle",
  "Security & privacy",
  "Observability",
  "Testing & reliability",
  "Releases & docs",
  "Developer experience",
] as const;
export const PROJECT_STATUSES = [
  "Todo",
  "In Progress",
  "In review",
  "Done",
] as const;
export const BEAD_TYPES = ["epic", "feature", "task", "bug"] as const;
export const BEAD_STATUSES = [
  "open",
  "in_progress",
  "blocked",
  "deferred",
  "closed",
] as const;

const dependencySchema = z.object({
  issue_id: z.string().min(1),
  depends_on_id: z.string().min(1),
  type: z.string().min(1),
});

const beadSchema = z.object({
  acceptance_criteria: z.string().min(1),
  dependencies: z.array(dependencySchema).default([]),
  description: z.string().min(1),
  id: z.string().regex(/^coven-agents-[a-z0-9.-]+$/),
  issue_type: z.enum(BEAD_TYPES),
  metadata: z.object({
    projectStatus: z.enum(PROJECT_STATUSES).optional(),
    runner: z.enum(RUNNERS),
    size: z.enum(SIZES),
    workstream: z.enum(WORKSTREAMS),
  }),
  parent: z.string().optional(),
  priority: z.number().int().min(0).max(2),
  status: z.enum(BEAD_STATUSES),
  title: z.string().min(1),
});

export type Bead = z.infer<typeof beadSchema>;

export type ProjectItem = {
  content: { body: string; title: string; type: string };
  fields: Record<string, string>;
  id: string;
};

export function parseBeadsJson(input: string): Bead[] {
  return z.array(beadSchema).parse(JSON.parse(input));
}

function canonicalFieldName(name: string): string {
  const normalized = name.toLowerCase();
  const names = [
    "Bead ID",
    "Blocked",
    "Priority",
    "Runner",
    "Size",
    "Status",
    "Type",
    "Workstream",
  ];
  return names.find((candidate) => candidate.toLowerCase() === normalized) ?? name;
}

export function parseProjectJson(input: string): ProjectItem[] {
  const raw = z
    .object({
      items: z.array(z.record(z.string(), z.unknown())),
      totalCount: z.number(),
    })
    .parse(JSON.parse(input));

  return raw.items.map((item) => {
    const content = z
      .object({
        body: z.string().default(""),
        title: z.string(),
        type: z.string(),
      })
      .parse(item.content);
    const id = z.string().parse(item.id);
    const fields: Record<string, string> = {};

    for (const [key, value] of Object.entries(item)) {
      if (key !== "content" && key !== "id" && typeof value === "string") {
        fields[canonicalFieldName(key)] = value;
      }
    }

    return { content, fields, id };
  });
}
```

- [ ] **Step 4: Run model tests**

Run:

```bash
pnpm exec tsx --test scripts/beads-project-model.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/beads-project-model.ts scripts/beads-project-model.test.ts
git commit -S -m "feat(planning): validate beads project inputs" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Enforce the privacy projection

**Files:**
- Create: `scripts/beads-project-policy.ts`
- Test: `scripts/beads-project-policy.test.ts`

- [ ] **Step 1: Write failing privacy-policy tests**

Create `scripts/beads-project-policy.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { Bead } from "./beads-project-model";
import {
  projectBead,
  validateSafeText,
} from "./beads-project-policy";

function bead(overrides: Partial<Bead> = {}): Bead {
  return {
    acceptance_criteria: "The public-safe fixture passes.",
    dependencies: [],
    description: "Add a bounded, testable control.",
    id: "coven-agents-security.1",
    issue_type: "task",
    metadata: {
      runner: "Shared",
      size: "S",
      workstream: "Security & privacy",
    },
    priority: 0,
    status: "open",
    title: "Add staged secret scanning",
    ...overrides,
  };
}

test("rejects common token and credential forms", () => {
  for (const unsafe of [
    "github_pat_1234567890abcdefghijklmnopqrstuvwxyz",
    "Authorization: Bearer abcdefghijklmnop",
    "API_TOKEN=super-secret-value",
    "-----BEGIN PRIVATE KEY-----",
  ]) {
    assert.throws(() => validateSafeText("description", unsafe), /unsafe/i);
  }
});

test("rejects local absolute paths and oversized text", () => {
  assert.throws(
    () => validateSafeText("description", "/Users/alice/private/file.txt"),
    /absolute path/i
  );
  assert.throws(
    () => validateSafeText("title", "x".repeat(121)),
    /120/
  );
});

test("renders a deterministic draft item", () => {
  const projected = projectBead(
    bead({
      dependencies: [
        {
          depends_on_id: "coven-agents-security",
          issue_id: "coven-agents-security.1",
          type: "parent-child",
        },
      ],
      parent: "coven-agents-security",
    }),
    new Map()
  );

  assert.equal(projected.fields["Bead ID"], "coven-agents-security.1");
  assert.equal(projected.fields.Blocked, "No");
  assert.match(projected.body, /coven-agents-bead-sync:v1/);
  assert.match(projected.body, /Parent: `coven-agents-security`/);
});

test("marks active blocking dependencies without treating parent links as blockers", () => {
  const source = bead({
    dependencies: [
      {
        depends_on_id: "coven-agents-contracts.1",
        issue_id: "coven-agents-security.1",
        type: "blocks",
      },
      {
        depends_on_id: "coven-agents-security",
        issue_id: "coven-agents-security.1",
        type: "parent-child",
      },
    ],
  });
  const all = new Map<string, Bead>([
    [source.id, source],
    [
      "coven-agents-contracts.1",
      bead({
        id: "coven-agents-contracts.1",
        status: "open",
      }),
    ],
  ]);

  assert.equal(projectBead(source, all).fields.Blocked, "Yes");
});
```

- [ ] **Step 2: Run the tests and verify the expected failure**

Run:

```bash
pnpm exec tsx --test scripts/beads-project-policy.test.ts
```

Expected: FAIL because the policy module does not exist.

- [ ] **Step 3: Implement fail-closed validation and rendering**

Create `scripts/beads-project-policy.ts`:

```ts
import type { Bead } from "./beads-project-model";

export const MARKER_PREFIX = "<!-- coven-agents-bead-sync:v1 id=";

export type DesiredProjectItem = {
  beadId: string;
  body: string;
  fields: Record<string, string>;
  title: string;
};

const MAX_LENGTHS: Record<string, number> = {
  acceptance: 3000,
  description: 2000,
  title: 120,
};

const UNSAFE_PATTERNS = [
  { label: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/i },
  { label: "authorization header", pattern: /authorization:\s*bearer\s+\S+/i },
  { label: "GitHub token", pattern: /\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}\b/ },
  { label: "provider token", pattern: /\b(?:sk-|xox[baprs]-)[A-Za-z0-9_-]{16,}\b/ },
  {
    label: "environment assignment",
    pattern: /(?:^|\n)\s*[A-Z][A-Z0-9_]{1,63}\s*=\s*\S+/,
  },
];

const ABSOLUTE_PATH = /(?:^|[\s`"'(])(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)/;

export function validateSafeText(
  field: keyof typeof MAX_LENGTHS,
  value: string
): void {
  const limit = MAX_LENGTHS[field];
  if (value.length > limit) {
    throw new Error(`${field} exceeds ${limit} characters`);
  }
  if (ABSOLUTE_PATH.test(value)) {
    throw new Error(`${field} contains an unsafe absolute path`);
  }
  for (const candidate of UNSAFE_PATTERNS) {
    if (candidate.pattern.test(value)) {
      throw new Error(`${field} contains unsafe ${candidate.label} content`);
    }
  }
}

function projectStatus(bead: Bead): string {
  if (bead.status === "closed") {
    return "Done";
  }
  if (bead.metadata.projectStatus === "In review") {
    return "In review";
  }
  return bead.status === "in_progress" ? "In Progress" : "Todo";
}

function activeBlockers(bead: Bead, all: Map<string, Bead>): string[] {
  return bead.dependencies
    .filter((dependency) => dependency.type === "blocks")
    .filter((dependency) => all.get(dependency.depends_on_id)?.status !== "closed")
    .map((dependency) => dependency.depends_on_id)
    .sort();
}

export function projectBead(
  bead: Bead,
  all: Map<string, Bead>
): DesiredProjectItem {
  validateSafeText("title", bead.title);
  validateSafeText("description", bead.description);
  validateSafeText("acceptance", bead.acceptance_criteria);

  const blockers = activeBlockers(bead, all);
  const parent = bead.parent ? `\`${bead.parent}\`` : "None";
  const dependencies = blockers.length
    ? blockers.map((id) => `\`${id}\``).join(", ")
    : "None";
  const body = [
    `${MARKER_PREFIX}${bead.id} -->`,
    "",
    "## Objective",
    "",
    bead.description,
    "",
    "## Acceptance criteria",
    "",
    bead.acceptance_criteria,
    "",
    "## Tracking",
    "",
    `- Bead: \`${bead.id}\``,
    `- Parent: ${parent}`,
    `- Active dependencies: ${dependencies}`,
  ].join("\n");

  return {
    beadId: bead.id,
    body,
    fields: {
      "Bead ID": bead.id,
      Blocked: bead.status === "blocked" || blockers.length > 0 ? "Yes" : "No",
      Priority: `P${bead.priority}`,
      Runner: bead.metadata.runner,
      Size: bead.metadata.size,
      Status: projectStatus(bead),
      Type: bead.issue_type,
      Workstream: bead.metadata.workstream,
    },
    title: bead.title,
  };
}
```

- [ ] **Step 4: Run policy tests**

Run:

```bash
pnpm exec tsx --test scripts/beads-project-policy.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/beads-project-policy.ts scripts/beads-project-policy.test.ts
git commit -S -m "feat(planning): enforce private roadmap projection" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Build the deterministic reconciliation planner

**Files:**
- Create: `scripts/beads-project-reconcile.ts`
- Test: `scripts/beads-project-reconcile.test.ts`

- [ ] **Step 1: Write failing reconciliation tests**

Create `scripts/beads-project-reconcile.test.ts` with these cases:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectItem } from "./beads-project-model";
import type { DesiredProjectItem } from "./beads-project-policy";
import {
  parseManagedBeadId,
  planReconciliation,
} from "./beads-project-reconcile";

const desired: DesiredProjectItem = {
  beadId: "coven-agents-security.1",
  body: "<!-- coven-agents-bead-sync:v1 id=coven-agents-security.1 -->\nBody",
  fields: {
    "Bead ID": "coven-agents-security.1",
    Blocked: "No",
    Priority: "P0",
    Runner: "Shared",
    Size: "S",
    Status: "Todo",
    Type: "task",
    Workstream: "Security & privacy",
  },
  title: "Add staged secret scanning",
};

function existing(overrides: Partial<ProjectItem> = {}): ProjectItem {
  return {
    content: {
      body: desired.body,
      title: desired.title,
      type: "DraftIssue",
    },
    fields: { ...desired.fields },
    id: "PVTI_item",
    ...overrides,
  };
}

test("creates an item when the marker is absent", () => {
  const plan = planReconciliation([desired], []);
  assert.deepEqual(plan.actions.map((action) => action.kind), ["create"]);
});

test("produces a no-op for an identical managed item", () => {
  const plan = planReconciliation([desired], [existing()]);
  assert.equal(plan.actions.length, 0);
  assert.equal(plan.unchanged, 1);
});

test("updates only changed content and fields", () => {
  const item = existing({
    content: { body: "old", title: "old", type: "DraftIssue" },
    fields: { ...desired.fields, Priority: "P2" },
  });
  const plan = planReconciliation([desired], [item]);
  const update = plan.actions[0];

  assert.equal(update?.kind, "update");
  if (update?.kind === "update") {
    assert.deepEqual(update.changedFields, ["Priority"]);
    assert.equal(update.contentChanged, true);
  }
});

test("rejects duplicate managed markers", () => {
  assert.throws(
    () => planReconciliation([desired], [existing(), existing({ id: "other" })]),
    /duplicate/i
  );
});

test("leaves unrelated and orphaned items untouched", () => {
  const orphan = existing({
    content: {
      body: "<!-- coven-agents-bead-sync:v1 id=coven-agents-old.1 -->",
      title: "Old",
      type: "DraftIssue",
    },
  });
  const unrelated = existing({
    content: { body: "Human-authored note", title: "Note", type: "DraftIssue" },
    id: "human",
  });
  const plan = planReconciliation([desired], [orphan, unrelated]);

  assert.deepEqual(plan.orphaned, ["coven-agents-old.1"]);
  assert.equal(plan.unmanaged, 1);
});

test("parses only a complete versioned marker", () => {
  assert.equal(parseManagedBeadId(desired.body), desired.beadId);
  assert.equal(parseManagedBeadId("coven-agents-security.1"), null);
});
```

- [ ] **Step 2: Run the tests and verify the expected failure**

Run:

```bash
pnpm exec tsx --test scripts/beads-project-reconcile.test.ts
```

Expected: FAIL because the reconciliation module does not exist.

- [ ] **Step 3: Implement reconciliation**

Create `scripts/beads-project-reconcile.ts`:

```ts
import type { ProjectItem } from "./beads-project-model";
import {
  MARKER_PREFIX,
  type DesiredProjectItem,
} from "./beads-project-policy";

export type ReconciliationAction =
  | { desired: DesiredProjectItem; kind: "create" }
  | {
      changedFields: string[];
      contentChanged: boolean;
      desired: DesiredProjectItem;
      itemId: string;
      kind: "update";
    };

export type ReconciliationPlan = {
  actions: ReconciliationAction[];
  orphaned: string[];
  unchanged: number;
  unmanaged: number;
};

const MARKER = /<!-- coven-agents-bead-sync:v1 id=(coven-agents-[a-z0-9.-]+) -->/;

export function parseManagedBeadId(body: string): string | null {
  if (!body.includes(MARKER_PREFIX)) {
    return null;
  }
  return body.match(MARKER)?.[1] ?? null;
}

export function planReconciliation(
  desiredItems: DesiredProjectItem[],
  existingItems: ProjectItem[]
): ReconciliationPlan {
  const desiredById = new Map(
    desiredItems.map((item) => [item.beadId, item] as const)
  );
  const managed = new Map<string, ProjectItem>();
  let unmanaged = 0;

  for (const item of existingItems) {
    const beadId = parseManagedBeadId(item.content.body);
    if (beadId === null) {
      unmanaged += 1;
      continue;
    }
    if (managed.has(beadId)) {
      throw new Error(`duplicate managed marker for ${beadId}`);
    }
    managed.set(beadId, item);
  }

  const actions: ReconciliationAction[] = [];
  let unchanged = 0;

  for (const desired of desiredItems) {
    const existing = managed.get(desired.beadId);
    if (!existing) {
      actions.push({ desired, kind: "create" });
      continue;
    }

    const contentChanged =
      existing.content.title !== desired.title ||
      existing.content.body !== desired.body;
    const changedFields = Object.entries(desired.fields)
      .filter(([name, value]) => existing.fields[name] !== value)
      .map(([name]) => name)
      .sort();

    if (!contentChanged && changedFields.length === 0) {
      unchanged += 1;
      continue;
    }

    actions.push({
      changedFields,
      contentChanged,
      desired,
      itemId: existing.id,
      kind: "update",
    });
  }

  return {
    actions,
    orphaned: [...managed.keys()]
      .filter((id) => !desiredById.has(id))
      .sort(),
    unchanged,
    unmanaged,
  };
}
```

- [ ] **Step 4: Run reconciliation tests**

Run:

```bash
pnpm exec tsx --test scripts/beads-project-reconcile.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/beads-project-reconcile.ts scripts/beads-project-reconcile.test.ts
git commit -S -m "feat(planning): plan idempotent project reconciliation" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Add the Beads and GitHub command boundary

**Files:**
- Create: `scripts/beads-project-io.ts`
- Test: `scripts/beads-project-io.test.ts`

- [ ] **Step 1: Write failing command-boundary tests**

Create tests around an injected command runner. Assert these exact calls:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyReconciliation,
  loadDependencyCycles,
  loadBeads,
  loadProject,
  runCommand,
  validateProjectSchema,
  type CommandRunner,
} from "./beads-project-io";
import type { ReconciliationPlan } from "./beads-project-reconcile";

test("loads every bead in read-only mode", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    return "[]";
  };

  await loadBeads("/private/workspace", run);

  assert.deepEqual(calls, [
    {
      command: "bd",
      args: [
        "-C",
        "/private/workspace",
        "--readonly",
        "list",
        "--all",
        "--limit",
        "0",
        "--json",
      ],
    },
  ]);
});

test("loads dependency cycles without mutating Beads", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    return "[]";
  };

  assert.deepEqual(await loadDependencyCycles("/private/workspace", run), []);
  assert.deepEqual(calls[0]?.args, [
    "-C",
    "/private/workspace",
    "--readonly",
    "dep",
    "cycles",
    "--json",
  ]);
});

test("loads all managed Project fields", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    if (args[1] === "view") {
      return JSON.stringify({ id: "PVT_project" });
    }
    if (args[1] === "field-list") {
      return JSON.stringify({
        fields: [
          {
            id: "PVTSSF_status",
            name: "Status",
            options: [{ id: "todo", name: "Todo" }],
            type: "ProjectV2SingleSelectField",
          },
        ],
        totalCount: 1,
      });
    }
    return JSON.stringify({ items: [], totalCount: 0 });
  };

  const project = await loadProject("OpenCoven", 10, run);

  assert.equal(calls.length, 3);
  assert.equal(project.projectId, "PVT_project");
  assert.equal(project.fields.Status?.options.Todo, "todo");
  assert.deepEqual(calls[2]?.args.slice(0, 6), [
    "project",
    "item-list",
    "10",
    "--owner",
    "OpenCoven",
    "--limit",
  ]);
  assert.ok(calls[2]?.args.includes("Workstream"));
});

test("creates a draft before setting its fields", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    if (args[1] === "item-create") {
      return JSON.stringify({ id: "PVTI_new" });
    }
    return "{}";
  };
  const plan: ReconciliationPlan = {
    actions: [
      {
        desired: {
          beadId: "coven-agents-security.1",
          body: "safe",
          fields: { Status: "Todo" },
          title: "Safe title",
        },
        kind: "create",
      },
    ],
    orphaned: [],
    unchanged: 0,
    unmanaged: 0,
  };
  const project = {
    fields: {
      Status: {
        id: "PVTSSF_status",
        options: { Todo: "todo" },
        type: "ProjectV2SingleSelectField",
      },
    },
    items: [],
    projectId: "PVT_project",
  };

  await applyReconciliation(plan, project, "OpenCoven", 10, run);

  assert.equal(calls[0]?.args[1], "item-create");
  assert.equal(calls[1]?.args[1], "item-edit");
  assert.ok(calls[1]?.args.includes("--field-id"));
  assert.ok(calls[1]?.args.includes("PVTSSF_status"));
  assert.ok(calls[1]?.args.includes("--single-select-option-id"));
  assert.ok(calls[1]?.args.includes("todo"));
});

test("rejects missing fields and mismatched select options", () => {
  assert.throws(
    () =>
      validateProjectSchema({
        fields: {},
        items: [],
        projectId: "PVT_project",
      }),
    /Bead ID/
  );
});

test("propagates subprocess failures", async () => {
  const run: CommandRunner = async () => {
    throw new Error("authentication failed");
  };

  await assert.rejects(() => loadProject("OpenCoven", 10, run), /authentication/);
});

test("the default runner does not echo command arguments on failure", async () => {
  await assert.rejects(
    () =>
      runCommand("false", [
        "private acceptance text",
        "github_pat_1234567890abcdefghijklmnopqrstuvwxyz",
      ]),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.doesNotMatch(message, /private acceptance text/);
      assert.doesNotMatch(message, /github_pat_/);
      return true;
    }
  );
});
```

- [ ] **Step 2: Run the tests and verify the expected failure**

Run:

```bash
pnpm exec tsx --test scripts/beads-project-io.test.ts
```

Expected: FAIL because the I/O module does not exist.

- [ ] **Step 3: Implement the subprocess boundary**

Create `scripts/beads-project-io.ts` with an `execFile`-based default runner,
`maxBuffer: 20 * 1024 * 1024`, and these exports:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseBeadsJson, parseProjectJson } from "./beads-project-model";
import type {
  ReconciliationAction,
  ReconciliationPlan,
} from "./beads-project-reconcile";

const exec = promisify(execFile);

export type CommandRunner = (
  command: string,
  args: string[]
) => Promise<string>;

export type ProjectField = {
  id: string;
  options: Record<string, string>;
  type: "ProjectV2Field" | "ProjectV2SingleSelectField";
};

export type ProjectSnapshot = {
  fields: Record<string, ProjectField>;
  items: ReturnType<typeof parseProjectJson>;
  projectId: string;
};

export const runCommand: CommandRunner = async (command, args) => {
  try {
    const { stdout } = await exec(command, args, {
      maxBuffer: 20 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "unknown";
    throw new Error(`${command} failed with exit code ${code}`);
  }
};

const FIELD_NAMES = [
  "Bead ID",
  "Blocked",
  "Priority",
  "Runner",
  "Size",
  "Status",
  "Type",
  "Workstream",
] as const;

const EXPECTED_FIELDS: Record<string, string[] | null> = {
  "Bead ID": null,
  Blocked: ["No", "Yes"],
  Priority: ["P0", "P1", "P2"],
  Runner: ["Cloud", "Control plane", "Local", "Shared"],
  Size: ["L", "M", "S", "XL", "XS"],
  Status: ["Done", "In Progress", "In review", "Todo"],
  Type: ["bug", "epic", "feature", "task"],
  Workstream: [
    "Cloud runner",
    "Contracts & harnesses",
    "Data lifecycle",
    "Developer experience",
    "Local runner",
    "Observability",
    "Product",
    "Releases & docs",
    "Security & privacy",
    "Testing & reliability",
  ],
};

export function validateProjectSchema(project: ProjectSnapshot): void {
  for (const [name, expectedOptions] of Object.entries(EXPECTED_FIELDS)) {
    const field = project.fields[name];
    if (!field) {
      throw new Error(`missing Project field: ${name}`);
    }
    if (expectedOptions === null) {
      if (field.type !== "ProjectV2Field") {
        throw new Error(`Project field ${name} must be text`);
      }
      continue;
    }
    if (field.type !== "ProjectV2SingleSelectField") {
      throw new Error(`Project field ${name} must be single-select`);
    }
    const actual = Object.keys(field.options).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expectedOptions)) {
      throw new Error(`Project field ${name} has incorrect options`);
    }
  }
}

export async function loadBeads(directory: string, run = runCommand) {
  const output = await run("bd", [
    "-C",
    directory,
    "--readonly",
    "list",
    "--all",
    "--limit",
    "0",
    "--json",
  ]);
  return parseBeadsJson(output);
}

export async function loadDependencyCycles(
  directory: string,
  run = runCommand
): Promise<unknown[]> {
  const output = await run("bd", [
    "-C",
    directory,
    "--readonly",
    "dep",
    "cycles",
    "--json",
  ]);
  return JSON.parse(output) as unknown[];
}

export async function loadProject(
  owner: string,
  projectNumber: number,
  run = runCommand
) {
  const view = JSON.parse(
    await run("gh", [
      "project",
      "view",
      String(projectNumber),
      "--owner",
      owner,
      "--format",
      "json",
    ])
  ) as { id: string };
  const fieldResponse = JSON.parse(
    await run("gh", [
      "project",
      "field-list",
      String(projectNumber),
      "--owner",
      owner,
      "--format",
      "json",
    ])
  ) as {
    fields: Array<{
      id: string;
      name: string;
      options?: Array<{ id: string; name: string }>;
      type: string;
    }>;
  };
  const itemArgs = [
    "project",
    "item-list",
    String(projectNumber),
    "--owner",
    owner,
    "--limit",
    "1000",
    "--format",
    "json",
  ];
  for (const field of FIELD_NAMES) {
    itemArgs.push("--field", field);
  }
  const fields = Object.fromEntries(
    fieldResponse.fields.map((field) => [
      field.name,
      {
        id: field.id,
        options: Object.fromEntries(
          (field.options ?? []).map((option) => [option.name, option.id])
        ),
        type: field.type,
      },
    ])
  ) as Record<string, ProjectField>;

  return {
    fields,
    items: parseProjectJson(await run("gh", itemArgs)),
    projectId: view.id,
  } satisfies ProjectSnapshot;
}

async function setField(
  itemId: string,
  fieldName: string,
  value: string,
  project: ProjectSnapshot,
  run: CommandRunner
): Promise<void> {
  const field = project.fields[fieldName];
  if (!field) {
    throw new Error(`missing Project field: ${fieldName}`);
  }
  const args = [
    "project",
    "item-edit",
    "--id",
    itemId,
    "--project-id",
    project.projectId,
    "--field-id",
    field.id,
  ];
  if (field.type === "ProjectV2Field") {
    args.push("--text", value);
  } else {
    const optionId = field.options[value];
    if (!optionId) {
      throw new Error(`missing option ${value} for Project field ${fieldName}`);
    }
    args.push("--single-select-option-id", optionId);
  }
  await run("gh", args);
}

async function applyAction(
  action: ReconciliationAction,
  project: ProjectSnapshot,
  owner: string,
  projectNumber: number,
  run: CommandRunner
): Promise<void> {
  let itemId: string;
  if (action.kind === "create") {
    const created = JSON.parse(
      await run("gh", [
        "project",
        "item-create",
        String(projectNumber),
        "--owner",
        owner,
        "--title",
        action.desired.title,
        "--body",
        action.desired.body,
        "--format",
        "json",
      ])
    ) as { id: string };
    itemId = created.id;
  } else {
    itemId = action.itemId;
    if (action.contentChanged) {
      await run("gh", [
        "project",
        "item-edit",
        String(projectNumber),
        "--owner",
        owner,
        "--id",
        itemId,
        "--title",
        action.desired.title,
        "--body",
        action.desired.body,
      ]);
    }
  }

  const fields =
    action.kind === "create"
      ? Object.keys(action.desired.fields)
      : action.changedFields;
  for (const field of fields.sort()) {
    await setField(
      itemId,
      field,
      action.desired.fields[field]!,
      project,
      run
    );
  }
}

export async function applyReconciliation(
  plan: ReconciliationPlan,
  project: ProjectSnapshot,
  owner: string,
  projectNumber: number,
  run = runCommand
): Promise<void> {
  for (const action of plan.actions) {
    for (const [fieldName, value] of Object.entries(action.desired.fields)) {
      const field = project.fields[fieldName];
      if (!field) {
        throw new Error(`missing Project field: ${fieldName}`);
      }
      if (
        field.type === "ProjectV2SingleSelectField" &&
        !field.options[value]
      ) {
        throw new Error(
          `missing option ${value} for Project field ${fieldName}`
        );
      }
    }
  }
  for (const action of plan.actions) {
    await applyAction(action, project, owner, projectNumber, run);
  }
}
```

Sequential writes are intentional: one draft must exist before its fields are
set, and bounded serialization avoids rate-limit bursts.

- [ ] **Step 4: Run I/O tests**

Run:

```bash
pnpm exec tsx --test scripts/beads-project-io.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/beads-project-io.ts scripts/beads-project-io.test.ts
git commit -S -m "feat(planning): add beads and project adapters" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Wire preview/apply and private seed CLIs

**Files:**
- Create: `scripts/beads-project-sync.ts`
- Test: `scripts/beads-project-sync.test.ts`
- Create: `scripts/beads-roadmap-seed.ts`
- Test: `scripts/beads-roadmap-seed.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing sync CLI tests**

Test an exported `runSync()` with injected loaders/applier. Required assertions:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { Bead } from "./beads-project-model";
import type { ProjectSnapshot } from "./beads-project-io";
import { runSync } from "./beads-project-sync";

const config = {
  beadsDirectory: "/private/beads",
  owner: "OpenCoven",
  projectNumber: 10,
};

const emptyProject: ProjectSnapshot = {
  fields: {},
  items: [],
  projectId: "PVT_project",
};

function safeBead(overrides: Partial<Bead> = {}): Bead {
  return {
    acceptance_criteria: "private acceptance text",
    dependencies: [],
    description: "Add a bounded control.",
    id: "coven-agents-security.1",
    issue_type: "task",
    metadata: {
      runner: "Shared",
      size: "S",
      workstream: "Security & privacy",
    },
    priority: 0,
    status: "open",
    title: "Add staged secret scanning",
    ...overrides,
  };
}

function unsafeBead(): Bead {
  return safeBead({
    description:
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234567890",
  });
}

test("preview never calls the applier", async () => {
  let applied = false;
  const code = await runSync(
    ["preview"],
    config,
    {
      apply: async () => {
        applied = true;
      },
      loadBeads: async () => [safeBead()],
      loadDependencyCycles: async () => [],
      loadProject: async () => emptyProject,
      validateProject: () => undefined,
      write: () => undefined,
    }
  );

  assert.equal(code, 0);
  assert.equal(applied, false);
});

test("apply validates the complete plan before writing", async () => {
  let applied = false;
  await assert.rejects(
    () =>
      runSync(
        ["apply"],
        config,
        {
          apply: async () => {
            applied = true;
          },
          loadBeads: async () => [unsafeBead()],
          loadDependencyCycles: async () => [],
          loadProject: async () => emptyProject,
          validateProject: () => undefined,
          write: () => undefined,
        }
      ),
    /unsafe/i
  );
  assert.equal(applied, false);
});

test("output contains counts and IDs but not bead bodies", async () => {
  const lines: string[] = [];
  await runSync(["preview"], config, {
    apply: async () => undefined,
    loadBeads: async () => [safeBead()],
    loadDependencyCycles: async () => [],
    loadProject: async () => emptyProject,
    validateProject: () => undefined,
    write: (line) => lines.push(line),
  });

  assert.match(lines.join("\n"), /coven-agents-security.1/);
  assert.doesNotMatch(lines.join("\n"), /private acceptance text/);
});
```

- [ ] **Step 2: Implement `scripts/beads-project-sync.ts`**

Implement the CLI with this structure:

```ts
#!/usr/bin/env tsx
import type { Bead } from "./beads-project-model";
import {
  applyReconciliation,
  loadBeads,
  loadDependencyCycles,
  loadProject,
  type ProjectSnapshot,
  validateProjectSchema,
} from "./beads-project-io";
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
    project: ProjectSnapshot,
    owner: string,
    projectNumber: number
  ) => Promise<void>;
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

function validateDependencies(beads: Bead[]): Map<string, Bead> {
  const byId = new Map(beads.map((bead) => [bead.id, bead] as const));
  for (const bead of beads) {
    if (bead.parent && !byId.has(bead.parent)) {
      throw new Error(`missing parent ${bead.parent} for ${bead.id}`);
    }
    for (const dependency of bead.dependencies) {
      if (!byId.has(dependency.depends_on_id)) {
        throw new Error(
          `missing dependency ${dependency.depends_on_id} for ${bead.id}`
        );
      }
    }
  }
  return byId;
}

export async function runSync(
  args: string[],
  config: SyncConfig,
  dependencies: SyncDependencies = defaultDependencies
): Promise<number> {
  const mode = args[0];
  if ((mode !== "preview" && mode !== "apply") || args.length !== 1) {
    throw new Error("Usage: pnpm beads:sync [preview|apply]");
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

  const byId = validateDependencies(beads);
  const desired = [...beads]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((bead) => projectBead(bead, byId));
  const plan = planReconciliation(desired, project.items);
  const creates = plan.actions.filter((action) => action.kind === "create");
  const updates = plan.actions.filter((action) => action.kind === "update");

  dependencies.write(`create: ${creates.length}`);
  dependencies.write(`update: ${updates.length}`);
  dependencies.write(`unchanged: ${plan.unchanged}`);
  dependencies.write(`orphaned: ${plan.orphaned.length}`);
  dependencies.write(`unmanaged: ${plan.unmanaged}`);
  for (const action of plan.actions) {
    dependencies.write(`${action.kind}: ${action.desired.beadId}`);
  }

  if (mode === "apply") {
    await dependencies.apply(
      plan,
      project,
      config.owner,
      config.projectNumber
    );
  }
  return 0;
}

const isMain =
  process.argv[1] === undefined
    ? false
    : import.meta.url === `file://${process.argv[1]}`;

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
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
```

This validates the complete source graph, safety projection, reconciliation
plan, and Project schema before the I/O adapter performs its first write.

- [ ] **Step 3: Write failing seed validation tests**

Define a private seed schema containing exactly 10 epics and 50 children:

```ts
type SeedItem = {
  acceptanceCriteria: string;
  dependsOn: string[];
  description: string;
  id: string;
  metadata: {
    projectStatus?: "Todo" | "In Progress" | "In review";
    runner: "Cloud" | "Local" | "Control plane" | "Shared";
    size: "XS" | "S" | "M" | "L" | "XL";
    workstream: Workstream;
  };
  parent?: string;
  priority: 0 | 1 | 2;
  title: string;
  type: "epic" | "feature" | "task" | "bug";
};
```

Tests must reject:

- any item count other than 60;
- any epic count other than 10;
- an epic without exactly five direct children;
- duplicate IDs;
- a missing parent or dependency;
- a dependency cycle;
- descriptions or acceptance criteria rejected by the privacy policy;
- an ID outside `coven-agents-<workstream>` and `.1` through `.5`.

- [ ] **Step 4: Implement the idempotent seed CLI**

`scripts/beads-roadmap-seed.ts` accepts:

```text
pnpm beads:seed preview /absolute/path/to/private-seed.json
pnpm beads:seed apply /absolute/path/to/private-seed.json
```

It validates the whole file first. `preview` prints IDs and counts only. `apply`
loads current Beads IDs, creates epics before children with `bd create --id`,
then adds missing `blocks` dependencies with `bd dep add`. Existing IDs are
never updated or deleted automatically; differing existing content is a hard
failure.

Construct each create call as:

```ts
[
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
]
```

Add dependencies only after all 60 items exist. Finish with
`bd -C "$BEADS_WORKSPACE" dep cycles --json`; a non-empty result fails the
command.

- [ ] **Step 5: Add package scripts**

Modify `package.json`:

```json
{
  "scripts": {
    "beads:seed": "tsx scripts/beads-roadmap-seed.ts",
    "beads:sync": "tsx scripts/beads-project-sync.ts"
  }
}
```

Keep all existing scripts unchanged.

- [ ] **Step 6: Run targeted tests and typecheck**

Run:

```bash
pnpm exec tsx --test \
  scripts/beads-project-sync.test.ts \
  scripts/beads-roadmap-seed.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json scripts/beads-project-sync.ts \
  scripts/beads-project-sync.test.ts scripts/beads-roadmap-seed.ts \
  scripts/beads-roadmap-seed.test.ts
git commit -S -m "feat(planning): add roadmap seed and sync commands" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Add safe automation and operator documentation

**Files:**
- Create: `.github/workflows/beads-project-sync.yml`
- Create: `docs/beads-project-sync.md`
- Modify: `.gitignore`

- [ ] **Step 1: Extend `.gitignore`**

Append:

```gitignore

# Private Beads planning data
.beads/
*.beads-private.json
```

- [ ] **Step 2: Add the pinned workflow**

Create `.github/workflows/beads-project-sync.yml`:

```yaml
name: beads project sync

on:
  schedule:
    - cron: "17 8 * * *"
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: beads-project-sync
  cancel-in-progress: false

jobs:
  sync:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    env:
      BEADS_WORKSPACE: ${{ runner.temp }}/coven-agents-beads
      COVEN_PROJECT_NUMBER: "10"
      COVEN_PROJECT_OWNER: OpenCoven
      DOLT_REMOTE_PASSWORD: ${{ secrets.DOLT_REMOTE_PASSWORD }}
      DOLT_REMOTE_USER: ${{ secrets.DOLT_REMOTE_USER }}
      GH_TOKEN: ${{ secrets.COVEN_PROJECT_TOKEN }}

    steps:
      - name: Check out
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1

      - name: Set up pnpm
        uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6.0.10

      - name: Set up Node
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Install Beads 1.2.2
        env:
          BEADS_SHA256: 8140098a51d3b81d5548d1c5e6db1a2d9930e5d141efe2a4bff7d079c4d321e8
        run: |
          set -euo pipefail
          archive="$RUNNER_TEMP/beads.tar.gz"
          curl --fail --location --silent --show-error \
            https://github.com/gastownhall/beads/releases/download/v1.2.2/beads_1.2.2_linux_amd64.tar.gz \
            --output "$archive"
          echo "$BEADS_SHA256  $archive" | sha256sum --check
          mkdir -p "$RUNNER_TEMP/beads-bin"
          tar -xzf "$archive" -C "$RUNNER_TEMP/beads-bin"
          echo "$RUNNER_TEMP/beads-bin" >> "$GITHUB_PATH"
          "$RUNNER_TEMP/beads-bin/bd" version

      - name: Restore private Beads database
        env:
          DOLT_REMOTE_URL: https://doltremoteapi.dolthub.com/OpenCoven/coven-agents-beads
        run: |
          set -euo pipefail
          mkdir -p "$BEADS_WORKSPACE"
          bd -C "$BEADS_WORKSPACE" init \
            --non-interactive \
            --prefix coven-agents \
            --remote "$DOLT_REMOTE_URL" \
            --skip-agents \
            --skip-hooks

      - name: Preview reconciliation
        run: pnpm beads:sync preview

      - name: Apply reconciliation
        run: pnpm beads:sync apply
```

- [ ] **Step 3: Write operator documentation**

Create `docs/beads-project-sync.md` with:

- authority: private Beads is source of truth, Project #10 is generated;
- local prerequisites: `bd 1.2.2`, `dolt 2.x`, `gh`, Node 24, pnpm 10;
- DoltHub remote URL;
- secret names and minimum permissions;
- local `preview`, `apply`, `bd dolt pull`, and `bd dolt push` commands;
- field mapping and status mapping;
- generated marker format;
- privacy rejection rules;
- recovery from duplicate markers, missing fields, auth failures, and orphans;
- explicit warning that Project edits to managed fields are overwritten;
- explicit warning never to commit `.beads/` or `*.beads-private.json`.

- [ ] **Step 4: Validate workflow and docs**

Run:

```bash
pnpm check
pnpm typecheck
git check-ignore .beads/example.db example.beads-private.json
```

Expected:

- lint and typecheck pass;
- both example paths are printed by `git check-ignore`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/beads-project-sync.yml .gitignore \
  docs/beads-project-sync.md
git commit -S -m "ci(planning): automate private beads project sync" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: Configure private Project #10

**Files:**
- No repository files.

- [ ] **Step 1: Confirm the destination is private and empty**

Run:

```bash
gh project view 10 --owner OpenCoven --format json \
  --jq '{closed,number,public,title}'
gh project item-list 10 --owner OpenCoven --limit 1000 --format json \
  --jq '.totalCount'
```

Expected:

```json
{"closed":false,"number":10,"public":false,"title":"Coven Agents"}
```

and item count `0`. If items now exist, stop and inspect them before changing
the schema.

- [ ] **Step 2: Create missing fields**

Run each command only when `gh project field-list` confirms the field is
missing:

```bash
gh project field-create 10 --owner OpenCoven \
  --name "Bead ID" --data-type TEXT

gh project field-create 10 --owner OpenCoven \
  --name "Type" --data-type SINGLE_SELECT \
  --single-select-options "epic,feature,task,bug"

gh project field-create 10 --owner OpenCoven \
  --name "Workstream" --data-type SINGLE_SELECT \
  --single-select-options "Product,Contracts & harnesses,Cloud runner,Local runner,Data lifecycle,Security & privacy,Observability,Testing & reliability,Releases & docs,Developer experience"

gh project field-create 10 --owner OpenCoven \
  --name "Blocked" --data-type SINGLE_SELECT \
  --single-select-options "Yes,No"
```

- [ ] **Step 3: Verify the complete schema**

Run:

```bash
gh project field-list 10 --owner OpenCoven --format json \
  --jq '.fields[] | {name,type,options: [.options[]?.name]}'
```

Expected: the existing Status, Runner, Size, and Priority fields plus Bead ID,
Type, Workstream, and Blocked with exactly the designed options.

---

### Task 8: Create and back up the private roadmap

**Files:**
- Create outside Git only:
  `$HOME/.local/share/opencoven/coven-agents-roadmap.beads-private.json`

- [ ] **Step 1: Confirm DoltHub authentication**

Run:

```bash
dolt creds check
```

If unauthenticated, run `dolt login`, complete the browser authorization, then
rerun `dolt creds check`.

- [ ] **Step 2: Create the private DoltHub database**

Create private database `OpenCoven/coven-agents-beads` in DoltHub. Confirm it is
private before adding any roadmap data.

- [ ] **Step 3: Initialize the local private Beads workspace**

Use a path outside the public repository:

```bash
mkdir -p "$HOME/.local/share/opencoven/coven-agents-beads"
bd -C "$HOME/.local/share/opencoven/coven-agents-beads" init \
  --non-interactive \
  --prefix coven-agents \
  --skip-agents \
  --skip-hooks
bd -C "$HOME/.local/share/opencoven/coven-agents-beads" \
  dolt remote add origin \
  https://doltremoteapi.dolthub.com/OpenCoven/coven-agents-beads
```

- [ ] **Step 4: Build the private 60-item seed**

Create the untracked JSON file accepted by `pnpm beads:seed`. It must contain
these ten epic IDs, with children `.1` through `.5`:

| Epic ID | Required child coverage |
|---|---|
| `coven-agents-product` | onboarding/configuration, agent lifecycle, mission UX, run history, error/accessibility UX |
| `coven-agents-contracts` | contract versioning, Codex translation, Claude translation, capability negotiation, compatibility policy |
| `coven-agents-cloud` | sandbox lifecycle, credential provisioning, concurrency, network policy, deployment diagnostics |
| `coven-agents-local` | process lifecycle, workspace boundary, stream/cancel behavior, harness discovery, crash recovery |
| `coven-agents-data` | registry schema, run persistence, retention, export/import, migrations |
| `coven-agents-security` | staged secret scanning, CI privacy scanning, output redaction, dependency/code scanning, threat model |
| `coven-agents-observability` | structured logs, traces, metrics, audit events, health/runbooks |
| `coven-agents-testing` | contract conformance, cloud integration, local integration, browser E2E, load/failure testing |
| `coven-agents-release` | environment setup, deployment automation, release/versioning, operator docs, recovery docs |
| `coven-agents-dx` | bootstrap, task/worktree lifecycle, generated API docs, review ownership, maintenance cadence |

For every record:

- write a concrete outcome-oriented title;
- use a two-to-four sentence objective;
- use measurable acceptance criteria;
- set one valid runner, size, workstream, type, and P0-P2 priority;
- add only real ordering dependencies;
- ensure at least eight child beads are ready immediately;
- use no more than fifteen P0 child beads;
- include at least twelve cross-epic dependencies;
- do not include credentials, local paths, customer data, logs, or unpublished
  implementation details.

- [ ] **Step 5: Preview and apply the private seed**

Run:

```bash
export BEADS_WORKSPACE="$HOME/.local/share/opencoven/coven-agents-beads"
pnpm beads:seed preview \
  "$HOME/.local/share/opencoven/coven-agents-roadmap.beads-private.json"
pnpm beads:seed apply \
  "$HOME/.local/share/opencoven/coven-agents-roadmap.beads-private.json"
```

Expected: 10 epics and 50 child beads created, with no content printed.

- [ ] **Step 6: Verify graph quality and back it up**

Run:

```bash
bd -C "$BEADS_WORKSPACE" list --all --limit 0 --json | jq 'length'
bd -C "$BEADS_WORKSPACE" list --type epic --all --limit 0 --json | jq 'length'
bd -C "$BEADS_WORKSPACE" ready --json | jq 'length'
bd -C "$BEADS_WORKSPACE" dep cycles --json
bd -C "$BEADS_WORKSPACE" dolt commit \
  --message "Seed initial coven-agents roadmap"
bd -C "$BEADS_WORKSPACE" dolt push
bd -C "$BEADS_WORKSPACE" dolt remote list
```

Expected:

- total `60`;
- epics `10`;
- ready count at least `8`;
- cycles `[]`;
- `origin` listed as the private DoltHub remote and the push succeeds.

---

### Task 9: Perform the initial synchronization and verify idempotency

**Files:**
- Modify only if verification exposes a bug in the committed implementation.

- [ ] **Step 1: Run all repository validation**

Run:

```bash
pnpm hygiene
pnpm check
pnpm typecheck
pnpm test:unit
```

Expected: PASS and no AT RISK worktree created by this task.

- [ ] **Step 2: Preview the live reconciliation**

Run:

```bash
export BEADS_WORKSPACE="$HOME/.local/share/opencoven/coven-agents-beads"
export COVEN_PROJECT_OWNER=OpenCoven
export COVEN_PROJECT_NUMBER=10
pnpm beads:sync preview
```

Expected:

- `create: 60`;
- `update: 0`;
- no bodies or acceptance criteria in output;
- only managed Bead IDs and aggregate counts.

- [ ] **Step 3: Apply the initial import**

Run:

```bash
pnpm beads:sync apply
```

Expected: 60 private draft items created and populated.

- [ ] **Step 4: Prove idempotency**

Run:

```bash
pnpm beads:sync preview
pnpm beads:sync apply
```

Expected for both:

- `create: 0`;
- `update: 0`;
- `unchanged: 60`.

- [ ] **Step 5: Verify Project inventory**

Run:

```bash
gh project item-list 10 --owner OpenCoven --limit 1000 --format json \
  --field "Bead ID" --field "Status" --field "Blocked" \
  --jq '{
    total: .totalCount,
    managed: [.items[] | select(.\"bead ID\" != \"\")] | length
  }'
```

Expected:

```json
{"managed":60,"total":60}
```

- [ ] **Step 6: Configure workflow secrets**

Set:

- `DOLT_REMOTE_USER`;
- `DOLT_REMOTE_PASSWORD`;
- `COVEN_PROJECT_TOKEN`.

`COVEN_PROJECT_TOKEN` must have write access only to organization Project #10;
checkout continues to use the workflow's read-only `GITHUB_TOKEN`.

- [ ] **Step 7: Push and inspect the workflow**

Push the branch, open a pull request, and run:

```bash
gh workflow view beads-project-sync.yml --repo OpenCoven/coven-agents
```

After merge, dispatch from `main`:

```bash
gh workflow run beads-project-sync.yml \
  --repo OpenCoven/coven-agents \
  --ref main
gh run watch --repo OpenCoven/coven-agents --exit-status
```

Expected: success, zero reconciliation changes, and no sensitive content in
logs.

- [ ] **Step 8: Commit any verification fixes**

If live verification required code changes:

```bash
git add scripts .github/workflows/beads-project-sync.yml \
  docs/beads-project-sync.md package.json .gitignore
git commit -S -m "fix(planning): harden live beads synchronization" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
git push
```

If no fixes were needed, do not create an empty commit.
