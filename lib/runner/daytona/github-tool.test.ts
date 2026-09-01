// biome-ignore-all lint/suspicious/useAwait: Filesystem doubles intentionally preserve promise-shaped SDK methods.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  cleanupGitHubToolCapability,
  GITHUB_TOOL_CLIENT_MAX_BYTES,
  GITHUB_TOOL_CLIENT_TIMEOUT_MS,
  GITHUB_TOOL_CLIENT_VERSION,
  githubToolCapabilityPath,
  githubToolClientArtifact,
  githubToolClientPath,
  githubToolMcpArtifact,
  githubToolMcpPath,
  stageGitHubTool,
} from "./github-tool";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const RAW_CAPABILITY = Buffer.alloc(32, 0x5c).toString("base64url");

test("the versioned client is a fixed bounded stdin-only gateway executable", () => {
  assert.equal(GITHUB_TOOL_CLIENT_VERSION, "v1");
  assert.equal(GITHUB_TOOL_CLIENT_MAX_BYTES, 512 * 1024);
  assert.equal(GITHUB_TOOL_CLIENT_TIMEOUT_MS, 10_000);
  assert.equal(githubToolClientPath(), "/tmp/coven-tools/v1/coven-github");
  assert.equal(githubToolMcpPath(), "/tmp/coven-tools/v1/coven-github-mcp");
  const artifact = githubToolClientArtifact(
    "https://app.example/api/internal/github-tool"
  );
  assert.equal(artifact.path, githubToolClientPath());
  assert.equal(artifact.mode, "755");
  assert.match(artifact.content, /^#!\/usr\/bin\/env node\n/u);
  assert.match(artifact.content, /process\.stdin/u);
  assert.match(artifact.content, /COVEN_GITHUB_TOOL_URL/u);
  assert.match(
    artifact.content,
    /EXPECTED_ENDPOINT = "https:\/\/app\.example\/api\/internal\/github-tool"/u
  );
  assert.match(artifact.content, /endpoint\.href !== EXPECTED_ENDPOINT/u);
  assert.match(artifact.content, /COVEN_GITHUB_CAPABILITY/u);
  assert.match(artifact.content, /Authorization/u);
  assert.match(artifact.content, /redirect:\s*"error"/u);
  assert.match(artifact.content, /process\.argv\.length !== 2/u);
  assert.match(artifact.content, /AbortController/u);
  assert.doesNotMatch(artifact.content, /\bgh\b|api\.github\.com|graphql/u);
  assert.doesNotMatch(artifact.content, new RegExp(RAW_CAPABILITY, "u"));
  assert.ok(Buffer.byteLength(artifact.content, "utf8") <= 16_384);

  const mcp = githubToolMcpArtifact(
    "https://app.example/api/internal/github-tool"
  );
  assert.equal(mcp.path, githubToolMcpPath());
  assert.equal(mcp.mode, "755");
  assert.match(mcp.content, /tools\/list/u);
  assert.match(mcp.content, /tools\/call/u);
  assert.match(mcp.content, /CovenGitHub/u);
  assert.match(mcp.content, /"execute"/u);
  assert.match(mcp.content, /spawn\(CLIENT_PATH, \[\]/u);
  assert.match(mcp.content, /shell:\s*false/u);
  assert.doesNotMatch(mcp.content, /\.\.\.process\.env/u);
  assert.doesNotMatch(mcp.content, /COPILOT_GITHUB_TOKEN/u);
  for (const kind of [
    "issue.get",
    "issue.search",
    "issue.create",
    "issue.comment",
    "pull.get",
    "pull.create",
    "pull.comment",
    "pull.review",
    "project.item.add",
    "project.item.field.update",
  ]) {
    assert.ok(mcp.content.includes(kind), kind);
  }
  assert.doesNotMatch(mcp.content, /\bgh\b|api\.github\.com/u);
  assert.doesNotMatch(mcp.content, new RegExp(RAW_CAPABILITY, "u"));
  assert.ok(Buffer.byteLength(mcp.content, "utf8") <= 32_768);
});

test("Daytona filesystem upload stages executable and 0600 attempt capability without command or env interpolation", async () => {
  const calls: Array<{ args: unknown[]; name: string }> = [];
  const filesystem = {
    createFolder: async (...args: unknown[]) => {
      calls.push({ args, name: "createFolder" });
    },
    deleteFile: async (...args: unknown[]) => {
      calls.push({ args, name: "deleteFile" });
    },
    setFilePermissions: async (...args: unknown[]) => {
      calls.push({ args, name: "setFilePermissions" });
    },
    uploadFile: async (...args: unknown[]) => {
      calls.push({
        args: [
          Buffer.isBuffer(args[0]) ? Buffer.from(args[0]) : args[0],
          ...args.slice(1),
        ],
        name: "uploadFile",
      });
    },
  };

  const staged = await stageGitHubTool(filesystem, {
    attemptId: ATTEMPT_ID,
    rawCapability: RAW_CAPABILITY,
    runId: RUN_ID,
    url: "https://app.example/api/internal/github-tool",
  });

  assert.deepEqual(staged, {
    capabilityPath: githubToolCapabilityPath(RUN_ID, ATTEMPT_ID),
    clientPath: githubToolClientPath(),
    toolDirectory: "/tmp/coven-tools/v1",
  });
  assert.deepEqual(
    calls.map(({ name }) => name),
    [
      "createFolder",
      "uploadFile",
      "setFilePermissions",
      "uploadFile",
      "setFilePermissions",
      "uploadFile",
      "setFilePermissions",
    ]
  );
  const [
    folderCall,
    clientUpload,
    clientMode,
    mcpUpload,
    mcpMode,
    tokenUpload,
    tokenMode,
  ] = calls;
  assert.ok(folderCall);
  assert.ok(clientUpload);
  assert.ok(clientMode);
  assert.ok(mcpUpload);
  assert.ok(mcpMode);
  assert.ok(tokenUpload);
  assert.ok(tokenMode);
  assert.deepEqual(folderCall.args, ["/tmp/coven-tools/v1", "755"]);
  assert.equal(
    Buffer.isBuffer(clientUpload.args[0]) &&
      (clientUpload.args[0] as Buffer).toString("utf8"),
    githubToolClientArtifact("https://app.example/api/internal/github-tool")
      .content
  );
  assert.deepEqual(clientMode.args, [githubToolClientPath(), { mode: "755" }]);
  assert.equal(
    Buffer.isBuffer(mcpUpload.args[0]) &&
      (mcpUpload.args[0] as Buffer).toString("utf8"),
    githubToolMcpArtifact("https://app.example/api/internal/github-tool")
      .content
  );
  assert.deepEqual(mcpMode.args, [githubToolMcpPath(), { mode: "755" }]);
  assert.equal(
    Buffer.isBuffer(tokenUpload.args[0]) &&
      (tokenUpload.args[0] as Buffer).toString("utf8"),
    RAW_CAPABILITY
  );
  assert.deepEqual(tokenMode.args, [
    githubToolCapabilityPath(RUN_ID, ATTEMPT_ID),
    { mode: "600" },
  ]);
  assert.equal(
    calls.some(({ name }) => name === "executeCommand"),
    false
  );
});

test("the staged MCP adapter advertises exactly one strict typed execute tool", () => {
  const source = githubToolMcpArtifact(
    "https://app.example/api/internal/github-tool"
  ).content.replace(/^#![^\n]*\n/u, "");
  const result = spawnSync(process.execPath, ["--eval", source], {
    encoding: "utf8",
    env: {
      ...process.env,
      COVEN_GITHUB_CAPABILITY: RAW_CAPABILITY,
      COVEN_GITHUB_TOOL_URL: "https://app.example/api/internal/github-tool",
    },
    input: [
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      }),
      JSON.stringify({ id: 2, jsonrpc: "2.0", method: "tools/list" }),
      "",
    ].join("\n"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const messages = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(messages.length, 2);
  assert.deepEqual(
    messages[1].result.tools.map((tool: { name: string }) => tool.name),
    ["execute"]
  );
  const schema = messages[1].result.tools[0].inputSchema;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required.sort(), ["operation", "operationId"]);
  assert.equal(JSON.stringify(messages).includes(RAW_CAPABILITY), false);
});

test("capability cleanup is exact and cleanup failures fail closed", async () => {
  const paths: string[] = [];
  await cleanupGitHubToolCapability(
    {
      deleteFile: async (path: string) => {
        paths.push(path);
      },
    },
    RUN_ID,
    ATTEMPT_ID
  );
  assert.deepEqual(paths, [githubToolCapabilityPath(RUN_ID, ATTEMPT_ID)]);

  await assert.rejects(
    cleanupGitHubToolCapability(
      {
        deleteFile: async () => {
          throw new Error(`provider leaked ${RAW_CAPABILITY}`);
        },
      },
      RUN_ID,
      ATTEMPT_ID
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "GitHub capability file cleanup failed." &&
      !error.message.includes(RAW_CAPABILITY)
  );
});

test("failed capability staging attempts exact cleanup and never includes raw authority in errors", async () => {
  const deleted: string[] = [];
  await assert.rejects(
    stageGitHubTool(
      {
        createFolder: async () => undefined,
        deleteFile: async (path: string) => {
          deleted.push(path);
        },
        setFilePermissions: async (path: string) => {
          if (path === githubToolCapabilityPath(RUN_ID, ATTEMPT_ID)) {
            throw new Error(RAW_CAPABILITY);
          }
        },
        uploadFile: async () => undefined,
      },
      {
        attemptId: ATTEMPT_ID,
        rawCapability: RAW_CAPABILITY,
        runId: RUN_ID,
        url: "https://app.example/api/internal/github-tool",
      }
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "GitHub tool staging failed." &&
      !error.message.includes(RAW_CAPABILITY)
  );
  assert.deepEqual(deleted, [githubToolCapabilityPath(RUN_ID, ATTEMPT_ID)]);
});
