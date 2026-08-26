# Repository Roadmap and Delivery Governance Design

**Date:** 2026-08-25  
**Status:** Approved design  
**Scope:** Public roadmap, delivery documentation, safe status projection, and
execution governance for the full `coven-agents` repository

## Why this exists

`coven-agents` has moved quickly from an initial control-plane design into a
working hybrid product with tenant isolation, demo replay, subscriptions,
account setup, a local runner, a cloud runner, and a private 60-item roadmap.
The implementation is no longer missing plans. It is missing one public,
current, evidence-backed explanation of how those plans fit together and how
work advances safely.

The repository currently has three useful but separate planning layers:

- private Beads and DoltHub data as the task-level execution authority;
- private OpenCoven Project #10 as the generated organization view; and
- checked-in feature specs and implementation plans as historical design
  records.

Those layers must remain, but they need a public strategic spine. Without one,
stakeholders cannot see the delivery sequence without private roadmap access,
maintainers must reconstruct priorities from many documents, and merged code
can drift from Project or issue status.

## Audit baseline

This design began from an audit of `main`, repository documentation, recent
commits, worktree hygiene, open issues, Project #10, package scripts, and the
current local validation gates.

At commit `65b4a1f`, the repository contains:

- a Next.js control plane with demo, account, chat, and agent-console surfaces;
- shared contracts and harness normalization packages;
- local and Cloudflare runner implementations;
- tenant-scoped identity and encrypted credential storage;
- subscription checkout, webhook, cap, and usage primitives;
- 60 managed Project items across 10 workstreams and 7 waves;
- 2 Project items marked Done, 6 In Progress, 2 In review, and 50 Todo;
- 37 Project items marked blocked;
- feature-level specs and plans under `docs/superpowers/`;
- local quality gates for hygiene, lint, types, unit tests, and production build;
  and
- intentionally disabled GitHub Actions during the private pre-release period.

The audit also found planning-state drift:

- the documented default local Beads workspace was not present, so this
  checkout could inspect Project #10 but not the authoritative database;
- issues for shipped identity, demo, and subscription work remained open;
- Project status had not caught up with several merged changes; and
- active delivery temporarily produced excess, reapable, and at-risk
  worktrees.

The initial typecheck and build also failed after billing landed because the
shared checkout had not installed the newly declared Stripe dependency and
still contained validators under `.next/dev` for removed routes. Restoring the
frozen lockfile and removing only the stale generated development directory
returned the baseline to green:

- `pnpm check`: passed, 317 files checked;
- `pnpm build`: passed;
- `pnpm typecheck`: passed; and
- `pnpm test:unit`: passed.

This chronology matters. The roadmap must distinguish a product defect from a
stale local checkout, and it must make planning drift visible without
presenting transient findings as permanent architecture.

## Goals

1. Give maintainers, coding agents, and product stakeholders one public view of
   delivered outcomes, current priorities, next priorities, promotion gates,
   and major risks.
2. Preserve private Beads/DoltHub data as the sole task-level execution
   authority.
3. Provide detailed execution guidance for Baseline, Now, and Next while
   keeping later waves outcome-oriented until promotion.
4. Tie completion claims to reproducible evidence rather than merge state
   alone.
5. Make roadmap drift detectable without exposing private task records,
   descriptions, acceptance criteria, paths, logs, or credentials.
6. Keep each document focused enough to review and maintain independently.

## Non-goals

- Copying the private Beads roadmap into git.
- Creating a second task database in Markdown.
- Rewriting historical feature specs or implementation plans.
- Changing product scope through documentation.
- Re-enabling GitHub Actions during the private pre-release period.
- Automatically closing, deleting, or archiving issues, Project items, or
  beads.
- Expanding all unfinished beads into one permanently detailed implementation
  plan.
- Implementing the product roadmap as part of the documentation change.

## Authority model

Planning authority is explicit and one-directional:

1. **Private Beads/DoltHub:** task content, acceptance criteria, dependencies,
   priority, assignment, and task status.
2. **Private Project #10:** generated, queryable view of the Beads graph.
3. **Public `ROADMAP.md`:** strategic outcomes, wave gates, aggregate status,
   and evidence links.
4. **Checked-in specs and plans:** immutable historical records of approved
   feature decisions and execution instructions.
5. **Issues and pull requests:** delivery artifacts, not roadmap authority.

If sources disagree, Beads wins at task level. The public roadmap may summarize
only the safe aggregate state and approved outcome language. Project status
must be reconciled before it is used to refresh the public snapshot.

## Documentation architecture

### `ROADMAP.md`

The repository root contains the strategic spine:

- product direction and authority;
- the current wave and promotion gate;
- delivered, Now, Next, Certify, Platform, Product data, and Operations
  outcomes;
- aggregate counts by wave, status, and blocked state;
- top-level risks;
- links to current-state, execution, verification, and release evidence; and
- instructions for reading and updating the roadmap.

The file must remain useful without private Project access. Generated status is
clearly marked and dated so a stale snapshot is recognizable.

### `docs/roadmap/current-state.md`

This is a dated, evidence-backed repository audit. It records:

- deployed and implemented capability surfaces;
- repository and worktree state;
- quality-gate results;
- planning-system availability and drift;
- known gaps and risks; and
- the evidence required to close each gap.

It is refreshed at release checkpoints and material architecture transitions,
not after every commit.

### `docs/roadmap/implementation-sequence.md`

This is the program-level implementation plan:

- Phase 0, Now, and Next are detailed into dependency-aware execution lanes;
- each lane has outcomes, entry conditions, exit evidence, owner roles, and
  review checkpoints;
- later waves remain outcome-level until promotion; and
- task IDs may be referenced, but private task text is not duplicated.

This file coordinates work across subsystems without replacing the private
dependency graph.

### `docs/roadmap/delivery-governance.md`

This defines how work moves:

- branch and worktree rules;
- roadmap, issue, pull-request, and Project reconciliation;
- update triggers and review cadence;
- phase promotion and demotion;
- decision ownership;
- stale-work handling; and
- the rule that no work may exist only on one machine when its owner goes idle.

### `docs/roadmap/verification-matrix.md`

This maps end-to-end capabilities across:

- demo;
- subscriber;
- local runner;
- cloud runner;
- security and privacy;
- persistence and recovery;
- observability; and
- operations.

Evidence records the procedure or command, environment, commit SHA, date,
artifact or link, result, and certification state.

### `docs/roadmap/release-readiness.md`

This contains the go/no-go model:

- environment prerequisites;
- data and credential prerequisites;
- deployment preflight;
- smoke, integration, and production-E2E gates;
- rollback and recovery expectations;
- unresolved-risk policy; and
- release sign-off evidence.

### Existing documentation

`README.md` remains the setup and architecture entry point. Feature specs and
plans under `docs/superpowers/` remain historical records. They may receive an
explicit correction note, but the roadmap must not silently rewrite old
decisions to look current.

## Delivery phases

### Phase 0: Restore a trustworthy baseline

Phase 0 is a required gate, not a parallel housekeeping stream.

Outcomes:

- the authoritative Beads workspace is available, current, and backed up;
- Project #10 reconciles to Beads with a no-op second apply;
- shipped issues and Project statuses are reconciled;
- no worktree is `AT RISK`;
- secondary worktrees are within the repository soft cap;
- lockfile-defined dependencies are installed;
- generated Next.js artifacts do not contain stale routes; and
- hygiene, lint, typecheck, unit tests, and production build pass.

Exit evidence:

- `pnpm hygiene`;
- `pnpm check`;
- `pnpm typecheck`;
- `pnpm test:unit`;
- `pnpm build`;
- Beads restore/pull status;
- `pnpm beads:sync preview`;
- a second no-op Project apply or equivalent current reconciliation evidence;
  and
- issue/Project state matching delivered work.

### Wave 0: Delivered foundations

Publicly record the shipped foundations:

- tenant identity and harness credential isolation; and
- signed-commit, branch, worktree, and cleanup lifecycle controls.

Each claim links to the relevant spec, merged implementation, and verification
evidence.

### Wave 1: Now

Settle the boundaries that all later work depends on:

- clarify how Coven Agents fits within OpenCoven;
- prevent secrets from entering version control;
- document local and cloud trust boundaries;
- accept the recorded demo as the public evaluation path;
- make private planning and its generated view dependable; and
- make operator and contributor workflows repeatable.

Exit requires approved boundaries, enforced secret controls, an accepted demo,
an operable planning system, and a green Phase 0 baseline.

### Wave 2: Next

Make both runners durable and explainable:

- stabilize and version the shared runner contract;
- expose only supported execution capabilities;
- enforce subscriber access and output-safety boundaries;
- make cloud sandbox ownership and network access explicit;
- make local process ownership, streaming, and cancellation reliable;
- establish durable agent and run records with crash recovery; and
- produce structured operational telemetry.

Exit requires shared execution semantics, explicit lifecycle ownership,
durable records, bounded cancellation, enforced authorization and redaction,
and enough telemetry to explain a failed run.

### Wave 3: Certify

Prove production behavior:

- demonstrate contract conformance across implementations;
- exercise cloud, local, and browser paths in realistic environments;
- preflight deployment configuration and dependencies;
- trace requests through execution and expose reliability metrics;
- prove recovery from crashes and abandoned work;
- make failures understandable and accessible; and
- certify demo, subscriber, local, and cloud journeys end to end.

The wave exits only when required paths are certified with dated evidence.

### Wave 4: Platform

Expand the execution platform:

- add normalized execution support for additional coding harnesses;
- enforce fair cloud capacity allocation;
- offer a more isolated local execution option;
- continuously inspect dependencies and source for known risks;
- reduce contributor setup to a repeatable bootstrap; and
- enforce ownership for sensitive repository surfaces.

### Wave 5: Product data

Make history and lifecycle durable:

- align lifecycle semantics across runners;
- provide durable agent and run history;
- enforce retention and deletion policy;
- preserve auditable state changes;
- support privacy-safe archive movement; and
- generate interface documentation from source.

### Wave 6: Operations

Make releases and recovery routine:

- migrate persisted data safely;
- stage and gate cloud releases;
- publish compatibility expectations for runner-facing changes;
- standardize health and readiness signals;
- document day-two operation; and
- provide recovery procedures for expected failures.

## Promotion rules

A phase or wave cannot advance while any of these conditions hold:

- an unmet exit gate;
- an `AT RISK` worktree;
- a failed required quality gate;
- an unresolved P0 dependency;
- stale roadmap aggregates;
- a red required verification row;
- missing rollback or recovery evidence for a release-affecting change; or
- a discrepancy between Beads and Project status.

Later waves receive detailed implementation lanes only when promoted. This
prevents speculative plans from hardening around APIs or constraints that
earlier work may change.

## Public status projection

A dedicated command issues a field-only GraphQL query against the private
Project projection. The query requests managed Project field values and item
identifiers only; it does not request content nodes, titles, bodies, or
descriptions.

The command produces only:

- managed inventory count;
- counts by approved wave;
- counts by approved status;
- counts by blocked state; and
- refresh timestamp.

It must not request, read, or emit:

- item titles;
- item or issue bodies;
- descriptions or acceptance criteria;
- local paths;
- command output or logs;
- credentials or environment values; or
- arbitrary Project fields.

Responses containing item content or unapproved fields are rejected rather
than ignored.

The generated block in `ROADMAP.md` is enclosed by versioned markers. Authored
content remains outside the markers.

The command has three modes:

- `preview`: print aggregate differences without writing;
- `check`: fail when the checked-in snapshot differs from current aggregate
  state; and
- `apply`: atomically replace only the generated block.

The initial execution path is local because GitHub Actions is disabled.
Required update triggers are:

- material Beads changes;
- roadmap or delivery-governance pull requests;
- wave promotion;
- release-readiness review; and
- restoration of automated checks.

## Failure behavior

Roadmap updates fail closed.

The command returns non-zero and leaves the existing file untouched when:

- Project authentication fails;
- the managed inventory is missing or duplicated;
- the total differs from the reviewed configured inventory;
- expected fields, waves, statuses, or options are missing;
- unknown values appear;
- generated markers are absent, malformed, or duplicated;
- aggregate counts do not balance; or
- the target file cannot be replaced atomically.

If private Project access is unavailable, the last checked-in snapshot remains
visible with its original refresh date. The tooling must not replace it with
zeroes, partial data, or a success-shaped fallback.

The public projection never attempts to repair Project or Beads data. Operators
repair the authoritative source, run the existing private sync, verify a
no-op rerun, and then refresh the public aggregate.

## Verification and certification

The documentation distinguishes:

- **implemented:** code is merged;
- **verified:** repeatable checks pass in a named environment; and
- **certified:** the required end-to-end path has current evidence and satisfies
  its release gate.

Roadmap projection tests cover:

- deterministic aggregate rendering;
- a no-op second apply;
- marker preservation;
- authored-content preservation;
- aggregate arithmetic;
- allowed enum handling;
- malformed and partial Project data;
- authentication and rate-limit failure;
- atomic-write failure; and
- refusal to process private text fields.

Documentation review checks:

- internal links resolve;
- one source owns each kind of information;
- no private task text is committed;
- phase gates match the implementation sequence and release checklist;
- every certification claim has evidence; and
- the current-state date and commit are explicit.

## Staying-on-track loop

The operating loop is:

1. restore and inspect the authoritative Beads graph;
2. select ready work from the current detailed wave;
3. create one branch and worktree per task;
4. preserve work remotely before idle;
5. implement against the task acceptance criteria;
6. run the repository quality gates;
7. merge and reconcile issue, Beads, and Project status;
8. attach verification evidence;
9. refresh the public aggregate when an update trigger fires; and
10. promote a wave only after its exit review passes.

The loop separates task execution from public communication while ensuring that
each remains traceable to the other.

## Rollout

1. Commit this design on a dedicated documentation branch.
2. Write the detailed implementation plan.
3. Restore and reconcile Beads, Project, issues, and worktree state.
4. Add `ROADMAP.md` and the focused companion documents.
5. Add the aggregate projection command and tests.
6. Add package commands and contributor-facing documentation links.
7. Populate the initial verification matrix from existing evidence.
8. Run all repository gates and a privacy review.
9. Review the public output without private Project access.
10. Merge the documentation system, then use it to drive Wave 1 and Wave 2.

## Acceptance criteria

- A reader without private roadmap access can identify what is delivered, what
  is Now, what is Next, what blocks promotion, and what evidence exists.
- An authorized maintainer can preview, verify, and refresh aggregate status.
- Beads remains the only task-level execution authority.
- Repeated aggregate applies are deterministic and no-op when state is
  unchanged.
- Private roadmap text never enters git or command output.
- Phase 0, Now, and Next have explicit entry, exit, ownership, and evidence
  rules.
- Later waves remain outcome-level until promotion.
- A failed refresh cannot corrupt or silently zero the public snapshot.
- The release-readiness decision can be made from checked-in evidence and
  linked operational artifacts.

## Deferred

- CI enforcement while GitHub Actions is disabled.
- Public release dates or promises.
- Automated issue closure or Project mutation from the public roadmap command.
- Detailed implementation plans for waves that have not been promoted.
- A standalone web roadmap or dashboard.
