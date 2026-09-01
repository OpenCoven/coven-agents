import assert from "node:assert/strict";
import test from "node:test";
import { HERMETIC_TENANTS, HERMETIC_USERS } from "../tests/e2e/hermetic-db";
import {
  DOCKER_COMMAND_TIMEOUT_MS,
  dockerRunArguments,
  hermeticEnvironment,
  mappedPort,
} from "./e2e-hermetic";

test("hermetic Docker command names and publishes only its exact disposable container", () => {
  assert.deepEqual(dockerRunArguments("coven-hermetic-e2e-42"), [
    "run",
    "--detach",
    "--name",
    "coven-hermetic-e2e-42",
    "--env",
    "POSTGRES_DB=coven_hermetic_e2e",
    "--env",
    "POSTGRES_PASSWORD=test-hermetic-postgres",
    "--env",
    "POSTGRES_USER=postgres",
    "--publish",
    "127.0.0.1::5432",
    "postgres:16-alpine",
  ]);
  assert.equal(mappedPort("127.0.0.1:54321\n"), 54_321);
  assert.throws(
    () => mappedPort("not a port"),
    /usable mapped PostgreSQL port/u
  );
});

test("hermetic runner environment explicitly blanks external configuration", async () => {
  const example = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../.env.example", import.meta.url), "utf8")
  );
  const exampleNames = [...example.matchAll(/^([A-Z][A-Z0-9_]+)=/gmu)].map(
    ([, name]) => name
  );
  const poisoned = Object.fromEntries(
    exampleNames.map((name) => [name, `must-not-reach-${name}`])
  );
  const environment = hermeticEnvironment("postgres://example.invalid/e2e", {
    ...poisoned,
    AI_GATEWAY_API_KEY: "must-not-reach-provider",
    AUTH_GITHUB_ID: "must-not-reach-oauth",
    AUTH_GITHUB_SECRET: "must-not-reach-oauth",
    BLOB_READ_WRITE_TOKEN: "must-not-reach-storage",
    CREDENTIAL_KEK: "must-not-reach-legacy-kek",
    CREDENTIAL_KEK_V2: "must-not-reach-current-kek",
    DAYTONA_API_KEY: "must-not-reach-fake",
    DAYTONA_SNAPSHOT: "coven-agents-copilot-1",
    DAYTONA_UNDOCUMENTED_SETTING: "must-not-reach-fake",
    E2E_PRODUCTION: "1",
    NODE_ENV: "production",
    OPENAI_API_KEY: "must-not-reach-provider",
    REDIS_URL: "redis://must-not-reach",
    STRIPE_SECRET_KEY: "must-not-reach-billing",
    STRIPE_WEBHOOK_SECRET: "must-not-reach-billing",
  });
  assert.equal(environment.COVEN_HERMETIC_RUNNER, "1");
  assert.equal(environment.E2E_HERMETIC_RUNNER, "1");
  assert.equal(environment.PORT, "3100");
  assert.equal(environment.NODE_ENV, "development");
  assert.equal(environment.DAYTONA_API_KEY, "");
  assert.equal(environment.DAYTONA_SNAPSHOT, "");
  assert.equal(environment.DAYTONA_UNDOCUMENTED_SETTING, "");
  assert.equal(environment.E2E_PRODUCTION, "");
  assert.equal(environment.REDIS_URL, "");
  assert.equal(environment.AUTH_GITHUB_ID, "");
  assert.equal(environment.AUTH_GITHUB_SECRET, "");
  assert.equal(environment.STRIPE_SECRET_KEY, "");
  assert.equal(environment.STRIPE_WEBHOOK_SECRET, "");
  assert.equal(environment.BLOB_READ_WRITE_TOKEN, "");
  assert.equal(environment.AI_GATEWAY_API_KEY, "");
  assert.equal(environment.OPENAI_API_KEY, "");
  assert.equal(environment.CREDENTIAL_KEK, "");
  assert.equal(environment.CREDENTIAL_KEK_V2, "");
  assert.equal(environment.CREDENTIAL_KEK_V1?.length, 43);
  assert.equal(environment.CREDENTIAL_KEK_CURRENT_VERSION, "v1");
  assert.equal(environment.POSTGRES_URL, "postgres://example.invalid/e2e");
  for (const name of exampleNames) {
    assert.equal(
      typeof environment[name],
      "string",
      `${name} must survive child environment construction`
    );
    assert.notEqual(
      environment[name],
      poisoned[name],
      `${name} must not retain inherited external configuration`
    );
  }
});

test("Docker operations use a short bounded timeout", () => {
  assert.equal(DOCKER_COMMAND_TIMEOUT_MS, 10_000);
});

test("hermetic seed accounts are fixed non-personal subscriber and denial identities", () => {
  assert.deepEqual(
    Object.values(HERMETIC_USERS).map((account) => account.authVersion),
    [13, 7, 11]
  );
  assert.equal(HERMETIC_USERS.ineligible.subscribedUntil, null);
  assert.equal(
    HERMETIC_USERS.subscriberA.subscribedUntil,
    "2099-01-01T00:00:00.000Z"
  );
  assert.equal(HERMETIC_TENANTS.length, 3);
  assert.equal(new Set(HERMETIC_TENANTS).size, 3);
});

test("database certification helper source does not select or read credential ciphertext", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../tests/e2e/hermetic-db.ts", import.meta.url), "utf8")
  );
  assert.match(source, /"executionProvenance"->>'provider'/u);
  assert.match(source, /row_to_json\("application_row"\)/u);
  assert.doesNotMatch(source, /SELECT\s+"ciphertext"/u);
  assert.doesNotMatch(source, /SELECT\s+\*/u);
});
