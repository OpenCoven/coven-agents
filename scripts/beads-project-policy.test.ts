import assert from "node:assert/strict";
import test from "node:test";
import type { Bead } from "./beads-project-model";
import {
  MARKER_PREFIX,
  projectBead,
  validateSafeText,
} from "./beads-project-policy";

function makeBead(overrides: Partial<Bead> = {}): Bead {
  const { metadata: overrideMetadata, ...rest } = overrides;

  const metadata: Bead["metadata"] = {
    runner: "Shared",
    size: "M",
    workstream: "Product",
    ...overrideMetadata,
  };

  return {
    acceptance_criteria: "Acceptance criteria.",
    dependencies: [],
    description: "Description.",
    id: "coven-agents-test",
    issue_type: "task",
    priority: 1,
    status: "open",
    title: "Test bead",
    ...rest,
    metadata,
  };
}

function expectUnsafe(
  field: "title" | "description" | "acceptance",
  value: string,
  category: RegExp
): void {
  assert.throws(
    () => validateSafeText(field, value),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(`^${field}: `));
      assert.match(error.message, category);
      assert.ok(!error.message.includes(value));
      return true;
    }
  );
}

test("rejects sensitive content categories", () => {
  expectUnsafe("title", "github_pat_abc123", /github token/i);
  expectUnsafe(
    "description",
    "Authorization: Bearer secret-token",
    /bearer header/i
  );
  expectUnsafe("acceptance", "AWS_KEY=supersecret", /env assignment/i);
  expectUnsafe(
    "acceptance",
    "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    /pem private key/i
  );
});

test("rejects absolute paths and overlong title", () => {
  expectUnsafe("description", "/Users/alice/private.txt", /absolute path/i);
  expectUnsafe(
    "description",
    "C:\\Users\\alice\\private.txt",
    /absolute path/i
  );
  assert.throws(
    () => validateSafeText("title", "x".repeat(121)),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^title: /);
      assert.match(error.message, /length/i);
      return true;
    }
  );
});

test("renders deterministic markdown with marker and parent", () => {
  const parent = makeBead({
    id: "coven-agents-parent",
    title: "Parent bead",
  });
  const child = makeBead({
    dependencies: [
      {
        depends_on_id: "coven-agents-parent",
        issue_id: "coven-agents-child",
        type: "blocks",
      },
    ],
    id: "coven-agents-child",
    parent: "coven-agents-parent",
    title: "Child bead",
  });

  const item = projectBead(child, [parent, child]);

  assert.equal(item.title, "Child bead");
  assert.equal(item.beadId, "coven-agents-child");
  assert.match(
    item.body,
    new RegExp(`^${MARKER_PREFIX}coven-agents-child -->\\n`)
  );
  assert.match(item.body, /## Objective\nDescription\./);
  assert.match(item.body, /## Acceptance criteria\nAcceptance criteria\./);
  assert.match(item.body, /## Bead ID\ncoven-agents-child/);
  assert.match(item.body, /## Parent\ncoven-agents-parent/);
  assert.match(item.body, /## Active dependencies\nNone/);
});

test("active blocks dependency marks blocked while parent-child alone does not", () => {
  const parent = makeBead({
    id: "coven-agents-parent",
  });
  const openBlocker = makeBead({
    id: "coven-agents-open-blocker",
    status: "open",
  });
  const secondOpenBlocker = makeBead({
    id: "coven-agents-a-blocker",
    status: "open",
  });
  const closedBlocker = makeBead({
    id: "coven-agents-closed-blocker",
    status: "closed",
  });

  const childBlockedByParentOnly = makeBead({
    dependencies: [
      {
        depends_on_id: "coven-agents-parent",
        issue_id: "coven-agents-child-parent-only",
        type: "blocks",
      },
    ],
    id: "coven-agents-child-parent-only",
    parent: "coven-agents-parent",
  });

  const childBlockedByOpenDependency = makeBead({
    dependencies: [
      {
        depends_on_id: "coven-agents-open-blocker",
        issue_id: "coven-agents-child-open",
        type: "blocks",
      },
      {
        depends_on_id: "coven-agents-a-blocker",
        issue_id: "coven-agents-child-open",
        type: "blocks",
      },
      {
        depends_on_id: "coven-agents-parent",
        issue_id: "coven-agents-child-open",
        type: "blocks",
      },
    ],
    id: "coven-agents-child-open",
    parent: "coven-agents-parent",
  });

  const childWithClosedDependency = makeBead({
    dependencies: [
      {
        depends_on_id: "coven-agents-closed-blocker",
        issue_id: "coven-agents-child-closed",
        type: "blocks",
      },
    ],
    id: "coven-agents-child-closed",
  });

  const blockedOnly = projectBead(childBlockedByParentOnly, [
    parent,
    childBlockedByParentOnly,
  ]);
  const blockedByOpen = projectBead(childBlockedByOpenDependency, [
    parent,
    openBlocker,
    secondOpenBlocker,
    childBlockedByOpenDependency,
  ]);
  const blockedByClosed = projectBead(childWithClosedDependency, [
    closedBlocker,
    childWithClosedDependency,
  ]);

  assert.equal(blockedOnly.fields.Blocked, "No");
  assert.equal(blockedByOpen.fields.Blocked, "Yes");
  assert.match(
    blockedByOpen.body,
    /## Active dependencies\n- coven-agents-a-blocker\n- coven-agents-open-blocker$/
  );
  assert.equal(blockedByClosed.fields.Blocked, "No");
});

test("maps status type and priority fields", () => {
  const closed = makeBead({
    id: "coven-agents-closed",
    issue_type: "bug",
    metadata: {
      projectStatus: "In review",
      runner: "Local",
      size: "XL",
      workstream: "Testing & reliability",
    },
    priority: 2,
    status: "closed",
  });
  const inReview = makeBead({
    id: "coven-agents-review",
    metadata: {
      projectStatus: "In review",
      runner: "Control plane",
      size: "S",
      workstream: "Security & privacy",
    },
    priority: 0,
    status: "open",
  });

  const closedItem = projectBead(closed, [closed]);
  const reviewItem = projectBead(inReview, [inReview]);

  assert.deepEqual(closedItem.fields, {
    "Bead ID": "coven-agents-closed",
    Blocked: "No",
    Priority: "P2",
    Runner: "Local",
    Size: "XL",
    Status: "Done",
    Type: "bug",
    Workstream: "Testing & reliability",
  });
  assert.equal(reviewItem.fields.Status, "In review");
  assert.equal(reviewItem.fields.Priority, "P0");
  assert.equal(reviewItem.fields.Type, "task");
});
