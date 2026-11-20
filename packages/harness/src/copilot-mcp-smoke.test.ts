// biome-ignore-all lint/performance/noAwaitInLoops lint/suspicious/useAwait: The smoke server and subprocess preserve asynchronous lifecycle boundaries.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildInvocation,
  COVEN_GITHUB_CAPABILITY_ENV_REFERENCE,
  COVEN_GITHUB_TOOL_URL_ENV_REFERENCE,
} from "./invocation";

// This is the local smoke dependency, not the separately pinned runtime image.
const smokeManifest = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8")
) as { devDependencies: Record<string, string> };
const PINNED_COPILOT_VERSION = smokeManifest.devDependencies["@github/copilot"];
assert.match(PINNED_COPILOT_VERSION, /^\d+\.\d+\.\d+$/u);
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

async function pinnedCopilotApp(
  expectedVersion = PINNED_COPILOT_VERSION
): Promise<string> {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve("@github/copilot/package.json");
  const packageValue = JSON.parse(await readFile(packageJson, "utf8")) as {
    version: string;
  };
  assert.equal(packageValue.version, expectedVersion);
  const platformRequire = createRequire(packageJson);
  const platformEntry = platformRequire.resolve(platformPackage());
  const platformJson = join(dirname(platformEntry), "package.json");
  const platformValue = JSON.parse(await readFile(platformJson, "utf8")) as {
    version: string;
  };
  assert.equal(platformValue.version, expectedVersion);
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

interface SmokeFixture {
  attemptDir: string;
  child?: ChildProcess;
  provider: Server;
  requests: Record<string, unknown>[];
  scratch: string;
  startCli: (
    args: readonly string[],
    env?: Record<string, string>
  ) => Promise<void>;
  stderr: string;
  workspace: string;
}

type ResolveSmokeApp = (fixture: SmokeFixture) => Promise<string>;

async function withCopilotSmoke<T>(
  run: (fixture: SmokeFixture) => Promise<T>,
  resolveApp: ResolveSmokeApp = () => pinnedCopilotApp(),
  reply: (fixture: SmokeFixture) => string = providerResponse
): Promise<T> {
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
      response.end(reply(fixture));
    });
  });
  const scratch = await mkdtemp(
    join(dirname(fileURLToPath(import.meta.url)), ".copilot-smoke-")
  );
  const home = join(scratch, "home");
  let childClosed: Promise<void> | undefined;
  const fixture: SmokeFixture = {
    attemptDir: join(scratch, "attempt"),
    provider,
    requests,
    scratch,
    async startCli(args, env = {}) {
      assert.equal(fixture.child, undefined, "one CLI per smoke fixture");
      const address = provider.address();
      assert.ok(address && typeof address === "object");
      const app = await resolveApp(fixture);
      const child = spawn(process.execPath, [app, ...args], {
        cwd: fixture.workspace,
        env: {
          ...env,
          COPILOT_DISABLE_KEYTAR: "1",
          COPILOT_HOME: join(scratch, "copilot-home"),
          COPILOT_MODEL: "gpt-5.4",
          // Offline mode disables GitHub auth, telemetry, and update traffic.
          COPILOT_OFFLINE: "true",
          COPILOT_PROVIDER_API_KEY: "smoke",
          COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
          COPILOT_PROVIDER_WIRE_API: "responses",
          HOME: home,
          PATH: dirname(process.execPath),
          SystemRoot: process.env.SystemRoot,
          TEMP: join(scratch, "tmp"),
          TMP: join(scratch, "tmp"),
          TMPDIR: join(scratch, "tmp"),
          USERPROFILE: home,
          XDG_CACHE_HOME: join(home, ".cache"),
          XDG_CONFIG_HOME: join(home, ".config"),
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      fixture.child = child;
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        fixture.stderr += chunk;
      });
      childClosed = new Promise<void>((resolve) =>
        child.once("close", () => resolve())
      );
      await once(child, "spawn");
    },
    stderr: "",
    workspace: join(scratch, "workspace"),
  };

  try {
    await mkdir(fixture.attemptDir);
    await mkdir(fixture.workspace);
    await mkdir(home);
    await mkdir(join(scratch, "tmp"));
    await chmod(fixture.attemptDir, 0o500);
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    return await run(fixture);
  } finally {
    try {
      const { child } = fixture;
      if (child) {
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
        killTimer.unref();
        try {
          if (
            child.pid &&
            child.exitCode === null &&
            child.signalCode === null
          ) {
            child.kill("SIGTERM");
          }
          await childClosed;
        } finally {
          clearTimeout(killTimer);
        }
      }
    } finally {
      try {
        if (provider.listening) {
          const closed = new Promise<void>((resolve, reject) =>
            provider.close((error) => (error ? reject(error) : resolve()))
          );
          provider.closeAllConnections();
          await closed;
        }
      } finally {
        await rm(scratch, { force: true, recursive: true });
      }
    }
  }
}

async function waitForProvider(fixture: SmokeFixture): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (fixture.requests.length === 0) {
    assert.ok(
      fixture.child &&
        fixture.child.exitCode === null &&
        fixture.child.signalCode === null,
      `Copilot exited before contacting the mock provider: ${fixture.stderr}`
    );
    assert.ok(
      Date.now() < deadline,
      `Copilot did not contact the mock provider: ${fixture.stderr}`
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function restrictedVisibleTools(
  permissionMode: "workspace_read" | "workspace_write",
  resolveApp?: ResolveSmokeApp
): Promise<{
  args: readonly string[];
  visibleTools: string[];
}> {
  return await withCopilotSmoke(async (fixture) => {
    const { attemptDir, scratch, workspace, requests } = fixture;
    await writeFile(join(workspace, "needle.txt"), "workspace needle\n", {
      mode: 0o600,
    });
    const invocation = buildInvocation({
      attemptDir,
      configDir: join(scratch, "copilot-home"),
      cwd: workspace,
      harness: "copilot",
      instructions: "Return smoke complete.",
      model: "gpt-5.4",
      permissionMode,
      stream: true,
      task: "Do not call tools.",
    });
    await fixture.startCli(invocation.args);
    await waitForProvider(fixture);
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
    ].sort();
    return { args: invocation.args, visibleTools };
  }, resolveApp);
}

test("read-only Copilot handles denied file and command requests without effects", {
  timeout: 60_000,
}, async () => {
  await withCopilotSmoke(
    async (fixture) => {
      const inside = join(fixture.workspace, "inside.txt");
      const outside = join(fixture.scratch, "outside.txt");
      const marker = join(fixture.workspace, "command-ran");
      await Promise.all(
        [inside, outside].map((path) => writeFile(path, "original"))
      );
      const invocation = buildInvocation({
        attemptDir: fixture.attemptDir,
        configDir: join(fixture.scratch, "copilot-home"),
        cwd: fixture.workspace,
        harness: "copilot",
        instructions: "Read the indicated file.",
        model: "gpt-5.4",
        permissionMode: "workspace_read",
        task: "Inspect inside.txt.",
      });
      await fixture.startCli(invocation.args);
      await waitForProvider(fixture);
      const deadline = Date.now() + 20_000;
      while (fixture.requests.length < 2) {
        assert.ok(Date.now() < deadline, "missing tool results");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const input = fixture.requests[1].input as {
        type: string;
        call_id?: string;
        output?: string;
      }[];
      const outputs = new Map(
        input
          .filter((item) => item.type === "function_call_output")
          .map((item) => [item.call_id, item.output])
      );
      assert.equal(outputs.get("read"), "original");
      for (const id of ["change_inside", "change_outside", "command"]) {
        assert.match(outputs.get(id) ?? "", /does not exist/u);
      }
      assert.deepEqual(
        await Promise.all(
          [inside, outside].map((path) => readFile(path, "utf8"))
        ),
        ["original", "original"]
      );
      await assert.rejects(stat(marker), { code: "ENOENT" });
    },
    undefined,
    (fixture) => {
      if (fixture.requests.length > 1) {
        return providerResponse();
      }
      const response = JSON.parse(providerResponse());
      const inside = join(fixture.workspace, "inside.txt");
      const outside = join(fixture.scratch, "outside.txt");
      response.output = [
        ["read", "view", { path: inside }],
        [
          "change_inside",
          "apply_patch",
          {
            patch: `*** Begin Patch\n*** Update File: ${inside}\n@@\n-original\n+changed\n*** End Patch`,
          },
        ],
        [
          "change_outside",
          "apply_patch",
          {
            patch: `*** Begin Patch\n*** Update File: ${outside}\n@@\n-original\n+changed\n*** End Patch`,
          },
        ],
        [
          "command",
          "bash",
          {
            command: "echo executed > command-ran",
            description: "fixture marker",
          },
        ],
      ].map(([id, name, args]) => ({
        arguments: JSON.stringify(args),
        call_id: id,
        id: `fc_${id}`,
        name,
        status: "completed",
        type: "function_call",
      }));
      return JSON.stringify(response);
    }
  );
});

test("Copilot smoke version matches the repository's exact dependency pin", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../../package.json", import.meta.url), "utf8")
  ) as { devDependencies: Record<string, string> };
  assert.match(manifest.devDependencies["@github/copilot"], /^\d+\.\d+\.\d+$/u);
  assert.equal(
    PINNED_COPILOT_VERSION,
    manifest.devDependencies["@github/copilot"]
  );
  await pinnedCopilotApp();
});

for (const failure of [
  "version validation",
  "synchronous spawn",
  "asynchronous spawn",
] as const) {
  test(`Copilot smoke cleans up after ${failure} failure`, {
    timeout: 10_000,
  }, async () => {
    let resources: SmokeFixture | undefined;
    try {
      await assert.rejects(
        restrictedVisibleTools("workspace_read", async (fixture) => {
          resources = fixture;
          if (failure === "asynchronous spawn") {
            await rm(fixture.workspace, { recursive: true });
            return await pinnedCopilotApp();
          }
          return failure === "version validation"
            ? pinnedCopilotApp("0.0.0")
            : Promise.resolve("\0");
        }),
        failure === "version validation"
          ? { code: "ERR_ASSERTION" }
          : {
              code:
                failure === "synchronous spawn"
                  ? "ERR_INVALID_ARG_VALUE"
                  : "ENOENT",
            }
      );
      assert.ok(resources);
      assert.equal(resources.provider.listening, false, "mock provider leaked");
      await assert.rejects(stat(resources.scratch), {
        code: "ENOENT",
      });
    } finally {
      // Keep the regression runnable even when the smoke helper leaks.
      if (resources) {
        const { provider, scratch } = resources;
        provider.closeAllConnections();
        await new Promise<void>((resolve) => provider.close(() => resolve()));
        await rm(scratch, { force: true, recursive: true });
      }
    }
  });
}

for (const outcome of ["already exited", "ignores SIGTERM"] as const) {
  test(`Copilot smoke cleans up a child that ${outcome}`, {
    skip:
      outcome === "ignores SIGTERM" && process.platform === "win32"
        ? "Windows terminates children forcibly on SIGTERM"
        : false,
    timeout: 10_000,
  }, async () => {
    let resources: SmokeFixture | undefined;
    await withCopilotSmoke(
      async (fixture) => {
        resources = fixture;
        await fixture.startCli([]);
        assert.ok(fixture.child);
        if (outcome === "already exited") {
          await once(fixture.child, "close");
        } else {
          assert.ok(fixture.child.stderr);
          await once(fixture.child.stderr, "data");
        }
      },
      async (fixture) => {
        const app = join(fixture.scratch, "child.cjs");
        await writeFile(
          app,
          outcome === "already exited"
            ? "process.exitCode = 0;"
            : 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.stderr.write("ready");'
        );
        return app;
      }
    );
    assert.ok(resources?.child);
    assert.equal(resources.provider.listening, false);
    await assert.rejects(stat(resources.scratch), { code: "ENOENT" });
    if (outcome === "already exited") {
      assert.equal(resources.child.exitCode, 0);
    } else {
      assert.equal(resources.child.signalCode, "SIGKILL");
    }
  });
}

test(`Copilot ${PINNED_COPILOT_VERSION} workspace_read exposes view, rg, and glob without write, shell, or network`, {
  timeout: 60_000,
}, async () => {
  const smoke = await restrictedVisibleTools("workspace_read");
  assert.deepEqual(smoke.visibleTools, ["glob", "rg", "view"]);
  assert.equal(
    smoke.visibleTools.some((name) =>
      /apply_patch|bash|shell|web|url|curl|network/iu.test(name)
    ),
    false
  );
  assert.equal(smoke.args.includes("--allow-tool"), false);
});

test(`Copilot ${PINNED_COPILOT_VERSION} workspace_write exposes apply_patch but no shell or network`, {
  timeout: 60_000,
}, async () => {
  const smoke = await restrictedVisibleTools("workspace_write");
  assert.deepEqual(smoke.visibleTools, ["apply_patch", "glob", "rg", "view"]);
  assert.equal(
    smoke.visibleTools.some((name) =>
      /bash|shell|web|url|curl|network/iu.test(name)
    ),
    false
  );
  assert.deepEqual(
    smoke.args.filter(
      (_argument, index) => smoke.args[index - 1] === "--allow-tool"
    ),
    ["write"]
  );
});

test(
  `Copilot ${PINNED_COPILOT_VERSION} isolates workspace MCP and exposes only bounded tools`,
  {
    timeout: 60_000,
  },
  async () =>
    withCopilotSmoke(async (fixture) => {
      const { attemptDir, scratch, workspace, requests } = fixture;
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

      await fixture.startCli(args, {
        COPILOT_GITHUB_TOKEN: "copilot-credential-must-not-reach-mcp",
        COVEN_GITHUB_CAPABILITY: CAPABILITY,
        COVEN_GITHUB_TOOL_URL: TOOL_URL,
      });

      await waitForProvider(fixture);
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
        "rg",
        "view",
      ]);
      assert.equal(
        visibleTools.some((name) =>
          /bash|shell|web|url|curl|network/iu.test(name)
        ),
        false
      );
    })
);
