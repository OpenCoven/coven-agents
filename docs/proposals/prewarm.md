# Daytona Prewarm Proposal

- Status: proposed; not authorized for delivery
- Decision authority: private Beads/DoltHub
- Last reviewed: 2026-08-31
- Entry gate: an approved private task and measured cold-start evidence
- Registry: [planning document registry](../roadmap/README.md)

## Goal

Reduce first-run latency without weakening tenant isolation, idempotency,
capacity limits, or durable lifecycle ownership.

## Measurement first

Measure separately:

- sandbox allocation;
- snapshot start;
- harness readiness probe;
- credential acquisition;
- process launch;
- first normalized event.

Record percentiles by snapshot version and target using sanitized aggregate
telemetry. Do not infer a prewarm benefit from total request latency alone.

## Proposed behavior

- Prewarm only the most recently used eligible agent for an authenticated
  subscriber.
- Use the existing tenant-scoped persistent Daytona sandbox lifecycle.
- Store warm state and attempt version in PostgreSQL.
- Make concurrent triggers join or observe the same lifecycle attempt.
- Bound the request deadline; unfinished work remains recoverable through
  reconciliation.
- Refuse unsupported harnesses before provider work.

## Capacity degradation

Prewarm is best-effort. Under provider pressure, admission-store failure, or
tenant limits, skip or defer it without blocking agent reads or creating a
success-shaped state. Paid run admission always has priority.

## Verification

- cold and warm latency distributions;
- duplicate-trigger idempotency;
- stale-attempt fencing;
- provider failure and timeout behavior;
- tenant and deployment capacity limits;
- no credential acquisition during readiness-only work;
- cleanup and reconciliation after interruption.
