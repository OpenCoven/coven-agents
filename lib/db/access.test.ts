import assert from "node:assert/strict";
import test from "node:test";
import { isSubscriber, toSession } from "@/lib/session";
import { databaseFor } from "./access";

test("a subscriber session yields a database handle", () => {
  const session = toSession({
    id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    type: "subscriber",
  });

  // Narrowed rather than cast: `as never` would sidestep the very
  // compile-time guarantee this module exists to provide, so the call would
  // typecheck for the wrong reason.
  assert.ok(isSubscriber(session));
  if (isSubscriber(session)) {
    assert.ok(databaseFor(session));
  }
});

test("a demo session is refused at runtime as well as at compile time", () => {
  // The type system is the primary guard. This asserts the runtime backstop
  // for callers that reach here through an `any` or a deserialised boundary,
  // where the type has already been erased.
  const demo = toSession(null);

  assert.throws(() => databaseFor(demo as never), /untrusted principal/i);
});

test("the server-only runner operator can obtain its scheduler database", () => {
  assert.ok(databaseFor({ kind: "runner-operator" }));
});
