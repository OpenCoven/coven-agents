import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const validatorPath = fileURLToPath(
  new URL("./validate-runtime-config.ts", import.meta.url)
);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const TEST_KEK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const VALID_ENV: Partial<NodeJS.ProcessEnv> = {
  ABUSE_KEY_SECRET: "subprocess-test-abuse-key-secret",
  DAYTONA_API_KEY: "subprocess-test-daytona-api-key",
  DAYTONA_API_URL: "https://app.daytona.io/api",
  DAYTONA_AUTO_ARCHIVE_MINUTES: "10080",
  DAYTONA_AUTO_STOP_MINUTES: "15",
  DAYTONA_SNAPSHOT: "coven-agents-copilot-1",
  DAYTONA_TARGET: "us",
  OPERATOR_DIAGNOSTIC_TOKEN: "subprocess-test-operator-token",
  REDIS_URL: "redis://localhost:6379",
  RUN_ADMISSION_CONSECUTIVE_MAX: "2",
  RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX: "25",
  RUN_ADMISSION_MODE: "queue",
  RUN_ADMISSION_TENANT_ACTIVE_MAX: "2",
  RUN_ADMISSION_TENANT_QUEUE_MAX: "10",
  RUNNER_RECONCILE_SECRET: "subprocess-test-reconcile-secret",
};
const REQUIRED_PRODUCTION_VARIABLES = [
  "ABUSE_KEY_SECRET",
  "DAYTONA_API_KEY",
  "DAYTONA_SNAPSHOT",
  "OPERATOR_DIAGNOSTIC_TOKEN",
  "REDIS_URL",
  "RUNNER_RECONCILE_SECRET",
] as const;
const REQUIRED_POSITIVE_INTEGER_VARIABLES = [
  "DAYTONA_AUTO_ARCHIVE_MINUTES",
  "DAYTONA_AUTO_STOP_MINUTES",
  "RUN_ADMISSION_CONSECUTIVE_MAX",
  "RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX",
  "RUN_ADMISSION_TENANT_ACTIVE_MAX",
  "RUN_ADMISSION_TENANT_QUEUE_MAX",
] as const;

function runValidator(
  overrides: Partial<
    Pick<
      NodeJS.ProcessEnv,
      | "ABUSE_KEY_SECRET"
      | "CREDENTIAL_KEK"
      | "CREDENTIAL_KEK_CURRENT_VERSION"
      | "CREDENTIAL_KEK_V1"
      | "CREDENTIAL_KEK_V2"
      | "DAYTONA_API_KEY"
      | "DAYTONA_API_URL"
      | "DAYTONA_AUTO_ARCHIVE_MINUTES"
      | "DAYTONA_AUTO_STOP_MINUTES"
      | "DAYTONA_DOMAIN_ALLOW_LIST"
      | "DAYTONA_SNAPSHOT"
      | "DAYTONA_TARGET"
      | "GLOBAL_DAILY_RUN_CAP"
      | "OPERATOR_DIAGNOSTIC_TOKEN"
      | "REDIS_URL"
      | "RUNNER_RECONCILE_SECRET"
      | "RUN_ADMISSION_CONSECUTIVE_MAX"
      | "RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX"
      | "RUN_ADMISSION_MODE"
      | "RUN_ADMISSION_TENANT_ACTIVE_MAX"
      | "RUN_ADMISSION_TENANT_QUEUE_MAX"
    >
  >
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ABUSE_KEY_SECRET: undefined,
    CREDENTIAL_KEK: undefined,
    CREDENTIAL_KEK_CURRENT_VERSION: undefined,
    CREDENTIAL_KEK_V1: undefined,
    CREDENTIAL_KEK_V2: undefined,
    DAYTONA_API_KEY: undefined,
    DAYTONA_API_URL: undefined,
    DAYTONA_AUTO_ARCHIVE_MINUTES: undefined,
    DAYTONA_AUTO_STOP_MINUTES: undefined,
    DAYTONA_DOMAIN_ALLOW_LIST: undefined,
    DAYTONA_SNAPSHOT: undefined,
    DAYTONA_TARGET: undefined,
    GLOBAL_DAILY_RUN_CAP: undefined,
    NODE_ENV: "production",
    OPERATOR_DIAGNOSTIC_TOKEN: undefined,
    REDIS_URL: undefined,
    RUN_ADMISSION_CONSECUTIVE_MAX: undefined,
    RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX: undefined,
    RUN_ADMISSION_MODE: undefined,
    RUN_ADMISSION_TENANT_ACTIVE_MAX: undefined,
    RUN_ADMISSION_TENANT_QUEUE_MAX: undefined,
    RUNNER_RECONCILE_SECRET: undefined,
    ...VALID_ENV,
  };
  Object.assign(env, overrides);

  return spawnSync(process.execPath, ["--import", "tsx", validatorPath], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env,
  });
}

test("rejects missing required production configuration", () => {
  for (const variableName of REQUIRED_PRODUCTION_VARIABLES) {
    const result = runValidator({ [variableName]: undefined });

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      new RegExp(
        `Missing required production environment variables: ${variableName}`
      )
    );
  }
});

test("rejects blank required production configuration", () => {
  for (const variableName of REQUIRED_PRODUCTION_VARIABLES) {
    for (const blankValue of ["", "  "]) {
      const result = runValidator({ [variableName]: blankValue });

      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        new RegExp(
          `Missing required production environment variables: ${variableName}`
        )
      );
    }
  }
});

test("rejects an invalid Daytona target", () => {
  const result = runValidator({ DAYTONA_TARGET: "moon" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DAYTONA_TARGET must be "us" or "eu"\./);
});

test("rejects malformed positive integer runtime settings", () => {
  for (const variableName of REQUIRED_POSITIVE_INTEGER_VARIABLES) {
    const result = runValidator({ [variableName]: "0" });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      new RegExp(`${variableName} must be a positive integer\\.`)
    );
  }
});

test("accepts a production build with no credential KEK variables", () => {
  const result = runValidator({
    CREDENTIAL_KEK: undefined,
    CREDENTIAL_KEK_CURRENT_VERSION: undefined,
    CREDENTIAL_KEK_V1: undefined,
    CREDENTIAL_KEK_V2: undefined,
  });

  assert.equal(result.status, 0, result.stderr);
});

test("rejects partial credential KEK configuration", () => {
  const missingCurrent = runValidator({
    CREDENTIAL_KEK_CURRENT_VERSION: undefined,
    CREDENTIAL_KEK_V1: TEST_KEK,
  });
  assert.notEqual(missingCurrent.status, 0);
  assert.match(missingCurrent.stderr, /CREDENTIAL_KEK_CURRENT_VERSION/);

  const missingKey = runValidator({
    CREDENTIAL_KEK: undefined,
    CREDENTIAL_KEK_CURRENT_VERSION: "v1",
    CREDENTIAL_KEK_V1: undefined,
  });
  assert.notEqual(missingKey.status, 0);
  assert.match(missingKey.stderr, /CREDENTIAL_KEK_V1/);
});

test("accepts valid credential KEK configuration", () => {
  const result = runValidator({
    CREDENTIAL_KEK: TEST_KEK,
    CREDENTIAL_KEK_CURRENT_VERSION: "v1",
  });

  assert.equal(result.status, 0, result.stderr);
});

test("rejects conflicting credential KEK configuration", () => {
  const conflicting = runValidator({
    CREDENTIAL_KEK: TEST_KEK,
    CREDENTIAL_KEK_CURRENT_VERSION: "v1",
    CREDENTIAL_KEK_V1: `${TEST_KEK}different`,
  });
  assert.notEqual(conflicting.status, 0);
  assert.match(conflicting.stderr, /conflict|ambiguous/i);
});

test("rejects a malformed global daily run cap", () => {
  const result = runValidator({
    GLOBAL_DAILY_RUN_CAP: "not-a-number",
  });

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /GLOBAL_DAILY_RUN_CAP must be a positive integer/
  );
});

test("accepts a valid production configuration without printing secrets", () => {
  const result = runValidator({
    DAYTONA_DOMAIN_ALLOW_LIST: "github.com,api.github.com",
    GLOBAL_DAILY_RUN_CAP: "500",
  });

  assert.equal(result.status, 0, result.stderr);
  for (const secret of [
    VALID_ENV.ABUSE_KEY_SECRET,
    VALID_ENV.DAYTONA_API_KEY,
    VALID_ENV.OPERATOR_DIAGNOSTIC_TOKEN,
    VALID_ENV.RUNNER_RECONCILE_SECRET,
  ]) {
    assert.doesNotMatch(
      `${result.stdout}${result.stderr}`,
      new RegExp(secret ?? "")
    );
  }
});
