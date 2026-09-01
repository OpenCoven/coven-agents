import { defineConfig, devices } from "@playwright/test";

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
import { config } from "dotenv";

type PlaywrightEnvironment = Readonly<Record<string, string | undefined>>;
export const HERMETIC_PLAYWRIGHT_GLOBAL_TIMEOUT_MS = 120 * 1000;

export function loadPlaywrightLocalEnvironment(
  environment: PlaywrightEnvironment = process.env,
  load: typeof config = config
): boolean {
  if (environment.E2E_HERMETIC_RUNNER === "1") {
    return false;
  }
  load({ path: ".env.local" });
  return true;
}

export function playwrightWebServerEnvironment(
  environment: PlaywrightEnvironment = process.env
): Record<string, string> {
  const childEnvironment: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined) {
      childEnvironment[name] = value;
    }
  }
  childEnvironment.ADMIN_EMAILS =
    environment.ADMIN_EMAILS || "e2e-admin@example.invalid";
  return childEnvironment;
}

export function playwrightSettings(
  environment: PlaywrightEnvironment = process.env
) {
  const port = environment.PORT || "3100";
  const hermetic = environment.E2E_HERMETIC_RUNNER === "1";
  const host = hermetic ? "127.0.0.1" : "localhost";
  const baseURL = `http://${host}:${port}`;
  const basePath = environment.IS_DEMO === "1" ? "/demo" : "";
  const useProductionBuild = environment.E2E_PRODUCTION === "1";
  const nextCommand = "node node_modules/next/dist/bin/next";
  const hostname = hermetic ? ` --hostname ${host}` : "";

  return {
    baseURL,
    globalTimeout: hermetic ? HERMETIC_PLAYWRIGHT_GLOBAL_TIMEOUT_MS : undefined,
    webServerCommand: useProductionBuild
      ? `pnpm validate:runtime && exec ${nextCommand} start${hostname} --port ${port}`
      : `exec ${nextCommand} dev --turbo${hostname} --port ${port}`,
    webServerURL: `${baseURL}${basePath}/ping`,
  };
}

loadPlaywrightLocalEnvironment();

/* Keep E2E isolated from the app developers commonly run on port 3000. */
const settings = playwrightSettings();

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  expect: {
    timeout: 10 * 1000,
  },
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Run tests in files in parallel */
  fullyParallel: true,
  ...(settings.globalTimeout === undefined
    ? {}
    : { globalTimeout: settings.globalTimeout }),

  /* Configure projects */
  projects: [
    {
      name: "e2e",
      testMatch: /e2e\/.*.test.ts/,
      use: {
        ...devices["Desktop Chrome"],
      },
    },

    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },

    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },

    /* Test against mobile viewports. */
    // {
    //   name: 'Mobile Chrome',
    //   use: { ...devices['Pixel 5'] },
    // },
    // {
    //   name: 'Mobile Safari',
    //   use: { ...devices['iPhone 12'] },
    // },

    /* Test against branded browsers. */
    // {
    //   name: 'Microsoft Edge',
    //   use: { ...devices['Desktop Edge'], channel: 'msedge' },
    // },
    // {
    //   name: 'Google Chrome',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    // },
  ],
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: "html",
  /* Retry on CI only */
  retries: 0,
  testDir: "./tests",

  /* Configure global timeout for each test */
  timeout: 30 * 1000,
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: settings.baseURL,

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: "retain-on-failure",
  },

  /* Run your local dev server before starting the tests */
  webServer: {
    command: settings.webServerCommand,
    env: playwrightWebServerEnvironment(),
    reuseExistingServer: false,
    timeout: 120 * 1000,
    url: settings.webServerURL,
  },
  /* Limit workers to prevent browser crashes */
  workers: process.env.CI ? 2 : 2,
});
