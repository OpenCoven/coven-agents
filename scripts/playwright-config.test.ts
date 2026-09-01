import assert from "node:assert/strict";
import test from "node:test";
import {
  loadPlaywrightLocalEnvironment,
  playwrightWebServerEnvironment,
} from "../playwright.config";

test("hermetic Playwright config skips .env.local and retains explicit blank values", () => {
  let loads = 0;
  const environment = {
    E2E_HERMETIC_RUNNER: "1",
    REDIS_URL: "",
    STRIPE_SECRET_KEY: "",
  };
  assert.equal(
    loadPlaywrightLocalEnvironment(environment, () => {
      loads += 1;
      return {} as never;
    }),
    false
  );
  assert.equal(loads, 0);
  assert.deepEqual(playwrightWebServerEnvironment(environment), {
    ...environment,
    ADMIN_EMAILS: "e2e-admin@example.invalid",
  });
});

test("normal Playwright config still loads .env.local", () => {
  let received: unknown;
  assert.equal(
    loadPlaywrightLocalEnvironment({}, (options) => {
      received = options;
      return {} as never;
    }),
    true
  );
  assert.deepEqual(received, { path: ".env.local" });
});
