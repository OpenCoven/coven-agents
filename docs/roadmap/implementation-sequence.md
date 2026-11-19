# Implementation Sequence

## Current delivery checkpoint

The baseline gate repair shipped in [PR #302](https://github.com/OpenCoven/coven-agents/pull/302). Next, finish the contributor setup and Git hook review in #310, then reconcile the Castles contract and scoped owner credential in #311. Record the accepted contract SHA for Castles before closing #296. Keep guarded external binding and redacted execution evidence visible under #298. The runner and billing branches share migration slots. Agree on the landing order and verify the regenerated chain on fresh and previously migrated disposable databases before delivering #276.

This sequence describes public outcome ordering. Private planning remains the
task-level authority and must not be reconstructed from this document.

## Authority reminder

Coven Agents owns product accounts, subscriptions, encrypted tenant harness
credentials, Daytona execution, PostgreSQL run state, and bounded evidence.
Other OpenCoven authorities remain external and are consumed through versioned
references and adapters.

## Authority freshness

The public outcome order below was reviewed but not reordered on 2026-08-31
because private planning authority was unavailable. Repository evidence and
operating policy may be corrected independently, but task status, dependency
order, priority, assignment, and promotion remain unchanged until an authorized
Beads-to-Project reconciliation ends with a final no-op preview.

## Promotion model

An outcome advances only when:

1. dependencies are complete;
2. repository gates pass on the candidate;
3. the verification matrix cites retained evidence;
4. production-only claims have operator approval;
5. rollback and recovery criteria are explicit.

## Phase 0

### Planning authority

- Authorized maintainers validate the private source before changing the
  generated project view or public aggregates.
- Preview/apply cycles must finish with a no-op preview.
- Public artifacts contain outcomes and evidence, never private task text.

### Repository integrity

- Keep one worktree per task and no `AT RISK` worktree.
- Sign every commit and push branches before they become unattended.
- Keep dependency, route, environment, and package inventories executable.

### Evidence baseline

- Run the five repository gates.
- Record exact commit, command, exit status, date, and environment.
- Keep local evidence distinct from production approval.

## Wave 1

### Product authority and evaluation

- Maintain ADR-001 and ADR-002 as the execution and ownership boundaries.
- Keep the guest replay deterministic, sanitized, and resource-free.
- Keep internal contracts private and versioned.

### Security posture

- Keep subscriber authority server-derived and fail closed.
- Keep credential acquisition, Daytona configuration, and dispatch server-only.
- Extend evidence redaction and secret scanning when new formats are added.

### Operator and contributor workflow

- Keep incident, key rotation, cutover, and release runbooks current.
- Preserve local gate evidence because remote checks are intentionally absent.
- Require an explicit approval record for production promotion or destructive
  provider operations.

## Wave 2

### Execution safety

- Complete and verify least-privilege outbound policy.
- Prove tenant isolation across agent, run, event, credential, and sandbox
  access.
- Exercise capacity degradation without exposing credentials or provider
  internals.

### Contracts and capabilities

- Add harness support only with deterministic event translation and conformance
  evidence.
- Migrate the generic backend discriminator through a versioned dual-read,
  single-write process when the contract changes.

### Runner lifecycle

- Retain create, reuse, run, stream, stop, delete, and cleanup evidence.
- Prove operation idempotency and SSE cursor continuity under retries.
- Prove provider ambiguity converges through bounded reconciliation.

### Explainability

- Make queue, admission, cancellation, cleanup, and recovery states visible
  without exposing tenant or credential data.

### Durability

- Exercise restart and partial-write recovery against release-equivalent
  PostgreSQL.
- Prove exact attempt fencing and duplicate suppression.

## Later outcome envelopes

### Certify

Retain production-equivalent security, lifecycle, rollback, and recovery
evidence with owner approval.

### Platform

Tune fairness, capacity, observability, and provider cost controls from measured
behavior.

### Product data

Complete tenant-scoped retention, export, deletion, and audit-safe archive
behavior.

### Operations

Rehearse incident response, credential rotation, provider resource inventory,
and rollback on a documented cadence.
