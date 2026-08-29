#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const PLATFORM_RESIDUE_SCANNER_PATH = "scripts/platform-residue-scan.ts";
export const LOCKFILE_OPTIONAL_PEER_MARKER = "@cloudflare/workers-types";

export const RETIRED_INTEGRATION_MARKERS = [
  "cloudflare",
  "@cloudflare",
  "cloudflare:workers",
  "workers.dev",
  "wrangler",
  "workerd",
  "durable object",
  "durable objects",
  "cloudflare-workers-ai",
  "DEMO_RUNNER_",
  "EDGE_",
  "RUNNER_URL",
  "ALLOWED_ORIGIN",
  "x-runner-token",
  "x-service-token",
  "miniflare",
  "partyserver",
  "@opencoven/cloud-runner",
  "AGENT_CONTROL_TOKEN",
  "RUNNER_SERVICE_TOKEN",
  "RUNNER_SIGNING_",
  "RUNNER_VERIFY_",
  "RUNNER_AUTH_VERSION",
  "RUN_SCOPED_IDENTITY_WRITES_ENABLED",
  "CREDENTIAL_LEGACY_LENDING_ENABLED",
  "RUNNER_RECONCILE_SECRET",
  "OLD_RUNTIME_MODE",
] as const;

export type PlatformResidueFinding = {
  kind: "content" | "filename";
  line: number;
  marker: string;
  path: string;
};

export type TrackedEntry = {
  content: string;
  path: string;
};

export type PlatformScanMode = "index" | "worktree";

const LOCKFILE_PATH = "pnpm-lock.yaml";
const MAX_GIT_OUTPUT_BYTES = 50 * 1024 * 1024;
const orderedMarkers = [...new Set(RETIRED_INTEGRATION_MARKERS)].sort(
  (left, right) => right.length - left.length
);

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function matchingMarker(value: string): string | undefined {
  const normalized = value.toLocaleLowerCase("en-US");
  return orderedMarkers.find((marker) =>
    normalized.includes(marker.toLocaleLowerCase("en-US"))
  );
}

function owningLockfileSection(
  lines: readonly string[],
  index: number
): string | undefined {
  for (let current = index - 1; current >= 0; current -= 1) {
    const line = lines[current] ?? "";
    if (/^ {4}\S/u.test(line)) {
      return line;
    }
    if (/^ {2}\S/u.test(line)) {
      return undefined;
    }
  }
  return undefined;
}

function allowedLockfileMarkerLines(lines: readonly string[]): Set<number> {
  const markerLines = lines
    .map((line, index) => ({ index, line }))
    .filter(({ line }) =>
      line
        .toLocaleLowerCase("en-US")
        .includes(LOCKFILE_OPTIONAL_PEER_MARKER.toLocaleLowerCase("en-US"))
    );
  if (markerLines.length !== 2) {
    return new Set();
  }

  const packageStart = lines.findIndex((line) =>
    /^ {2}drizzle-orm@[^:]+:$/u.test(line)
  );
  if (packageStart === -1) {
    return new Set();
  }
  const packageEnd = lines.findIndex(
    (line, index) => index > packageStart && /^ {2}\S/u.test(line)
  );
  const end = packageEnd === -1 ? lines.length : packageEnd;
  if (markerLines.some(({ index }) => index <= packageStart || index >= end)) {
    return new Set();
  }

  const dependencyLine = markerLines.find(
    ({ index, line }) =>
      line === `      '${LOCKFILE_OPTIONAL_PEER_MARKER}': '>=4'` &&
      owningLockfileSection(lines, index) === "    peerDependencies:"
  );
  const metadataLine = markerLines.find(
    ({ index, line }) =>
      line === `      '${LOCKFILE_OPTIONAL_PEER_MARKER}':` &&
      lines[index + 1] === "        optional: true" &&
      owningLockfileSection(lines, index) === "    peerDependenciesMeta:"
  );

  if (!(dependencyLine && metadataLine)) {
    return new Set();
  }
  return new Set([dependencyLine.index, metadataLine.index]);
}

export function scanTrackedEntries(
  entries: readonly TrackedEntry[]
): PlatformResidueFinding[] {
  const findings: PlatformResidueFinding[] = [];

  for (const entry of entries) {
    const path = normalizePath(entry.path);
    if (path === PLATFORM_RESIDUE_SCANNER_PATH) {
      continue;
    }

    const filenameMarker = matchingMarker(path);
    if (filenameMarker) {
      findings.push({
        kind: "filename",
        line: 0,
        marker: filenameMarker,
        path,
      });
    }

    const lines = entry.content.split(/\r?\n/u);
    const allowedLines =
      path === LOCKFILE_PATH ? allowedLockfileMarkerLines(lines) : new Set();
    for (const [index, line] of lines.entries()) {
      if (allowedLines.has(index)) {
        continue;
      }
      const marker = matchingMarker(line);
      if (marker) {
        findings.push({
          kind: "content",
          line: index + 1,
          marker,
          path,
        });
      }
    }
  }

  return findings;
}

function gitOutput(cwd: string, args: readonly string[]): Buffer {
  return execFileSync("git", args, {
    cwd,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function nulDelimited(output: Buffer): string[] {
  return output.toString("utf8").split("\0").filter(Boolean);
}

function textContent(content: Buffer | string): string {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return buffer.includes(0) ? "" : buffer.toString("utf8");
}

function worktreePaths(cwd: string): string[] {
  return nulDelimited(
    gitOutput(cwd, [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ])
  );
}

function readWorktreeEntry(cwd: string, path: string): TrackedEntry | null {
  const absolutePath = join(cwd, path);
  let status: ReturnType<typeof lstatSync>;
  try {
    status = lstatSync(absolutePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  if (status.isDirectory()) {
    return { content: "", path };
  }

  const content = status.isSymbolicLink()
    ? readlinkSync(absolutePath, "utf8")
    : readFileSync(absolutePath);
  return { content: textContent(content), path };
}

type IndexEntry = {
  mode: string;
  objectId: string;
  path: string;
};

function indexEntries(cwd: string): IndexEntry[] {
  return nulDelimited(gitOutput(cwd, ["ls-files", "--stage", "-z"])).map(
    (record) => {
      const separator = record.indexOf("\t");
      if (separator === -1) {
        throw new Error("Could not parse Git index entry.");
      }
      const [mode, objectId, stage] = record.slice(0, separator).split(" ");
      if (!(mode && objectId && stage === "0")) {
        throw new Error(
          "The Git index contains an unmerged or unreadable entry."
        );
      }
      return { mode, objectId, path: record.slice(separator + 1) };
    }
  );
}

function readIndexEntries(cwd: string): TrackedEntry[] {
  const blobCache = new Map<string, string>();
  return indexEntries(cwd).map((entry) => {
    if (entry.mode === "160000") {
      return { content: "", path: entry.path };
    }

    let content = blobCache.get(entry.objectId);
    if (content === undefined) {
      content = textContent(
        gitOutput(cwd, ["cat-file", "blob", entry.objectId])
      );
      blobCache.set(entry.objectId, content);
    }
    return { content, path: entry.path };
  });
}

export function scanRepository(
  cwd = process.cwd(),
  mode: PlatformScanMode = "worktree"
): PlatformResidueFinding[] {
  const entries =
    mode === "index"
      ? readIndexEntries(cwd)
      : worktreePaths(cwd)
          .map((path) => readWorktreeEntry(cwd, path))
          .filter((entry): entry is TrackedEntry => entry !== null);
  return scanTrackedEntries(entries);
}

export function parsePlatformScanMode(
  args: readonly string[]
): PlatformScanMode {
  if (args.length === 0 || (args.length === 1 && args[0] === "--worktree")) {
    return "worktree";
  }
  if (args.length === 1 && args[0] === "--index") {
    return "index";
  }
  throw new Error("Usage: pnpm validate:platform-residue [--worktree|--index]");
}

function printablePath(path: string): string {
  return Array.from(path, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? "?" : character;
  }).join("");
}

export function renderFindings(
  findings: readonly PlatformResidueFinding[]
): string {
  return findings
    .map((finding) => {
      const location =
        finding.kind === "filename" ? "filename" : String(finding.line);
      return `${printablePath(finding.path)}:${location}: retired integration marker "${finding.marker}"`;
    })
    .join("\n");
}

function main(): number {
  let mode: PlatformScanMode;
  try {
    mode = parsePlatformScanMode(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
    return 2;
  }

  const findings = scanRepository(process.cwd(), mode);
  if (findings.length > 0) {
    process.stderr.write(`${renderFindings(findings)}\n`);
    return 1;
  }

  process.stdout.write(
    `Platform residue ${mode} scan passed. The only permitted lockfile matches are the two upstream drizzle-orm optional-peer metadata keys for @cloudflare/workers-types.\n`
  );
  return 0;
}

const [, entrypoint] = process.argv;
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = main();
}
