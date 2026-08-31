# Current Repository State

- Snapshot date: 2026-08-31
- Application baseline: `f211e49eb2c633759c63e1cb077a9e44e5bdc172`
- Evidence class: verified repository and local contract evidence plus retained
  infrastructure cutover evidence

This snapshot distinguishes the completed infrastructure cutover from pending
full product release certification. Private planning reconciliation remains
pending and is not inferred from repository or Project evidence.

## Implemented surfaces

| Surface | Current repository reality | Evidence |
| --- | --- | --- |
| Product application | Next.js 16 serves authenticated account, agent, team, skill, run, analytics, settings, and administration surfaces. | `app/`, `components/` |
| Console workspace | Every stored agent profile resolves to a bounded execution profile; the workspace presents responsive creation, resizable rails, rendered runner Markdown, and structured research-report evidence. | `lib/console/agent-profile.ts`, `components/console/`, `app/console.css` |
| Browser execution access | Browser code calls relative same-origin `/api` routes with the Auth.js session. | `lib/agents/browser-transport.ts`, `lib/agents/client.ts` |
| Authority | Protected routes revalidate subscriber state and derive tenant ownership on the server. | `lib/auth/subscriber-authorization.server.ts`, `lib/runner/http.ts`, `lib/runner/runtime.ts` |
| Subscription authority | Checkout is explicitly gated, authentication-first, abuse-bounded, operation-idempotent, lease-fenced, and recoverable across uncertain provider outcomes. Signature-verified webhooks update paid intervals transactionally and persist bounded manual-reconciliation records when authority cannot be applied safely. | `lib/billing/checkout-lease.ts`, `lib/billing/checkout-response.ts`, `lib/billing/webhook.ts`, `lib/db/stripe-event.ts` |
| Coordinated teams | Authenticated tenants can manage bounded skill and team definitions and start durable team runs. Immutable authority, agent, skill, and child-run snapshots fence execution; handoffs are UTF-8 byte-bounded and sanitized; workspace-only Copilot steps are orchestrated durably while GitHub-capable steps fail closed until brokered. | `packages/agent-contracts/src/index.ts`, `lib/teams/`, `app/api/teams/`, `app/api/team-runs/` |
| Daytona execution | Daytona is the sole execution provider. Each agent owns a persistent tenant-scoped sandbox; attempts use short-lived process sessions. | `lib/runner/daytona/`, `lib/runner/service.ts` |
| Durable ownership | PostgreSQL stores agent, run, event, admission, dispatch, attempt, cancellation, and reconciliation state. | `lib/runner/store.ts`, `lib/db/schema.ts` |
| Credential custody | Tenant harness credentials are encrypted, AAD-bound, acquired server-side, and compensated on failed launch. | `lib/credentials/`, `lib/runner/runtime.ts` |
| Run reliability | Starts are operation-idempotent, SSE resumes from numeric cursors, and reconciliation uses database-time leases and exact fences. | `lib/runner/admission.ts`, `lib/runner/sse.ts`, `lib/runner/reconcile.ts` |
| Guest replay | A committed sanitized replay can render without starting an agent, creating a sandbox, or using subscriber resources. | `lib/demo/`, `components/demo/` |
| Security operations | Separate credentials protect diagnostics, scheduled reconciliation, and manual reconciliation. | `lib/runner/auth.ts`, `docs/security/incident-response.md` |
| Deployment posture | Git-triggered Vercel deployments are denied by repository configuration; reintroduction requires a separately reviewed runbook. | `vercel.json`, `docs/operations/vercel-git-deployment-disablement.md`, `scripts/deployment-documentation-policy.ts` |
| Planning documents | A canonical registry classifies current, proposed, historical, and superseded planning artifacts, with a local coverage and supersession check. | `docs/roadmap/README.md`, `scripts/planning-docs-policy.ts` |

## Public delivery evidence

- [PR #128](https://github.com/OpenCoven/coven-agents/pull/128) merged as
  `bd46bece9ea9b33700f3316919c6f035aad7d7d1`.
- [PR #133](https://github.com/OpenCoven/coven-agents/pull/133) merged as
  `acc7ca3fa2dd51f496e1900573f239eb8a158ce6`.
- [PR #134](https://github.com/OpenCoven/coven-agents/pull/134) merged as
  `1bec409b399651d8a115e4518a0f444e9753a728`.
- [PR #147](https://github.com/OpenCoven/coven-agents/pull/147) records the
  completed Daytona infrastructure cutover and retired-provider cleanup.
- [PR #162](https://github.com/OpenCoven/coven-agents/pull/162) added the
  deny-only Vercel Git deployment control.
- [PR #171](https://github.com/OpenCoven/coven-agents/pull/171) added
  tenant-fenced skill, team, approval, and persistence foundations.
- [PR #173](https://github.com/OpenCoven/coven-agents/pull/173) and
  [PR #176](https://github.com/OpenCoven/coven-agents/pull/176) added
  lease-fenced checkout recovery and transactional paid-period authority.
- [PR #174](https://github.com/OpenCoven/coven-agents/pull/174) added bounded
  handoffs and durable workspace-only team-run orchestration.

The application baseline also includes the merged console, billing,
deployment-policy, branding, runner-reliability, coordinated-team, dependency,
and session-path corrections through
`f211e49eb2c633759c63e1cb077a9e44e5bdc172`. The
[cutover attestation](../operations/daytona-cutover-attestation.md) records
infrastructure production evidence while preserving the remaining product
certification and approval gates.

## Known gaps

- No retained full subscriber create, standalone and coordinated run, stream,
  stop, delete, and cross-tenant production-equivalent artifact exists.
- Complete outbound policy evidence remains open.
- End-to-end evidence redaction, restart recovery, retention, export, and
  deletion require broader certification.
- Only GitHub Copilot CLI has implemented event translation.
- GitHub-capable team steps remain intentionally blocked until approved
  operations use a bounded production capability broker.
- GitHub Actions remain intentionally disabled, so local gates are the only
  repository verification boundary.
- Git-triggered Vercel deployments remain intentionally disabled.
- Private planning reconciliation must be performed by an authorized
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
