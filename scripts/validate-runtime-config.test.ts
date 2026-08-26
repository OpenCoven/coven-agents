import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const validatorPath = fileURLToPath(
  new URL("./validate-runtime-config.ts", import.meta.url)
);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function runValidator(
  overrides: Partial<Pick<NodeJS.ProcessEnv, "ABUSE_KEY_SECRET" | "REDIS_URL">>
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ABUSE_KEY_SECRET: undefined,
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

test("accepts production without Redis", () => {
  const result = runValidator({});

  assert.equal(result.status, 0, result.stderr);
});
