import assert from "node:assert/strict";
import test from "node:test";
import { decryptCredential, encryptCredential, generateKek } from "./envelope";

test("a credential round-trips through encrypt and decrypt", async () => {
  const kek = await generateKek();

  const sealed = await encryptCredential("ghp_secret_value", kek);
  const opened = await decryptCredential(sealed, kek);

  assert.equal(opened, "ghp_secret_value");
});

test("the plaintext never appears in the stored envelope", async () => {
  const kek = await generateKek();

  const sealed = await encryptCredential("ghp_secret_value", kek);

  const serialized = JSON.stringify(sealed);
  assert.ok(!serialized.includes("ghp_secret_value"));
  assert.ok(!serialized.includes("secret"));
});

test("each credential gets its own data key", async () => {
  // A shared data key would mean one compromised credential exposes the rest,
  // and would make per-tenant revocation meaningless.
  const kek = await generateKek();

  const first = await encryptCredential("same-value", kek);
  const second = await encryptCredential("same-value", kek);

  assert.notEqual(first.wrappedKey, second.wrappedKey);
  assert.notEqual(first.ciphertext, second.ciphertext);
});

test("a wrong KEK cannot open the envelope", async () => {
  const sealed = await encryptCredential(
    "ghp_secret_value",
    await generateKek()
  );

  const wrongKek = await generateKek();
  await assert.rejects(() => decryptCredential(sealed, wrongKek));
});

test("tampering with the ciphertext is detected", async () => {
  // AES-GCM is authenticated: a flipped bit must fail loudly rather than
  // decrypt to something plausible.
  const kek = await generateKek();
  const sealed = await encryptCredential("ghp_secret_value", kek);

  const flipped = Buffer.from(sealed.ciphertext, "base64url");
  flipped[0] ^= 0xff;

  await assert.rejects(() =>
    decryptCredential(
      { ...sealed, ciphertext: flipped.toString("base64url") },
      kek
    )
  );
});

test("every credential gets a fresh initialisation vector", async () => {
  // A fixed IV is survivable only while every credential also has its own
  // data key: AES-GCM fails catastrophically when key AND IV repeat together.
  // Pinning it here means a later change that shares a DEK cannot quietly
  // turn a static IV into a key-recovery bug.
  const kek = await generateKek();

  const sealed = await Promise.all(
    Array.from({ length: 20 }, () => encryptCredential("same-value", kek))
  );
  const ivs = new Set(sealed.map((entry) => entry.iv));

  assert.equal(ivs.size, 20, "initialisation vectors must not repeat");
});
