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
