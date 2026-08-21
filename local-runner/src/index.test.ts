import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { AGENT_RUNNER_API_VERSION } from "@opencoven/agent-contracts";
import { createLocalRunner } from "./index.js";

const token = "test-runner-token";

class FakeChild extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly stdout = new EventEmitter();
  signal: NodeJS.Signals | undefined;

  kill(signal?: NodeJS.Signals): boolean {
    this.signal = signal;
    return true;
  }

  close(exitCode: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("close", exitCode, signal);
  }
}

async function waitFor<T>(
  read: () => T | Promise<T | undefined> | undefined,
  timeoutMs = 1000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: Each observation must finish before retrying.
    const value = await read();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for test runner work.");
}

async function withRunner(
  callback: (context: {
    baseUrl: string;
    child: () => FakeChild | undefined;
    close: () => Promise<void>;
  }) => Promise<void>,
  options: { runTimeoutMs?: number } = {}
): Promise<void> {
  const fixture = join(
    process.cwd(),
    ".test-artifacts",
    `local-runner-${process.pid}-${randomUUID()}`
  );
  const root = join(fixture, "root");
  const storePath = join(fixture, "agents.json");
  await mkdir(root, { recursive: true });
  let spawned: FakeChild | undefined;
  const runner = createLocalRunner({
    root,
    runTimeoutMs: options.runTimeoutMs,
    spawn: (() => {
      spawned = new FakeChild();
      return spawned;
    }) as unknown as typeof import("node:child_process").spawn,
    storePath,
    token,
  });
  await runner.initialize();
  await new Promise<void>((resolve) => runner.server.listen(0, resolve));
  const address = runner.server.address() as AddressInfo;

  try {
    await callback({
      baseUrl: `http://127.0.0.1:${address.port}`,
      child: () => spawned,
      close: () =>
        new Promise((resolve, reject) =>
          runner.server.close((error) => (error ? reject(error) : resolve()))
        ),
    });
  } finally {
    await new Promise<void>((resolve) => runner.server.close(() => resolve()));
    await rm(fixture, { force: true, recursive: true });
  }
}

function request(
  baseUrl: string,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

async function createAgent(baseUrl: string): Promise<{ id: string }> {
  const response = await request(baseUrl, "/api/agents", {
    body: JSON.stringify({
      backend: "local",
      instructions: "Run the supplied mission.",
      model: "auto",
      name: "Runner test",
      runtime: "copilot",
      workspace: ".",
    }),
    method: "POST",
  });
  if (response.status !== 201) {
    assert.fail(await response.text());
  }
  return ((await response.json()) as { agent: { id: string } }).agent;
}

async function startRun(
  baseUrl: string,
  agentId: string,
  task = "Run focused tests."
): Promise<{ id: string }> {
  const response = await request(baseUrl, `/api/agents/${agentId}/runs`, {
    body: JSON.stringify({ operationId: randomUUID(), task }),
    method: "POST",
  });
  assert.equal(response.status, 202);
  return ((await response.json()) as { run: { id: string } }).run;
}

test("accepts an asynchronous run and deduplicates its operation", async () => {
  await withRunner(async ({ baseUrl, child }) => {
    const agent = await createAgent(baseUrl);
    const operationId = randomUUID();
    const body = JSON.stringify({ operationId, task: "Run focused tests." });

    const accepted = await request(baseUrl, `/api/agents/${agent.id}/runs`, {
      body,
      method: "POST",
    });
    const acceptedPayload = (await accepted.json()) as {
      apiVersion: string;
      run: { id: string; status: string };
    };
    assert.equal(accepted.status, 202);
    assert.equal(acceptedPayload.apiVersion, AGENT_RUNNER_API_VERSION);
    assert.match(acceptedPayload.run.status, /queued|running/);

    const repeated = await request(baseUrl, `/api/agents/${agent.id}/runs`, {
      body,
      method: "POST",
    });
    const repeatedPayload = (await repeated.json()) as {
      run: { id: string };
    };
    assert.equal(repeated.status, 202);
    assert.equal(repeatedPayload.run.id, acceptedPayload.run.id);

    const conflict = await request(baseUrl, `/api/agents/${agent.id}/runs`, {
      body: JSON.stringify({ operationId, task: "Run a different mission." }),
      method: "POST",
    });
    const error = (await conflict.json()) as {
      apiVersion: string;
      error: { code: string };
    };
    assert.equal(conflict.status, 409);
    assert.equal(error.apiVersion, AGENT_RUNNER_API_VERSION);
    assert.equal(error.error.code, "operation_conflict");

    const activeChild = await waitFor(child);
    activeChild.close(0);
    await waitFor(async () => {
      const response = await request(
        baseUrl,
        `/api/runs/${acceptedPayload.run.id}`
      );
      const current = (await response.json()) as { run: { status: string } };
      return current.run.status === "completed" ? current : undefined;
    });
    await waitFor(async () => {
      const response = await request(baseUrl, `/api/agents/${agent.id}`);
      const current = (await response.json()) as { agent: { status: string } };
      return current.agent.status === "idle" ? current : undefined;
    });
  });
});

test("cancels only the active child and replays events after the cursor", async () => {
  await withRunner(async ({ baseUrl, child }) => {
    const agent = await createAgent(baseUrl);
    const run = await startRun(baseUrl, agent.id, "Run until stopped.");
    const activeChild = await waitFor(child);

    const stopped = await request(baseUrl, `/api/runs/${run.id}/stop`, {
      method: "POST",
    });
    assert.equal(stopped.status, 200);
    assert.equal(activeChild.signal, "SIGTERM");

    activeChild.close(null, "SIGTERM");
    const current = await waitFor(async () => {
      const response = await request(baseUrl, `/api/runs/${run.id}`);
      const body = (await response.json()) as { run: { status: string } };
      return body.run.status === "cancelled" ? body : undefined;
    });
    assert.equal(current.run.status, "cancelled");
    await waitFor(async () => {
      const response = await request(baseUrl, `/api/agents/${agent.id}`);
      const body = (await response.json()) as { agent: { status: string } };
      return body.agent.status === "idle" ? body : undefined;
    });

    const events = await request(baseUrl, `/api/runs/${run.id}/events`, {
      headers: { "last-event-id": "1" },
    });
    const replay = await events.text();
    assert.match(
      events.headers.get("content-type") ?? "",
      /^text\/event-stream/
    );
    assert.equal(replay.includes("id: 1\n"), false);
    assert.match(replay, /event: status|event: completed|event: failed/);
  });
});

test("retains failed evidence when the local CLI output cap is exceeded", async () => {
  await withRunner(async ({ baseUrl, child }) => {
    const agent = await createAgent(baseUrl);
    const run = await startRun(baseUrl, agent.id);
    const activeChild = await waitFor(child);

    activeChild.stdout.emit("data", Buffer.alloc(2 * 1024 * 1024 + 1, "x"));
    assert.equal(activeChild.signal, "SIGTERM");
    activeChild.close(null, "SIGTERM");

    const failed = await waitFor(async () => {
      const response = await request(baseUrl, `/api/runs/${run.id}`);
      const current = (await response.json()) as {
        run: {
          commandEvidence: unknown[];
          error: { code: string } | null;
          output: string;
          status: string;
        };
      };
      return current.run.status === "failed" ? current : undefined;
    });
    assert.equal(failed.run.error?.code, "output_limit");
    assert.equal(failed.run.commandEvidence.length, 1);
    assert.match(failed.run.output, /output limit/);
    await waitFor(async () => {
      const response = await request(baseUrl, `/api/agents/${agent.id}`);
      const current = (await response.json()) as { agent: { status: string } };
      return current.agent.status === "error" ? current : undefined;
    });
  });
});

test("retains failed evidence when the local CLI cannot start", async () => {
  await withRunner(async ({ baseUrl, child }) => {
    const agent = await createAgent(baseUrl);
    const run = await startRun(baseUrl, agent.id);
    const activeChild = await waitFor(child);
    await waitFor(async () => {
      const response = await request(baseUrl, `/api/runs/${run.id}`);
      const current = (await response.json()) as { run: { status: string } };
      return current.run.status === "running" ? current : undefined;
    });
    activeChild.emit("error", new Error("spawn copilot ENOENT"));

    const failed = await waitFor(async () => {
      const response = await request(baseUrl, `/api/runs/${run.id}`);
      const current = (await response.json()) as {
        run: {
          commandEvidence: unknown[];
          error: { code: string } | null;
          status: string;
        };
      };
      return current.run.status === "failed" ? current : undefined;
    });
    assert.equal(failed.run.error?.code, "cli_unavailable");
    assert.equal(failed.run.commandEvidence.length, 1);
    await waitFor(async () => {
      const response = await request(baseUrl, `/api/agents/${agent.id}`);
      const current = (await response.json()) as { agent: { status: string } };
      return current.agent.status === "error" ? current : undefined;
    });
  });
});

test("retains timeout evidence after terminating the specific child", async () => {
  await withRunner(
    async ({ baseUrl, child }) => {
      const agent = await createAgent(baseUrl);
      const run = await startRun(baseUrl, agent.id);
      const activeChild = await waitFor(child);
      await waitFor(() =>
        activeChild.signal === "SIGTERM" ? activeChild : undefined
      );
      activeChild.close(null, "SIGTERM");

      const failed = await waitFor(async () => {
        const response = await request(baseUrl, `/api/runs/${run.id}`);
        const current = (await response.json()) as {
          run: {
            error: { code: string } | null;
            status: string;
          };
        };
        return current.run.status === "failed" ? current : undefined;
      });
      assert.equal(failed.run.error?.code, "timeout");
      await waitFor(async () => {
        const response = await request(baseUrl, `/api/agents/${agent.id}`);
        const current = (await response.json()) as {
          agent: { status: string };
        };
        return current.agent.status === "error" ? current : undefined;
      });
    },
    { runTimeoutMs: 5 }
  );
});

test("persists only sanitized local output and event evidence", async () => {
  await withRunner(async ({ baseUrl, child }) => {
    const agent = await createAgent(baseUrl);
    const run = await startRun(baseUrl, agent.id, "Capture safe diagnostics.");
    const activeChild = await waitFor(child);
    const secrets = [
      "bearer-local-value",
      "runner-access-value",
      "local-password-value",
      "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
    ];

    activeChild.stdout.emit(
      "data",
      Buffer.from(
        [
          "preflight: local runner started",
          "Authorization: Bearer bearer-local-value",
          "RUNNER_ACCESS_KEY=runner-access-value",
          "DATABASE_PASSWORD=local-password-value",
          "PATH=/usr/local/bin",
          "HOME=/root",
          "SHELL=/bin/sh",
          "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
          "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
          "postflight: focused checks passed",
        ].join("\n")
      )
    );
    activeChild.close(0);

    const completed = await waitFor(async () => {
      const response = await request(baseUrl, `/api/runs/${run.id}`);
      const current = (await response.json()) as {
        run: { status: string };
      };
      return current.run.status === "completed" ? current : undefined;
    });
    const persisted = JSON.stringify(completed);
    const events = await request(baseUrl, `/api/runs/${run.id}/events`);
    const replay = await events.text();

    for (const secret of secrets) {
      assert.equal(persisted.includes(secret), false, `persisted ${secret}`);
      assert.equal(replay.includes(secret), false, `streamed ${secret}`);
    }
    assert.match(persisted, /preflight: local runner started/);
    assert.match(persisted, /postflight: focused checks passed/);
    assert.match(replay, /\[environment output redacted\]/);
  });
});

test("does not leak environment dumps split across local output events", async () => {
  await withRunner(async ({ baseUrl, child }) => {
    const agent = await createAgent(baseUrl);
    const run = await startRun(
      baseUrl,
      agent.id,
      "Capture streamed diagnostics."
    );
    const activeChild = await waitFor(child);

    activeChild.stdout.emit("data", Buffer.from("PATH=/usr/local/bin\n"));
    activeChild.stdout.emit("data", Buffer.from("HOME=/root\n"));
    activeChild.stdout.emit("data", Buffer.from("SHELL=/bin/sh\n"));
    activeChild.stdout.emit("data", Buffer.from("focused checks passed\n"));
    activeChild.close(0);

    const completed = await waitFor(async () => {
      const response = await request(baseUrl, `/api/runs/${run.id}`);
      const current = (await response.json()) as {
        run: { status: string };
      };
      return current.run.status === "completed" ? current : undefined;
    });
    const events = await request(baseUrl, `/api/runs/${run.id}/events`);
    const replay = await events.text();
    const persisted = JSON.stringify(completed);

    for (const leakedValue of ["/usr/local/bin", "/root", "/bin/sh"]) {
      assert.equal(persisted.includes(leakedValue), false);
      assert.equal(replay.includes(leakedValue), false);
    }
    assert.match(replay, /\[environment assignment redacted\]/);
    assert.match(replay, /focused checks passed/);
  });
});
