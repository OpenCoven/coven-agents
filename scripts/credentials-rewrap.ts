#!/usr/bin/env tsx
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, eq, gt } from "drizzle-orm";
import {
  rewrapWrappedKey,
  unwrapDataKey,
  validateKekVersion,
} from "../lib/credentials/envelope";
import {
  type CredentialKekRing,
  credentialKekRingFromEnvironment,
} from "../lib/credentials/key-ring";

export const DEFAULT_BATCH_SIZE = 100;
export const MAX_BATCH_SIZE = 1000;

export type RewrapRow = {
  id: string;
  kekVersion: string;
  wrappedKey: string;
};

export type RewrapStore = {
  compareAndSwap: (
    row: RewrapRow,
    expectedWrappedKey: string,
    wrappedKey: string,
    toVersion: string
  ) => Promise<boolean>;
  listByVersion: (
    version: string,
    limit: number,
    afterId?: string
  ) => Promise<RewrapRow[]>;
  listAll?: (limit: number, afterId?: string) => Promise<RewrapRow[]>;
};

export type RewrapArguments = {
  batch: number;
  dryRun: boolean;
  from: string;
  to: string;
};

export type RewrapResult = {
  failures: number;
  failureIds: string[];
  remaining: number;
  rewrapped: number;
  skipped: number;
  status: RewrapStatus;
  verified: number;
};

export type RewrapStatus = "complete" | "failed" | "resume";

export type RewrapCliDependencies = {
  loadRing: () => Promise<CredentialKekRing>;
  loadStore: () => Promise<RewrapStore>;
  stderr: (line: string) => void;
  stdout: (line: string) => void;
};

function parseBatch(value: string | undefined): number {
  const batch = value === undefined ? DEFAULT_BATCH_SIZE : Number(value);
  if (!Number.isSafeInteger(batch) || batch <= 0 || batch > MAX_BATCH_SIZE) {
    throw new Error(
      `batch must be a positive integer no greater than ${MAX_BATCH_SIZE}.`
    );
  }
  return batch;
}

export function parseRewrapArguments(argv: string[]): RewrapArguments {
  let from: string | undefined;
  let to: string | undefined;
  let batch: string | undefined;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (
      (argument === "--from" ||
        argument === "--to" ||
        argument === "--batch") &&
      argv[index + 1]
    ) {
      const value = argv[index + 1];
      if (argument === "--from") {
        from = value;
      } else if (argument === "--to") {
        to = value;
      } else {
        batch = value;
      }
      index += 1;
      continue;
    }
    throw new Error(
      "Usage: pnpm credentials:rewrap --from v1 --to v2 [--batch 100] [--dry-run]"
    );
  }

  const checkedFrom = validateKekVersion(from, "--from");
  const checkedTo = validateKekVersion(to, "--to");
  if (checkedFrom === checkedTo) {
    throw new Error("source and target KEK versions must differ.");
  }

  return {
    batch: parseBatch(batch),
    dryRun,
    from: checkedFrom,
    to: checkedTo,
  };
}

function result(): RewrapResult {
  return {
    failureIds: [],
    failures: 0,
    remaining: 0,
    rewrapped: 0,
    skipped: 0,
    status: "complete",
    verified: 0,
  };
}

function reportFailure(
  output: (line: string) => void,
  target: RewrapResult,
  id: string
): void {
  target.failures += 1;
  target.failureIds.push(id);
  output(`row_id: ${id}`);
}

async function countRemaining(
  store: RewrapStore,
  version: string,
  batch: number
): Promise<number> {
  let count = 0;
  let afterId: string | undefined;
  while (true) {
    // Pagination is intentionally sequential so the cursor is deterministic.
    // biome-ignore lint/performance/noAwaitInLoops: cursor pagination depends on the prior page
    const rows = await store.listByVersion(version, batch, afterId);
    if (rows.length === 0) {
      return count;
    }
    count += rows.length;
    const nextAfterId = rows.at(-1)?.id;
    if (rows.length < batch || !nextAfterId || nextAfterId === afterId) {
      return count;
    }
    afterId = nextAfterId;
  }
}

export function rewrapStatus(summary: RewrapResult): RewrapStatus {
  if (summary.failures > 0) {
    return "failed";
  }
  if (summary.remaining > 0 || summary.skipped > 0) {
    return "resume";
  }
  return "complete";
}

export function rewrapExitCode(
  summary: Pick<RewrapResult, "failures" | "remaining" | "skipped">
): 0 | 1 | 2 {
  if (summary.failures > 0) {
    return 1;
  }
  return summary.remaining > 0 || summary.skipped > 0 ? 2 : 0;
}

/**
 * Rewraps rows in deterministic batches. Every update is a separate database
 * transaction with a compare-and-swap predicate, so an interrupted process
 * leaves committed rows complete and a concurrent credential write wins.
 */
export async function rewrapRows(
  input: {
    batch: number;
    from: string;
    sourceKek: CryptoKey;
    targetKek: CryptoKey;
    to: string;
  },
  store: RewrapStore,
  output: (line: string) => void = () => undefined
): Promise<RewrapResult> {
  const from = validateKekVersion(input.from, "--from");
  const to = validateKekVersion(input.to, "--to");
  if (from === to) {
    throw new Error("source and target KEK versions must differ.");
  }
  parseBatch(String(input.batch));

  const summary = result();
  while (true) {
    // Each batch is selected before its CAS updates to bound memory and make
    // interruption leave complete, independently committed rows.
    // biome-ignore lint/performance/noAwaitInLoops: batch processing is intentionally ordered
    const rows = await store.listByVersion(from, input.batch);
    if (rows.length === 0) {
      break;
    }

    let changedThisBatch = 0;
    for (const row of rows) {
      if (row.kekVersion !== from) {
        reportFailure(output, summary, row.id);
        continue;
      }
      try {
        // Keep failure IDs deterministic and prevent an operator-visible
        // output race between rows.
        // biome-ignore lint/performance/noAwaitInLoops: deterministic per-row crypto and CAS
        const wrappedKey = await rewrapWrappedKey(
          row.wrappedKey,
          input.sourceKek,
          input.targetKek
        );
        const updated = await store.compareAndSwap(
          row,
          row.wrappedKey,
          wrappedKey,
          to
        );
        if (updated) {
          summary.rewrapped += 1;
          changedThisBatch += 1;
        } else {
          summary.skipped += 1;
        }
      } catch {
        reportFailure(output, summary, row.id);
      }
    }

    // Do not retry a corrupt row forever in one invocation. A later run can
    // retry it after an operator repairs the row or key configuration.
    if (summary.failures > 0 || changedThisBatch === 0) {
      break;
    }
  }

  summary.remaining = await countRemaining(store, from, input.batch);
  summary.status = rewrapStatus(summary);
  return summary;
}

export async function verifyRows(
  input: { batch: number; key: CryptoKey; version: string },
  store: RewrapStore,
  output: (line: string) => void = () => undefined
): Promise<RewrapResult> {
  const version = validateKekVersion(input.version, "--version");
  parseBatch(String(input.batch));
  const summary = result();
  let afterId: string | undefined;

  while (true) {
    // Pagination is intentionally sequential so the cursor is deterministic.
    // biome-ignore lint/performance/noAwaitInLoops: cursor pagination depends on the prior page
    const rows = await store.listByVersion(version, input.batch, afterId);
    if (rows.length === 0) {
      break;
    }
    for (const row of rows) {
      if (row.kekVersion !== version) {
        reportFailure(output, summary, row.id);
        continue;
      }
      try {
        // Verification output is kept deterministic and read-only.
        // biome-ignore lint/performance/noAwaitInLoops: deterministic verification order
        await unwrapDataKey(row.wrappedKey, input.key);
        summary.verified += 1;
      } catch {
        reportFailure(output, summary, row.id);
      }
    }
    afterId = rows.at(-1)?.id;
    if (rows.length < input.batch || !afterId) {
      break;
    }
  }

  summary.status = rewrapStatus(summary);
  return summary;
}

function unknownRows(
  store: RewrapStore,
  knownVersions: readonly string[],
  batch: number,
  output: (line: string) => void,
  summary: RewrapResult
): Promise<void> {
  if (!store.listAll) {
    return Promise.resolve();
  }

  const known = new Set(knownVersions);
  return (async () => {
    let afterId: string | undefined;
    while (true) {
      // Pagination is intentionally sequential so the cursor is deterministic.
      // biome-ignore lint/performance/noAwaitInLoops: cursor pagination depends on the prior page
      const rows = await store.listAll?.(batch, afterId);
      if (!rows || rows.length === 0) {
        break;
      }
      for (const row of rows) {
        if (!known.has(row.kekVersion)) {
          reportFailure(output, summary, row.id);
        }
      }
      afterId = rows.at(-1)?.id;
      if (rows.length < batch || !afterId) {
        break;
      }
    }
  })();
}

async function databaseStore(): Promise<RewrapStore> {
  const [{ db }, { tenantCredential }] = await Promise.all([
    import("../lib/db/queries"),
    import("../lib/db/schema"),
  ]);

  return {
    async compareAndSwap(row, expectedWrappedKey, wrappedKey, toVersion) {
      const updated = await db.transaction(async (transaction) =>
        transaction
          .update(tenantCredential)
          .set({ kekVersion: toVersion, wrappedKey })
          .where(
            and(
              eq(tenantCredential.id, row.id),
              eq(tenantCredential.kekVersion, row.kekVersion),
              eq(tenantCredential.wrappedKey, expectedWrappedKey)
            )
          )
          .returning({ id: tenantCredential.id })
      );
      return updated.length === 1;
    },
    async listAll(limit, afterId) {
      const rows = await db
        .select({
          id: tenantCredential.id,
          kekVersion: tenantCredential.kekVersion,
          wrappedKey: tenantCredential.wrappedKey,
        })
        .from(tenantCredential)
        .where(afterId ? gt(tenantCredential.id, afterId) : undefined)
        .orderBy(asc(tenantCredential.id))
        .limit(limit);
      return rows;
    },
    async listByVersion(version, limit, afterId) {
      const rows = await db
        .select({
          id: tenantCredential.id,
          kekVersion: tenantCredential.kekVersion,
          wrappedKey: tenantCredential.wrappedKey,
        })
        .from(tenantCredential)
        .where(
          and(
            eq(tenantCredential.kekVersion, version),
            afterId ? gt(tenantCredential.id, afterId) : undefined
          )
        )
        .orderBy(asc(tenantCredential.id))
        .limit(limit);
      return rows;
    },
  };
}

function printSummary(
  output: (line: string) => void,
  label: string,
  summary: RewrapResult
): void {
  output(
    `${label} verified=${summary.verified} rewrapped=${summary.rewrapped} ` +
      `skipped=${summary.skipped} failures=${summary.failures} ` +
      `remaining=${summary.remaining} status=${summary.status}`
  );
}

export async function run(
  argv: string[],
  dependencies: RewrapCliDependencies = defaultDependencies()
): Promise<number> {
  const ring = await dependencies.loadRing();
  const store = await dependencies.loadStore();
  const output = dependencies.stdout;

  if (argv[0] === "verify") {
    let version: string | undefined;
    let batch: string | undefined;
    for (let index = 1; index < argv.length; index += 1) {
      const argument = argv[index];
      if (
        (argument === "--version" || argument === "--batch") &&
        argv[index + 1]
      ) {
        if (argument === "--version") {
          version = argv[index + 1];
        } else {
          batch = argv[index + 1];
        }
        index += 1;
      } else {
        throw new Error(
          "Usage: pnpm credentials:rewrap verify --version v1 [--batch 100]"
        );
      }
    }
    const oldVersion = validateKekVersion(version, "--version");
    if (oldVersion === ring.currentVersion) {
      throw new Error("verification version must be an old KEK version.");
    }
    const batchSize = parseBatch(batch);
    ring.keyFor(oldVersion);
    const summary = await verifyRows(
      { batch: batchSize, key: ring.current, version: ring.currentVersion },
      store,
      output
    );
    summary.remaining = await countRemaining(store, oldVersion, batchSize);
    await unknownRows(store, ring.versions, batchSize, output, summary);
    summary.status = rewrapStatus(summary);
    printSummary(output, "verify", summary);
    return rewrapExitCode(summary);
  }

  const args = parseRewrapArguments(argv);
  const sourceKek = ring.keyFor(args.from);
  const targetKek = ring.keyFor(args.to);
  if (args.dryRun) {
    const summary = await verifyRows(
      { batch: args.batch, key: targetKek, version: args.to },
      store,
      output
    );
    await unknownRows(store, ring.versions, args.batch, output, summary);
    summary.status = rewrapStatus(summary);
    printSummary(output, "dry-run", summary);
    return summary.failures === 0 ? 0 : 1;
  }

  const summary = await rewrapRows(
    {
      batch: args.batch,
      from: args.from,
      sourceKek,
      targetKek,
      to: args.to,
    },
    store,
    output
  );
  await unknownRows(store, ring.versions, args.batch, output, summary);
  summary.status = rewrapStatus(summary);
  printSummary(output, "rewrap", summary);
  return rewrapExitCode(summary);
}

export async function main(
  argv: string[] = process.argv.slice(2),
  dependencies: RewrapCliDependencies = defaultDependencies()
): Promise<number> {
  try {
    return await run(argv, dependencies);
  } catch {
    dependencies.stderr("Credential rewrap failed.");
    return 1;
  }
}

function defaultDependencies(): RewrapCliDependencies {
  return {
    loadRing: () => credentialKekRingFromEnvironment(),
    loadStore: () => databaseStore(),
    stderr: (line) => process.stderr.write(`${line}\n`),
    stdout: (line) => process.stdout.write(`${line}\n`),
  };
}

const [, invokedPath] = process.argv;
if (invokedPath && fileURLToPath(import.meta.url) === resolve(invokedPath)) {
  main().then((code) => process.exit(code));
}
