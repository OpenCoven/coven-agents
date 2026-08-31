import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  findPlanningDocumentViolations,
  PLANNING_REGISTRY_PATH,
  type PlanningDocumentPolicyInput,
  parsePlanningRegistry,
  scanPlanningDocuments,
} from "./planning-docs-policy";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

const registry = `# Planning document registry

<!-- coven-agents-planning-registry:v1:start -->
| Path | Role | Lifecycle | Authority | Last reviewed | Current guidance |
| --- | --- | --- | --- | --- | --- |
| [\`ROADMAP.md\`](../../ROADMAP.md) | Strategy | Current | Beads-derived aggregate | 2026-08-31 | — |
| [\`POLISH.md\`](../../POLISH.md) | Decision log | Historical | Repository evidence | 2026-08-31 | [Current state](current-state.md) |
| [\`docs/roadmap/README.md\`](README.md) | Registry | Current | Operating policy | 2026-08-31 | — |
| [\`docs/roadmap/current-state.md\`](current-state.md) | State | Current | Repository evidence | 2026-08-31 | — |
| [\`docs/roadmap/old-audit.md\`](old-audit.md) | Evidence | Historical | Repository evidence | 2026-08-31 | [Current state](current-state.md) |
| [\`docs/proposals/example.md\`](../proposals/example.md) | Proposal | Proposed | Non-authoritative proposal | 2026-08-31 | — |
| [\`docs/superpowers/README.md\`](../superpowers/README.md) | Tombstone | Superseded | Repository evidence | 2026-08-31 | [Planning registry](../roadmap/README.md) |
<!-- coven-agents-planning-registry:v1:end -->

A disabled deployment may require [a future runbook](../runbooks/vercel-deployment.md).
`;

const trackedPaths = [
  "POLISH.md",
  "ROADMAP.md",
  "docs/proposals/example.md",
  "docs/roadmap/README.md",
  "docs/roadmap/current-state.md",
  "docs/roadmap/old-audit.md",
  "docs/superpowers/README.md",
];

function input(
  overrides: Partial<PlanningDocumentPolicyInput> = {}
): PlanningDocumentPolicyInput {
  return {
    registryMarkdown: registry,
    trackedPaths,
    ...overrides,
  };
}

test("parses the canonical planning registry", () => {
  const documents = parsePlanningRegistry(registry);

  assert.equal(documents.length, 7);
  assert.deepEqual(documents[1], {
    authority: "Repository evidence",
    currentGuidance: ["docs/roadmap/current-state.md"],
    lastReviewed: "2026-08-31",
    lifecycle: "Historical",
    path: "POLISH.md",
    registryTarget: "POLISH.md",
    role: "Decision log",
  });
});

test("accepts complete planning coverage and ignores conditional future links", () => {
  assert.deepEqual(findPlanningDocumentViolations(input()), []);
});

test("rejects duplicate registry paths", () => {
  const duplicate = registry.replace(
    "<!-- coven-agents-planning-registry:v1:end -->",
    "| [`ROADMAP.md`](../../ROADMAP.md) | Strategy | Current | Beads-derived aggregate | 2026-08-31 | — |\n<!-- coven-agents-planning-registry:v1:end -->"
  );

  assert.deepEqual(
    findPlanningDocumentViolations(input({ registryMarkdown: duplicate })),
    [
      {
        path: "ROADMAP.md",
        reason: "duplicate-path",
      },
    ]
  );
});

test("rejects unknown lifecycle and role values", () => {
  const invalid = registry
    .replace("| Strategy | Current |", "| Backlog | Current |")
    .replace("| Proposal | Proposed |", "| Proposal | Planned |");

  assert.deepEqual(
    findPlanningDocumentViolations(input({ registryMarkdown: invalid })),
    [
      {
        path: "ROADMAP.md",
        reason: "invalid-role",
      },
      {
        path: "docs/proposals/example.md",
        reason: "invalid-lifecycle",
      },
    ]
  );
});

test("rejects unknown authority and invalid review dates", () => {
  const invalid = registry
    .replace(
      "| Strategy | Current | Beads-derived aggregate | 2026-08-31 |",
      "| Strategy | Current | Private task copy | 2026-08-31 |"
    )
    .replace(
      "| Proposal | Proposed | Non-authoritative proposal | 2026-08-31 |",
      "| Proposal | Proposed | Non-authoritative proposal | 2026-02-30 |"
    );

  assert.deepEqual(
    findPlanningDocumentViolations(input({ registryMarkdown: invalid })),
    [
      {
        path: "ROADMAP.md",
        reason: "invalid-authority",
      },
      {
        path: "docs/proposals/example.md",
        reason: "invalid-last-reviewed",
      },
    ]
  );
});

test("rejects registry paths that are not tracked", () => {
  assert.deepEqual(
    findPlanningDocumentViolations(
      input({
        trackedPaths: trackedPaths.filter(
          (path) => path !== "docs/proposals/example.md"
        ),
      })
    ),
    [
      {
        path: "docs/proposals/example.md",
        reason: "missing-tracked-file",
      },
    ]
  );
});

test("rejects registry links that do not target their labeled path", () => {
  const invalidLink = registry.replace(
    "[`ROADMAP.md`](../../ROADMAP.md)",
    "[`ROADMAP.md`](missing.md)"
  );

  assert.deepEqual(
    findPlanningDocumentViolations(input({ registryMarkdown: invalidLink })),
    [
      {
        path: "ROADMAP.md",
        reason: "invalid-registry-link",
      },
    ]
  );
});

test("rejects tracked planning documents missing from the registry", () => {
  assert.deepEqual(
    findPlanningDocumentViolations(
      input({
        trackedPaths: [...trackedPaths, "docs/roadmap/unindexed.md"],
      })
    ),
    [
      {
        path: "docs/roadmap/unindexed.md",
        reason: "unindexed-planning-document",
      },
    ]
  );
});

test("requires nested roadmap and proposal documents to be indexed", () => {
  assert.deepEqual(
    findPlanningDocumentViolations(
      input({
        trackedPaths: [
          ...trackedPaths,
          "docs/roadmap/archive/old.md",
          "docs/proposals/future/example.md",
        ],
      })
    ),
    [
      {
        path: "docs/roadmap/archive/old.md",
        reason: "unindexed-planning-document",
      },
      {
        path: "docs/proposals/future/example.md",
        reason: "unindexed-planning-document",
      },
    ]
  );
});

test("requires historical and superseded documents to link current guidance", () => {
  const missingGuidance = registry.replace(
    "| [`POLISH.md`](../../POLISH.md) | Decision log | Historical | Repository evidence | 2026-08-31 | [Current state](current-state.md) |",
    "| [`POLISH.md`](../../POLISH.md) | Decision log | Historical | Repository evidence | 2026-08-31 | — |"
  );

  assert.deepEqual(
    findPlanningDocumentViolations(
      input({ registryMarkdown: missingGuidance })
    ),
    [
      {
        path: "POLISH.md",
        reason: "missing-current-guidance",
      },
    ]
  );
});

test("requires current guidance to target a current indexed document", () => {
  const selfGuidance = registry.replace(
    "[Current state](current-state.md)",
    "[This historical log](../../POLISH.md)"
  );

  assert.deepEqual(
    findPlanningDocumentViolations(input({ registryMarkdown: selfGuidance })),
    [
      {
        path: "POLISH.md",
        reason: "noncurrent-current-guidance",
      },
    ]
  );
});

test("rejects broken current-guidance links", () => {
  const brokenGuidance = registry.replace(
    "[Current state](current-state.md)",
    "[Missing](missing.md)"
  );

  assert.deepEqual(
    findPlanningDocumentViolations(input({ registryMarkdown: brokenGuidance })),
    [
      {
        path: "docs/roadmap/missing.md",
        reason: "broken-current-guidance",
      },
    ]
  );
});

test("the repository planning registry passes the policy", () => {
  assert.equal(
    existsSync(`${repositoryRoot}/${PLANNING_REGISTRY_PATH}`),
    true,
    `${PLANNING_REGISTRY_PATH} must exist`
  );
  assert.deepEqual(scanPlanningDocuments(repositoryRoot), []);
});

test("repository scanning does not treat untracked files as tracked", () => {
  const directory = mkdtempSync(
    join(repositoryRoot, ".planning-docs-policy-test-")
  );

  try {
    mkdirSync(join(directory, "docs/roadmap"), { recursive: true });
    writeFileSync(join(directory, "ROADMAP.md"), "# Roadmap\n");
    writeFileSync(
      join(directory, PLANNING_REGISTRY_PATH),
      `# Registry

<!-- coven-agents-planning-registry:v1:start -->
| Path | Role | Lifecycle | Authority | Last reviewed | Current guidance |
| --- | --- | --- | --- | --- | --- |
| [\`ROADMAP.md\`](../../ROADMAP.md) | Strategy | Current | Beads-derived aggregate | 2026-08-31 | — |
| [\`docs/roadmap/README.md\`](README.md) | Registry | Current | Operating policy | 2026-08-31 | — |
<!-- coven-agents-planning-registry:v1:end -->
`
    );
    execFileSync("git", ["init", "--quiet"], { cwd: directory });
    execFileSync("git", ["add", "ROADMAP.md"], { cwd: directory });

    assert.deepEqual(scanPlanningDocuments(directory), [
      {
        path: "docs/roadmap/README.md",
        reason: "missing-tracked-file",
      },
    ]);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
