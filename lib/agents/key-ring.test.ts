import assert from "node:assert/strict";
import test from "node:test";
import {
  base64UrlEncode,
  TOKEN_LIFETIME_SECONDS,
} from "@opencoven/agent-contracts";
import { runnerVerificationKeyRingFromEnvironment } from "./key-ring";

async function publicKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return base64UrlEncode(
    new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))
  );
}

test("loads the retained explicit and legacy verification configurations", async () => {
  const key = await publicKey();

  const compatibilityRing = await runnerVerificationKeyRingFromEnvironment({
    RUNNER_SIGNING_KEY_ID: "key-2026-08",
    RUNNER_SIGNING_PUBLIC_KEY: key,
  });
  assert.equal(compatibilityRing.current.id, "key-2026-08");

  const workerRing = await runnerVerificationKeyRingFromEnvironment({
    RUNNER_VERIFY_KEY: key,
    RUNNER_VERIFY_KEY_ID: "key-2026-08",
  });
  assert.equal(workerRing.current.id, "key-2026-08");

  const legacyRing = await runnerVerificationKeyRingFromEnvironment({
    RUNNER_VERIFY_KEY: key,
  });
  assert.equal(legacyRing.current.id, "legacy");
});

test("does not mix compatibility and Worker verification names", async () => {
  const key = await publicKey();

  await assert.rejects(() =>
    runnerVerificationKeyRingFromEnvironment({
      RUNNER_SIGNING_KEY_ID: "key-2026-08",
      RUNNER_SIGNING_PUBLIC_KEY: key,
      RUNNER_VERIFY_KEY: key,
    })
  );
});

test("treats blank optional previous variables as absent", async () => {
  const key = await publicKey();
  const ring = await runnerVerificationKeyRingFromEnvironment({
    RUNNER_VERIFY_KEY: key,
    RUNNER_VERIFY_PREVIOUS_KEY: "\t",
    RUNNER_VERIFY_PREVIOUS_KEY_ID: " ",
    RUNNER_VERIFY_PREVIOUS_LAST_SIGNED_AT: "",
    RUNNER_VERIFY_PREVIOUS_RETIRE_AT: "",
  });

  assert.equal(ring.previous, undefined);
});

test("rejects partial previous verification configuration", async () => {
  const key = await publicKey();

  await assert.rejects(() =>
    runnerVerificationKeyRingFromEnvironment({
      RUNNER_VERIFY_KEY: key,
      RUNNER_VERIFY_PREVIOUS_KEY_ID: "key-2026-07",
    })
  );
});

test("enforces the previous-key retirement boundary", async () => {
  const currentKey = await publicKey();
  const previousKey = await publicKey();
  const lastSignedAt = new Date("2026-08-27T00:00:00.000Z");
  const retireAt = new Date(
    lastSignedAt.getTime() + TOKEN_LIFETIME_SECONDS * 1000
  );
  const base = {
    RUNNER_VERIFY_KEY: currentKey,
    RUNNER_VERIFY_KEY_ID: "key-2026-08",
    RUNNER_VERIFY_PREVIOUS_KEY: previousKey,
    RUNNER_VERIFY_PREVIOUS_KEY_ID: "key-2026-07",
    RUNNER_VERIFY_PREVIOUS_LAST_SIGNED_AT: lastSignedAt.toISOString(),
  };

  const exact = await runnerVerificationKeyRingFromEnvironment({
    ...base,
    RUNNER_VERIFY_PREVIOUS_RETIRE_AT: retireAt.toISOString(),
  });
  assert.equal(exact.previous?.retireAt.toISOString(), retireAt.toISOString());

  await assert.rejects(() =>
    runnerVerificationKeyRingFromEnvironment({
      ...base,
      RUNNER_VERIFY_PREVIOUS_RETIRE_AT: new Date(
        retireAt.getTime() - 1
      ).toISOString(),
    })
  );
});
