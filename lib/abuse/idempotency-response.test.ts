import assert from "node:assert/strict";
import test from "node:test";
import { generateKek } from "../credentials/envelope";
import {
  encryptedIdempotencyResponseStorage,
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
  const storage = encryptedIdempotencyResponseStorage(() =>
    Promise.resolve(kek)
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
  const storage = encryptedIdempotencyResponseStorage(() =>
    Promise.resolve(kek)
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

test("encrypted responses replay with the envelope's KEK after rotation", async () => {
  const oldKek = await generateKek();
  const currentKek = await generateKek();
  let currentVersion = "v1";
  let currentKekForWrites = oldKek;
  const storage = encryptedIdempotencyResponseStorage(
    (version) =>
      Promise.resolve(
        version === undefined
          ? currentKekForWrites
          : version === "v1"
            ? oldKek
            : currentKek
      ),
    () => Promise.resolve(currentVersion)
  );

  const stored = await storage.store({ status: "pending" }, CONTEXT);
  currentVersion = "v2";
  currentKekForWrites = currentKek;

  assert.deepEqual(await storage.replay(stored, CONTEXT), {
    status: "pending",
  });
});
