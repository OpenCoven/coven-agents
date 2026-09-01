import assert from "node:assert/strict";
import test from "node:test";
import {
  loadPlaywrightLocalEnvironment,
  playwrightSettings,
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

test("hermetic Playwright config uses one IPv4 origin and a bounded suite timeout", () => {
  assert.deepEqual(
    playwrightSettings({
      E2E_HERMETIC_RUNNER: "1",
      IS_DEMO: "1",
      PORT: "43123",
    }),
    {
      baseURL: "http://127.0.0.1:43123",
      globalTimeout: 120_000,
      webServerCommand:
        "exec node node_modules/next/dist/bin/next dev --turbo --hostname 127.0.0.1 --port 43123",
      webServerURL: "http://127.0.0.1:43123/demo/ping",
    }
  );
});

test("normal Playwright config retains localhost defaults without a global timeout", () => {
  assert.deepEqual(playwrightSettings({}), {
    baseURL: "http://localhost:3100",
    globalTimeout: undefined,
    webServerCommand:
      "exec node node_modules/next/dist/bin/next dev --turbo --port 3100",
    webServerURL: "http://localhost:3100/ping",
  });
});
