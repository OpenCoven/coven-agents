# Git Lifecycle Automation Design

## Goal

Give `coven-agents` a complete branch → PR → review → merge → cleanup → board
lifecycle, enforced by CI, so that branch and worktree counts stay low without
anyone remembering to clean up.

Scope is this repository only. The wider OpenCoven sprawl (40 worktrees across
20 repos, `coven-cave` at 22 branches and 12 open PRs) is out of scope; the
design should generalize, but nothing here reaches outside `coven-agents`.

## Current state

Measured 2026-08-22.

- No `.github/` directory. No workflows, no `dependabot.yml`, no `CODEOWNERS`,
  no PR template.
- No `CLAUDE.md`, `AGENTS.md`, or `CONTRIBUTING.md`. The only agent-facing
  instruction file is `.cursor/rules/ultracite.mdc`. Conventions were never
  written down here, so agents cannot follow them.
- Tests exist but never run automatically: four Playwright specs in
  `tests/e2e/` and unit tests across four workspace packages.
- Four remote branches beyond `main`. Two (`chore/dependabot-remediation`,
  `feat/keyless-multi-harness-execution`) are fully merged with zero commits
  ahead. One (PR #4, `next` 16.2.11) is open and `CONFLICTING`.
- One worktree, `agent-runner-v1-contract`: six commits ahead, five behind, 24
  uncommitted files, and **never pushed to origin**. New `env-contract.ts`,
  `yolo-agent.ts`, and `test-support/` exist only on one laptop.

## Constraints

**Branch protection was unavailable — this has since changed.** As designed,
the repository was private on a free plan and the protection and rulesets APIs
returned 403 with "Upgrade to GitHub Pro or make this repository public."
That forced an advisory design, structured so enabling real protection later
would be a settings change rather than a redesign.

During implementation the repository was made public, which lifted the
restriction. The advisory structure still stands and the protection-ready seam
paid off exactly as intended: stable job names (`Verify`, `Actionlint`) drop
straight into required status checks. Enabling protection also closes the two
gaps this document flags below — bypassable `--no-verify` hooks and
`automerge`'s `--auto` having no required checks to wait on.

**Four actor classes push here**: AI coding agents, the solo maintainer,
Dependabot, and other human collaborators. Any rule that only holds locally
leaves three of the four uncovered.

**Actions was billing-blocked, and minutes were metered.** As designed, private
repositories on the free plan draw on 2,000 minutes/month. In practice the
constraint was harder than metering: every job was rejected before starting
with "recent account payments have failed or your spending limit needs to be
increased." That is why all 16 workflow runs in this repository's history had
failed and the only successes were Dependabot's own infrastructure, which does
not use Actions runners. Making the repository public removed both the block
and the meter.

**End-to-end tests need real infrastructure.** `playwright.config.ts` boots
`pnpm dev` as its `webServer`, and `.env.example` requires `POSTGRES_URL`,
`REDIS_URL`, `AUTH_SECRET`, `AI_GATEWAY_API_KEY`, and a Blob token.

## Architecture

Two planes with an explicit boundary.

The **server plane** is GitHub Actions and Projects. It owns everything that
must hold for all four actor classes: pull request checks, branch deletion on
merge, Dependabot grouping and auto-merge, and board state.

The **local plane** is `scripts/hygiene.ts` and husky hooks. It owns what
GitHub cannot see — worktrees, uncommitted work, and unpushed branches.

A purely server-side design cannot satisfy this goal. GitHub has no concept of
a worktree, and the repository's single riskiest artifact today is 24
uncommitted files in an unpushed worktree. CI would have reported all green
while that work sat unbacked-up.

**Boundary contract: the server plane is the source of truth for what is
merged. The local plane never infers merge state — it asks `gh`.** This is what
makes it safe for a local tool to delete things.

## Server plane

Four workflow files, kept few deliberately.

**`check.yml`** — fast lane. Triggers on every push and pull request. Runs
`typecheck`, `ultracite check`, `test:unit` across all four workspace packages,
and `actionlint`. No service containers, no browsers, pnpm store cached.
Roughly 2–3 minutes per run.

**`e2e.yml`** — slow lane, **opt-in via the `run-e2e` label or manual dispatch**.
Postgres and Redis run as service containers rather than hosted infrastructure.
`AUTH_SECRET` is generated per run. `AI_GATEWAY_API_KEY` and
`BLOB_READ_WRITE_TOKEN` are set to non-empty placeholder values rather than
real credentials.

This section originally claimed the four existing specs "never reach a code
path that calls either service" and could therefore run on every pull request.
**That was wrong.** The first real run proved it: every infrastructure step
passed in 68 seconds — containers, migrations, browsers — and then `pnpm test`
ran 1,144 seconds and was killed by the job timeout. `chat.test.ts` and
`model-selector.test.ts` exercise `/api/models` and the chat route, which do
call the AI gateway; against a placeholder key those calls hang until the 240s
per-test timeout in `playwright.config.ts`.

The workflow is therefore opt-in. Making it automatic again requires either
real credentials in CI or network-boundary mocks in the specs — app work,
outside the scope of this lifecycle design.

Budget: with e2e opt-in, routine spend is the fast lane only — about 100 pushes
and pull request runs at 2.5 minutes is roughly 250 minutes. Public
repositories get unmetered Actions, so this is now a runner-time consideration
rather than a billing one.

**`hygiene.yml`** — two triggers in one file. On `pull_request: closed` where
merged, delete the head branch. On a weekly schedule, find remote branches
fully merged into `main`, delete them, and open or update a single rolling
issue listing what was reaped.

**`automerge.yml`** — enables auto-merge on Dependabot patch and minor bumps
once `check.yml` is green. Major bumps are labeled and left for human review.
Paired with a `dependabot.yml` that groups by ecosystem, replacing the trickle
of individual PRs that produced PR #4 and an entire remediation branch.

Supporting files: `CODEOWNERS` and a pull request template. `CODEOWNERS` is
advisory metadata on the current plan and becomes enforcing the moment
protection is enabled.

**Protection-ready seam:** every job has a stable, named job ID. Enabling branch
protection later means pasting those names into required status checks.

## Local plane

**`scripts/hygiene.ts`**, exposed as `pnpm hygiene`. New `scripts/` directory;
`tsx` is already a devDependency, so no new tooling.

Three subcommands:

- **`status`** (default) — for each worktree of this repo, report dirty file
  count, ahead/behind versus `main`, and whether the branch exists on origin at
  all. Warn above three worktrees for this repository. Exits non-zero only when
  work is at risk.
- **`reap`** — delete only what is provably safe. Dry-run by default; requires
  `--yes` to act.
- **`doctor`** — verify `user.signingkey` and `gpg.format` are both set before
  the session's first commit.

**Reap safety predicate.** A worktree is deleted only if all four hold: the tree
is clean, the branch exists on origin, all local commits are pushed, and `gh`
confirms the branch is merged. Failing any one means the worktree is reported,
never touched.

Against current state, `agent-runner-v1-contract` fails two conditions — dirty
and never pushed — so the tool refuses it and surfaces it.

**Husky hooks.** The existing `pre-commit` (lint-staged) is unchanged.

- **`pre-push`** — block the push if any outgoing commit is unsigned, via
  `git log @{u}..HEAD --pretty='%G?'`, failing on anything that is not `G`.
  Warn on direct pushes to `main`.
- **`post-merge`** — after a `main` pull, run `hygiene status` quietly and print
  a one-line nudge if anything is reapable or at risk.

**`CLAUDE.md` at the repository root** — branch naming (`feat/`, `fix/`,
`chore/`, `copilot/`), one worktree per task, push before going idle, and run
`pnpm hygiene` before opening a pull request. This is what makes the
conventions reachable by the AI-agent actor class.

**Known limit:** `pre-push` and the worktree cap are per-clone and bypassable
with `--no-verify`. Against cooperating agents this is sufficient. It is not a
wall, and closing that gap is exactly what enabling branch protection does.

## Board

One new org-level Project, **Coven Agents**, scoped to this repository. Four
fields, against Teamwork's 26:

- **Status**: `Todo → In progress → In review → Done`
- **Runner**: `Cloud · Local · Control plane · Shared`, matching the repo's
  split across `worker/`, `local-runner/`, `app/`, and `packages/`
- **Size**: `XS–XL`, reusing Teamwork's values so items stay legible if the
  boards are ever merged
- **Priority**

Automation uses Projects' built-in workflows, not a custom Action: auto-add
issues and pull requests from this repository, `pull request merged → Done`,
`item closed → Done`, `review requested → In review`. These cost zero Actions
minutes, which is why the server plane has no `project-sync.yml`.

`Todo → In progress` stays manual. It marks the point where someone commits to
the work; inferring it from branch creation would mark abandoned experiments as
active.

The existing boards were considered and rejected. Teamwork's 338 items are 279
drafts plus 59 from `coven-cave`, and its schema (Bead ID, Bead status, Surface,
Sprint wave) is built for the beads work. `coven-agents` currently appears on no
board at all.

## Migration

Sequenced so nothing destructive happens until at-risk work is safe.

**Step 0 — Concurrency check.** Run `ps -ef | grep ' claude --'` before touching
the worktree. If a live session owns it, stop and coordinate rather than racing
it. This gates Step 1.

**Step 1 — Rescue.** In `agent-runner-v1-contract`: review the 24 files, commit
with `-S`, push to origin. Nothing else runs first. This is non-destructive and
retires the largest risk in the repository. Rebasing onto `main` happens after
the backup push, not before.

**Step 2 — Land the scaffolding.** One pull request: `.github/` (four workflows,
`dependabot.yml`, `CODEOWNERS`, PR template), `scripts/hygiene.ts`, the two
husky hooks, and `CLAUDE.md`. This PR introduces the checks and so cannot be
gated by them; it gets self-review plus a local full run of `check` and `e2e`
before merge.

**Step 3 — Resolve PR #4.** With grouped `dependabot.yml` on `main`, comment
`@dependabot recreate`. It regenerates conflict-free and grouped rather than
hand-resolving a conflict the new config makes obsolete. If it misbehaves, close
it; the next scheduled run picks the bump up.

**Step 4 — Prune the two dead branches.** `chore/dependabot-remediation` and
`feat/keyless-multi-harness-execution`, both zero commits ahead. First real
exercise of `hygiene reap` against known-safe input.

**Step 5 — Board and backfill.** Create the project, then backfill open items.

**Step 6 — Rebase and land agent-runner.** It flows through the finished system
end to end: rebase, checks, pull request, merge, auto-delete, then
`hygiene reap` removes the worktree.

**Rollback.** The only destructive operations are branch deletions guarded by
proven-merged, so those commits survive in `main`'s history; the local reflog
covers the rest. No history rewriting anywhere: no force-pushes, no rebases of
anything already shared.

## Testing

The safety predicate is the only component that can destroy work, so it carries
the test weight.

`hygiene.ts` separates into two layers. `collectState()` shells out to `git` and
`gh` and returns plain objects. `isReapable(state) → { safe, reasons[] }` is
pure. Only the pure layer is unit tested, exhaustively, over the full truth
table of (clean, on-origin, fully-pushed, merged). A false positive deletes
unpushed work, so `safe` must be unreachable unless all four hold. This follows
the `tsx --test` convention already used in `lib/agents/` and `packages/*/src/`.

**Integration tests** `git init` a scratch repository in a temp directory,
attach worktrees in each interesting state — dirty, unpushed, merged-and-clean —
then run `status` and `reap` and assert on real behavior. This catches the gap
between a correct predicate and wrong state being fed to it. Merge state is
stubbed at the `collectState()` seam so these tests never call `gh`. Fast
enough for the fast lane.

Both test files live at `scripts/*.test.ts`, and the `test:unit` script in
`package.json` gains a leading `tsx --test scripts/*.test.ts &&` so `check.yml`
picks them up without a second command.

**Workflows get syntax validation, not behavioral tests.** `actionlint` catches
malformed YAML and bad expressions. `act` is deliberately not used: it requires
Docker and still does not faithfully reproduce GitHub's merge-event semantics.
Workflow behavior is proven by observation on the scaffolding pull request.

**Step 6 is the acceptance test.** Pass criteria:

1. Push → `check.yml` green in under 5 minutes
2. Open pull request → `e2e.yml` runs with service containers, no live secrets
3. Merge → head branch auto-deleted, board item flips to Done
4. `pnpm hygiene status` → reports the orphaned worktree as reapable
5. `pnpm hygiene reap --yes` → removes it
6. A deliberately unsigned commit → blocked by `pre-push`
7. End state: one worktree, one branch, zero open pull requests
