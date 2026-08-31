# Coven Agents Roadmap

This is the public strategic view of delivery. Private Beads/DoltHub data is the task-level source of truth; OpenCoven Project #10 is its generated private view. This file contains outcomes, gates, aggregate counts, and evidence links. It does not duplicate private task descriptions or acceptance criteria.

## Authority freshness

On 2026-08-31, the field-only Project aggregate still matched the checked-in
status block. Private Beads repository access was unavailable, so that check is
not proof of source reconciliation and does not authorize promotion or
reordering. The generated status block remains unchanged.

## Current gate: Phase 0 baseline

Phase 0 restores a trustworthy delivery baseline and is required before any
later wave can be promoted. The gate closes when:

- the authoritative planning workspace is available, current, and backed up;
- its generated Project view and delivered issue state are reconciled;
- a second planning sync is a no-op;
- no worktree is `AT RISK` and the secondary-worktree count is within the
  repository soft cap;
- lockfile-defined dependencies are installed and generated application
  artifacts are current; and
- hygiene, lint, typecheck, unit tests, and production build all pass.

## Aggregate status

<!-- coven-agents-roadmap-status:v1:start -->
<!-- coven-agents-roadmap-status-data:v1 {"blockedCount":35,"byStatus":{"Todo":47,"In Progress":6,"In review":1,"Done":6},"byWave":{"0 - Delivered":{"blockedCount":0,"byStatus":{"Todo":0,"In Progress":0,"In review":0,"Done":2},"total":2},"1 - Now":{"blockedCount":0,"byStatus":{"Todo":0,"In Progress":4,"In review":1,"Done":4},"total":9},"2 - Next":{"blockedCount":6,"byStatus":{"Todo":14,"In Progress":1,"In review":0,"Done":0},"total":15},"3 - Certify":{"blockedCount":11,"byStatus":{"Todo":12,"In Progress":1,"In review":0,"Done":0},"total":13},"4 - Platform":{"blockedCount":5,"byStatus":{"Todo":7,"In Progress":0,"In review":0,"Done":0},"total":7},"5 - Product data":{"blockedCount":6,"byStatus":{"Todo":6,"In Progress":0,"In review":0,"Done":0},"total":6},"6 - Operations":{"blockedCount":7,"byStatus":{"Todo":8,"In Progress":0,"In review":0,"Done":0},"total":8}},"totalCount":60} -->
_Last refreshed: 2026-08-26T01:35:14.947Z from private Project #10._

| Wave | Total | Done | In Progress | In review | Todo | Blocked |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 - Delivered | 2 | 2 | 0 | 0 | 0 | 0 |
| 1 - Now | 9 | 4 | 4 | 1 | 0 | 0 |
| 2 - Next | 15 | 0 | 1 | 0 | 14 | 6 |
| 3 - Certify | 13 | 0 | 1 | 0 | 12 | 11 |
| 4 - Platform | 7 | 0 | 0 | 0 | 7 | 5 |
| 5 - Product data | 6 | 0 | 0 | 0 | 6 | 6 |
| 6 - Operations | 8 | 0 | 0 | 0 | 8 | 7 |

| Project status | Total |
| --- | ---: |
| Todo | 47 |
| In Progress | 6 |
| In review | 1 |
| Done | 6 |
<!-- coven-agents-roadmap-status:v1:end -->

## Delivery sequence

### Phase 0: Baseline

Restore and reconcile authoritative planning, remove repository hygiene risks,
and prove every required local quality gate on the current source tree.

### Wave 0: Delivered

- Tenant identity and harness credential isolation.
- Signed-commit, branch, worktree, and cleanup lifecycle controls.

### Wave 1: Now

- Clarify how Coven Agents fits within OpenCoven.
- Prevent secrets from entering version control.
- Document application and Daytona trust boundaries.
- Establish the recorded demo as the public evaluation path.
- Make private planning and its generated view dependable.
- Make operator and contributor workflows repeatable.

### Wave 2: Next

- Stabilize and version the shared runner contract.
- Expose only supported execution capabilities.
- Enforce subscriber access and output-safety boundaries.
- Make Daytona sandbox ownership and network access explicit.
- Make process ownership, streaming, and cancellation reliable.
- Establish durable agent and run records with crash recovery.
- Produce structured operational telemetry.

### Wave 3: Certify

- Prove contract conformance across runner implementations.
- Exercise Daytona, application, browser, demo, and subscriber paths in realistic
  environments.
- Preflight deployment configuration and dependencies.
- Trace requests through execution and expose reliability metrics.
- Prove recovery from crashes and abandoned work.
- Make failures understandable and accessible.

### Wave 4: Platform

- Normalize support for additional coding harnesses.
- Enforce fair Daytona capacity allocation.
- Expand application-managed Daytona execution controls.
- Continuously inspect dependencies and source for known risks.
- Make contributor setup repeatable.
- Enforce ownership for sensitive repository surfaces.

### Wave 5: Product data

- Align lifecycle semantics across runners.
- Provide durable agent and run history.
- Enforce retention and deletion policy.
- Preserve auditable state changes.
- Support privacy-safe archive movement.
- Generate interface documentation from source.

### Wave 6: Operations

- Migrate persisted data safely.
- Stage and gate application releases.
- Publish compatibility expectations for runner-facing changes.
- Standardize health and readiness signals.
- Document day-two operation and expected-failure recovery.

## Promotion rules

A phase or wave cannot advance while any of these conditions holds:

- an unmet exit gate;
- an `AT RISK` worktree;
- a failed required quality gate;
- an unresolved P0 dependency;
- stale roadmap aggregates;
- a red required verification row;
- missing rollback or recovery evidence for a release-affecting change; or
- a discrepancy between Beads and Project status.

Later waves receive detailed implementation lanes only after promotion. This
keeps later outcomes flexible until earlier work settles their interfaces and
constraints.

## Evidence and operating docs

- [Planning document registry](docs/roadmap/README.md)
- [Repository setup and architecture](README.md)
- [Current-state audit](docs/roadmap/current-state.md)
- [Daytona cutover audit](docs/roadmap/daytona-cutover-audit-2026-08-29.md)
- [Implementation sequence](docs/roadmap/implementation-sequence.md)
- [Delivery governance](docs/roadmap/delivery-governance.md)
- [Verification matrix](docs/roadmap/verification-matrix.md)
- [Release readiness](docs/roadmap/release-readiness.md)
- [Product authority ADR](docs/architecture/adr-001-product-authority-boundary.md)
- [Daytona execution ADR](docs/architecture/adr-002-daytona-execution-boundary.md)
- [Daytona cutover attestation](docs/operations/daytona-cutover-attestation.md)

## Refreshing status

Authorized maintainers can inspect and refresh the generated block:

```bash
pnpm roadmap:status preview
pnpm roadmap:status check
pnpm roadmap:status apply
```

The command uses a field-only query for managed item identifiers plus the
approved Bead ID, Wave, Status, and Blocked fields. It does not request Project
content, titles, bodies, descriptions, or acceptance criteria, and it never
publishes those fields. Authentication, schema, inventory, or write failures
leave the checked-in snapshot unchanged. Do not hand-edit the generated block.
