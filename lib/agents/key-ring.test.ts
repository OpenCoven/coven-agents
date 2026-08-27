import assert from "node:assert/strict";
import test from "node:test";
import { base64UrlEncode } from "@opencoven/agent-contracts";
import {
  parseRunnerKeyRing,
  runnerKeyRingFromEnvironment,
  runnerVerificationKeyRingFromEnvironment,
} from "./key-ring";

const NOW = new Date("2026-08-27T00:00:00.000Z");

async function generatedKeys() {
  const current = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const previous = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;

  return {
    current,
    currentPrivateKey: base64UrlEncode(
      new Uint8Array(await crypto.subtle.exportKey("pkcs8", current.privateKey))
    ),
    currentPublicKey: base64UrlEncode(
      new Uint8Array(await crypto.subtle.exportKey("spki", current.publicKey))
    ),
    previousPublicKey: base64UrlEncode(
      new Uint8Array(await crypto.subtle.exportKey("spki", previous.publicKey))
    ),
  };
}

test("parses a current key and an unexpired previous key", async () => {
  const keys = await generatedKeys();
  const ring = await parseRunnerKeyRing(
    {
      currentId: "key-2026-08",
      currentPrivateKey: keys.currentPrivateKey,
      currentPublicKey: keys.currentPublicKey,
      previousId: "key-2026-07",
      previousPublicKey: keys.previousPublicKey,
      previousRetireAt: "2026-08-27T00:15:00.000Z",
    },
    NOW
  );

  assert.equal(ring.current.id, "key-2026-08");
  assert.ok(ring.current.privateKey);
  assert.ok(ring.current.publicKey);
  assert.equal(ring.previous?.id, "key-2026-07");
  assert.equal(
    ring.previous?.retireAt.toISOString(),
    "2026-08-27T00:15:00.000Z"
  );
});

test("refuses incomplete, colliding, or expired rotation configuration", async () => {
  const keys = await generatedKeys();
  const base = {
    currentId: "key-2026-08",
    currentPrivateKey: keys.currentPrivateKey,
    currentPublicKey: keys.currentPublicKey,
  };

  await assert.rejects(() =>
    parseRunnerKeyRing({ ...base, currentId: "key 2026" }, NOW)
  );
  await assert.rejects(() =>
    parseRunnerKeyRing(
      {
        ...base,
        previousId: base.currentId,
        previousPublicKey: keys.previousPublicKey,
        previousRetireAt: "2026-08-27T00:15:00.000Z",
      },
      NOW
    )
  );
  await assert.rejects(() =>
    parseRunnerKeyRing(
      {
        ...base,
        previousId: "key-2026-07",
        previousPublicKey: keys.previousPublicKey,
        previousRetireAt: "2026-08-26T23:59:59.000Z",
      },
      NOW
    )
  );
  await assert.rejects(() =>
    parseRunnerKeyRing(
      {
        ...base,
        currentPublicKey: keys.previousPublicKey,
      },
      NOW
    )
  );
});

test("supports the legacy pair without silently replacing it", async () => {
  const keys = await generatedKeys();
  const environment = {
    RUNNER_SIGNING_KEY: keys.currentPrivateKey,
    RUNNER_VERIFY_KEY: keys.currentPublicKey,
  };

  const ring = await runnerKeyRingFromEnvironment(environment);
  assert.equal(ring.current.id, "legacy");
  assert.equal(
    await runnerKeyRingFromEnvironment(environment),
    ring,
    "unchanged configuration is parsed once and reused"
  );
});

test("requires an explicit id when a versioned public-key variable is used", async () => {
  const keys = await generatedKeys();

  await assert.rejects(() =>
    runnerKeyRingFromEnvironment({
      RUNNER_SIGNING_KEY: keys.currentPrivateKey,
      RUNNER_SIGNING_PUBLIC_KEY: keys.currentPublicKey,
    })
  );
  await assert.rejects(() =>
    runnerKeyRingFromEnvironment({
      RUNNER_SIGNING_KEY: keys.currentPrivateKey,
      RUNNER_SIGNING_KEY_ID: "",
      RUNNER_SIGNING_PUBLIC_KEY: keys.currentPublicKey,
      RUNNER_VERIFY_KEY: keys.currentPublicKey,
    })
  );
});

test("does not mix versioned app and legacy verification configuration", async () => {
  const keys = await generatedKeys();

  const appRing = await runnerVerificationKeyRingFromEnvironment({
    RUNNER_SIGNING_KEY_ID: "key-2026-08",
    RUNNER_SIGNING_PUBLIC_KEY: keys.currentPublicKey,
  });
  assert.equal(appRing.current.id, "key-2026-08");

  const workerRing = await runnerVerificationKeyRingFromEnvironment({
    RUNNER_VERIFY_KEY: keys.currentPublicKey,
    RUNNER_VERIFY_KEY_ID: "key-2026-08",
  });
  assert.equal(workerRing.current.id, "key-2026-08");

  await assert.rejects(() =>
    runnerVerificationKeyRingFromEnvironment({
      RUNNER_SIGNING_KEY_ID: "key-2026-08",
      RUNNER_VERIFY_KEY: keys.currentPublicKey,
    })
  );
});
