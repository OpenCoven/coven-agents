import assert from "node:assert/strict";
import test from "node:test";
import { resolveDemoView, resolveRootRoute } from "./root";

test("default root behavior remains a redirect to agents", () => {
  assert.deepEqual(resolveRootRoute(undefined), {
    kind: "redirect",
    location: "/agents",
  });
});

test("demo mode owns the root route", () => {
  assert.deepEqual(resolveRootRoute("1"), { kind: "demo" });
});

test("demo mode without a valid fixture renders a clear empty state", () => {
  assert.deepEqual(resolveDemoView(null), {
    description:
      "No recorded run is available to replay. No live run was started.",
    kind: "unavailable",
    title: "Demo unavailable",
  });
});
