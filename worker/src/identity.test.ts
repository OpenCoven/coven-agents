import assert from "node:assert/strict";
import test from "node:test";
import {
  base64UrlEncode,
  type RunnerClaims,
  TOKEN_LIFETIME_SECONDS,
} from "@opencoven/agent-contracts";
import { verifyRunnerToken } from "./identity.js";

async function keyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

async function mint(
  privateKey: CryptoKey,
  // biome-ignore lint/suspicious/noShadow: matches the `claims()` builder below; renaming would just be `claimsValue` vs `claims`, no clearer.
  claims: RunnerClaims
): Promise<string> {
  const payload = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(claims))
  );
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    new TextEncoder().encode(payload)
  );
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function claims(overrides: Partial<RunnerClaims> = {}): RunnerClaims {
  return {
    authVersion: 0,
    exp: Math.floor(Date.now() / 1000) + TOKEN_LIFETIME_SECONDS,
    kid: "legacy",
    plan: "subscriber",
    sub: "user-1",
    tenant: "acme",
    ...overrides,
  };
}

test("a token signed by the matching key verifies", async () => {
  const pair = await keyPair();
  const token = await mint(pair.privateKey, claims());

  const result = await verifyRunnerToken(token, pair.publicKey);

  assert.equal(result?.tenant, "acme");
  assert.equal(result?.plan, "subscriber");
});

test("a token signed by a different key is refused", async () => {
  const signer = await keyPair();
  const other = await keyPair();
  const token = await mint(signer.privateKey, claims({ tenant: "victim" }));

  assert.equal(await verifyRunnerToken(token, other.publicKey), null);
});

test("tampering with the payload invalidates the signature", async () => {
  const pair = await keyPair();
  const token = await mint(pair.privateKey, claims({ tenant: "acme" }));
  const forged = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(claims({ tenant: "victim" })))
  );

  const tampered = `${forged}.${token.split(".")[1]}`;

  assert.equal(await verifyRunnerToken(tampered, pair.publicKey), null);
});

test("an expired token is refused even though the signature is good", async () => {
  const pair = await keyPair();
  const token = await mint(
    pair.privateKey,
    claims({ exp: Math.floor(Date.now() / 1000) - 1 })
  );

  assert.equal(await verifyRunnerToken(token, pair.publicKey), null);
});

test("a malformed token is refused without throwing", async () => {
  const pair = await keyPair();

  for (const bad of ["", "no-dot", "a.b.c", "!!!.???"]) {
    assert.equal(
      // biome-ignore lint/performance/noAwaitInLoops: each malformed input is asserted in turn against the same key; there's nothing to parallelise for a handful of test fixtures.
      await verifyRunnerToken(bad, pair.publicKey),
      null,
      `expected ${JSON.stringify(bad)} to be refused`
    );
  }
});

test("a payload is never parsed until its signature is proven", async () => {
  // Order of operations is a security property, not a style preference:
  // parsing first means running JSON.parse and the schema over bytes an
  // attacker chose. Asserting the outcome cannot catch a reorder, because a
  // bad token is refused either way — so this watches whether the parse
  // happened at all.
  const signer = await keyPair();
  const other = await keyPair();
  const token = await mint(signer.privateKey, claims({ tenant: "victim" }));

  const realParse = JSON.parse;
  let parsed = false;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
    parsed = true;
    return realParse(...args);
  }) as typeof JSON.parse;

  try {
    assert.equal(await verifyRunnerToken(token, other.publicKey), null);
  } finally {
    JSON.parse = realParse;
  }

  assert.equal(parsed, false, "full claims must not be parsed before verify");
});
