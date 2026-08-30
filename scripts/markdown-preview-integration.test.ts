import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const runThread = readFileSync(
  new URL("../components/console/run-thread.tsx", import.meta.url),
  "utf8"
);
const consoleCss = readFileSync(
  new URL("../app/console.css", import.meta.url),
  "utf8"
);

test("run output and evidence claims use the sanitized Markdown preview", () => {
  assert.match(
    runThread,
    /import \{ MarkdownPreview \} from "@\/components\/console\/markdown-preview";/
  );
  assert.match(runThread, /<MarkdownPreview live=\{block\.live\}>/);
  assert.match(
    runThread,
    /<MarkdownPreview>\{block\.claim\}<\/MarkdownPreview>/
  );
  assert.match(consoleCss, /\.oc-markdown \.oc-md-preview/);
});
