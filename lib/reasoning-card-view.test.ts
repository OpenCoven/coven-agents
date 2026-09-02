import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../components/chat/reasoning-card.tsx", import.meta.url),
  "utf8"
);

test("reasoning card keeps disclosure, focus, and reduced-motion semantics", () => {
  assert.match(source, /<section aria-label="Reasoning">/u);
  assert.match(source, /data-testid="message-reasoning"/u);
  assert.match(source, /<CollapsibleTrigger/u);
  assert.match(source, /<CollapsibleContent/u);
  assert.match(source, /focus-visible:outline/u);
  assert.match(source, /motion-reduce:transition-none/u);
  assert.match(source, /aria-hidden=\{!isOpen\}/u);
  assert.match(source, /inert=\{!isOpen\}/u);
  assert.match(source, /Show \{step\.collapsedCount\} routine tool calls/u);
  assert.match(source, /expandedFocusRef\.current\?\.focus\(\)/u);
});

test("reasoning card uses the exported OpenCoven surface tokens", () => {
  for (const token of [
    "--border-hairline",
    "--bg-raised",
    "--bg-hover",
    "--text-primary",
    "--text-secondary",
    "--text-muted",
    "--accent-presence",
    "--color-danger",
    "--color-warning",
    "--ring-focus",
    "--font-mono",
  ]) {
    assert.match(source, new RegExp(token, "u"));
  }
});
