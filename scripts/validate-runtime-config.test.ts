import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
      | "BETA_ALLOWLIST"
      | "BETA_MODE"
      | "CREDENTIAL_KEK"
      | "CREDENTIAL_KEK_CURRENT_VERSION"
      | "CREDENTIAL_KEK_V1"
      | "CREDENTIAL_KEK_V2"
      | "GLOBAL_DAILY_RUN_CAP"
      | "NODE_ENV"
      | "REDIS_URL"
      | "RELEASE_AUDIENCE"
      | "VERCEL_ENV"
    >
  > = {},
  arguments_: string[] = [],
  cwd = repositoryRoot
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ABUSE_KEY_SECRET: undefined,
    BETA_ALLOWLIST: undefined,
    BETA_MODE: "off",
    CREDENTIAL_KEK: undefined,
    CREDENTIAL_KEK_CURRENT_VERSION: undefined,
    CREDENTIAL_KEK_V1: undefined,
    CREDENTIAL_KEK_V2: undefined,
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
      cwd,
      encoding: "utf8",
      env,
    }
  );
}

function runReleaseValidatorFromFiles(
  files: Record<string, string>,
  overrides: Partial<NodeJS.ProcessEnv> = {}
) {
  const cwd = mkdtempSync(
    join(repositoryRoot, ".validate-runtime-config-test-")
  );

  try {
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(cwd, name), contents);
    }

    return runValidator(
      {
        BETA_ALLOWLIST: undefined,
        BETA_MODE: undefined,
        RELEASE_AUDIENCE: undefined,
        ...overrides,
      },
      ["--release"],
      cwd
    );
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
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

test(".env.production.local takes precedence over .env.local", () => {
  const result = runReleaseValidatorFromFiles({
    ".env.local": "RELEASE_AUDIENCE=public\nBETA_MODE=on\n",
    ".env.production.local": "RELEASE_AUDIENCE=public\nBETA_MODE=off\n",
  });

  assert.equal(result.status, 0, result.stderr);
});

test("process environment takes precedence over production env files", () => {
  const result = runReleaseValidatorFromFiles(
    {
      ".env.local":
        "RELEASE_AUDIENCE=public\nBETA_MODE=off\nBETA_ALLOWLIST=member@example.com\n",
      ".env.production.local":
        "RELEASE_AUDIENCE=public\nBETA_MODE=on\nBETA_ALLOWLIST=not-an-email\n",
    },
    { RELEASE_AUDIENCE: "closed-beta" }
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Closed beta requires BETA_ALLOWLIST to contain only valid email addresses/
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
