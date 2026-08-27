import assert from "node:assert/strict";
import test from "node:test";
import { encryptCredential, generateKek } from "../credentials/envelope";
import {
  encryptedIdempotencyResponseStorage,
  parseStoredIdempotencyResponseEnvelope,
  plaintextIdempotencyResponseStorage,
} from "./idempotency-response";

const CONTEXT = {
  operation: "credential_device_start",
  ownerId: "00000000-0000-4000-8000-000000000001",
};

test("plaintext responses use a non-null tagged envelope even for a null body", async () => {
  const stored = await plaintextIdempotencyResponseStorage.store(null, CONTEXT);

  assert.deepEqual(stored, { body: null, kind: "plain_json" });
  assert.equal(
    await plaintextIdempotencyResponseStorage.replay(stored, CONTEXT),
    null
  );
});

test("encrypted device-flow responses never store the device code in plaintext", async () => {
  const kek = await generateKek();
  const storage = encryptedIdempotencyResponseStorage(
    () => Promise.resolve(kek),
    () => Promise.resolve("v2")
  );
  const body = {
    deviceCode: "device-code-sensitive",
    interval: 5,
    userCode: "ABCD-EFGH",
    verificationUri: "https://github.com/login/device",
  };

  const stored = await storage.store(body, CONTEXT);

  assert.equal(stored.kind, "encrypted_json");
  assert.doesNotMatch(JSON.stringify(stored), /device-code-sensitive/);
  assert.deepEqual(await storage.replay(stored, CONTEXT), body);
});

test("encrypted responses cannot be replayed for another owner", async () => {
  const kek = await generateKek();
  const storage = encryptedIdempotencyResponseStorage(
    () => Promise.resolve(kek),
    () => Promise.resolve("v2")
  );
  const stored = await storage.store(
    { deviceCode: "device-code-sensitive" },
    CONTEXT
  );

  await assert.rejects(
    storage.replay(stored, {
      ...CONTEXT,
      ownerId: "00000000-0000-4000-8000-000000000002",
    }),
    /does not belong to this idempotency claim/
  );
});

test("encrypted responses bind the idempotency key and route with AAD", async () => {
  const kek = await generateKek();
  const storage = encryptedIdempotencyResponseStorage(
    () => Promise.resolve(kek),
    () => Promise.resolve("v2")
  );
  const stored = await storage.store(
    { deviceCode: "device-code-sensitive" },
    {
      ...CONTEXT,
      keyHash: "key-hash-a",
    }
  );

  assert.equal(stored.kind, "encrypted_json");
  if (stored.kind !== "encrypted_json") {
    throw new Error("expected encrypted envelope");
  }
  assert.equal(stored.payload.aadVersion, 1);
  await assert.rejects(
    storage.replay(stored, { ...CONTEXT, keyHash: "key-hash-b" })
  );
});

test("encrypted responses replay with the envelope's KEK after rotation", async () => {
  const oldKek = await generateKek();
  const currentKek = await generateKek();
  let currentVersion = "v1";
  const storage = encryptedIdempotencyResponseStorage(
    (version) => Promise.resolve(version === "v1" ? oldKek : currentKek),
    () => Promise.resolve(currentVersion)
  );

  const stored = await storage.store({ status: "pending" }, CONTEXT);
  currentVersion = "v2";

  assert.deepEqual(await storage.replay(stored, CONTEXT), {
    status: "pending",
  });
  assert.equal(
    stored.kind === "encrypted_json" ? stored.payload.kekVersion : null,
    "v1"
  );
});

test("legacy encrypted envelopes are explicitly migrated to v1 at the boundary", async () => {
  const oldKek = await generateKek();
  const currentKek = await generateKek();
  const keyFor = (version: string) =>
    Promise.resolve(version === "v1" ? oldKek : currentKek);
  const versioned = await encryptCredential(
    JSON.stringify({
      body: { status: "pending" },
      operation: CONTEXT.operation,
      ownerId: CONTEXT.ownerId,
      version: 1,
    }),
    oldKek,
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
  const normalized = parseStoredIdempotencyResponseEnvelope(legacy);
  assert.equal(
    normalized.kind === "encrypted_json" ? normalized.payload.kekVersion : null,
    "v1"
  );

  const v2Storage = encryptedIdempotencyResponseStorage(keyFor, () =>
    Promise.resolve("v2")
  );
  assert.deepEqual(await v2Storage.replay(normalized, CONTEXT), {
    status: "pending",
  });
});

test("legacy encrypted envelopes fail closed when v1 is not configured", async () => {
  const oldKek = await generateKek();
  const versioned = await encryptCredential(
    JSON.stringify({
      body: { status: "pending" },
      operation: CONTEXT.operation,
      ownerId: CONTEXT.ownerId,
      version: 1,
    }),
    oldKek,
    "v1"
  );

  const legacy = parseStoredIdempotencyResponseEnvelope({
    kind: "encrypted_json",
    payload: {
      ciphertext: versioned.ciphertext,
      iv: versioned.iv,
      wrappedKey: versioned.wrappedKey,
    },
  });
  const v2OnlyStorage = encryptedIdempotencyResponseStorage(
    (version: string) => {
      if (version !== "v2") {
        return Promise.reject(new Error("v1 is not configured"));
      }
      return Promise.resolve(oldKek);
    },
    () => Promise.resolve("v2")
  );

  await assert.rejects(
    v2OnlyStorage.replay(legacy, CONTEXT),
    /v1 is not configured/
  );
});

test("new encrypted envelopes use the configured current version", async () => {
  const v2 = await generateKek();
  const storage = encryptedIdempotencyResponseStorage(
    (version: string) => {
      assert.equal(version, "v2");
      return Promise.resolve(v2);
    },
    () => Promise.resolve("v2")
  );

  const stored = await storage.store({ status: "current" }, CONTEXT);
  assert.equal(
    stored.kind === "encrypted_json" ? stored.payload.kekVersion : null,
    "v2"
  );
});
