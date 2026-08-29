# Verification Matrix

This matrix records implemented source and retained evidence as of 2026-08-29.
The current candidate has not completed its final branch gates. No row is
`Verified` or `Certified` without retained, dated evidence tied to the cited
candidate.

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
| Guest replay | `Implemented` | `lib/demo/`, `components/demo/`, `scripts/demo-route.test.ts` | Retained release-equivalent replay artifact |
| Subscriber classification | `Implemented` | `app/(auth)/auth.ts`, `lib/auth/subscriber-authorization.server.ts` | Real OAuth and active/expired account exercise |
| Same-origin execution session | `Implemented` | `lib/agents/browser-transport.test.ts`, `lib/runner/auth.test.ts`, `scripts/product-boundary.test.ts` | Production-equivalent Auth.js request evidence |
| Tenant credential custody | `Implemented` | `lib/credentials/*.test.ts`, evidence safety tests | Retained isolation and redaction exercise |
| Daytona lifecycle | `Implemented` | `lib/runner/daytona/*.test.ts`, `lib/runner/service.test.ts` | Dated create, reuse, run, stop, delete, and cleanup artifact |
| Idempotent starts | `Implemented` | `lib/runner/admission.test.ts`, `lib/runner/store.test.ts` | Retry exercise against release-equivalent PostgreSQL |
| Cursor-safe SSE | `Implemented` | `lib/runner/sse.test.ts`, `lib/agents/browser-transport.test.ts` | Reconnect exercise with retained cursor evidence |
| Persisted recovery | `Implemented` | `lib/runner/reconcile.test.ts`, `lib/runner/store.test.ts` | Interrupted-attempt convergence and idempotent rerun |
| Outbound policy | `Implemented` | Daytona domain configuration and tests | Enforced denial and recovery evidence |
| Production smoke and rollback | `Pending` | [release readiness](release-readiness.md), [cutover attestation](../operations/daytona-cutover-attestation.md) | Authorized promotion and rollback record |

The [Daytona cutover audit](daytona-cutover-audit-2026-08-29.md) records the
documentation and repository assessment. Any relevant code, configuration,
schema, or dependency change invalidates the affected row until its procedure
is rerun.
