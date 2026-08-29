# Current Repository State

- Snapshot date: 2026-08-29
- Candidate: `1bec409b399651d8a115e4518a0f444e9753a728`
- Evidence class: verified repository and local contract evidence

This snapshot does not claim a production deployment, provider cleanup, or
private planning update.

## Implemented surfaces

| Surface | Current repository reality | Evidence |
| --- | --- | --- |
| Product application | Next.js 16 serves authenticated account, agent, run, analytics, settings, and administration surfaces. | `app/`, `components/` |
| Browser execution access | Browser code calls relative same-origin `/api` routes with the Auth.js session. | `lib/agents/browser-transport.ts`, `lib/agents/client.ts` |
| Authority | Protected routes revalidate subscriber state and derive tenant ownership on the server. | `lib/auth/subscriber-authorization.server.ts`, `lib/runner/http.ts`, `lib/runner/runtime.ts` |
| Daytona execution | Daytona is the sole execution provider. Each agent owns a persistent tenant-scoped sandbox; attempts use short-lived process sessions. | `lib/runner/daytona/`, `lib/runner/service.ts` |
| Durable ownership | PostgreSQL stores agent, run, event, admission, dispatch, attempt, cancellation, and reconciliation state. | `lib/runner/store.ts`, `lib/db/schema.ts` |
| Credential custody | Tenant harness credentials are encrypted, AAD-bound, acquired server-side, and compensated on failed launch. | `lib/credentials/`, `lib/runner/runtime.ts` |
| Run reliability | Starts are operation-idempotent, SSE resumes from numeric cursors, and reconciliation uses database-time leases and exact fences. | `lib/runner/admission.ts`, `lib/runner/sse.ts`, `lib/runner/reconcile.ts` |
| Guest replay | A committed sanitized replay can render without starting an agent, creating a sandbox, or using subscriber resources. | `lib/demo/`, `components/demo/` |
| Security operations | Separate credentials protect diagnostics, scheduled reconciliation, and manual reconciliation. | `lib/runner/auth.ts`, `docs/security/incident-response.md` |

## Public delivery evidence

- [PR #128](https://github.com/OpenCoven/coven-agents/pull/128) merged as
  `bd46bece9ea9b33700f3316919c6f035aad7d7d1`.
- [PR #133](https://github.com/OpenCoven/coven-agents/pull/133) merged as
  `acc7ca3fa2dd51f496e1900573f239eb8a158ce6`.
- [PR #134](https://github.com/OpenCoven/coven-agents/pull/134) merged as
  `1bec409b399651d8a115e4518a0f444e9753a728`.

The PR #134 merge tree is identical to its fully gated head. These commits
establish repository state and local verification. The
[cutover attestation](../operations/daytona-cutover-attestation.md) keeps
production evidence pending until an authorized operator records it.

## Known gaps

- No retained production-equivalent create, run, stream, stop, delete, and
  reconciliation artifact exists.
- Complete outbound policy evidence remains open.
- End-to-end evidence redaction, restart recovery, retention, export, and
  deletion require broader certification.
- Only GitHub Copilot CLI has implemented event translation.
- GitHub Actions remain intentionally disabled, so local gates are the only
  repository verification boundary.
- Private planning reconciliation must be performed only by an authorized
  maintainer and is not asserted here.

## Verification commands

```bash
pnpm hygiene
pnpm check
pnpm typecheck
pnpm test:unit
pnpm build
```

See the [verification matrix](verification-matrix.md) for evidence states and
the [release readiness runbook](release-readiness.md) for approval-gated work.
