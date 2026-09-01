import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  githubAppConfig,
  githubTeamsEnabled,
  validateGitHubEnvironment,
} from "./config";

const PRIMARY_SIGNER_PEM = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
}).privateKey;
const LEGACY_SIGNER_PEM = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { format: "pem", type: "pkcs1" },
  publicKeyEncoding: { format: "pem", type: "spki" },
}).privateKey;

const VALID_ENVIRONMENT: NodeJS.ProcessEnv = {
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY: PRIMARY_SIGNER_PEM,
  GITHUB_APP_SLUG: "opencoven-delivery",
  GITHUB_STATE_SIGNING_SECRET:
    "0123456789abcdefghijklmnopqrstuvwxyz-STATE-SIGNING",
  GITHUB_TEAMS_ENABLED: "on",
  NODE_ENV: "test",
};

test("GitHub teams accepts only exact enabled and disabled flag values", () => {
  for (const value of [undefined, "", "  ", "off"]) {
    assert.equal(githubTeamsEnabled({ GITHUB_TEAMS_ENABLED: value }), false);
  }
  assert.equal(githubTeamsEnabled({ GITHUB_TEAMS_ENABLED: "on" }), true);

  for (const value of ["true", "1", "ON", "on ", "disabled"]) {
    assert.throws(
      () => githubTeamsEnabled({ GITHUB_TEAMS_ENABLED: value }),
      new Error(
        'GITHUB_TEAMS_ENABLED must be exactly "on" or "off" when configured.'
      )
    );
  }
});

test("disabled GitHub teams does not require app credentials", () => {
  for (const value of [undefined, "", "  ", "off"]) {
    assert.deepEqual(
      validateGitHubEnvironment({ GITHUB_TEAMS_ENABLED: value }),
      { enabled: false }
    );
  }
});

test("enabled GitHub teams names every missing or blank variable", () => {
  for (const name of [
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_SLUG",
    "GITHUB_STATE_SIGNING_SECRET",
  ] as const) {
    for (const value of [undefined, "", "  "]) {
      assert.throws(
        () =>
          validateGitHubEnvironment({
            ...VALID_ENVIRONMENT,
            [name]: value,
          }),
        new RegExp(name, "u")
      );
    }
  }
});

test("enabled GitHub teams rejects malformed identifiers, keys, and weak state secrets", () => {
  for (const [name, value] of [
    ["GITHUB_APP_ID", "0"],
    ["GITHUB_APP_ID", "01"],
    ["GITHUB_APP_ID", "12.3"],
    ["GITHUB_APP_ID", "1".repeat(21)],
    ["GITHUB_APP_SLUG", "OpenCoven"],
    ["GITHUB_APP_SLUG", "-opencoven"],
    ["GITHUB_APP_SLUG", "opencoven_teams"],
    ["GITHUB_APP_PRIVATE_KEY", "not-a-private-key"],
    [
      "GITHUB_APP_PRIVATE_KEY",
      generateKeyPairSync("ec", {
        namedCurve: "P-256",
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      }).privateKey,
    ],
    ["GITHUB_STATE_SIGNING_SECRET", "short"],
    ["GITHUB_STATE_SIGNING_SECRET", "a".repeat(64)],
  ] as const) {
    assert.throws(
      () =>
        validateGitHubEnvironment({
          ...VALID_ENVIRONMENT,
          [name]: value,
        }),
      new RegExp(name, "u"),
      `${name}=${String(value).slice(0, 20)}`
    );
  }
});

test("GitHub state signing authority is distinct from other configured server secrets", () => {
  const shared = "0123456789abcdefghijklmnopqrstuvwxyz-SHARED-STATE-AUTHORITY";
  for (const name of [
    "AUTH_SECRET",
    "ABUSE_KEY_SECRET",
    "CRON_SECRET",
    "OPERATOR_DIAGNOSTIC_TOKEN",
    "RUNNER_MANUAL_RECONCILE_SECRET",
  ] as const) {
    assert.throws(
      () =>
        validateGitHubEnvironment({
          ...VALID_ENVIRONMENT,
          GITHUB_STATE_SIGNING_SECRET: shared,
          [name]: shared,
        }),
      /GITHUB_STATE_SIGNING_SECRET.*distinct/u
    );
  }
});

test("valid GitHub app configuration exposes only non-secret metadata when serialized", () => {
  const config = githubAppConfig(VALID_ENVIRONMENT);

  assert.equal(config.enabled, true);
  assert.equal(config.appId, "123456");
  assert.equal(config.appSlug, "opencoven-delivery");
  assert.equal(config.privateKey.asymmetricKeyType, "rsa");
  assert.equal(config.stateSigningKey.type, "secret");

  const serialized = JSON.stringify(config);
  assert.doesNotMatch(serialized, /BEGIN .*PRIVATE KEY/u);
  assert.doesNotMatch(serialized, /STATE-SIGNING/u);
});

test("GitHub app configuration accepts PKCS#8 and PKCS#1 RSA PEM encodings", () => {
  for (const privateKey of [PRIMARY_SIGNER_PEM, LEGACY_SIGNER_PEM]) {
    assert.equal(
      githubAppConfig({
        ...VALID_ENVIRONMENT,
        GITHUB_APP_PRIVATE_KEY: privateKey,
      }).privateKey.asymmetricKeyType,
      "rsa"
    );
  }
});
