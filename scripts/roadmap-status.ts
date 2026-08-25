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
import { loadRoadmapProjectItems } from "./roadmap-project-status";
import {
  extractRoadmapSummary,
  renderRoadmapStatusBlock,
  replaceRoadmapStatusBlock,
} from "./roadmap-status-block";
import {
  ROADMAP_EXPECTED_ITEM_COUNT,
  type RoadmapProjectItem,
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
  writeAtomic: (path: string, contents: string) => Promise<void>;
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

async function cleanupTemporaryFile(
  path: string,
  handle: AtomicFileHandle | undefined,
  operations: AtomicWriteOperations,
  failure: unknown
): Promise<never> {
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

  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      [failure, ...cleanupFailures],
      "Atomic write failed and cleanup was incomplete"
    );
  }

  throw failure;
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
  contents: string,
  operations: AtomicWriteOperations = defaultAtomicWriteOperations
): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${operations.pid}.${operations.randomUUID()}.tmp`
  );
  let created = false;
  let handle: AtomicFileHandle | undefined;

  try {
    handle = await operations.openExclusive(temporaryPath);
    created = true;
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await operations.rename(temporaryPath, path);
    created = false;
  } catch (error) {
    if (created) {
      await cleanupTemporaryFile(temporaryPath, handle, operations, error);
    }

    throw error;
  }

  await syncDirectory(directory, operations);
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
  contents: string,
  writeAtomic: RoadmapStatusDependencies["writeAtomic"]
): Promise<void> {
  try {
    await writeAtomic(path, contents);
  } catch (error) {
    throw new RoadmapStatusOperationError("filesystem", { cause: error });
  }
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
    dependencies.stdout(
      `roadmap status: changed\n${JSON.stringify(nextSummary)}\n`
    );
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
