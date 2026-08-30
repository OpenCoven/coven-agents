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
const agentRail = readFileSync(
  new URL("../components/console/agent-rail.tsx", import.meta.url),
  "utf8"
);
const composer = readFileSync(
  new URL("../components/console/composer.tsx", import.meta.url),
  "utf8"
);
const runConsole = readFileSync(
  new URL("../components/console/run-console.tsx", import.meta.url),
  "utf8"
);
const runtimeInspector = readFileSync(
  new URL("../components/console/runtime-inspector.tsx", import.meta.url),
  "utf8"
);
const consoleBlocks = readFileSync(
  new URL("../lib/console/blocks.ts", import.meta.url),
  "utf8"
);

test("run output and evidence claims use the sanitized Markdown preview", () => {
  assert.match(
    runThread,
    /import \{ MarkdownPreview \} from "@\/components\/console\/markdown-preview";/
  );
  assert.match(runThread, /<MarkdownPreview live=\{block\.live\}>/);
  assert.match(runThread, /block\.hasAnswer/);
  assert.match(
    runThread,
    /<MarkdownPreview variant="report">\s*\{block\.claim\}\s*<\/MarkdownPreview>/
  );
  assert.match(runThread, /"Run report"/);
  assert.match(runThread, /No file changes reported/);
  assert.doesNotMatch(runThread, /Verified run report/);
  assert.match(consoleCss, /\.oc-markdown \.oc-md-preview/);
  assert.match(
    consoleCss,
    /\.oc-markdown mark \{[\s\S]*background: transparent;[\s\S]*\}/
  );
  assert.match(consoleCss, /\.oc-evidence-report/);
  assert.match(consoleCss, /\.oc-markdown-report/);
});

test("every read-only mission surface applies the shared evidence sanitizer", () => {
  assert.match(consoleBlocks, /sanitizeEvidenceText\(run\.task\)/);
  assert.match(agentRail, /sanitizeEvidenceText\(run\.snapshot\.task\)/);
  assert.match(composer, /sanitizeEvidenceText\(run\.snapshot\.task\)/);
  assert.match(composer, /sanitizeEvidenceText\(agent\.model\)/);
  assert.match(composer, /sanitizeEvidencePath\(agent\.workspace/);
  assert.match(runConsole, /sanitizeEvidenceText\(agent\.model\)/);
  assert.match(runConsole, /sanitizeEvidenceText\(created\.name\)/);
  assert.match(runConsole, /sanitizeEvidenceText\(updated\.name\)/);
  assert.match(
    runConsole,
    /name=\{sanitizeEvidenceText\(selectedAgent\.name\)\}/
  );
  assert.match(runConsole, /sanitizeEvidenceText\(error\.message\)/);
  assert.match(runtimeInspector, /sanitizeEvidenceText\(agent\.model\)/);
  assert.match(runtimeInspector, /sanitizeEvidencePath\(agent\.workspace/);
  assert.match(
    consoleBlocks,
    /sanitizeEvidenceText\(event\.evidence\.(?:command|stdout|stderr)\)/
  );
});
