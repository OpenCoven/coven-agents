import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readHarnessConfig } from "./config.mjs";

const sharedEnvironment = {
  AGENT_CONTROL_TOKEN: "non-default-control-token",
  RUNNER_AUTH_VERSION: "7",
  RUNNER_SERVICE_TOKEN: "non-default-service-token",
  RUNNER_URL: "http://127.0.0.1:9898/",
  RUNNER_VERIFY_KEY_ID: "key-rotated",
};

test("reads and normalizes the shared harness configuration", () => {
  assert.deepEqual(readHarnessConfig(sharedEnvironment), {
    authVersion: 7,
    controlToken: "non-default-control-token",
    keyId: "key-rotated",
    runnerUrl: "http://127.0.0.1:9898",
    serviceToken: "non-default-service-token",
  });
});

test("uses the local runner URL only when no URL is configured", () => {
  const { RUNNER_URL: _runnerUrl, ...withoutUrl } = sharedEnvironment;

  assert.equal(
    readHarnessConfig(withoutUrl).runnerUrl,
    "http://127.0.0.1:8788"
  );
});

for (const name of ["AGENT_CONTROL_TOKEN", "RUNNER_SERVICE_TOKEN"]) {
  test(`rejects a missing ${name} explicitly`, () => {
    const environment = { ...sharedEnvironment };
    delete environment[name];

    assert.throws(
      () => readHarnessConfig(environment),
      new RegExp(`${name}.*required`)
    );
  });
}

test("all standalone harness scripts use the shared configuration", () => {
  for (const script of ["mint.mjs", "stub-credential.mjs", "run.mjs"]) {
    const source = readFileSync(
      new URL(`./${script}`, import.meta.url),
      "utf8"
    );
    assert.match(source, /readHarnessConfig/);
  }
});

test("the harness package scripts load worker/.dev.vars explicitly", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  );

  for (const script of ["harness:mint", "harness:stub", "harness:run"]) {
    assert.match(
      packageJson.scripts[script],
      /--env-file-if-exists=\.dev\.vars/
    );
  }
});
