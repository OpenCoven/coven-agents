export const PROTECTED_BRANCHES: readonly string[] = Object.freeze([
  "main",
  "master",
]);

export type WorktreeState = {
  branch: string | null;
  dirtyCount: number;
  existsOnOrigin: boolean;
  /** Local branch tip. Null when it cannot be resolved. */
  headSha: string | null;
  isLocked: boolean;
  isPrimary: boolean;
  /** The head `gh` reports as merged. Null when there is no merged PR. */
  mergedHeadSha: string | null;
  mergedIntoMain: boolean;
  path: string;
  unpushedCommits: number;
};

export type ReapVerdict = {
  reasons: string[];
  safe: boolean;
};

/**
 * True when every commit in this worktree already reached main.
 *
 * "On origin" and "fully pushed" are proxies for that, and they stop being
 * true the moment a PR merges: the hygiene workflow deletes the remote branch,
 * and squashing rewrites the SHA, so the local commits become unreachable from
 * any remote ref. The branch then looks like unpushed work that only exists on
 * this machine — the exact opposite of the truth.
 *
 * Requiring the local tip to equal the head `gh` says was merged is what makes
 * relaxing them safe. A commit made after the merge moves the tip, so it never
 * matches, and the strict conditions apply again.
 */
export function isPreservedOnMain(state: WorktreeState): boolean {
  return (
    state.mergedIntoMain &&
    state.headSha !== null &&
    state.mergedHeadSha !== null &&
    state.headSha === state.mergedHeadSha
  );
}

/**
 * Which `git branch` delete flag a reapable worktree has earned.
 *
 * `-d` is git's ancestry check. It cannot see a squash, so it refuses every
 * branch this repository merges — but it is still a real backstop, because
 * `isReapable` can also pass on the strict path, where the only evidence of a
 * merge is `gh pr list --head`. That matches on branch *name*, so a reused
 * name can match an older merged PR whose head is not this tip.
 *
 * So bypass git only where we hold strictly better evidence than ancestry:
 * the tip is exactly the head `gh` reports as merged. Everywhere else, let
 * `-d` refuse and surface the disagreement.
 */
export function branchDeleteFlag(state: WorktreeState): "-D" | "-d" {
  return isPreservedOnMain(state) ? "-D" : "-d";
}

/**
 * Decides whether a worktree can be deleted without losing work.
 *
 * Safe requires no uncommitted files, a confirmed merge, and proof the commits
 * live somewhere else — either the branch is on origin with nothing unpushed,
 * or `isPreservedOnMain` holds because the merged head is the tip this
 * worktree still points at. The second case covers the normal post-merge
 * state, where the remote branch is already deleted and squashing has made the
 * local commits look unpushed.
 *
 * Structural guards on top of that stop the predicate from ever recommending
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

  const trimmedBranch = state.branch?.trim();

  if (state.branch === null || trimmedBranch === "") {
    reasons.push("detached HEAD");
  } else if (
    trimmedBranch !== undefined &&
    PROTECTED_BRANCHES.includes(trimmedBranch)
  ) {
    reasons.push(`protected branch: ${trimmedBranch}`);
  }

  if (!Number.isInteger(state.dirtyCount) || state.dirtyCount < 0) {
    reasons.push(`invalid dirty count: ${state.dirtyCount}`);
  } else if (state.dirtyCount > 0) {
    reasons.push(`${state.dirtyCount} uncommitted file(s)`);
  }

  // Both conditions below are evidence that the work survives losing this
  // worktree. A head already merged into main is stronger evidence than
  // either, so it substitutes for them — but never for uncommitted files,
  // which by definition reached neither origin nor main.
  const preserved = isPreservedOnMain(state);

  if (!(state.existsOnOrigin || preserved)) {
    reasons.push("branch not on origin");
  }

  if (!Number.isInteger(state.unpushedCommits) || state.unpushedCommits < 0) {
    reasons.push(`invalid unpushed count: ${state.unpushedCommits}`);
  } else if (state.unpushedCommits > 0 && !preserved) {
    reasons.push(`${state.unpushedCommits} unpushed commit(s)`);
  }

  if (!state.mergedIntoMain) {
    reasons.push("not merged into main");
  }

  return { reasons, safe: reasons.length === 0 };
}
