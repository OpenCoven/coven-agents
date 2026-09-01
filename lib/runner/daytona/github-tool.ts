// biome-ignore-all lint/style/useErrorCause: Staging and client failures deliberately discard provider details that may contain authority.
import "server-only";

import { githubToolRequestSchema } from "@opencoven/agent-contracts";
import {
  COVEN_GITHUB_MCP_PATH,
  COVEN_GITHUB_TOOL_PATH,
} from "@opencoven/harness";
import { z } from "zod";
import { daytonaRunSessionName } from "./names";

export const GITHUB_TOOL_CLIENT_VERSION = "v1";
export const GITHUB_TOOL_CLIENT_MAX_BYTES = 512 * 1024;
export const GITHUB_TOOL_CLIENT_TIMEOUT_MS = 10_000;
const GITHUB_TOOL_DIRECTORY = `/tmp/coven-tools/${GITHUB_TOOL_CLIENT_VERSION}`;
const FILE_OPERATION_TIMEOUT_SECONDS = 15;
const RAW_CAPABILITY = /^[A-Za-z0-9_-]{43}$/u;

function normalizedEndpoint(value: string): string {
  try {
    const endpoint = new URL(value);
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.href !== value ||
      value.length > 2048
    ) {
      throw new Error("invalid endpoint");
    }
    return endpoint.href;
  } catch {
    throw new Error("GitHub tool endpoint is invalid.");
  }
}

function clientSource(expectedEndpoint: string): string {
  return `#!/usr/bin/env node
"use strict";
const MAX_BYTES = ${GITHUB_TOOL_CLIENT_MAX_BYTES};
const TIMEOUT_MS = ${GITHUB_TOOL_CLIENT_TIMEOUT_MS};
const EXPECTED_ENDPOINT = ${JSON.stringify(expectedEndpoint)};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
function write(value, ok) {
  let encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_BYTES) {
    encoded = JSON.stringify({ error: { code: "github_tool_output_too_large", message: "GitHub tool response was too large.", retryable: false } });
    ok = false;
  }
  process.stdout.write(encoded + "\\n");
  process.exitCode = ok ? 0 : 1;
}
async function readBounded(stream, signal) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    if (signal.aborted) throw new Error("aborted");
    const bytes = Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_BYTES) throw new Error("oversize");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}
async function main() {
  if (process.argv.length !== 2) throw new Error("arguments");
  const endpointValue = process.env.COVEN_GITHUB_TOOL_URL;
  let capability = process.env.COVEN_GITHUB_CAPABILITY;
  delete process.env.COVEN_GITHUB_CAPABILITY;
  if (!endpointValue || !TOKEN.test(capability || "")) throw new Error("configuration");
  const endpoint = new URL(endpointValue);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.href !== EXPECTED_ENDPOINT) throw new Error("endpoint");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const input = await readBounded(process.stdin, controller.signal);
    const request = JSON.parse(input);
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("request");
    const keys = Object.keys(request).sort();
    if (keys.length !== 2 || keys[0] !== "operation" || keys[1] !== "operationId" || !UUID.test(request.operationId) || !request.operation || typeof request.operation !== "object" || Array.isArray(request.operation)) throw new Error("request");
    const response = await fetch(endpoint, {
      body: JSON.stringify(request),
      headers: {
        Authorization: "Bearer " + capability,
        "Content-Type": "application/json"
      },
      method: "POST",
      redirect: "error",
      signal: controller.signal
    });
    capability = "";
    const body = await readBounded(response.body || [], controller.signal);
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("response");
    write(parsed, response.ok);
  } finally {
    clearTimeout(timer);
    capability = "";
  }
}
main().catch(() => write({ error: { code: "github_tool_client_failed", message: "GitHub tool request failed.", retryable: false } }, false));
`;
}

function mcpSource(expectedEndpoint: string): string {
  const inputSchema = z.toJSONSchema(githubToolRequestSchema);
  return `#!/usr/bin/env node
"use strict";
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const CLIENT_PATH = ${JSON.stringify(COVEN_GITHUB_TOOL_PATH)};
const EXPECTED_ENDPOINT = ${JSON.stringify(expectedEndpoint)};
const INPUT_SCHEMA = ${JSON.stringify(inputSchema)};
const MAX_BYTES = ${GITHUB_TOOL_CLIENT_MAX_BYTES};
const TIMEOUT_MS = ${GITHUB_TOOL_CLIENT_TIMEOUT_MS + 2000};
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
let capability = process.env.COVEN_GITHUB_CAPABILITY || "";
const endpoint = process.env.COVEN_GITHUB_TOOL_URL || "";
delete process.env.COVEN_GITHUB_CAPABILITY;
delete process.env.COVEN_GITHUB_TOOL_URL;
if (!TOKEN.test(capability) || endpoint !== EXPECTED_ENDPOINT) process.exit(1);
function send(value) {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") <= MAX_BYTES) {
    process.stdout.write(encoded + "\\n");
  }
}
function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}
function callClient(argumentsValue) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (operation) => {
      if (!settled) {
        settled = true;
        operation();
      }
    };
    const child = spawn(CLIENT_PATH, [], {
      env: {
        COVEN_GITHUB_CAPABILITY: capability,
        COVEN_GITHUB_TOOL_URL: EXPECTED_ENDPOINT,
        HOME: process.env.HOME || "",
        HTTPS_PROXY: process.env.HTTPS_PROXY || "",
        NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS || "",
        NO_PROXY: process.env.NO_PROXY || "",
        PATH: process.env.PATH || "",
        SSL_CERT_DIR: process.env.SSL_CERT_DIR || "",
        SSL_CERT_FILE: process.env.SSL_CERT_FILE || ""
      },
      shell: false,
      stdio: ["pipe", "pipe", "ignore"]
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(() => reject(new Error("timeout")));
    }, TIMEOUT_MS);
    const chunks = [];
    let total = 0;
    child.stdout.on("data", (chunk) => {
      total += chunk.byteLength;
      if (total > MAX_BYTES) {
        child.kill("SIGKILL");
        settle(() => reject(new Error("oversize")));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.once("error", () => {
      clearTimeout(timer);
      settle(() => reject(new Error("start")));
    });
    child.once("close", () => {
      clearTimeout(timer);
      settle(() => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("response");
          resolve(parsed);
        } catch {
          reject(new Error("response"));
        }
      });
    });
    child.stdin.end(JSON.stringify(argumentsValue));
  });
}
async function handle(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  const id = message.id;
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: message.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "CovenGitHub", version: "${GITHUB_TOOL_CLIENT_VERSION}" }
      }
    });
    return;
  }
  if (message.method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [{
          name: "execute",
          description: "Execute one server-authorized GitHub operation.",
          inputSchema: INPUT_SCHEMA
        }]
      }
    });
    return;
  }
  if (message.method === "tools/call") {
    if (message.params?.name !== "execute") {
      sendError(id, -32602, "Unknown tool.");
      return;
    }
    try {
      const result = await callClient(message.params.arguments);
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result) }],
          isError: Boolean(result.error),
          structuredContent: result
        }
      });
    } catch {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: "{\\"error\\":{\\"code\\":\\"github_tool_client_failed\\",\\"message\\":\\"GitHub tool request failed.\\",\\"retryable\\":false}}" }],
          isError: true
        }
      });
    }
    return;
  }
  if (id !== undefined && id !== null) {
    sendError(id, -32601, "Method not found.");
  }
}
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (Buffer.byteLength(line, "utf8") > MAX_BYTES) return;
  try {
    void handle(JSON.parse(line));
  } catch {
    // Ignore malformed frames without logging authority-bearing data.
  }
});
process.on("exit", () => {
  capability = "";
});
`;
}

export type GitHubToolFileSystem = Readonly<{
  createFolder: (path: string, mode: string) => Promise<void>;
  deleteFile: (path: string, recursive?: boolean) => Promise<void>;
  setFilePermissions: (
    path: string,
    permissions: Readonly<{ mode: string }>
  ) => Promise<void>;
  uploadFile: (
    file: Buffer,
    remotePath: string,
    timeout?: number
  ) => Promise<void>;
}>;

export function githubToolClientPath(): string {
  return COVEN_GITHUB_TOOL_PATH;
}

export function githubToolMcpPath(): string {
  return COVEN_GITHUB_MCP_PATH;
}

export function githubToolCapabilityPath(
  runId: string,
  attemptId: string
): string {
  return `/tmp/${daytonaRunSessionName(runId, attemptId)}.github-capability`;
}

export function githubToolClientArtifact(url: string): Readonly<{
  content: string;
  mode: "755";
  path: string;
  version: string;
}> {
  const endpoint = normalizedEndpoint(url);
  return {
    content: clientSource(endpoint),
    mode: "755",
    path: COVEN_GITHUB_TOOL_PATH,
    version: GITHUB_TOOL_CLIENT_VERSION,
  };
}

export function githubToolMcpArtifact(url: string): Readonly<{
  content: string;
  mode: "755";
  path: string;
  version: string;
}> {
  const endpoint = normalizedEndpoint(url);
  return {
    content: mcpSource(endpoint),
    mode: "755",
    path: COVEN_GITHUB_MCP_PATH,
    version: GITHUB_TOOL_CLIENT_VERSION,
  };
}

export async function cleanupGitHubToolCapability(
  filesystem: Pick<GitHubToolFileSystem, "deleteFile">,
  runId: string,
  attemptId: string
): Promise<void> {
  try {
    await filesystem.deleteFile(githubToolCapabilityPath(runId, attemptId));
  } catch {
    throw new Error("GitHub capability file cleanup failed.");
  }
}

export async function stageGitHubTool(
  filesystem: GitHubToolFileSystem,
  input: Readonly<{
    attemptId: string;
    rawCapability: string;
    runId: string;
    url: string;
  }>
): Promise<
  Readonly<{
    capabilityPath: string;
    clientPath: string;
    toolDirectory: string;
  }>
> {
  if (!RAW_CAPABILITY.test(input.rawCapability)) {
    throw new Error("GitHub tool staging failed.");
  }
  const capabilityPath = githubToolCapabilityPath(input.runId, input.attemptId);
  const artifact = githubToolClientArtifact(input.url);
  const mcpArtifact = githubToolMcpArtifact(input.url);
  try {
    await filesystem.createFolder(GITHUB_TOOL_DIRECTORY, "755");
    await filesystem.uploadFile(
      Buffer.from(artifact.content, "utf8"),
      COVEN_GITHUB_TOOL_PATH,
      FILE_OPERATION_TIMEOUT_SECONDS
    );
    await filesystem.setFilePermissions(COVEN_GITHUB_TOOL_PATH, {
      mode: "755",
    });
    await filesystem.uploadFile(
      Buffer.from(mcpArtifact.content, "utf8"),
      COVEN_GITHUB_MCP_PATH,
      FILE_OPERATION_TIMEOUT_SECONDS
    );
    await filesystem.setFilePermissions(COVEN_GITHUB_MCP_PATH, {
      mode: "755",
    });
    const capabilityBytes = Buffer.from(input.rawCapability, "utf8");
    try {
      await filesystem.uploadFile(
        capabilityBytes,
        capabilityPath,
        FILE_OPERATION_TIMEOUT_SECONDS
      );
    } finally {
      capabilityBytes.fill(0);
    }
    await filesystem.setFilePermissions(capabilityPath, { mode: "600" });
    return {
      capabilityPath,
      clientPath: COVEN_GITHUB_TOOL_PATH,
      toolDirectory: GITHUB_TOOL_DIRECTORY,
    };
  } catch {
    try {
      await filesystem.deleteFile(capabilityPath);
    } catch {
      // The caller retains the attempt for deterministic reconciliation.
    }
    throw new Error("GitHub tool staging failed.");
  }
}
