import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rootLayout = readFileSync(
  new URL("../app/layout.tsx", import.meta.url),
  "utf8"
);
const chatLayout = readFileSync(
  new URL("../app/(chat)/layout.tsx", import.meta.url),
  "utf8"
);
const authLayout = readFileSync(
  new URL("../app/(auth)/layout.tsx", import.meta.url),
  "utf8"
);

const providerImport = 'import { SessionProvider } from "next-auth/react";';
const providerOpeningTag =
  /<SessionProvider\s+basePath=\{`\$\{process\.env\.NEXT_PUBLIC_BASE_PATH \?\? ""\}\/api\/auth`}/;

test("root layout does not mount SessionProvider", () => {
  assert.doesNotMatch(rootLayout, /\bSessionProvider\b/);
  assert.match(rootLayout, /<TooltipProvider>\{children\}<\/TooltipProvider>/);
});

test("chat layout mounts SessionProvider with the configured auth base path", () => {
  assert.match(chatLayout, new RegExp(providerImport.replace(/[{}]/g, "\\$&")));
  assert.match(chatLayout, providerOpeningTag);
  assert.match(chatLayout, /<\/SessionProvider>/);
});

test("auth layout mounts SessionProvider with the configured auth base path", () => {
  assert.match(authLayout, new RegExp(providerImport.replace(/[{}]/g, "\\$&")));
  assert.match(authLayout, providerOpeningTag);
  assert.match(authLayout, /<\/SessionProvider>/);
});
