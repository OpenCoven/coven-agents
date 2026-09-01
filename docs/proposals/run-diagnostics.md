# Daytona Run Diagnostics Proposal

- Status: proposed; not authorized for delivery
- Decision authority: private Beads/DoltHub
- Last reviewed: 2026-08-31
- Entry gate: an approved private task with bounded evidence requirements
- Registry: [planning document registry](../roadmap/README.md)

## Goal

Explain run and recovery failures from PostgreSQL and Daytona evidence without
exposing credentials, private output, or unbounded provider detail.

## Diagnostic model

Use the run ID as the correlation key and build a bounded timeline from:

- admission and operation-idempotency decisions;
- dispatch and attempt leases;
- Daytona sandbox, session, and command state;
- persisted event cursors;
- cancellation and cleanup claims;
- reconciliation outcomes.

Normalize failures into stable categories such as authorization, admission,
credential acquisition, provider availability, launch, harness translation,
evidence persistence, cancellation, and cleanup. Preserve detailed provider
errors only in protected operational logs after sanitization.

## Recovery behavior

- Read durable ownership before inspecting Daytona.
- Adopt or clean only with exact attempt, generation, version, and lease fences.
- Ingest events after the persisted cursor with count and byte bounds.
- Retry ambiguous provider observations through leased reconciliation.
- Return explicit unavailable or cleanup-required states rather than success.
- Make repeated diagnosis and recovery idempotent.

## Operator output

Expose sanitized timestamps, status transitions, opaque IDs, bounded categories,
retryability, and aggregate reconciliation counts. Never expose cookies,
authorization headers, tenant harness plaintext, task content, or raw process
environment.

## Verification

- interruption before and after provider launch;
- duplicate reconciliation;
- expired lease adoption;
- cursor replay without gaps or duplicates;
- cancellation during provider outage;
- stale cleanup refusal;
- bounded output and error sanitization.
