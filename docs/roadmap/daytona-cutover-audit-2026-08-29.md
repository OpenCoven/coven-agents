# Daytona-Only Cutover Audit — 2026-08-29

## Scope

This audit reviews tracked application documentation, browser execution
transport, server authority, Daytona lifecycle composition, PostgreSQL run
ownership, and documentation guardrails. It does not claim production
deployment or provider resource deletion.

Candidate base:
`acc7ca3fa2dd51f496e1900573f239eb8a158ce6`.

## Findings and remediation

| Area | Finding | Remediation |
| --- | --- | --- |
| Browser transport | Relative same-origin APIs are the current browser boundary. | Active docs now describe Auth.js session access only. |
| Authority | Subscriber state and tenant ownership are server-derived. | Security and roadmap docs cite route and dispatch-time checks. |
| Credential custody | Harness plaintext uses only the ratified short-lived server-to-sandbox attempt transfer. | README, ADRs, runbooks, and threat model use one custody model. |
| Provider lifecycle | Daytona is the sole execution provider. | ADR-002 records lifecycle, rollback, and adapter criteria. |
| Durable state | PostgreSQL owns runs, events, attempts, cancellation, and recovery. | Roadmap and diagnostics proposals now use durable database evidence. |
| Historical guidance | Fully decommissioned implementation plans could be mistaken for current instructions. | The dated governance exception and sanitized [tombstone index](../superpowers/README.md) make the reviewed policy evolution and Git-history recovery explicit. |
| Production claims | Repository delivery and production action were previously easy to conflate. | The cutover attestation keeps repository verification and approval-gated evidence pending until their gates run. |

## Repository evidence

- PR #128 merge commit:
  `bd46bece9ea9b33700f3316919c6f035aad7d7d1`
- PR #133 merge commit:
  `acc7ca3fa2dd51f496e1900573f239eb8a158ce6`
- Browser boundary: `lib/agents/browser-transport.ts`
- Server authority: `lib/runner/http.ts`, `lib/runner/runtime.ts`
- Daytona lifecycle: `lib/runner/daytona/`
- Durable ownership: `lib/runner/store.ts`
- SSE recovery: `lib/runner/sse.ts`
- Attempt reconciliation: `lib/runner/attempt-reconcile.ts`
- Persistent resource recovery: `lib/runner/daytona/resource-recovery.ts`

## Verification procedure

```bash
pnpm exec tsx --test scripts/product-boundary.test.ts \
  scripts/security-docs.test.ts scripts/guest-access-docs.test.ts \
  scripts/wave-one-report.test.ts
pnpm check
```

The final change report must also include exact tracked-content and
tracked-filename scan matches.

## Unverified boundaries

- production Auth.js request and tenant isolation;
- full Daytona create, reuse, run, stream, stop, delete, and cleanup;
- interrupted-attempt recovery;
- provider resource inventory and revocation;
- observation-window stability;
- operator approvals.

## Disposition

Repository documentation remains pending until the required tests and residue
scan pass. Production readiness remains pending until the
[cutover attestation](../operations/daytona-cutover-attestation.md) is completed
by authorized operators.
