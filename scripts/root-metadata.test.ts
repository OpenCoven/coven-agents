import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const layout = readFileSync(
  new URL("../app/layout.tsx", import.meta.url),
  "utf8"
);

test("social metadata has an explicit deployment-aware base URL", () => {
  assert.match(
    layout,
    /metadataBase:\s*new URL\(process\.env\.APP_ORIGIN \?\? "http:\/\/localhost:3000"\)/
  );
});

test("the public description uses the stable cloud deployment class", () => {
  assert.match(layout, /run in isolated cloud sandboxes/);
});

test("Vercel analytics is mounted only where its script endpoint exists", () => {
  assert.match(layout, /const analyticsEnabled = process\.env\.VERCEL === "1"/);
  assert.match(layout, /\{analyticsEnabled \? <Analytics \/> : null\}/);
});
