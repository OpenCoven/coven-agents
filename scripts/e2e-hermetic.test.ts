import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import { HARNESS_SPECS } from "@opencoven/harness";
import { HERMETIC_TENANTS, HERMETIC_USERS } from "../tests/e2e/hermetic-db";
import {
  allocateHermeticPort,
  DOCKER_COMMAND_TIMEOUT_MS,
  dockerRunArguments,
  explicitHermeticPort,
  hermeticDatabaseUrl,
  hermeticEnvironment,
  mappedPort,
  PORT_ALLOCATION_TIMEOUT_MS,
  waitForPlaywrightExit,
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
  const harnessAuthNames = [
    ...new Set(HARNESS_SPECS.flatMap((spec) => spec.authEnvVars)),
  ];
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
    ...Object.fromEntries(
      harnessAuthNames.map((name) => [name, `must-not-reach-${name}`])
    ),
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
  assert.ok(harnessAuthNames.includes("COPILOT_GITHUB_TOKEN"));
  assert.ok(harnessAuthNames.includes("GH_TOKEN"));
  assert.ok(harnessAuthNames.includes("CODEX_API_KEY"));
  assert.ok(harnessAuthNames.includes("CLAUDE_CODE_OAUTH_TOKEN"));
  for (const name of harnessAuthNames) {
    assert.equal(
      environment[name],
      "",
      `${name} must not retain an inherited harness credential`
    );
  }
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

test("hermetic port override is strictly validated", () => {
  assert.equal(explicitHermeticPort({}), undefined);
  assert.equal(explicitHermeticPort({ E2E_HERMETIC_PORT: "43123" }), 43_123);
  for (const value of ["", "0", "65536", "-1", "3100.5", " 3100"]) {
    assert.throws(
      () => explicitHermeticPort({ E2E_HERMETIC_PORT: value }),
      /E2E_HERMETIC_PORT/u
    );
  }
});

test("hermetic port allocation is bounded and configures one localhost origin", async () => {
  assert.equal(PORT_ALLOCATION_TIMEOUT_MS, 5000);
  const port = await allocateHermeticPort();
  assert.ok(port >= 1 && port <= 65_535);
  const environment = hermeticEnvironment(
    "postgres://example.invalid/e2e",
    {},
    port
  );
  const origin = `http://localhost:${port}`;
  assert.equal(environment.PORT, String(port));
  assert.equal(environment.APP_ORIGIN, origin);
  assert.equal(environment.AUTH_URL, origin);
  assert.equal(environment.NEXTAUTH_URL, origin);
});

test("hermetic automatic port allocation checks both loopback families", async (t) => {
  const port = await allocateHermeticPort();
  const ipv4 = createServer();
  const ipv6 = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      ipv4.once("error", reject);
      ipv4.listen({ host: "127.0.0.1", port }, resolve);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        ipv6.once("error", reject);
        ipv6.listen({ host: "::1", ipv6Only: true, port }, resolve);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EAFNOSUPPORT") {
        t.skip("IPv6 loopback is unsupported on this host");
        return;
      }
      throw error;
    }
  } finally {
    await Promise.all(
      [ipv4, ipv6].map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (
                (error as NodeJS.ErrnoException | undefined)?.code ===
                "ERR_SERVER_NOT_RUNNING"
              ) {
                resolve();
                return;
              }
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          })
      )
    );
  }
});

test("Playwright failure close surfaces output after Playwright can tear down its web server", async () => {
  const child = new EventEmitter();
  const completion = waitForPlaywrightExit(
    "tests/e2e/subscriber-hermetic.test.ts",
    child
  );
  child.emit("close", 2, null);
  await assert.rejects(completion, /exit code 2.*output is shown above/u);

  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("./e2e-hermetic.ts", import.meta.url), "utf8")
  );
  assert.match(source, /stdio: "inherit"/u);
  assert.match(source, /detached: false/u);
  assert.match(source, /child\.once\("close",/u);
  assert.match(source, /if \(!childExited\) \{\s*child\.kill\(signal\)/u);
  assert.match(source, /process\.on\("SIGINT", forwardSignal\)/u);
  assert.match(source, /process\.on\("SIGTERM", forwardSignal\)/u);
  assert.match(source, /process\.off\("SIGINT", forwardSignal\)/u);
  assert.match(source, /process\.off\("SIGTERM", forwardSignal\)/u);
  assert.doesNotMatch(source, /process\.kill\(/u);
  assert.doesNotMatch(source, /Promise\.race\(\[\s*completion/u);
});

test("hermetic port override rejects a foreign IPv4 loopback listener", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await assert.rejects(
      () =>
        allocateHermeticPort({
          E2E_HERMETIC_PORT: String(address.port),
        }),
      /is unavailable/u
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("hermetic port override rejects a foreign IPv6 loopback listener", async (t) => {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "::1", ipv6Only: true, port: 0 }, resolve);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EAFNOSUPPORT") {
      t.skip("IPv6 loopback is unsupported on this host");
      return;
    }
    throw error;
  }
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await assert.rejects(
      () =>
        allocateHermeticPort({
          E2E_HERMETIC_PORT: String(address.port),
        }),
      /is unavailable on ::1/u
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("Docker operations use a short bounded timeout", () => {
  assert.equal(DOCKER_COMMAND_TIMEOUT_MS, 10_000);
});

test("disposable database URLs force the public schema and UTC", () => {
  const configured = new URL(
    hermeticDatabaseUrl(
      "postgres://postgres@example.invalid/e2e?application_name=hermetic&options=-c%20ignored%3D1&options=-c%20search_path%3Dother%20-c%20statement_timeout%3D5000"
    )
  );
  assert.equal(configured.searchParams.get("application_name"), "hermetic");
  assert.equal(
    configured.searchParams.get("options"),
    "-c search_path=other -c statement_timeout=5000 -c search_path=public -c timezone=UTC"
  );
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
  assert.equal(
    source.match(/SELECT "id"::text FROM "RunnerRun"/gu)?.length,
    2,
    "varchar reservation run IDs must compare against UUID run IDs as text"
  );
  assert.match(source, /"executionProvenance"->>'provider'/u);
  assert.match(source, /row_to_json\("application_row"\)/u);
  assert.doesNotMatch(source, /SELECT\s+"ciphertext"/u);
  assert.doesNotMatch(source, /SELECT\s+\*/u);
});

test("adversarial probes run only after the immutable demo replay fingerprint", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("./e2e-hermetic.ts", import.meta.url), "utf8")
  );
  const replay = source.indexOf('await playwright("tests/e2e/demo.test.ts",');
  const replayFingerprint = source.indexOf("const afterDemo", replay);
  const replayInvariant = source.indexOf(
    "JSON.stringify(beforeDemo) !== JSON.stringify(afterDemo)",
    replayFingerprint
  );
  const adversarial = source.indexOf(
    'await playwright("tests/e2e/demo-adversarial.test.ts",',
    replayInvariant
  );
  const adversarialFingerprint = source.indexOf(
    "const afterAdversarial",
    adversarial
  );
  const adversarialInvariant = source.indexOf(
    "JSON.stringify(beforeAdversarial) !== JSON.stringify(afterAdversarial)",
    adversarialFingerprint
  );

  assert.ok(replay >= 0);
  assert.ok(replayFingerprint > replay);
  assert.ok(replayInvariant > replayFingerprint);
  assert.ok(adversarial > replayInvariant);
  assert.ok(adversarialFingerprint > adversarial);
  assert.ok(adversarialInvariant > adversarialFingerprint);
  assert.match(
    source,
    /Anonymous adversarial demo probes wrote to the hermetic database\./u
  );
});

test("session revocation runs after subscriber fixtures are reseeded and before demo fingerprints", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("./e2e-hermetic.ts", import.meta.url), "utf8")
  );
  const subscriber = source.indexOf('"tests/e2e/subscriber-hermetic.test.ts"');
  const reseed = source.indexOf("await seedHermeticUsers(url)", subscriber);
  const revocation = source.indexOf(
    '"tests/e2e/session-revocation-hermetic.test.ts"'
  );
  const demoFingerprint = source.indexOf("const beforeDemo");
  assert.ok(subscriber >= 0);
  assert.ok(
    reseed > subscriber,
    "subscriber mutations must not leak into auth fixtures"
  );
  assert.ok(revocation > reseed);
  assert.ok(demoFingerprint > revocation);
});

test("base-path recovery runs outside both anonymous inventory assertions", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("./e2e-hermetic.ts", import.meta.url), "utf8")
  );
  const replayInvariant = source.indexOf(
    "JSON.stringify(beforeDemo) !== JSON.stringify(afterDemo)"
  );
  const recovery = source.indexOf(
    '"tests/e2e/session-revocation-hermetic.test.ts"',
    replayInvariant
  );
  const adversarialFingerprint = source.indexOf("const beforeAdversarial");
  assert.ok(recovery > replayInvariant);
  assert.ok(recovery < adversarialFingerprint);
  assert.match(
    source.slice(recovery, adversarialFingerprint),
    /IS_DEMO:\s*"1"/u
  );
});
