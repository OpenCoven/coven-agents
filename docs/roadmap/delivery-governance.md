# Delivery Governance

## Authority hierarchy

1. GitHub issues own repository task status, dependencies, priority, assignment, and acceptance. Use native blocked-by and sub-issue links. Keep private material out of public issues.
2. Pull requests and landed commits record implementation, review, and verification evidence. A merge alone leaves issue acceptance and production approval pending.
3. [The roadmap](../../ROADMAP.md) and [its supporting docs](./) record public goals, gates, and verified outcomes. Resolve discrepancies with the issue owner and the relevant evidence.

`main` is the source of truth for merged repository content.

## One task, branch, and worktree

Each delivery unit uses exactly one authoritative task, one branch, and one
worktree:

- branch names follow `<type>/<short-slug>`;
- a worktree is not shared by unrelated tasks;
- a branch does not silently absorb a second task;
- commits are signed; and
- the branch is pushed before its owner becomes idle.

If related work must split, create separately authorized tasks and independent
branches/worktrees. Do not use one branch to hide dependency or ownership
changes that belong in the delivery issue.

## Delivery lifecycle

### Start

1. Confirm the task and dependencies in GitHub issues.
2. Create or select the task's branch and worktree.
3. Confirm the worktree is clean and that no other task owns the same files.
4. Record the intended verification and release evidence before implementation.

### Work and review

- Keep changes within the authorized task.
- Push before idle and before handing work to another actor.
- Attach evidence to the pull request without copying private planning text.
- Treat a passing local command as evidence only for the commit it tested.
- Do not promote a task merely because implementation exists; apply the gates
  below.

### Post-merge reconciliation

1. Verify the landed revision and record the merged pull request and relevant test receipts on the delivery issue.
2. Record unmet acceptance criteria and their owners. Close the issue only when every required criterion has evidence and closure is authorized.
3. Update the public roadmap, verification matrix, or release-readiness record when the merge changes an outcome, procedure, environment, blocker, rollback condition, or retained artifact.

## Roadmap refresh triggers

Review the roadmap when delivery issues change materially, work merges or is reverted, verification evidence expires, or a promotion or release decision is made. Resolve stale claims against issue state and exact landed evidence.

## Planning document registry

[`docs/roadmap/README.md`](README.md) is the canonical index for tracked
planning documents. It classifies living guidance, non-authoritative proposals,
historical evidence, decision logs, and superseded specifications without
changing issue status.

Add or update a registry row in the same change that creates, reclassifies,
supersedes, or removes a planning document. Historical and superseded rows must
link to current guidance. Deleted mixed-content specifications continue to use
the specialized tombstone index in
[`docs/superpowers/README.md`](../superpowers/README.md).

Run `pnpm planning:check` before commit. The check is local and privacy-safe: it
validates tracked paths, lifecycle metadata, and current-guidance links without
querying or reproducing private task content.

## Promotion and demotion

A phase, wave, capability, or release may be promoted only when:

- relevant issues and dependencies are current and linked to landed evidence;
- no unresolved P0 or blocking dependency applies;
- there are no `AT RISK` worktrees;
- the secondary-worktree count is within the repository soft cap;
- lockfile-defined dependencies are installed and generated application
  artifacts are current;
- all five required local gates pass on the promoted commit;
- every required verification row is `Verified` or `Certified`;
- the roadmap is current;
- rollback ownership and triggers are recorded; and
- release-affecting data has a tested recovery path or an explicit no-go.

`Certified` requires retained, dated end-to-end evidence from a
release-equivalent environment. Unit, integration, source inspection, or an
undated manual claim cannot satisfy that state.

Demote immediately when a required gate regresses, the secondary-worktree count exceeds the soft cap, dependencies or generated artifacts become stale, evidence no longer applies to the current commit or environment, a required row becomes `Blocked`, a rollback occurs, an `AT RISK` worktree appears, or an unmet blocking issue invalidates readiness. Record the change without rewriting historical evidence.

## Historical specifications

Accepted and merged specifications are historical records. Do not silently
rewrite them to describe later implementation reality.

When a historical specification becomes inaccurate, add a dated correction
note headed **Correction note**. Identify the obsolete claim, the superseding
decision or commit, and the current evidence document. Update living
operational documents directly. Security or privacy removal is the exception:
redact exposed sensitive material promptly, follow incident response, and
leave a safe note that a redaction occurred.

### Supersession policy evolution — 2026-08-29

Normal accepted specifications remain tracked with correction notes. For a
mixed-content historical document only, a reviewed migration may instead
delete the obsolete tracked document and replace it with a sanitized tombstone
when all of these conditions hold:

1. the tombstone maps every deleted document to specific current documents
   that preserve every decision that remains applicable;
2. Git history preserves each original;
3. every active link is updated to current guidance or the tombstone index;
4. the removal and its sanitized tombstone are explicitly reviewed; and
5. no private or sensitive detail is copied into the tombstone.

The tombstone must identify recoverable history without reproducing retired
vendor markers, credentials, private planning records, or executable obsolete
topology. This exception does not permit deleting a historical document merely
because its conclusions changed; the document must mix still-applicable
decisions with implementation detail whose continued presence creates a
material risk of being followed as current guidance. The current index is
[`docs/superpowers/README.md`](../superpowers/README.md).

## Actions policy

GitHub Actions are intentionally disabled for private pre-release cost control.
Workflow files describe possible future automation but are not current
execution evidence. Do not re-enable Actions, required checks, scheduled
mutation, or automatic merging as part of ordinary delivery work. That change
requires a separately approved task with cost, permission, secret, and
failure-mode review.

Until that approval, the five local gates are the only merge gates:

```bash
pnpm hygiene
pnpm check
pnpm typecheck
pnpm test:unit
pnpm build
```

## Cadence and roles

| Cadence | Responsible role | Required action |
| --- | --- | --- |
| Every task start | Delivery owner | Confirm authority, branch, worktree, scope, and evidence plan. |
| Before every idle period or handoff | Delivery owner | Commit when appropriate and push the branch; never leave unique work only on one machine. |
| Every review and merge | Reviewer and delivery owner | Bind evidence to the tested commit and identify any invalidated verification row. |
| After every merge | Authorized maintainer | Verify the landed revision and update the delivery issue, roadmap, and affected evidence documents. |
| Weekly and before promotion | Maintainer and reviewer | Check roadmap freshness, verification age, blockers, dependency drift, and worktree hygiene. |
| Every release | Release operator and reviewer | Execute [`release-readiness.md`](release-readiness.md), record go/no-go, and retain smoke and rollback evidence. |

The maintainer owns authority mutations, promotion, production release, and
rollback. The delivery owner owns the task branch and implementation evidence.
The reviewer independently checks the claim. Automation may validate evidence. The maintainer decides acceptance.

## Unavailable issue state

When issue state cannot be verified, continue already authorized work and retain local evidence. Wait for verified issue state and approval before changing acceptance or promoting a release.

## No destructive automation

Automation must preview before mutation, fail on ambiguity, and preserve data:

- no automatic issue closure, branch deletion,
  worktree removal, history rewrite, force push, database rollback, or evidence
  purge;
- orphaned or conflicting records remain untouched for authorized review;
- cleanup tools may act only when they prove work is safely merged or pushed;
- migration, rollback, retention, and deletion actions require a named human
  operator and recovery evidence; and
- authentication, schema, inventory, or privacy failures stop
  rather than guess.
