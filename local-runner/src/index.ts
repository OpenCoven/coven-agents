import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { resolve } from "node:path";
import {
  type AgentDefinition,
  agentIdSchema,
  createAgentInputSchema,
  type RunResult,
  runAgentInputSchema,
} from "@opencoven/agent-contracts";
import { buildInvocation } from "./runtime.js";
import { AgentStore } from "./store.js";

const port = Number(process.env.OPENCOVEN_LOCAL_PORT ?? "7331");
const root = resolve(process.env.OPENCOVEN_LOCAL_ROOT ?? process.cwd());
const token = process.env.OPENCOVEN_LOCAL_TOKEN ?? "";
const allowedOrigin =
  process.env.OPENCOVEN_ALLOWED_ORIGIN ?? "http://localhost:3000";
const storePath = resolve(
  process.env.OPENCOVEN_AGENT_STORE ?? ".opencoven/agents.json"
);
const runTimeoutMs = Number(process.env.OPENCOVEN_RUN_TIMEOUT_MS ?? "900000");
const maxOutputBytes = 2 * 1024 * 1024;
const maxBodyBytes = 64 * 1024;
const store = new AgentStore(storePath);

if (!token) {
  throw new Error("OPENCOVEN_LOCAL_TOKEN is required.");
}

function setCors(request: IncomingMessage, response: ServerResponse) {
  if (request.headers.origin === allowedOrigin) {
    response.setHeader("access-control-allow-origin", allowedOrigin);
  }
  response.setHeader(
    "access-control-allow-headers",
    "authorization, content-type"
  );
  response.setHeader(
    "access-control-allow-methods",
    "GET, POST, DELETE, OPTIONS"
  );
  response.setHeader("vary", "Origin");
}

function sendJson(
  response: ServerResponse,
  value: unknown,
  status = 200
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function authorized(request: IncomingMessage): boolean {
  const supplied = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(token);
  return (
    suppliedBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(suppliedBytes, expectedBytes)
  );
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBodyBytes) {
      throw new RequestError(
        "Request body is too large.",
        413,
        "body_too_large"
      );
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: RequestError forwards this options object to Error.
    throw new RequestError(
      "Request body must be valid JSON.",
      400,
      "invalid_json",
      { cause: error }
    );
  }
}

class RequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(
    message: string,
    status: number,
    code: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.code = code;
    this.status = status;
  }
}

async function executeAgent(
  definition: AgentDefinition,
  task: string
): Promise<RunResult> {
  const invocation = buildInvocation(definition, task, root);
  const startedAt = new Date().toISOString();
  await store.upsert({
    ...definition,
    status: "running",
    updatedAt: startedAt,
  });

  const child = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let outputSize = 0;
  let outputExceeded = false;

  function collect(target: "stdout" | "stderr", chunk: Buffer) {
    outputSize += chunk.byteLength;
    if (outputSize > maxOutputBytes) {
      outputExceeded = true;
      child.kill("SIGTERM");
      return;
    }
    if (target === "stdout") {
      stdout += chunk.toString("utf8");
    } else {
      stderr += chunk.toString("utf8");
    }
  }

  child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, runTimeoutMs);

  let exitCode: number | null = null;
  try {
    exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    });
  } catch (error) {
    stderr +=
      error instanceof Error ? error.message : "The local CLI could not start.";
  } finally {
    clearTimeout(timer);
  }

  const completedAt = new Date().toISOString();
  const status =
    exitCode === 0 && !timedOut && !outputExceeded ? "completed" : "failed";
  const output = [
    stdout.trim(),
    stderr.trim() ? `\n[stderr]\n${stderr.trim()}` : "",
    timedOut
      ? "\nRunner stopped the process after the configured timeout."
      : "",
    outputExceeded
      ? "\nRunner stopped the process after the output limit."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  const result: RunResult = {
    agentId: definition.id,
    commandResults: [
      {
        command: `${invocation.command} ${invocation.args[0] ?? ""}`.trim(),
        exitCode,
        stderr,
        stdout,
      },
    ],
    completedAt,
    fileOperations: [],
    id: randomUUID(),
    output,
    startedAt,
    status,
  };
  await store.upsert({
    ...definition,
    lastRunAt: completedAt,
    status: status === "completed" ? "idle" : "error",
    updatedAt: completedAt,
  });
  return result;
}

const server = createServer(async (request, response) => {
  setCors(request, response);
  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }
  if (request.url === "/api/health" && request.method === "GET") {
    sendJson(response, { mode: "local", ok: true, root });
    return;
  }
  if (!authorized(request)) {
    sendJson(
      response,
      { code: "unauthorized", error: "Runner token was rejected." },
      401
    );
    return;
  }

  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/agents") {
      if (request.method === "GET") {
        sendJson(response, { agents: await store.list() });
        return;
      }
      if (request.method === "POST") {
        const input = createAgentInputSchema.parse(await readJson(request));
        if (input.backend !== "local") {
          throw new RequestError(
            "Local runner only accepts local agents.",
            400,
            "backend_mismatch"
          );
        }
        const now = new Date().toISOString();
        const definition: AgentDefinition = {
          ...input,
          createdAt: now,
          id: randomUUID(),
          lastRunAt: null,
          status: "idle",
          updatedAt: now,
        };
        buildInvocation(definition, "Validate configuration.", root);
        await store.upsert(definition);
        sendJson(response, { agent: definition }, 201);
        return;
      }
    }

    const match = url.pathname.match(/^\/api\/agents\/([^/]+)(?:\/(runs))?$/);
    if (match) {
      const [, rawId, action] = match;
      const id = agentIdSchema.parse(decodeURIComponent(rawId ?? ""));
      const agent = await store.get(id);
      if (!agent) {
        throw new RequestError("Agent was not found.", 404, "not_found");
      }
      if (!action && request.method === "GET") {
        sendJson(response, { agent });
        return;
      }
      if (!action && request.method === "DELETE") {
        await store.remove(id);
        sendJson(response, { ok: true });
        return;
      }
      if (action === "runs" && request.method === "POST") {
        if (agent.status === "running") {
          throw new RequestError(
            "Agent is already running a mission.",
            409,
            "already_running"
          );
        }
        const { task } = runAgentInputSchema.parse(await readJson(request));
        sendJson(response, { run: await executeAgent(agent, task) });
        return;
      }
    }

    throw new RequestError("Route was not found.", 404, "not_found");
  } catch (error) {
    if (error instanceof RequestError) {
      sendJson(
        response,
        { code: error.code, error: error.message },
        error.status
      );
      return;
    }
    if (error instanceof Error && error.name === "ZodError") {
      sendJson(
        response,
        { code: "invalid_request", error: "Request validation failed." },
        400
      );
      return;
    }
    console.error(error);
    sendJson(
      response,
      { code: "internal_error", error: "Runner request failed." },
      500
    );
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(
    JSON.stringify({
      event: "opencoven.local_runner.started",
      root,
      store: storePath,
      url: `http://127.0.0.1:${port}`,
    })
  );
});
