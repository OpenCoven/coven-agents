#!/usr/bin/env tsx
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  branchDeleteFlag,
  isPreservedOnMain,
  isReapable,
  type ReapVerdict,
  type WorktreeState,
} from "./hygiene-core";
import { collectState } from "./hygiene-git";

export const WORKTREE_SOFT_CAP = 3;

export type Row = { state: WorktreeState; verdict: ReapVerdict };

function classify(states: WorktreeState[]): Row[] {
  return states.map((state) => ({ state, verdict: isReapable(state) }));
}

/** At risk means work exists in exactly one place and could be lost. */
export function isAtRisk(state: WorktreeState): boolean {
  if (state.isPrimary) {
    return false;
  }
  if (state.dirtyCount > 0) {
    return true;
  }
  // A merged branch whose remote was deleted has no remote ref and no pushed
  // commits, yet the work is on main. Reporting it as at risk told the user to
  // push commits that had already shipped.
  if (isPreservedOnMain(state)) {
    return false;
  }
  return !state.existsOnOrigin || state.unpushedCommits > 0;
}

export function describe(row: Row): string {
  const { state, verdict } = row;
  const name = state.branch ?? "(detached)";
  const tag = state.isPrimary
    ? "primary"
    : verdict.safe
      ? "reapable"
      : isAtRisk(state)
        ? "AT RISK"
        : "active";
  const detail = state.isPrimary
    ? "current checkout"
    : verdict.reasons.join(", ") || "no blockers";

  return `  [${tag}] ${name}\n      ${state.path}\n      ${detail}`;
}

async function status(): Promise<number> {
  const rows = classify(await collectState());
  const secondary = rows.filter((r) => !r.state.isPrimary);
  const reapable = rows.filter((r) => r.verdict.safe);
  const atRisk = secondary.filter((r) => isAtRisk(r.state));

  console.log(
    `\nWorktrees (${rows.length} total, ${secondary.length} secondary)\n`
  );
  for (const row of rows) {
    console.log(describe(row));
  }

  if (secondary.length > WORKTREE_SOFT_CAP) {
    console.log(
      `\nWARNING: ${secondary.length} secondary worktrees exceeds the soft cap of ${WORKTREE_SOFT_CAP}.`
    );
  }

  if (reapable.length > 0) {
    console.log(
      `\n${reapable.length} worktree(s) reapable. Run: pnpm hygiene reap --yes`
    );
  }

  if (atRisk.length > 0) {
    console.log(
      `\n${atRisk.length} worktree(s) AT RISK — work exists only on this machine:`
    );
    for (const row of atRisk) {
      console.log(
        `  ${row.state.branch ?? "(detached)"}: ${row.verdict.reasons.join(", ")}`
      );
    }
    console.log("\nPush these branches before doing anything else.");
    return 1;
  }

  return 0;
}

const runCmd = promisify(execFile);

/**
 * What happened to one worktree during a reap.
 *
 * `removed` and `branch_left` both mean the worktree directory is gone; they
 * differ only in whether the branch went with it. `kept` means nothing was
 * deleted. Reporting has to tell these apart: the old code logged a single
 * success line after both git calls, so a failed branch delete was reported as
 * a total failure even though the worktree had already been removed.
 */
export type ReapStepResult =
  | { readonly kind: "removed"; readonly label: string }
  | {
      readonly kind: "branch_left";
      readonly label: string;
      readonly branch: string;
      readonly deleteFlag: "-d" | "-D";
      readonly detail: string;
    }
  | { readonly kind: "kept"; readonly label: string; readonly detail: string };

export type ReapDependencies = {
  deleteBranch: (flag: "-d" | "-D", branch: string) => Promise<void>;
  removeWorktree: (path: string) => Promise<void>;
};

function failureDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Removes each reapable worktree, then its branch, recording the two steps
 * independently.
 *
 * The order is forced: git refuses to delete a branch that is still checked
 * out in a worktree, so the worktree must go first. That makes a partially
 * applied removal genuinely reachable, and the caller has to be told about it
 * rather than shown a count that implies nothing happened.
 */
export async function reapWorktrees(
  reapable: Row[],
  deps: ReapDependencies
): Promise<ReapStepResult[]> {
  const results: ReapStepResult[] = [];

  // Removals run sequentially — concurrent `git worktree remove`/
  // `git branch -d` calls against the same repo can race on the shared git
  // index and refs.
  for (const row of reapable) {
    const label = row.state.branch ?? row.state.path;

    try {
      // biome-ignore lint/performance/noAwaitInLoops: sequential by design, see above.
      await deps.removeWorktree(row.state.path);
    } catch (error) {
      results.push({ detail: failureDetail(error), kind: "kept", label });
      continue;
    }

    const { branch } = row.state;
    if (branch === null) {
      results.push({ kind: "removed", label });
      continue;
    }

    // Flag choice is a safety decision, so it lives with the predicate.
    const deleteFlag = branchDeleteFlag(row.state);
    try {
      await deps.deleteBranch(deleteFlag, branch);
      results.push({ kind: "removed", label });
    } catch (error) {
      results.push({
        branch,
        deleteFlag,
        detail: failureDetail(error),
        kind: "branch_left",
        label,
      });
    }
  }

  return results;
}

/** Prints the per-worktree outcome and returns the process exit code. */
export function reportReap(results: ReapStepResult[]): number {
  const worktreesRemoved = results.filter((r) => r.kind !== "kept");
  const branchesLeft = results.filter((r) => r.kind === "branch_left");
  const kept = results.filter((r) => r.kind === "kept");

  for (const result of results) {
    if (result.kind === "removed") {
      console.log(`Removed ${result.label}`);
    } else if (result.kind === "branch_left") {
      console.log(
        `Removed worktree ${result.label}, but its branch remains: ${result.detail}`
      );
    } else {
      console.error(`Failed to reap ${result.label}: ${result.detail}`);
    }
  }

  console.log(
    `\nReaped ${worktreesRemoved.length}/${results.length} worktree(s).`
  );

  if (branchesLeft.length > 0) {
    console.error(
      `\n${branchesLeft.length} branch(es) left behind. Delete when you are sure:`
    );
    for (const result of branchesLeft) {
      console.error(`  git branch ${result.deleteFlag} ${result.branch}`);
    }
  }

  if (kept.length > 0) {
    console.error(
      `${kept.length} failed: ${kept.map((r) => r.label).join(", ")}`
    );
  }

  return branchesLeft.length > 0 || kept.length > 0 ? 1 : 0;
}

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

  const results = await reapWorktrees(reapable, {
    deleteBranch: async (flag, branch) => {
      await runCmd("git", ["branch", flag, branch]);
    },
    removeWorktree: async (path) => {
      await runCmd("git", ["worktree", "remove", path]);
    },
  });

  return reportReap(results);
}

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

  console.log(
    `Signing configured: ${format} key ${signingKey.slice(0, 32)}...`
  );
  return 0;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "status";
  const confirmed = process.argv.includes("--yes");

  if (command === "status") {
    process.exit(await status());
  }

  if (command === "reap") {
    process.exit(await reap(confirmed));
  }

  if (command === "doctor") {
    process.exit(await doctor());
  }

  console.error(`Unknown command: ${command}`);
  console.error("Usage: pnpm hygiene [status|reap [--yes]|doctor]");
  process.exit(2);
}

// Guard so importing this module (e.g. from tests, for `describe()`) doesn't
// also execute the CLI and call `process.exit()`.
const isMain =
  process.argv[1] === undefined
    ? false
    : import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(2);
  });
}
