import assert from "node:assert/strict";
import test from "node:test";
import { HERMETIC_TENANTS, HERMETIC_USERS } from "../tests/e2e/hermetic-db";
import {
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

test("hermetic runner environment is fixed, guarded, and strips Daytona configuration", () => {
  const environment = hermeticEnvironment("postgres://example.invalid/e2e", {
    DAYTONA_API_KEY: "must-not-reach-fake",
    DAYTONA_SNAPSHOT: "coven-agents-copilot-1",
    NODE_ENV: "production",
  });
  assert.equal(environment.COVEN_HERMETIC_RUNNER, "1");
  assert.equal(environment.E2E_HERMETIC_RUNNER, "1");
  assert.equal(environment.PORT, "3100");
  assert.equal(environment.NODE_ENV, "development");
  assert.equal(environment.DAYTONA_API_KEY, undefined);
  assert.equal(environment.DAYTONA_SNAPSHOT, undefined);
  assert.equal(environment.POSTGRES_URL, "postgres://example.invalid/e2e");
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
