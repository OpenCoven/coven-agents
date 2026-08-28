import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { encryptedIdempotencyResponseStorage } from "../lib/abuse/idempotency-response";
import {
  decryptCredential,
  encryptCredential,
  generateKek,
  rewrapWrappedKey,
} from "../lib/credentials/envelope";
import type { CredentialKekRing } from "../lib/credentials/key-ring";
import {
  parseStoredCredential,
  serializeCredential,
} from "../lib/credentials/shape";
import {
  bindLegacyAadRows,
  main,
  parseRewrapArguments,
  type RewrapCliDependencies,
  type RewrapStore,
  rewrapRows,
  verifyRows,
} from "./credentials-rewrap";

test("requires distinct versions and a bounded positive batch", () => {
  assert.deepEqual(
    parseRewrapArguments(["--from", "v1", "--to", "v2", "--batch", "100"]),
    { batch: 100, dryRun: false, from: "v1", to: "v2" }
  );
  assert.throws(() =>
    parseRewrapArguments(["--from", "v1", "--to", "v1", "--batch", "1"])
  );
  assert.throws(() =>
    parseRewrapArguments(["--from", "v1", "--to", "v2", "--batch", "0"])
  );
  assert.throws(() =>
    parseRewrapArguments(["--from", "v1", "--to", "v2", "--batch", "1001"])
  );
});

test("successful batches remain resumable after an interruption", async () => {
  const sourceKek = await generateKek();
  const targetKek = await generateKek();
  const first = await encryptCredential("first", sourceKek, "v1");
  const second = await encryptCredential("second", sourceKek, "v1");
  const rows = [
    { id: "00000000-0000-0000-0000-000000000001", ...first },
    { id: "00000000-0000-0000-0000-000000000002", ...second },
  ];
  let interrupted = false;
  const store: RewrapStore = {
    compareAndSwap(row, expectedWrappedKey, wrappedKey, to) {
      if (!interrupted && row.id.endsWith("1")) {
        interrupted = true;
        return Promise.reject(new Error("synthetic interruption"));
      }
      if (row.kekVersion !== "v1" || row.wrappedKey !== expectedWrappedKey) {
        return Promise.resolve(false);
      }
      row.wrappedKey = wrappedKey;
      row.kekVersion = to;
      return Promise.resolve(true);
    },
    listByVersion(version, limit) {
      return Promise.resolve(
        rows
          .filter((row) => row.kekVersion === version)
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, limit)
      );
    },
  };

  const firstRun = await rewrapRows(
    { batch: 1, from: "v1", sourceKek, targetKek, to: "v2" },
    store,
    () => undefined
  );
  assert.equal(firstRun.failures, 1);

  const secondRun = await rewrapRows(
    { batch: 100, from: "v1", sourceKek, targetKek, to: "v2" },
    store,
    () => undefined
  );
  assert.equal(secondRun.rewrapped, 2);
  assert.equal(secondRun.remaining, 0);
});

test("bind-aad decrypts legacy rows, encrypts with tenant AAD, and resumes after CAS", async () => {
  const kek = await generateKek();
  const legacy = await encryptCredential("legacy-secret", kek, "v1");
  const row = {
    aadVersion: 0,
    ciphertext: legacy.ciphertext,
    credentialRevision: "credential-before",
    envelopeRevision: "revision-before",
    harnessId: "copilot",
    id: "opaque-bind-row",
    iv: legacy.iv,
    kekVersion: "v1",
    tenant: "acme",
    wrappedKey: legacy.wrappedKey,
  };
  let casCalls = 0;
  const store: RewrapStore = {
    bindAndCompareAndSwap(candidate, sealed) {
      casCalls += 1;
      assert.equal(candidate.envelopeRevision, "revision-before");
      if (casCalls === 1) {
        return Promise.resolve(false);
      }
      Object.assign(candidate, sealed, {
        aadVersion: sealed.aadVersion,
        envelopeRevision: "revision-after",
      });
      return Promise.resolve(true);
    },
    compareAndSwap: async () => false,
    listByAadVersion(version, limit, afterId) {
      return Promise.resolve(
        afterId || version !== row.aadVersion ? [] : [row].slice(0, limit)
      );
    },
    listByVersion: async () => [],
  };

  const first = await bindLegacyAadRows(
    { batch: 1, currentKek: kek, currentVersion: "v1" },
    store,
    () => undefined
  );
  assert.equal(first.skipped, 1);
  assert.equal(first.remaining, 1);
  assert.equal(row.aadVersion, 0);

  const second = await bindLegacyAadRows(
    { batch: 1, currentKek: kek, currentVersion: "v1" },
    store,
    () => undefined
  );
  assert.equal(second.rewrapped, 1);
  assert.equal(second.remaining, 0);
  assert.equal(row.aadVersion, 1);
  assert.equal(row.credentialRevision, "credential-before");
  assert.equal(
    await decryptCredential(row, kek, {
      harnessId: "copilot",
      kind: "credential",
      tenant: "acme",
    }),
    "legacy-secret"
  );
  assert.equal(casCalls, 2);
});

test("a concurrent update loses only the CAS and never overwrites newer data", async () => {
  const sourceKek = await generateKek();
  const targetKek = await generateKek();
  const sealed = await encryptCredential("credential", sourceKek, "v1");
  const row = {
    envelopeRevision: "revision-before",
    id: "opaque-row-id",
    ...sealed,
  };
  let casCalls = 0;
  const store: RewrapStore = {
    compareAndSwap() {
      casCalls += 1;
      row.envelopeRevision = "revision-from-newer-writer";
      row.kekVersion = "v2";
      row.wrappedKey = "newer-write";
      return Promise.resolve(false);
    },
    listByVersion() {
      return Promise.resolve(row.kekVersion === "v1" ? [row] : []);
    },
  };

  const result = await rewrapRows(
    { batch: 100, from: "v1", sourceKek, targetKek, to: "v2" },
    store,
    () => undefined
  );

  assert.equal(casCalls, 1);
  assert.equal(result.skipped, 1);
  assert.equal(row.wrappedKey, "newer-write");
  assert.equal(row.envelopeRevision, "revision-from-newer-writer");
});

test("a refresh that wins before rewrap CAS keeps its rotated token", async () => {
  const sourceKek = await generateKek();
  const targetKek = await generateKek();
  const context = {
    harnessId: "copilot",
    kind: "credential" as const,
    tenant: "acme",
  };
  const original = await encryptCredential(
    serializeCredential({
      access: "old-access",
      expiresAt: 0,
      kind: "oauth",
      refresh: "old-refresh",
    }),
    sourceKek,
    "v1",
    context
  );
  const refreshedCredential = {
    access: "fresh-access",
    expiresAt: Date.now() + 3_600_000,
    kind: "oauth" as const,
    refresh: "fresh-refresh",
  };
  const refreshed = await encryptCredential(
    serializeCredential(refreshedCredential),
    targetKek,
    "v2",
    context
  );
  const row = {
    aadVersion: original.aadVersion,
    ciphertext: original.ciphertext,
    credentialRevision: "credential-before",
    envelopeRevision: "envelope-before",
    harnessId: "copilot",
    id: "refresh-winner-row",
    iv: original.iv,
    kekVersion: "v1",
    tenant: "acme",
    wrappedKey: original.wrappedKey,
  };
  const store: RewrapStore = {
    compareAndSwap() {
      Object.assign(row, refreshed, {
        credentialRevision: "credential-after",
        envelopeRevision: "envelope-after",
      });
      return Promise.resolve(false);
    },
    listByVersion(version, limit, afterId) {
      return Promise.resolve(
        !afterId && version === row.kekVersion ? [row].slice(0, limit) : []
      );
    },
  };

  const result = await rewrapRows(
    { batch: 100, from: "v1", sourceKek, targetKek, to: "v2" },
    store,
    () => undefined
  );

  assert.equal(result.rewrapped, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.remaining, 0);
  assert.equal(row.credentialRevision, "credential-after");
  assert.deepEqual(
    parseStoredCredential(await decryptCredential(row, targetKek, context)),
    refreshedCredential
  );
});

test("a corrupt wrapped key fails one row without exposing its contents", async () => {
  const sourceKek = await generateKek();
  const targetKek = await generateKek();
  const row = {
    id: "opaque-row-9",
    kekVersion: "v1",
    wrappedKey: "corrupt",
  };
  const output: string[] = [];
  let writes = 0;
  const store: RewrapStore = {
    compareAndSwap() {
      writes += 1;
      return Promise.resolve(true);
    },
    listByVersion(version) {
      return Promise.resolve(version === "v1" && writes === 0 ? [row] : []);
    },
  };

  const result = await rewrapRows(
    { batch: 100, from: "v1", sourceKek, targetKek, to: "v2" },
    store,
    (line) => output.push(line)
  );

  assert.equal(result.failures, 1);
  assert.deepEqual(output, ["row_id: opaque-row-9"]);
  assert.doesNotMatch(output.join("\n"), /corrupt|wrappedKey|ciphertext/i);
  assert.equal(writes, 0);
});

test("dry-run verification unwraps target rows without writing", async () => {
  const targetKek = await generateKek();
  const sealed = await encryptCredential("target", targetKek, "v2");
  const row = { id: "opaque-target-row", ...sealed };
  let writes = 0;
  const store: RewrapStore = {
    compareAndSwap() {
      writes += 1;
      return Promise.resolve(true);
    },
    listByVersion(version, limit, afterId) {
      if (afterId) {
        return Promise.resolve([]);
      }
      return Promise.resolve(version === "v2" ? [row].slice(0, limit) : []);
    },
  };

  const result = await verifyRows(
    { batch: 100, key: targetKek, version: "v2" },
    store
  );

  assert.equal(result.verified, 1);
  assert.equal(result.failures, 0);
  assert.equal(writes, 0);
});

test("database updates use a transaction and wrapped-key CAS", () => {
  const source = readFileSync(
    new URL("./credentials-rewrap.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /db\.transaction/);
  assert.match(source, /envelopeRevision:\s*crypto\.randomUUID\(\)/);
  assert.match(source, /kekVersion: toVersion/);
  assert.match(source, /wrappedKey/);
  assert.match(
    source,
    /set_config\('coven\.credential_aad_migration', 'on', true\)/
  );
  assert.match(
    source,
    /credentialRevision: tenantCredential\.credentialRevision/
  );
  assert.match(source, /eq\(tenantCredential\.id, row\.id\)/);
  assert.match(source, /eq\(tenantCredential\.kekVersion, row\.kekVersion\)/);
  assert.match(
    source,
    /eq\(tenantCredential\.wrappedKey, expectedWrappedKey\)/
  );
  assert.match(source, /eq\(\s*tenantCredential\.envelopeRevision/);
});

test("the rewrap CLI returns resume for CAS conflicts and never prints payloads", async () => {
  const sourceKek = await generateKek();
  const targetKek = await generateKek();
  const sealed = await encryptCredential("secret", sourceKek, "v1");
  const row = { id: "opaque-cas-row", ...sealed };
  const output: string[] = [];
  const dependencies = cliDependencies(
    sourceKek,
    targetKek,
    {
      compareAndSwap() {
        return Promise.resolve(false);
      },
      listByVersion(version) {
        return Promise.resolve(version === "v1" ? [row] : []);
      },
    },
    output
  );

  assert.equal(await main(["--from", "v1", "--to", "v2"], dependencies), 2);
  assert.match(output.at(-1) ?? "", /status=resume/);
  assert.doesNotMatch(output.join("\n"), /secret|ciphertext|wrappedKey/i);
});

test("the rewrap CLI rolls v2 back to v1, resumes after CAS, and verifies before retirement", async () => {
  const sourceKek = await generateKek();
  const targetKek = await generateKek();
  const original = await encryptCredential("rollback-secret", sourceKek, "v1");
  const v2WrappedKey = await rewrapWrappedKey(
    original.wrappedKey,
    sourceKek,
    targetKek
  );
  const row = {
    id: "opaque-rollback-row",
    ...original,
    kekVersion: "v2",
    wrappedKey: v2WrappedKey,
  };
  assert.equal(await decryptCredential(row, targetKek), "rollback-secret");
  const output: string[] = [];
  let casCalls = 0;
  const store: RewrapStore = {
    compareAndSwap(candidate, expectedWrappedKey, wrappedKey, toVersion) {
      casCalls += 1;
      assert.equal(candidate.id, row.id);
      assert.equal(candidate.kekVersion, "v2");
      assert.equal(expectedWrappedKey, row.wrappedKey);
      assert.equal(toVersion, "v1");
      if (casCalls === 1) {
        return Promise.resolve(false);
      }
      row.wrappedKey = wrappedKey;
      row.kekVersion = toVersion;
      return Promise.resolve(true);
    },
    listAll(limit, afterId) {
      return Promise.resolve(afterId ? [] : [row].slice(0, limit));
    },
    listByVersion(version, limit, afterId) {
      return Promise.resolve(
        afterId || version !== row.kekVersion ? [] : [row].slice(0, limit)
      );
    },
  };
  const rollbackDependencies = cliDependencies(
    sourceKek,
    targetKek,
    store,
    output,
    "v1"
  );

  assert.equal(
    await main(
      ["--from", "v2", "--to", "v1", "--batch", "1"],
      rollbackDependencies
    ),
    2
  );
  assert.equal(row.kekVersion, "v2");
  assert.match(
    output.at(-1) ?? "",
    /rewrapped=0 .*skipped=1 .*remaining=1 status=resume/
  );

  output.length = 0;
  assert.equal(
    await main(
      ["--from", "v2", "--to", "v1", "--batch", "1"],
      rollbackDependencies
    ),
    0
  );
  assert.equal(row.kekVersion, "v1");
  assert.equal(row.wrappedKey, original.wrappedKey);
  assert.equal(await decryptCredential(row, sourceKek), "rollback-secret");
  assert.equal(row.ciphertext, original.ciphertext);
  assert.equal(row.iv, original.iv);
  assert.match(
    output.at(-1) ?? "",
    /rewrapped=1 .*remaining=0 status=complete/
  );

  output.length = 0;
  assert.equal(
    await main(
      ["verify", "--version", "v2", "--batch", "1"],
      rollbackDependencies
    ),
    0
  );
  assert.match(
    output.at(-1) ?? "",
    /verify verified=1 .*remaining=0 status=complete/
  );
  assert.doesNotMatch(
    output.join("\n"),
    /rollback-secret|ciphertext|wrappedKey/i
  );
  assert.equal(casCalls, 2);
});

test("the rewrap CLI returns failure for corrupt rows and preserves privacy", async () => {
  const sourceKek = await generateKek();
  const targetKek = await generateKek();
  const row = {
    id: "opaque-invalid-row",
    kekVersion: "v1",
    wrappedKey: "corrupt",
  };
  const output: string[] = [];
  const dependencies = cliDependencies(
    sourceKek,
    targetKek,
    {
      compareAndSwap() {
        return Promise.resolve(true);
      },
      listByVersion(version) {
        return Promise.resolve(version === "v1" ? [row] : []);
      },
    },
    output
  );

  assert.equal(await main(["--from", "v1", "--to", "v2"], dependencies), 1);
  assert.match(output.at(-1) ?? "", /status=failed/);
  assert.deepEqual(output.slice(0, -1), ["row_id: opaque-invalid-row"]);
  assert.doesNotMatch(output.join("\n"), /corrupt|wrappedKey|ciphertext/i);
});

test("verify returns zero for a clean current-key gate and two while old rows remain", async () => {
  const sourceKek = await generateKek();
  const targetKek = await generateKek();
  const current = await encryptCredential("current", targetKek, "v2");
  const old = await encryptCredential("old", sourceKek, "v1");
  const cleanStore: RewrapStore = {
    compareAndSwap: async () => true,
    listAll() {
      return Promise.resolve([{ id: "current", ...current }]);
    },
    listByVersion(version, _limit, afterId) {
      if (afterId) {
        return Promise.resolve([]);
      }
      return Promise.resolve(
        version === "v2" ? [{ id: "current", ...current }] : []
      );
    },
  };
  const cleanOutput: string[] = [];
  assert.equal(
    await main(
      ["verify", "--version", "v1"],
      cliDependencies(sourceKek, targetKek, cleanStore, cleanOutput)
    ),
    0
  );
  assert.match(cleanOutput.at(-1) ?? "", /status=complete/);

  const remainingStore: RewrapStore = {
    compareAndSwap: async () => true,
    listAll() {
      return Promise.resolve([
        { id: "current", ...current },
        { id: "old", ...old },
      ]);
    },
    listByVersion(version, _limit, afterId) {
      if (afterId) {
        return Promise.resolve([]);
      }
      return Promise.resolve(
        version === "v2"
          ? [{ id: "current", ...current }]
          : version === "v1"
            ? [{ id: "old", ...old }]
            : []
      );
    },
  };
  const remainingOutput: string[] = [];
  assert.equal(
    await main(
      ["verify", "--version", "v1"],
      cliDependencies(sourceKek, targetKek, remainingStore, remainingOutput)
    ),
    2
  );
  assert.match(remainingOutput.at(-1) ?? "", /status=resume/);
});

test("verify returns one for a corrupt current row", async () => {
  const sourceKek = await generateKek();
  const targetKek = await generateKek();
  const output: string[] = [];
  const store: RewrapStore = {
    compareAndSwap: async () => true,
    listAll() {
      return Promise.resolve([]);
    },
    listByVersion(version, _limit, afterId) {
      if (afterId) {
        return Promise.resolve([]);
      }
      return Promise.resolve(
        version === "v2"
          ? [
              {
                id: "opaque-current-row",
                kekVersion: "v2",
                wrappedKey: "corrupt",
              },
            ]
          : []
      );
    },
  };

  assert.equal(
    await main(
      ["verify", "--version", "v1"],
      cliDependencies(sourceKek, targetKek, store, output)
    ),
    1
  );
  assert.match(output.at(-1) ?? "", /status=failed/);
  assert.doesNotMatch(output.join("\n"), /corrupt|wrappedKey|ciphertext/i);
});

test("dry-run is read-only and reports clean or corrupt target rows", async () => {
  const sourceKek = await generateKek();
  const targetKek = await generateKek();
  const sealed = await encryptCredential("target", targetKek, "v2");
  let writes = 0;
  const cleanOutput: string[] = [];
  const cleanStore: RewrapStore = {
    compareAndSwap() {
      writes += 1;
      return Promise.resolve(true);
    },
    listAll() {
      return Promise.resolve([]);
    },
    listByVersion(version, _limit, afterId) {
      return Promise.resolve(
        version === "v2" && !afterId ? [{ id: "target", ...sealed }] : []
      );
    },
  };
  assert.equal(
    await main(
      ["--from", "v1", "--to", "v2", "--dry-run"],
      cliDependencies(sourceKek, targetKek, cleanStore, cleanOutput)
    ),
    0
  );
  assert.equal(writes, 0);
  assert.match(cleanOutput.at(-1) ?? "", /dry-run .*status=complete/);

  const corruptOutput: string[] = [];
  const corruptStore: RewrapStore = {
    compareAndSwap() {
      writes += 1;
      return Promise.resolve(true);
    },
    listAll() {
      return Promise.resolve([]);
    },
    listByVersion(version, _limit, afterId) {
      return Promise.resolve(
        version === "v2" && !afterId
          ? [{ id: "target-row-2", kekVersion: "v2", wrappedKey: "invalid" }]
          : []
      );
    },
  };
  assert.equal(
    await main(
      ["--from", "v1", "--to", "v2", "--dry-run"],
      cliDependencies(sourceKek, targetKek, corruptStore, corruptOutput)
    ),
    1
  );
  assert.match(corruptOutput.at(-1) ?? "", /dry-run .*status=failed/);
  assert.doesNotMatch(
    corruptOutput.join("\n"),
    /invalid|wrappedKey|ciphertext/i
  );
});

test("retirement gate blocks an unexpired encrypted idempotency response", async () => {
  const sourceKek = await generateKek();
  const targetKek = await generateKek();
  const current = await encryptCredential("current", targetKek, "v2");
  const response = await encryptedIdempotencyResponseStorage(
    (version) => Promise.resolve(version === "v1" ? sourceKek : targetKek),
    () => Promise.resolve("v1")
  ).store(
    { status: "pending" },
    {
      keyHash: "key-hash",
      operation: "credential_device_start",
      ownerId: "opaque-owner",
    }
  );
  const output: string[] = [];
  const store: RewrapStore = {
    compareAndSwap: async () => true,
    listByVersion(version, _limit, afterId) {
      return Promise.resolve(
        !afterId && version === "v2" ? [{ id: "current", ...current }] : []
      );
    },
    listUnexpiredIdempotency(now, _limit, afterId) {
      return Promise.resolve(
        !afterId && response.kind === "encrypted_json" && response.payload
          ? [
              {
                expiresAt: new Date(now.getTime() + 60_000),
                id: "opaque-idempotency-v1",
                keyHash: "key-hash",
                operation: "credential_device_start",
                ownerId: "opaque-owner",
                responseJson: response,
              },
            ]
          : []
      );
    },
  };

  assert.equal(
    await main(
      ["verify", "--version", "v1"],
      cliDependencies(sourceKek, targetKek, store, output)
    ),
    2
  );
  assert.match(output.at(-1) ?? "", /remaining=1 .*status=resume/);
  assert.deepEqual(
    output.filter((line) => line.includes("idempotency")),
    ["idempotency_row_id: opaque-idempotency-v1"]
  );
  assert.doesNotMatch(output.join("\n"), /pending|opaque-owner|ciphertext/i);
});

test("expired idempotency responses do not block retirement", async () => {
  const sourceKek = await generateKek();
  const targetKek = await generateKek();
  const current = await encryptCredential("current", targetKek, "v2");
  const response = await encryptedIdempotencyResponseStorage(
    () => Promise.resolve(sourceKek),
    () => Promise.resolve("v1")
  ).store(
    { status: "expired" },
    {
      operation: "credential_device_start",
      ownerId: "opaque-owner",
    }
  );
  const store: RewrapStore = {
    compareAndSwap: async () => true,
    listByVersion(version, _limit, afterId) {
      return Promise.resolve(
        !afterId && version === "v2" ? [{ id: "current", ...current }] : []
      );
    },
    listUnexpiredIdempotency() {
      return Promise.resolve([]);
    },
  };

  assert.equal(
    await main(
      ["verify", "--version", "v1"],
      cliDependencies(sourceKek, targetKek, store, [])
    ),
    0
  );
  assert.equal(response.kind, "encrypted_json");
});

test("legacy encrypted idempotency responses block the v1 retirement gate", async () => {
  const sourceKek = await generateKek();
  const targetKek = await generateKek();
  const current = await encryptCredential("current", targetKek, "v2");
  const versioned = await encryptCredential(
    JSON.stringify({
      body: { status: "legacy" },
      operation: "credential_device_start",
      ownerId: "opaque-owner",
      version: 1,
    }),
    sourceKek,
    "v1"
  );
  const legacy = {
    kind: "encrypted_json" as const,
    payload: {
      ciphertext: versioned.ciphertext,
      iv: versioned.iv,
      wrappedKey: versioned.wrappedKey,
    },
  };
  const store: RewrapStore = {
    compareAndSwap: async () => true,
    listByVersion(version, _limit, afterId) {
      return Promise.resolve(
        !afterId && version === "v2" ? [{ id: "current", ...current }] : []
      );
    },
    listUnexpiredIdempotency(now, _limit, afterId) {
      return Promise.resolve(
        afterId
          ? []
          : [
              {
                expiresAt: new Date(now.getTime() + 60_000),
                id: "opaque-legacy-idempotency",
                keyHash: "",
                operation: "credential_device_start",
                ownerId: "opaque-owner",
                responseJson: legacy,
              },
            ]
      );
    },
  };
  const output: string[] = [];

  assert.equal(
    await main(
      ["verify", "--version", "v1"],
      cliDependencies(sourceKek, targetKek, store, output)
    ),
    2
  );
  assert.deepEqual(
    output.filter((line) => line.includes("idempotency")),
    ["idempotency_row_id: opaque-legacy-idempotency"]
  );
});

test("plain idempotency responses are not classified as encrypted envelopes", async () => {
  const sourceKek = await generateKek();
  const targetKek = await generateKek();
  const current = await encryptCredential("current", targetKek, "v2");
  const store: RewrapStore = {
    compareAndSwap: async () => true,
    listByVersion(version, _limit, afterId) {
      return Promise.resolve(
        !afterId && version === "v2" ? [{ id: "current", ...current }] : []
      );
    },
    listUnexpiredIdempotency(now, _limit, afterId) {
      return Promise.resolve(
        afterId
          ? []
          : [
              {
                expiresAt: new Date(now.getTime() + 60_000),
                id: "opaque-plain-idempotency",
                keyHash: "",
                operation: "credential_device_start",
                ownerId: "opaque-owner",
                responseJson: {
                  body: { status: "plain" },
                  kind: "plain_json",
                },
              },
            ]
      );
    },
  };

  assert.equal(
    await main(
      ["verify", "--version", "v1"],
      cliDependencies(sourceKek, targetKek, store, [])
    ),
    0
  );
});

test("malformed encrypted idempotency responses fail the retirement gate", async () => {
  const sourceKek = await generateKek();
  const targetKek = await generateKek();
  const current = await encryptCredential("current", targetKek, "v2");
  const output: string[] = [];
  const store: RewrapStore = {
    compareAndSwap: async () => true,
    listByVersion(version, _limit, afterId) {
      return Promise.resolve(
        !afterId && version === "v2" ? [{ id: "current", ...current }] : []
      );
    },
    listUnexpiredIdempotency(now, _limit, afterId) {
      return Promise.resolve(
        afterId
          ? []
          : [
              {
                expiresAt: new Date(now.getTime() + 60_000),
                id: "opaque-malformed-idempotency",
                keyHash: "",
                operation: "credential_device_start",
                ownerId: "opaque-owner",
                responseJson: {
                  kind: "encrypted_json",
                  payload: { ciphertext: "malformed" },
                },
              },
            ]
      );
    },
  };

  assert.equal(
    await main(
      ["verify", "--version", "v1"],
      cliDependencies(sourceKek, targetKek, store, output)
    ),
    1
  );
  assert.deepEqual(
    output.filter((line) => line.includes("idempotency")),
    ["idempotency_row_id: opaque-malformed-idempotency"]
  );
});

test("malformed old idempotency envelope fields fail instead of blocking as remaining", async () => {
  const sourceKek = await generateKek();
  const targetKek = await generateKek();
  const current = await encryptCredential("current", targetKek, "v2");
  const response = await encryptedIdempotencyResponseStorage(
    () => Promise.resolve(sourceKek),
    () => Promise.resolve("v1")
  ).store(
    { status: "malformed" },
    {
      operation: "credential_device_start",
      ownerId: "opaque-owner",
    }
  );
  assert.equal(response.kind, "encrypted_json");
  if (response.kind !== "encrypted_json") {
    throw new Error("expected encrypted response");
  }

  const malformedPayloads = [
    ["wrapped-key", { ...response.payload, wrappedKey: "malformed" }],
    ["ciphertext", { ...response.payload, ciphertext: "malformed" }],
    ["iv", { ...response.payload, iv: "malformed" }],
    ["aad", { ...response.payload, aadVersion: 2 }],
  ] as const;

  await Promise.all(
    malformedPayloads.map(async ([field, payload], index) => {
      const output: string[] = [];
      const id = `opaque-old-envelope-${index}`;
      const store: RewrapStore = {
        compareAndSwap: async () => true,
        listByVersion(version, _limit, afterId) {
          return Promise.resolve(
            !afterId && version === "v2" ? [{ id: "current", ...current }] : []
          );
        },
        listUnexpiredIdempotency(now, _limit, afterId) {
          return Promise.resolve(
            afterId
              ? []
              : [
                  {
                    expiresAt: new Date(now.getTime() + 60_000),
                    id,
                    keyHash: "",
                    operation: "credential_device_start",
                    ownerId: "opaque-owner",
                    responseJson: { kind: "encrypted_json", payload },
                  },
                ]
          );
        },
      };

      assert.equal(
        await main(
          ["verify", "--version", "v1"],
          cliDependencies(sourceKek, targetKek, store, output)
        ),
        1,
        field
      );
      assert.match(output.at(-1) ?? "", /status=failed/);
      assert.deepEqual(
        output.filter((line) => line.includes("idempotency")),
        [`idempotency_row_id: ${id}`]
      );
      assert.doesNotMatch(
        output.join("\n"),
        /malformed|wrappedKey|ciphertext/i
      );
    })
  );
});

test("rollback retirement gate also counts unexpired v2 idempotency responses", async () => {
  const sourceKek = await generateKek();
  const targetKek = await generateKek();
  const current = await encryptCredential("current", sourceKek, "v1");
  const response = await encryptedIdempotencyResponseStorage(
    () => Promise.resolve(targetKek),
    () => Promise.resolve("v2")
  ).store(
    { status: "rollback" },
    {
      operation: "credential_device_start",
      ownerId: "opaque-owner",
    }
  );
  const store: RewrapStore = {
    compareAndSwap: async () => true,
    listByVersion(version, _limit, afterId) {
      return Promise.resolve(
        !afterId && version === "v1" ? [{ id: "current", ...current }] : []
      );
    },
    listUnexpiredIdempotency(now, _limit, afterId) {
      return Promise.resolve(
        afterId
          ? []
          : [
              {
                expiresAt: new Date(now.getTime() + 60_000),
                id: "opaque-idempotency-v2",
                keyHash: "",
                operation: "credential_device_start",
                ownerId: "opaque-owner",
                responseJson: response,
              },
            ]
      );
    },
  };
  const output: string[] = [];

  assert.equal(
    await main(
      ["verify", "--version", "v2"],
      cliDependencies(sourceKek, targetKek, store, output, "v1")
    ),
    2
  );
  assert.deepEqual(
    output.filter((line) => line.includes("idempotency")),
    ["idempotency_row_id: opaque-idempotency-v2"]
  );
});

test("main turns configuration errors into a private failure", async () => {
  const output: string[] = [];
  const dependencies = cliDependencies(
    await generateKek(),
    await generateKek(),
    {
      compareAndSwap: async () => false,
      listByVersion: async () => [],
    },
    output
  );
  dependencies.loadRing = () =>
    Promise.reject(new Error("sensitive configuration detail"));

  assert.equal(await main(["--from", "v1", "--to", "v2"], dependencies), 1);
  assert.deepEqual(output, ["stderr: Credential rewrap failed."]);
  assert.doesNotMatch(output.join("\n"), /sensitive|configuration detail/i);
});

function cliDependencies(
  sourceKek: CryptoKey,
  targetKek: CryptoKey,
  store: RewrapStore,
  output: string[],
  currentVersion: "v1" | "v2" = "v2"
): RewrapCliDependencies {
  const ring: CredentialKekRing = {
    current: currentVersion === "v1" ? sourceKek : targetKek,
    currentVersion,
    keyFor(version) {
      if (version === "v1") {
        return sourceKek;
      }
      if (version === "v2") {
        return targetKek;
      }
      throw new Error("version is not configured");
    },
    versions: ["v1", "v2"],
  };
  return {
    loadRing: () => Promise.resolve(ring),
    loadStore: () => Promise.resolve(store),
    stderr: (line) => output.push(`stderr: ${line}`),
    stdout: (line) => output.push(line),
  };
}
