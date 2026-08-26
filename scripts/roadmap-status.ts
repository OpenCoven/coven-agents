#!/usr/bin/env tsx

import { randomUUID } from "node:crypto";
import {
  readFile as fsReadFile,
  rename as fsRename,
  unlink as fsUnlink,
  open,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { PROJECT_STATUSES, WAVES } from "./beads-project-model";
import { loadRoadmapProjectItems } from "./roadmap-project-status";
import {
  extractRoadmapSummary,
  renderRoadmapStatusBlock,
  replaceRoadmapStatusBlock,
} from "./roadmap-status-block";
import {
  ROADMAP_EXPECTED_ITEM_COUNT,
  type RoadmapProjectItem,
  type RoadmapSummary,
  sameRoadmapSummary,
  summarizeRoadmap,
} from "./roadmap-status-model";

export type RoadmapStatusConfig = {
  expectedCount: number;
  owner: string;
  projectNumber: number;
  roadmapPath: string;
};

export type RoadmapStatusDependencies = {
  loadItems: (
    owner: string,
    projectNumber: number
  ) => Promise<RoadmapProjectItem[]>;
  now: () => Date;
  readFile: (path: string) => Promise<string>;
  stderr: (text: string) => void;
  stdout: (text: string) => void;
  writeAtomic: (
    path: string,
    expectedSource: string,
    contents: string
  ) => Promise<void>;
};

type AtomicFileHandle = {
  close: () => Promise<void>;
  sync: () => Promise<void>;
  writeFile: (contents: string) => Promise<void>;
};

type AtomicDirectoryHandle = {
  close: () => Promise<void>;
  sync: () => Promise<void>;
};

export type AtomicWriteOperations = {
  openDirectory: (path: string) => Promise<AtomicDirectoryHandle>;
  openExclusive: (path: string) => Promise<AtomicFileHandle>;
  pid: number;
  randomUUID: () => string;
  readFile: (path: string) => Promise<string>;
  rename: (from: string, to: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
};

type ErrorCategory = "filesystem" | "project";

class RoadmapStatusOperationError extends Error {
  readonly category: ErrorCategory;

  constructor(category: ErrorCategory, options: ErrorOptions) {
    super(`Roadmap status ${category} operation failed`, options);
    this.category = category;
    this.name = "RoadmapStatusOperationError";
  }
}

const configSchema = z
  .object({
    expectedCount: z.number().int().positive(),
    owner: z.string().trim().min(1),
    projectNumber: z.number().int().positive(),
    roadmapPath: z.string().trim().min(1),
  })
  .strict();

const defaultAtomicWriteOperations: AtomicWriteOperations = {
  openDirectory: async (path) => {
    const handle = await open(path, "r");

    return {
      close: () => handle.close(),
      sync: () => handle.sync(),
    };
  },
  openExclusive: async (path) => {
    const handle = await open(path, "wx");

    return {
      close: () => handle.close(),
      sync: () => handle.sync(),
      writeFile: (contents) => handle.writeFile(contents, "utf8"),
    };
  },
  pid: process.pid,
  randomUUID,
  readFile: (path) => fsReadFile(path, "utf8"),
  rename: fsRename,
  unlink: fsUnlink,
};

function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }

  return undefined;
}

function isMissingFile(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  const code = errorCode(error);

  return (
    code === "EBADF" ||
    code === "EINVAL" ||
    code === "EISDIR" ||
    code === "ENOTSUP" ||
    code === "EPERM"
  );
}

async function cleanupCreatedFile(
  path: string,
  handle: AtomicFileHandle | undefined,
  operations: AtomicWriteOperations
): Promise<unknown[]> {
  const cleanupFailures: unknown[] = [];

  if (handle !== undefined) {
    try {
      await handle.close();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }

  try {
    await operations.unlink(path);
  } catch (error) {
    if (!isMissingFile(error)) {
      cleanupFailures.push(error);
    }
  }

  return cleanupFailures;
}

async function syncDirectory(
  path: string,
  operations: AtomicWriteOperations
): Promise<void> {
  let handle: AtomicDirectoryHandle;

  try {
    handle = await operations.openDirectory(path);
  } catch (error) {
    if (isUnsupportedDirectorySync(error)) {
      return;
    }

    throw error;
  }

  try {
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) {
      throw error;
    }
  } finally {
    await handle.close();
  }
}

export async function writeFileAtomic(
  path: string,
  expectedSource: string,
  contents: string,
  operations: AtomicWriteOperations = defaultAtomicWriteOperations
): Promise<void> {
  const directory = dirname(path);
  const lockPath = join(directory, `.${basename(path)}.lock`);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${operations.pid}.${operations.randomUUID()}.tmp`
  );
  let failure: unknown;
  let lockCreated = false;
  let lockHandle: AtomicFileHandle | undefined;
  let temporaryCreated = false;
  let temporaryHandle: AtomicFileHandle | undefined;

  try {
    lockHandle = await operations.openExclusive(lockPath);
    lockCreated = true;

    const currentSource = await operations.readFile(path);

    if (currentSource !== expectedSource) {
      throw new Error("ROADMAP.md changed after status refresh began");
    }

    temporaryHandle = await operations.openExclusive(temporaryPath);
    temporaryCreated = true;
    await temporaryHandle.writeFile(contents);
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await operations.rename(temporaryPath, path);
    temporaryCreated = false;
    await syncDirectory(directory, operations);
  } catch (error) {
    failure = error;
  }

  const cleanupFailures: unknown[] = [];

  if (temporaryCreated) {
    cleanupFailures.push(
      ...(await cleanupCreatedFile(temporaryPath, temporaryHandle, operations))
    );
  }

  if (lockCreated) {
    cleanupFailures.push(
      ...(await cleanupCreatedFile(lockPath, lockHandle, operations))
    );
  }

  if (failure !== undefined) {
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [failure, ...cleanupFailures],
        "Atomic write failed and cleanup was incomplete"
      );
    }

    throw failure;
  }

  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      cleanupFailures,
      "Atomic write cleanup was incomplete"
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

function isInventoryError(message: string): boolean {
  return (
    message.startsWith("Duplicate roadmap bead ID") ||
    /^Expected \d+ roadmap items, received \d+$/u.test(message) ||
    message.startsWith("Invalid roadmap bead ID")
  );
}

function isRoadmapBlockError(error: unknown, message: string): boolean {
  return (
    error instanceof SyntaxError ||
    message.startsWith("Expected exactly one roadmap") ||
    message.startsWith("Replacement must contain") ||
    message.startsWith("Roadmap blocked count") ||
    message.startsWith("Roadmap refreshed timestamp") ||
    message.startsWith("Roadmap status ") ||
    message.startsWith("Roadmap wave ") ||
    message.startsWith("Roadmap ")
  );
}

function isProjectError(message: string): boolean {
  return (
    message.startsWith("GitHub GraphQL") ||
    message.startsWith("GitHub organization") ||
    message.startsWith("GitHub Project") ||
    message.startsWith("Managed Project item") ||
    message.startsWith("Project field") ||
    message.startsWith("Project items reported") ||
    message.startsWith("gh command") ||
    message.startsWith("gh graphql")
  );
}

export function formatRoadmapStatusError(error: unknown): string {
  if (error instanceof RoadmapStatusOperationError) {
    return error.category === "project"
      ? "GitHub Project status query failed."
      : "Roadmap status filesystem operation failed.";
  }

  const message = errorMessage(error);

  if (isInventoryError(message)) {
    return "Roadmap Project inventory is invalid.";
  }

  if (error instanceof z.ZodError) {
    return "Roadmap status schema validation failed.";
  }

  if (isRoadmapBlockError(error, message)) {
    return "ROADMAP.md status markers or data are invalid.";
  }

  if (isProjectError(message)) {
    return "GitHub Project status query failed.";
  }

  if (errorCode(error) !== undefined) {
    return "Roadmap status filesystem operation failed.";
  }

  return "Roadmap status refresh failed.";
}

async function loadSource(
  path: string,
  readFile: RoadmapStatusDependencies["readFile"]
): Promise<string> {
  try {
    return await readFile(path);
  } catch (error) {
    throw new RoadmapStatusOperationError("filesystem", { cause: error });
  }
}

async function loadItems(
  owner: string,
  projectNumber: number,
  loader: RoadmapStatusDependencies["loadItems"]
): Promise<RoadmapProjectItem[]> {
  try {
    return await loader(owner, projectNumber);
  } catch (error) {
    throw new RoadmapStatusOperationError("project", { cause: error });
  }
}

async function writeUpdatedRoadmap(
  path: string,
  expectedSource: string,
  contents: string,
  writeAtomic: RoadmapStatusDependencies["writeAtomic"]
): Promise<void> {
  try {
    await writeAtomic(path, expectedSource, contents);
  } catch (error) {
    throw new RoadmapStatusOperationError("filesystem", { cause: error });
  }
}

function formatCountChange(
  label: string,
  current: number,
  next: number
): string | undefined {
  return current === next ? undefined : `${label} ${current} -> ${next}`;
}

function formatRoadmapSummaryDiff(
  current: RoadmapSummary,
  next: RoadmapSummary
): string {
  const changes: string[] = [];
  const managedChange = formatCountChange(
    "managed",
    current.totalCount,
    next.totalCount
  );
  const blockedChange = formatCountChange(
    "blocked",
    current.blockedCount,
    next.blockedCount
  );

  if (managedChange !== undefined) {
    changes.push(managedChange);
  }

  if (blockedChange !== undefined) {
    changes.push(blockedChange);
  }

  for (const status of PROJECT_STATUSES) {
    const statusChange = formatCountChange(
      `status ${status}`,
      current.byStatus[status],
      next.byStatus[status]
    );

    if (statusChange !== undefined) {
      changes.push(statusChange);
    }
  }

  for (const wave of WAVES) {
    const waveChanges: string[] = [];
    const currentWave = current.byWave[wave];
    const nextWave = next.byWave[wave];
    const totalChange = formatCountChange(
      "total",
      currentWave.total,
      nextWave.total
    );

    if (totalChange !== undefined) {
      waveChanges.push(totalChange);
    }

    for (const status of PROJECT_STATUSES) {
      const statusChange = formatCountChange(
        status,
        currentWave.byStatus[status],
        nextWave.byStatus[status]
      );

      if (statusChange !== undefined) {
        waveChanges.push(statusChange);
      }
    }

    const waveBlockedChange = formatCountChange(
      "blocked",
      currentWave.blockedCount,
      nextWave.blockedCount
    );

    if (waveBlockedChange !== undefined) {
      waveChanges.push(waveBlockedChange);
    }

    if (waveChanges.length > 0) {
      changes.push(`wave ${wave}: ${waveChanges.join(", ")}`);
    }
  }

  return `roadmap status: changed (${changes.join("; ")})\n`;
}

function isMode(
  value: string | undefined
): value is "apply" | "check" | "preview" {
  return value === "apply" || value === "check" || value === "preview";
}

export async function runRoadmapStatus(
  args: string[],
  config: RoadmapStatusConfig,
  dependencies: RoadmapStatusDependencies
): Promise<number> {
  const [mode] = args;

  if (args.length !== 1 || !isMode(mode)) {
    dependencies.stderr("Invalid roadmap status arguments.\n");
    return 2;
  }

  const parsedConfig = configSchema.safeParse(config);

  if (!parsedConfig.success) {
    dependencies.stderr("Invalid roadmap status configuration.\n");
    return 2;
  }

  const validatedConfig = parsedConfig.data;
  const [source, items] = await Promise.all([
    loadSource(validatedConfig.roadmapPath, dependencies.readFile),
    loadItems(
      validatedConfig.owner,
      validatedConfig.projectNumber,
      dependencies.loadItems
    ),
  ]);
  const nextSummary = summarizeRoadmap(items, validatedConfig.expectedCount);
  const currentSummary = extractRoadmapSummary(source);

  if (sameRoadmapSummary(currentSummary, nextSummary)) {
    dependencies.stdout("roadmap status: unchanged\n");
    return 0;
  }

  if (mode === "preview") {
    dependencies.stdout(formatRoadmapSummaryDiff(currentSummary, nextSummary));
    return 0;
  }

  if (mode === "check") {
    dependencies.stderr("ROADMAP.md aggregate status is stale.\n");
    return 1;
  }

  const replacement = renderRoadmapStatusBlock(
    nextSummary,
    dependencies.now().toISOString()
  );
  const updated = replaceRoadmapStatusBlock(source, replacement);
  await writeUpdatedRoadmap(
    validatedConfig.roadmapPath,
    source,
    updated,
    dependencies.writeAtomic
  );
  dependencies.stdout("roadmap status: updated\n");

  return 0;
}

const defaultDependencies: RoadmapStatusDependencies = {
  loadItems: loadRoadmapProjectItems,
  now: () => new Date(),
  readFile: (path) => fsReadFile(path, "utf8"),
  stderr: (text) => {
    process.stderr.write(text);
  },
  stdout: (text) => {
    process.stdout.write(text);
  },
  writeAtomic: writeFileAtomic,
};

export async function executeRoadmapStatus(
  args: string[],
  config: RoadmapStatusConfig,
  dependencies: RoadmapStatusDependencies = defaultDependencies
): Promise<number> {
  try {
    return await runRoadmapStatus(args, config, dependencies);
  } catch (error) {
    dependencies.stderr(`${formatRoadmapStatusError(error)}\n`);
    return 1;
  }
}

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const isMain =
  process.argv[1] === undefined
    ? false
    : fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  executeRoadmapStatus(process.argv.slice(2), {
    expectedCount: ROADMAP_EXPECTED_ITEM_COUNT,
    owner: process.env.COVEN_PROJECT_OWNER ?? "OpenCoven",
    projectNumber: Number.parseInt(
      process.env.COVEN_PROJECT_NUMBER ?? "10",
      10
    ),
    roadmapPath: resolve(repositoryRoot, "ROADMAP.md"),
  }).then((code) => {
    process.exitCode = code;
  });
}
