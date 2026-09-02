// biome-ignore-all lint/style/useDestructuring: The table-driven fixtures intentionally address exact operation positions.
import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalGitHubOperation,
  GITHUB_TOOL_LIMITS,
  githubOperationAuthority,
  githubOperationMarker,
  githubOperationRepository,
  githubOperationTarget,
  githubToolOperationSchema,
  githubToolResultSchema,
  hashGitHubOperation,
} from "./operations";

test("GitHub tool operations accept only a strict typed issue lookup", () => {
  assert.deepEqual(
    githubToolOperationSchema.parse({
      issueNumber: "42",
      kind: "issue.get",
      owner: "OpenCoven",
      repo: "coven-agents",
    }),
    {
      issueNumber: "42",
      kind: "issue.get",
      owner: "OpenCoven",
      repo: "coven-agents",
    }
  );
  assert.equal(
    githubToolOperationSchema.safeParse({
      issueNumber: "42",
      kind: "issue.get",
      method: "DELETE",
      owner: "OpenCoven",
      path: "/repos/OpenCoven/coven-agents",
      repo: "coven-agents",
    }).success,
    false
  );
});

const OPERATIONS = [
  {
    issueNumber: "42",
    kind: "issue.get",
    owner: "OpenCoven",
    repo: "coven-agents",
  },
  {
    kind: "issue.search",
    limit: 10,
    owner: "OpenCoven",
    query: "label:bug state:open",
    repo: "coven-agents",
    state: "open",
  },
  {
    assignees: ["BunsDev"],
    body: "Reproduction steps.",
    kind: "issue.create",
    labels: ["bug"],
    owner: "OpenCoven",
    repo: "coven-agents",
    title: "Gateway regression",
  },
  {
    body: "Confirmed by the focused regression.",
    issueNumber: "42",
    kind: "issue.comment",
    owner: "OpenCoven",
    repo: "coven-agents",
  },
  {
    kind: "pull.get",
    owner: "OpenCoven",
    pullNumber: "181",
    repo: "coven-agents",
  },
  {
    base: "main",
    body: "Implements the approved gateway.",
    draft: true,
    head: "feat/github-tool-gateway",
    kind: "pull.create",
    owner: "OpenCoven",
    repo: "coven-agents",
    title: "Add GitHub tool gateway",
  },
  {
    body: "The bounded review follow-up is ready.",
    kind: "pull.comment",
    owner: "OpenCoven",
    pullNumber: "181",
    repo: "coven-agents",
  },
  {
    body: "The approval fence is preserved.",
    event: "approve",
    kind: "pull.review",
    owner: "OpenCoven",
    pullNumber: "181",
    repo: "coven-agents",
  },
  {
    contentId: "I_kwDOExample",
    contentType: "issue",
    kind: "project.item.add",
    owner: "OpenCoven",
    projectId: "PVT_kwDOExample",
    repo: "coven-agents",
  },
  {
    contentId: "I_kwDOExample",
    contentType: "issue",
    fieldId: "PVTF_lADOExample",
    itemId: "PVTI_lADOExample",
    kind: "project.item.field.update",
    owner: "OpenCoven",
    projectId: "PVT_kwDOExample",
    repo: "coven-agents",
    value: { kind: "single_select", optionId: "PVTSSF_lADOExample" },
  },
] as const;

test("the operation union covers only the ten approved exact shapes", () => {
  for (const operation of OPERATIONS) {
    assert.deepEqual(githubToolOperationSchema.parse(operation), operation);
  }
  for (const operation of [
    {
      issueNumber: "42",
      kind: "issue.close",
      owner: "OpenCoven",
      repo: "coven-agents",
    },
    {
      kind: "pull.merge",
      owner: "OpenCoven",
      pullNumber: "181",
      repo: "coven-agents",
    },
    {
      kind: "repository.delete",
      owner: "OpenCoven",
      repo: "coven-agents",
    },
    {
      document: "mutation { deleteRepository(input: {}) { clientMutationId } }",
      kind: "project.item.add",
      owner: "OpenCoven",
      repo: "coven-agents",
      variables: {},
    },
  ]) {
    assert.equal(githubToolOperationSchema.safeParse(operation).success, false);
  }
});

test("operations reject arbitrary transport authority and noncanonical targets", () => {
  const base = OPERATIONS[0];
  for (const extra of [
    { headers: { authorization: "caller controlled" } },
    { method: "DELETE" },
    { path: "/repos/OpenCoven/coven-agents/issues/42" },
    { url: "https://api.github.com/user" },
    { variables: { owner: "elsewhere" } },
  ]) {
    assert.equal(
      githubToolOperationSchema.safeParse({ ...base, ...extra }).success,
      false
    );
  }
  for (const value of [
    { ...base, issueNumber: 42 },
    { ...base, issueNumber: "0" },
    { ...base, issueNumber: "01" },
    { ...base, owner: "https://github.com/OpenCoven" },
    { ...base, owner: "OpenCoven/other" },
    { ...base, repo: "../secrets" },
  ]) {
    assert.equal(githubToolOperationSchema.safeParse(value).success, false);
  }
});

test("operation text, lists, searches, refs, and typed project values are bounded", () => {
  const create = OPERATIONS[2];
  for (const value of [
    { ...create, title: "x".repeat(GITHUB_TOOL_LIMITS.titleBytes + 1) },
    { ...create, body: "🧪".repeat(GITHUB_TOOL_LIMITS.bodyBytes) },
    {
      ...create,
      labels: Array.from(
        { length: GITHUB_TOOL_LIMITS.maxLabels + 1 },
        (_, index) => `label-${index}`
      ),
    },
    {
      ...OPERATIONS[1],
      limit: GITHUB_TOOL_LIMITS.maxSearchResults + 1,
    },
    { ...OPERATIONS[5], head: "../unsafe" },
    { ...OPERATIONS[5], head: "refs/heads/main.lock" },
    {
      ...OPERATIONS[9],
      value: { kind: "number", number: Number.POSITIVE_INFINITY },
    },
    {
      ...OPERATIONS[9],
      value: { date: "2026-02-30", kind: "date" },
    },
    {
      ...OPERATIONS[9],
      value: { kind: "single_select", optionId: "../../other" },
    },
  ]) {
    assert.equal(githubToolOperationSchema.safeParse(value).success, false);
  }
  for (const value of [
    { ...OPERATIONS[9], value: { kind: "clear" } },
    {
      ...OPERATIONS[9],
      value: { date: "2026-08-31", kind: "date" },
    },
    {
      ...OPERATIONS[9],
      value: { iterationId: "PVTSI_lADOExample", kind: "iteration" },
    },
    {
      ...OPERATIONS[9],
      value: { kind: "number", number: 3.5 },
    },
    {
      ...OPERATIONS[9],
      value: { kind: "text", text: "Ready" },
    },
  ]) {
    assert.equal(githubToolOperationSchema.safeParse(value).success, true);
  }
});

test("project field updates carry the exact repository content identity to verify", () => {
  const update = OPERATIONS[9];
  assert.equal(githubToolOperationSchema.safeParse(update).success, true);
  const { contentId: _contentId, ...withoutContentId } = update;
  const { contentType: _contentType, ...withoutContentType } = update;
  assert.equal(
    githubToolOperationSchema.safeParse(withoutContentId).success,
    false
  );
  assert.equal(
    githubToolOperationSchema.safeParse(withoutContentType).success,
    false
  );
});

test("each operation maps to one immutable team capability and read/write class", () => {
  assert.deepEqual(
    OPERATIONS.map((operation) => [
      operation.kind,
      githubOperationAuthority(operation.kind),
    ]),
    [
      [
        "issue.get",
        { capability: "github.issues.read", classification: "read" },
      ],
      [
        "issue.search",
        { capability: "github.issues.read", classification: "read" },
      ],
      [
        "issue.create",
        { capability: "github.issues.write", classification: "write" },
      ],
      [
        "issue.comment",
        { capability: "github.issues.write", classification: "write" },
      ],
      [
        "pull.get",
        {
          capability: "github.pull_requests.read",
          classification: "read",
        },
      ],
      [
        "pull.create",
        {
          capability: "github.pull_requests.write",
          classification: "write",
        },
      ],
      [
        "pull.comment",
        {
          capability: "github.pull_requests.write",
          classification: "write",
        },
      ],
      [
        "pull.review",
        {
          capability: "github.pull_requests.write",
          classification: "write",
        },
      ],
      [
        "project.item.add",
        { capability: "github.projects.write", classification: "write" },
      ],
      [
        "project.item.field.update",
        { capability: "github.projects.write", classification: "write" },
      ],
    ]
  );
});

test("canonical operation hashing is stable and repository matching is case insensitive", () => {
  const operation = githubToolOperationSchema.parse(OPERATIONS[2]);
  assert.equal(operation.kind, "issue.create");
  if (operation.kind !== "issue.create") {
    throw new Error("Expected issue.create test fixture.");
  }
  const reordered = {
    assignees: [...operation.assignees],
    body: operation.body,
    kind: "issue.create" as const,
    labels: [...operation.labels],
    owner: operation.owner.toLowerCase(),
    repo: operation.repo,
    title: operation.title,
  };
  assert.equal(hashGitHubOperation(operation), hashGitHubOperation(reordered));
  assert.notEqual(
    hashGitHubOperation(operation),
    hashGitHubOperation({ ...operation, body: `${operation.body}!` })
  );
  assert.equal(githubOperationRepository(operation), "opencoven/coven-agents");
  assert.deepEqual(canonicalGitHubOperation(reordered), {
    ...operation,
    owner: "opencoven",
    repo: "coven-agents",
  });
});

test("write markers are deterministic, bounded, and carry no caller text", () => {
  const operation = githubToolOperationSchema.parse(OPERATIONS[2]);
  const marker = githubOperationMarker({
    capabilityBinding: "c".repeat(64),
    operationId: "aaaaaaaa-0000-4000-8000-000000000001",
    requestHash: hashGitHubOperation(operation),
    teamStepId: "bbbbbbbb-0000-4000-8000-000000000002",
  });

  assert.equal(
    marker,
    githubOperationMarker({
      capabilityBinding: "c".repeat(64),
      operationId: "aaaaaaaa-0000-4000-8000-000000000001",
      requestHash: hashGitHubOperation(operation),
      teamStepId: "bbbbbbbb-0000-4000-8000-000000000002",
    })
  );
  assert.match(marker, /^<!-- coven-github:v1:[a-f0-9]{40} -->$/u);
  assert.notEqual(
    marker,
    githubOperationMarker({
      capabilityBinding: "d".repeat(64),
      operationId: "aaaaaaaa-0000-4000-8000-000000000001",
      requestHash: hashGitHubOperation(operation),
      teamStepId: "bbbbbbbb-0000-4000-8000-000000000002",
    })
  );
  assert.ok(Buffer.byteLength(marker, "utf8") <= 80);
  assert.doesNotMatch(marker, /Gateway regression|Reproduction/u);
});

test("public receipt targets are deterministic and exclude caller-authored text", () => {
  assert.deepEqual(
    OPERATIONS.map((operation) =>
      githubOperationTarget(githubToolOperationSchema.parse(operation))
    ),
    [
      "opencoven/coven-agents#issue.get:42",
      "opencoven/coven-agents#issue.search:sha256:5e9dd94abfa9dffc6701eabdba20bee87c6c1e5a",
      "opencoven/coven-agents#issue.create:sha256:8dd76f1f1b9a18803caa96f1778faf21886d8715",
      "opencoven/coven-agents#issue.comment:42",
      "opencoven/coven-agents#pull.get:181",
      "opencoven/coven-agents#pull.create:sha256:400fe64d166eb2f09f296204c3eca66d1b433218",
      "opencoven/coven-agents#pull.comment:181",
      "opencoven/coven-agents#pull.review:181",
      "opencoven/coven-agents#project.item.add:sha256:95f359366c4c7636804374db762ff8be3d100f61",
      "opencoven/coven-agents#project.item.field.update:sha256:59c6cbc1bfe5b2ef41e65d616bbbb39fe5ef425b",
    ]
  );
  assert.doesNotMatch(
    OPERATIONS.map((operation) =>
      githubOperationTarget(githubToolOperationSchema.parse(operation))
    ).join("\n"),
    /Gateway regression|Reproduction steps|Approved/u
  );
});

test("every maximum valid operation has a deterministic UTF-8 receipt target within 512 bytes", () => {
  const owner = "o".repeat(100);
  const repo = "r".repeat(100);
  const node = "N".repeat(256);
  const maximumOperations = [
    {
      issueNumber: "9".repeat(20),
      kind: "issue.get",
      owner,
      repo,
    },
    {
      kind: "issue.search",
      limit: GITHUB_TOOL_LIMITS.maxSearchResults,
      owner,
      query: "q".repeat(GITHUB_TOOL_LIMITS.queryBytes),
      repo,
      state: "all",
    },
    {
      assignees: [],
      body: "",
      kind: "issue.create",
      labels: [],
      owner,
      repo,
      title: "t".repeat(GITHUB_TOOL_LIMITS.titleBytes),
    },
    {
      body: "b",
      issueNumber: "9".repeat(20),
      kind: "issue.comment",
      owner,
      repo,
    },
    {
      kind: "pull.get",
      owner,
      pullNumber: "9".repeat(20),
      repo,
    },
    {
      base: `b${"x".repeat(GITHUB_TOOL_LIMITS.branchBytes - 1)}`,
      body: "",
      draft: false,
      head: `h${"y".repeat(GITHUB_TOOL_LIMITS.branchBytes - 1)}`,
      kind: "pull.create",
      owner,
      repo,
      title: "t",
    },
    {
      body: "b",
      kind: "pull.comment",
      owner,
      pullNumber: "9".repeat(20),
      repo,
    },
    {
      body: "",
      event: "approve",
      kind: "pull.review",
      owner,
      pullNumber: "9".repeat(20),
      repo,
    },
    {
      contentId: node,
      contentType: "issue",
      kind: "project.item.add",
      owner,
      projectId: node,
      repo,
    },
    {
      contentId: node,
      contentType: "pull",
      fieldId: node,
      itemId: node,
      kind: "project.item.field.update",
      owner,
      projectId: node,
      repo,
      value: { kind: "clear" },
    },
  ] as const;

  for (const value of maximumOperations) {
    const operation = githubToolOperationSchema.parse(value);
    const first = githubOperationTarget(operation);
    const second = githubOperationTarget(operation);
    assert.equal(first, second);
    assert.ok(Buffer.byteLength(first, "utf8") <= 512, operation.kind);
    assert.match(first, new RegExp(`^${owner}/${repo}#${operation.kind}`, "u"));
  }
});

test("public operation results are discriminated, strict, and bounded", () => {
  const issueResult = {
    issue: {
      body: "Bounded public body.",
      nodeId: "I_kwDOExample",
      number: "42",
      state: "open",
      title: "Gateway regression",
      url: "https://github.com/OpenCoven/coven-agents/issues/42",
    },
    kind: "issue.get",
    repository: "OpenCoven/coven-agents",
  } as const;
  assert.deepEqual(githubToolResultSchema.parse(issueResult), issueResult);
  assert.equal(
    githubToolResultSchema.safeParse({
      ...issueResult,
      providerBody: { installation_token: "must never pass through" },
    }).success,
    false
  );
  assert.equal(
    githubToolResultSchema.safeParse({
      ...issueResult,
      issue: {
        ...issueResult.issue,
        body: "x".repeat(GITHUB_TOOL_LIMITS.resultBodyBytes + 1),
      },
    }).success,
    false
  );
  assert.equal(
    githubToolResultSchema.safeParse({
      items: Array.from(
        { length: GITHUB_TOOL_LIMITS.maxSearchResults + 1 },
        () => issueResult.issue
      ),
      kind: "issue.search",
      repository: "OpenCoven/coven-agents",
    }).success,
    false
  );
});
