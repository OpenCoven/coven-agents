import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { describe } from "./hygiene";
import { isReapable } from "./hygiene-core";
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

    const states = await collectState(async () => true, clone);
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

    const states = await collectState(async () => true, clone);
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

    const states = await collectState(async () => true, clone);
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
    const states = await collectState(async () => true, clone);
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
    const states = await collectState(async () => true, clone);
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
