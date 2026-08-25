import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const rootPageUrl = new URL("../app/page.tsx", import.meta.url);
const chatRootPageUrl = new URL("../app/(chat)/page.tsx", import.meta.url);
const nestedDemoPageUrl = new URL("../app/demo/page.tsx", import.meta.url);
const demoRootUrl = new URL(
  "../components/demo/demo-root.tsx",
  import.meta.url
);
const replayPlayerUrl = new URL(
  "../components/demo/replay-player.tsx",
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

test("the client player plans the transcript before scheduling playback", () => {
  const replayPlayer = read(replayPlayerUrl);

  assert.match(
    replayPlayer,
    /import\s+\{\s*planPlayback\s*\}\s+from\s+"@\/lib\/demo\/player"/
  );
  assert.match(replayPlayer, /planPlayback\(transcript\.events\)/);
  assert.match(replayPlayer, /schedulePlayback\(/);
  assert.match(replayPlayer, /Replay recorded run/);
});

test("the replay button shows a high-contrast keyboard focus ring", () => {
  const replayPlayer = read(replayPlayerUrl);

  assert.match(
    replayPlayer,
    /aria-label="Replay recorded run"[\s\S]*?className="[^"]*focus-visible:border-white\s+focus-visible:ring-\[3px\]\s+focus-visible:ring-white\/70/
  );
});

test("the demo uses the purple brand palette", () => {
  const sources = [read(demoRootUrl), read(replayPlayerUrl)].join("\n");

  assert.match(sources, /rgba\(147,134,208,0\.2\)/);
  assert.match(sources, /violet-300/);
  assert.doesNotMatch(sources, /emerald-/);
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
