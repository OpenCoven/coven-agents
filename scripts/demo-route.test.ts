import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const rootPageUrl = new URL("../app/page.tsx", import.meta.url);
const chatRootPageUrl = new URL("../app/(chat)/page.tsx", import.meta.url);
const nestedDemoPageUrl = new URL("../app/demo/page.tsx", import.meta.url);
const loginPageUrl = new URL("../app/(auth)/login/page.tsx", import.meta.url);
const githubSignInUrl = new URL(
  "../components/chat/github-sign-in.tsx",
  import.meta.url
);
const demoRootUrl = new URL(
  "../components/demo/demo-root.tsx",
  import.meta.url
);
const replayPlayerUrl = new URL(
  "../components/demo/replay-player.tsx",
  import.meta.url
);
const nextConfigUrl = new URL("../next.config.ts", import.meta.url);
const chatPageUrl = new URL(
  "../app/(chat)/chat/[id]/page.tsx",
  import.meta.url
);

function read(url: URL) {
  return readFileSync(url, "utf8");
}

test("root ownership sits outside the chat layout and has no nested demo page", () => {
  assert.equal(existsSync(rootPageUrl), true);
  assert.equal(existsSync(chatRootPageUrl), false);
  assert.equal(existsSync(nestedDemoPageUrl), false);
});

test("the root page preserves the demo gate and agents redirect", () => {
  const rootPage = read(rootPageUrl);

  assert.match(rootPage, /resolveRootRoute\(process\.env\.IS_DEMO\)/);
  assert.match(rootPage, /redirect\(route\.location\)/);
  assert.match(rootPage, /loadDemoTranscript\(/);
});

test("the default root redirect runs before the page is rendered", () => {
  const nextConfig = read(nextConfigUrl);

  assert.match(nextConfig, /const rootDestination = basePath \|\| "\/agents"/);
  assert.match(
    nextConfig,
    /redirects:\s*async \(\) =>\s*\[\s*\{[\s\S]*?destination: rootDestination[\s\S]*?source: "\/"/
  );
});

test("registration redirects before the redirect-only page is rendered", () => {
  const nextConfig = read(nextConfigUrl);

  assert.match(nextConfig, /const loginDestination = `\$\{basePath\}\/login`/);
  assert.match(
    nextConfig,
    /destination: loginDestination[\s\S]*?source: "\/register"/
  );
});

test("the layout-owned chat leaf opts out of instant rendering", () => {
  const chatPage = read(chatPageUrl);

  assert.match(chatPage, /export const instant = false/);
  assert.match(chatPage, /return null/);
});

test("the client player plans the transcript before scheduling playback", () => {
  const replayPlayer = read(replayPlayerUrl);

  assert.match(
    replayPlayer,
    /import\s+\{\s*planPlayback\s*\}\s+from\s+"@\/lib\/demo\/player"/
  );
  assert.match(replayPlayer, /planPlayback\(transcript\.events\)/);
  assert.match(replayPlayer, /schedulePlayback\(/);
  assert.match(replayPlayer, /Replay guest run/);
});

test("the replay button shows a high-contrast keyboard focus ring", () => {
  const replayPlayer = read(replayPlayerUrl);

  assert.match(
    replayPlayer,
    /aria-label="Replay guest run"[\s\S]*?className="[^"]*focus-visible:border-white\s+focus-visible:ring-\[3px\]\s+focus-visible:ring-white\/70/
  );
});

test("the demo uses the purple brand palette", () => {
  const sources = [read(demoRootUrl), read(replayPlayerUrl)].join("\n");

  assert.match(sources, /rgba\(147,134,208,0\.2\)/);
  assert.match(sources, /violet-300/);
  assert.doesNotMatch(sources, /emerald-/);
});

test("curated guest data is not described as a live recording", () => {
  const demoRoot = read(demoRootUrl);

  assert.match(demoRoot, /Curated guest preview/);
  assert.match(demoRoot, /Safe guest replay/);
  assert.match(demoRoot, /deterministic example built from sanitized evidence/);
  assert.doesNotMatch(demoRoot, /Recorded agent run|Recorded replay/);
});

test("the guest preview offers account creation without starting live resources", () => {
  const demoRoot = read(demoRootUrl);
  const githubSignIn = read(githubSignInUrl);
  const loginPage = read(loginPageUrl);

  assert.match(demoRoot, /href="\/login"[\s\S]*?prefetch=\{false\}/);
  assert.match(demoRoot, /Create guest account/);
  assert.match(loginPage, /New accounts start with guest access/);
  // The promise was deliberately narrowed when sign-in prewarming shipped:
  // signing in still never starts an agent or a run, but for subscribers it
  // now begins booting a sandbox container — and the page must say so.
  assert.match(loginPage, /never starts an agent or a run/);
  assert.match(loginPage, /warming\s+the\s+sandbox/);
  assert.match(loginPage, /<GithubSignIn callbackUrl="\/"\s*\/>/);
  assert.doesNotMatch(loginPage, /callbackUrl="\/agents"/);
  assert.doesNotMatch(githubSignIn, />or</);
});

test("the demo route tree has no live service or network dependency", () => {
  const sources = [read(rootPageUrl), read(demoRootUrl), read(replayPlayerUrl)];
  const forbidden = [
    /\bfetch\s*\(/,
    /\bSessionProvider\b/,
    /next-auth/,
    /@\/lib\/agents\/client/,
    /@\/lib\/db/,
    /@\/app\/\(auth\)\/auth/,
  ];

  for (const source of sources) {
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern);
    }
  }
});
