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
  const failures: string[] = [];
  let removedCount = 0;
  for (const row of reapable) {
    const label = row.state.branch ?? row.state.path;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: sequential by design, see above.
      await runCmd("git", ["worktree", "remove", row.state.path]);
      if (row.state.branch !== null) {
        // Flag choice is a safety decision, so it lives with the predicate.
        await runCmd("git", [
          "branch",
          branchDeleteFlag(row.state),
          row.state.branch,
        ]);
      }
      console.log(`Removed ${label}`);
      removedCount += 1;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`Failed to reap ${label}: ${detail}`);
      failures.push(label);
    }
  }

  console.log(`\nReaped ${removedCount}/${reapable.length} worktree(s).`);
  if (failures.length > 0) {
    console.error(`${failures.length} failed: ${failures.join(", ")}`);
    return 1;
  }
  return 0;
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
