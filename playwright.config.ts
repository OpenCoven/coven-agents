import { defineConfig, devices } from "@playwright/test";

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
import { config } from "dotenv";

type PlaywrightEnvironment = Readonly<Record<string, string | undefined>>;

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

loadPlaywrightLocalEnvironment();

/* Keep E2E isolated from the app developers commonly run on port 3000. */
const PORT = process.env.PORT || 3100;
const useProductionBuild = process.env.E2E_PRODUCTION === "1";
const nextCommand = "node node_modules/next/dist/bin/next";

/**
 * Set webServer.url and use.baseURL with the location
 * of the WebServer respecting the correct set port
 */
const baseURL = `http://localhost:${PORT}`;
const basePath = process.env.IS_DEMO === "1" ? "/demo" : "";

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
    baseURL,

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: "retain-on-failure",
  },

  /* Run your local dev server before starting the tests */
  webServer: {
    command: useProductionBuild
      ? `pnpm validate:runtime && exec ${nextCommand} start --port ${PORT}`
      : `exec ${nextCommand} dev --turbo --port ${PORT}`,
    env: playwrightWebServerEnvironment(),
    reuseExistingServer: false,
    timeout: 120 * 1000,
    url: `${baseURL}${basePath}/ping`,
  },
  /* Limit workers to prevent browser crashes */
  workers: process.env.CI ? 2 : 2,
});
