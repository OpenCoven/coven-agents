import { generateDummyPassword } from "./db/utils";

export const isProductionEnvironment = process.env.NODE_ENV === "production";
export const isDevelopmentEnvironment = process.env.NODE_ENV === "development";
export const isTestEnvironment = Boolean(
  process.env.PLAYWRIGHT_TEST_BASE_URL ||
    process.env.PLAYWRIGHT ||
    process.env.CI_PLAYWRIGHT
);

export const guestRegex = /^guest-\d+$/;

export const DUMMY_PASSWORD = generateDummyPassword();

/**
 * Opening prompts.
 *
 * The upstream template's four were a Next.js question, a Dijkstra exercise,
 * a Silicon Valley essay and a weather lookup -- a general-purpose chatbot
 * demo. This product runs coding agents against a workspace, so the prompts
 * describe that instead.
 */
export const suggestions = [
  "Audit this workspace and list what looks unsafe",
  "Add a failing test for the bug I just described, then fix it",
  "Explain how the credential flow works end to end",
  "Find the slowest part of the build and tell me why",
];
