import assert from "node:assert/strict";
import { after, test } from "node:test";
import { renderConsoleMarkdown } from "./markdown";

Object.defineProperty(globalThis, "HTMLElement", {
  configurable: true,
  value: class HTMLElement {},
});

after(() => {
  Reflect.deleteProperty(globalThis, "HTMLElement");
});

test("renders structured Markdown with console-scoped preview classes", async () => {
  const html = await renderConsoleMarkdown(`
## Recon report

The result is **verified** with \`pnpm test\`.

- first check
- second check
`);

  assert.match(html, /class="oc-md-preview"/);
  assert.match(html, /<h2 class="oc-md-heading oc-md-h2">Recon report<\/h2>/);
  assert.match(html, /<strong>verified<\/strong>/);
  assert.match(html, /<code>pnpm test<\/code>/);
  assert.match(html, /<ul class="oc-md-bullet-list">/);
});

test("removes executable links and remote images from untrusted run output", async () => {
  const html = await renderConsoleMarkdown(`
[unsafe](javascript:alert("x"))

![tracking pixel](https://example.com/pixel.png)

<script>alert("x")</script>
`);

  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /<img\b/i);
  assert.doesNotMatch(html, /<script\b/i);
  assert.match(html, /tracking pixel/);
});

test("keeps safe external links isolated from the application window", async () => {
  const html = await renderConsoleMarkdown(
    "[Open the report](https://example.com/report)"
  );

  assert.match(html, /href="https:\/\/example\.com\/report"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
});
