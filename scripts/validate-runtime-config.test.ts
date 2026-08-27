import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const validatorPath = fileURLToPath(
  new URL("./validate-runtime-config.ts", import.meta.url)
);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const TEST_KEK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function runValidator(
  overrides: Partial<
    Pick<
      NodeJS.ProcessEnv,
      | "ABUSE_KEY_SECRET"
      | "CREDENTIAL_KEK"
      | "CREDENTIAL_KEK_CURRENT_VERSION"
      | "CREDENTIAL_KEK_V1"
      | "CREDENTIAL_KEK_V2"
      | "GLOBAL_DAILY_RUN_CAP"
      | "REDIS_URL"
    >
  >
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ABUSE_KEY_SECRET: undefined,
    CREDENTIAL_KEK: TEST_KEK,
    CREDENTIAL_KEK_CURRENT_VERSION: "v1",
    CREDENTIAL_KEK_V1: undefined,
    CREDENTIAL_KEK_V2: undefined,
    GLOBAL_DAILY_RUN_CAP: undefined,
    NODE_ENV: "production",
    REDIS_URL: undefined,
  };
  Object.assign(env, overrides);

  return spawnSync(process.execPath, ["--import", "tsx", validatorPath], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env,
  });
}

test("rejects production Redis when the abuse key secret is missing or empty", () => {
  for (const abuseKeySecret of [undefined, ""]) {
    const result = runValidator({
      ABUSE_KEY_SECRET: abuseKeySecret,
      REDIS_URL: "redis://localhost:6379",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ABUSE_KEY_SECRET is required/);
  }
});

test("accepts production Redis when the abuse key secret is valid", () => {
  const secret = "subprocess-test-abuse-key-secret";
  const result = runValidator({
    ABUSE_KEY_SECRET: secret,
    REDIS_URL: "redis://localhost:6379",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret));
});

test("rejects configured run reservations without a nonempty abuse key secret", () => {
  for (const abuseKeySecret of [undefined, "", "  "]) {
    const result = runValidator({
      ABUSE_KEY_SECRET: abuseKeySecret,
      GLOBAL_DAILY_RUN_CAP: "500",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ABUSE_KEY_SECRET is required/);
  }
});

test("rejects a malformed global daily run cap", () => {
  const result = runValidator({
    ABUSE_KEY_SECRET: "subprocess-test-abuse-key-secret",
    GLOBAL_DAILY_RUN_CAP: "not-a-number",
  });

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /GLOBAL_DAILY_RUN_CAP must be a positive integer/
  );
});

test("accepts valid run reservation configuration without Redis", () => {
  const result = runValidator({
    ABUSE_KEY_SECRET: "subprocess-test-abuse-key-secret",
    GLOBAL_DAILY_RUN_CAP: "500",
  });

  assert.equal(result.status, 0, result.stderr);
});

test("accepts production without Redis", () => {
  const result = runValidator({});

  assert.equal(result.status, 0, result.stderr);
});

test("rejects missing or conflicting credential KEK configuration", () => {
  const missingCurrent = runValidator({
    CREDENTIAL_KEK_CURRENT_VERSION: undefined,
  });
  assert.notEqual(missingCurrent.status, 0);
  assert.match(missingCurrent.stderr, /CREDENTIAL_KEK_CURRENT_VERSION/);

  const conflicting = runValidator({
    CREDENTIAL_KEK: TEST_KEK,
    CREDENTIAL_KEK_CURRENT_VERSION: "v1",
    CREDENTIAL_KEK_V1: `${TEST_KEK}different`,
  });
  assert.notEqual(conflicting.status, 0);
  assert.match(conflicting.stderr, /conflict|ambiguous/i);
});
