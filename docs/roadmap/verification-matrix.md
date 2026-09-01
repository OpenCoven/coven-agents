# Verification Matrix

This matrix records implemented source and retained evidence as of 2026-08-31
for application baseline `f0ffb3124ab6a39d776bd9f7b5e77fd652b4c27e`
and the planning-document candidate that updates this matrix. Repository and
local contract procedures are verified; infrastructure cutover evidence is
retained; full product release certification remains pending.

## State vocabulary

| State | Meaning |
| --- | --- |
| `Not implemented` | No complete supported path exists. |
| `Implemented` | Code exists but its required procedure lacks retained evidence. |
| `Pending` | The required procedure or approval has not yet been completed. |
| `Verified` | A deterministic local or staging procedure passed for the cited candidate. |
| `Certified` | Release-equivalent evidence is retained and owner-approved. |
| `Blocked` | A named prerequisite prevents the required procedure. |

## Current matrix

| Capability | State | Repository evidence | Required next evidence |
| --- | --- | --- | --- |
| Console profile execution | `Verified` | `lib/console/agent-profile.ts`, console component coverage, responsive contract tests, and production build | Release-equivalent subscriber exercise and accessibility evidence |
| Paid subscription authority | `Verified` | Checkout lease, provider recovery, webhook transaction, paid-interval, reconciliation, strict expiry, shared user/auth-version/resolution authority, bounded invalidation, configuration, idempotency, abuse-order, and browser coverage | Real Stripe checkout, delayed authority refresh, expiry, webhook, retry, and manual-reconciliation exercise when billing is enabled |
| Subscriber checkout surfaces | `Verified` | Account and console subscription components, authoritative run-cap rendering, canonical-path handling, checkout confirmation recovery, and checkout-enabled/disabled browser matrices | Retained release-equivalent account and console exercise across reload, identity transition, delayed webhook authority, and disabled billing |
| Credential authorization lifecycle | `Verified` | Owner-bound device-flow binding, abortable canonical-path polling, claim-before-provider ordering, atomic credential/replay commit, authority-scoped caching, and refusal invalidation coverage | Real OAuth device authorization with authority loss, retry, lost-response replay, and cross-user refusal evidence |
| Coordinated team execution | `Verified` | Strict contracts, tenant-fenced CRUD and persistence, deterministic child reservations, bounded handoffs, durable orchestration, cancellation, approval, migration, and production-route coverage | Release-equivalent workspace-only team run with approval, cancellation, recovery, redaction, and cross-tenant evidence; brokered operations before GitHub-capable steps |
| Guest replay | `Verified` | `lib/demo/`, `components/demo/`, `scripts/demo-route.test.ts`; final unit gate | Retained release-equivalent replay artifact |
| Subscriber classification | `Verified` | Auth unit coverage and 28-case authenticated browser contract | Real OAuth and active/expired account exercise |
| Same-origin execution session | `Verified` | Browser transport, runner authorization, product-boundary, and browser contract tests | Production-equivalent Auth.js request evidence |
| Tenant credential custody | `Verified` | Credential, isolation, and evidence-safety unit suites | Retained production-equivalent isolation and redaction exercise |
| Cross-surface evidence redaction | `Verified` | `packages/agent-contracts/src/evidence-safety.test.ts`, `lib/runner/evidence.test.ts`, `lib/runner/daytona/process.test.ts`, `lib/runner/reconcile.test.ts`, `lib/runner/http.test.ts`, `lib/runner/daytona/resource-inventory.test.ts`, `lib/runner/resource-observability.test.ts`, and `lib/runner/production.test.ts` prove bounded exact redaction, adapter and neutral defense in depth, categorical observability, safe failures, and tenant-B refusal | Dated deployed Daytona attempt plus retained credential-free browser API/SSE, internal inventory/diagnostic, provider-failure, and cross-tenant refusal captures. This row is a focused local verification slice, not full release or security-program closure. |
| Hermetic PostgreSQL browser certification | `Implemented` | `pnpm test:e2e:hermetic`, guarded server-only executor, disposable PostgreSQL seed, signed Auth.js cookies, real API/browser assertions, and demo zero-write inventory | Dated successful local command record; this does not replace Daytona or deployed-environment evidence |
| Daytona lifecycle | `Verified` | Daytona adapter and runner service unit suites | Dated provider create, reuse, run, stop, delete, and cleanup artifact |
| Idempotent starts | `Verified` | Admission, store, and browser retry unit suites | Retry exercise against release-equivalent PostgreSQL |
| Cursor-safe SSE | `Verified` | Server and browser reconnect/cursor unit suites | Release-equivalent reconnect exercise with retained cursor evidence |
| Persisted recovery | `Verified` | Reconciliation and store unit suites | Interrupted provider-attempt convergence and idempotent rerun |
| Outbound policy | `Implemented` | Daytona domain configuration and tests | Enforced denial and recovery evidence |
| Planning document registry | `Verified` | `docs/roadmap/README.md`, `scripts/planning-docs-policy.ts`, and focused policy coverage | Final Beads-to-Project no-op reconciliation before authority-derived status refresh |
| Vercel Git deployment disablement | `Verified` | `vercel.json`, deployment documentation policy, and focused unit coverage | Account-level project disconnection only if full Vercel retirement is separately approved |
| Production smoke and rollback | `Pending` | [release readiness](release-readiness.md), [cutover attestation](../operations/daytona-cutover-attestation.md) | Authorized promotion and rollback record |

The [Daytona cutover audit](daytona-cutover-audit-2026-08-29.md) records the
documentation and repository assessment. Any relevant code, configuration,
schema, or dependency change invalidates the affected row until its procedure
is rerun.
