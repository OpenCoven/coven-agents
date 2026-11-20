# Working in coven-agents

## Start here

From your task worktree, run `corepack pnpm install --frozen-lockfile`, then `corepack pnpm hygiene doctor`. Installation runs Husky's setup. If the doctor reports a missing hook, run `corepack pnpm exec husky` and repeat the check. Run `corepack pnpm exec next typegen` before the first typecheck in a fresh checkout.

Read the issue and PR before editing. Record the base SHA, the paths you own, and any shared-file handoff. Use the narrowest test first, then the relevant gates below. Report the tested revision, commands, exit codes, and which checks used fixtures or live systems.

Start with [README.md](README.md) for the product and local setup, [the threat model](docs/security/execution-threat-model.md) for trust boundaries, and [the incident runbook](docs/security/incident-response.md) for credential exposure. Keep provider, billing, authentication, and production database credentials out of routine local checks.

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
pnpm build            # the app actually builds
```

**GitHub Actions is disabled for this repository.**
That is deliberate pre-release cost control, not a breakage — do not diagnose
the absent checks as a regression or re-add required status checks while it is
off. It also means the list above is the *only* gate: nothing remote will
catch a break, so run all five before every merge, not just before a PR.

Migration PRs must also run `pnpm db:verify`: it applies the entire migration
chain and requires the GitHub lifecycle, minute-pack, and Stripe reconciliation
PostgreSQL assertions without Playwright.
It owns a disposable PostgreSQL 16 Docker container by default. Alternatively,
set `E2E_POSTGRES_URL` to a disposable PostgreSQL server and explicitly confirm
`E2E_POSTGRES_DISPOSABLE=1`; the role must be able to create databases. The gate
creates and drops only its unique child database, never the supplied database.
Never point these commands at production. Release migration invocations must
use `pnpm db:migrate --strict`; ordinary builds warn and skip without a URL.
`pnpm check` includes the DB-free `pnpm db:check` drift gate: Drizzle generates
against copied migration metadata in temporary output and refuses any new
migration (including column, index, or foreign-key drift). It never leaves
generated files in the working tree or reads local database credentials.

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

## Secret checks

Pre-commit scans the staged index before and after lint-staged. The commit-message hook scans the proposed message. Pre-push scans the outgoing revision range, including messages and blobs from intermediate commits. Run `corepack pnpm secret:scan` for staged files, `corepack pnpm secret:scan:all` for tracked files, and `corepack pnpm secret:scan:history` for locally reachable history.

Report the finding location and category without copying the value or raw logs. Stop publication on findings you cannot classify. A disposable credential belongs in generated test data. When a real credential reaches a remote, follow the incident runbook and rotate it through its owner. Removing a value from the latest tree does not remove it from Git history.

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

The second case is the normal one after a merge. Squashing rewrites the SHA,
so a merged branch's commits look unpushed even though the work is on `main`.
That is not lost work and `reap` will clear it.

With Actions disabled the hygiene workflow no longer deletes merged remote
branches, so they accumulate on origin. `git branch --merged` will not find
them either — squash-merge leaves no ancestry — so prune by asking GitHub for
each branch's PR state rather than trusting git.

Commit anything *after* the merge, though, and the tip no longer matches what
`gh` merged — `reap` protects it and `pnpm hygiene` reports it AT RISK until
you push it.

## Planning and delivery

Use GitHub issues for repository tasks, ownership, dependencies, and acceptance criteria. Use pull requests and landed commits for delivery evidence. [Delivery governance](docs/roadmap/delivery-governance.md) defines when maintainers update issues and the public roadmap.

Keep private task details and metadata out of tracked files, public issues, pull requests, commit messages, and logs.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
