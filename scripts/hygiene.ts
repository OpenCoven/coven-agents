#!/usr/bin/env tsx
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  isReapable,
  type ReapVerdict,
  type WorktreeState,
} from "./hygiene-core";
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
  return (
    state.dirtyCount > 0 || !state.existsOnOrigin || state.unpushedCommits > 0
  );
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

  // Removals run sequentially — concurrent `git worktree remove`/
  // `git branch -d` calls against the same repo can race on the shared git
  // index and refs.
  for (const row of reapable) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential by design, see above.
    await runCmd("git", ["worktree", "remove", row.state.path]);
    if (row.state.branch !== null) {
      await runCmd("git", ["branch", "-d", row.state.branch]);
    }
    console.log(`Removed ${row.state.branch ?? row.state.path}`);
  }

  console.log(`\nReaped ${reapable.length} worktree(s).`);
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

  console.error(`Unknown command: ${command}`);
  console.error("Usage: pnpm hygiene [status|reap [--yes]]");
  process.exit(2);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(2);
});
