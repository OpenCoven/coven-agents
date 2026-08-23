export const PROTECTED_BRANCHES: readonly string[] = Object.freeze([
  "main",
  "master",
]);

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

  if (!state.existsOnOrigin) {
    reasons.push("branch not on origin");
  }

  if (!Number.isInteger(state.unpushedCommits) || state.unpushedCommits < 0) {
    reasons.push(`invalid unpushed count: ${state.unpushedCommits}`);
  } else if (state.unpushedCommits > 0) {
    reasons.push(`${state.unpushedCommits} unpushed commit(s)`);
  }

  if (!state.mergedIntoMain) {
    reasons.push("not merged into main");
  }

  return { reasons, safe: reasons.length === 0 };
}
