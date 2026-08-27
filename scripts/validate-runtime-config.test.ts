import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const validatorPath = fileURLToPath(
  new URL("./validate-runtime-config.ts", import.meta.url)
);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function runValidator(
  overrides: Partial<
    Pick<
      NodeJS.ProcessEnv,
      | "ABUSE_KEY_SECRET"
      | "BETA_ALLOWLIST"
      | "BETA_MODE"
      | "GLOBAL_DAILY_RUN_CAP"
      | "NODE_ENV"
      | "REDIS_URL"
      | "RELEASE_AUDIENCE"
      | "VERCEL_ENV"
    >
  > = {},
  arguments_: string[] = []
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ABUSE_KEY_SECRET: undefined,
    BETA_ALLOWLIST: undefined,
    BETA_MODE: "off",
    GLOBAL_DAILY_RUN_CAP: undefined,
    NODE_ENV: "production",
    REDIS_URL: undefined,
    RELEASE_AUDIENCE: "public",
    VERCEL_ENV: undefined,
  };
  Object.assign(env, overrides);

  return spawnSync(
    process.execPath,
    ["--import", "tsx", validatorPath, ...arguments_],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env,
    }
  );
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

test("requires an exact release audience in production", () => {
  for (const releaseAudience of [
    undefined,
    "",
    "Public",
    "public ",
    "closed-beta,public",
    "closed_beta",
  ]) {
    const result = runValidator({ RELEASE_AUDIENCE: releaseAudience });

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /RELEASE_AUDIENCE must be exactly "closed-beta" or "public"/
    );
  }
});

test("closed beta requires beta mode on", () => {
  for (const betaMode of [undefined, "", "off", "ON", "on "]) {
    const result = runValidator({
      BETA_ALLOWLIST: "member@example.com",
      BETA_MODE: betaMode,
      RELEASE_AUDIENCE: "closed-beta",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Closed beta requires BETA_MODE=on/);
  }
});

test("closed beta requires a nonempty valid allowlist", () => {
  for (const betaAllowlist of [
    undefined,
    "",
    " ",
    ",",
    "member@example.com,",
    "not-an-email",
    "member@example.com,not-an-email",
  ]) {
    const result = runValidator({
      BETA_ALLOWLIST: betaAllowlist,
      BETA_MODE: "on",
      RELEASE_AUDIENCE: "closed-beta",
    });

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Closed beta requires BETA_ALLOWLIST to contain only valid email addresses/
    );
  }
});

test("accepts an explicit closed beta audience", () => {
  const result = runValidator({
    BETA_ALLOWLIST: " Member@Example.com , other@example.com ",
    BETA_MODE: "on",
    RELEASE_AUDIENCE: "closed-beta",
  });

  assert.equal(result.status, 0, result.stderr);
});

test("public release requires beta mode explicitly off", () => {
  for (const betaMode of [undefined, "", "on", "OFF", "off "]) {
    const result = runValidator({
      BETA_MODE: betaMode,
      RELEASE_AUDIENCE: "public",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Public release requires BETA_MODE=off/);
  }
});

test("release audience is not required for local or preview validation", () => {
  for (const environment of [
    { NODE_ENV: "development", VERCEL_ENV: undefined },
    { NODE_ENV: "test", VERCEL_ENV: undefined },
    { NODE_ENV: "production", VERCEL_ENV: "preview" },
  ] as const) {
    const result = runValidator({
      ...environment,
      BETA_MODE: undefined,
      RELEASE_AUDIENCE: undefined,
    });

    assert.equal(result.status, 0, result.stderr);
  }
});

test("Vercel production enforces release audience regardless of NODE_ENV", () => {
  const result = runValidator({
    BETA_MODE: undefined,
    NODE_ENV: "development",
    RELEASE_AUDIENCE: undefined,
    VERCEL_ENV: "production",
  });

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /RELEASE_AUDIENCE must be exactly "closed-beta" or "public"/
  );
});

test("the explicit release preflight enforces outside production markers", () => {
  const result = runValidator(
    {
      BETA_MODE: undefined,
      NODE_ENV: "development",
      RELEASE_AUDIENCE: undefined,
      VERCEL_ENV: "preview",
    },
    ["--release"]
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /RELEASE_AUDIENCE must be exactly "closed-beta" or "public"/
  );
});

test("the start command uses the explicit release preflight", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  ) as { scripts?: Record<string, string> };

  assert.equal(
    manifest.scripts?.["validate:release"],
    "tsx scripts/validate-runtime-config.ts --release"
  );
  assert.match(manifest.scripts?.start ?? "", /^pnpm validate:release && /);
});
