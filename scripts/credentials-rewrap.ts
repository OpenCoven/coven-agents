#!/usr/bin/env tsx
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, eq, gt } from "drizzle-orm";
import { parseStoredIdempotencyResponseEnvelope } from "../lib/abuse/idempotency-response";
import {
  type CredentialEnvelopeV2,
  decryptCredential,
  encryptCredential,
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
  aadVersion?: number;
  ciphertext?: string;
  envelopeRevision?: string;
  harnessId?: string;
  id: string;
  iv?: string;
  kekVersion: string;
  tenant?: string;
  wrappedKey: string;
};

export type RewrapIdempotencyRow = {
  expiresAt: Date;
  id: string;
  responseJson: unknown;
};

export type RewrapStore = {
  bindAndCompareAndSwap?: (
    row: RewrapRow,
    sealed: CredentialEnvelopeV2
  ) => Promise<boolean>;
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
  listByAadVersion?: (
    version: number,
    limit: number,
    afterId?: string
  ) => Promise<RewrapRow[]>;
  listUnexpiredIdempotency?: (
    now: Date,
    limit: number,
    afterId?: string
  ) => Promise<RewrapIdempotencyRow[]>;
  listAll?: (limit: number, afterId?: string) => Promise<RewrapRow[]>;
};

export type RewrapArguments = {
  batch: number;
  dryRun: boolean;
  from: string;
  to: string;
};

export type RewrapResult = {
  aadRemaining: number;
  failures: number;
  failureIds: string[];
  remaining: number;
  rewrapped: number;
  skipped: number;
  status: RewrapStatus;
  verified: number;
};

export type RewrapStatus = "complete" | "failed" | "resume";

export type BindAadArguments = {
  batch: number;
};

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

export function parseBindAadArguments(argv: string[]): BindAadArguments {
  let batch: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--batch" && argv[index + 1]) {
      batch = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error("Usage: pnpm credentials:rewrap bind-aad [--batch 100]");
  }
  return { batch: parseBatch(batch) };
}

function result(): RewrapResult {
  return {
    aadRemaining: 0,
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

function reportIdempotencyFailure(
  output: (line: string) => void,
  target: RewrapResult,
  id: string
): void {
  target.failures += 1;
  target.failureIds.push(id);
  output(`idempotency_row_id: ${id}`);
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
  if (
    summary.aadRemaining > 0 ||
    summary.remaining > 0 ||
    summary.skipped > 0
  ) {
    return "resume";
  }
  return "complete";
}

export function rewrapExitCode(
  summary: Pick<
    RewrapResult,
    "aadRemaining" | "failures" | "remaining" | "skipped"
  >
): 0 | 1 | 2 {
  if (summary.failures > 0) {
    return 1;
  }
  return summary.aadRemaining > 0 ||
    summary.remaining > 0 ||
    summary.skipped > 0
    ? 2
    : 0;
}

async function countRemainingAadVersion(
  store: RewrapStore,
  version: number,
  batch: number
): Promise<number> {
  if (!store.listByAadVersion) {
    return 0;
  }
  let count = 0;
  let afterId: string | undefined;
  while (true) {
    // biome-ignore lint/performance/noAwaitInLoops: cursor pagination depends on the prior page
    const rows = await store.listByAadVersion(version, batch, afterId);
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

/**
 * Converts legacy credential ciphertexts to the bound AAD format. Plaintext
 * exists only in this function's stack for the duration of one row and is
 * never included in operator output.
 */
export async function bindLegacyAadRows(
  input: {
    batch: number;
    currentKek: CryptoKey;
    currentVersion: string;
    keyFor?: (version: string) => CryptoKey;
  },
  store: RewrapStore,
  output: (line: string) => void = () => undefined
): Promise<RewrapResult> {
  if (!store.listByAadVersion || !store.bindAndCompareAndSwap) {
    throw new Error("AAD binding requires a compatible credential store.");
  }
  const currentVersion = validateKekVersion(
    input.currentVersion,
    "--current-version"
  );
  parseBatch(String(input.batch));
  const summary = result();

  while (true) {
    // Each page is selected before its CAS updates so an interruption leaves
    // complete rows and a concurrent writer wins without being overwritten.
    // biome-ignore lint/performance/noAwaitInLoops: deterministic cursor pagination
    const rows = await store.listByAadVersion(0, input.batch);
    if (rows.length === 0) {
      break;
    }

    let changedThisBatch = 0;
    for (const row of rows) {
      if (
        row.aadVersion !== 0 ||
        row.ciphertext === undefined ||
        row.harnessId === undefined ||
        row.iv === undefined ||
        row.envelopeRevision === undefined ||
        row.tenant === undefined
      ) {
        reportFailure(output, summary, row.id);
        continue;
      }

      try {
        const sourceKek =
          input.keyFor?.(row.kekVersion) ??
          (row.kekVersion === currentVersion ? input.currentKek : undefined);
        if (!sourceKek) {
          throw new Error("source KEK is not configured");
        }
        // biome-ignore lint/performance/noAwaitInLoops: deterministic per-row crypto and CAS
        const plaintext = await decryptCredential(
          {
            aadVersion: 0,
            ciphertext: row.ciphertext,
            iv: row.iv,
            kekVersion: row.kekVersion,
            wrappedKey: row.wrappedKey,
          },
          sourceKek
        );
        const sealed = await encryptCredential(
          plaintext,
          input.currentKek,
          currentVersion,
          {
            harnessId: row.harnessId,
            kind: "credential",
            tenant: row.tenant,
          }
        );
        const updated = await store.bindAndCompareAndSwap(row, sealed);
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

    if (summary.failures > 0 || changedThisBatch === 0) {
      break;
    }
  }

  summary.remaining = await countRemainingAadVersion(store, 0, input.batch);
  summary.aadRemaining = summary.remaining;
  summary.status = rewrapStatus(summary);
  return summary;
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

async function verifyIdempotencyRows(
  input: {
    batch: number;
    knownVersions: readonly string[];
    key: CryptoKey;
    now: Date;
    oldVersion: string;
    targetVersion: string;
  },
  store: RewrapStore,
  summary: RewrapResult,
  output: (line: string) => void
): Promise<void> {
  if (!store.listUnexpiredIdempotency) {
    return;
  }

  const knownVersions = new Set(input.knownVersions);
  let afterId: string | undefined;

  while (true) {
    // Idempotency responses are bounded by their retention window. The store
    // filters at the database boundary, and the cursor keeps the gate
    // deterministic without exposing response bodies.
    // biome-ignore lint/performance/noAwaitInLoops: cursor pagination depends on the prior page
    const rows = await store.listUnexpiredIdempotency(
      input.now,
      input.batch,
      afterId
    );
    if (rows.length === 0) {
      return;
    }

    for (const row of rows) {
      if (row.expiresAt <= input.now) {
        continue;
      }

      let envelope: ReturnType<typeof parseStoredIdempotencyResponseEnvelope>;
      try {
        envelope = parseStoredIdempotencyResponseEnvelope(row.responseJson);
      } catch {
        reportIdempotencyFailure(output, summary, row.id);
        continue;
      }

      if (envelope.kind === "plain_json") {
        continue;
      }

      const version = envelope.payload.kekVersion;
      if (!knownVersions.has(version)) {
        reportIdempotencyFailure(output, summary, row.id);
        continue;
      }
      if (version === input.oldVersion) {
        summary.remaining += 1;
        output(`idempotency_row_id: ${row.id}`);
        continue;
      }
      if (version !== input.targetVersion) {
        reportIdempotencyFailure(output, summary, row.id);
        continue;
      }

      try {
        // Verification is intentionally read-only. No idempotency response is
        // rewritten by this gate; bounded retention is the retirement path.
        // biome-ignore lint/performance/noAwaitInLoops: deterministic verification order
        await unwrapDataKey(envelope.payload.wrappedKey, input.key);
        summary.verified += 1;
      } catch {
        reportIdempotencyFailure(output, summary, row.id);
      }
    }

    const nextAfterId = rows.at(-1)?.id;
    if (rows.length < input.batch || !nextAfterId || nextAfterId === afterId) {
      return;
    }
    afterId = nextAfterId;
  }
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
  const [{ db }, { idempotencyRecord, tenantCredential }] = await Promise.all([
    import("../lib/db/queries"),
    import("../lib/db/schema"),
  ]);

  return {
    async bindAndCompareAndSwap(row, sealed) {
      if (row.envelopeRevision === undefined) {
        return false;
      }
      const expectedRevision = row.envelopeRevision;
      const updated = await db.transaction(async (transaction) =>
        transaction
          .update(tenantCredential)
          .set({
            aadVersion: sealed.aadVersion,
            ciphertext: sealed.ciphertext,
            envelopeRevision: crypto.randomUUID(),
            iv: sealed.iv,
            kekVersion: sealed.kekVersion,
            updatedAt: new Date(),
            wrappedKey: sealed.wrappedKey,
          })
          .where(
            and(
              eq(tenantCredential.id, row.id),
              eq(tenantCredential.aadVersion, 0),
              eq(tenantCredential.envelopeRevision, expectedRevision)
            )
          )
          .returning({ id: tenantCredential.id })
      );
      return updated.length === 1;
    },
    async compareAndSwap(row, expectedWrappedKey, wrappedKey, toVersion) {
      const updated = await db.transaction(async (transaction) =>
        transaction
          .update(tenantCredential)
          .set({
            envelopeRevision: crypto.randomUUID(),
            kekVersion: toVersion,
            wrappedKey,
          })
          .where(
            and(
              eq(tenantCredential.id, row.id),
              eq(tenantCredential.kekVersion, row.kekVersion),
              eq(tenantCredential.wrappedKey, expectedWrappedKey),
              row.envelopeRevision
                ? eq(tenantCredential.envelopeRevision, row.envelopeRevision)
                : undefined
            )
          )
          .returning({ id: tenantCredential.id })
      );
      return updated.length === 1;
    },
    async listAll(limit, afterId) {
      const rows = await db
        .select({
          aadVersion: tenantCredential.aadVersion,
          ciphertext: tenantCredential.ciphertext,
          envelopeRevision: tenantCredential.envelopeRevision,
          harnessId: tenantCredential.harnessId,
          id: tenantCredential.id,
          iv: tenantCredential.iv,
          kekVersion: tenantCredential.kekVersion,
          tenant: tenantCredential.tenant,
          wrappedKey: tenantCredential.wrappedKey,
        })
        .from(tenantCredential)
        .where(afterId ? gt(tenantCredential.id, afterId) : undefined)
        .orderBy(asc(tenantCredential.id))
        .limit(limit);
      return rows;
    },
    async listByAadVersion(version, limit, afterId) {
      const rows = await db
        .select({
          aadVersion: tenantCredential.aadVersion,
          ciphertext: tenantCredential.ciphertext,
          envelopeRevision: tenantCredential.envelopeRevision,
          harnessId: tenantCredential.harnessId,
          id: tenantCredential.id,
          iv: tenantCredential.iv,
          kekVersion: tenantCredential.kekVersion,
          tenant: tenantCredential.tenant,
          wrappedKey: tenantCredential.wrappedKey,
        })
        .from(tenantCredential)
        .where(
          and(
            eq(tenantCredential.aadVersion, version),
            afterId ? gt(tenantCredential.id, afterId) : undefined
          )
        )
        .orderBy(asc(tenantCredential.id))
        .limit(limit);
      return rows;
    },
    async listByVersion(version, limit, afterId) {
      const rows = await db
        .select({
          aadVersion: tenantCredential.aadVersion,
          ciphertext: tenantCredential.ciphertext,
          envelopeRevision: tenantCredential.envelopeRevision,
          harnessId: tenantCredential.harnessId,
          id: tenantCredential.id,
          iv: tenantCredential.iv,
          kekVersion: tenantCredential.kekVersion,
          tenant: tenantCredential.tenant,
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
    async listUnexpiredIdempotency(now, limit, afterId) {
      const rows = await db
        .select({
          expiresAt: idempotencyRecord.expiresAt,
          id: idempotencyRecord.id,
          responseJson: idempotencyRecord.responseJson,
        })
        .from(idempotencyRecord)
        .where(
          and(
            eq(idempotencyRecord.state, "completed"),
            gt(idempotencyRecord.expiresAt, now),
            afterId ? gt(idempotencyRecord.id, afterId) : undefined
          )
        )
        .orderBy(asc(idempotencyRecord.id))
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

  if (argv[0] === "bind-aad") {
    const args = parseBindAadArguments(argv);
    const summary = await bindLegacyAadRows(
      {
        batch: args.batch,
        currentKek: ring.current,
        currentVersion: ring.currentVersion,
        keyFor: (version) => ring.keyFor(version),
      },
      store,
      output
    );
    printSummary(output, "bind-aad", summary);
    return rewrapExitCode(summary);
  }

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
    summary.aadRemaining = await countRemainingAadVersion(store, 0, batchSize);
    await verifyIdempotencyRows(
      {
        batch: batchSize,
        key: ring.current,
        knownVersions: ring.versions,
        now: new Date(),
        oldVersion,
        targetVersion: ring.currentVersion,
      },
      store,
      summary,
      output
    );
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
