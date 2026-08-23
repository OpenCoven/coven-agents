import assert from "node:assert/strict";
import test from "node:test";
import { ZodError } from "zod";
import {
  type Bead,
  parseBeadsJson,
  parseProjectJson,
} from "./beads-project-model";

function expectZodIssue(
  run: () => void,
  predicate: (path: readonly PropertyKey[]) => boolean
): void {
  assert.throws(run, (error: unknown) => {
    if (!(error instanceof ZodError)) {
      return false;
    }

    return error.issues.some((issue) => predicate(issue.path));
  });
}

test("parses real Beads CLI JSON with issue_type and extra fields", () => {
  const parsed = parseBeadsJson(
    JSON.stringify([
      {
        acceptance_criteria:
          "The roadmap item is visible in the project board.",
        comment_count: 3,
        created_at: "2026-08-23T09:00:00Z",
        created_by: "OpenCoven",
        dependency_count: 0,
        dependent_count: 1,
        description: "Define the shared security model for project board sync.",
        id: "coven-agents-security",
        issue_type: "epic",
        metadata: {
          projectStatus: "Todo",
          runner: "Shared",
          size: "M",
          workstream: "Security & privacy",
        },
        owner: "OpenCoven",
        priority: 1,
        status: "open",
        title: "Define project board security model",
        updated_at: "2026-08-23T09:15:00Z",
      },
      {
        acceptance_criteria: "Child work can be blocked by the parent epic.",
        comment_count: 0,
        created_at: "2026-08-23T09:05:00Z",
        created_by: "OpenCoven",
        dependencies: [
          {
            depends_on_id: "coven-agents-security",
            issue_id: "coven-agents-security.1",
            type: "blocks",
          },
        ],
        dependency_count: 1,
        dependent_count: 0,
        description: "Add redaction to the sync projection.",
        id: "coven-agents-security.1",
        issue_type: "feature",
        metadata: {
          runner: "Control plane",
          size: "S",
          workstream: "Security & privacy",
        },
        owner: "OpenCoven",
        parent: "coven-agents-security",
        priority: 2,
        status: "in_progress",
        title: "Add secret redaction",
        updated_at: "2026-08-23T09:20:00Z",
      },
    ])
  );

  const bead: Bead = parsed[0];

  assert.equal(parsed.length, 2);
  assert.equal(bead.status, "open");
  assert.equal(parsed[1].id, "coven-agents-security.1");
  assert.equal(parsed[1].parent, "coven-agents-security");
  assert.deepEqual(parsed[1].dependencies, [
    {
      depends_on_id: "coven-agents-security",
      issue_id: "coven-agents-security.1",
      type: "blocks",
    },
  ]);
  assert.equal(parsed[1].metadata.runner, "Control plane");
  assert.equal(parsed[0].metadata.projectStatus, "Todo");
});

test("rejects priority 4", () => {
  expectZodIssue(
    () =>
      parseBeadsJson(
        JSON.stringify([
          {
            acceptance_criteria: "Valid criteria.",
            description: "Priority must stay in range.",
            id: "coven-agents-priority",
            issue_type: "task",
            metadata: {
              runner: "Shared",
              size: "XS",
              workstream: "Product",
            },
            priority: 4,
            status: "open",
            title: "Reject invalid priority",
          },
        ])
      ),
    (path) => path.at(-1) === "priority"
  );
});

test("rejects unsupported issue type decision", () => {
  expectZodIssue(
    () =>
      parseBeadsJson(
        JSON.stringify([
          {
            acceptance_criteria: "Valid criteria.",
            description: "Unsupported type must fail.",
            id: "coven-agents-decision",
            issue_type: "decision",
            metadata: {
              runner: "Shared",
              size: "XS",
              workstream: "Product",
            },
            priority: 0,
            status: "open",
            title: "Reject invalid type",
          },
        ])
      ),
    (path) => path.at(-1) === "issue_type"
  );
});

test("parses real project item-list JSON with extra content fields", () => {
  const parsed = parseProjectJson(
    JSON.stringify({
      items: [
        {
          "bead id": "coven-agents-security.1",
          content: {
            body: "Draft body",
            number: 42,
            repository: "OpenCoven/coven-agents",
            title: "Draft title",
            type: "DraftIssue",
            url: "https://github.com/OpenCoven/coven-agents/issues/42",
          },
          id: "PJI_1",
          runner: "Shared",
          type: "feature",
          url: "https://github.com/orgs/OpenCoven/projects/10/views/1?pane=issue&itemId=PJI_1",
        },
      ],
      pageInfo: {
        hasNextPage: false,
      },
      totalCount: 1,
    })
  );

  assert.equal(parsed.totalCount, 1);
  assert.equal(parsed.items[0].content.type, "DraftIssue");
  assert.equal(parsed.items[0].content.number, 42);
  assert.equal(parsed.items[0].fields["Bead ID"], "coven-agents-security.1");
  assert.equal(parsed.items[0].fields.Type, "feature");
});

test("parsed beads are assignable to Bead and keep open status", () => {
  const [bead] = parseBeadsJson(
    JSON.stringify([
      {
        acceptance_criteria: "The item can be read as a Bead.",
        description: "Return a typed bead instance.",
        id: "coven-agents-assignment",
        issue_type: "task",
        metadata: {
          runner: "Local",
          size: "XS",
          workstream: "Developer experience",
        },
        priority: 0,
        status: "open",
        title: "Type check bead return values",
      },
    ])
  );

  const typedBead: Bead = bead;

  assert.equal(typedBead.status, "open");
  assert.equal(typedBead.issue_type, "task");
});
