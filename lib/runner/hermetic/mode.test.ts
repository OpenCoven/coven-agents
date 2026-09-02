import assert from "node:assert/strict";
import test from "node:test";
import {
  HERMETIC_RUNNER_E2E_FLAG,
  HERMETIC_RUNNER_FLAG,
  hermeticRunnerMode,
} from "./mode";

test("hermetic runner defaults to Daytona without a server environment selection", () => {
  assert.equal(hermeticRunnerMode({ NODE_ENV: "development" }), "daytona");
});

test("hermetic runner requires both exact E2E flags outside production", () => {
  assert.equal(
    hermeticRunnerMode({
      [HERMETIC_RUNNER_E2E_FLAG]: "1",
      [HERMETIC_RUNNER_FLAG]: "1",
      NODE_ENV: "test",
    }),
    "hermetic"
  );
  assert.throws(
    () =>
      hermeticRunnerMode({
        [HERMETIC_RUNNER_FLAG]: "1",
        NODE_ENV: "development",
      }),
    new RegExp(HERMETIC_RUNNER_E2E_FLAG)
  );
  assert.throws(
    () =>
      hermeticRunnerMode({
        [HERMETIC_RUNNER_E2E_FLAG]: "1",
        [HERMETIC_RUNNER_FLAG]: "true",
        NODE_ENV: "development",
      }),
    new RegExp(HERMETIC_RUNNER_FLAG)
  );
  assert.throws(
    () =>
      hermeticRunnerMode({
        [HERMETIC_RUNNER_FLAG]: "",
        NODE_ENV: "development",
      }),
    new RegExp(HERMETIC_RUNNER_FLAG)
  );
});

test("hermetic runner fails closed in production", () => {
  assert.throws(
    () =>
      hermeticRunnerMode({
        [HERMETIC_RUNNER_E2E_FLAG]: "1",
        [HERMETIC_RUNNER_FLAG]: "1",
        NODE_ENV: "production",
      }),
    /unavailable when NODE_ENV is production/u
  );
});
