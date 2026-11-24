# Coven Agents Roadmap

This roadmap describes delivery outcomes, gates, and evidence. GitHub issues track tasks, dependencies, and acceptance. Pull requests record review and delivery evidence. [Open issues](https://github.com/OpenCoven/coven-agents/issues) · [Delivery governance](docs/roadmap/delivery-governance.md)

## Current gate: Phase 0 baseline

Phase 0 requires current delivery issues, no `AT RISK` worktrees, a secondary-worktree count within the repository soft cap, a frozen dependency install, and current generated application artifacts. Hygiene, lint, typecheck, unit tests, and production build must pass before a later wave advances.

## Delivery checkpoint — 2026-11-23

Merged repository work is on main `6d7f257d2793f1091877678e0e2e7c5daecadb30`; #320 landed and #299 closed after acceptance replay. GitHub issues remain the task and acceptance authority. The remaining delivery queue is the attempt-reference, CLI and inspection stack; its unmerged candidates are not deployed capabilities or accepted Castles pins. Keep Phase 0 until the exact promoted source passes its required gates and the shared-worktree and release blockers are resolved.

| Delivery | Current boundary | Next proof |
| --- | --- | --- |
| [#299 / #320](https://github.com/OpenCoven/coven-agents/pull/320) | Landed and #299 closed; exact-head normal browser and landed acceptance replay pass | Target installed-version and consumer pin adoption remain separately owned |
| [#326 / #327](https://github.com/OpenCoven/coven-agents/pull/327) | Opaque attempt references and exclusive bound admission reviewed; migration integration prepared without #325 | Confirm integration ownership, qualify the exact migration order and replay both acceptance rows on landed main |
| [#328 / #330](https://github.com/OpenCoven/coven-agents/pull/330) | Codex and Claude CLI candidate reviewed, including corrected credential persistence | Qualify the integrated source; retain unsupported restricted-mode refusal and separate snapshot/live gates |
| [#322 / #324](https://github.com/OpenCoven/coven-agents/pull/324) | Producer and Castles consumer pair reviewed with synthetic compatibility evidence | Qualify landed producer and obtain the required consumer steward/maintainer acceptance |

The remaining sequence and one owner/action per open issue are recorded in the [implementation sequence](docs/roadmap/implementation-sequence.md). The [verification matrix](docs/roadmap/verification-matrix.md) separates the passing composed validation from source-head browser failures and pending delivery gates. [Release readiness](docs/roadmap/release-readiness.md) remains a no-go until its operator evidence and approval gates are complete.

## Delivery sequence

### Phase 0: Baseline

Keep delivery issues current, resolve repository hygiene risks, and prove every required local quality gate on the current source tree.

### Wave 0: Delivered

- Tenant identity and harness credential isolation.
- Signed-commit, branch, worktree, and cleanup lifecycle controls.

### Wave 1: Now

- Clarify how Coven Agents fits within OpenCoven.
- Prevent secrets from entering version control.
- Document application and Daytona trust boundaries.
- Establish the recorded demo as the public evaluation path.
- Keep delivery issues and their evidence current.
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
- Exercise Daytona, application, browser, demo, and subscriber paths in realistic environments.
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
- stale roadmap evidence or an unresolved discrepancy with delivery issues;
- a red required verification row;
- missing rollback or recovery evidence for a release-affecting change.

Later waves receive detailed implementation lanes only after promotion. This keeps later outcomes flexible until earlier work settles their interfaces and constraints.

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
