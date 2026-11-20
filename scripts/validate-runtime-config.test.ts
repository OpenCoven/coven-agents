import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const validatorPath = fileURLToPath(
  new URL("./validate-runtime-config.ts", import.meta.url)
);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const TEST_KEK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TEST_GITHUB_SIGNER_PEM = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
}).privateKey;
const TEST_GITHUB_CLIENT_VALUE = `github-app-client-${"0123456789abcdef".repeat(
  3
)}`;
const VALID_ENV: Partial<NodeJS.ProcessEnv> = {
  ABUSE_KEY_SECRET: "subprocess-test-abuse-key-secret",
  APP_ORIGIN: "https://app.example",
  AUTH_URL: "https://app.example",
  CRON_SECRET: "subprocess-test-reconcile-secret",
  DAYTONA_API_KEY: "subprocess-test-daytona-api-key",
  DAYTONA_API_URL: "https://app.daytona.io/api",
  DAYTONA_AUTO_ARCHIVE_MINUTES: "10080",
  DAYTONA_AUTO_STOP_MINUTES: "15",
  DAYTONA_DOMAIN_ALLOW_LIST: "github.com,api.github.com,app.example",
  DAYTONA_SANDBOX_CPU_CORES: "2",
  DAYTONA_SANDBOX_DISK_GIB: "10",
  DAYTONA_SANDBOX_MEMORY_GIB: "4",
  DAYTONA_SNAPSHOT: "coven-agents-copilot-1",
  DAYTONA_TARGET: "us",
  GLOBAL_DAILY_RUN_CAP: "500",
  OPERATOR_DIAGNOSTIC_TOKEN: "subprocess-test-operator-token",
  REDIS_URL: "redis://localhost:6379",
  RUN_ADMISSION_CONSECUTIVE_MAX: "2",
  RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX: "25",
  RUN_ADMISSION_MODE: "queue",
  RUN_ADMISSION_TENANT_ACTIVE_MAX: "2",
  RUN_ADMISSION_TENANT_QUEUE_MAX: "10",
  RUNNER_MANUAL_RECONCILE_SECRET: "subprocess-test-manual-reconcile-secret",
};
const VALID_STRIPE_ENV: Partial<NodeJS.ProcessEnv> = {
  STRIPE_PRICE_ID: "price_test",
  STRIPE_SECRET_KEY: "sk_test",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
  SUBSCRIPTION_CHECKOUT_ENABLED: "on",
};
const VALID_GITHUB_ENV: Partial<NodeJS.ProcessEnv> = {
  GITHUB_APP_CLIENT_ID: "Iv1.0123456789abcdef",
  GITHUB_APP_CLIENT_SECRET: TEST_GITHUB_CLIENT_VALUE,
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY: TEST_GITHUB_SIGNER_PEM,
  GITHUB_APP_SLUG: "opencoven-delivery",
  GITHUB_STATE_SIGNING_SECRET:
    "0123456789abcdefghijklmnopqrstuvwxyz-STATE-SIGNING",
  GITHUB_TEAMS_ENABLED: "on",
};
const NON_PRODUCTION_RUNTIME_MODES = [
  {
    NODE_ENV: "development",
    RELEASE_AUDIENCE: undefined,
    VERCEL_ENV: undefined,
  },
  {
    NODE_ENV: "production",
    RELEASE_AUDIENCE: undefined,
    VERCEL_ENV: "preview",
  },
] satisfies Partial<NodeJS.ProcessEnv>[];
const REQUIRED_PRODUCTION_VARIABLES = [
  "ABUSE_KEY_SECRET",
  "APP_ORIGIN",
  "CRON_SECRET",
  "DAYTONA_API_KEY",
  "DAYTONA_DOMAIN_ALLOW_LIST",
  "DAYTONA_SNAPSHOT",
  "GLOBAL_DAILY_RUN_CAP",
  "OPERATOR_DIAGNOSTIC_TOKEN",
  "REDIS_URL",
  "RUNNER_MANUAL_RECONCILE_SECRET",
] as const;
const DAYTONA_RESOURCE_POLICY_VARIABLES = [
  "DAYTONA_AUTO_ARCHIVE_MINUTES",
  "DAYTONA_AUTO_STOP_MINUTES",
  "DAYTONA_SANDBOX_CPU_CORES",
  "DAYTONA_SANDBOX_DISK_GIB",
  "DAYTONA_SANDBOX_MEMORY_GIB",
] as const;
const ADMISSION_LIMIT_MAXIMUMS = {
  RUN_ADMISSION_CONSECUTIVE_MAX: "2",
  RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX: "25",
  RUN_ADMISSION_TENANT_ACTIVE_MAX: "2",
  RUN_ADMISSION_TENANT_QUEUE_MAX: "10",
} as const;
const RUNTIME_CONFIGURATION_KEYS = [
  "ABUSE_KEY_SECRET",
  "APP_ORIGIN",
  "AUTH_GITHUB_ID",
  "AUTH_GITHUB_SECRET",
  "AUTH_SECRET",
  "WORKOS_AUTH_ENABLED",
  "WORKOS_CLIENT_ID",
  "WORKOS_API_KEY",
  "AUTH_URL",
  "BETA_ALLOWLIST",
  "BETA_MODE",
  "CREDENTIAL_KEK",
  "CREDENTIAL_KEK_CURRENT_VERSION",
  "CREDENTIAL_KEK_V1",
  "CREDENTIAL_KEK_V2",
  "COVEN_HERMETIC_RUNNER",
  "CRON_SECRET",
  "DAYTONA_API_KEY",
  "DAYTONA_API_URL",
  "DAYTONA_AUTO_ARCHIVE_MINUTES",
  "DAYTONA_AUTO_STOP_MINUTES",
  "DAYTONA_DOMAIN_ALLOW_LIST",
  "DAYTONA_REQUEST_TIMEOUT_MS",
  "DAYTONA_SANDBOX_CPU_CORES",
  "DAYTONA_SANDBOX_DISK_GIB",
  "DAYTONA_SANDBOX_MEMORY_GIB",
  "DAYTONA_SNAPSHOT",
  "DAYTONA_TARGET",
  "E2E_HERMETIC_RUNNER",
  "GLOBAL_DAILY_RUN_CAP",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_SLUG",
  "GITHUB_STATE_SIGNING_SECRET",
  "GITHUB_TEAMS_ENABLED",
  "NEXTAUTH_URL",
  "NODE_ENV",
  "OPERATOR_DIAGNOSTIC_TOKEN",
  "REDIS_URL",
  "RELEASE_AUDIENCE",
  "RUN_ADMISSION_CONSECUTIVE_MAX",
  "RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX",
  "RUN_ADMISSION_MODE",
  "RUN_ADMISSION_TENANT_ACTIVE_MAX",
  "RUN_ADMISSION_TENANT_QUEUE_MAX",
  "RUNNER_MANUAL_RECONCILE_SECRET",
  "STRIPE_PRICE_ID",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "SUBSCRIPTION_CHECKOUT_ENABLED",
  "VERCEL_ENV",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "VERCEL_URL",
  "WORKOS_CLIENT_ID",
  "WORKOS_API_KEY",
] as const;

function assertRejectedWithMessage(
  result: ReturnType<typeof runValidator>,
  message: string
) {
  assert.notEqual(result.status, 0);
  assert.equal(
    result.stderr.trim(),
    message,
    JSON.stringify({
      error: result.error?.message,
      signal: result.signal,
      status: result.status,
    })
  );
}

function emptyEnvironmentDirectory(): string {
  return mkdtempSync(join(repositoryRoot, ".validate-runtime-config-test-"));
}

/**
 * Release validation calls `loadEnvConfig(process.cwd())`, which reads the
 * `.env` files of whatever directory it runs in. Running it at the repository
 * root would let a contributor's untracked `.env.local` overwrite the keys
 * this harness deliberately clears, so a release run without an explicit
 * working directory gets an empty one and is decided by `env` alone.
 */
function runValidator(
  overrides: Partial<NodeJS.ProcessEnv> = {},
  arguments_: string[] = [],
  cwd?: string
) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...Object.fromEntries(
      RUNTIME_CONFIGURATION_KEYS.map((name) => [name, undefined])
    ),
    BETA_MODE: "off",
    NODE_ENV: "production",
    RELEASE_AUDIENCE: "public",
    ...VALID_ENV,
  };
  Object.assign(env, overrides);

  const spawnIn = (directory: string) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", validatorPath, ...arguments_],
      {
        cwd: directory,
        encoding: "utf8",
        env,
      }
    );

  if (cwd !== undefined) {
    return spawnIn(cwd);
  }
  if (!arguments_.includes("--release")) {
    return spawnIn(repositoryRoot);
  }

  const isolated = emptyEnvironmentDirectory();
  try {
    return spawnIn(isolated);
  } finally {
    rmSync(isolated, { force: true, recursive: true });
  }
}

function runReleaseValidatorFromFiles(
  files: Record<string, string>,
  overrides: Partial<NodeJS.ProcessEnv> = {}
) {
  const cwd = emptyEnvironmentDirectory();

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

test("GitHub teams configuration is gated by an exact server-side flag", () => {
  for (const value of [undefined, "", "  ", "off"]) {
    const result = runValidator({ GITHUB_TEAMS_ENABLED: value });
    assert.equal(result.status, 0, result.stderr);
  }

  for (const value of ["true", "1", "ON", "on ", "disabled"]) {
    assertRejectedWithMessage(
      runValidator({ GITHUB_TEAMS_ENABLED: value }),
      'GITHUB_TEAMS_ENABLED must be exactly "on" or "off" when configured.'
    );
  }
});

test("enabled GitHub teams requires every app authority variable", () => {
  for (const name of [
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_CLIENT_SECRET",
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_SLUG",
    "GITHUB_STATE_SIGNING_SECRET",
  ] as const) {
    for (const value of [undefined, "", "  "]) {
      const result = runValidator({
        ...VALID_GITHUB_ENV,
        [name]: value,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(name, "u"));
    }
  }
});

test("enabled GitHub teams validates identifiers, RSA key material, and state entropy", () => {
  for (const overrides of [
    { GITHUB_APP_ID: "01" },
    { GITHUB_APP_CLIENT_ID: "not a client id" },
    { GITHUB_APP_CLIENT_SECRET: "weak" },
    { GITHUB_APP_SLUG: "OpenCoven_Delivery" },
    { GITHUB_APP_PRIVATE_KEY: "not-a-key" },
    { GITHUB_STATE_SIGNING_SECRET: "weak" },
  ]) {
    const result = runValidator({ ...VALID_GITHUB_ENV, ...overrides });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /GITHUB_APP_|GITHUB_STATE_SIGNING_SECRET/u);
    assert.doesNotMatch(result.stderr, /BEGIN .*PRIVATE KEY|STATE-SIGNING/u);
  }
});

test("GitHub state signing authority cannot alias another server secret", () => {
  const shared = "0123456789abcdefghijklmnopqrstuvwxyz-SHARED-STATE-AUTHORITY";
  for (const name of [
    "AI_GATEWAY_API_KEY",
    "AUTH_SECRET",
    "WORKOS_API_KEY",
    "AUTH_GITHUB_SECRET",
    "ABUSE_KEY_SECRET",
    "BLOB_READ_WRITE_TOKEN",
    "CREDENTIAL_KEK_V2",
    "CRON_SECRET",
    "DAYTONA_API_KEY",
    "DEMO_RECORDING_CREDENTIAL",
    "GITHUB_APP_CLIENT_SECRET",
    "OPERATOR_DIAGNOSTIC_TOKEN",
    "POSTGRES_URL",
    "REDIS_URL",
    "RUNNER_MANUAL_RECONCILE_SECRET",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
  ] as const) {
    const result = runValidator({
      ...VALID_GITHUB_ENV,
      GITHUB_STATE_SIGNING_SECRET: shared,
      [name]: name === "GITHUB_APP_CLIENT_SECRET" ? shared : `  ${shared}  `,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /GITHUB_STATE_SIGNING_SECRET|distinct/u);
    assert.doesNotMatch(result.stderr, /SHARED-STATE-AUTHORITY/u);
  }
});

test("valid enabled GitHub teams configuration passes runtime validation", () => {
  const result = runValidator(VALID_GITHUB_ENV);
  assert.equal(result.status, 0, result.stderr);
});

test("enabled GitHub teams requires APP_ORIGIN hostname in restrictive Daytona egress", () => {
  const rejected = runValidator({
    ...VALID_GITHUB_ENV,
    DAYTONA_DOMAIN_ALLOW_LIST: "github.com,api.github.com",
  });
  assertRejectedWithMessage(
    rejected,
    "DAYTONA_DOMAIN_ALLOW_LIST must include the APP_ORIGIN hostname when GitHub teams are enabled."
  );

  const accepted = runValidator({
    ...VALID_GITHUB_ENV,
    DAYTONA_DOMAIN_ALLOW_LIST: "github.com,api.github.com,app.example",
  });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.doesNotMatch(rejected.stderr, /https:\/\/|app\.example/u);
});

test("rejects the hermetic runner selection for a production validation", () => {
  const result = runValidator({
    COVEN_HERMETIC_RUNNER: "1",
    E2E_HERMETIC_RUNNER: "1",
  });
  assertRejectedWithMessage(
    result,
    "COVEN_HERMETIC_RUNNER is unavailable when NODE_ENV is production."
  );
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

test("production Vercel validation requires the project production authority", () => {
  const accepted = runValidator({
    APP_ORIGIN: "https://app.example",
    AUTH_URL: undefined,
    VERCEL_ENV: "production",
    VERCEL_PROJECT_PRODUCTION_URL: "app.example",
    VERCEL_URL: "generated-project.vercel.app",
  });
  assert.equal(accepted.status, 0, accepted.stderr);

  for (const overrides of [
    {
      APP_ORIGIN: "https://generated-project.vercel.app",
      AUTH_URL: undefined,
      VERCEL_ENV: "production",
      VERCEL_PROJECT_PRODUCTION_URL: "app.example",
      VERCEL_URL: "generated-project.vercel.app",
    },
    {
      APP_ORIGIN: "https://app.example",
      AUTH_URL: undefined,
      VERCEL_ENV: "production",
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      VERCEL_URL: "generated-project.vercel.app",
    },
    {
      APP_ORIGIN: "https://app.example:444",
      AUTH_URL: undefined,
      VERCEL_ENV: "production",
      VERCEL_PROJECT_PRODUCTION_URL: "app.example",
      VERCEL_URL: "generated-project.vercel.app",
    },
  ]) {
    const result = runValidator(overrides);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /APP_ORIGIN|application authority|production/u);
  }
});

test("preview Vercel validation uses the current deployment authority", () => {
  const accepted = runValidator({
    APP_ORIGIN: "https://project-git-feature-team.vercel.app",
    AUTH_URL: undefined,
    NODE_ENV: "production",
    VERCEL_ENV: "preview",
    VERCEL_PROJECT_PRODUCTION_URL: "app.example",
    VERCEL_URL: "project-git-feature-team.vercel.app",
  });
  assert.equal(accepted.status, 0, accepted.stderr);

  for (const overrides of [
    {
      APP_ORIGIN: "https://app.example",
      VERCEL_PROJECT_PRODUCTION_URL: "app.example",
      VERCEL_URL: "project-git-feature-team.vercel.app",
    },
    {
      APP_ORIGIN: "https://project-git-feature-team.vercel.app",
      VERCEL_PROJECT_PRODUCTION_URL: "app.example",
      VERCEL_URL: undefined,
    },
    {
      APP_ORIGIN: "https://project-git-feature-team.vercel.app:444",
      VERCEL_PROJECT_PRODUCTION_URL: "app.example",
      VERCEL_URL: "project-git-feature-team.vercel.app:444",
    },
  ]) {
    const rejected = runValidator({
      AUTH_URL: undefined,
      NEXTAUTH_URL: undefined,
      NODE_ENV: "production",
      VERCEL_ENV: "preview",
      ...overrides,
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /APP_ORIGIN|application authority|host/u);
  }
});

test("explicit Auth.js origin overrides Vercel environment authorities", () => {
  for (const override of [
    { AUTH_URL: "https://auth.example" },
    { NEXTAUTH_URL: "https://auth.example" },
  ]) {
    const result = runValidator({
      APP_ORIGIN: "https://auth.example",
      AUTH_URL: undefined,
      NEXTAUTH_URL: undefined,
      VERCEL_ENV: "production",
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      VERCEL_URL: "generated-project.vercel.app",
      ...override,
    });

    assert.equal(result.status, 0, result.stderr);
  }
});

test("rejects aliases among privileged runner secrets", () => {
  const aliases = [
    ["CRON_SECRET", "OPERATOR_DIAGNOSTIC_TOKEN"],
    ["CRON_SECRET", "RUNNER_MANUAL_RECONCILE_SECRET"],
    ["OPERATOR_DIAGNOSTIC_TOKEN", "RUNNER_MANUAL_RECONCILE_SECRET"],
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
    ["CRON_SECRET", "  "],
    ["OPERATOR_DIAGNOSTIC_TOKEN", ""],
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

test("accepts current production runner configuration", () => {
  const result = runValidator();

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}`,
    new RegExp(VALID_ENV.ABUSE_KEY_SECRET ?? "")
  );
});

test("unknown environment settings are ignored by the runtime validator", () => {
  const result = runValidator({
    UNRELATED_RUNTIME_SETTING: "not-part-of-the-runtime-contract",
  });

  assert.equal(result.status, 0, result.stderr);
});

test("disabled checkout validation accepts absent Stripe variables", () => {
  for (const checkoutFlag of [undefined, "", "  ", "off"]) {
    const result = runValidator({
      STRIPE_PRICE_ID: undefined,
      STRIPE_SECRET_KEY: undefined,
      STRIPE_WEBHOOK_SECRET: undefined,
      SUBSCRIPTION_CHECKOUT_ENABLED: checkoutFlag,
    });

    assert.equal(result.status, 0, result.stderr);
  }
});

test("enabled checkout validation accepts complete Stripe configuration", () => {
  for (const arguments_ of [[], ["--release"]]) {
    const result = runValidator(VALID_STRIPE_ENV, arguments_);

    assert.equal(result.status, 0, result.stderr);
  }
});

test("non-production runtime validation accepts enabled checkout with complete Stripe configuration", () => {
  for (const runtimeMode of NON_PRODUCTION_RUNTIME_MODES) {
    const result = runValidator({
      ...runtimeMode,
      ...VALID_STRIPE_ENV,
    });

    assert.equal(result.status, 0, result.stderr);
  }
});

test("enabled production and release validation names missing Stripe variables", () => {
  for (const arguments_ of [[], ["--release"]]) {
    const result = runValidator(
      {
        STRIPE_PRICE_ID: " ",
        STRIPE_SECRET_KEY: undefined,
        STRIPE_WEBHOOK_SECRET: "",
        SUBSCRIPTION_CHECKOUT_ENABLED: "on",
      },
      arguments_
    );

    assertRejectedWithMessage(
      result,
      "Subscription Checkout requires nonblank environment variables: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID."
    );
  }
});

test("non-production runtime validation names missing Stripe variables", () => {
  for (const runtimeMode of NON_PRODUCTION_RUNTIME_MODES) {
    const result = runValidator({
      ...runtimeMode,
      STRIPE_PRICE_ID: " ",
      STRIPE_SECRET_KEY: undefined,
      STRIPE_WEBHOOK_SECRET: "",
      SUBSCRIPTION_CHECKOUT_ENABLED: "on",
    });

    assertRejectedWithMessage(
      result,
      "Subscription Checkout requires nonblank environment variables: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID."
    );
  }
});

test("runtime validation rejects checkout flag typos", () => {
  for (const checkoutFlag of ["true", "1", "ON", "on ", "disabled"]) {
    const result = runValidator({
      SUBSCRIPTION_CHECKOUT_ENABLED: checkoutFlag,
    });

    assertRejectedWithMessage(
      result,
      'SUBSCRIPTION_CHECKOUT_ENABLED must be exactly "on" or "off" when configured.'
    );
  }
});

test("non-production runtime validation rejects checkout flag typos", () => {
  for (const runtimeMode of NON_PRODUCTION_RUNTIME_MODES) {
    for (const checkoutFlag of ["true", "ON", "1"]) {
      const result = runValidator({
        ...runtimeMode,
        SUBSCRIPTION_CHECKOUT_ENABLED: checkoutFlag,
      });

      assertRejectedWithMessage(
        result,
        'SUBSCRIPTION_CHECKOUT_ENABLED must be exactly "on" or "off" when configured.'
      );
    }
  }
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
    GLOBAL_DAILY_RUN_CAP: undefined,
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

test("resource policy rejects disabled automatic lifecycle settings", () => {
  const result = runValidator({
    DAYTONA_AUTO_ARCHIVE_MINUTES: "0",
    DAYTONA_AUTO_STOP_MINUTES: "0",
  });

  assertRejectedWithMessage(
    result,
    "DAYTONA_AUTO_ARCHIVE_MINUTES must be an integer between 60 and 43200."
  );
});

test("rejects malformed and over-cap Daytona resource policy settings", () => {
  const invalidValues = ["-1", "1.5", "9007199254740992"] as const;

  for (const variableName of DAYTONA_RESOURCE_POLICY_VARIABLES) {
    for (const invalidValue of invalidValues) {
      const result = runValidator({ [variableName]: invalidValue });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(variableName));
    }
  }

  for (const [variableName, invalidValue] of [
    ["DAYTONA_AUTO_ARCHIVE_MINUTES", "43201"],
    ["DAYTONA_AUTO_STOP_MINUTES", "61"],
    ["DAYTONA_SANDBOX_CPU_CORES", "5"],
    ["DAYTONA_SANDBOX_MEMORY_GIB", "9"],
    ["DAYTONA_SANDBOX_DISK_GIB", "11"],
  ] as const) {
    const result = runValidator({ [variableName]: invalidValue });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(variableName));
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
    DAYTONA_SANDBOX_CPU_CORES: undefined,
    DAYTONA_SANDBOX_DISK_GIB: undefined,
    DAYTONA_SANDBOX_MEMORY_GIB: undefined,
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

test("an env file in the working directory supplies keys the harness cleared", () => {
  const result = runReleaseValidatorFromFiles(
    {
      ".env.local":
        "RELEASE_AUDIENCE=public\nBETA_MODE=off\nGLOBAL_DAILY_RUN_CAP=not-a-number\n",
    },
    { GLOBAL_DAILY_RUN_CAP: undefined }
  );

  assertRejectedWithMessage(
    result,
    "GLOBAL_DAILY_RUN_CAP must be a positive integer."
  );
});

test("a blank run cap is missing configuration rather than a malformed value", () => {
  const result = runValidator({ GLOBAL_DAILY_RUN_CAP: "   " }, ["--release"]);

  assertRejectedWithMessage(
    result,
    "Missing required production environment variables: GLOBAL_DAILY_RUN_CAP."
  );
});

test("release validation is decided by the environment, not by repository env files", () => {
  const result = runValidator({}, ["--release"]);

  assert.equal(result.status, 0, result.stderr);
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

/**
 * Validation exists to predict what `register()` enforces at boot, and boot
 * reads NODE_ENV. These two pin both directions of that parity, because the
 * obvious alternative — reusing the production-release notion — is wrong: a
 * Vercel preview is not the approved production audience but still boots with
 * NODE_ENV=production, so it must be validated as production.
 */
test("a Vercel preview validates reservation settings, matching what it boots with", () => {
  const result = runValidator({
    GLOBAL_DAILY_RUN_CAP: "not-a-number",
    NODE_ENV: "production",
    RELEASE_AUDIENCE: undefined,
    VERCEL_ENV: "preview",
  });

  assertRejectedWithMessage(
    result,
    "GLOBAL_DAILY_RUN_CAP must be a positive integer."
  );
});

test("development does not enforce reservation settings the server would skip", () => {
  const result = runValidator({
    GLOBAL_DAILY_RUN_CAP: "not-a-number",
    NODE_ENV: "development",
    RELEASE_AUDIENCE: undefined,
    VERCEL_ENV: undefined,
  });

  assert.equal(result.status, 0, result.stderr);
});
