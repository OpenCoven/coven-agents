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

async function existsOnOrigin(branch: string, cwd?: string): Promise<boolean> {
  const out = await tryGit(
    ["ls-remote", "--heads", "origin", `refs/heads/${branch}`],
    cwd
  );
  return out !== null && out.length > 0;
}

async function countUnpushed(path: string, branch: string): Promise<number> {
  // Commits on this branch that no remote ref can reach. Correct whether or
  // not origin/<branch> exists, unlike a `origin/<branch>..<branch>` range.
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

export type MergeResult = {
  /** Head SHA the merged PR carried, so a later commit can be told apart. */
  headSha: string | null;
  merged: boolean;
};

/**
 * Merge state comes from `gh`, never from local refs. The server plane is the
 * source of truth for what is merged; the local plane only ever asks.
 *
 * `headRefOid` matters as much as the merged flag: once the remote branch is
 * deleted it is the only remaining proof that a local commit already reached
 * main.
 */
export async function isMergedViaGh(branch: string): Promise<MergeResult> {
  try {
    const { stdout } = await run("gh", [
      "pr",
      "list",
      "--state",
      "merged",
      "--head",
      branch,
      "--json",
      "headRefOid,number",
      "--limit",
      "1",
    ]);
    const parsed = JSON.parse(stdout) as {
      headRefOid?: string;
      number: number;
    }[];
    const pr = parsed.at(0);
    if (pr === undefined) {
      return { headSha: null, merged: false };
    }
    return { headSha: pr.headRefOid ?? null, merged: true };
  } catch {
    return { headSha: null, merged: false };
  }
}

export type MergeChecker = (branch: string) => Promise<MergeResult>;

async function readHeadSha(path: string): Promise<string | null> {
  return await tryGit(["rev-parse", "HEAD"], path);
}

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
          headSha: await readHeadSha(wt.path),
          isLocked: wt.isLocked,
          isPrimary: wt.isPrimary,
          mergedHeadSha: null,
          mergedIntoMain: false,
          path: wt.path,
          unpushedCommits: 0,
        };
      }

      const [dirtyCount, onOrigin, unpushedCommits, merge, headSha] =
        await Promise.all([
          countDirty(wt.path),
          existsOnOrigin(wt.branch, cwd),
          countUnpushed(wt.path, wt.branch),
          checkMerged(wt.branch),
          readHeadSha(wt.path),
        ]);

      return {
        branch: wt.branch,
        dirtyCount,
        existsOnOrigin: onOrigin,
        headSha,
        isLocked: wt.isLocked,
        isPrimary: wt.isPrimary,
        mergedHeadSha: merge.headSha,
        mergedIntoMain: merge.merged,
        path: wt.path,
        unpushedCommits,
      };
    })
  );
}
