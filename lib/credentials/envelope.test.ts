import assert from "node:assert/strict";
import test from "node:test";
import { base64UrlEncode } from "@opencoven/agent-contracts";
import {
  decryptCredential,
  encryptCredential,
  generateKek,
  importKek,
  rewrapWrappedKey,
  unwrapDataKey,
} from "./envelope";

test("a credential round-trips through encrypt and decrypt", async () => {
  const kek = await generateKek();

  const sealed = await encryptCredential("ghp_secret_value", kek, "v1");
  const opened = await decryptCredential(sealed, kek);

  assert.equal(opened, "ghp_secret_value");
  assert.equal(sealed.kekVersion, "v1");
});

test("the plaintext never appears in the stored envelope", async () => {
  const kek = await generateKek();

  const sealed = await encryptCredential("ghp_secret_value", kek, "v1");

  const serialized = JSON.stringify(sealed);
  assert.ok(!serialized.includes("ghp_secret_value"));
});

test("each credential gets its own data key", async () => {
  // A shared data key would mean one compromised credential exposes the rest,
  // and would make per-tenant revocation meaningless.
  const kek = await generateKek();

  const first = await encryptCredential("same-value", kek, "v1");
  const second = await encryptCredential("same-value", kek, "v1");

  assert.notEqual(first.wrappedKey, second.wrappedKey);
  assert.notEqual(first.ciphertext, second.ciphertext);
});

test("a wrong KEK cannot open the envelope", async () => {
  const sealed = await encryptCredential(
    "ghp_secret_value",
    await generateKek(),
    "v1"
  );

  const wrongKek = await generateKek();
  await assert.rejects(() => decryptCredential(sealed, wrongKek));
});

test("tampering with the ciphertext is detected", async () => {
  // AES-GCM is authenticated: a flipped bit must fail loudly rather than
  // decrypt to something plausible.
  const kek = await generateKek();
  const sealed = await encryptCredential("ghp_secret_value", kek, "v1");

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
    Array.from({ length: 20 }, () => encryptCredential("same-value", kek, "v1"))
  );
  const ivs = new Set(sealed.map((entry) => entry.iv));

  assert.equal(ivs.size, 20, "initialisation vectors must not repeat");
});

test("rewrapping preserves the ciphertext and the underlying data key", async () => {
  const sourceKek = await generateKek();
  const targetKek = await generateKek();
  const sealed = await encryptCredential("same-secret", sourceKek, "v1");
  const { ciphertext, iv } = sealed;

  const wrappedKey = await rewrapWrappedKey(
    sealed.wrappedKey,
    sourceKek,
    targetKek
  );
  const opened = await decryptCredential(
    { ...sealed, kekVersion: "v2", wrappedKey },
    targetKek
  );

  assert.equal(opened, "same-secret");
  assert.equal(sealed.ciphertext, ciphertext);
  assert.equal(sealed.iv, iv);
});

test("malformed envelope fields are rejected before WebCrypto", async () => {
  const kek = await generateKek();
  const sealed = await encryptCredential("secret", kek, "v1");

  await assert.rejects(() =>
    decryptCredential({ ...sealed, kekVersion: "bad version" }, kek)
  );
  await assert.rejects(() =>
    decryptCredential({ ...sealed, iv: "not-base64!" }, kek)
  );
});

test("imported KEKs remain non-extractable", async () => {
  const generated = await generateKek();
  const raw = base64UrlEncode(
    new Uint8Array(await crypto.subtle.exportKey("raw", generated))
  );
  const imported = await importKek(raw);

  await assert.rejects(() => crypto.subtle.exportKey("raw", imported));
});

test("legacy standard base64 KEK material remains importable", async () => {
  const generated = await generateKek();
  const raw = Buffer.from(
    await crypto.subtle.exportKey("raw", generated)
  ).toString("base64");

  const imported = await importKek(raw);
  const sealed = await encryptCredential("secret", imported, "v1");

  assert.equal(await decryptCredential(sealed, imported), "secret");
});

test("ordinary data-key unwrapping remains non-extractable", async () => {
  const kek = await generateKek();
  const sealed = await encryptCredential("secret", kek, "v1");
  const dek = await unwrapDataKey(sealed.wrappedKey, kek);

  await assert.rejects(() => crypto.subtle.exportKey("raw", dek));
});
