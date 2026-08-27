import assert from "node:assert/strict";
import test from "node:test";
import {
  base64UrlDecode,
  splitToken,
  TOKEN_LIFETIME_SECONDS,
} from "@opencoven/agent-contracts";
import { claimsForUser, mintRunnerToken } from "./runner-token";

async function signingKey(): Promise<{ pkcs8: string; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  return {
    pkcs8: Buffer.from(raw).toString("base64url"),
    publicKey: pair.publicKey,
  };
}

test("a minted token carries the requested claims and a future expiry", async () => {
  const { pkcs8 } = await signingKey();

  const token = await mintRunnerToken(
    { authVersion: 0, plan: "subscriber", sub: "user-1", tenant: "acme" },
    pkcs8
  );

  const parts = splitToken(token);
  assert.ok(parts, "token must split into payload and signature");

  const payload = JSON.parse(
    new TextDecoder().decode(base64UrlDecode(parts.payload))
  );
  assert.equal(payload.tenant, "acme");
  assert.equal(payload.plan, "subscriber");
  assert.equal(payload.sub, "user-1");
  assert.equal(payload.kid, "legacy");
  assert.equal(payload.authVersion, 0);

  const now = Math.floor(Date.now() / 1000);
  assert.ok(payload.exp > now, "expiry must be in the future");
  assert.ok(
    payload.exp <= now + TOKEN_LIFETIME_SECONDS,
    "expiry must not exceed the configured lifetime"
  );
});

test("the signature verifies against the matching public key", async () => {
  // The contract with the worker: what this mints is what that verifies.
  const { pkcs8, publicKey } = await signingKey();

  const token = await mintRunnerToken(
    {
      authVersion: 0,
      plan: "demo",
      sub: "user-2",
      tenant: "d_9c8589018a57479181fe4c455b099bc9",
    },
    pkcs8
  );
  const parts = splitToken(token);
  assert.ok(parts);

  const verified = await crypto.subtle.verify(
    { name: "Ed25519" },
    publicKey,
    new Uint8Array(base64UrlDecode(parts.signature)),
    new TextEncoder().encode(parts.payload)
  );

  assert.equal(verified, true);
});

test("a token minted by one key does not verify against another", async () => {
  const signer = await signingKey();
  const other = await signingKey();

  const token = await mintRunnerToken(
    { authVersion: 0, plan: "subscriber", sub: "user-1", tenant: "victim" },
    signer.pkcs8
  );
  const parts = splitToken(token);
  assert.ok(parts);

  const verified = await crypto.subtle.verify(
    { name: "Ed25519" },
    other.publicKey,
    new Uint8Array(base64UrlDecode(parts.signature)),
    new TextEncoder().encode(parts.payload)
  );

  assert.equal(verified, false);
});

test("minting refuses claims the worker would reject", async () => {
  // Validating at mint time means a malformed claim fails here, loudly, rather
  // than becoming a token that silently never verifies.
  const { pkcs8 } = await signingKey();

  await assert.rejects(() =>
    mintRunnerToken(
      { authVersion: 0, plan: "subscriber", sub: "user-1", tenant: "" },
      pkcs8
    )
  );
  await assert.rejects(() =>
    mintRunnerToken(
      {
        authVersion: 0,
        plan: "subscriber",
        sub: "user-1",
        tenant: "t".repeat(65),
      },
      pkcs8
    )
  );
});

test("a signed-in user is not granted a subscriber plan by default", () => {
  // The bug this guards: hardcoding `plan: "subscriber"` here would hand the
  // owner's database to every visitor. While this lived inline in the route
  // handler it was unreachable by any test, and that mutation passed.
  for (const type of ["guest", "regular", "demo", "", "SUBSCRIBER"]) {
    const claims = claimsForUser({
      authVersion: 0,
      id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      type,
    });

    assert.equal(
      claims.plan,
      "demo",
      `type ${JSON.stringify(type)} must not yield a subscriber plan`
    );
  }

  assert.equal(
    claimsForUser({
      authVersion: 0,
      id: "9c858901-8a57-4791-81fe-4c455b099bc9",
      type: "subscriber",
    }).plan,
    "subscriber"
  );
});

test("claims carry a stable tenant derived from the user id", () => {
  // Not `toSession().tenant`: that mints a fresh demo tenant per call, so a
  // user's agents would vanish between mints.
  const first = claimsForUser({
    authVersion: 0,
    id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    type: "guest",
  });
  const second = claimsForUser({
    authVersion: 0,
    id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    type: "guest",
  });

  assert.equal(first.tenant, second.tenant);
  assert.equal(first.tenant, "u_6ba7b8109dad11d180b400c04fd430c8");
  assert.equal(first.sub, "6ba7b810-9dad-11d1-80b4-00c04fd430c8");
});
