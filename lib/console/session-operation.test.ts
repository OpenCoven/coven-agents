import assert from "node:assert/strict";
import test from "node:test";
import {
  isSessionOperationCurrent,
  type SessionOperationContext,
} from "./session-operation";

function context(
  generation: number,
  controller = new AbortController()
): SessionOperationContext {
  return {
    generation,
    isCurrent: () => !controller.signal.aborted,
    signal: controller.signal,
  };
}

test("delayed settings list, save, delete, and wipe results are stale after a session transition", async () => {
  await Promise.all(
    ["list", "save", "delete", "wipe"].map(async (operation) => {
      const first = context(1);
      let current: SessionOperationContext | null = first;
      let resolve!: () => void;
      const delayed = new Promise<void>((done) => {
        resolve = done;
      });
      const publication = delayed.then(() =>
        isSessionOperationCurrent(first, current)
      );

      first.signal.dispatchEvent(new Event("abort"));
      current = context(2);
      resolve();

      assert.equal(await publication, false, operation);
      assert.equal(
        isSessionOperationCurrent(current, current),
        true,
        operation
      );
    })
  );
});

test("unmounted settings reject delayed operation publication", () => {
  const first = context(1);
  assert.equal(isSessionOperationCurrent(first, null), false);
});

test("aborted settings operations cannot publish into the current generation", () => {
  const controller = new AbortController();
  const first = context(1, controller);
  controller.abort();

  assert.equal(isSessionOperationCurrent(first, first), false);
});
