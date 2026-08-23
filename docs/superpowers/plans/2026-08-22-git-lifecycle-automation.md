# Git Lifecycle Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `coven-agents` a complete branch → PR → merge → cleanup → board lifecycle so branch and worktree counts stay low without anyone remembering to clean up.

**Architecture:** Two planes. The **server plane** (GitHub Actions + Projects) owns what must hold for all four actor classes — AI agents, the solo maintainer, Dependabot, other humans. The **local plane** (`scripts/hygiene.ts` + husky hooks) owns worktree and unpushed-commit state that GitHub cannot see. Boundary contract: the server plane is the source of truth for what is merged; the local plane never infers merge state, it asks `gh`.

**Tech Stack:** TypeScript run via `tsx`, `node:test` + `node:assert/strict`, pnpm 10 workspaces, husky, GitHub Actions, GitHub Projects v2, `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-08-22-git-lifecycle-automation-design.md`

---

## Deviation from the spec — read before Task 1

The spec's reap predicate lists **four** conditions: clean, on-origin, fully-pushed, merged.

Implementing it literally produces a **destructive bug**. `git worktree list` includes the primary checkout, which sits on `main`. For that entry all four conditions are trivially true — `main` is clean, on origin, pushed, and merged into itself — so the predicate returns `safe: true` and `reap` would delete your main working copy.

This plan therefore adds **two structural guards** to the predicate: `isPrimary` and `PROTECTED_BRANCHES`. These are not new policy; they are the conditions that make the spec's four safe to evaluate. The spec should be amended to match once this lands.

---

## File Structure

**Local plane (new `scripts/` directory):**

| File | Responsibility |
|---|---|
| `scripts/hygiene-core.ts` | Pure logic only. Types + `isReapable()`. No I/O, no imports outside `node:` types. |
| `scripts/hygiene-core.test.ts` | Exhaustive truth table over the predicate. |
| `scripts/hygiene-git.ts` | All shelling out to `git` and `gh`. `collectState()`. |
| `scripts/hygiene.ts` | CLI entry: arg parsing, `status` / `reap` / `doctor`, output formatting. |
| `scripts/hygiene.test.ts` | Integration tests against scratch repos in temp dirs. |

The split exists so the only component that can destroy work is pure and exhaustively testable.

**Server plane:**

| File | Responsibility |
|---|---|
| `.github/workflows/check.yml` | Fast lane: typecheck, lint, unit tests, actionlint. |
| `.github/workflows/e2e.yml` | Slow lane: Playwright with Postgres + Redis service containers. |
| `.github/workflows/hygiene.yml` | Delete head branch on merge; weekly merged-branch reaper. |
| `.github/workflows/automerge.yml` | Dependabot auto-merge on green for patch/minor. |
| `.github/dependabot.yml` | Grouped weekly dependency updates. |
| `.github/CODEOWNERS` | Advisory ownership; enforcing once protection is enabled. |
| `.github/pull_request_template.md` | PR checklist. |

**Modified:**

| File | Change |
|---|---|
| `package.json` | Add `hygiene` script; prepend `scripts/*.test.ts` to `test:unit`. |
| `.husky/pre-push` | Create. Block unsigned commits. |
| `.husky/post-merge` | Create. Nudge on reapable worktrees. |
| `CLAUDE.md` | Create. Conventions for the AI-agent actor class. |

---

## Task 1: Pure reap predicate

**Files:**
- Create: `scripts/hygiene-core.ts`
- Test: `scripts/hygiene-core.test.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/hygiene-core.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { type WorktreeState, isReapable } from "./hygiene-core";

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
  const blockers: Array<Partial<WorktreeState>> = [
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx --test scripts/hygiene-core.test.ts`
Expected: FAIL — `Cannot find module './hygiene-core'`

- [ ] **Step 3: Write minimal implementation**

Create `scripts/hygiene-core.ts`:

```ts
export const PROTECTED_BRANCHES = ["main", "master"];

export type WorktreeState = {
  branch: string | null;
  dirtyCount: number;
  existsOnOrigin: boolean;
  isLocked: boolean;
  isPrimary: boolean;
  mergedIntoMain: boolean;
  path: string;
  unpushedCommits: number;
};

export type ReapVerdict = {
  reasons: string[];
  safe: boolean;
};

/**
 * Decides whether a worktree can be deleted without losing work.
 *
 * Safe requires all four spec conditions — clean, on origin, fully pushed,
 * merged — plus structural guards that stop the predicate from recommending
 * deletion of the primary checkout or a protected branch.
 */
export function isReapable(state: WorktreeState): ReapVerdict {
  const reasons: string[] = [];

  if (state.isPrimary) {
    reasons.push("primary worktree");
  }

  if (state.isLocked) {
    reasons.push("locked");
  }

  if (state.branch === null) {
    reasons.push("detached HEAD");
  } else if (PROTECTED_BRANCHES.includes(state.branch)) {
    reasons.push(`protected branch: ${state.branch}`);
  }

  if (state.dirtyCount > 0) {
    reasons.push(`${state.dirtyCount} uncommitted file(s)`);
  }

  if (!state.existsOnOrigin) {
    reasons.push("branch not on origin");
  }

  if (state.unpushedCommits > 0) {
    reasons.push(`${state.unpushedCommits} unpushed commit(s)`);
  }

  if (!state.mergedIntoMain) {
    reasons.push("not merged into main");
  }

  return { reasons, safe: reasons.length === 0 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsx --test scripts/hygiene-core.test.ts`
Expected: PASS — 8 tests passing

- [ ] **Step 5: Commit**

```bash
git add scripts/hygiene-core.ts scripts/hygiene-core.test.ts
git commit -S -m "feat(hygiene): add pure worktree reap predicate"
```

**Hardening applied during execution.** Code review of this task found three
fail-open gaps in the version above. They landed in a follow-up commit and
should be treated as part of Task 1:

1. `PROTECTED_BRANCHES` is an exported mutable array — a consumer could empty it
   and silently disable protection process-wide. Wrap it:
   `export const PROTECTED_BRANCHES: readonly string[] = Object.freeze([...])`.
2. The protected-branch comparison is untrimmed, so `"main "` from stray git
   plumbing whitespace reads as an ordinary reapable branch. Trim before
   comparing, and treat a whitespace-only branch as detached. Do not lowercase —
   git refs are case-sensitive.
3. `dirtyCount > 0` is `false` when the value is `NaN`, so malformed input is
   treated as clean and can yield `safe: true`. Require
   `Number.isInteger(n) && n >= 0`; otherwise push
   `` `invalid dirty count: ${n}` `` / `` `invalid unpushed count: ${n}` ``
   instead of the normal reason.

Three extra tests cover these: structural guards accumulating with each other,
whitespace-padded protected branches, and invalid counters failing closed.
Total after hardening: 11 tests.

---

## Task 2: Worktree state collection

**Files:**
- Create: `scripts/hygiene-git.ts`

No unit test here by design — this layer is pure I/O against `git` and `gh`, and is covered by the integration tests in Task 6.

- [ ] **Step 1: Write the implementation**

Create `scripts/hygiene-git.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorktreeState } from "./hygiene-core";

const run = promisify(execFile);

type RawWorktree = {
  branch: string | null;
  isLocked: boolean;
  isPrimary: boolean;
  path: string;
};

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

/** Returns null when the command fails, so callers can treat it as "unknown". */
async function tryGit(args: string[], cwd?: string): Promise<string | null> {
  try {
    return await git(args, cwd);
  } catch {
    return null;
  }
}

export function parseWorktreeList(porcelain: string): RawWorktree[] {
  const blocks = porcelain.split("\n\n").filter((b) => b.trim().length > 0);

  return blocks.map((block, index) => {
    const lines = block.split("\n");
    const path = lines
      .find((l) => l.startsWith("worktree "))
      ?.slice("worktree ".length);
    const branchRef = lines
      .find((l) => l.startsWith("branch "))
      ?.slice("branch ".length);

    return {
      branch: branchRef ? branchRef.replace("refs/heads/", "") : null,
      isLocked: lines.some((l) => l === "locked" || l.startsWith("locked ")),
      isPrimary: index === 0,
      path: path ?? "",
    };
  });
}

async function countDirty(path: string): Promise<number> {
  const out = await tryGit(["status", "--porcelain"], path);
  if (out === null || out === "") {
    return 0;
  }
  return out.split("\n").length;
}

async function existsOnOrigin(branch: string): Promise<boolean> {
  const out = await tryGit([
    "ls-remote",
    "--heads",
    "origin",
    `refs/heads/${branch}`,
  ]);
  return out !== null && out.length > 0;
}

async function countUnpushed(path: string, branch: string): Promise<number> {
  // Commits on this branch that no remote ref can reach. Correct whether or
  // not origin/<branch> exists, unlike an `origin/<branch>..<branch>` range —
  // that range's fallback counted every ancestor of the branch, reporting 19
  // for a branch that was really 6 ahead.
  const out = await tryGit(
    ["rev-list", "--count", branch, "--not", "--remotes"],
    path
  );
  if (out === null) {
    // Unknown. Assume unpushed so the predicate fails closed.
    return 1;
  }
  const parsed = Number.parseInt(out, 10);
  return Number.isNaN(parsed) ? 1 : parsed;
}

/**
 * Merge state comes from `gh`, never from local refs. The server plane is the
 * source of truth for what is merged; the local plane only ever asks.
 */
export async function isMergedViaGh(branch: string): Promise<boolean> {
  try {
    const { stdout } = await run("gh", [
      "pr",
      "list",
      "--state",
      "merged",
      "--head",
      branch,
      "--json",
      "number",
      "--limit",
      "1",
    ]);
    const parsed = JSON.parse(stdout) as Array<{ number: number }>;
    return parsed.length > 0;
  } catch {
    return false;
  }
}

export type MergeChecker = (branch: string) => Promise<boolean>;

/**
 * `checkMerged` is injectable so integration tests can exercise real git
 * worktrees without calling GitHub.
 */
export async function collectState(
  checkMerged: MergeChecker = isMergedViaGh,
  cwd?: string
): Promise<WorktreeState[]> {
  await tryGit(["fetch", "--prune", "--quiet", "origin"], cwd);

  const porcelain = await git(["worktree", "list", "--porcelain"], cwd);
  const raw = parseWorktreeList(porcelain);

  return await Promise.all(
    raw.map(async (wt): Promise<WorktreeState> => {
      if (wt.branch === null) {
        return {
          branch: null,
          dirtyCount: await countDirty(wt.path),
          existsOnOrigin: false,
          isLocked: wt.isLocked,
          isPrimary: wt.isPrimary,
          mergedIntoMain: false,
          path: wt.path,
          unpushedCommits: 0,
        };
      }

      const [dirtyCount, onOrigin, unpushedCommits, mergedIntoMain] =
        await Promise.all([
          countDirty(wt.path),
          existsOnOrigin(wt.branch),
          countUnpushed(wt.path, wt.branch),
          checkMerged(wt.branch),
        ]);

      return {
        branch: wt.branch,
        dirtyCount,
        existsOnOrigin: onOrigin,
        isLocked: wt.isLocked,
        isPrimary: wt.isPrimary,
        mergedIntoMain,
        path: wt.path,
        unpushedCommits,
      };
    })
  );
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm exec tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Smoke-test against the real repo**

Run:
```bash
pnpm exec tsx -e "import('./scripts/hygiene-git').then(async (m) => console.log(await m.collectState()))"
```
Expected: a two-element array. The primary checkout with `isPrimary: true`, and `agent-runner-v1-contract` with `dirtyCount: 24`, `existsOnOrigin: false`, and `unpushedCommits: 6`. A large `unpushedCommits` such as 19 means `countUnpushed` is counting ancestors rather than commits unreachable from any remote — check the `--not --remotes` form.

- [ ] **Step 4: Commit**

```bash
git add scripts/hygiene-git.ts
git commit -S -m "feat(hygiene): collect worktree state from git and gh"
```

---

## Task 3: CLI with the `status` subcommand

**Files:**
- Create: `scripts/hygiene.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the implementation**

Create `scripts/hygiene.ts`:

```ts
#!/usr/bin/env tsx
import { type ReapVerdict, type WorktreeState, isReapable } from "./hygiene-core";
import { collectState } from "./hygiene-git";

export const WORKTREE_SOFT_CAP = 3;

type Row = { state: WorktreeState; verdict: ReapVerdict };

function classify(states: WorktreeState[]): Row[] {
  return states.map((state) => ({ state, verdict: isReapable(state) }));
}

/** At risk means work exists in exactly one place and could be lost. */
export function isAtRisk(state: WorktreeState): boolean {
  if (state.isPrimary) {
    return false;
  }
  return state.dirtyCount > 0 || !state.existsOnOrigin || state.unpushedCommits > 0;
}

function describe(row: Row): string {
  const { state, verdict } = row;
  const name = state.branch ?? "(detached)";
  const tag = state.isPrimary
    ? "primary"
    : verdict.safe
      ? "reapable"
      : isAtRisk(state)
        ? "AT RISK"
        : "active";

  return `  [${tag}] ${name}\n      ${state.path}\n      ${verdict.reasons.join(", ") || "no blockers"}`;
}

async function status(): Promise<number> {
  const rows = classify(await collectState());
  const secondary = rows.filter((r) => !r.state.isPrimary);
  const reapable = rows.filter((r) => r.verdict.safe);
  const atRisk = secondary.filter((r) => isAtRisk(r.state));

  console.log(`\nWorktrees (${rows.length} total, ${secondary.length} secondary)\n`);
  for (const row of rows) {
    console.log(describe(row));
  }

  if (secondary.length > WORKTREE_SOFT_CAP) {
    console.log(
      `\nWARNING: ${secondary.length} secondary worktrees exceeds the soft cap of ${WORKTREE_SOFT_CAP}.`
    );
  }

  if (reapable.length > 0) {
    console.log(`\n${reapable.length} worktree(s) reapable. Run: pnpm hygiene reap --yes`);
  }

  if (atRisk.length > 0) {
    console.log(`\n${atRisk.length} worktree(s) AT RISK — work exists only on this machine:`);
    for (const row of atRisk) {
      console.log(`  ${row.state.branch ?? "(detached)"}: ${row.verdict.reasons.join(", ")}`);
    }
    console.log("\nPush these branches before doing anything else.");
    return 1;
  }

  return 0;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "status";

  if (command === "status") {
    process.exit(await status());
  }

  console.error(`Unknown command: ${command}`);
  console.error("Usage: pnpm hygiene [status]");
  process.exit(2);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(2);
});
```

- [ ] **Step 2: Add the `hygiene` script**

In `package.json`, in the `"scripts"` block, add this line immediately after the `"fix"` entry:

```json
    "hygiene": "tsx scripts/hygiene.ts",
```

- [ ] **Step 3: Run it against the real repo**

Run: `pnpm hygiene`
Expected: exit code 1. The `agent-runner-v1-contract` worktree listed as `[AT RISK]` with reasons including `24 uncommitted file(s)` and `branch not on origin`. The primary checkout listed as `[primary]`.

Confirm the exit code:
```bash
pnpm hygiene; echo "exit=$?"
```
Expected: `exit=1`

- [ ] **Step 4: Commit**

```bash
git add scripts/hygiene.ts package.json
git commit -S -m "feat(hygiene): add status subcommand with worktree soft cap"
```

---

## Task 4: The `reap` subcommand

**Files:**
- Modify: `scripts/hygiene.ts`

- [ ] **Step 1: Add the reap implementation**

In `scripts/hygiene.ts`, add this import at the top, merging with the existing `node:` imports:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
```

Add after the `status()` function:

```ts
const runCmd = promisify(execFile);

async function reap(confirmed: boolean): Promise<number> {
  const rows = classify(await collectState());
  const reapable = rows.filter((r) => r.verdict.safe);

  if (reapable.length === 0) {
    console.log("Nothing to reap.");
    return 0;
  }

  if (!confirmed) {
    console.log(`\nWould remove ${reapable.length} worktree(s):\n`);
    for (const row of reapable) {
      console.log(`  ${row.state.branch ?? "(detached)"}  ${row.state.path}`);
    }
    console.log("\nDry run. Re-run with --yes to actually remove them.");
    return 0;
  }

  for (const row of reapable) {
    await runCmd("git", ["worktree", "remove", row.state.path]);
    if (row.state.branch !== null) {
      await runCmd("git", ["branch", "-d", row.state.branch]);
    }
    console.log(`Removed ${row.state.branch ?? row.state.path}`);
  }

  console.log(`\nReaped ${reapable.length} worktree(s).`);
  return 0;
}
```

Replace the `main()` function with:

```ts
async function main(): Promise<void> {
  const command = process.argv[2] ?? "status";
  const confirmed = process.argv.includes("--yes");

  if (command === "status") {
    process.exit(await status());
  }

  if (command === "reap") {
    process.exit(await reap(confirmed));
  }

  console.error(`Unknown command: ${command}`);
  console.error("Usage: pnpm hygiene [status|reap [--yes]]");
  process.exit(2);
}
```

- [ ] **Step 2: Verify dry-run is the default**

Run: `pnpm hygiene reap`
Expected: either `Nothing to reap.` or a `Would remove ...` list ending in `Dry run.` — and **no** worktree is actually removed.

Verify nothing changed:
```bash
git worktree list
```
Expected: same two worktrees as before.

- [ ] **Step 3: Commit**

```bash
git add scripts/hygiene.ts
git commit -S -m "feat(hygiene): add reap subcommand, dry-run by default"
```

---

## Task 5: The `doctor` subcommand

**Files:**
- Modify: `scripts/hygiene.ts`

- [ ] **Step 1: Add the doctor implementation**

In `scripts/hygiene.ts`, add after the `reap()` function:

```ts
async function configValue(key: string): Promise<string> {
  try {
    const { stdout } = await runCmd("git", ["config", "--get", key]);
    return stdout.trim();
  } catch {
    return "";
  }
}

async function doctor(): Promise<number> {
  const [signingKey, format] = await Promise.all([
    configValue("user.signingkey"),
    configValue("gpg.format"),
  ]);
  const problems: string[] = [];

  if (signingKey === "") {
    problems.push("user.signingkey is not set");
  }
  if (format === "") {
    problems.push("gpg.format is not set (expected: ssh, openpgp, or x509)");
  }

  if (problems.length > 0) {
    console.error("\nCommit signing is NOT configured:\n");
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    console.error("\nDo not commit until this is fixed.");
    return 1;
  }

  console.log(`Signing configured: ${format} key ${signingKey.slice(0, 32)}...`);
  return 0;
}
```

Add this branch to `main()`, immediately before the `Unknown command` lines:

```ts
  if (command === "doctor") {
    process.exit(await doctor());
  }
```

And update the usage string in `main()` to:

```ts
  console.error("Usage: pnpm hygiene [status|reap [--yes]|doctor]");
```

- [ ] **Step 2: Run it**

Run: `pnpm hygiene doctor`
Expected: `Signing configured: ssh key key::ssh-ed25519 AAAAC3NzaC1lZDI1...` and exit 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/hygiene.ts
git commit -S -m "feat(hygiene): add doctor subcommand for signing config"
```

---

## Task 6: Integration tests against scratch repos

**Files:**
- Create: `scripts/hygiene.test.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/hygiene.test.ts`:

```ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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

  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe" });
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx --test scripts/hygiene.test.ts`
Expected: FAIL — `collectState` does not accept a `cwd` argument, or `parseWorktreeList` is not exported.

If both are already exported with the Task 2 signature `collectState(checkMerged, cwd)`, this test passes immediately. That is acceptable — Task 2 was written to be testable. Confirm by reading the failure output before changing anything.

- [ ] **Step 3: Fix any signature mismatch**

If Step 2 failed, reconcile `scripts/hygiene-git.ts` so that `collectState(checkMerged?: MergeChecker, cwd?: string)` and `parseWorktreeList` are both exported exactly as written in Task 2.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsx --test scripts/hygiene.test.ts`
Expected: PASS — 5 tests passing

- [ ] **Step 5: Commit**

```bash
git add scripts/hygiene.test.ts scripts/hygiene-git.ts
git commit -S -m "test(hygiene): add scratch-repo integration tests"
```

---

## Task 7: Wire hygiene tests into `test:unit`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Prepend the scripts glob**

In `package.json`, replace the `"test:unit"` value. It currently reads:

```json
"test:unit": "tsx --test lib/agents/*.test.ts && pnpm --filter @opencoven/agent-contracts test && pnpm --filter @opencoven/harness test && pnpm --filter @opencoven/local-runner test && pnpm --filter @opencoven/cloud-runner test",
```

Change it to:

```json
"test:unit": "tsx --test scripts/*.test.ts && tsx --test lib/agents/*.test.ts && pnpm --filter @opencoven/agent-contracts test && pnpm --filter @opencoven/harness test && pnpm --filter @opencoven/local-runner test && pnpm --filter @opencoven/cloud-runner test",
```

- [ ] **Step 2: Run the full unit suite**

Run: `pnpm test:unit`
Expected: PASS. The hygiene tests run first, followed by the existing four workspace packages.

- [ ] **Step 3: Verify lint and types are clean**

Run: `pnpm check && pnpm exec tsc --noEmit`
Expected: no errors. If `ultracite` reports formatting issues in `scripts/`, run `pnpm fix` and re-run.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -S -m "chore(test): run hygiene tests in test:unit"
```

---

## Task 8: `pre-push` hook blocking unsigned commits

**Files:**
- Create: `.husky/pre-push`

- [ ] **Step 1: Write the hook**

Create `.husky/pre-push`:

```sh
#!/bin/sh
# Blocks pushes containing unsigned commits.
# Mirrors the global rule: every commit must land Verified on GitHub.

branch="$(git rev-parse --abbrev-ref HEAD)"

if [ "$branch" = "main" ]; then
  echo "WARNING: pushing directly to main."
fi

# Commits about to be pushed. Falls back to origin/main for a new branch
# with no upstream yet.
if git rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
  range='@{u}..HEAD'
else
  range='origin/main..HEAD'
fi

unsigned="$(git log "$range" --pretty='%H %G?' 2>/dev/null | awk '$2 != "G" {print}')"

if [ -n "$unsigned" ]; then
  echo ""
  echo "BLOCKED: the following commits are not signed:"
  echo "$unsigned"
  echo ""
  echo "Sign them before pushing (git rebase --exec 'git commit --amend --no-edit -S')."
  exit 1
fi

exit 0
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x .husky/pre-push`

- [ ] **Step 3: Verify it passes on signed commits**

Run: `git push --dry-run origin HEAD`
Expected: no `BLOCKED` output. Your commits so far are signed, so the hook is a no-op.

- [ ] **Step 4: Verify it blocks an unsigned commit**

```bash
git commit -S --allow-empty -m "temp: signed marker"
git -c commit.gpgsign=false commit --allow-empty -m "temp: unsigned probe"
git push --dry-run origin HEAD; echo "exit=$?"
```
Expected: `BLOCKED:` appears, the unsigned probe commit is listed, and `exit=1`.

Then undo the probe:
```bash
git reset --hard HEAD~2
```
Expected: both temp commits gone. Confirm with `git log --oneline -1`.

- [ ] **Step 5: Commit**

```bash
git add .husky/pre-push
git commit -S -m "feat(husky): block pushes containing unsigned commits"
```

---

## Task 9: `post-merge` hook nudge

**Files:**
- Create: `.husky/post-merge`

- [ ] **Step 1: Write the hook**

Create `.husky/post-merge`:

```sh
#!/bin/sh
# After pulling main, quietly point out worktrees that are reapable or at risk.
# Never blocks — this is a nudge, not a gate.

if [ "$(git rev-parse --abbrev-ref HEAD)" != "main" ]; then
  exit 0
fi

corepack pnpm hygiene status >/dev/null 2>&1 || \
  echo "hygiene: worktrees need attention — run 'pnpm hygiene'"

exit 0
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x .husky/post-merge`

- [ ] **Step 3: Verify it does not block**

Run: `sh .husky/post-merge; echo "exit=$?"`
Expected: `exit=0`. Because `agent-runner-v1-contract` is currently at risk, the nudge line should also print.

- [ ] **Step 4: Commit**

```bash
git add .husky/post-merge
git commit -S -m "feat(husky): nudge on reapable worktrees after merge"
```

---

## Task 10: Repository `CLAUDE.md`

**Files:**
- Create: `CLAUDE.md`

- [ ] **Step 1: Write the file**

Create `CLAUDE.md`:

````markdown
# Working in coven-agents

## Branches

Name branches `<type>/<short-slug>`, where type is one of `feat`, `fix`,
`chore`, `docs`, or `copilot`.

Never commit directly to `main`. `main` is the source of truth for what is
merged, and the hygiene tooling trusts it.

## Worktrees

One worktree per task. Soft cap is **3** secondary worktrees for this repo —
`pnpm hygiene` warns above that.

**Push your branch before you go idle.** An unpushed branch exists on exactly
one machine. This is the single most common way work is lost here.

## Before opening a pull request

```bash
pnpm hygiene          # no AT RISK worktrees
pnpm check            # lint
pnpm typecheck        # types
pnpm test:unit        # unit tests
```

## Commits must be signed

Every commit must land Verified on GitHub. Pass `-S` to every `git commit`,
including amends.

```bash
git commit -S -m "feat(scope): what changed"
```

Run `pnpm hygiene doctor` before the first commit of a session to confirm
signing is configured. The `pre-push` hook blocks unsigned commits, but it is
per-clone — do not rely on it as the only guard.

## Cleaning up

```bash
pnpm hygiene          # report
pnpm hygiene reap     # dry run
pnpm hygiene reap --yes
```

`reap` only removes worktrees that are clean, pushed, on origin, and confirmed
merged by `gh`. It refuses everything else. If it refuses something you expect
it to remove, the branch is not actually merged — check the PR, do not force it.
````

- [ ] **Step 2: Verify formatting passes**

Run: `pnpm check`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -S -m "docs: add repo conventions for agent sessions"
```

---

## Task 11: `check.yml` fast lane

**Files:**
- Create: `.github/workflows/check.yml`

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/check.yml`:

```yaml
name: check

on:
  # Scoped to main on purpose. Branch pushes are covered by pull_request;
  # listening to both would double every run and double the minute spend.
  push:
    branches: [main]
  pull_request:

concurrency:
  group: check-${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    name: check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - run: pnpm typecheck

      - run: pnpm check

      - run: pnpm test:unit

  actionlint:
    name: actionlint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: raven-actions/actionlint@v2
```

The job names `check` and `actionlint` are the protection-ready seam. When
branch protection becomes available, these two strings go into required status
checks unchanged.

- [ ] **Step 2: Validate the YAML locally**

Run:
```bash
pnpm exec tsx -e "import('node:fs').then(fs => console.log(fs.readFileSync('.github/workflows/check.yml','utf8').length + ' bytes'))"
```
Expected: a byte count, confirming the file exists and is readable.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/check.yml
git commit -S -m "ci: add fast-lane check workflow"
```

---

## Task 12: `e2e.yml` slow lane

**Files:**
- Create: `.github/workflows/e2e.yml`

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/e2e.yml`:

```yaml
name: e2e

on:
  pull_request:
    branches: [main]
    # `labeled` must be listed explicitly — it is not a default type, and
    # without it the run-e2e escape hatch below can never fire.
    types: [opened, synchronize, reopened, labeled]

concurrency:
  group: e2e-${{ github.ref }}
  cancel-in-progress: true

jobs:
  e2e:
    name: e2e
    # Runs on every PR to main, or on demand via the run-e2e label.
    if: >-
      github.event.action != 'labeled' ||
      contains(github.event.pull_request.labels.*.name, 'run-e2e')
    runs-on: ubuntu-latest
    timeout-minutes: 20

    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_DB: coven_test
          POSTGRES_PASSWORD: postgres
          POSTGRES_USER: postgres
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-retries 5
          --health-timeout 5s
        ports:
          - 5432:5432

      redis:
        image: redis:7
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-retries 5
          --health-timeout 5s
        ports:
          - 6379:6379

    env:
      # Placeholder values. The four specs assert on page rendering and auth
      # form structure and never reach a code path that calls these services.
      # A spec that does must mock at the network boundary, not promote a live
      # secret into CI.
      AI_GATEWAY_API_KEY: placeholder-not-a-real-key
      BLOB_READ_WRITE_TOKEN: placeholder-not-a-real-token
      POSTGRES_URL: postgres://postgres:postgres@localhost:5432/coven_test
      REDIS_URL: redis://localhost:6379

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - name: Generate a per-run auth secret
        run: echo "AUTH_SECRET=$(openssl rand -base64 32)" >> "$GITHUB_ENV"

      - name: Run database migrations
        run: pnpm db:migrate

      - name: Install Playwright browsers
        run: pnpm exec playwright install --with-deps chromium

      - run: pnpm test

      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 7
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/e2e.yml
git commit -S -m "ci: add e2e workflow with service containers"
```

---

## Task 13: `hygiene.yml` branch cleanup

**Files:**
- Create: `.github/workflows/hygiene.yml`

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/hygiene.yml`:

```yaml
name: hygiene

on:
  pull_request:
    types: [closed]
  schedule:
    # Mondays at 09:00 UTC.
    - cron: "0 9 * * 1"
  workflow_dispatch:

permissions:
  contents: write
  issues: write
  pull-requests: read

jobs:
  delete-merged-head:
    name: delete merged head branch
    if: >-
      github.event_name == 'pull_request' &&
      github.event.pull_request.merged == true &&
      github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - name: Delete the head branch
        env:
          BRANCH: ${{ github.event.pull_request.head.ref }}
          GH_TOKEN: ${{ github.token }}
        run: |
          if [ "$BRANCH" = "main" ]; then
            echo "Refusing to delete main."
            exit 0
          fi
          gh api -X DELETE \
            "repos/${GITHUB_REPOSITORY}/git/refs/heads/${BRANCH}" \
            && echo "Deleted ${BRANCH}" \
            || echo "Already deleted: ${BRANCH}"

  reap-merged-branches:
    name: reap merged branches
    if: github.event_name != 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Delete remote branches already merged into main
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          reaped=""
          for ref in $(git branch -r --merged origin/main \
                        | grep -v 'origin/main$' \
                        | grep -v 'HEAD' \
                        | sed 's|origin/||' \
                        | tr -d ' '); do
            case "$ref" in
              main|master) continue ;;
            esac
            gh api -X DELETE \
              "repos/${GITHUB_REPOSITORY}/git/refs/heads/${ref}" \
              && reaped="${reaped}- ${ref}"$'\n'
          done

          if [ -z "$reaped" ]; then
            echo "Nothing to reap."
            exit 0
          fi

          printf 'Reaped:\n%s' "$reaped"
          {
            echo "Branches deleted on $(date -u +%Y-%m-%d):"
            echo ""
            printf '%s' "$reaped"
          } > body.md

          existing=$(gh issue list --label branch-hygiene --state open \
                      --json number --jq '.[0].number // empty')
          if [ -n "$existing" ]; then
            gh issue comment "$existing" --body-file body.md
          else
            gh issue create --title "Branch hygiene log" \
              --label branch-hygiene --body-file body.md
          fi
```

- [ ] **Step 2: Create the label the workflow depends on**

Run:
```bash
gh label create branch-hygiene \
  --description "Rolling log of automatically reaped branches" \
  --color ededed
```
Expected: `✓ Label "branch-hygiene" created`. If it already exists, the command reports so — that is fine.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/hygiene.yml
git commit -S -m "ci: delete merged branches on merge and weekly"
```

---

## Task 14: Dependabot grouping and auto-merge

**Files:**
- Create: `.github/dependabot.yml`
- Create: `.github/workflows/automerge.yml`

- [ ] **Step 1: Write the Dependabot config**

Create `.github/dependabot.yml`:

```yaml
version: 2

updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
      day: monday
    open-pull-requests-limit: 3
    groups:
      # One grouped PR for safe bumps instead of a trickle of individual ones.
      minor-and-patch:
        applies-to: version-updates
        update-types:
          - minor
          - patch
      security:
        applies-to: security-updates
        patterns:
          - "*"
    commit-message:
      prefix: "chore(deps)"

  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
      day: monday
    groups:
      actions:
        patterns:
          - "*"
    commit-message:
      prefix: "chore(ci)"
```

- [ ] **Step 2: Write the auto-merge workflow**

Create `.github/workflows/automerge.yml`:

```yaml
name: automerge

on: pull_request_target

permissions:
  contents: write
  pull-requests: write

jobs:
  automerge:
    name: automerge
    if: github.actor == 'dependabot[bot]'
    runs-on: ubuntu-latest
    steps:
      - name: Fetch dependency metadata
        id: meta
        uses: dependabot/fetch-metadata@v2
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}

      - name: Enable auto-merge for patch and minor bumps
        if: >-
          steps.meta.outputs.update-type ==
            'version-update:semver-patch' ||
          steps.meta.outputs.update-type ==
            'version-update:semver-minor'
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PR_URL: ${{ github.event.pull_request.html_url }}
        run: gh pr merge --auto --squash "$PR_URL"

      - name: Label major bumps for human review
        if: >-
          steps.meta.outputs.update-type ==
            'version-update:semver-major'
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PR_URL: ${{ github.event.pull_request.html_url }}
        run: gh pr edit "$PR_URL" --add-label needs-human-review
```

Note: auto-merge waits for required checks. Until branch protection is
available there are no required checks, so `--auto` merges as soon as GitHub
allows. This is the known advisory-mode gap from the spec, and it closes on its
own the moment protection is enabled.

- [ ] **Step 3: Create the review label**

Run:
```bash
gh label create needs-human-review \
  --description "Major version bump; do not auto-merge" \
  --color d93f0b
```
Expected: `✓ Label "needs-human-review" created`

- [ ] **Step 4: Enable auto-merge on the repository**

Run:
```bash
gh api -X PATCH repos/OpenCoven/coven-agents \
  -F allow_auto_merge=true \
  --jq '.allow_auto_merge'
```
Expected: `true`

- [ ] **Step 5: Commit**

```bash
git add .github/dependabot.yml .github/workflows/automerge.yml
git commit -S -m "ci: group dependabot updates and auto-merge safe bumps"
```

---

## Task 15: CODEOWNERS and PR template

**Files:**
- Create: `.github/CODEOWNERS`
- Create: `.github/pull_request_template.md`

- [ ] **Step 1: Write CODEOWNERS**

Create `.github/CODEOWNERS`:

```
# Advisory until branch protection is enabled, at which point these become
# required reviewers with no further changes needed.

*                       @BunsDev

/worker/                @BunsDev
/local-runner/          @BunsDev
/packages/              @BunsDev
/.github/               @BunsDev
/scripts/               @BunsDev
```

- [ ] **Step 2: Write the PR template**

Create `.github/pull_request_template.md`:

```markdown
## What changed

<!-- One or two sentences. -->

## Why

<!-- Link the issue, or explain the motivation. -->

## Verification

- [ ] `pnpm check` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test:unit` passes
- [ ] `pnpm hygiene` reports no AT RISK worktrees
- [ ] All commits are signed (`git log --pretty='%G?'` shows only `G`)

## Notes

<!-- Anything a reviewer should know. Delete if empty. -->
```

- [ ] **Step 3: Commit**

```bash
git add .github/CODEOWNERS .github/pull_request_template.md
git commit -S -m "chore(github): add CODEOWNERS and PR template"
```

---

## Task 16: Create the Coven Agents board

This task uses `gh` against the live org. It creates no files.

- [ ] **Step 1: Create the project**

Run:
```bash
gh project create --owner OpenCoven --title "Coven Agents" --format json
```
Expected: JSON containing `"number"` and an `id` starting `PVT_`. **Record the number** — later steps need it. Substitute it for `<N>` below.

- [ ] **Step 2: Add the Runner field**

Run:
```bash
gh project field-create <N> --owner OpenCoven \
  --name "Runner" \
  --data-type SINGLE_SELECT \
  --single-select-options "Cloud,Local,Control plane,Shared"
```
Expected: JSON describing the created field.

- [ ] **Step 3: Add the Size field**

Run:
```bash
gh project field-create <N> --owner OpenCoven \
  --name "Size" \
  --data-type SINGLE_SELECT \
  --single-select-options "XS,S,M,L,XL"
```
Expected: JSON describing the created field.

- [ ] **Step 4: Verify the schema**

Run:
```bash
gh project field-list <N> --owner OpenCoven
```
Expected: `Status`, `Runner`, `Size`, and `Priority` all present.

Two corrections found during execution. `Priority` does **not** exist by
default and must be created like the others. And `Status` can be given its
`In review` option through GraphQL after all — `gh project field-list` cannot
edit it, but `updateProjectV2Field` can, passing the full option list:

```bash
gh api graphql -f query='
mutation($fieldId: ID!) {
  updateProjectV2Field(input: {
    fieldId: $fieldId
    singleSelectOptions: [
      {name: "Todo", color: GRAY, description: ""}
      {name: "In Progress", color: YELLOW, description: ""}
      {name: "In review", color: PURPLE, description: ""}
      {name: "Done", color: GREEN, description: ""}
    ]
  }) { projectV2Field { ... on ProjectV2SingleSelectField { options { name } } } }
}' -F fieldId=<STATUS_FIELD_ID>
```

- [ ] **Step 5: Enable built-in workflows**

Open the project → **⋯ → Workflows** and enable:

- **Auto-add to project** — filter `repo:OpenCoven/coven-agents is:issue,pr is:open`
- **Item closed** → set Status to `Done`
- **Pull request merged** → set Status to `Done`

This step genuinely cannot be scripted. The GraphQL schema exposes
`ProjectV2Workflow` for reading and `deleteProjectV2Workflow` for removal, but
no create or update mutation exists. Verified against the live schema.

**`Code review requested → In review` was in this plan and does not exist.**
The board offers exactly six built-ins — auto-add sub-issues, auto-close issue,
item added, item closed, pull request linked to issue, and pull request merged.
None fires on a review request, so `In review` has to be set by hand.

That leaves two manual transitions rather than one. `Todo → In progress` is
manual by design: it marks the point where someone commits to the work, and
inferring it from branch creation would mark abandoned experiments as active.
`→ In review` is manual because nothing can automate it.

- [ ] **Step 6: Verify auto-add works**

Run:
```bash
gh issue create --repo OpenCoven/coven-agents \
  --title "Board smoke test" \
  --body "Verifying auto-add. Close me."
```
Then:
```bash
gh project item-list <N> --owner OpenCoven --format json \
  | grep -c "Board smoke test"
```
Expected: `1`. Auto-add can take up to a minute; re-run if it returns `0` on the first try.

Then close it and confirm it flips to Done:
```bash
gh issue close <issue-number> --repo OpenCoven/coven-agents
```
Expected: within a minute, the item's Status shows `Done` on the board.

---

## Migration runbook

These tasks operate on live state. Run them **in order**. Nothing destructive
happens until the at-risk work is safe.

### Task 17: Rescue the unpushed worktree

- [ ] **Step 1: Concurrency check**

Run:
```bash
ps -ef | grep ' claude --' | grep -v grep
```
Expected: a list of PIDs. If more than one session is live, identify whether
any owns
`/Users/buns/.config/superpowers/worktrees/coven-agents/agent-runner-v1-contract`:

```bash
for pid in $(pgrep -f ' claude --'); do
  echo "$pid -> $(lsof -p "$pid" 2>/dev/null | awk '$4=="cwd"{print $9}')"
done
```

**If another session owns that worktree, STOP.** Coordinate with the user
before continuing. Do not race it.

- [ ] **Step 2: Review what is uncommitted**

Run:
```bash
cd /Users/buns/.config/superpowers/worktrees/coven-agents/agent-runner-v1-contract
git status --porcelain
git diff --stat
```
Expected: 24 entries — 19 modified, 1 deleted (`worker/src/worker-secrets.d.ts`),
and 5 untracked (`worker/src/env-contract.ts`, `worker/src/env-contract.test.ts`,
`worker/src/yolo-agent.test.ts`, `worker/test-support/`, `worker/tsconfig.test.json`).

Read the diff before committing it. Do not commit blind.

- [ ] **Step 3: Confirm signing, then commit**

```bash
git config --get user.signingkey
git add -A
git commit -S -m "feat(agent-runner): add env contract and run-state hardening"
```

- [ ] **Step 4: Verify the commit is signed**

Run: `git log -1 --show-signature`
Expected: output contains `Good "git" signature`. If it does not, **STOP — do not push.**

- [ ] **Step 5: Push for backup**

```bash
git push -u origin copilot/agent-runner-v1-contract
```
Expected: branch created on origin. The largest risk in the repo is now retired.

Verify:
```bash
git ls-remote --heads origin copilot/agent-runner-v1-contract
```
Expected: one line with a SHA.

### Task 18: Land the scaffolding

- [ ] **Step 1: Return to the primary checkout**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/coven-agents`

- [ ] **Step 2: Move the work onto a branch**

Tasks 1–15 committed to whatever branch was checked out. If that was `main`,
move those commits onto a feature branch now:

```bash
git branch chore/git-lifecycle-automation
git reset --hard origin/main
git checkout chore/git-lifecycle-automation
```

Verify: `git log --oneline origin/main..HEAD` lists the Task 1–15 commits.

- [ ] **Step 3: Run the full local suite**

The scaffolding PR introduces the checks, so it cannot be gated by them. Run
them by hand instead:

```bash
pnpm check && pnpm typecheck && pnpm test:unit
```
Expected: all pass.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin chore/git-lifecycle-automation
gh pr create --fill --base main
```
Expected: PR URL. Confirm `check` and `actionlint` both appear and go green —
this is the first proof the server plane works.

- [ ] **Step 5: Merge**

```bash
gh pr merge --squash --delete-branch
```
Expected: merged, and the head branch deleted by `hygiene.yml`.

### Task 19: Resolve PR #4

- [ ] **Step 1: Ask Dependabot to recreate**

Run:
```bash
gh pr comment 4 --repo OpenCoven/coven-agents --body "@dependabot recreate"
```
Expected: comment posted. Within a few minutes Dependabot force-pushes a
rebased, grouped PR.

- [ ] **Step 2: Verify it is no longer conflicting**

Run:
```bash
gh pr view 4 --repo OpenCoven/coven-agents --json mergeable,title --jq '.'
```
Expected: `"mergeable": "MERGEABLE"`.

If it is still `CONFLICTING` after ten minutes, close it — the next scheduled
run picks the bump up under the new grouping:
```bash
gh pr close 4 --repo OpenCoven/coven-agents \
  --comment "Superseded by grouped dependabot config."
```

### Task 20: Prune the two dead branches

- [ ] **Step 1: Confirm both are fully merged**

Run:
```bash
git fetch --prune origin
for b in chore/dependabot-remediation feat/keyless-multi-harness-execution; do
  echo "$b ahead: $(git rev-list --count origin/main..origin/$b)"
done
```
Expected: `ahead: 0` for both. **If either is non-zero, stop and investigate.**

- [ ] **Step 2: Delete them**

```bash
gh api -X DELETE repos/OpenCoven/coven-agents/git/refs/heads/chore/dependabot-remediation
gh api -X DELETE repos/OpenCoven/coven-agents/git/refs/heads/feat/keyless-multi-harness-execution
```
Expected: empty responses (HTTP 204).

- [ ] **Step 3: Verify**

Run: `git fetch --prune origin && git branch -r`
Expected: only `origin/main`, `origin/copilot/agent-runner-v1-contract`, and
possibly the Dependabot branch remain.

### Task 21: Land agent-runner as the acceptance test

- [ ] **Step 1: Rebase onto main**

```bash
cd /Users/buns/.config/superpowers/worktrees/coven-agents/agent-runner-v1-contract
git fetch origin
git rebase origin/main
```
Expected: resolve conflicts if any. The branch was five behind `main` when this
plan was written and drifts further with every merge, so expect some.

- [ ] **Step 2: Verify every commit is still signed after the rebase**

Rebasing rewrites commits and can drop signatures.

```bash
git log origin/main..HEAD --pretty='%H %G?' | awk '$2 != "G" {print "UNSIGNED:", $0}'
```
Expected: no output. If anything prints, re-sign before pushing:
```bash
git rebase --exec 'git commit --amend --no-edit -S' origin/main
```

- [ ] **Step 3: Push and open the PR**

```bash
git push --force-with-lease
gh pr create --fill --base main
```
Expected: PR opens. `check` and `e2e` both run.

- [ ] **Step 4: Verify the acceptance criteria**

Confirm each, in order:

1. `check.yml` green in under 5 minutes
2. `e2e.yml` runs with service containers and no live secrets
3. The board shows a new item, auto-added
4. Merge with `gh pr merge --squash`; head branch is auto-deleted
5. Board item flips to `Done`

- [ ] **Step 5: Reap the worktree**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-agents
pnpm hygiene
```
Expected: `agent-runner-v1-contract` now listed as `[reapable]`, exit 0.

```bash
pnpm hygiene reap
```
Expected: dry-run listing it.

```bash
pnpm hygiene reap --yes
```
Expected: `Removed copilot/agent-runner-v1-contract`.

- [ ] **Step 6: Confirm the end state**

```bash
git worktree list
git branch -r
gh pr list --state open
```
Expected: **one worktree, one remote branch (`origin/main`), zero open PRs** —
modulo any Dependabot PR still in flight from Task 19.

---

## Self-Review Notes

**Spec coverage.** Every spec section maps to a task: server plane → 11–15;
local plane → 1–10; board → 16; migration → 17–21; testing → 1, 6, 7, and the
Task 21 acceptance criteria.

**Known deviation.** The predicate has six conditions, not the spec's four. See
the note at the top — the literal four-condition version deletes the primary
checkout. Amend the spec once this lands.

**Known gap carried from the spec.** `automerge.yml` uses `--auto`, which waits
on required checks. With no branch protection there are no required checks, so
safe bumps merge as soon as GitHub allows rather than strictly after `check`
goes green. This is inherent to advisory mode and resolves itself when
protection is enabled. Task 14 Step 2 documents it inline.
