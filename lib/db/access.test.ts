import assert from "node:assert/strict";
import test from "node:test";
import { toSession } from "@/lib/session";
import { databaseFor } from "./access";

test("a subscriber session yields a database handle", () => {
  const session = toSession({ id: "user-1", type: "subscriber" });

  assert.ok(databaseFor(session as never));
});

test("a demo session is refused at runtime as well as at compile time", () => {
  // The type system is the primary guard. This asserts the runtime backstop
  // for callers that reach here through an `any` or a deserialised boundary,
  // where the type has already been erased.
  const demo = toSession(null);

  assert.throws(() => databaseFor(demo as never), /demo session/i);
});
