import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);
const guideUrl = new URL("docs/security/guest-access.md", repositoryRoot);
const readmeUrl = new URL("README.md", repositoryRoot);

const protectedRoutes = new Map([
  ["app/(chat)/api/chat/route.ts", 2],
  ["app/(chat)/api/document/route.ts", 3],
  ["app/(chat)/api/files/upload/route.ts", 1],
  ["app/(chat)/api/history/route.ts", 2],
  ["app/(chat)/api/messages/route.ts", 1],
  ["app/(chat)/api/suggestions/route.ts", 1],
  ["app/(chat)/api/vote/route.ts", 2],
  ["app/api/account/avatar/route.ts", 2],
  ["app/api/credentials/device/route.ts", 2],
  ["app/api/credentials/route.ts", 3],
]);

const guestFacingCopy = new Map([
  ["app/(auth)/login/page.tsx", "guest access"],
  ["components/agents/account-menu.tsx", '"Guest"'],
  [
    "components/chat/multimodal-input.tsx",
    "This model needs an active subscription",
  ],
  ["components/demo/demo-root.tsx", "Curated guest preview"],
  ["components/demo/replay-player.tsx", "Replay guest run"],
  ["lib/demo/root.ts", "Guest preview unavailable"],
]);

function read(path: string) {
  return readFileSync(new URL(path, repositoryRoot), "utf8");
}

test("the guest guide documents states, flows, gates, and precautions", () => {
  const guide = readFileSync(guideUrl, "utf8");

  for (const heading of [
    "# Guest Access and Safety Boundary",
    "## Vocabulary",
    "## Guest states",
    "## Flow diagrams",
    "## Authorization matrix",
    "## Conditions and constraints",
    "## Safety precautions",
    "## Verification",
  ]) {
    assert.match(guide, new RegExp(heading));
  }

  assert.ok(
    (guide.match(/```mermaid/g) ?? []).length >= 3,
    "guest access must include state, request, and resource-flow diagrams"
  );

  for (const reference of [
    "proxy.ts",
    "app/(auth)/auth.ts",
    "lib/session.ts",
    "lib/auth/subscriber-access.ts",
    "lib/auth/subscriber-authorization.server.ts",
    "app/api/credentials/route.ts",
    "worker/src/routes.ts",
  ]) {
    assert.ok(guide.includes(reference), `${reference} must remain documented`);
  }

  assert.match(guide, /guest access/i);
  assert.match(guide, /internal `demo`/i);
  assert.match(guide, /revoked subscriber token loses authority immediately/i);
  assert.match(
    guide,
    /does \*\*not\*\* start an agent, sandbox,[\s\S]*persistent chat/i
  );
});

test("the README links the guest safety boundary", () => {
  assert.match(
    readFileSync(readmeUrl, "utf8"),
    /\[Guest access and safety\s+boundary\]\(docs\/security\/guest-access\.md\)/
  );
});

test("every resource-bearing guest route enforces subscriber access", () => {
  for (const [path, expectedCalls] of protectedRoutes) {
    const source = read(path);
    const calls = source.match(/authorizeSubscriberAccess\(/g) ?? [];

    assert.match(
      source,
      /from "@\/lib\/auth\/subscriber-authorization\.server"/,
      `${path} must use authoritative subscriber access`
    );
    assert.equal(
      calls.length,
      expectedCalls,
      `${path} must gate every resource-bearing handler`
    );
  }
});

test("guest-facing surfaces consistently use welcoming terminology", () => {
  for (const [path, expectedCopy] of guestFacingCopy) {
    assert.ok(
      read(path).includes(expectedCopy),
      `${path} must retain guest-facing copy`
    );
  }
});
