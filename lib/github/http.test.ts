// biome-ignore-all lint/performance/noAwaitInLoops lint/suspicious/useAwait: Provider and HTTP doubles intentionally exercise sequential boundaries.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { GitHubToolOperation } from "@opencoven/agent-contracts";
import { GITHUB_TOOL_SERVER_DEADLINE_MS } from "@opencoven/agent-contracts";
import type { GitHubOperationExecutionContext } from "./capability";
import {
  createGitHubOperationProvider,
  createGitHubToolGateway,
  createGitHubToolHttpHandler,
  GitHubToolGatewayError,
  GitHubToolProviderError,
} from "./http";
import { githubOperationMarker, hashGitHubOperation } from "./operations";

const OPERATION = {
  issueNumber: "42",
  kind: "issue.get" as const,
  owner: "OpenCoven",
  repo: "coven-agents",
};
const currentAuthority = () => Promise.resolve();

function context(
  operation: GitHubToolOperation = OPERATION,
  marker: string | null = null
): GitHubOperationExecutionContext {
  const write = !["issue.get", "issue.search", "pull.get"].includes(
    operation.kind
  );
  const requiredCapability = operation.kind.startsWith("issue.")
    ? `github.issues.${write ? "write" : "read"}`
    : operation.kind.startsWith("pull.")
      ? `github.pull_requests.${write ? "write" : "read"}`
      : operation.kind === "repository.commit"
        ? "github.contents.write"
        : "github.projects.write";
  return {
    accountId: "123",
    accountLogin: "OpenCoven",
    accountType: "Organization",
    actorUserId: "99999999-9999-4999-8999-999999999999",
    capability: {
      allowedCapabilities: [requiredCapability] as never,
      approvedCapabilities: write ? ([requiredCapability] as never) : [],
      attemptId: "11111111-1111-4111-8111-111111111111",
      authVersion: 7,
      connectionGeneration: 3,
      createdAt: new Date("2026-08-31T20:00:00.000Z"),
      declaredCapabilities: [requiredCapability] as never,
      expiresAt: new Date("2026-08-31T20:10:00.000Z"),
      id: "22222222-2222-4222-8222-222222222222",
      maxCallCount: 32,
      repositoryAllowlist: ["opencoven/coven-agents"],
      revokedAt: null,
      runnerRunId: "33333333-3333-4333-8333-333333333333",
      teamRunId: "44444444-4444-4444-8444-444444444444",
      teamStepId: "55555555-5555-4555-8555-555555555555",
      tenant: "u_9c8589018a57479181fe4c455b099bc9",
      tokenHash: "a".repeat(64),
      usedCallCount: 1,
      version: 1,
    },
    connectionId: "66666666-6666-4666-8666-666666666666",
    installationId: "456",
    operation: {
      accountId: "123",
      accountLogin: "OpenCoven",
      accountType: "Organization",
      capabilityId: "22222222-2222-4222-8222-222222222222",
      completedAt: null,
      connectionGeneration: 3,
      connectionId: "66666666-6666-4666-8666-666666666666",
      createdAt: new Date("2026-08-31T20:00:00.000Z"),
      error: null,
      executionLeaseExpiresAt: new Date("2026-08-31T20:00:30.000Z"),
      id: "77777777-7777-4777-8777-777777777777",
      installationId: "456",
      kind: operation.kind,
      operationId: "88888888-8888-4888-8888-888888888888",
      operationMarker: marker,
      projectAuthorityBound:
        operation.kind === "project.item.add" ||
        operation.kind === "project.item.field.update",
      projectId:
        operation.kind === "project.item.add" ||
        operation.kind === "project.item.field.update"
          ? operation.projectId
          : null,
      providerDispatchPhase: write ? "pre_send" : "not_applicable",
      providerRequestId: null,
      providerSentAt: null,
      repository: "opencoven/coven-agents",
      repositoryId: "789",
      repositoryName: "coven-agents",
      repositoryNodeId: "R_kgDOExample",
      repositoryOwner: "OpenCoven",
      requestHash: "b".repeat(64),
      requiredCapability: requiredCapability as never,
      result: null,
      resultNodeId: null,
      resultUrl: null,
      startedAt: new Date("2026-08-31T20:00:00.000Z"),
      status: "running",
      target: "opencoven/coven-agents#issue.get:42",
      teamStepId: "55555555-5555-4555-8555-555555555555",
      tenant: "u_9c8589018a57479181fe4c455b099bc9",
      updatedAt: new Date("2026-08-31T20:00:00.000Z"),
      version: 0,
      writeIntentActive: write,
    },
    repositoryId: "789",
    repositoryName: "coven-agents",
    repositoryNodeId: "R_kgDOExample",
    repositoryOwner: "OpenCoven",
  };
}

type CapturedRequest = {
  body: string | null;
  headers: Headers;
  method: string;
  url: string;
};

function sequenceProvider(
  responses: readonly Response[],
  options: Readonly<{ maxResponseBytes?: number; timeoutMs?: number }> = {}
) {
  const queue = [...responses];
  const requests: CapturedRequest[] = [];
  const scopes: unknown[] = [];
  const provider = createGitHubOperationProvider({
    fetch: async (url, init) => {
      requests.push({
        body: typeof init?.body === "string" ? init.body : null,
        headers: new Headers(init?.headers),
        method: init?.method ?? "GET",
        url,
      });
      const response = queue.shift();
      if (!response) {
        throw new Error("Unexpected provider request.");
      }
      return response;
    },
    ...options,
    withInstallationAuthorization: async (scope, operation) => {
      scopes.push(scope);
      return operation("Bearer installation-token");
    },
  });
  return { provider, requests, scopes };
}

function issue(overrides: Record<string, unknown> = {}) {
  return {
    body: "Bounded public body.",
    html_url: "https://github.com/OpenCoven/coven-agents/issues/42",
    node_id: "I_kwDOExample",
    number: 42,
    state: "open",
    title: "Gateway regression",
    ...overrides,
  };
}

function pull(overrides: Record<string, unknown> = {}) {
  return {
    base: { ref: "main" },
    body: "Bounded public body.",
    draft: false,
    head: { ref: "feat/github-tool-gateway" },
    html_url: "https://github.com/OpenCoven/coven-agents/pull/181",
    merged: false,
    node_id: "PR_kwDOExample",
    number: 181,
    state: "open",
    title: "Gateway regression",
    ...overrides,
  };
}

test("issue.get uses one repository-scoped read request and returns a sanitized result", async () => {
  const requests: Array<{ init?: RequestInit; url: string }> = [];
  const scopes: unknown[] = [];
  const provider = createGitHubOperationProvider({
    fetch: (url, init) => {
      requests.push({ init, url });
      return Promise.resolve(
        Response.json(
          {
            body: "Bounded public body.",
            html_url: "https://github.com/OpenCoven/coven-agents/issues/42",
            node_id: "I_kwDOExample",
            number: 42,
            state: "open",
            title: "Gateway regression",
          },
          { headers: { "x-github-request-id": "ABC1:DEF2" } }
        )
      );
    },
    withInstallationAuthorization: async (scope, operation) => {
      scopes.push(scope);
      return operation("Bearer installation-token");
    },
  });

  const result = await provider.execute({
    authorizeMutation: () => Promise.resolve(false),
    context: context(),
    mode: "execute",
    operation: OPERATION,
  });

  assert.deepEqual(scopes, [
    {
      installationId: "456",
      permissions: { issues: "read", metadata: "read" },
      repositoryIds: ["789"],
    },
  ]);
  assert.equal(
    requests[0]?.url,
    "https://api.github.com/repos/OpenCoven/coven-agents/issues/42"
  );
  assert.equal(requests[0]?.init?.method, "GET");
  assert.equal(
    new Headers(requests[0]?.init?.headers).get("authorization"),
    "Bearer installation-token"
  );
  assert.deepEqual(result, {
    providerRequestId: "ABC1:DEF2",
    result: {
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
    },
    resultNodeId: "I_kwDOExample",
    resultUrl: "https://github.com/OpenCoven/coven-agents/issues/42",
  });
});

test("issue.search pins the authoritative repository, state, page, and result limit", async () => {
  const operation = {
    kind: "issue.search" as const,
    limit: 2,
    owner: "OpenCoven",
    query: "label:bug repo:attacker/elsewhere",
    repo: "coven-agents",
    state: "open" as const,
  };
  const sequence = sequenceProvider([
    Response.json({ items: [issue()], total_count: 1 }),
  ]);

  const result = await sequence.provider.execute({
    authorizeMutation: () => Promise.resolve(false),
    context: context(operation),
    mode: "execute",
    operation,
  });

  const url = new URL(sequence.requests[0]?.url ?? "");
  assert.equal(url.pathname, "/search/issues");
  assert.equal(url.searchParams.get("per_page"), "2");
  assert.equal(url.searchParams.get("page"), "1");
  assert.match(
    url.searchParams.get("q") ?? "",
    /repo:OpenCoven\/coven-agents/u
  );
  assert.match(url.searchParams.get("q") ?? "", /is:issue/u);
  assert.match(url.searchParams.get("q") ?? "", /is:open/u);
  assert.equal(result.result.kind, "issue.search");
  assert.equal(
    result.result.kind === "issue.search" && result.result.items.length,
    1
  );
});

test("issue and pull writes use exact REST endpoints, marker bodies, and mutation revalidation", async () => {
  const marker =
    "<!-- coven-github:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->";
  const cases: Array<{
    expectedBody: Record<string, unknown>;
    expectedMutationPath: string;
    expectedPermissions: Record<string, "read" | "write">;
    operation: GitHubToolOperation;
    responses: Response[];
  }> = [
    {
      expectedBody: {
        assignees: ["BunsDev"],
        body: `Issue body.\n\n${marker}`,
        labels: ["bug"],
        title: "Gateway issue",
      },
      expectedMutationPath: "/repos/OpenCoven/coven-agents/issues",
      expectedPermissions: { issues: "write", metadata: "read" },
      operation: {
        assignees: ["BunsDev"],
        body: "Issue body.",
        kind: "issue.create",
        labels: ["bug"],
        owner: "OpenCoven",
        repo: "coven-agents",
        title: "Gateway issue",
      },
      responses: [Response.json(issue())],
    },
    {
      expectedBody: { body: `Issue comment.\n\n${marker}` },
      expectedMutationPath: "/repos/OpenCoven/coven-agents/issues/42/comments",
      expectedPermissions: { issues: "write", metadata: "read" },
      operation: {
        body: "Issue comment.",
        issueNumber: "42",
        kind: "issue.comment",
        owner: "OpenCoven",
        repo: "coven-agents",
      },
      responses: [
        Response.json(issue()),
        Response.json({
          html_url:
            "https://github.com/OpenCoven/coven-agents/issues/42#issuecomment-1",
          node_id: "IC_kwDOExample",
        }),
      ],
    },
    {
      expectedBody: {
        base: "main",
        body: `Pull body.\n\n${marker}`,
        draft: true,
        head: "feat/github-tool-gateway",
        title: "Gateway pull",
      },
      expectedMutationPath: "/repos/OpenCoven/coven-agents/pulls",
      expectedPermissions: {
        metadata: "read",
        pull_requests: "write",
      },
      operation: {
        base: "main",
        body: "Pull body.",
        draft: true,
        head: "feat/github-tool-gateway",
        kind: "pull.create",
        owner: "OpenCoven",
        repo: "coven-agents",
        title: "Gateway pull",
      },
      responses: [Response.json(pull())],
    },
    {
      expectedBody: { body: `Pull comment.\n\n${marker}` },
      expectedMutationPath: "/repos/OpenCoven/coven-agents/issues/181/comments",
      expectedPermissions: {
        metadata: "read",
        pull_requests: "write",
      },
      operation: {
        body: "Pull comment.",
        kind: "pull.comment",
        owner: "OpenCoven",
        pullNumber: "181",
        repo: "coven-agents",
      },
      responses: [
        Response.json(pull()),
        Response.json({
          html_url:
            "https://github.com/OpenCoven/coven-agents/pull/181#issuecomment-2",
          node_id: "IC_kwDOExample2",
        }),
      ],
    },
    {
      expectedBody: {
        body: `Approved.\n\n${marker}`,
        event: "APPROVE",
      },
      expectedMutationPath: "/repos/OpenCoven/coven-agents/pulls/181/reviews",
      expectedPermissions: {
        metadata: "read",
        pull_requests: "write",
      },
      operation: {
        body: "Approved.",
        event: "approve",
        kind: "pull.review",
        owner: "OpenCoven",
        pullNumber: "181",
        repo: "coven-agents",
      },
      responses: [
        Response.json(pull()),
        Response.json({
          body: `Approved.\n\n${marker}`,
          html_url:
            "https://github.com/OpenCoven/coven-agents/pull/181#pullrequestreview-1",
          node_id: "PRR_kwDOExample",
          state: "APPROVED",
        }),
      ],
    },
  ];

  for (const value of cases) {
    const sequence = sequenceProvider(value.responses);
    let authorizations = 0;
    await sequence.provider.execute({
      authorizeMutation: () => {
        authorizations += 1;
        return Promise.resolve(true);
      },
      context: context(value.operation, marker),
      mode: "execute",
      operation: value.operation,
    });

    const mutation = sequence.requests.find(({ method }) => method === "POST");
    assert.equal(
      new URL(mutation?.url ?? "").pathname,
      value.expectedMutationPath
    );
    assert.deepEqual(JSON.parse(mutation?.body ?? ""), value.expectedBody);
    assert.deepEqual(sequence.scopes, [
      {
        installationId: "456",
        permissions: value.expectedPermissions,
        repositoryIds: ["789"],
      },
    ]);
    assert.equal(authorizations, 1);
  }
});

test("repository.commit publishes one bounded branch commit through Git data", async () => {
  const marker =
    "<!-- coven-github:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->";
  const baseSha = "1".repeat(40);
  const baseTreeSha = "2".repeat(40);
  const sourceTreeSha = "6".repeat(40);
  const blobSha = "3".repeat(40);
  const treeSha = "4".repeat(40);
  const commitSha = "5".repeat(40);
  const operation = {
    base: "main",
    branch: "feat/familiar-delivery",
    files: [
      {
        content: "export const delivered = true;\n",
        operation: "upsert" as const,
        path: "src/delivery.ts",
      },
      { operation: "delete" as const, path: "src/obsolete.ts" },
    ],
    kind: "repository.commit" as const,
    message: "feat: deliver familiar changes",
    owner: "OpenCoven",
    repo: "coven-agents",
  };
  const sequence = sequenceProvider([
    Response.json({ message: "Not Found" }, { status: 404 }),
    Response.json({
      object: { sha: baseSha, type: "commit" },
      ref: "refs/heads/main",
    }),
    Response.json({ sha: baseSha, tree: { sha: baseTreeSha } }),
    Response.json({
      sha: baseTreeSha,
      tree: [
        {
          mode: "040000",
          path: "src",
          sha: sourceTreeSha,
          type: "tree",
        },
      ],
      truncated: false,
    }),
    Response.json({
      sha: sourceTreeSha,
      tree: [
        {
          mode: "100755",
          path: "delivery.ts",
          sha: "7".repeat(40),
          type: "blob",
        },
      ],
      truncated: false,
    }),
    Response.json({ sha: blobSha }),
    Response.json({ sha: treeSha }),
    Response.json({
      html_url: `https://github.com/OpenCoven/coven-agents/commit/${commitSha}`,
      message: `${operation.message}\n\n${marker}`,
      parents: [{ sha: baseSha }],
      sha: commitSha,
      tree: { sha: treeSha },
    }),
    Response.json(
      {
        object: { sha: commitSha, type: "commit" },
        ref: `refs/heads/${operation.branch}`,
      },
      { status: 201 }
    ),
  ]);
  let authorizations = 0;

  const result = await sequence.provider.execute({
    authorizeMutation: () => {
      authorizations += 1;
      return Promise.resolve(true);
    },
    context: context(operation, marker),
    mode: "execute",
    operation,
  });

  assert.deepEqual(sequence.scopes, [
    {
      installationId: "456",
      permissions: { contents: "write", metadata: "read" },
      repositoryIds: ["789"],
    },
  ]);
  assert.equal(authorizations, 2);
  assert.deepEqual(
    sequence.requests.map(({ method, url }) => [method, new URL(url).pathname]),
    [
      [
        "GET",
        "/repos/OpenCoven/coven-agents/git/ref/heads/feat%2Ffamiliar-delivery",
      ],
      ["GET", "/repos/OpenCoven/coven-agents/git/ref/heads/main"],
      ["GET", `/repos/OpenCoven/coven-agents/git/commits/${baseSha}`],
      ["GET", `/repos/OpenCoven/coven-agents/git/trees/${baseTreeSha}`],
      ["GET", `/repos/OpenCoven/coven-agents/git/trees/${sourceTreeSha}`],
      ["POST", "/repos/OpenCoven/coven-agents/git/blobs"],
      ["POST", "/repos/OpenCoven/coven-agents/git/trees"],
      ["POST", "/repos/OpenCoven/coven-agents/git/commits"],
      ["POST", "/repos/OpenCoven/coven-agents/git/refs"],
    ]
  );
  assert.deepEqual(JSON.parse(sequence.requests[5]?.body ?? ""), {
    content: operation.files[0].content,
    encoding: "utf-8",
  });
  assert.deepEqual(JSON.parse(sequence.requests[6]?.body ?? ""), {
    base_tree: baseTreeSha,
    tree: [
      {
        mode: "100755",
        path: "src/delivery.ts",
        sha: blobSha,
        type: "blob",
      },
      {
        mode: "100644",
        path: "src/obsolete.ts",
        sha: null,
        type: "blob",
      },
    ],
  });
  assert.deepEqual(JSON.parse(sequence.requests[7]?.body ?? ""), {
    message: `${operation.message}\n\n${marker}`,
    parents: [baseSha],
    tree: treeSha,
  });
  assert.deepEqual(JSON.parse(sequence.requests[8]?.body ?? ""), {
    ref: `refs/heads/${operation.branch}`,
    sha: commitSha,
  });
  assert.deepEqual(result, {
    providerRequestId: null,
    result: {
      branch: operation.branch,
      commit: {
        sha: commitSha,
        url: `https://github.com/OpenCoven/coven-agents/commit/${commitSha}`,
      },
      kind: "repository.commit",
      repository: "OpenCoven/coven-agents",
    },
    resultNodeId: commitSha,
    resultUrl: `https://github.com/OpenCoven/coven-agents/commit/${commitSha}`,
  });
});

test("repository.commit rechecks authority before publishing the branch ref", async () => {
  const marker =
    "<!-- coven-github:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->";
  const baseSha = "1".repeat(40);
  const baseTreeSha = "2".repeat(40);
  const blobSha = "3".repeat(40);
  const treeSha = "4".repeat(40);
  const commitSha = "5".repeat(40);
  const operation = {
    base: "main",
    branch: "feat/familiar-delivery",
    files: [
      {
        content: "export const delivered = true;\n",
        operation: "upsert" as const,
        path: "delivery.ts",
      },
    ],
    kind: "repository.commit" as const,
    message: "feat: deliver familiar changes",
    owner: "OpenCoven",
    repo: "coven-agents",
  };
  const sequence = sequenceProvider([
    Response.json({ message: "Not Found" }, { status: 404 }),
    Response.json({
      object: { sha: baseSha, type: "commit" },
      ref: "refs/heads/main",
    }),
    Response.json({ sha: baseSha, tree: { sha: baseTreeSha } }),
    Response.json({ sha: baseTreeSha, tree: [], truncated: false }),
    Response.json({ sha: blobSha }),
    Response.json({ sha: treeSha }),
    Response.json({
      html_url: `https://github.com/OpenCoven/coven-agents/commit/${commitSha}`,
      message: `${operation.message}\n\n${marker}`,
      parents: [{ sha: baseSha }],
      sha: commitSha,
      tree: { sha: treeSha },
    }),
  ]);
  let authorizations = 0;

  await assert.rejects(
    sequence.provider.execute({
      authorizeMutation: () => {
        authorizations += 1;
        return Promise.resolve(authorizations === 1);
      },
      context: context(operation, marker),
      mode: "execute",
      operation,
    }),
    (error: unknown) =>
      error instanceof GitHubToolProviderError &&
      error.code === "github_operation_authority_changed"
  );
  assert.equal(authorizations, 2);
  assert.equal(
    sequence.requests.some(
      ({ method, url }) =>
        method === "POST" && new URL(url).pathname.endsWith("/git/refs")
    ),
    false
  );
});

test("repository.commit recovers only the exact marked branch tip", async () => {
  const operation = {
    base: "main",
    branch: "feat/familiar-delivery",
    files: [
      {
        content: "export const enabled = true;\n",
        operation: "upsert" as const,
        path: "src/feature.ts",
      },
    ],
    kind: "repository.commit" as const,
    message: "feat: add familiar delivery",
    owner: "OpenCoven",
    repo: "coven-agents",
  };
  const marker =
    "<!-- coven-github:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->";
  const commit = {
    html_url:
      "https://github.com/OpenCoven/coven-agents/commit/2222222222222222222222222222222222222222",
    message: `${operation.message}\n\n${marker}`,
    node_id: "C_kwDOExample",
    sha: "2222222222222222222222222222222222222222",
    tree: { sha: "3333333333333333333333333333333333333333" },
  };
  const recovered = sequenceProvider([
    Response.json({
      object: {
        sha: commit.sha,
        type: "commit",
      },
      ref: "refs/heads/feat/familiar-delivery",
    }),
    Response.json(commit),
  ]);

  const result = await recovered.provider.execute({
    authorizeMutation: () => Promise.resolve(false),
    context: context(operation, marker),
    mode: "recover",
    operation,
  });
  assert.deepEqual(result.result, {
    branch: operation.branch,
    commit: {
      sha: commit.sha,
      url: commit.html_url,
    },
    kind: "repository.commit",
    repository: "OpenCoven/coven-agents",
  });

  const foreignSha = "4444444444444444444444444444444444444444";
  const foreign = sequenceProvider([
    Response.json({
      object: {
        sha: foreignSha,
        type: "commit",
      },
      ref: "refs/heads/feat/familiar-delivery",
    }),
    Response.json({
      ...commit,
      message: "feat: unrelated branch",
      sha: foreignSha,
    }),
  ]);
  await assert.rejects(
    foreign.provider.execute({
      authorizeMutation: () => Promise.resolve(false),
      context: context(operation, marker),
      mode: "execute",
      operation,
    }),
    (error: unknown) =>
      error instanceof GitHubToolProviderError &&
      error.code === "github_target_mismatch"
  );
});

test("repository.commit rejects symlink and submodule upserts before mutation authority", async () => {
  for (const entry of [
    { mode: "120000", type: "blob" },
    { mode: "160000", type: "commit" },
  ] as const) {
    const baseSha = "1".repeat(40);
    const baseTreeSha = "2".repeat(40);
    const operation = {
      base: "main",
      branch: "feat/familiar-delivery",
      files: [
        {
          content: "replacement\n",
          operation: "upsert" as const,
          path: "target",
        },
      ],
      kind: "repository.commit" as const,
      message: "feat: replace target",
      owner: "OpenCoven",
      repo: "coven-agents",
    };
    const sequence = sequenceProvider([
      Response.json({ message: "Not Found" }, { status: 404 }),
      Response.json({
        object: { sha: baseSha, type: "commit" },
        ref: "refs/heads/main",
      }),
      Response.json({ sha: baseSha, tree: { sha: baseTreeSha } }),
      Response.json({
        sha: baseTreeSha,
        tree: [
          {
            ...entry,
            path: "target",
            sha: "3".repeat(40),
          },
        ],
        truncated: false,
      }),
    ]);
    let authorizations = 0;

    await assert.rejects(
      sequence.provider.execute({
        authorizeMutation: () => {
          authorizations += 1;
          return Promise.resolve(true);
        },
        context: context(
          operation,
          "<!-- coven-github:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->"
        ),
        mode: "execute",
        operation,
      }),
      (error: unknown) =>
        error instanceof GitHubToolProviderError &&
        error.code === "github_target_mismatch"
    );
    assert.equal(authorizations, 0);
    assert.equal(
      sequence.requests.some(({ method }) => method === "POST"),
      false
    );
  }
});

test("mutation authority is revalidated immediately after target verification and before the provider write", async () => {
  const marker =
    "<!-- coven-github:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->";
  const operation = {
    body: "Issue comment.",
    issueNumber: "42",
    kind: "issue.comment" as const,
    owner: "OpenCoven",
    repo: "coven-agents",
  };
  const timeline: string[] = [];
  const responses = [
    Response.json(issue()),
    Response.json({
      html_url:
        "https://github.com/OpenCoven/coven-agents/issues/42#issuecomment-1",
      node_id: "IC_kwDOExample",
    }),
  ];
  const provider = createGitHubOperationProvider({
    fetch: (_url, init) => {
      timeline.push(init?.method ?? "GET");
      const response = responses.shift();
      if (!response) {
        throw new Error("Unexpected provider request.");
      }
      return Promise.resolve(response);
    },
    withInstallationAuthorization: async (_scope, callback) =>
      callback("Bearer installation-token"),
  });

  await provider.execute({
    authorizeMutation: () => {
      timeline.push("authorize");
      return Promise.resolve(true);
    },
    context: context(operation, marker),
    mode: "execute",
    operation,
  });

  assert.deepEqual(timeline, ["GET", "authorize", "POST"]);
});

test("write recovery finds deterministic markers and never issues a second mutation", async () => {
  const marker =
    "<!-- coven-github:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->";
  const operation = {
    assignees: [] as string[],
    body: "Issue body.",
    kind: "issue.create" as const,
    labels: [] as string[],
    owner: "OpenCoven",
    repo: "coven-agents",
    title: "Gateway issue",
  };
  const found = sequenceProvider([
    Response.json({
      items: [issue({ body: `Issue body.\n\n${marker}` })],
      total_count: 1,
    }),
  ]);
  let authorizations = 0;

  const result = await found.provider.execute({
    authorizeMutation: () => {
      authorizations += 1;
      return Promise.resolve(true);
    },
    context: context(operation, marker),
    mode: "recover",
    operation,
  });

  assert.equal(result.result.kind, "issue.create");
  assert.equal(
    result.result.kind === "issue.create" && result.result.issue.body,
    "Issue body."
  );
  assert.doesNotMatch(JSON.stringify(result), /coven-github:v1/u);
  assert.equal(found.requests.length, 1);
  assert.equal(found.requests[0]?.method, "GET");
  assert.equal(authorizations, 0);

  const absent = sequenceProvider([
    Response.json({ items: [], total_count: 0 }),
  ]);
  await assert.rejects(
    absent.provider.execute({
      authorizeMutation: () => Promise.resolve(true),
      context: context(operation, marker),
      mode: "recover",
      operation,
    }),
    (error: unknown) =>
      error instanceof GitHubToolProviderError &&
      error.code === "github_write_uncertain" &&
      error.uncertain &&
      !error.retryable
  );
  assert.equal(absent.requests.length, 1);
});

test("pull review recovery checks the newest paginated reviews", async () => {
  const marker =
    "<!-- coven-github:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->";
  const operation = {
    body: "Approved.",
    event: "approve" as const,
    kind: "pull.review" as const,
    owner: "OpenCoven",
    pullNumber: "181",
    repo: "coven-agents",
  };
  const sequence = sequenceProvider([
    Response.json([], {
      headers: {
        link: '<https://api.github.com/repositories/789/pulls/181/reviews?per_page=100&page=3>; rel="last"',
      },
    }),
    Response.json([
      {
        body: `Approved.\n\n${marker}`,
        html_url:
          "https://github.com/OpenCoven/coven-agents/pull/181#pullrequestreview-3",
        node_id: "PRR_kwDOExample3",
        state: "APPROVED",
      },
    ]),
  ]);

  const result = await sequence.provider.execute({
    authorizeMutation: () => Promise.resolve(false),
    context: context(operation, marker),
    mode: "recover",
    operation,
  });

  assert.equal(result.result.kind, "pull.review");
  assert.deepEqual(
    sequence.requests.map(({ url }) => url),
    [
      "https://api.github.com/repos/OpenCoven/coven-agents/pulls/181/reviews?per_page=100&page=1",
      "https://api.github.com/repos/OpenCoven/coven-agents/pulls/181/reviews?per_page=100&page=3",
    ]
  );
});

test("issue comment recovery checks the newest paginated comments", async () => {
  const marker =
    "<!-- coven-github:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->";
  const operation = {
    body: "Issue comment.",
    issueNumber: "42",
    kind: "issue.comment" as const,
    owner: "OpenCoven",
    repo: "coven-agents",
  };
  const sequence = sequenceProvider([
    Response.json([], {
      headers: {
        link: '<https://api.github.com/repositories/789/issues/42/comments?per_page=100&page=4>; rel="last"',
      },
    }),
    Response.json([
      {
        body: `Issue comment.\n\n${marker}`,
        html_url:
          "https://github.com/OpenCoven/coven-agents/issues/42#issuecomment-4",
        node_id: "IC_kwDOExample4",
      },
    ]),
  ]);

  const result = await sequence.provider.execute({
    authorizeMutation: () => Promise.resolve(false),
    context: context(operation, marker),
    mode: "recover",
    operation,
  });

  assert.equal(result.result.kind, "issue.comment");
  assert.deepEqual(
    sequence.requests.map(({ url }) => url),
    [
      "https://api.github.com/repos/OpenCoven/coven-agents/issues/42/comments?per_page=100&page=1",
      "https://api.github.com/repos/OpenCoven/coven-agents/issues/42/comments?per_page=100&page=4",
    ]
  );
});

test("pull.get is bounded and rejects an issue-shaped target", async () => {
  const operation = {
    kind: "pull.get" as const,
    owner: "OpenCoven",
    pullNumber: "181",
    repo: "coven-agents",
  };
  const sequence = sequenceProvider([Response.json(pull())]);
  const result = await sequence.provider.execute({
    authorizeMutation: () => Promise.resolve(false),
    context: context(operation),
    mode: "execute",
    operation,
  });
  assert.equal(result.result.kind, "pull.get");
  assert.equal(
    new URL(sequence.requests[0]?.url ?? "").pathname,
    "/repos/OpenCoven/coven-agents/pulls/181"
  );
  assert.deepEqual(sequence.scopes, [
    {
      installationId: "456",
      permissions: { metadata: "read", pull_requests: "read" },
      repositoryIds: ["789"],
    },
  ]);

  for (const [targetOperation, response] of [
    [OPERATION, Response.json(issue({ number: 43 }))],
    [operation, Response.json(pull({ number: 182 }))],
  ] as const) {
    const mismatched = sequenceProvider([response]);
    await assert.rejects(
      mismatched.provider.execute({
        authorizeMutation: () => Promise.resolve(false),
        context: context(targetOperation),
        mode: "execute",
        operation: targetOperation,
      }),
      (error: unknown) =>
        error instanceof GitHubToolProviderError &&
        error.code === "github_target_mismatch"
    );
  }
});

test("project add and field update use fixed GraphQL documents and verify repository identities", async () => {
  const marker =
    "<!-- coven-github:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->";
  const add = {
    contentId: "I_kwDOExample",
    contentType: "issue" as const,
    kind: "project.item.add" as const,
    owner: "OpenCoven",
    projectId: "PVT_kwDOExample",
    repo: "coven-agents",
  };
  const addSequence = sequenceProvider([
    Response.json({
      data: {
        content: {
          __typename: "Issue",
          id: add.contentId,
          repository: {
            databaseId: 789,
            nameWithOwner: "OpenCoven/coven-agents",
          },
        },
        project: {
          id: add.projectId,
          items: {
            nodes: [],
            pageInfo: { endCursor: "cursor-1", hasNextPage: true },
          },
          owner: { login: "OpenCoven" },
        },
      },
    }),
    Response.json({
      data: {
        content: {
          __typename: "Issue",
          id: add.contentId,
          repository: {
            databaseId: 789,
            nameWithOwner: "OpenCoven/coven-agents",
          },
        },
        project: {
          id: add.projectId,
          items: {
            nodes: [],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
          owner: { login: "OpenCoven" },
        },
      },
    }),
    Response.json({
      data: {
        addProjectV2ItemById: {
          item: { id: "PVTI_lADOExample" },
        },
      },
    }),
  ]);
  let addAuthorizations = 0;
  const added = await addSequence.provider.execute({
    authorizeMutation: () => {
      addAuthorizations += 1;
      return Promise.resolve(true);
    },
    context: context(add, marker),
    mode: "execute",
    operation: add,
  });
  assert.equal(added.result.kind, "project.item.add");
  assert.equal(addAuthorizations, 1);
  const addBodies = addSequence.requests.map(({ body }) =>
    JSON.parse(body ?? "")
  );
  assert.equal(addBodies[0].operationName, "CovenProjectItemAddTargets");
  assert.deepEqual(addBodies[0].variables, {
    after: null,
    contentId: add.contentId,
    projectId: add.projectId,
  });
  assert.equal(addBodies[1].operationName, "CovenProjectItemAddTargets");
  assert.deepEqual(addBodies[1].variables, {
    after: "cursor-1",
    contentId: add.contentId,
    projectId: add.projectId,
  });
  assert.equal(addBodies[2].operationName, "CovenProjectItemAdd");
  assert.deepEqual(addBodies[2].variables, {
    contentId: add.contentId,
    projectId: add.projectId,
  });
  assert.doesNotMatch(addBodies[2].query, /delete|merge|workflow|secret/iu);

  const update = {
    contentId: add.contentId,
    contentType: "issue" as const,
    fieldId: "PVTF_lADOExample",
    itemId: "PVTI_lADOExample",
    kind: "project.item.field.update" as const,
    owner: "OpenCoven",
    projectId: add.projectId,
    repo: "coven-agents",
    value: { kind: "text" as const, text: "Ready" },
  };
  const updateSequence = sequenceProvider([
    Response.json({
      data: {
        item: {
          content: {
            __typename: "Issue",
            id: update.contentId,
            repository: {
              databaseId: 789,
              nameWithOwner: "OpenCoven/coven-agents",
            },
          },
          fieldValues: { nodes: [] },
          id: update.itemId,
          project: { id: update.projectId },
        },
        project: {
          fields: { nodes: [{ id: update.fieldId }] },
          id: update.projectId,
          owner: { login: "OpenCoven" },
        },
      },
    }),
    Response.json({
      data: {
        updateProjectV2ItemFieldValue: {
          projectV2Item: { id: update.itemId },
        },
      },
    }),
  ]);
  const updated = await updateSequence.provider.execute({
    authorizeMutation: () => Promise.resolve(true),
    context: context(update, marker),
    mode: "execute",
    operation: update,
  });
  assert.equal(updated.result.kind, "project.item.field.update");
  const updateMutation = JSON.parse(updateSequence.requests[1]?.body ?? "");
  assert.equal(updateMutation.operationName, "CovenProjectItemFieldUpdate");
  assert.deepEqual(updateMutation.variables, {
    fieldId: update.fieldId,
    itemId: update.itemId,
    projectId: update.projectId,
    value: { text: "Ready" },
  });
});

test("project add deadline exhaustion remains proven pre-send", async () => {
  const operation = {
    contentId: "I_kwDOExample",
    contentType: "issue" as const,
    kind: "project.item.add" as const,
    owner: "OpenCoven",
    projectId: "PVT_kwDOExample",
    repo: "coven-agents",
  };
  let authorizations = 0;
  let now = 0;
  let requests = 0;
  const provider = createGitHubOperationProvider({
    clock: () => now,
    fetch: async () => {
      requests += 1;
      now = 101;
      return Response.json({
        data: {
          content: {
            __typename: "Issue",
            id: operation.contentId,
            repository: {
              databaseId: 789,
              nameWithOwner: "OpenCoven/coven-agents",
            },
          },
          project: {
            id: operation.projectId,
            items: {
              nodes: [],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
            owner: { login: "OpenCoven" },
          },
        },
      });
    },
    withInstallationAuthorization: async (_scope, callback) =>
      callback("******"),
  });

  await assert.rejects(
    provider.execute({
      authorizeMutation: () => {
        authorizations += 1;
        return Promise.resolve(true);
      },
      context: context(operation),
      deadlineAt: 100,
      mode: "execute",
      operation,
    }),
    (error: unknown) =>
      error instanceof GitHubToolProviderError &&
      error.code === "github_provider_timeout" &&
      error.mutationMayHaveReached === false &&
      error.retryable
  );
  assert.equal(authorizations, 0);
  assert.equal(requests, 1);
});

test("project operations request only verified organization project authority and reject user installations", async () => {
  const operation = {
    contentId: "I_kwDOExample",
    contentType: "issue" as const,
    kind: "project.item.add" as const,
    owner: "OpenCoven",
    projectId: "PVT_kwDOExample",
    repo: "coven-agents",
  };
  const org = sequenceProvider([
    Response.json({
      data: {
        content: {
          __typename: "Issue",
          id: operation.contentId,
          repository: {
            databaseId: 789,
            nameWithOwner: "OpenCoven/coven-agents",
          },
        },
        project: {
          id: operation.projectId,
          items: {
            nodes: [
              {
                content: { id: operation.contentId },
                id: "PVTI_lADOExample",
              },
            ],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
          owner: { login: "OpenCoven" },
        },
      },
    }),
  ]);
  await org.provider.execute({
    authorizeMutation: () => Promise.resolve(false),
    context: context(operation),
    mode: "execute",
    operation,
  });
  assert.deepEqual(org.scopes, [
    {
      installationId: "456",
      permissions: {
        issues: "read",
        metadata: "read",
        organization_projects: "write",
      },
      repositoryIds: ["789"],
    },
  ]);

  let tokenRequests = 0;
  const userProvider = createGitHubOperationProvider({
    fetch: () => {
      throw new Error("user project operations must fail before provider work");
    },
    withInstallationAuthorization: async (_scope, callback) => {
      tokenRequests += 1;
      return callback("Bearer installation-token");
    },
  });
  await assert.rejects(
    userProvider.execute({
      authorizeMutation: () => Promise.resolve(true),
      context: { ...context(operation), accountType: "User" },
      mode: "execute",
      operation,
    }),
    (error: unknown) =>
      error instanceof GitHubToolProviderError &&
      error.code === "github_project_installation_unsupported"
  );
  assert.equal(tokenRequests, 0);
});

test("project field recovery ignores unsupported mixed union values and compares only typed supported shapes", async () => {
  const marker =
    "<!-- coven-github:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->";
  const operation = {
    contentId: "I_kwDOExample",
    contentType: "issue" as const,
    fieldId: "PVTF_lADOExample",
    itemId: "PVTI_lADOExample",
    kind: "project.item.field.update" as const,
    owner: "OpenCoven",
    projectId: "PVT_kwDOExample",
    repo: "coven-agents",
    value: { kind: "text" as const, text: "Ready" },
  };
  const mixedValues = [
    {
      __typename: "ProjectV2ItemFieldRepositoryValue",
      field: { id: "PVTF_repository" },
    },
    {
      __typename: "ProjectV2ItemFieldLabelValue",
      field: { id: "PVTF_labels" },
    },
    {
      __typename: "ProjectV2ItemFieldMilestoneValue",
      field: { id: "PVTF_milestone" },
    },
    {
      __typename: "ProjectV2ItemFieldMultiSelectValue",
      field: { id: "PVTF_multi_select" },
    },
    {
      __typename: "ProjectV2ItemFieldPullRequestValue",
      field: { id: "PVTF_pull_requests" },
    },
    {
      __typename: "ProjectV2ItemFieldUserValue",
      field: { id: "PVTF_assignees" },
    },
    {
      __typename: "ProjectV2ItemFieldReviewerValue",
      field: { id: "PVTF_reviewers" },
    },
    {
      __typename: "ProjectV2ItemIssueFieldValue",
      field: { id: "PVTF_issue_field" },
    },
    {
      __typename: "ProjectV2ItemFieldTextValue",
      field: { id: "PVTF_other" },
      text: "Ready",
    },
  ];
  const targetResponse = (fieldValues: unknown[]) =>
    Response.json({
      data: {
        item: {
          content: {
            __typename: "Issue",
            id: operation.contentId,
            repository: {
              databaseId: 789,
              nameWithOwner: "OpenCoven/coven-agents",
            },
          },
          fieldValues: { nodes: fieldValues },
          id: operation.itemId,
          project: { id: operation.projectId },
        },
        project: {
          fields: { nodes: [{ id: operation.fieldId }] },
          id: operation.projectId,
          owner: { login: "OpenCoven" },
        },
      },
    });
  const execute = sequenceProvider([
    targetResponse(mixedValues),
    Response.json({
      data: {
        updateProjectV2ItemFieldValue: {
          projectV2Item: { id: operation.itemId },
        },
      },
    }),
  ]);

  const updated = await execute.provider.execute({
    authorizeMutation: () => Promise.resolve(true),
    context: context(operation, marker),
    mode: "execute",
    operation,
  });
  assert.equal(updated.result.kind, "project.item.field.update");
  assert.equal(
    execute.requests.filter(({ method }) => method === "POST").length,
    2
  );
  const query = JSON.parse(execute.requests[0]?.body ?? "").query as string;
  assert.match(query, /nodes \{\s*__typename/u);
  for (const typename of [
    "ProjectV2ItemFieldLabelValue",
    "ProjectV2ItemFieldMilestoneValue",
    "ProjectV2ItemFieldMultiSelectValue",
    "ProjectV2ItemFieldPullRequestValue",
    "ProjectV2ItemFieldRepositoryValue",
    "ProjectV2ItemFieldReviewerValue",
    "ProjectV2ItemFieldUserValue",
    "ProjectV2ItemIssueFieldValue",
  ]) {
    assert.match(
      query,
      new RegExp(
        `\\.\\.\\. on ${typename} \\{ field \\{ \\.\\.\\. on ProjectV2FieldCommon \\{ id \\} \\} \\}`,
        "u"
      )
    );
  }

  const recovered = sequenceProvider([
    targetResponse([
      ...mixedValues,
      {
        __typename: "ProjectV2ItemFieldTextValue",
        field: { id: operation.fieldId },
        text: "Ready",
      },
    ]),
  ]);
  const result = await recovered.provider.execute({
    authorizeMutation: () => Promise.resolve(false),
    context: context(operation, marker),
    mode: "recover",
    operation,
  });
  assert.equal(result.result.kind, "project.item.field.update");
  assert.equal(recovered.requests.length, 1);

  const clearOperation = {
    ...operation,
    value: { kind: "clear" as const },
  };
  const unclearedUnsupportedValue = sequenceProvider([
    targetResponse([
      {
        __typename: "ProjectV2ItemFieldRepositoryValue",
        field: { id: operation.fieldId },
      },
    ]),
  ]);
  await assert.rejects(
    unclearedUnsupportedValue.provider.execute({
      authorizeMutation: () => Promise.resolve(false),
      context: context(clearOperation, marker),
      mode: "recover",
      operation: clearOperation,
    }),
    (error: unknown) =>
      error instanceof GitHubToolProviderError &&
      error.code === "github_write_uncertain"
  );
});

test("provider timeout, rate limits, oversize bodies, malformed JSON, and unsafe request ids are sanitized", async () => {
  const hanging = createGitHubOperationProvider({
    fetch: (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      }),
    timeoutMs: 5,
    withInstallationAuthorization: async (_scope, operation) =>
      operation("Bearer installation-token"),
  });
  await assert.rejects(
    hanging.execute({
      authorizeMutation: () => Promise.resolve(false),
      context: context(),
      mode: "execute",
      operation: OPERATION,
    }),
    (error: unknown) =>
      error instanceof GitHubToolProviderError &&
      error.code === "github_provider_timeout"
  );

  for (const response of [
    new Response("rate body must not escape", {
      headers: {
        "x-github-request-id": "unsafe request id with spaces",
        "x-ratelimit-remaining": "0",
      },
      status: 403,
    }),
    new Response("x".repeat(33), {
      headers: { "content-length": "33" },
      status: 200,
    }),
    new Response("{malformed", { status: 200 }),
  ]) {
    const sequence = sequenceProvider([response], { maxResponseBytes: 32 });
    await assert.rejects(
      sequence.provider.execute({
        authorizeMutation: () => Promise.resolve(false),
        context: context(),
        mode: "execute",
        operation: OPERATION,
      }),
      (error: unknown) => {
        assert.ok(error instanceof GitHubToolProviderError);
        assert.doesNotMatch(
          error.message,
          /rate body|malformed|installation-token/u
        );
        assert.equal(error.providerRequestId, null);
        return true;
      }
    );
  }
});

test("pull preflight rate limits remain proven pre-send", async () => {
  const operation = {
    body: "Pull comment.",
    kind: "pull.comment" as const,
    owner: "OpenCoven",
    pullNumber: "181",
    repo: "coven-agents",
  };
  const sequence = sequenceProvider([
    new Response("rate limited", {
      headers: { "retry-after": "1" },
      status: 429,
    }),
  ]);
  let authorizationCalls = 0;

  await assert.rejects(
    sequence.provider.execute({
      authorizeMutation: async () => {
        authorizationCalls += 1;
        return true;
      },
      context: context(
        operation,
        "<!-- coven-github:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->"
      ),
      mode: "execute",
      operation,
    }),
    (error: unknown) =>
      error instanceof GitHubToolProviderError &&
      error.code === "github_provider_rate_limited" &&
      error.retryable === true &&
      error.mutationMayHaveReached === false
  );
  assert.equal(authorizationCalls, 0);
  assert.deepEqual(
    sequence.requests.map(({ method }) => method),
    ["GET"]
  );
});

test("provider timeout bounds a response body that sends headers and never completes", {
  timeout: 150,
}, async () => {
  const provider = createGitHubOperationProvider({
    fetch: () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start() {
              // The provider intentionally never closes this body.
            },
          }),
          { status: 200 }
        )
      ),
    timeoutMs: 5,
    withInstallationAuthorization: (_scope, callback) =>
      callback("Bearer installation-token"),
  });

  {
    let now = 10_000;
    const deadlineProvider = createGitHubOperationProvider({
      clock: () => now,
      fetch: () => {
        now = 69_999;
        return Promise.resolve(Response.json(issue()));
      },
      timeoutMs: 5000,
      withInstallationAuthorization: (_scope, callback) =>
        callback("Bearer installation-token"),
    });
    await assert.rejects(
      deadlineProvider.execute({
        authorizeMutation: () => Promise.resolve(false),
        context: context(),
        deadlineAt: 9999,
        mode: "execute",
        operation: OPERATION,
      }),
      (error: unknown) =>
        error instanceof GitHubToolProviderError &&
        error.code === "github_provider_timeout"
    );

    const result = await deadlineProvider.execute({
      authorizeMutation: () => Promise.resolve(false),
      context: context(),
      deadlineAt: 70_000,
      mode: "execute",
      operation: OPERATION,
    });
    assert.equal(result.result.kind, "issue.get");
  }

  await assert.rejects(
    provider.execute({
      authorizeMutation: () => Promise.resolve(false),
      context: context(),
      mode: "execute",
      operation: OPERATION,
    }),
    (error: unknown) =>
      error instanceof GitHubToolProviderError &&
      error.code === "github_provider_timeout"
  );
});

test("an ambiguous write response recovers by marker or terminates uncertain without replay", async () => {
  const marker =
    "<!-- coven-github:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->";
  const operation = {
    body: "Issue comment.",
    issueNumber: "42",
    kind: "issue.comment" as const,
    owner: "OpenCoven",
    repo: "coven-agents",
  };
  const recovered = sequenceProvider([
    Response.json(issue()),
    new Response("provider unavailable", { status: 503 }),
    Response.json([
      {
        body: `Issue comment.\n\n${marker}`,
        html_url:
          "https://github.com/OpenCoven/coven-agents/issues/42#issuecomment-1",
        node_id: "IC_kwDOExample",
      },
    ]),
  ]);
  const result = await recovered.provider.execute({
    authorizeMutation: () => Promise.resolve(true),
    context: context(operation, marker),
    mode: "execute",
    operation,
  });
  assert.equal(result.result.kind, "issue.comment");
  assert.equal(
    recovered.requests.filter(({ method }) => method === "POST").length,
    1
  );

  const uncertain = sequenceProvider([
    Response.json(issue()),
    new Response("provider unavailable", { status: 503 }),
    Response.json([]),
  ]);
  await assert.rejects(
    uncertain.provider.execute({
      authorizeMutation: () => Promise.resolve(true),
      context: context(operation, marker),
      mode: "execute",
      operation,
    }),
    (error: unknown) =>
      error instanceof GitHubToolProviderError &&
      error.code === "github_write_uncertain" &&
      error.uncertain
  );
  assert.equal(
    uncertain.requests.filter(({ method }) => method === "POST").length,
    1
  );
});

test("a 2xx mutation body reset is recovered by marker and never becomes replayable", async () => {
  const marker =
    "<!-- coven-github:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->";
  const operation = {
    assignees: [] as string[],
    body: "Issue body.",
    kind: "issue.create" as const,
    labels: [] as string[],
    owner: "OpenCoven",
    repo: "coven-agents",
    title: "Gateway issue",
  };
  const resetBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"number":'));
      controller.error(new Error("response reset after provider commit"));
    },
  });
  const recovered = sequenceProvider([
    new Response(resetBody, { status: 201 }),
    Response.json({
      items: [issue({ body: `Issue body.\n\n${marker}` })],
      total_count: 1,
    }),
  ]);

  const result = await recovered.provider.execute({
    authorizeMutation: () => Promise.resolve(true),
    context: context(operation, marker),
    mode: "execute",
    operation,
  });

  assert.equal(result.result.kind, "issue.create");
  assert.equal(
    recovered.requests.filter(({ method }) => method === "POST").length,
    1
  );
  assert.equal(
    recovered.requests.filter(({ method }) => method === "GET").length,
    1
  );
});

test("a structurally malformed 2xx mutation result recovers before any replay", async () => {
  const marker =
    "<!-- coven-github:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->";
  const operation = {
    assignees: [] as string[],
    body: "Issue body.",
    kind: "issue.create" as const,
    labels: [] as string[],
    owner: "OpenCoven",
    repo: "coven-agents",
    title: "Gateway issue",
  };
  const recovered = sequenceProvider([
    Response.json({ number: 42 }, { status: 201 }),
    Response.json({
      items: [issue({ body: `Issue body.\n\n${marker}` })],
      total_count: 1,
    }),
  ]);

  const result = await recovered.provider.execute({
    authorizeMutation: () => Promise.resolve(true),
    context: context(operation, marker),
    mode: "execute",
    operation,
  });

  assert.equal(result.result.kind, "issue.create");
  assert.equal(
    recovered.requests.filter(({ method }) => method === "POST").length,
    1
  );
  assert.equal(
    recovered.requests.filter(({ method }) => method === "GET").length,
    1
  );
});

test("timeout after mutation send becomes terminal uncertainty after one recovery probe", async () => {
  const marker =
    "<!-- coven-github:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->";
  const operation = {
    assignees: [] as string[],
    body: "Issue body.",
    kind: "issue.create" as const,
    labels: [] as string[],
    owner: "OpenCoven",
    repo: "coven-agents",
    title: "Gateway issue",
  };
  const requests: string[] = [];
  const provider = createGitHubOperationProvider({
    fetch: (url, init) => {
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if ((init?.method ?? "GET") === "POST") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true }
          );
        });
      }
      return Promise.resolve(Response.json({ items: [], total_count: 0 }));
    },
    timeoutMs: 5,
    withInstallationAuthorization: (_scope, callback) =>
      callback("Bearer installation-token"),
  });

  await assert.rejects(
    provider.execute({
      authorizeMutation: () => Promise.resolve(true),
      context: context(operation, marker),
      mode: "execute",
      operation,
    }),
    (error: unknown) =>
      error instanceof GitHubToolProviderError &&
      error.code === "github_write_uncertain" &&
      error.retryable === false
  );
  assert.equal(
    requests.filter((request) => request.startsWith("POST ")).length,
    1
  );
  assert.equal(
    requests.filter((request) => request.startsWith("GET ")).length,
    1
  );
});

test("gateway hashes the raw capability, reserves once, revalidates mutations, and persists the bounded receipt", async () => {
  const rawCapability = Buffer.alloc(32, 0x4a).toString("base64url");
  const operation = {
    body: "Issue comment.",
    issueNumber: "42",
    kind: "issue.comment" as const,
    owner: "OpenCoven",
    repo: "coven-agents",
  };
  const operationId = "88888888-8888-4888-8888-888888888888";
  const reservedContext = context(
    operation,
    githubOperationMarker({
      capabilityBinding: createHash("sha256")
        .update(Buffer.alloc(32, 0x4a).toString("base64url"), "utf8")
        .digest("hex"),
      operationId,
      requestHash: hashGitHubOperation(operation),
      teamStepId: "55555555-5555-4555-8555-555555555555",
    })
  );
  const dispatchedOperation = {
    ...reservedContext.operation,
    providerDispatchPhase: "sent" as const,
    providerSentAt: new Date("2026-08-31T20:00:01.000Z"),
    version: 1,
  };
  const completedOperation = {
    ...dispatchedOperation,
    completedAt: new Date("2026-08-31T20:00:02.000Z"),
    providerRequestId: "ABC1:DEF2",
    result: {
      comment: {
        nodeId: "IC_kwDOExample",
        url: "https://github.com/OpenCoven/coven-agents/issues/42#issuecomment-1",
      },
      kind: "issue.comment" as const,
      repository: "OpenCoven/coven-agents",
    },
    resultNodeId: "IC_kwDOExample",
    resultUrl:
      "https://github.com/OpenCoven/coven-agents/issues/42#issuecomment-1",
    status: "completed" as const,
    version: 2,
  };
  const calls: [string, unknown][] = [];
  const gateway = createGitHubToolGateway({
    clock: () => new Date("2026-08-31T20:00:00.000Z"),
    createId: () => reservedContext.operation.id,
    operator: { kind: "runner-operator" },
    provider: {
      execute: async (input) => {
        calls.push(["provider", input]);
        assert.equal(
          input.deadlineAt,
          new Date("2026-08-31T20:00:00.000Z").getTime() +
            GITHUB_TOOL_SERVER_DEADLINE_MS
        );
        assert.equal(await input.authorizeMutation(), true);
        return {
          providerRequestId: "ABC1:DEF2",
          result: completedOperation.result as never,
          resultNodeId: "IC_kwDOExample",
          resultUrl: completedOperation.resultUrl,
        };
      },
    },
    refreshAuthority: currentAuthority,
    store: {
      authorizeMutation: async (_operator, input) => {
        calls.push(["authorizeMutation", input]);
        return {
          kind: "authorized" as const,
          operation: dispatchedOperation,
        };
      },
      completeOperation: async (_operator, input) => {
        calls.push(["complete", input]);
        return {
          kind: "completed" as const,
          operation: completedOperation,
        };
      },
      failOperation: async () => {
        throw new Error("successful execution must not fail");
      },
      releaseOperationForRetry: async () => {
        throw new Error("successful execution must not release");
      },
      reserveOperation: async (_operator, input) => {
        calls.push(["reserve", input]);
        return {
          context: reservedContext,
          kind: "reserved" as const,
        };
      },
    },
  });

  const response = await gateway.execute({
    operation,
    operationId: reservedContext.operation.operationId,
    rawCapability,
  });

  const reservation = calls[0]?.[1] as Record<string, unknown>;
  assert.equal(
    reservation.tokenHash,
    await crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(rawCapability))
      .then((digest) => Buffer.from(digest).toString("hex"))
  );
  assert.equal(JSON.stringify(calls).includes(rawCapability), false);
  assert.equal(reservation.requestHash, hashGitHubOperation(operation));
  assert.equal("operationMarker" in reservation, false);
  const providerCall = calls.find(([name]) => name === "provider");
  assert.ok(providerCall);
  assert.equal((providerCall[1] as { mode: string }).mode, "execute");
  const completion = calls.find(([name]) => name === "complete")?.[1] as {
    expectedVersion?: number;
  };
  assert.equal(completion.expectedVersion, dispatchedOperation.version);
  assert.deepEqual(response, {
    receipt: {
      completedAt: "2026-08-31T20:00:02.000Z",
      id: completedOperation.id,
      kind: "issue.comment",
      providerRequestId: "ABC1:DEF2",
      requestHash: completedOperation.requestHash,
      resultNodeId: "IC_kwDOExample",
      resultUrl: completedOperation.resultUrl,
      status: "completed",
      stepId: completedOperation.teamStepId,
      target: completedOperation.target,
    },
    result: completedOperation.result,
  });
});

test("gateway revalidates current user authority after reservation and before provider execution", async () => {
  const rawCapability = Buffer.alloc(32, 0x6a).toString("base64url");
  const reserved = context();
  let providerCalls = 0;
  let refreshCalls = 0;
  const gateway = createGitHubToolGateway({
    clock: () => new Date("2026-08-31T20:00:00.000Z"),
    createId: () => reserved.operation.id,
    operator: { kind: "runner-operator" },
    provider: {
      execute: async () => {
        providerCalls += 1;
        throw new Error("stale user authority must not reach GitHub");
      },
    },
    refreshAuthority: async () => {
      refreshCalls += 1;
      throw new GitHubToolProviderError("github_operation_authority_changed", {
        retryable: false,
        status: 409,
      });
    },
    store: {
      authorizeMutation: async () => ({ kind: "unauthorized" as const }),
      completeOperation: async () => {
        throw new Error("authority failure must not complete");
      },
      failOperation: async (_operator, input) => ({
        kind: "failed" as const,
        operation: {
          ...reserved.operation,
          completedAt: new Date("2026-08-31T20:00:01.000Z"),
          error: input.error,
          status: "failed" as const,
          version: 1,
        },
      }),
      releaseOperationForRetry: async () => ({ kind: "stale" as const }),
      reserveOperation: async () => ({
        context: reserved,
        kind: "reserved" as const,
      }),
    },
  });

  await assert.rejects(
    gateway.execute({
      operation: OPERATION,
      operationId: reserved.operation.operationId,
      rawCapability,
    }),
    (error: unknown) =>
      error instanceof GitHubToolGatewayError &&
      error.code === "github_operation_authority_changed" &&
      error.retryable === false
  );
  assert.equal(refreshCalls, 1);
  assert.equal(providerCalls, 0);
});

test("a blocked authority refresh is aborted within its gateway phase budget before provider execution", {
  timeout: 500,
}, async () => {
  const rawCapability = Buffer.alloc(32, 0x6b).toString("base64url");
  const reserved = context();
  let providerCalls = 0;
  let refreshAborted = false;
  const gateway = createGitHubToolGateway({
    authorityRefreshTimeoutMs: 10,
    clock: () => new Date("2026-08-31T20:00:00.000Z"),
    createId: () => reserved.operation.id,
    operator: { kind: "runner-operator" },
    provider: {
      execute: async () => {
        providerCalls += 1;
        throw new Error("timed-out authority must not reach GitHub");
      },
    },
    refreshAuthority: async (input: {
      abortSignal?: AbortSignal;
      deadlineAt?: number;
    }) => {
      assert.equal(
        input.deadlineAt,
        new Date("2026-08-31T20:00:00.000Z").getTime() +
          GITHUB_TOOL_SERVER_DEADLINE_MS
      );
      if (!input.abortSignal) {
        return new Promise<void>(() => undefined);
      }
      return new Promise<void>((_resolve, reject) => {
        input.abortSignal?.addEventListener(
          "abort",
          () => {
            refreshAborted = true;
            reject(input.abortSignal?.reason);
          },
          { once: true }
        );
      });
    },
    store: {
      authorizeMutation: async () => ({ kind: "unauthorized" as const }),
      completeOperation: async () => {
        throw new Error("authority timeout must not complete");
      },
      failOperation: async (_operator, input) => ({
        kind: "failed" as const,
        operation: {
          ...reserved.operation,
          completedAt: new Date("2026-08-31T20:00:01.000Z"),
          error: input.error,
          status: "failed" as const,
          version: 1,
        },
      }),
      releaseOperationForRetry: async () => ({ kind: "stale" as const }),
      reserveOperation: async () => ({
        context: reserved,
        kind: "reserved" as const,
      }),
    },
  });

  await assert.rejects(
    gateway.execute({
      operation: OPERATION,
      operationId: reserved.operation.operationId,
      rawCapability,
    }),
    (error: unknown) =>
      error instanceof GitHubToolGatewayError &&
      error.code === "github_provider_unavailable"
  );
  assert.equal(refreshAborted, true);
  assert.equal(providerCalls, 0);
});

test("same-operation recovery after completion persistence failure performs at most one provider write", async () => {
  const rawCapability = Buffer.alloc(32, 0x4e).toString("base64url");
  const operation = {
    body: "Issue comment.",
    issueNumber: "42",
    kind: "issue.comment" as const,
    owner: "OpenCoven",
    repo: "coven-agents",
  };
  const requestHash = hashGitHubOperation(operation);
  const tokenHash = createHash("sha256")
    .update(rawCapability, "utf8")
    .digest("hex");
  const seedContext = context();
  const {
    capability: { teamStepId },
    operation: { operationId },
  } = seedContext;
  const operationMarker = githubOperationMarker({
    capabilityBinding: tokenHash,
    operationId,
    requestHash,
    teamStepId,
  });
  const boundContext = context(operation, operationMarker);
  const initialContext = {
    ...boundContext,
    operation: {
      ...boundContext.operation,
      requestHash,
      target: "opencoven/coven-agents#issue.comment:42",
    },
  };
  const dispatchedContext = {
    ...initialContext,
    operation: {
      ...initialContext.operation,
      providerDispatchPhase: "sent" as const,
      providerSentAt: new Date("2026-08-31T20:00:01.000Z"),
      version: 1,
    },
  };
  const recoveryContext = {
    ...dispatchedContext,
    operation: {
      ...dispatchedContext.operation,
      executionLeaseExpiresAt: new Date("2026-08-31T20:01:30.000Z"),
      updatedAt: new Date("2026-08-31T20:01:00.000Z"),
      version: 2,
    },
  };
  const comment = {
    body: `Issue comment.\n\n${operationMarker}`,
    html_url:
      "https://github.com/OpenCoven/coven-agents/issues/42#issuecomment-1",
    node_id: "IC_kwDOExample",
  };
  const sequence = sequenceProvider([
    Response.json(issue()),
    Response.json(comment),
    Response.json([comment]),
  ]);
  let completionCalls = 0;
  let failureCalls = 0;
  let reservationCalls = 0;
  const gateway = createGitHubToolGateway({
    clock: () => new Date("2030-08-31T20:00:00.000Z"),
    createId: () => initialContext.operation.id,
    operator: { kind: "runner-operator" },
    provider: sequence.provider,
    refreshAuthority: currentAuthority,
    store: {
      authorizeMutation: async () => ({
        kind: "authorized" as const,
        operation: dispatchedContext.operation,
      }),
      completeOperation: async (_operator, input) => {
        completionCalls += 1;
        if (completionCalls === 1) {
          throw new Error("database reset after provider success");
        }
        return {
          kind: "completed" as const,
          operation: {
            ...recoveryContext.operation,
            completedAt: new Date("2026-08-31T20:00:02.000Z"),
            providerRequestId: input.providerRequestId,
            result: input.result,
            resultNodeId: input.resultNodeId,
            resultUrl: input.resultUrl,
            status: "completed" as const,
            version: 3,
          },
        };
      },
      failOperation: async () => {
        failureCalls += 1;
        throw new Error("completion ambiguity must not call failOperation");
      },
      releaseOperationForRetry: async () => {
        throw new Error("sent writes must not release");
      },
      reserveOperation: async () => {
        reservationCalls += 1;
        return reservationCalls === 1
          ? { context: initialContext, kind: "reserved" as const }
          : { context: recoveryContext, kind: "recover" as const };
      },
    },
  });

  await assert.rejects(
    gateway.execute({ operation, operationId, rawCapability }),
    (error: unknown) =>
      error instanceof GitHubToolGatewayError &&
      error.code === "github_write_uncertain" &&
      error.retryable === false
  );
  const recovered = await gateway.execute({
    operation,
    operationId,
    rawCapability,
  });

  assert.equal(recovered.result.kind, "issue.comment");
  assert.equal(completionCalls, 2);
  assert.equal(failureCalls, 0);
  assert.equal(
    sequence.requests.filter(({ method }) => method === "POST").length,
    1
  );
  assert.deepEqual(
    sequence.requests.map(({ method, url }) => [method, url]),
    [
      ["GET", "https://api.github.com/repos/OpenCoven/coven-agents/issues/42"],
      [
        "POST",
        "https://api.github.com/repos/OpenCoven/coven-agents/issues/42/comments",
      ],
      [
        "GET",
        "https://api.github.com/repos/OpenCoven/coven-agents/issues/42/comments?per_page=100&page=1",
      ],
    ]
  );
});

test("known-sent recovery failures persist terminal write uncertainty for replay", async () => {
  const rawCapability = Buffer.alloc(32, 0x58).toString("base64url");
  const operation = {
    body: "Issue comment.",
    issueNumber: "42",
    kind: "issue.comment" as const,
    owner: "OpenCoven",
    repo: "coven-agents",
  };
  const tokenHash = createHash("sha256")
    .update(rawCapability, "utf8")
    .digest("hex");
  const {
    operation: { operationId },
  } = context();
  const sentContext = {
    ...context(
      operation,
      githubOperationMarker({
        capabilityBinding: tokenHash,
        operationId,
        requestHash: hashGitHubOperation(operation),
        teamStepId: context().capability.teamStepId,
      })
    ),
    operation: {
      ...context(operation).operation,
      operationMarker: githubOperationMarker({
        capabilityBinding: tokenHash,
        operationId,
        requestHash: hashGitHubOperation(operation),
        teamStepId: context().capability.teamStepId,
      }),
      providerDispatchPhase: "sent" as const,
      providerSentAt: new Date("2030-08-31T20:00:01.000Z"),
      version: 1,
    },
  };
  const variants = [
    new GitHubToolProviderError("github_provider_unavailable", {
      retryable: true,
      status: 503,
    }),
    new GitHubToolProviderError("github_provider_timeout", {
      retryable: true,
      status: 503,
    }),
    new GitHubToolProviderError("github_provider_rate_limited", {
      retryable: true,
      status: 429,
    }),
    new GitHubToolProviderError("github_provider_invalid_response", {
      retryable: false,
      status: 502,
    }),
    new GitHubToolProviderError("github_operation_authority_changed", {
      retryable: false,
      status: 401,
    }),
    new Error("recovery transport reset"),
  ];

  for (const providerError of variants) {
    const persisted: Array<{
      error: {
        code: string;
        message: string;
        retryable: boolean;
      };
      writeIntentActive: boolean;
    }> = [];
    let providerCalls = 0;
    let terminal:
      | (typeof sentContext.operation & {
          completedAt: Date;
          error: {
            code: string;
            message: string;
            retryable: boolean;
          };
          status: "failed";
        })
      | null = null;
    const gateway = createGitHubToolGateway({
      clock: () => new Date("2030-08-31T20:00:00.000Z"),
      createId: () => sentContext.operation.id,
      operator: { kind: "runner-operator" },
      provider: {
        execute: async () => {
          providerCalls += 1;
          throw providerError;
        },
      },
      refreshAuthority: currentAuthority,
      store: {
        authorizeMutation: async () => {
          throw new Error("recovery must not authorize another write");
        },
        completeOperation: async () => ({ kind: "stale" as const }),
        failOperation: async (_operator, input) => {
          terminal = {
            ...sentContext.operation,
            completedAt: new Date("2030-08-31T20:00:02.000Z"),
            error: input.error,
            status: "failed" as const,
            version: 2,
          };
          persisted.push({
            error: input.error,
            writeIntentActive: terminal.writeIntentActive,
          });
          return { kind: "failed" as const, operation: terminal };
        },
        releaseOperationForRetry: async () => {
          throw new Error("known-sent intent must remain permanent");
        },
        reserveOperation: async () =>
          terminal
            ? { kind: "terminal" as const, operation: terminal }
            : { context: sentContext, kind: "recover" as const },
      },
    });

    for (let replay = 0; replay < 2; replay += 1) {
      await assert.rejects(
        gateway.execute({ operation, operationId, rawCapability }),
        (error: unknown) =>
          error instanceof GitHubToolGatewayError &&
          error.code === "github_write_uncertain" &&
          error.retryable === false &&
          error.status === 409
      );
    }
    assert.deepEqual(persisted, [
      {
        error: {
          code: "github_write_uncertain",
          message: "GitHub may have accepted the write; it was not replayed.",
          retryable: false,
        },
        writeIntentActive: true,
      },
    ]);
    assert.equal(providerCalls, 1);
  }
});

test("post-authorization provider failure persists known-sent uncertainty", async () => {
  const rawCapability = Buffer.alloc(32, 0x59).toString("base64url");
  const operation = {
    body: "Issue comment.",
    issueNumber: "42",
    kind: "issue.comment" as const,
    owner: "OpenCoven",
    repo: "coven-agents",
  };
  const tokenHash = createHash("sha256")
    .update(rawCapability, "utf8")
    .digest("hex");
  const {
    operation: { operationId },
  } = context();
  const reservedContext = context(
    operation,
    githubOperationMarker({
      capabilityBinding: tokenHash,
      operationId,
      requestHash: hashGitHubOperation(operation),
      teamStepId: context().capability.teamStepId,
    })
  );
  const sentOperation = {
    ...reservedContext.operation,
    providerDispatchPhase: "sent" as const,
    providerSentAt: new Date("2030-08-31T20:00:01.000Z"),
    version: 1,
  };
  let persistedError: unknown;
  const gateway = createGitHubToolGateway({
    clock: () => new Date("2030-08-31T20:00:00.000Z"),
    createId: () => reservedContext.operation.id,
    operator: { kind: "runner-operator" },
    provider: {
      execute: async (input) => {
        assert.equal(await input.authorizeMutation(), true);
        throw new GitHubToolProviderError("github_provider_unavailable", {
          retryable: true,
          status: 503,
        });
      },
    },
    refreshAuthority: currentAuthority,
    store: {
      authorizeMutation: async () => ({
        kind: "authorized" as const,
        operation: sentOperation,
      }),
      completeOperation: async () => ({ kind: "stale" as const }),
      failOperation: async (_operator, input) => {
        persistedError = input.error;
        return {
          kind: "failed" as const,
          operation: {
            ...sentOperation,
            completedAt: new Date("2030-08-31T20:00:02.000Z"),
            error: input.error,
            status: "failed" as const,
            version: 2,
          },
        };
      },
      releaseOperationForRetry: async () => {
        throw new Error("sent write must not release");
      },
      reserveOperation: async () => ({
        context: reservedContext,
        kind: "reserved" as const,
      }),
    },
  });

  await assert.rejects(
    gateway.execute({ operation, operationId, rawCapability }),
    (error: unknown) =>
      error instanceof GitHubToolGatewayError &&
      error.code === "github_write_uncertain" &&
      error.retryable === false
  );
  assert.deepEqual(persistedError, {
    code: "github_write_uncertain",
    message: "GitHub may have accepted the write; it was not replayed.",
    retryable: false,
  });
});

test("known-sent failure persistence aborts before a delayed terminal commit", {
  timeout: 250,
}, async () => {
  const rawCapability = Buffer.alloc(32, 0x5c).toString("base64url");
  const operation = {
    body: "Issue comment.",
    issueNumber: "42",
    kind: "issue.comment" as const,
    owner: "OpenCoven",
    repo: "coven-agents",
  };
  const tokenHash = createHash("sha256")
    .update(rawCapability, "utf8")
    .digest("hex");
  const {
    operation: { operationId },
  } = context();
  const sentContext = {
    ...context(
      operation,
      githubOperationMarker({
        capabilityBinding: tokenHash,
        operationId,
        requestHash: hashGitHubOperation(operation),
        teamStepId: context().capability.teamStepId,
      })
    ),
    operation: {
      ...context(operation).operation,
      operationMarker: githubOperationMarker({
        capabilityBinding: tokenHash,
        operationId,
        requestHash: hashGitHubOperation(operation),
        teamStepId: context().capability.teamStepId,
      }),
      providerDispatchPhase: "sent" as const,
      providerSentAt: new Date("2030-08-31T20:00:01.000Z"),
      version: 1,
    },
  };
  let failureAborted = false;
  let lateMutations = 0;
  const gateway = createGitHubToolGateway({
    clock: () => new Date("2030-08-31T20:00:00.000Z"),
    createId: () => sentContext.operation.id,
    databasePhaseTimeoutMs: 5,
    operator: { kind: "runner-operator" },
    provider: {
      execute: async () => {
        throw new GitHubToolProviderError("github_provider_unavailable", {
          retryable: true,
          status: 503,
        });
      },
    },
    refreshAuthority: currentAuthority,
    store: {
      authorizeMutation: async () => ({ kind: "unauthorized" as const }),
      completeOperation: async () => ({ kind: "stale" as const }),
      failOperation: (
        _operator: unknown,
        input: { abortSignal?: AbortSignal }
      ) =>
        new Promise((resolve, reject) => {
          const { abortSignal } = input;
          const timer = setTimeout(() => {
            if (!abortSignal?.aborted) {
              lateMutations += 1;
              resolve({ kind: "stale" as const });
            }
          }, 30);
          abortSignal?.addEventListener(
            "abort",
            () => {
              failureAborted = true;
              clearTimeout(timer);
              reject(abortSignal.reason);
            },
            { once: true }
          );
        }),
      releaseOperationForRetry: async () => {
        throw new Error("known-sent write must not release");
      },
      reserveOperation: async () => ({
        context: sentContext,
        kind: "recover" as const,
      }),
    },
  } as never);

  await assert.rejects(
    gateway.execute({ operation, operationId, rawCapability }),
    (error: unknown) =>
      error instanceof GitHubToolGatewayError &&
      error.code === "github_write_uncertain" &&
      error.retryable === false
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(failureAborted, true);
  assert.equal(lateMutations, 0);
});

test("retryable pre-send provider failure releases the write intent and permits the same operation retry", async () => {
  const rawCapability = Buffer.alloc(32, 0x53).toString("base64url");
  const operation = {
    body: "Issue comment.",
    issueNumber: "42",
    kind: "issue.comment" as const,
    owner: "OpenCoven",
    repo: "coven-agents",
  };
  const tokenHash = createHash("sha256")
    .update(rawCapability, "utf8")
    .digest("hex");
  const {
    operation: { operationId },
  } = context();
  const marker = githubOperationMarker({
    capabilityBinding: tokenHash,
    operationId,
    requestHash: hashGitHubOperation(operation),
    teamStepId: context().capability.teamStepId,
  });
  const initial = context(operation, marker);
  const retried = {
    ...initial,
    operation: {
      ...initial.operation,
      executionLeaseExpiresAt: new Date("2030-08-31T20:01:00.000Z"),
      version: 2,
    },
  };
  let failures = 0;
  let providerCalls = 0;
  let releases = 0;
  let reservations = 0;
  const gateway = createGitHubToolGateway({
    clock: () => new Date("2030-08-31T20:00:00.000Z"),
    createId: () => initial.operation.id,
    operator: { kind: "runner-operator" },
    provider: {
      execute: async () => {
        providerCalls += 1;
        if (providerCalls === 1) {
          throw new GitHubToolProviderError("github_provider_rate_limited", {
            retryable: true,
            status: 429,
          });
        }
        return {
          providerRequestId: "ABC1:DEF2",
          result: {
            comment: {
              nodeId: "IC_kwDOExample",
              url: "https://github.com/OpenCoven/coven-agents/issues/42#issuecomment-1",
            },
            kind: "issue.comment",
            repository: "OpenCoven/coven-agents",
          },
          resultNodeId: "IC_kwDOExample",
          resultUrl:
            "https://github.com/OpenCoven/coven-agents/issues/42#issuecomment-1",
        };
      },
    },
    refreshAuthority: currentAuthority,
    store: {
      authorizeMutation: async () => ({
        kind: "authorized" as const,
        operation: retried.operation,
      }),
      completeOperation: async (_operator, input) => ({
        kind: "completed" as const,
        operation: {
          ...retried.operation,
          completedAt: new Date("2030-08-31T20:00:02.000Z"),
          providerRequestId: input.providerRequestId,
          result: input.result,
          resultNodeId: input.resultNodeId,
          resultUrl: input.resultUrl,
          status: "completed" as const,
          version: 3,
        },
      }),
      failOperation: async () => {
        failures += 1;
        return { kind: "stale" as const };
      },
      releaseOperationForRetry: async () => {
        releases += 1;
        return {
          kind: "released" as const,
          operation: {
            ...initial.operation,
            error: {
              code: "github_provider_rate_limited",
              message: "GitHub provider execution failed.",
              retryable: true,
            },
            status: "pending" as const,
            version: 1,
            writeIntentActive: false,
          },
        };
      },
      reserveOperation: async () => {
        reservations += 1;
        return reservations === 1
          ? { context: initial, kind: "reserved" as const }
          : { context: retried, kind: "reserved" as const };
      },
    },
  });

  await assert.rejects(
    gateway.execute({ operation, operationId, rawCapability }),
    (error: unknown) =>
      error instanceof GitHubToolGatewayError &&
      error.code === "github_provider_rate_limited" &&
      error.retryable === true
  );
  const response = await gateway.execute({
    operation,
    operationId,
    rawCapability,
  });

  assert.equal(response.result.kind, "issue.comment");
  assert.equal(releases, 1);
  assert.equal(failures, 0);
  assert.equal(providerCalls, 2);
});

test("installation-token failure releases the pre-send write without touching the provider endpoint", async () => {
  const rawCapability = Buffer.alloc(32, 0x54).toString("base64url");
  const operation = {
    assignees: [] as string[],
    body: "Issue body.",
    kind: "issue.create" as const,
    labels: [] as string[],
    owner: "OpenCoven",
    repo: "coven-agents",
    title: "Gateway issue",
  };
  const tokenHash = createHash("sha256")
    .update(rawCapability, "utf8")
    .digest("hex");
  const {
    operation: { operationId },
  } = context();
  const reservedContext = context(
    operation,
    githubOperationMarker({
      capabilityBinding: tokenHash,
      operationId,
      requestHash: hashGitHubOperation(operation),
      teamStepId: context().capability.teamStepId,
    })
  );
  let endpointCalls = 0;
  let releases = 0;
  const gateway = createGitHubToolGateway({
    clock: () => new Date("2030-08-31T20:00:00.000Z"),
    createId: () => reservedContext.operation.id,
    operator: { kind: "runner-operator" },
    provider: createGitHubOperationProvider({
      fetch: () => {
        endpointCalls += 1;
        throw new Error("provider endpoint must not be called");
      },
      withInstallationAuthorization: async () => {
        throw new Error("installation token rate limited");
      },
    }),
    refreshAuthority: currentAuthority,
    store: {
      authorizeMutation: async () => {
        throw new Error("token mint must precede mutation dispatch");
      },
      completeOperation: async () => ({ kind: "stale" as const }),
      failOperation: async () => {
        throw new Error("pre-send retry must not become terminal");
      },
      releaseOperationForRetry: async () => {
        releases += 1;
        return {
          kind: "released" as const,
          operation: {
            ...reservedContext.operation,
            error: {
              code: "github_provider_unavailable",
              message: "GitHub provider execution failed.",
              retryable: true,
            },
            status: "pending" as const,
            version: 1,
            writeIntentActive: false,
          },
        };
      },
      reserveOperation: async () => ({
        context: reservedContext,
        kind: "reserved" as const,
      }),
    },
  });

  await assert.rejects(
    gateway.execute({ operation, operationId, rawCapability }),
    (error: unknown) =>
      error instanceof GitHubToolGatewayError &&
      error.code === "github_provider_unavailable" &&
      error.retryable === true
  );
  assert.equal(endpointCalls, 0);
  assert.equal(releases, 1);
});

test("blocked operation reservation fails inside the server database phase budget", {
  timeout: 250,
}, async () => {
  let reservationAborted = false;
  let lateMutations = 0;
  let providerCalls = 0;
  const gateway = createGitHubToolGateway({
    clock: () => new Date("2030-08-31T20:00:00.000Z"),
    createId: () => context().operation.id,
    databasePhaseTimeoutMs: 5,
    operator: { kind: "runner-operator" },
    provider: {
      execute: async () => {
        providerCalls += 1;
        throw new Error("blocked reservation must not reach provider");
      },
    },
    refreshAuthority: currentAuthority,
    store: {
      authorizeMutation: async () => ({ kind: "unauthorized" as const }),
      completeOperation: async () => ({ kind: "stale" as const }),
      failOperation: async () => ({ kind: "stale" as const }),
      reserveOperation: (
        _operator: unknown,
        input: { abortSignal?: AbortSignal }
      ) =>
        new Promise((resolve, reject) => {
          const { abortSignal } = input;
          const timer = setTimeout(() => {
            if (!abortSignal?.aborted) {
              lateMutations += 1;
              resolve({ kind: "unauthorized" as const });
            }
          }, 30);
          abortSignal?.addEventListener(
            "abort",
            () => {
              reservationAborted = true;
              clearTimeout(timer);
              reject(abortSignal.reason);
            },
            { once: true }
          );
        }),
    },
  } as never);

  await assert.rejects(
    gateway.execute({
      operation: OPERATION,
      operationId: context().operation.operationId,
      rawCapability: Buffer.alloc(32, 0x51).toString("base64url"),
    }),
    (error: unknown) =>
      error instanceof GitHubToolGatewayError &&
      error.code === "github_gateway_unavailable" &&
      error.retryable === true &&
      error.status === 503
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(reservationAborted, true);
  assert.equal(lateMutations, 0);
  assert.equal(providerCalls, 0);
});

test("ambiguous dispatch-phase persistence never sends or releases the write", {
  timeout: 250,
}, async () => {
  const rawCapability = Buffer.alloc(32, 0x55).toString("base64url");
  const operation = {
    body: "Issue comment.",
    issueNumber: "42",
    kind: "issue.comment" as const,
    owner: "OpenCoven",
    repo: "coven-agents",
  };
  const tokenHash = createHash("sha256")
    .update(rawCapability, "utf8")
    .digest("hex");
  const {
    operation: { operationId },
  } = context();
  const reservedContext = context(
    operation,
    githubOperationMarker({
      capabilityBinding: tokenHash,
      operationId,
      requestHash: hashGitHubOperation(operation),
      teamStepId: context().capability.teamStepId,
    })
  );
  const sequence = sequenceProvider([Response.json(issue())]);
  let failures = 0;
  let releases = 0;
  const gateway = createGitHubToolGateway({
    clock: () => new Date("2030-08-31T20:00:00.000Z"),
    createId: () => reservedContext.operation.id,
    databasePhaseTimeoutMs: 5,
    operator: { kind: "runner-operator" },
    provider: sequence.provider,
    refreshAuthority: currentAuthority,
    store: {
      authorizeMutation: () => new Promise(() => undefined),
      completeOperation: async () => ({ kind: "stale" as const }),
      failOperation: async () => {
        failures += 1;
        return { kind: "stale" as const };
      },
      releaseOperationForRetry: async () => {
        releases += 1;
        return { kind: "stale" as const };
      },
      reserveOperation: async () => ({
        context: reservedContext,
        kind: "reserved" as const,
      }),
    },
  } as never);

  await assert.rejects(
    gateway.execute({ operation, operationId, rawCapability }),
    (error: unknown) =>
      error instanceof GitHubToolGatewayError &&
      error.code === "github_write_uncertain" &&
      error.retryable === false
  );
  assert.equal(failures, 0);
  assert.equal(releases, 0);
  assert.deepEqual(
    sequence.requests.map(({ method }) => method),
    ["GET"]
  );
});

test("blocked mutation authorization returns dispatch uncertainty without provider execution", {
  timeout: 250,
}, async () => {
  const rawCapability = Buffer.alloc(32, 0x54).toString("base64url");
  const operation = {
    body: "Issue comment.",
    issueNumber: "42",
    kind: "issue.comment" as const,
    owner: "OpenCoven",
    repo: "coven-agents",
  };
  const tokenHash = createHash("sha256")
    .update(rawCapability, "utf8")
    .digest("hex");
  const {
    operation: { operationId },
  } = context();
  const reservedContext = context(
    operation,
    githubOperationMarker({
      capabilityBinding: tokenHash,
      operationId,
      requestHash: hashGitHubOperation(operation),
      teamStepId: context().capability.teamStepId,
    })
  );
  let authorizationAborted = false;
  let failures = 0;
  let mutations = 0;
  let releases = 0;
  const gateway = createGitHubToolGateway({
    clock: () => new Date("2030-08-31T20:00:00.000Z"),
    createId: () => reservedContext.operation.id,
    databasePhaseTimeoutMs: 5,
    operator: { kind: "runner-operator" },
    provider: {
      execute: async (input) => {
        if (await input.authorizeMutation()) {
          mutations += 1;
        }
        throw new Error("authorization timeout must stop provider execution");
      },
    },
    refreshAuthority: currentAuthority,
    store: {
      authorizeMutation: (_operator, input) =>
        new Promise((_resolve, reject) => {
          input.abortSignal?.addEventListener(
            "abort",
            () => {
              authorizationAborted = true;
              reject(input.abortSignal?.reason);
            },
            { once: true }
          );
        }),
      completeOperation: async () => ({ kind: "stale" as const }),
      failOperation: async () => {
        failures += 1;
        return { kind: "stale" as const };
      },
      releaseOperationForRetry: async () => {
        releases += 1;
        return { kind: "stale" as const };
      },
      reserveOperation: async () => ({
        context: reservedContext,
        kind: "reserved" as const,
      }),
    },
  });

  await assert.rejects(
    gateway.execute({ operation, operationId, rawCapability }),
    (error: unknown) =>
      error instanceof GitHubToolGatewayError &&
      error.code === "github_write_uncertain" &&
      error.retryable === false
  );
  assert.equal(authorizationAborted, true);
  assert.equal(mutations, 0);
  assert.equal(failures, 0);
  assert.equal(releases, 0);
});

test("a proven PostgreSQL lock timeout before dispatch releases the write for retry", async () => {
  const rawCapability = Buffer.alloc(32, 0x56).toString("base64url");
  const operation = {
    body: "Issue comment.",
    issueNumber: "42",
    kind: "issue.comment" as const,
    owner: "OpenCoven",
    repo: "coven-agents",
  };
  const tokenHash = createHash("sha256")
    .update(rawCapability, "utf8")
    .digest("hex");
  const {
    operation: { operationId },
  } = context();
  const reservedContext = context(
    operation,
    githubOperationMarker({
      capabilityBinding: tokenHash,
      operationId,
      requestHash: hashGitHubOperation(operation),
      teamStepId: context().capability.teamStepId,
    })
  );
  let failures = 0;
  let mutations = 0;
  let releases = 0;
  const gateway = createGitHubToolGateway({
    clock: () => new Date("2030-08-31T20:00:00.000Z"),
    createId: () => reservedContext.operation.id,
    databasePhaseTimeoutMs: 25,
    operator: { kind: "runner-operator" },
    provider: {
      execute: async (input) => {
        if (await input.authorizeMutation()) {
          mutations += 1;
        }
        throw new Error("lock timeout must stop provider execution");
      },
    },
    refreshAuthority: currentAuthority,
    store: {
      authorizeMutation: async () => {
        throw Object.assign(new Error("lock timeout"), { code: "55P03" });
      },
      completeOperation: async () => ({ kind: "stale" as const }),
      failOperation: async () => {
        failures += 1;
        return { kind: "stale" as const };
      },
      releaseOperationForRetry: async () => {
        releases += 1;
        return {
          kind: "released" as const,
          operation: {
            ...reservedContext.operation,
            error: {
              code: "github_gateway_unavailable",
              message: "GitHub provider execution failed.",
              retryable: true,
            },
            status: "pending" as const,
            version: 1,
            writeIntentActive: false,
          },
        };
      },
      reserveOperation: async () => ({
        context: reservedContext,
        kind: "reserved" as const,
      }),
    },
  });

  await assert.rejects(
    gateway.execute({ operation, operationId, rawCapability }),
    (error: unknown) =>
      error instanceof GitHubToolGatewayError &&
      error.code === "github_provider_unavailable" &&
      error.retryable === true
  );
  assert.equal(mutations, 0);
  assert.equal(failures, 0);
  assert.equal(releases, 1);
});

test("an exhausted authorization margin releases before marking a write sent", async () => {
  const rawCapability = Buffer.alloc(32, 0x57).toString("base64url");
  const operation = {
    body: "Issue comment.",
    issueNumber: "42",
    kind: "issue.comment" as const,
    owner: "OpenCoven",
    repo: "coven-agents",
  };
  const tokenHash = createHash("sha256")
    .update(rawCapability, "utf8")
    .digest("hex");
  const {
    operation: { operationId },
  } = context();
  const reservedContext = context(
    operation,
    githubOperationMarker({
      capabilityBinding: tokenHash,
      operationId,
      requestHash: hashGitHubOperation(operation),
      teamStepId: context().capability.teamStepId,
    })
  );
  const startedAt = Date.parse("2030-08-31T20:00:00.000Z");
  let clockCalls = 0;
  let authorizations = 0;
  let releases = 0;
  const gateway = createGitHubToolGateway({
    clock: () => {
      const call = clockCalls;
      clockCalls += 1;
      return new Date(
        startedAt + (call === 0 ? 0 : GITHUB_TOOL_SERVER_DEADLINE_MS - 10)
      );
    },
    createId: () => reservedContext.operation.id,
    databasePhaseTimeoutMs: 25,
    operator: { kind: "runner-operator" },
    provider: {
      execute: async (input) => {
        await input.authorizeMutation();
        throw new Error("deadline margin must stop provider execution");
      },
    },
    refreshAuthority: currentAuthority,
    store: {
      authorizeMutation: async () => {
        authorizations += 1;
        throw new Error("must not mark the operation sent");
      },
      completeOperation: async () => ({ kind: "stale" as const }),
      failOperation: async () => ({ kind: "stale" as const }),
      releaseOperationForRetry: async () => {
        releases += 1;
        return {
          kind: "released" as const,
          operation: {
            ...reservedContext.operation,
            error: {
              code: "github_provider_unavailable",
              message: "GitHub provider execution failed.",
              retryable: true,
            },
            status: "pending" as const,
            version: 1,
            writeIntentActive: false,
          },
        };
      },
      reserveOperation: async () => ({
        context: reservedContext,
        kind: "reserved" as const,
      }),
    },
  });

  await assert.rejects(
    gateway.execute({ operation, operationId, rawCapability }),
    (error: unknown) =>
      error instanceof GitHubToolGatewayError &&
      error.code === "github_provider_unavailable" &&
      error.retryable
  );
  assert.equal(authorizations, 0);
  assert.equal(releases, 1);
});

test("blocked completion persistence returns write uncertainty before the client deadline", {
  timeout: 250,
}, async () => {
  const rawCapability = Buffer.alloc(32, 0x52).toString("base64url");
  const operation = {
    body: "Issue comment.",
    issueNumber: "42",
    kind: "issue.comment" as const,
    owner: "OpenCoven",
    repo: "coven-agents",
  };
  const tokenHash = createHash("sha256")
    .update(rawCapability, "utf8")
    .digest("hex");
  const reservedContext = context(
    operation,
    githubOperationMarker({
      capabilityBinding: tokenHash,
      operationId: context().operation.operationId,
      requestHash: hashGitHubOperation(operation),
      teamStepId: context().capability.teamStepId,
    })
  );
  let completionAborted = false;
  let failures = 0;
  let lateMutations = 0;
  const gateway = createGitHubToolGateway({
    clock: () => new Date("2030-08-31T20:00:00.000Z"),
    createId: () => reservedContext.operation.id,
    databasePhaseTimeoutMs: 5,
    operator: { kind: "runner-operator" },
    provider: {
      execute: async () => ({
        providerRequestId: "ABC1:DEF2",
        result: {
          comment: {
            nodeId: "IC_kwDOExample",
            url: "https://github.com/OpenCoven/coven-agents/issues/42#issuecomment-1",
          },
          kind: "issue.comment",
          repository: "OpenCoven/coven-agents",
        },
        resultNodeId: "IC_kwDOExample",
        resultUrl:
          "https://github.com/OpenCoven/coven-agents/issues/42#issuecomment-1",
      }),
    },
    refreshAuthority: currentAuthority,
    store: {
      authorizeMutation: async () => ({
        kind: "authorized" as const,
        operation: context().operation,
      }),
      completeOperation: (
        _operator: unknown,
        input: { abortSignal?: AbortSignal }
      ) =>
        new Promise((resolve, reject) => {
          const { abortSignal } = input;
          const timer = setTimeout(() => {
            if (!abortSignal?.aborted) {
              lateMutations += 1;
              resolve({ kind: "stale" as const });
            }
          }, 30);
          abortSignal?.addEventListener(
            "abort",
            () => {
              completionAborted = true;
              clearTimeout(timer);
              reject(abortSignal.reason);
            },
            { once: true }
          );
        }),
      failOperation: async () => {
        failures += 1;
        return { kind: "stale" as const };
      },
      reserveOperation: async () => ({
        context: reservedContext,
        kind: "reserved" as const,
      }),
    },
  } as never);

  await assert.rejects(
    gateway.execute({
      operation,
      operationId: reservedContext.operation.operationId,
      rawCapability,
    }),
    (error: unknown) =>
      error instanceof GitHubToolGatewayError &&
      error.code === "github_write_uncertain" &&
      error.retryable === false
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(completionAborted, true);
  assert.equal(lateMutations, 0);
  assert.equal(failures, 0);
});

test("gateway serializes duplicates and never success-shapes conflicts, active calls, or uncertainty", async () => {
  const rawCapability = Buffer.alloc(32, 0x4b).toString("base64url");
  const operation = OPERATION;
  const terminal = {
    ...context().operation,
    completedAt: new Date("2026-08-31T20:00:02.000Z"),
    result: {
      issue: {
        body: "",
        nodeId: "I_kwDOExample",
        number: "42",
        state: "open" as const,
        title: "Gateway",
        url: "https://github.com/OpenCoven/coven-agents/issues/42",
      },
      kind: "issue.get" as const,
      repository: "OpenCoven/coven-agents",
    },
    status: "completed" as const,
  };
  let providerCalls = 0;
  const gatewayFor = (
    reservation:
      | { kind: "conflict" | "in_progress" | "unauthorized" }
      | { kind: "intent_conflict"; operation: typeof terminal }
      | { kind: "terminal"; operation: typeof terminal }
      | {
          context: GitHubOperationExecutionContext;
          kind: "recover" | "reserved";
        },
    providerError?: Error
  ) =>
    createGitHubToolGateway({
      clock: () => new Date("2026-08-31T20:00:00.000Z"),
      createId: () => context().operation.id,
      operator: { kind: "runner-operator" },
      provider: {
        execute: async () => {
          providerCalls += 1;
          throw (
            providerError ??
            new Error("terminal reservations must not call provider")
          );
        },
      },
      refreshAuthority: currentAuthority,
      store: {
        authorizeMutation: async () => ({
          kind: "authorized" as const,
          operation: context().operation,
        }),
        completeOperation: async () => {
          throw new Error("failed provider must not complete");
        },
        failOperation: async (_operator, input) => ({
          kind: "failed" as const,
          operation: {
            ...context().operation,
            completedAt: new Date("2026-08-31T20:00:03.000Z"),
            error: input.error,
            status: "failed" as const,
            version: 1,
          },
        }),
        releaseOperationForRetry: async () => ({
          kind: "stale" as const,
        }),
        reserveOperation: async () => reservation as never,
      },
    });

  const replay = await gatewayFor({
    kind: "terminal",
    operation: terminal,
  }).execute({
    operation,
    operationId: terminal.operationId,
    rawCapability,
  });
  assert.equal(replay.result.kind, "issue.get");
  assert.equal(providerCalls, 0);

  await assert.rejects(
    gatewayFor({
      kind: "intent_conflict",
      operation: terminal,
    }).execute({
      operation,
      operationId: terminal.operationId,
      rawCapability,
    }),
    (error: unknown) =>
      error instanceof GitHubToolGatewayError &&
      error.code === "github_write_intent_conflict" &&
      error.status === 409 &&
      error.retryable === false
  );

  for (const [kind, status] of [
    ["unauthorized", 401],
    ["conflict", 409],
    ["in_progress", 409],
  ] as const) {
    await assert.rejects(
      gatewayFor({ kind }).execute({
        operation,
        operationId: terminal.operationId,
        rawCapability,
      }),
      (error: unknown) =>
        error instanceof GitHubToolGatewayError && error.status === status
    );
  }

  const uncertainError = new GitHubToolProviderError("github_write_uncertain", {
    retryable: false,
    status: 409,
    uncertain: true,
  });
  await assert.rejects(
    gatewayFor({ context: context(), kind: "recover" }, uncertainError).execute(
      {
        operation,
        operationId: terminal.operationId,
        rawCapability,
      }
    ),
    (error: unknown) =>
      error instanceof GitHubToolGatewayError &&
      error.code === "github_write_uncertain" &&
      error.status === 409
  );
});

test("internal HTTP accepts only bounded strict capability-authenticated POST bodies and always disables caching", async () => {
  const rawCapability = Buffer.alloc(32, 0x4c).toString("base64url");
  const calls: unknown[] = [];
  const handler = createGitHubToolHttpHandler({
    enforceAbuse: async () => ({ kind: "allowed" as const }),
    execute: async (input) => {
      calls.push(input);
      return {
        receipt: {
          completedAt: "2026-08-31T20:00:02.000Z",
          id: "77777777-7777-4777-8777-777777777777",
          kind: "issue.get" as const,
          providerRequestId: null,
          requestHash: "a".repeat(64),
          resultNodeId: "I_kwDOExample",
          resultUrl: "https://github.com/OpenCoven/coven-agents/issues/42",
          status: "completed" as const,
          stepId: "55555555-5555-4555-8555-555555555555",
          target: "opencoven/coven-agents#issue.get:42",
        },
        result: {
          issue: {
            body: "",
            nodeId: "I_kwDOExample",
            number: "42",
            state: "open" as const,
            title: "Gateway",
            url: "https://github.com/OpenCoven/coven-agents/issues/42",
          },
          kind: "issue.get" as const,
          repository: "OpenCoven/coven-agents",
        },
      };
    },
  });
  const body = JSON.stringify({
    operation: OPERATION,
    operationId: "88888888-8888-4888-8888-888888888888",
  });
  const response = await handler(
    new Request("https://app.example/api/internal/github-tool", {
      body,
      headers: {
        authorization: `Bearer ${rawCapability}`,
        "content-length": String(Buffer.byteLength(body)),
        cookie: "session=must-not-authorize",
      },
      method: "POST",
    })
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(calls, [
    {
      operation: OPERATION,
      operationId: "88888888-8888-4888-8888-888888888888",
      rawCapability,
    },
  ]);
  assert.equal(
    JSON.stringify(await response.json()).includes(rawCapability),
    false
  );

  const escapedBody = JSON.stringify({
    operation: {
      assignees: [],
      body: "\\".repeat(40_000),
      kind: "issue.create",
      labels: [],
      owner: "OpenCoven",
      repo: "coven-agents",
      title: "Escaped JSON remains within the operation byte bound",
    },
    operationId: "99999999-9999-4999-8999-999999999999",
  });
  assert.ok(Buffer.byteLength(escapedBody, "utf8") > 65_536);
  const escapedResponse = await handler(
    new Request("https://app.example/api/internal/github-tool", {
      body: escapedBody,
      headers: { authorization: `Bearer ${rawCapability}` },
      method: "POST",
    })
  );
  assert.equal(escapedResponse.status, 200);

  const callsBeforeUnauthorized = calls.length;
  const unauthorized = await handler(
    new Request("https://app.example/api/internal/github-tool", {
      body,
      headers: { cookie: "session=not-authority" },
      method: "POST",
    })
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get("location"), null);
  assert.equal(calls.length, callsBeforeUnauthorized);

  for (const request of [
    new Request("https://app.example/api/internal/github-tool", {
      body: JSON.stringify({
        operation: { ...OPERATION, method: "DELETE" },
        operationId: "88888888-8888-4888-8888-888888888888",
      }),
      headers: { authorization: `Bearer ${rawCapability}` },
      method: "POST",
    }),
    new Request("https://app.example/api/internal/github-tool", {
      body: "x".repeat(512 * 1024 + 1),
      headers: {
        authorization: `Bearer ${rawCapability}`,
        "content-length": String(512 * 1024 + 1),
      },
      method: "POST",
    }),
  ]) {
    const rejected = await handler(request);
    assert.equal(rejected.headers.get("cache-control"), "no-store");
    assert.ok([400, 401, 413].includes(rejected.status));
    assert.equal(
      JSON.stringify(await rejected.json()).includes(rawCapability),
      false
    );
  }
});

test("internal HTTP returns sanitized denied and unavailable admission responses before body reads or capability lookup", async () => {
  const rawCapability = Buffer.alloc(32, 0x5c).toString("base64url");
  for (const [admission, expected] of [
    [
      { kind: "denied", responseStatus: 429, retryAfterSeconds: 17 },
      {
        body: {
          error: {
            code: "rate_limited",
            message: "Too many requests. Try again later.",
            retryable: true,
          },
        },
        retryAfter: "17",
        status: 429,
      },
    ],
    [
      { kind: "unavailable", responseStatus: 503 },
      {
        body: {
          error: {
            code: "abuse_control_unavailable",
            message: "GitHub tool execution is unavailable.",
            retryable: true,
          },
        },
        retryAfter: null,
        status: 503,
      },
    ],
  ] as const) {
    let bodyPulls = 0;
    let executions = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          bodyPulls += 1;
          controller.enqueue(new TextEncoder().encode("{}"));
          controller.close();
        },
      },
      { highWaterMark: 0 }
    );
    const handler = createGitHubToolHttpHandler({
      enforceAbuse: async (input: unknown) => {
        assert.deepEqual(input, {
          failClosed: true,
          ip: "203.0.113.90",
          route: "github_tool",
        });
        return admission;
      },
      execute: async () => {
        executions += 1;
        return {} as never;
      },
    } as never) as unknown as (
      request: Request,
      ip: string | null
    ) => Promise<Response>;

    const response = await handler(
      new Request("https://app.example/api/internal/github-tool", {
        body,
        duplex: "half",
        headers: { authorization: ["Bearer", rawCapability].join(" ") },
        method: "POST",
      } as RequestInit & { duplex: "half" }),
      "203.0.113.90"
    );

    assert.equal(response.status, expected.status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("retry-after"), expected.retryAfter);
    assert.deepEqual(await response.json(), expected.body);
    assert.equal(bodyPulls, 0);
    assert.equal(executions, 0);
  }
});

test("syntactically valid capability floods are stopped by IP admission before database execution", async () => {
  const rawCapability = Buffer.alloc(32, 0x5d).toString("base64url");
  let admissions = 0;
  let executions = 0;
  const handler = createGitHubToolHttpHandler({
    enforceAbuse: async () => {
      admissions += 1;
      return admissions <= 2
        ? ({ kind: "allowed" } as const)
        : ({
            kind: "denied",
            responseStatus: 429,
            retryAfterSeconds: 60,
          } as const);
    },
    execute: async () => {
      executions += 1;
      return {} as never;
    },
  } as never) as unknown as (
    request: Request,
    ip: string | null
  ) => Promise<Response>;

  const responses = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      handler(
        new Request("https://app.example/api/internal/github-tool", {
          body: JSON.stringify({
            operation: OPERATION,
            operationId: `88888888-8888-4888-8888-${String(index).padStart(12, "0")}`,
          }),
          headers: { authorization: ["Bearer", rawCapability].join(" ") },
          method: "POST",
        }),
        "203.0.113.91"
      )
    )
  );

  assert.equal(admissions, 8);
  assert.equal(executions, 2);
  assert.deepEqual(
    responses.map(({ status }) => status),
    [200, 200, 429, 429, 429, 429, 429, 429]
  );
});

test("an absolute pre-database deadline cancels a slow endless body before capability lookup", {
  timeout: 500,
}, async () => {
  const rawCapability = Buffer.alloc(32, 0x5e).toString("base64url");
  let cancelled = false;
  let executions = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
    pull() {
      return new Promise(() => undefined);
    },
  });
  const handler = createGitHubToolHttpHandler({
    bodyDeadlineMs: 10,
    enforceAbuse: async () => ({ kind: "allowed" as const }),
    execute: async () => {
      executions += 1;
      return {} as never;
    },
  } as never) as unknown as (
    request: Request,
    ip: string | null
  ) => Promise<Response>;

  const response = await handler(
    new Request("https://app.example/api/internal/github-tool", {
      body,
      duplex: "half",
      headers: { authorization: ["Bearer", rawCapability].join(" ") },
      method: "POST",
    } as RequestInit & { duplex: "half" }),
    "203.0.113.92"
  );

  assert.equal(response.status, 408);
  assert.deepEqual(await response.json(), {
    error: {
      code: "request_timeout",
      message: "GitHub tool request timed out.",
      retryable: true,
    },
  });
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
  assert.equal(executions, 0);
});

test("a pre-aborted request is refused before admission, body access, or capability lookup", async () => {
  const controller = new AbortController();
  controller.abort(new Error("client disconnected"));
  let admissions = 0;
  let executions = 0;
  const handler = createGitHubToolHttpHandler({
    bodyDeadlineMs: 50,
    enforceAbuse: async () => {
      admissions += 1;
      return { kind: "allowed" as const };
    },
    execute: async () => {
      executions += 1;
      return {} as never;
    },
  });

  const response = await handler(
    new Request("https://app.example/api/internal/github-tool", {
      body: JSON.stringify({
        operation: OPERATION,
        operationId: "88888888-8888-4888-8888-888888888888",
      }),
      headers: {
        authorization: ["Bearer", Buffer.alloc(32).toString("base64url")].join(
          " "
        ),
      },
      method: "POST",
      signal: controller.signal,
    })
  );

  assert.equal(response.status, 408);
  assert.equal(admissions, 0);
  assert.equal(executions, 0);
});

test("the absolute deadline is checked even when timer delivery is delayed by synchronous admission work", async () => {
  let executions = 0;
  const handler = createGitHubToolHttpHandler({
    bodyDeadlineMs: 10,
    enforceAbuse: async () => {
      const blockedUntil = Date.now() + 30;
      while (Date.now() < blockedUntil) {
        // Intentionally block timer delivery to prove the absolute clock fence.
      }
      return { kind: "allowed" as const };
    },
    execute: async () => {
      executions += 1;
      return {} as never;
    },
  });

  const response = await handler(
    new Request("https://app.example/api/internal/github-tool", {
      body: JSON.stringify({
        operation: OPERATION,
        operationId: "88888888-8888-4888-8888-888888888888",
      }),
      headers: {
        authorization: ["Bearer", Buffer.alloc(32).toString("base64url")].join(
          " "
        ),
      },
      method: "POST",
    })
  );

  assert.equal(response.status, 408);
  assert.equal(executions, 0);
});

test("a non-settling stream cancellation cannot hold the timeout response open", {
  timeout: 500,
}, async () => {
  let cancelCalls = 0;
  let executions = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelCalls += 1;
      return new Promise(() => undefined);
    },
    pull() {
      return new Promise(() => undefined);
    },
  });
  const handler = createGitHubToolHttpHandler({
    bodyDeadlineMs: 10,
    enforceAbuse: async () => ({ kind: "allowed" as const }),
    execute: async () => {
      executions += 1;
      return {} as never;
    },
  });
  const response = await handler(
    new Request("https://app.example/api/internal/github-tool", {
      body,
      duplex: "half",
      headers: {
        authorization: ["Bearer", Buffer.alloc(32).toString("base64url")].join(
          " "
        ),
      },
      method: "POST",
    } as RequestInit & { duplex: "half" })
  );

  assert.equal(response.status, 408);
  assert.equal(cancelCalls, 1);
  assert.equal(executions, 0);
});

test("invalid UTF-8 split across chunks is cancelled and rejected before reservation", {
  timeout: 500,
}, async () => {
  const rawCapability = Buffer.alloc(32, 0x5a).toString("base64url");
  let cancelled = false;
  let reservations = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
    start(controller) {
      controller.enqueue(
        new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3])
      );
      controller.enqueue(new Uint8Array([0x28, 0x22, 0x7d]));
    },
  });
  const handler = createGitHubToolHttpHandler({
    enforceAbuse: async () => ({ kind: "allowed" as const }),
    execute: async () => {
      reservations += 1;
      throw new Error("invalid UTF-8 must not reserve");
    },
  });

  const response = await handler(
    new Request("https://app.example/api/internal/github-tool", {
      body,
      duplex: "half",
      headers: { authorization: ["Bearer", rawCapability].join(" ") },
      method: "POST",
    } as RequestInit & { duplex: "half" })
  );

  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    error: {
      code: "request_invalid",
      message: "GitHub tool request is invalid.",
      retryable: false,
    },
  });
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
  assert.equal(reservations, 0);
});

test("an endless oversized request stream is cancelled before reservation", {
  timeout: 500,
}, async () => {
  const rawCapability = Buffer.alloc(32, 0x5b).toString("base64url");
  let cancelled = false;
  let reservations = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
    pull(controller) {
      controller.enqueue(new Uint8Array(64 * 1024));
    },
  });
  const handler = createGitHubToolHttpHandler({
    enforceAbuse: async () => ({ kind: "allowed" as const }),
    execute: async () => {
      reservations += 1;
      throw new Error("oversized body must not reserve");
    },
  });

  const response = await handler(
    new Request("https://app.example/api/internal/github-tool", {
      body,
      duplex: "half",
      headers: { authorization: ["Bearer", rawCapability].join(" ") },
      method: "POST",
    } as RequestInit & { duplex: "half" })
  );

  assert.equal(response.status, 413);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
  assert.equal(reservations, 0);
});
