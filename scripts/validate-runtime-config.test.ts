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
const VALID_ENV: Partial<NodeJS.ProcessEnv> = {
  ABUSE_KEY_SECRET: "subprocess-test-abuse-key-secret",
  APP_ORIGIN: "https://app.example",
  AUTH_URL: "https://app.example",
  CRON_SECRET: "subprocess-test-reconcile-secret",
  DAYTONA_API_KEY: "subprocess-test-daytona-api-key",
  DAYTONA_API_URL: "https://app.daytona.io/api",
  DAYTONA_AUTO_ARCHIVE_MINUTES: "10080",
  DAYTONA_AUTO_STOP_MINUTES: "15",
  DAYTONA_DOMAIN_ALLOW_LIST: "github.com,api.github.com",
  DAYTONA_SNAPSHOT: "coven-agents-copilot-1",
  DAYTONA_TARGET: "us",
  OPERATOR_DIAGNOSTIC_TOKEN: "subprocess-test-operator-token",
  REDIS_URL: "redis://localhost:6379",
  RUN_ADMISSION_CONSECUTIVE_MAX: "2",
  RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX: "25",
  RUN_ADMISSION_MODE: "queue",
  RUN_ADMISSION_TENANT_ACTIVE_MAX: "2",
  RUN_ADMISSION_TENANT_QUEUE_MAX: "10",
  RUNNER_MANUAL_RECONCILE_SECRET: "subprocess-test-manual-reconcile-secret",
};
const REQUIRED_PRODUCTION_VARIABLES = [
  "ABUSE_KEY_SECRET",
  "APP_ORIGIN",
  "CRON_SECRET",
  "DAYTONA_API_KEY",
  "DAYTONA_DOMAIN_ALLOW_LIST",
  "DAYTONA_SNAPSHOT",
  "OPERATOR_DIAGNOSTIC_TOKEN",
  "REDIS_URL",
  "RUNNER_MANUAL_RECONCILE_SECRET",
] as const;
const DAYTONA_NON_NEGATIVE_SAFE_INTEGER_VARIABLES = [
  "DAYTONA_AUTO_ARCHIVE_MINUTES",
  "DAYTONA_AUTO_STOP_MINUTES",
] as const;
const ADMISSION_LIMIT_MAXIMUMS = {
  RUN_ADMISSION_CONSECUTIVE_MAX: "2",
  RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX: "25",
  RUN_ADMISSION_TENANT_ACTIVE_MAX: "2",
  RUN_ADMISSION_TENANT_QUEUE_MAX: "10",
} as const;

function assertRejectedWithMessage(
  result: ReturnType<typeof runValidator>,
  message: string
) {
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr.trim(), message);
}

function runValidator(
  overrides: Partial<
    Pick<
      NodeJS.ProcessEnv,
      | "ABUSE_KEY_SECRET"
      | "APP_ORIGIN"
      | "AUTH_URL"
      | "BETA_ALLOWLIST"
      | "BETA_MODE"
      | "CREDENTIAL_KEK"
      | "CREDENTIAL_KEK_CURRENT_VERSION"
      | "CREDENTIAL_KEK_V1"
      | "CREDENTIAL_KEK_V2"
      | "CRON_SECRET"
      | "DAYTONA_API_KEY"
      | "DAYTONA_API_URL"
      | "DAYTONA_AUTO_ARCHIVE_MINUTES"
      | "DAYTONA_AUTO_STOP_MINUTES"
      | "DAYTONA_DOMAIN_ALLOW_LIST"
      | "DAYTONA_REQUEST_TIMEOUT_MS"
      | "DAYTONA_SNAPSHOT"
      | "DAYTONA_TARGET"
      | "GLOBAL_DAILY_RUN_CAP"
      | "NODE_ENV"
      | "AGENT_CONTROL_TOKEN"
      | "OPERATOR_DIAGNOSTIC_TOKEN"
      | "REDIS_URL"
      | "RELEASE_AUDIENCE"
      | "RUNNER_MANUAL_RECONCILE_SECRET"
      | "RUNNER_SERVICE_TOKEN"
      | "RUN_ADMISSION_CONSECUTIVE_MAX"
      | "RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX"
      | "RUN_ADMISSION_MODE"
      | "RUN_ADMISSION_TENANT_ACTIVE_MAX"
      | "RUN_ADMISSION_TENANT_QUEUE_MAX"
      | "VERCEL_ENV"
    >
  > = {},
  arguments_: string[] = [],
  cwd = repositoryRoot
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ABUSE_KEY_SECRET: undefined,
    AGENT_CONTROL_TOKEN: undefined,
    APP_ORIGIN: undefined,
    AUTH_URL: undefined,
    BETA_ALLOWLIST: undefined,
    BETA_MODE: "off",
    CREDENTIAL_KEK: undefined,
    CREDENTIAL_KEK_CURRENT_VERSION: undefined,
    CREDENTIAL_KEK_V1: undefined,
    CREDENTIAL_KEK_V2: undefined,
    CRON_SECRET: undefined,
    DAYTONA_API_KEY: undefined,
    DAYTONA_API_URL: undefined,
    DAYTONA_AUTO_ARCHIVE_MINUTES: undefined,
    DAYTONA_AUTO_STOP_MINUTES: undefined,
    DAYTONA_DOMAIN_ALLOW_LIST: undefined,
    DAYTONA_REQUEST_TIMEOUT_MS: undefined,
    DAYTONA_SNAPSHOT: undefined,
    DAYTONA_TARGET: undefined,
    GLOBAL_DAILY_RUN_CAP: undefined,
    NEXT_PUBLIC_CLOUD_RUNNER_URL: undefined,
    NODE_ENV: "production",
    OPERATOR_DIAGNOSTIC_TOKEN: undefined,
    REDIS_URL: undefined,
    RELEASE_AUDIENCE: "public",
    RUN_ADMISSION_CONSECUTIVE_MAX: undefined,
    RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX: undefined,
    RUN_ADMISSION_MODE: undefined,
    RUN_ADMISSION_TENANT_ACTIVE_MAX: undefined,
    RUN_ADMISSION_TENANT_QUEUE_MAX: undefined,
    RUNNER_MANUAL_RECONCILE_SECRET: undefined,
    RUNNER_SERVICE_TOKEN: undefined,
    RUNNER_SIGNING_KEY: undefined,
    RUNNER_SIGNING_KEY_ID: undefined,
    RUNNER_SIGNING_PUBLIC_KEY: undefined,
    VERCEL_ENV: undefined,
    ...VALID_ENV,
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

test("rejects missing required production configuration", () => {
  for (const variableName of REQUIRED_PRODUCTION_VARIABLES) {
    const result = runValidator({ [variableName]: undefined });

    assertRejectedWithMessage(
      result,
      `Missing required production environment variables: ${variableName}.`
    );
  }
});

test("rejects blank required production configuration", () => {
  for (const variableName of REQUIRED_PRODUCTION_VARIABLES) {
    for (const blankValue of ["", "  "]) {
      const result = runValidator({ [variableName]: blankValue });

      assertRejectedWithMessage(
        result,
        `Missing required production environment variables: ${variableName}.`
      );
    }
  }
});

test("rejects unsafe or unapproved production application origins", () => {
  for (const overrides of [
    {
      APP_ORIGIN: "http://app.example",
      AUTH_URL: "http://app.example",
    },
    {
      APP_ORIGIN: "https://sibling.example",
      AUTH_URL: "https://app.example",
    },
    {
      APP_ORIGIN: "https://app.example/path",
      AUTH_URL: "https://app.example",
    },
  ]) {
    const result = runValidator(overrides);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /APP_ORIGIN|application authority|https/u);
  }
});

test("rejects aliases among privileged runner secrets", () => {
  const aliases = [
    ["CRON_SECRET", "OPERATOR_DIAGNOSTIC_TOKEN"],
    ["CRON_SECRET", "AGENT_CONTROL_TOKEN"],
    ["CRON_SECRET", "RUNNER_MANUAL_RECONCILE_SECRET"],
    ["CRON_SECRET", "RUNNER_SERVICE_TOKEN"],
    ["OPERATOR_DIAGNOSTIC_TOKEN", "AGENT_CONTROL_TOKEN"],
    ["OPERATOR_DIAGNOSTIC_TOKEN", "RUNNER_MANUAL_RECONCILE_SECRET"],
    ["OPERATOR_DIAGNOSTIC_TOKEN", "RUNNER_SERVICE_TOKEN"],
    ["AGENT_CONTROL_TOKEN", "RUNNER_MANUAL_RECONCILE_SECRET"],
    ["AGENT_CONTROL_TOKEN", "RUNNER_SERVICE_TOKEN"],
    ["RUNNER_MANUAL_RECONCILE_SECRET", "RUNNER_SERVICE_TOKEN"],
  ] as const;

  for (const [left, right] of aliases) {
    const result = runValidator({
      [left]: "shared-privileged-secret",
      [right]: "shared-privileged-secret",
    });

    assertRejectedWithMessage(
      result,
      `Privileged runner secrets must be distinct: ${left} aliases ${right}.`
    );
  }
});

test("rejects blank or oversized configured privileged runner secrets", () => {
  for (const [name, value] of [
    ["AGENT_CONTROL_TOKEN", "  "],
    ["RUNNER_SERVICE_TOKEN", ""],
    ["RUNNER_MANUAL_RECONCILE_SECRET", "x".repeat(1025)],
  ] as const) {
    const result = runValidator({ [name]: value });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(name));
  }
});

test("rejects production Redis when the abuse key secret is missing or empty", () => {
  for (const abuseKeySecret of [undefined, ""]) {
    const result = runValidator({ ABUSE_KEY_SECRET: abuseKeySecret });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ABUSE_KEY_SECRET/);
  }
});

test("accepts production without browser runner provisioning or signing config", () => {
  const result = runValidator();

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}`,
    new RegExp(VALID_ENV.ABUSE_KEY_SECRET ?? "")
  );
});

test("rejects configured run reservations without a nonempty abuse key secret", () => {
  for (const abuseKeySecret of [undefined, "", "  "]) {
    const result = runValidator({
      ABUSE_KEY_SECRET: abuseKeySecret,
      GLOBAL_DAILY_RUN_CAP: "500",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ABUSE_KEY_SECRET/);
  }
});

test("rejects a malformed global daily run cap", () => {
  const result = runValidator({ GLOBAL_DAILY_RUN_CAP: "not-a-number" });

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /GLOBAL_DAILY_RUN_CAP must be a positive integer/
  );
});

test("rejects a production configuration without Redis", () => {
  const result = runValidator({ REDIS_URL: undefined });

  assertRejectedWithMessage(
    result,
    "Missing required production environment variables: REDIS_URL."
  );
});

test("permits preview validation without production Daytona secrets or Redis", () => {
  const result = runValidator({
    ABUSE_KEY_SECRET: undefined,
    CRON_SECRET: undefined,
    DAYTONA_API_KEY: undefined,
    DAYTONA_DOMAIN_ALLOW_LIST: undefined,
    DAYTONA_SNAPSHOT: undefined,
    NODE_ENV: "production",
    OPERATOR_DIAGNOSTIC_TOKEN: undefined,
    REDIS_URL: undefined,
    RELEASE_AUDIENCE: undefined,
    VERCEL_ENV: "preview",
  });

  assert.equal(result.status, 0, result.stderr);
});

test("accepts valid run reservation configuration without Redis in preview", () => {
  const result = runValidator({
    CRON_SECRET: undefined,
    DAYTONA_API_KEY: undefined,
    DAYTONA_DOMAIN_ALLOW_LIST: undefined,
    DAYTONA_SNAPSHOT: undefined,
    GLOBAL_DAILY_RUN_CAP: "500",
    NODE_ENV: "development",
    OPERATOR_DIAGNOSTIC_TOKEN: undefined,
    REDIS_URL: undefined,
    RELEASE_AUDIENCE: undefined,
  });

  assert.equal(result.status, 0, result.stderr);
});

test("rejects an invalid Daytona target", () => {
  const result = runValidator({ DAYTONA_TARGET: "moon" });

  assertRejectedWithMessage(result, 'DAYTONA_TARGET must be "us" or "eu".');
});

test("preflight defaults blank Daytona endpoint and target", () => {
  for (const blankValue of [undefined, "", "  "]) {
    const result = runValidator({
      DAYTONA_API_URL: blankValue,
      DAYTONA_TARGET: blankValue,
    });

    assert.equal(result.status, 0, result.stderr);
  }
});

test("rejects malformed explicitly configured Daytona settings in preview", () => {
  for (const overrides of [
    { DAYTONA_API_URL: "http://app.daytona.io/api" },
    { DAYTONA_DOMAIN_ALLOW_LIST: "https://github.com" },
    { DAYTONA_REQUEST_TIMEOUT_MS: "0" },
    { DAYTONA_SNAPSHOT: "not-versioned" },
    { DAYTONA_TARGET: "moon" },
  ]) {
    const result = runValidator({
      ABUSE_KEY_SECRET: undefined,
      CRON_SECRET: undefined,
      DAYTONA_API_KEY: undefined,
      DAYTONA_DOMAIN_ALLOW_LIST: undefined,
      DAYTONA_SNAPSHOT: undefined,
      NODE_ENV: "development",
      OPERATOR_DIAGNOSTIC_TOKEN: undefined,
      REDIS_URL: undefined,
      RELEASE_AUDIENCE: undefined,
      ...overrides,
    });

    assert.notEqual(result.status, 0);
  }
});

test("defaults RUN_ADMISSION_MODE to queue when omitted", () => {
  const result = runValidator({ RUN_ADMISSION_MODE: undefined });

  assert.equal(result.status, 0, result.stderr);
});

test("defaults RUN_ADMISSION_MODE to queue when blank", () => {
  for (const blankValue of ["", "  "]) {
    const result = runValidator({ RUN_ADMISSION_MODE: blankValue });

    assert.equal(result.status, 0, result.stderr);
  }
});

test('accepts RUN_ADMISSION_MODE set to "queue" after trimming', () => {
  const result = runValidator({ RUN_ADMISSION_MODE: " queue " });

  assert.equal(result.status, 0, result.stderr);
});

test("rejects invalid RUN_ADMISSION_MODE values", () => {
  for (const invalidValue of ["reject", "bypass"]) {
    const result = runValidator({ RUN_ADMISSION_MODE: invalidValue });

    assertRejectedWithMessage(
      result,
      'RUN_ADMISSION_MODE must be "queue" when set.'
    );
  }
});

test("accepts zero-valued runtime and admission settings", () => {
  const result = runValidator({
    DAYTONA_AUTO_ARCHIVE_MINUTES: "0",
    DAYTONA_AUTO_STOP_MINUTES: "0",
    RUN_ADMISSION_CONSECUTIVE_MAX: "0",
    RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX: "0",
    RUN_ADMISSION_TENANT_ACTIVE_MAX: "0",
    RUN_ADMISSION_TENANT_QUEUE_MAX: "0",
  });

  assert.equal(result.status, 0, result.stderr);
});

test("rejects invalid Daytona interval settings", () => {
  const invalidValues = ["-1", "1.5", "9007199254740992"] as const;

  for (const variableName of DAYTONA_NON_NEGATIVE_SAFE_INTEGER_VARIABLES) {
    for (const invalidValue of invalidValues) {
      const result = runValidator({ [variableName]: invalidValue });

      assertRejectedWithMessage(
        result,
        `${variableName} must be a non-negative safe integer.`
      );
    }
  }
});

test("rejects missing, malformed, and unsafe production Daytona egress settings", () => {
  for (const invalidValue of [
    undefined,
    "",
    "  ",
    "github.com,",
    "https://github.com",
    "github.com/path",
    "github.com:443",
    "github.com,\napi.github.com",
  ]) {
    const result = runValidator({ DAYTONA_DOMAIN_ALLOW_LIST: invalidValue });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DAYTONA_DOMAIN_ALLOW_LIST/u);
  }
});

test("validates Daytona request timeout through the shared client parser", () => {
  const defaulted = runValidator({ DAYTONA_REQUEST_TIMEOUT_MS: undefined });
  assert.equal(defaulted.status, 0, defaulted.stderr);

  for (const invalidValue of ["0", "-1", "1.5", "9007199254740992", "120001"]) {
    const result = runValidator({ DAYTONA_REQUEST_TIMEOUT_MS: invalidValue });
    assertRejectedWithMessage(
      result,
      "DAYTONA_REQUEST_TIMEOUT_MS must be an integer between 1000 and 120000."
    );
  }
  assert.equal(runValidator({ DAYTONA_REQUEST_TIMEOUT_MS: "1000" }).status, 0);
});

test("rejects invalid admission limit settings", () => {
  const invalidValues = ["-1", "1.5", "9007199254740992"] as const;

  for (const [variableName, maximum] of Object.entries(
    ADMISSION_LIMIT_MAXIMUMS
  )) {
    for (const invalidValue of invalidValues) {
      const result = runValidator({ [variableName]: invalidValue });

      assertRejectedWithMessage(
        result,
        `${variableName} must be a non-negative safe integer no greater than ${maximum}.`
      );
    }
  }
});

test("rejects admission limits above their hard maxima", () => {
  const aboveMaximums = {
    RUN_ADMISSION_CONSECUTIVE_MAX: "3",
    RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX: "26",
    RUN_ADMISSION_TENANT_ACTIVE_MAX: "3",
    RUN_ADMISSION_TENANT_QUEUE_MAX: "11",
  } as const;

  for (const [variableName, invalidValue] of Object.entries(aboveMaximums)) {
    const result = runValidator({ [variableName]: invalidValue });

    assertRejectedWithMessage(
      result,
      `${variableName} must be a non-negative safe integer no greater than ${
        ADMISSION_LIMIT_MAXIMUMS[
          variableName as keyof typeof ADMISSION_LIMIT_MAXIMUMS
        ]
      }.`
    );
  }
});

test("accepts default runtime integer settings when omitted", () => {
  const result = runValidator({
    DAYTONA_AUTO_ARCHIVE_MINUTES: undefined,
    DAYTONA_AUTO_STOP_MINUTES: undefined,
    RUN_ADMISSION_CONSECUTIVE_MAX: undefined,
    RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX: undefined,
    RUN_ADMISSION_TENANT_ACTIVE_MAX: undefined,
    RUN_ADMISSION_TENANT_QUEUE_MAX: undefined,
  });

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
