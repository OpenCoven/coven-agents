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
const agentsLayout = readFileSync(
  new URL("../app/agents/layout.tsx", import.meta.url),
  "utf8"
);
const accountLayout = readFileSync(
  new URL("../app/account/layout.tsx", import.meta.url),
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

test("agents layout mounts SessionProvider with the configured auth base path", () => {
  // `/agents` is in neither the (auth) nor the (chat) group, so moving the
  // provider off the root left the console with no session context at all.
  // Nothing caught it until something needed to know who was signed in.
  assert.match(
    agentsLayout,
    new RegExp(providerImport.replace(/[{}]/g, "\\$&"))
  );
  assert.match(agentsLayout, providerOpeningTag);
  assert.match(agentsLayout, /<\/SessionProvider>/);
});

test("account layout mounts SessionProvider and stays outside the chat group", () => {
  // Living in (chat) meant inheriting a layout that renders <ChatShell />
  // unconditionally, so the settings form appeared stacked beneath an entire
  // chat interface -- and inherited whatever that shell fetches.
  assert.match(
    accountLayout,
    new RegExp(providerImport.replace(/[{}]/g, "\\$&"))
  );
  assert.match(accountLayout, providerOpeningTag);
  assert.match(accountLayout, /<\/SessionProvider>/);
});
