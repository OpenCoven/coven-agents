import assert from "node:assert/strict";
import test from "node:test";
import { base64UrlEncode } from "@opencoven/agent-contracts";
import { credentialKekRingFromEnvironment } from "./key-ring";

async function rawKek(): Promise<string> {
  const key = await crypto.subtle.generateKey(
    { length: 256, name: "AES-KW" },
    true,
    ["wrapKey", "unwrapKey"]
  );
  return base64UrlEncode(
    new Uint8Array(await crypto.subtle.exportKey("raw", key as CryptoKey))
  );
}

async function environment() {
  return {
    CREDENTIAL_KEK_CURRENT_VERSION: "v2",
    CREDENTIAL_KEK_V1: await rawKek(),
    CREDENTIAL_KEK_V2: await rawKek(),
  };
}

test("loads current and explicitly named previous KEKs", async () => {
  const ring = await credentialKekRingFromEnvironment(await environment());

  assert.equal(ring.currentVersion, "v2");
  assert.ok(ring.keyFor("v1"));
  assert.ok(ring.keyFor("v2"));
  assert.deepEqual(ring.versions, ["v1", "v2"]);
  assert.equal(ring.keyFor("v2"), ring.current);
});

test("refuses missing current configuration and unknown versions", async () => {
  const env = await environment();

  await assert.rejects(() =>
    credentialKekRingFromEnvironment({
      ...env,
      CREDENTIAL_KEK_CURRENT_VERSION: "",
    })
  );
  await assert.rejects(() =>
    credentialKekRingFromEnvironment({
      ...env,
      CREDENTIAL_KEK_CURRENT_VERSION: "v3",
    })
  );

  const ring = await credentialKekRingFromEnvironment(env);
  assert.throws(() => ring.keyFor("v3"));
});

test("refuses unsupported versioned environment keys", async () => {
  const env = await environment();

  await assert.rejects(() =>
    credentialKekRingFromEnvironment({
      ...env,
      CREDENTIAL_KEK_V3: env.CREDENTIAL_KEK_V2,
    })
  );
});

test("legacy CREDENTIAL_KEK maps only to explicit v1", async () => {
  const legacy = await rawKek();
  const env = {
    CREDENTIAL_KEK: legacy,
    CREDENTIAL_KEK_CURRENT_VERSION: "v1",
  };
  const ring = await credentialKekRingFromEnvironment(env);

  assert.equal(ring.currentVersion, "v1");
  assert.ok(ring.keyFor("v1"));
  assert.deepEqual(ring.versions, ["v1"]);
});

test("conflicting legacy and versioned v1 keys fail closed", async () => {
  const env = await environment();
  const conflictingLegacy = await rawKek();
  await assert.rejects(() =>
    credentialKekRingFromEnvironment({
      ...env,
      CREDENTIAL_KEK: conflictingLegacy,
    })
  );
});

test("the cache is invalidated by any configuration change", async () => {
  const env = await environment();
  const first = await credentialKekRingFromEnvironment(env);
  const second = await credentialKekRingFromEnvironment(env);
  assert.equal(first, second);

  const changed = { ...env, CREDENTIAL_KEK_V2: await rawKek() };
  const third = await credentialKekRingFromEnvironment(changed);
  assert.notEqual(third, first);
});
