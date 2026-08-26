# Delivery Governance

This document defines how delivery state moves between the private planning
authority, repository evidence, and release decisions. It does not reproduce
private task text.

## Authority hierarchy

When records disagree, the higher source in this list wins:

1. **Private Beads/DoltHub is the task authority.** It owns task status,
   dependencies, priority, assignment, and acceptance.
2. **OpenCoven Project #10 is generated.** It is a private, field-oriented
   projection of Beads for coordination. Project edits never override Beads.
3. **[`ROADMAP.md`](../../ROADMAP.md) and [`docs/roadmap`](./) are public
   aggregates and outcomes.** They record waves, gates, counts, current
   repository evidence, and operating policy without copying private task
   descriptions or acceptance criteria.
4. **GitHub issues and pull requests are delivery artifacts.** They provide
   discussion, review, merged-code, and deployment evidence. They do not become
   task authority merely because they are newer or public.

`main` remains the source of truth for merged repository content. A merge is
delivery evidence, not automatic proof that the authoritative task is accepted
or that every projection has reconciled.

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
changes that belong in Beads.

## Delivery lifecycle

### Start

1. Confirm the task and dependencies in Beads when authority is available.
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

An authorized maintainer reconciles in this order:

1. Pull the private Beads authority, record the accepted delivery and dependency
   changes, then commit and push the private database.
2. Preview and apply the one-way Beads-to-Project projection. Apply again and
   finish with a preview that reports no create, update, or orphan work.
3. Reconcile the delivery issue and merged pull request. Close an issue only
   when the authoritative task is accepted; preserve the pull request as
   evidence.
4. Refresh the generated aggregate in `ROADMAP.md`, run its stale check, and
   commit the refresh if it changed.
5. Update the verification matrix or release-readiness record when the merge
   changes a capability, procedure, environment, blocker, rollback condition,
   or retained artifact.

The Project, issue, and roadmap steps never run ahead of Beads. Authentication,
schema, inventory, or write failures stop reconciliation and leave checked-in
and remote projections unchanged.

## Roadmap refresh triggers

Run `pnpm roadmap:status check` and refresh when authorized after any of these
events:

- an authoritative task changes status, wave, dependency, priority, owner, or
  blocked state;
- a delivery pull request merges, reverts, or rolls back;
- a shipped issue is opened, closed, or found inconsistent with Beads;
- a promotion, demotion, go/no-go, or release decision is being made;
- verification evidence expires or a touched path invalidates it;
- `pnpm roadmap:status check` reports a stale aggregate; or
- unavailable planning authority becomes available again.

Do not hand-edit the generated status block. A current Project projection does
not prove Beads is current when the private authority cannot be read.

## Promotion and demotion

A phase, wave, capability, or release may be promoted only when:

- authoritative task and dependency state is available and reconciled;
- no unresolved P0 or blocking dependency applies;
- there are no `AT RISK` worktrees;
- all five required local gates pass on the promoted commit;
- every required verification row is `Verified` or `Certified`;
- the roadmap aggregate is current;
- rollback ownership and triggers are recorded; and
- release-affecting data has a tested recovery path or an explicit no-go.

`Certified` requires retained, dated end-to-end evidence from a
release-equivalent environment. Unit, integration, source inspection, or an
undated manual claim cannot satisfy that state.

Demote immediately when a required gate regresses, evidence no longer applies
to the current commit or environment, a required row becomes `Blocked`, a
rollback occurs, an `AT RISK` worktree appears, the roadmap becomes stale, or
Beads and Project can no longer be shown to agree. Demotion updates current
status; it does not rewrite historical evidence.

## Historical specifications

Accepted and merged specifications are historical records. Do not silently
rewrite them to describe later implementation reality.

When a historical specification becomes inaccurate, add a dated correction
note headed **Correction note**. Identify the obsolete claim, the superseding
decision or commit, and the current evidence document. Update living
operational documents directly. Security or privacy removal is the exception:
redact exposed sensitive material promptly, follow incident response, and
leave a safe note that a redaction occurred.

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
| After every merge | Authorized maintainer | Reconcile Beads, Project, issue/PR state, roadmap aggregate, and affected evidence documents in authority order. |
| Weekly and before promotion | Maintainer and reviewer | Check roadmap freshness, verification age, blockers, dependency drift, and worktree hygiene. |
| Every release | Release operator and reviewer | Execute [`release-readiness.md`](release-readiness.md), record go/no-go, and retain smoke and rollback evidence. |

The maintainer owns authority mutations, promotion, production release, and
rollback. The delivery owner owns the task branch and implementation evidence.
The reviewer independently checks the claim. Automation may validate or
project state, but it may not decide acceptance.

## Unavailable authority

Planning operations fail closed when Beads/DoltHub is unavailable:

- do not infer task status, dependencies, priority, or acceptance from Project,
  issues, pull requests, or `ROADMAP.md`;
- do not mutate Project, close delivery issues, promote a wave, or claim an
  idempotent sync;
- leave the last checked-in aggregate unchanged and record the access failure
  as a blocker;
- continue only work whose authorization and scope were already established
  and that does not require unavailable private acceptance details; and
- reconcile every projection before the next promotion or release after access
  returns.

The current access state and its release effect are recorded in
[`current-state.md`](current-state.md) and
[`release-readiness.md`](release-readiness.md).

## No destructive automation

Automation must preview before mutation, fail on ambiguity, and preserve data:

- no automatic Beads deletion, Project archive, issue closure, branch deletion,
  worktree removal, history rewrite, force push, database rollback, or evidence
  purge;
- orphaned or conflicting records remain untouched for authorized review;
- cleanup tools may act only when they prove work is safely merged or pushed;
- migration, rollback, retention, and deletion actions require a named human
  operator and recovery evidence; and
- authentication, schema, inventory, privacy, or partial-write failures stop
  rather than guess.
