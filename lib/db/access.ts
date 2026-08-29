import type { RunnerOperator } from "@/lib/runner/types";
import type { SubscriberSession } from "@/lib/session";
import { db } from "./queries";

/**
 * The only supported way to obtain a database handle.
 *
 * The parameter type IS the enforcement: a `SubscriberSession` is one member
 * of the `Session` union, and a `DemoSession` does not satisfy it. The only
 * other caller is the runner's internal operator capability, which is reached
 * after its own secret-authenticated boundary rather than from a browser.
 * A demo code path that tries to pass its session here fails to compile — the
 * ban on the owner's database being available to non-subscribers is
 * unrepresentable rather than something a reviewer has to catch. See
 * `lib/session.ts` for the discriminated principal union.
 *
 * The runtime check below is a backstop only, for callers that reach this
 * function through an `any` or a deserialised boundary (e.g. JSON parsed
 * from a request body) where the static type has already been erased. It is
 * not the primary guard.
 *
 * Every write and read must reach the database through this function.
 * Importing `db` directly from `./queries` bypasses the authenticated
 * principal type entirely and defeats the ban this function exists to enforce.
 */
export function databaseFor(
  principal: SubscriberSession | RunnerOperator
): typeof db {
  if (principal.kind !== "subscriber" && principal.kind !== "runner-operator") {
    throw new Error(
      "databaseFor called with an untrusted principal. This is a bug in the caller: " +
        "only a SubscriberSession or RunnerOperator may obtain a database handle. " +
        "If you reached this via `any` or a deserialised value, narrow to a " +
        "trusted principal before calling."
    );
  }

  return db;
}
