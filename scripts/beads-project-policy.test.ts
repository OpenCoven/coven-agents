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

function beadMap(...beads: Bead[]): Map<string, Bead> {
  return new Map(beads.map((bead) => [bead.id, bead]));
}

function expectedBody(
  beadId: string,
  parent: string | undefined,
  activeDependencies: readonly string[]
): string {
  return [
    `${MARKER_PREFIX}${beadId} -->`,
    "",
    "## Objective",
    "",
    "Description.",
    "",
    "## Acceptance criteria",
    "",
    "Acceptance criteria.",
    "",
    "## Tracking",
    "",
    `- Bead: \`${beadId}\``,
    `- Parent: ${parent ? `\`${parent}\`` : "None"}`,
    `- Active dependencies: ${
      activeDependencies.length > 0
        ? activeDependencies.map((dependency) => `\`${dependency}\``).join(", ")
        : "None"
    }`,
  ].join("\n");
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

function expectInvalidBeadId(run: () => void, field: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, new RegExp(`^${field}: invalid bead id$`));
    assert.ok(!error.message.includes("/api/agents"));
    return true;
  });
}

test("rejects sensitive content categories", () => {
  expectUnsafe("title", "sk-live-abc123", /provider token/i);
  expectUnsafe("description", "xoxb-1234567890", /provider token/i);
  expectUnsafe(
    "description",
    "github_pat_1234567890abcdefghijklmnopqrstuvwxyz",
    /github token/i
  );
  expectUnsafe("acceptance", "AWS_KEY=supersecret", /env assignment/i);
  expectUnsafe("acceptance", "API_TOKEN = value", /env assignment/i);
  expectUnsafe("description", "Authorization: ******", /authorization header/i);
  expectUnsafe(
    "acceptance",
    "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    /pem private key/i
  );
});

test("rejects authentication headers and command output markers", () => {
  expectUnsafe(
    "description",
    "Authorization: Bearer token",
    /authorization header/i
  );
  expectUnsafe(
    "description",
    "Run curl -H 'Authorization: Bearer token' https://example.com",
    /authorization header/i
  );

  expectUnsafe(
    "description",
    "Proxy-Authorization: Basic abc",
    /authorization header/i
  );
  expectUnsafe("description", "X-API-Key: secret", /api key header/i);
  expectUnsafe("description", "Cookie: session=abc", /cookie header/i);
  expectUnsafe("description", "Set-Cookie: session=abc", /cookie header/i);
  expectUnsafe("description", "$ npm run build", /shell prompt/i);
  expectUnsafe("description", "stdout: build complete", /stdout marker/i);
  expectUnsafe("description", "stderr: failed", /stderr marker/i);
  expectUnsafe(
    "description",
    "2026-08-23 05:35:51 INFO build complete",
    /timestamped log line/i
  );
  expectUnsafe("description", "[ERROR] build failed", /log level marker/i);
  expectUnsafe("description", "Logged in to GitHub", /login output/i);
});

test("rejects absolute paths and overlong title", () => {
  expectUnsafe("description", "/Users/alice/private.txt", /absolute path/i);
  expectUnsafe("description", "/home/alice/private.txt", /absolute path/i);
  expectUnsafe("description", "/private/secret.txt", /absolute path/i);
  expectUnsafe("description", "/tmp/cache.bin", /absolute path/i);
  expectUnsafe("description", "/var/log/app.log", /absolute path/i);
  expectUnsafe("description", "/etc/passwd", /absolute path/i);
  expectUnsafe("description", "/opt/tools/bin", /absolute path/i);
  expectUnsafe("description", "/usr/local/bin/node", /absolute path/i);
  expectUnsafe("description", "/Volumes/Data/archive.zip", /absolute path/i);
  expectUnsafe(
    "description",
    "file:///Users/alice/private.txt",
    /absolute path/i
  );
  expectUnsafe(
    "description",
    "path=/Users/alice/private.txt",
    /absolute path/i
  );
  expectUnsafe(
    "description",
    "D:\\Users\\alice\\private.txt",
    /absolute path/i
  );
  expectUnsafe("description", "C:\\temp\\build.log", /absolute path/i);
  assert.throws(
    () => validateSafeText("title", "x".repeat(121)),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /120/);
      return true;
    }
  );
});

test("allows ordinary API route prose", () => {
  assert.doesNotThrow(() =>
    validateSafeText("description", "Use /api/agents to list agents.")
  );

  const item = projectBead(
    makeBead({
      acceptance_criteria: "Use /api/agents in the product copy.",
      description: "Document the /api/agents route in prose.",
      id: "coven-agents-route-prose",
      title: "Keep API route prose allowed",
    }),
    beadMap()
  );

  assert.equal(item.fields["Bead ID"], "coven-agents-route-prose");
});

test("rejects malformed parent and dependency bead ids", () => {
  expectInvalidBeadId(
    () =>
      projectBead(
        makeBead({
          id: "/api/agents",
        }),
        beadMap()
      ),
    "bead.id"
  );

  expectInvalidBeadId(
    () =>
      projectBead(
        makeBead({
          parent: "/api/agents",
        }),
        beadMap()
      ),
    "parent"
  );

  expectInvalidBeadId(
    () =>
      projectBead(
        makeBead({
          dependencies: [
            {
              depends_on_id: "coven-agents-parent",
              issue_id: "/api/agents",
              type: "blocks",
            },
          ],
        }),
        beadMap()
      ),
    "dependency issue_id"
  );

  expectInvalidBeadId(
    () =>
      projectBead(
        makeBead({
          dependencies: [
            {
              depends_on_id: "/api/agents",
              issue_id: "coven-agents-child",
              type: "blocks",
            },
          ],
        }),
        beadMap()
      ),
    "dependency depends_on_id"
  );
});

test("projects the security fixture deterministically", () => {
  const security = makeBead({
    acceptance_criteria: "The roadmap item is visible in the project board.",
    dependencies: [
      {
        depends_on_id: "coven-agents-security",
        issue_id: "coven-agents-security.1",
        type: "blocks",
      },
    ],
    description: "Add redaction to the sync projection.",
    id: "coven-agents-security.1",
    parent: "coven-agents-security",
    status: "in_progress",
    title: "Add secret redaction",
  });

  const item = projectBead(security, beadMap(security));

  assert.equal(item.fields["Bead ID"], "coven-agents-security.1");
  assert.equal(
    item.body,
    [
      `${MARKER_PREFIX}coven-agents-security.1 -->`,
      "",
      "## Objective",
      "",
      "Add redaction to the sync projection.",
      "",
      "## Acceptance criteria",
      "",
      "The roadmap item is visible in the project board.",
      "",
      "## Tracking",
      "",
      "- Bead: `coven-agents-security.1`",
      "- Parent: `coven-agents-security`",
      "- Active dependencies: `coven-agents-security`",
    ].join("\n")
  );
});

test("parent-child dependency alone does not block", () => {
  const parent = makeBead({
    id: "coven-agents-parent",
  });
  const child = makeBead({
    dependencies: [
      {
        depends_on_id: "coven-agents-parent",
        issue_id: "coven-agents-child-parent-child",
        type: "parent-child",
      },
    ],
    id: "coven-agents-child-parent-child",
    parent: "coven-agents-parent",
  });

  const item = projectBead(child, beadMap(parent, child));

  assert.equal(item.fields.Blocked, "No");
  assert.equal(
    item.body,
    expectedBody("coven-agents-child-parent-child", "coven-agents-parent", [])
  );
});

test("blocks dependency on parent still blocks", () => {
  const parent = makeBead({
    id: "coven-agents-parent",
  });
  const child = makeBead({
    dependencies: [
      {
        depends_on_id: "coven-agents-parent",
        issue_id: "coven-agents-child-blocked",
        type: "parent-child",
      },
      {
        depends_on_id: "coven-agents-parent",
        issue_id: "coven-agents-child-blocked",
        type: "blocks",
      },
    ],
    id: "coven-agents-child-blocked",
    parent: "coven-agents-parent",
  });

  const item = projectBead(child, beadMap(parent, child));

  assert.equal(item.fields.Blocked, "Yes");
  assert.equal(
    item.body,
    expectedBody("coven-agents-child-blocked", "coven-agents-parent", [
      "coven-agents-parent",
    ])
  );
});

test("closed dependency does not block", () => {
  const closedBlocker = makeBead({
    id: "coven-agents-closed-blocker",
    status: "closed",
  });
  const child = makeBead({
    dependencies: [
      {
        depends_on_id: "coven-agents-closed-blocker",
        issue_id: "coven-agents-child-closed",
        type: "blocks",
      },
    ],
    id: "coven-agents-child-closed",
  });

  const item = projectBead(child, beadMap(closedBlocker, child));

  assert.equal(item.fields.Blocked, "No");
  assert.equal(
    item.body,
    expectedBody("coven-agents-child-closed", undefined, [])
  );
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

  const closedItem = projectBead(closed, beadMap(closed));
  const reviewItem = projectBead(inReview, beadMap(inReview));

  assert.deepEqual(closedItem.fields, {
    "Bead ID": "coven-agents-closed",
    "Bead Type": "bug",
    Blocked: "No",
    Priority: "P2",
    Runner: "Local",
    Size: "XL",
    Status: "Done",
    Workstream: "Testing & reliability",
  });
  assert.equal(reviewItem.fields.Status, "In review");
  assert.equal(reviewItem.fields.Priority, "P0");
  assert.equal(reviewItem.fields["Bead Type"], "task");
});

test("honors metadata In Progress for open beads", () => {
  const bead = makeBead({
    id: "coven-agents-in-progress",
    metadata: {
      projectStatus: "In Progress",
      runner: "Shared",
      size: "M",
      workstream: "Product",
    },
    status: "open",
  });

  const item = projectBead(bead, beadMap(bead));

  assert.equal(item.fields.Status, "In Progress");
});

test("keeps stored in_progress and metadata Todo/default mappings", () => {
  const storedInProgress = makeBead({
    id: "coven-agents-stored-in-progress",
    metadata: {
      projectStatus: "Todo",
      runner: "Shared",
      size: "M",
      workstream: "Product",
    },
    status: "in_progress",
  });
  const explicitTodo = makeBead({
    id: "coven-agents-explicit-todo",
    metadata: {
      projectStatus: "Todo",
      runner: "Shared",
      size: "M",
      workstream: "Product",
    },
  });
  const defaultTodo = makeBead({
    id: "coven-agents-default-todo",
  });

  const storedInProgressItem = projectBead(
    storedInProgress,
    beadMap(storedInProgress)
  );
  const explicitTodoItem = projectBead(explicitTodo, beadMap(explicitTodo));
  const defaultTodoItem = projectBead(defaultTodo, beadMap(defaultTodo));

  assert.equal(storedInProgressItem.fields.Status, "In Progress");
  assert.equal(explicitTodoItem.fields.Status, "Todo");
  assert.equal(defaultTodoItem.fields.Status, "Todo");
});
