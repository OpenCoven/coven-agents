import assert from "node:assert/strict";
import test from "node:test";
import { isReapable, type WorktreeState } from "./hygiene-core";

function state(overrides: Partial<WorktreeState> = {}): WorktreeState {
  return {
    branch: "feat/example",
    dirtyCount: 0,
    existsOnOrigin: true,
    headSha: "aaa111",
    isLocked: false,
    isPrimary: false,
    mergedHeadSha: null,
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

test("structural guards accumulate with each other", () => {
  const verdict = isReapable(state({ branch: "main", isLocked: true }));

  assert.equal(verdict.safe, false);
  assert.ok(verdict.reasons.includes("locked"));
  assert.ok(verdict.reasons.some((r) => r.includes("protected branch")));
});

test("whitespace-padded protected branches are blocked", () => {
  for (const branch of ["main ", "  main"]) {
    const verdict = isReapable(state({ branch }));

    assert.equal(
      verdict.safe,
      false,
      `${JSON.stringify(branch)} must not be reapable`
    );
    assert.ok(
      verdict.reasons.some((r) => r.includes("protected branch")),
      `${JSON.stringify(branch)} should report a protected branch reason`
    );
  }
});

test("invalid counters fail closed", () => {
  const nanDirty = isReapable(state({ dirtyCount: Number.NaN }));
  assert.equal(nanDirty.safe, false);
  assert.ok(nanDirty.reasons.includes("invalid dirty count: NaN"));

  const negativeDirty = isReapable(state({ dirtyCount: -1 }));
  assert.equal(negativeDirty.safe, false);
  assert.ok(negativeDirty.reasons.includes("invalid dirty count: -1"));

  const nanUnpushed = isReapable(state({ unpushedCommits: Number.NaN }));
  assert.equal(nanUnpushed.safe, false);
  assert.ok(nanUnpushed.reasons.includes("invalid unpushed count: NaN"));
});

test("a merged branch stays reapable after the remote branch is deleted", () => {
  // The hygiene workflow deletes the remote branch seconds after a merge, and
  // squashing rewrites the SHA, so the local commits become unreachable from
  // every remote ref. Nothing is at risk: `gh` reports the exact head that was
  // merged, and it is the head this worktree still points at.
  const verdict = isReapable(
    state({
      existsOnOrigin: false,
      headSha: "f10c255",
      mergedHeadSha: "f10c255",
      unpushedCommits: 1,
    })
  );

  assert.equal(verdict.safe, true, verdict.reasons.join(", "));
  assert.deepEqual(verdict.reasons, []);
});

test("a commit added after the merge is never treated as preserved", () => {
  const verdict = isReapable(
    state({
      existsOnOrigin: false,
      headSha: "newwork",
      mergedHeadSha: "f10c255",
      unpushedCommits: 1,
    })
  );

  assert.equal(verdict.safe, false);
  assert.ok(
    verdict.reasons.some((r) => r.includes("unpushed")),
    `expected an unpushed blocker, got: ${verdict.reasons.join(", ")}`
  );
});

test("uncommitted files block reaping even on a merged, preserved head", () => {
  const verdict = isReapable(
    state({
      dirtyCount: 2,
      existsOnOrigin: false,
      headSha: "f10c255",
      mergedHeadSha: "f10c255",
    })
  );

  assert.equal(verdict.safe, false);
  assert.ok(verdict.reasons.some((r) => r.includes("uncommitted")));
});

test("an unmerged branch missing from origin is still blocked", () => {
  const verdict = isReapable(
    state({
      existsOnOrigin: false,
      mergedHeadSha: null,
      mergedIntoMain: false,
    })
  );

  assert.equal(verdict.safe, false);
  assert.ok(verdict.reasons.includes("branch not on origin"));
});

test("an unknown merged head fails closed to the strict conditions", () => {
  // `mergedIntoMain` without a head SHA means gh confirmed a merged PR but the
  // head could not be matched. That must not unlock the relaxed path.
  const verdict = isReapable(
    state({ existsOnOrigin: false, mergedHeadSha: null, unpushedCommits: 1 })
  );

  assert.equal(verdict.safe, false);
  assert.ok(verdict.reasons.includes("branch not on origin"));
});

test("a null local head never matches a merged head", () => {
  const verdict = isReapable(
    state({ existsOnOrigin: false, headSha: null, mergedHeadSha: null })
  );

  assert.equal(verdict.safe, false);
});

test("preserved-on-main relaxes only origin and unpushed, exhaustively", () => {
  const flags = [false, true];
  let safeCount = 0;

  for (const clean of flags) {
    for (const onOrigin of flags) {
      for (const pushed of flags) {
        const verdict = isReapable(
          state({
            dirtyCount: clean ? 0 : 1,
            existsOnOrigin: onOrigin,
            headSha: "f10c255",
            mergedHeadSha: "f10c255",
            unpushedCommits: pushed ? 0 : 1,
          })
        );

        assert.equal(
          verdict.safe,
          clean,
          `clean=${clean} onOrigin=${onOrigin} pushed=${pushed}`
        );
        if (verdict.safe) {
          safeCount += 1;
        }
      }
    }
  }

  assert.equal(safeCount, 4, "only cleanliness may block a preserved head");
});
