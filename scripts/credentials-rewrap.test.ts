import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { encryptCredential, generateKek } from "../lib/credentials/envelope";
import {
  parseRewrapArguments,
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

test("a concurrent update loses only the CAS and never overwrites newer data", async () => {
  const sourceKek = await generateKek();
  const targetKek = await generateKek();
  const sealed = await encryptCredential("credential", sourceKek, "v1");
  const row = { id: "opaque-row-id", ...sealed };
  let casCalls = 0;
  const store: RewrapStore = {
    compareAndSwap() {
      casCalls += 1;
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
  assert.match(source, /\.set\(\{ kekVersion: toVersion, wrappedKey \}\)/);
  assert.match(source, /eq\(tenantCredential\.id, row\.id\)/);
  assert.match(source, /eq\(tenantCredential\.kekVersion, row\.kekVersion\)/);
  assert.match(
    source,
    /eq\(tenantCredential\.wrappedKey, expectedWrappedKey\)/
  );
});
