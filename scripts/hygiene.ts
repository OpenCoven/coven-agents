#!/usr/bin/env tsx
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";
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

    // The guard is repeated here on purpose. Every safety decision lives in
    // `isReapable`, and the caller filters on it — but this function is
    // exported and deletes the operator's only copy of unpushed work, so it
    // refuses an unsafe row itself rather than trusting caller convention.
    //
    // It re-derives the verdict from the state rather than reading
    // `row.verdict`. A Row carries a verdict computed at classify time; a
    // caller that re-reads the worktree, or reuses a Row across a refresh,
    // can hand over a stale verdict that no longer describes the state. Only
    // the state is authoritative at the moment of deletion.
    const verdict = isReapable(row.state);
    if (!verdict.safe) {
      results.push({
        detail: `refused: ${verdict.reasons.join(", ")}`,
        kind: "kept",
        label,
      });
      continue;
    }

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

/** The operator-visible result of a reap: what to print, and the exit code. */
export type ReapReport = {
  readonly code: number;
  readonly err: readonly string[];
  readonly out: readonly string[];
};

/**
 * Turns per-worktree outcomes into the exact lines the operator sees.
 *
 * Split from printing so the reporting contract — which this change exists to
 * fix — can be asserted directly instead of inferred from an exit code.
 */
export function formatReap(results: readonly ReapStepResult[]): ReapReport {
  const worktreesRemoved = results.filter((r) => r.kind !== "kept");
  const branchesLeft = results.filter((r) => r.kind === "branch_left");
  const kept = results.filter((r) => r.kind === "kept");
  const out: string[] = [];
  const err: string[] = [];

  for (const result of results) {
    if (result.kind === "removed") {
      out.push(`Removed ${result.label}`);
    } else if (result.kind === "branch_left") {
      out.push(
        `Removed worktree ${result.label}, but its branch remains: ${result.detail}`
      );
    } else {
      err.push(`Failed to reap ${result.label}: ${result.detail}`);
    }
  }

  const qualifier =
    branchesLeft.length > 0
      ? ` (${branchesLeft.length} branch(es) left behind)`
      : "";
  out.push(
    `\nReaped ${worktreesRemoved.length}/${results.length} worktree(s).${qualifier}`
  );

  if (branchesLeft.length > 0) {
    err.push("\nBranches left behind:");
    for (const result of branchesLeft) {
      // Echoing the command that just failed would be useless. `-d` refuses a
      // squash-merged branch because it cannot see the ancestry, which is the
      // common case here, so name the override explicitly as an override.
      err.push(
        result.deleteFlag === "-d"
          ? `  git branch -d ${result.branch} refused. If you are sure the work is elsewhere: git branch -D ${result.branch}`
          : `  git branch -D ${result.branch} failed: ${result.detail}`
      );
    }
  }

  if (kept.length > 0) {
    err.push(`${kept.length} failed: ${kept.map((r) => r.label).join(", ")}`);
  }

  return {
    code: branchesLeft.length > 0 || kept.length > 0 ? 1 : 0,
    err,
    out,
  };
}

/** Prints the per-worktree outcome and returns the process exit code. */
export function reportReap(results: readonly ReapStepResult[]): number {
  const report = formatReap(results);
  for (const line of report.out) {
    console.log(line);
  }
  for (const line of report.err) {
    console.error(line);
  }
  return report.code;
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
  const [signingKey, format, hooksPath] = await Promise.all([
    configValue("user.signingkey"),
    configValue("gpg.format"),
    configValue("core.hooksPath"),
  ]);
  const problems: string[] = [];

  if (signingKey === "") {
    problems.push("user.signingkey is not set");
  }
  if (format === "") {
    problems.push("gpg.format is not set (expected: ssh, openpgp, or x509)");
  }

  if (process.env.HUSKY === "0") {
    problems.push("Husky is disabled by HUSKY=0");
  }
  if (resolve(hooksPath) === resolve(".husky/_")) {
    try {
      accessSync(resolve(hooksPath, "h"), constants.R_OK);
    } catch {
      problems.push("Missing Husky dispatcher (run corepack pnpm exec husky)");
    }
    for (const hook of ["pre-commit", "commit-msg", "pre-push"]) {
      try {
        accessSync(resolve(hooksPath, hook), constants.X_OK);
      } catch {
        problems.push(
          `Missing executable ${hook} hook (run corepack pnpm exec husky)`
        );
      }
      try {
        accessSync(resolve(".husky", hook), constants.R_OK);
      } catch {
        problems.push(`Missing tracked hook script .husky/${hook}`);
      }
    }
  } else {
    problems.push("Husky is not active (run corepack pnpm exec husky)");
  }

  if (problems.length > 0) {
    console.error("\nCommit safeguards need setup:\n");
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    console.error("\nDo not commit until this is fixed.");
    return 1;
  }

  console.log(
    `Signing configured (${format}). Husky hook entry points are executable.`
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
