import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { fixtureClaims, isFixtureToken } from "./stub-credential.mjs";

function fixtureConfiguration() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    authVersion: 0,
    controlToken: "control-token",
    keyId: "key-test",
    privateKey,
    serviceToken: "service-token",
    verifyKey: publicKey,
  };
}

function fixtureToken(configuration, exp) {
  const payload = Buffer.from(
    JSON.stringify({ ...fixtureClaims(configuration), exp })
  ).toString("base64url");
  const signature = sign(
    null,
    Buffer.from(payload),
    configuration.privateKey
  ).toString("base64url");
  return `${payload}.${signature}`;
}

test("fixture token expiry matches the runner's inclusive boundary", () => {
  const configuration = fixtureConfiguration();
  const now = 1_772_000_000_000;
  const boundary = Math.floor(now / 1000);

  assert.equal(
    isFixtureToken(
      fixtureToken(configuration, boundary - 1),
      configuration,
      now
    ),
    false
  );
  assert.equal(
    isFixtureToken(fixtureToken(configuration, boundary), configuration, now),
    false
  );
  assert.equal(
    isFixtureToken(
      fixtureToken(configuration, boundary + 1),
      configuration,
      now
    ),
    true
  );
});
