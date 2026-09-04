import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  describe,
  isAtRisk,
  type ReapDependencies,
  type Row,
  reapWorktrees,
  reportReap,
} from "./hygiene";
import { isReapable, type WorktreeState } from "./hygiene-core";
import { collectState, parseWorktreeList } from "./hygiene-git";

function sh(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

/**
 * Builds an origin bare repo plus a clone, so push state and remote refs are
 * real rather than mocked.
 */
function makeSandbox(): { clone: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "hygiene-"));
  const origin = join(root, "origin.git");
  const clone = join(root, "clone");

  execFileSync("git", ["init", "--bare", "-b", "main", origin], {
    stdio: "pipe",
  });
  execFileSync("git", ["clone", origin, clone], { stdio: "pipe" });

  sh(["config", "user.email", "test@example.com"], clone);
  sh(["config", "user.name", "Test"], clone);
  sh(["config", "commit.gpgsign", "false"], clone);

  writeFileSync(join(clone, "README.md"), "# sandbox\n");
  sh(["add", "."], clone);
  sh(["commit", "-m", "init"], clone);
  sh(["push", "-u", "origin", "main"], clone);

  return { clone, root };
}

test("parseWorktreeList marks the first entry as primary", () => {
  const parsed = parseWorktreeList(
    [
      "worktree /repo",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repo/.worktrees/feat",
      "HEAD def456",
      "branch refs/heads/feat/thing",
      "locked",
    ].join("\n")
  );

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].isPrimary, true);
  assert.equal(parsed[0].branch, "main");
  assert.equal(parsed[1].isPrimary, false);
  assert.equal(parsed[1].branch, "feat/thing");
  assert.equal(parsed[1].isLocked, true);
});

test("a clean, pushed, merged worktree is reported reapable", async () => {
  const { clone, root } = makeSandbox();

  try {
    sh(["worktree", "add", "-b", "feat/done", join(root, "wt-done")], clone);
    sh(["push", "-u", "origin", "feat/done"], join(root, "wt-done"));

    const states = await collectState(
      async () => ({ merged: true, mergedHeadSha: null }),
      clone
    );
    const target = states.find((s) => s.branch === "feat/done");

    assert.ok(target, "feat/done worktree must be discovered");
    assert.equal(target.dirtyCount, 0);
    assert.equal(target.existsOnOrigin, true);
    assert.equal(target.unpushedCommits, 0);
    assert.equal(isReapable(target).safe, true);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("an unpushed branch is never reapable", async () => {
  const { clone, root } = makeSandbox();

  try {
    const wt = join(root, "wt-unpushed");
    sh(["worktree", "add", "-b", "feat/unpushed", wt], clone);
    writeFileSync(join(wt, "new.txt"), "work\n");
    sh(["add", "."], wt);
    sh(["commit", "-m", "unpushed work"], wt);

    const states = await collectState(
      async () => ({ merged: true, mergedHeadSha: null }),
      clone
    );
    const target = states.find((s) => s.branch === "feat/unpushed");

    assert.ok(target);
    assert.equal(target.existsOnOrigin, false);
    assert.ok(target.unpushedCommits > 0);

    const verdict = isReapable(target);
    assert.equal(verdict.safe, false);
    assert.ok(verdict.reasons.includes("branch not on origin"));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a dirty worktree is never reapable", async () => {
  const { clone, root } = makeSandbox();

  try {
    const wt = join(root, "wt-dirty");
    sh(["worktree", "add", "-b", "feat/dirty", wt], clone);
    sh(["push", "-u", "origin", "feat/dirty"], wt);
    writeFileSync(join(wt, "scratch.txt"), "uncommitted\n");

    const states = await collectState(
      async () => ({ merged: true, mergedHeadSha: null }),
      clone
    );
    const target = states.find((s) => s.branch === "feat/dirty");

    assert.ok(target);
    assert.equal(target.dirtyCount, 1);
    assert.equal(isReapable(target).safe, false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("the primary checkout is never reapable", async () => {
  const { clone, root } = makeSandbox();

  try {
    const states = await collectState(
      async () => ({ merged: true, mergedHeadSha: null }),
      clone
    );
    const primary = states.find((s) => s.isPrimary);

    assert.ok(primary, "primary worktree must be discovered");
    assert.equal(primary.branch, "main");
    assert.equal(
      isReapable(primary).safe,
      false,
      "reaping the primary checkout would delete the working copy"
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("status detail for the primary worktree reads 'current checkout', not reap blockers", async () => {
  const { clone, root } = makeSandbox();

  try {
    const states = await collectState(
      async () => ({ merged: true, mergedHeadSha: null }),
      clone
    );
    const primary = states.find((s) => s.isPrimary);
    assert.ok(primary, "primary worktree must be discovered");

    const verdict = isReapable(primary);
    const line = describe({ state: primary, verdict });

    assert.ok(line.includes("current checkout"));
    assert.ok(!line.includes("primary worktree"));
    assert.ok(!line.includes("not merged into main"));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a merged worktree survives the remote branch being deleted", async () => {
  // Reproduces the sequence that broke reaping in practice: merge a PR, let
  // the hygiene workflow delete the remote branch, and the local commits are
  // suddenly unreachable from every remote ref.
  const { clone, root } = makeSandbox();

  try {
    const wt = join(root, "wt-merged");
    sh(["worktree", "add", "-b", "feat/merged", wt], clone);
    writeFileSync(join(wt, "shipped.txt"), "shipped\n");
    sh(["add", "."], wt);
    sh(["commit", "-m", "work that later merges"], wt);
    sh(["push", "-u", "origin", "feat/merged"], wt);

    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: wt,
      encoding: "utf8",
    }).trim();

    // The server plane deletes the branch once the PR merges.
    sh(["push", "origin", "--delete", "feat/merged"], wt);

    const states = await collectState(
      async () => ({ merged: true, mergedHeadSha: headSha }),
      clone
    );
    const target = states.find((s) => s.branch === "feat/merged");

    assert.ok(target, "feat/merged worktree must be discovered");
    assert.equal(target.existsOnOrigin, false, "remote branch is gone");
    assert.ok(target.unpushedCommits > 0, "commits unreachable from remotes");
    assert.equal(target.headSha, headSha);

    assert.equal(
      isReapable(target).safe,
      true,
      `merged worktree must be reapable, got: ${isReapable(target).reasons.join(", ")}`
    );
    assert.equal(isAtRisk(target), false, "merged work is not at risk");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a commit made after the merge is protected, not reaped", async () => {
  const { clone, root } = makeSandbox();

  try {
    const wt = join(root, "wt-after");
    sh(["worktree", "add", "-b", "feat/after", wt], clone);
    writeFileSync(join(wt, "shipped.txt"), "shipped\n");
    sh(["add", "."], wt);
    sh(["commit", "-m", "work that later merges"], wt);
    sh(["push", "-u", "origin", "feat/after"], wt);

    const mergedSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: wt,
      encoding: "utf8",
    }).trim();

    sh(["push", "origin", "--delete", "feat/after"], wt);

    // New work committed after the PR merged. It exists only here.
    writeFileSync(join(wt, "later.txt"), "not yet shipped\n");
    sh(["add", "."], wt);
    sh(["commit", "-m", "work added after the merge"], wt);

    const states = await collectState(
      async () => ({ merged: true, mergedHeadSha: mergedSha }),
      clone
    );
    const target = states.find((s) => s.branch === "feat/after");

    assert.ok(target);
    assert.notEqual(target.headSha, mergedSha, "tip moved past the merge");
    assert.equal(isReapable(target).safe, false, "later work must be kept");
    assert.equal(isAtRisk(target), true, "later work is genuinely at risk");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

/**
 * Reap applies two git operations per worktree and the order is forced: git
 * refuses to delete a branch that is still checked out, so the worktree goes
 * first. That makes a half-applied removal reachable, and these tests pin what
 * the operator is told when it happens.
 */
function row(overrides: Partial<WorktreeState> = {}): Row {
  const state: WorktreeState = {
    branch: "fix/example",
    dirtyCount: 0,
    existsOnOrigin: true,
    isLocked: false,
    isPrimary: false,
    mergedIntoMain: true,
    path: "/tmp/wt/example",
    unpushedCommits: 0,
    ...overrides,
  } as WorktreeState;

  return { state, verdict: isReapable(state) };
}

function recordingDeps(
  fail: { worktree?: string; branch?: string } = {}
): ReapDependencies & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    deleteBranch: (flag, branch) => {
      calls.push(`branch:${flag}:${branch}`);
      return fail.branch === branch
        ? Promise.reject(new Error("not fully merged"))
        : Promise.resolve();
    },
    removeWorktree: (path) => {
      calls.push(`worktree:${path}`);
      return fail.worktree === path
        ? Promise.reject(new Error("worktree is dirty"))
        : Promise.resolve();
    },
  };
}

test("a worktree whose branch delete fails still counts as removed", async () => {
  // The bug: the success line was logged only after BOTH git calls, so a
  // failed branch delete reported the whole worktree as not reaped even though
  // its directory was already gone. The count then understated what changed on
  // disk, which is the opposite of the direction a cleanup tool may err in.
  const target = row({ branch: "fix/keeps-branch" });
  const results = await reapWorktrees(
    [target],
    recordingDeps({ branch: "fix/keeps-branch" })
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]?.kind, "branch_left");
  assert.equal(
    reportReap(results) === 0,
    false,
    "a branch left behind must not report clean success"
  );
});

test("a failed worktree removal never attempts the branch delete", async () => {
  const target = row({ path: "/tmp/wt/stuck" });
  const deps = recordingDeps({ worktree: "/tmp/wt/stuck" });
  const results = await reapWorktrees([target], deps);

  assert.equal(results[0]?.kind, "kept");
  assert.deepEqual(
    deps.calls,
    ["worktree:/tmp/wt/stuck"],
    "deleting the branch of a worktree that still exists would strand it"
  );
});

test("one failure does not abandon the remaining worktrees", async () => {
  const results = await reapWorktrees(
    [
      row({ branch: "fix/a", path: "/tmp/wt/a" }),
      row({ branch: "fix/b", path: "/tmp/wt/b" }),
      row({ branch: "fix/c", path: "/tmp/wt/c" }),
    ],
    recordingDeps({ worktree: "/tmp/wt/b" })
  );

  assert.deepEqual(
    results.map((r) => r.kind),
    ["removed", "kept", "removed"]
  );
});

test("the reaped count matches the worktrees actually gone from disk", async () => {
  const results = await reapWorktrees(
    [
      row({ branch: "fix/a", path: "/tmp/wt/a" }),
      row({ branch: "fix/b", path: "/tmp/wt/b" }),
      row({ branch: "fix/c", path: "/tmp/wt/c" }),
    ],
    recordingDeps({ branch: "fix/b" })
  );

  // b's directory is gone even though its branch survived, so two of three is
  // wrong: three worktrees were removed.
  const gone = results.filter((r) => r.kind !== "kept").length;
  assert.equal(gone, 3);
});

test("a detached worktree is removed without a branch delete", async () => {
  const deps = recordingDeps();
  const results = await reapWorktrees(
    [row({ branch: null, mergedIntoMain: true, path: "/tmp/wt/detached" })],
    deps
  );

  assert.deepEqual(deps.calls, ["worktree:/tmp/wt/detached"]);
  assert.equal(results[0]?.kind, "removed");
});
