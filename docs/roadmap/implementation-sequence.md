# Implementation Sequence

## Current delivery checkpoint

The baseline gate repair shipped in #302. The later dependency regression was repaired in [#319](https://github.com/OpenCoven/coven-agents/pull/319). Scoped owner credentials and inspection shipped in #311, and guarded binding and redacted run evidence shipped in #312. Issues #296, #297, and #298 are complete at the repository contract boundary. Keep the verified merge SHAs in the Castles consumer pins. The contributor setup and Git hook update carries the reviewed changes from #310 and the guide from #305. The account-keyed billing ledger landed in #317 with migrations 0048 and 0049 after runner migration 0047. Issues #225 and #226 are complete at the repository boundary. Production migration remains separately gated. Keep dependency updates in their own qualification lane.

- #299 is assigned to BunsDev. Next, carry server-enforced read-only permission through owner admission and prove a permitted read and denied mutation in the recording executor.
- #300 is open. The maintainer selected snapshot verification only. The lifecycle owner still needs to expose and qualify the versioned read-only result, including the observed harness version, and verify the exact pin and mismatch refusal. [Bootstrap decision](https://github.com/OpenCoven/coven-agents/issues/300#issuecomment-6791981973) · [Castles acceptance](https://github.com/OpenCoven/coven-castles/issues/3)

The web subscriber release still requires candidate-specific evidence. Track tenant and credential isolation in [#47](https://github.com/OpenCoven/coven-agents/issues/47), admission and revocation in [#49](https://github.com/OpenCoven/coven-agents/issues/49), live provider containment in [#262](https://github.com/OpenCoven/coven-agents/issues/262), and paid sales in [#263](https://github.com/OpenCoven/coven-agents/issues/263). The [subscriber rollout checklist](https://github.com/OpenCoven/coven-agents/issues/51) ties these results to one release candidate.

This sequence describes public outcome ordering. Check the delivery issues for task status and acceptance criteria.

## Authority reminder

Coven Agents owns product accounts, subscriptions, encrypted tenant harness
credentials, Daytona execution, PostgreSQL run state, and bounded evidence.
Other OpenCoven authorities remain external and are consumed through versioned
references and adapters.

## Promotion model

An outcome advances only when:

1. dependencies are complete;
2. repository gates pass on the candidate;
3. the verification matrix cites retained evidence;
4. production-only claims have operator approval;
5. rollback and recovery criteria are explicit.

## Phase 0

### Planning authority

- Verify issue owners, blockers, and acceptance before advancing delivery.
- Link landed changes and their evidence from the delivery issue.
- Keep private task details out of public artifacts.

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
