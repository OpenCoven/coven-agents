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

`git log --pretty='%G?'` reports a state, not a yes or no. `N` (unsigned) and
`B` (bad signature) are failures. `E` is not: it means the commit is signed but
the public key is not on this machine, which is how every GitHub-signed bot
commit looks locally. Never try to "fix" an `E` on a dependabot commit — it is
not yours to rewrite, and GitHub already shows it as Verified.

## Cleaning up

```bash
pnpm hygiene          # report
pnpm hygiene reap     # dry run
pnpm hygiene reap --yes
```

`reap` only removes worktrees with no uncommitted files whose work is provably
somewhere other than your machine. That means either the branch is on origin
with nothing unpushed, or `gh` confirms a merged PR whose head is the commit
this worktree still points at. It refuses everything else. If it refuses
something you expect it to remove, the branch is not actually merged — check
the PR, do not force it.

The second case is the normal one after a merge. The hygiene workflow deletes
the remote branch within seconds, and squashing rewrites the SHA, so a merged
branch has no remote ref and its commits look unpushed. That is not lost work
and `reap` will clear it. Commit anything *after* the merge, though, and the
tip no longer matches what `gh` merged — `reap` protects it and `pnpm hygiene`
reports it AT RISK until you push it.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
