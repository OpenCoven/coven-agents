import assert from "node:assert/strict";
import test from "node:test";
import { base64UrlEncode } from "./identity";
import { importVerifyKeyRing, verifyRunnerToken } from "./verify-token";

const NOW = new Date("2026-08-27T00:00:00.000Z");

async function keyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

async function publicSpki(key: CryptoKey): Promise<string> {
  return base64UrlEncode(
    new Uint8Array(await crypto.subtle.exportKey("spki", key))
  );
}

async function token(
  pair: CryptoKeyPair,
  kid: string,
  exp = Math.floor(NOW.getTime() / 1000) + 900
): Promise<string> {
  const payload = base64UrlEncode(
    new TextEncoder().encode(
      JSON.stringify({
        authVersion: 0,
        exp,
        kid,
        plan: "subscriber",
        sub: "user-1",
        tenant: "tenant_acme",
      })
    )
  );
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    pair.privateKey,
    new TextEncoder().encode(payload)
  );
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

test("routes by kid and verifies current and unexpired previous keys", async () => {
  const current = await keyPair();
  const previous = await keyPair();
  const ring = await importVerifyKeyRing(
    {
      currentId: "current",
      currentPublicKey: await publicSpki(current.publicKey),
      previousId: "previous",
      previousLastSignedAt: "2026-08-26T23:59:00.000Z",
      previousPublicKey: await publicSpki(previous.publicKey),
      previousRetireAt: "2026-08-27T00:15:00.000Z",
    },
    NOW
  );

  assert.ok(
    await verifyRunnerToken(await token(current, "current"), ring, NOW)
  );
  assert.ok(
    await verifyRunnerToken(await token(previous, "previous"), ring, NOW)
  );
});

test("refuses unknown and retired key ids", async () => {
  const current = await keyPair();
  const previous = await keyPair();
  const unknown = await keyPair();
  const ring = await importVerifyKeyRing(
    {
      currentId: "current",
      currentPublicKey: await publicSpki(current.publicKey),
      previousId: "previous",
      previousLastSignedAt: "2026-08-26T23:59:00.000Z",
      previousPublicKey: await publicSpki(previous.publicKey),
      previousRetireAt: "2026-08-27T00:15:00.000Z",
    },
    NOW
  );

  assert.equal(
    await verifyRunnerToken(await token(unknown, "unknown"), ring, NOW),
    null
  );
  assert.equal(
    await verifyRunnerToken(
      await token(previous, "previous"),
      ring,
      new Date("2026-08-27T00:15:00.001Z")
    ),
    null
  );
});

test("accepts a previous token exactly at retireAt and refuses it after", async () => {
  const current = await keyPair();
  const previous = await keyPair();
  const ring = await importVerifyKeyRing(
    {
      currentId: "current",
      currentPublicKey: await publicSpki(current.publicKey),
      previousId: "previous",
      previousLastSignedAt: NOW.toISOString(),
      previousPublicKey: await publicSpki(previous.publicKey),
      previousRetireAt: new Date(NOW.getTime() + 900_000).toISOString(),
    },
    NOW
  );
  const previousToken = await token(previous, "previous");

  assert.ok(
    await verifyRunnerToken(
      previousToken,
      ring,
      new Date("2026-08-27T00:15:00.000Z")
    )
  );
  assert.equal(
    await verifyRunnerToken(
      previousToken,
      ring,
      new Date("2026-08-27T00:15:00.001Z")
    ),
    null
  );
});
