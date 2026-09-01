// biome-ignore-all lint/performance/noAwaitInLoops lint/suspicious/useAwait: The smoke server and subprocess preserve asynchronous lifecycle boundaries.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildInvocation,
  COVEN_GITHUB_CAPABILITY_ENV_REFERENCE,
  COVEN_GITHUB_TOOL_URL_ENV_REFERENCE,
} from "./invocation";

const PINNED_COPILOT_VERSION = "1.0.80";
const CAPABILITY = "A".repeat(43);
const TOOL_URL = "https://gateway.invalid/api/internal/github-tool";

function platformPackage(): string {
  if (process.platform === "darwin") {
    return `@github/copilot-darwin-${process.arch}`;
  }
  if (process.platform === "win32") {
    return `@github/copilot-win32-${process.arch}`;
  }
  if (process.platform === "linux") {
    const report = process.report?.getReport() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined;
    const glibc = report?.header?.glibcVersionRuntime;
    return `@github/copilot-${glibc ? "linux" : "linuxmusl"}-${process.arch}`;
  }
  throw new Error(`Unsupported Copilot smoke platform: ${process.platform}`);
}

async function pinnedCopilotApp(): Promise<string> {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve("@github/copilot/package.json");
  const packageValue = JSON.parse(await readFile(packageJson, "utf8")) as {
    version: string;
  };
  assert.equal(packageValue.version, PINNED_COPILOT_VERSION);
  const platformRequire = createRequire(packageJson);
  const platformEntry = platformRequire.resolve(platformPackage());
  const platformJson = join(dirname(platformEntry), "package.json");
  const platformValue = JSON.parse(await readFile(platformJson, "utf8")) as {
    version: string;
  };
  assert.equal(platformValue.version, PINNED_COPILOT_VERSION);
  return join(dirname(platformJson), "app.js");
}

function providerResponse(): string {
  return JSON.stringify({
    created_at: 1,
    id: "resp_coven_smoke",
    model: "gpt-5.4",
    object: "response",
    output: [
      {
        content: [
          {
            annotations: [],
            text: "smoke complete",
            type: "output_text",
          },
        ],
        id: "msg_coven_smoke",
        role: "assistant",
        status: "completed",
        type: "message",
      },
    ],
    parallel_tool_calls: true,
    status: "completed",
    tool_choice: "auto",
    tools: [],
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 12,
    },
  });
}

test("Copilot 1.0.80 isolates workspace MCP and exposes only bounded tools", {
  timeout: 60_000,
}, async () => {
  const scratch = join(
    dirname(fileURLToPath(import.meta.url)),
    `.copilot-mcp-smoke-${process.pid}`
  );
  await rm(scratch, { force: true, recursive: true });
  await mkdir(scratch, { recursive: true });
  const attemptDir = join(scratch, "attempt");
  const workspace = join(scratch, "workspace");
  await mkdir(attemptDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await chmod(attemptDir, 0o500);
  const observedEnvPath = join(scratch, "observed-env.json");
  const maliciousObservedPath = join(scratch, "malicious-started.json");
  const maliciousProbePath = join(scratch, "malicious-probe.cjs");
  const probePath = join(scratch, "probe.cjs");
  const probeSource = `
const fs = require("node:fs");
const readline = require("node:readline");
fs.writeFileSync(${JSON.stringify(observedEnvPath)}, JSON.stringify({
  capability: process.env.COVEN_GITHUB_CAPABILITY ?? null,
  toolUrl: process.env.COVEN_GITHUB_TOOL_URL ?? null,
  hasCopilotCredential: Object.hasOwn(process.env, "COPILOT_GITHUB_TOKEN")
}));
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "CovenGitHub", version: "v1" }
      }
    }) + "\\n");
  } else if (message.method === "tools/list") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [{
          name: "execute",
          description: "smoke",
          inputSchema: { type: "object", additionalProperties: false, properties: {} }
        }]
      }
    }) + "\\n");
  }
});
`;
  await writeFile(probePath, probeSource, { mode: 0o600 });
  await writeFile(
    maliciousProbePath,
    probeSource.replace(
      JSON.stringify(observedEnvPath),
      JSON.stringify(maliciousObservedPath)
    ),
    { mode: 0o600 }
  );
  await writeFile(
    join(workspace, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        WorkspaceOwned: {
          args: [maliciousProbePath],
          command: process.execPath,
          type: "local",
        },
      },
    }),
    { mode: 0o600 }
  );

  const invocation = buildInvocation({
    attemptDir,
    configDir: join(scratch, "copilot-home"),
    cwd: workspace,
    githubTool: true,
    harness: "copilot",
    instructions: "Return smoke complete.",
    model: "gpt-5.4",
    permissionMode: "workspace_read",
    stream: true,
    task: "Do not call tools.",
  });
  const args = [...invocation.args];
  const configIndex = args.indexOf("--additional-mcp-config") + 1;
  const config = JSON.parse(args[configIndex] ?? "") as {
    mcpServers: Record<
      string,
      {
        args: string[];
        command: string;
        env: Record<string, string>;
        tools: string[];
        type: string;
      }
    >;
  };
  config.mcpServers.CovenGitHub.command = process.execPath;
  config.mcpServers.CovenGitHub.args = [probePath];
  args[configIndex] = JSON.stringify(config);
  assert.deepEqual(args.slice(args.indexOf("-C"), args.indexOf("-C") + 4), [
    "-C",
    attemptDir,
    "--add-dir",
    workspace,
  ]);
  assert.deepEqual(config.mcpServers.CovenGitHub.env, {
    COVEN_GITHUB_CAPABILITY: COVEN_GITHUB_CAPABILITY_ENV_REFERENCE,
    COVEN_GITHUB_TOOL_URL: COVEN_GITHUB_TOOL_URL_ENV_REFERENCE,
  });
  assert.equal(args.join("\n").includes(CAPABILITY), false);
  assert.equal(args.join("\n").includes(TOOL_URL), false);

  const app = await pinnedCopilotApp();
  const requests: Record<string, unknown>[] = [];
  const provider = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(providerResponse());
    });
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve)
  );
  const address = provider.address();
  assert.ok(address && typeof address === "object");

  const child = spawn(process.execPath, [app, ...args], {
    cwd: workspace,
    env: {
      ...process.env,
      COPILOT_GITHUB_TOKEN: "copilot-credential-must-not-reach-mcp",
      COPILOT_MODEL: "gpt-5.4",
      COPILOT_PROVIDER_API_KEY: "smoke",
      COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      COPILOT_PROVIDER_WIRE_API: "responses",
      COVEN_GITHUB_CAPABILITY: CAPABILITY,
      COVEN_GITHUB_TOOL_URL: TOOL_URL,
    },
    stdio: ["ignore", "ignore", "ignore"],
  });

  try {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      try {
        if (requests.length > 0) {
          await readFile(observedEnvPath, "utf8");
          break;
        }
      } catch {
        // The pinned CLI has not started the MCP process yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const observed = JSON.parse(await readFile(observedEnvPath, "utf8")) as {
      capability: string | null;
      hasCopilotCredential: boolean;
      toolUrl: string | null;
    };
    assert.deepEqual(observed, {
      capability: CAPABILITY,
      hasCopilotCredential: false,
      toolUrl: TOOL_URL,
    });
    await assert.rejects(readFile(maliciousObservedPath, "utf8"));
    assert.ok(requests.length > 0);
    const visibleTools = [
      ...new Set(
        requests.flatMap((request) =>
          Array.isArray(request.tools)
            ? request.tools.map((tool) =>
                String((tool as { name?: unknown }).name ?? "")
              )
            : []
        )
      ),
    ];
    assert.deepEqual(visibleTools.sort(), [
      "CovenGitHub-execute",
      "glob",
      "view",
    ]);
    assert.equal(
      visibleTools.some((name) =>
        /bash|shell|web|url|curl|network/iu.test(name)
      ),
      false
    );
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 1000).unref();
    });
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(scratch, { force: true, recursive: true });
  }
});
