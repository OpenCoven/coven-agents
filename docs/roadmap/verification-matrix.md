# Verification Matrix

This matrix records implemented source and retained evidence as of 2026-08-31
for application baseline `fc7578f39beae2541fd288fc8c16871a943574a3`
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
| Subscription checkout gating | `Verified` | Checkout response, configuration, idempotency, abuse-order, and runtime validation unit coverage | Real Stripe checkout and webhook transition exercise when billing is enabled |
| Guest replay | `Verified` | `lib/demo/`, `components/demo/`, `scripts/demo-route.test.ts`; final unit gate | Retained release-equivalent replay artifact |
| Subscriber classification | `Verified` | Auth unit coverage and 28-case authenticated browser contract | Real OAuth and active/expired account exercise |
| Same-origin execution session | `Verified` | Browser transport, runner authorization, product-boundary, and browser contract tests | Production-equivalent Auth.js request evidence |
| Tenant credential custody | `Verified` | Credential, isolation, and evidence-safety unit suites | Retained production-equivalent isolation and redaction exercise |
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
