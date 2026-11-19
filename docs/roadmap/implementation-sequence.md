# Implementation Sequence

## Current delivery checkpoint

The baseline gate repair shipped in #302. Scoped owner credentials and inspection shipped in #311, and guarded binding and redacted run evidence shipped in #312. Issues #296, #297, and #298 are complete at the repository contract boundary. Keep the verified merge SHAs in the Castles consumer pins. The contributor setup and Git hook update carries the reviewed changes from #310 and the guide from #305. The account-keyed billing ledger landed in #317 with migrations 0048 and 0049 after runner migration 0047. Issues #225 and #226 are complete at the repository boundary. Production migration remains separately gated. Keep dependency updates in their own qualification lane.

- #299 is assigned to BunsDev. Next, carry server-enforced read-only permission through owner admission and prove a permitted read and denied mutation in the recording executor.
- #300 needs the lifecycle owner’s bootstrap decision. Record the selected snapshot or install contract and prove the exact-pinned path and refusal when its prerequisites are missing before promoting it.

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
