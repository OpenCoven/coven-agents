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

test("parses valid Beads JSON with parent-child dependencies and metadata", () => {
  const parsed = parseBeadsJson(
    JSON.stringify([
      {
        acceptance_criteria:
          "The roadmap item is visible in the project board.",
        description: "Define the shared security model for project board sync.",
        id: "coven-agents-security",
        metadata: {
          projectStatus: "Todo",
          runner: "Shared",
          size: "M",
          workstream: "Security & privacy",
        },
        priority: 1,
        status: "open",
        title: "Define project board security model",
        type: "epic",
      },
      {
        acceptance_criteria: "Child work can be blocked by the parent epic.",
        dependencies: [
          {
            depends_on_id: "coven-agents-security",
            issue_id: "coven-agents-security.1",
            type: "blocks",
          },
        ],
        description: "Add redaction to the sync projection.",
        id: "coven-agents-security.1",
        metadata: {
          runner: "Control plane",
          size: "S",
          workstream: "Security & privacy",
        },
        parent: "coven-agents-security",
        priority: 2,
        status: "in_progress",
        title: "Add secret redaction",
        type: "feature",
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
            metadata: {
              runner: "Shared",
              size: "XS",
              workstream: "Product",
            },
            priority: 4,
            status: "open",
            title: "Reject invalid priority",
            type: "task",
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
            metadata: {
              runner: "Shared",
              size: "XS",
              workstream: "Product",
            },
            priority: 0,
            status: "open",
            title: "Reject invalid type",
            type: "decision",
          },
        ])
      ),
    (path) => path.at(-1) === "type"
  );
});

test("parses project draft items and canonicalizes top-level fields", () => {
  const parsed = parseProjectJson(
    JSON.stringify({
      items: [
        {
          "bead id": "coven-agents-security.1",
          content: {
            body: "Draft body",
            title: "Draft title",
            type: "DraftIssue",
          },
          id: "PJI_1",
          runner: "Shared",
          type: "feature",
        },
      ],
      totalCount: 1,
    })
  );

  assert.equal(parsed.totalCount, 1);
  assert.equal(parsed.items[0].content.type, "DraftIssue");
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
        metadata: {
          runner: "Local",
          size: "XS",
          workstream: "Developer experience",
        },
        priority: 0,
        status: "open",
        title: "Type check bead return values",
        type: "task",
      },
    ])
  );

  const typedBead: Bead = bead;

  assert.equal(typedBead.status, "open");
});
