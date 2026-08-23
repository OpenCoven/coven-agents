import assert from "node:assert/strict";
import test from "node:test";
import { isReapable, type WorktreeState } from "./hygiene-core";

function state(overrides: Partial<WorktreeState> = {}): WorktreeState {
  return {
    branch: "feat/example",
    dirtyCount: 0,
    existsOnOrigin: true,
    isLocked: false,
    isPrimary: false,
    mergedIntoMain: true,
    path: "/tmp/wt/example",
    unpushedCommits: 0,
    ...overrides,
  };
}

test("a clean, pushed, merged, non-primary worktree is reapable", () => {
  const verdict = isReapable(state());

  assert.equal(verdict.safe, true);
  assert.deepEqual(verdict.reasons, []);
});

test("every single unmet condition blocks reaping", () => {
  const blockers: Partial<WorktreeState>[] = [
    { dirtyCount: 3 },
    { existsOnOrigin: false },
    { unpushedCommits: 2 },
    { mergedIntoMain: false },
  ];

  for (const blocker of blockers) {
    const verdict = isReapable(state(blocker));

    assert.equal(
      verdict.safe,
      false,
      `expected ${JSON.stringify(blocker)} to block reaping`
    );
    assert.ok(verdict.reasons.length > 0);
  }
});

test("safe is unreachable unless all four conditions hold", () => {
  const flags = [false, true];
  let safeCount = 0;

  for (const clean of flags) {
    for (const onOrigin of flags) {
      for (const pushed of flags) {
        for (const merged of flags) {
          const verdict = isReapable(
            state({
              dirtyCount: clean ? 0 : 1,
              existsOnOrigin: onOrigin,
              mergedIntoMain: merged,
              unpushedCommits: pushed ? 0 : 1,
            })
          );
          const allHold = clean && onOrigin && pushed && merged;

          assert.equal(
            verdict.safe,
            allHold,
            `clean=${clean} onOrigin=${onOrigin} pushed=${pushed} merged=${merged}`
          );
          if (verdict.safe) {
            safeCount += 1;
          }
        }
      }
    }
  }

  assert.equal(safeCount, 1, "exactly one of 16 combinations may be safe");
});

test("the primary worktree is never reapable even when all four hold", () => {
  const verdict = isReapable(state({ branch: "main", isPrimary: true }));

  assert.equal(verdict.safe, false);
  assert.ok(verdict.reasons.includes("primary worktree"));
});

test("protected branches are never reapable", () => {
  for (const branch of ["main", "master"]) {
    const verdict = isReapable(state({ branch }));

    assert.equal(verdict.safe, false, `${branch} must not be reapable`);
    assert.ok(verdict.reasons.some((r) => r.includes("protected branch")));
  }
});

test("a detached HEAD is never reapable", () => {
  const verdict = isReapable(state({ branch: null }));

  assert.equal(verdict.safe, false);
  assert.ok(verdict.reasons.includes("detached HEAD"));
});

test("a locked worktree is never reapable", () => {
  const verdict = isReapable(state({ isLocked: true }));

  assert.equal(verdict.safe, false);
  assert.ok(verdict.reasons.includes("locked"));
});

test("reasons accumulate so the report can explain every blocker", () => {
  const verdict = isReapable(
    state({ dirtyCount: 24, existsOnOrigin: false, unpushedCommits: 5 })
  );

  assert.equal(verdict.safe, false);
  assert.equal(verdict.reasons.length, 3);
  assert.ok(verdict.reasons.includes("24 uncommitted file(s)"));
  assert.ok(verdict.reasons.includes("branch not on origin"));
  assert.ok(verdict.reasons.includes("5 unpushed commit(s)"));
});
