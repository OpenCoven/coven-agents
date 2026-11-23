# Verification matrix

## Local baseline checkpoint

PR #302 is merged at `181e389fd5e61b44b7626d8fd541209c88b9cfd5`. Its tree matches the tested PR head `4f06dfe342ab366f570297276b2f772cbf22f424`. Frozen installation, build, 2,927 unit tests, 17 disposable PostgreSQL tests, and 34 fixture-backed browser tests passed on the PR tree. Eight unit cases and 16 browser cases were skipped by their existing conditions. Check and typecheck passed again on the merged checkout. The first concurrent unit run hit a test deadline, and the serial full rerun passed with the original deadline. Isolated-checkout hygiene passed. Shared-checkout hygiene reported other active local work. [Baseline verification receipt](https://github.com/OpenCoven/coven-agents/pull/302#issuecomment-7000058884)

## Castles contract checkpoint

The scoped owner and inspection merge is `d1df95c2e202576ff396f786edffd90ece4f303d`. The qualified PR tree passed 3,209 unit, 23 disposable PostgreSQL, and 35 hermetic browser cases. Its inspection contract is pinned in the #296 closure, and the owner credential acceptance is recorded in #297. [Inspection pin](https://github.com/OpenCoven/coven-agents/issues/296#issuecomment-7000403983) · [Owner credential evidence](https://github.com/OpenCoven/coven-agents/issues/297#issuecomment-7000412838)

Guarded binding and execution evidence merged at `1496f0bbb09ac43de596e90baca1ef835caf648b`. The merge tree matches the qualified tree that passed 3,227 unit, 24 disposable PostgreSQL, and 35 hermetic browser cases. The exact merged checkout passed static checks, typecheck, and the focused binding and prewarm tests. Live Castles and Daytona acceptance remains pending. [Guarded binding evidence](https://github.com/OpenCoven/coven-agents/issues/298#issuecomment-7000529257)

### Sandbox inspection candidates

Producer [PR #324](https://github.com/OpenCoven/coven-agents/pull/324) at `6dedc26e9d49d945fc2442252c531b9ffdba3e18` and consumer [Castles PR #21](https://github.com/OpenCoven/coven-castles/pull/21) at `910d60ed770516e21446760fced3779a9868375f` match the 40-case compatibility receipt. The consumer is stacked on [Castles PR #18](https://github.com/OpenCoven/coven-castles/pull/18) at `e064756cd6f9cf404cf582d9407db3e5e6aa9b4f`. The maintainer approved the additive wire convention. Independent review of this pair and final acceptance are pending. [Contract decision](https://github.com/OpenCoven/coven-agents/pull/324#issuecomment-7081318179) · [Compatibility receipt](https://github.com/OpenCoven/coven-agents/issues/322#issuecomment-7081475247)

| Requirement | Candidate evidence | Acceptance gate |
| --- | --- | --- |
| #322 TTL, warm pool, linked sandbox and volumes | The recording provider exercised each omission. In detailed mode, each unknown survives JSON rendering and causes a field-specific refusal. Explicit false or zero survives as known absence. True or a positive count triggers the corresponding policy refusal. Default v1 remains compatible. A fresh synthetic replay of the 16 `#322 detail` tests passed, including exact inspection call counts, malformed inputs and redaction. | Independent review and maintainer acceptance of the tested pair. [Producer cases](https://github.com/OpenCoven/coven-agents/issues/322#issuecomment-7038161849) · [Consumer tests](https://github.com/OpenCoven/coven-castles/blob/910d60ed770516e21446760fced3779a9868375f/tests/preflight.test.ts) |
| #323 OS and architecture | Daytona SDK 0.231.1 supplies neither field on its exact-ID Sandbox response. The candidate emits two nulls. Castles can infer platform policy when the qualified snapshot pin matches. A synthetic replay through this consumer supplied OS alone, architecture alone and both together. Each valid input rendered two observed nulls. Even a Windows input against the qualified Linux snapshot returned fixture-ready. A numeric OS was refused. Every case returned false for live readiness. | The maintainer must decide whether unknown satisfies each field. If observations are required, the provider adapter owner must identify an authorized exact-ID source and demonstrate each populated field plus independent omissions through the consumer. The Castles #2 steward must also preserve reported values and decide how a conflict with snapshot policy affects readiness. [Platform checkpoint](https://github.com/OpenCoven/coven-agents/issues/323#issuecomment-7038162870) · [Producer mapping](https://github.com/OpenCoven/coven-agents/blob/6dedc26e9d49d945fc2442252c531b9ffdba3e18/lib/runner/daytona/resource-inspection.ts) |

## Billing ledger checkpoint

The account-keyed pack ledger landed at `1a2f4479a4eacd0b2376630eb168aa9770b55e6e`. Its merge tree passed 3,240 unit, 35 disposable PostgreSQL, and 35 hermetic browser tests. The database suite verified a fresh install, an upgrade from runner migration 0047, cap changes, key rotation, and refusal of unresolved paid history. The browser suite passed after a fresh Next.js cache retry. Production migration and live acceptance remain separate. [Cap-change evidence](https://github.com/OpenCoven/coven-agents/issues/225#issuecomment-7005167520) · [Key-rotation evidence](https://github.com/OpenCoven/coven-agents/issues/226#issuecomment-7005167860)

## Historical release evidence

This matrix records implemented source and retained evidence as of 2026-09-09
for application baseline `93b4784b8622cf371e63347f034df3cdd8aac70d`
and draft [PR #268](https://github.com/OpenCoven/coven-agents/pull/268), which
adds the bounded containment diagnostic. Repository and local contract
procedures are verified; infrastructure cutover evidence is retained; public
guest replay, Production-config operator paths, a non-promoted exact latest-main
production-target candidate, and the exact production Daytona snapshot profile
are verified. Persistent Daytona reuse, subscriber certification, observation,
and full product release certification remain pending.

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
| Paid subscription authority | `Verified` | Checkout lease, atomic webhook claim+mutation, paid-interval, reconciliation, strict expiry, shared user/auth-version/resolution authority, bounded invalidation, configuration, idempotency, abuse-order, and browser coverage | Real Stripe checkout, delayed authority refresh, expiry, webhook redelivery after an injected owner-write failure, retry, and manual-reconciliation exercise when billing is enabled |
| Subscriber checkout surfaces | `Verified` | Account and console subscription components, authoritative run-cap rendering, canonical-path handling, checkout confirmation recovery, and checkout-enabled/disabled browser matrices | Retained release-equivalent account and console exercise across reload, identity transition, delayed webhook authority, and disabled billing |
| Credential authorization lifecycle | `Verified` | Owner-bound device-flow binding, abortable canonical-path polling, claim-before-provider ordering, atomic credential/replay commit, authority-scoped caching, and refusal invalidation coverage | Real OAuth device authorization with authority loss, retry, lost-response replay, and cross-user refusal evidence |
| Coordinated team execution | `Verified` | Strict contracts, tenant-fenced CRUD and persistence, deterministic child reservations, bounded handoffs, durable orchestration, cancellation, approval, migration, and production-route coverage | Release-equivalent workspace-only team run with approval, cancellation, recovery, redaction, and cross-tenant evidence; brokered operations before GitHub-capable steps |
| Guest replay | `Verified` | `lib/demo/`, `components/demo/`, `scripts/demo-route.test.ts`, `tests/e2e/demo.test.ts`, and `tests/e2e/demo-adversarial.test.ts` prove bounded fixture replay, zero replay API/external traffic, zero application-table writes, tampered-session refusal, and fixture/product identifier separation. On 2026-09-01, Vercel deployment `dpl_DcRGhHtEUD33Jvmy3qQiHiwRmV8t` built exact `main` commit `3ad1232f061b5eaf4440b6fd3c7c13967a6c423f` in a separate project with no stored environment variables; anonymous Chromium completed the 10-event replay twice with zero API or cross-origin requests, zero console errors, and empty browser storage. | Re-run the public replay receipt after fixture, rendering, or deployment-boundary changes |
| Subscriber classification | `Verified` | Auth unit coverage and 28-case authenticated browser contract | Real OAuth and active/expired account exercise |
| Same-origin execution session | `Verified` | Browser transport, runner authorization, product-boundary, and browser contract tests | Production-equivalent Auth.js request evidence |
| Tenant credential custody | `Verified` | Credential, isolation, and evidence-safety unit suites | Retained production-equivalent isolation and redaction exercise |
| Cross-surface evidence redaction | `Verified` | `packages/agent-contracts/src/evidence-safety.test.ts`, `lib/runner/evidence.test.ts`, `lib/runner/daytona/process.test.ts`, `lib/runner/reconcile.test.ts`, `lib/runner/http.test.ts`, `lib/runner/daytona/resource-inventory.test.ts`, `lib/runner/resource-observability.test.ts`, and `lib/runner/production.test.ts` prove bounded exact redaction, adapter and neutral defense in depth, categorical observability, safe failures, and tenant-B refusal. The [Production-config receipt](../operations/p0-production-config-receipt-2026-09-01.json) retains sanitized diagnostic, inventory, reconciliation, and cross-channel refusal results without credential material. | Dated deployed tenant attempt plus retained credential-free browser API/SSE, provider-failure, and cross-tenant refusal captures. This row is a focused verification slice, not full release or security-program closure. |
| Hermetic PostgreSQL browser certification | `Verified` | The [hermetic receipt](../operations/p0-hermetic-receipt-2026-09-01.json) records `pnpm db:check` and `pnpm test:e2e:hermetic` passing on 2026-09-01: 11 browser cases against disposable PostgreSQL for application baseline `3ad1232f061b5eaf4440b6fd3c7c13967a6c423f`, covering signed Auth.js sessions, current `authVersion`, real API/SSE/cancellation/reconciliation, tenant-cap admission, launched and queued revocation, anonymous replay, hostile anonymous route calls, fixture separation, and unchanged application-table fingerprints | Deployed Daytona staging and production-safe evidence; hermetic certification does not replace provider or deployment proof |
| Daytona lifecycle | `Verified` | Daytona adapter and runner service unit suites, the Production-config receipt's successful bounded create/execute/delete diagnostic, [PR #267](https://github.com/OpenCoven/coven-agents/pull/267)'s production verification of `coven-agents-copilot-2` at 2 vCPU, 4 GiB memory, 10 GiB disk, and target `us`, and the [resource-repair receipt](../operations/p0-daytona-resource-repair-receipt-2026-09-02.json) | Merge, deploy, and retain draft [PR #268](https://github.com/OpenCoven/coven-agents/pull/268)'s exact detached-descendant and synthetic credential-cleanup receipt, then complete the approved persistent tenant sandbox reset/reuse, run, stop, delete, and cleanup exercise |
| Daytona resource disposition | `Blocked` | The resource-repair receipt proves four unique durable mappings, four stopped resources, zero unowned resources, below-only CPU/memory/disk drift, three definitive HTTP 404 resize rejections, zero remaining resize fences, and zero deletions, recreations, or adoptions | Provider-supported non-destructive resize, or an explicitly approved migration that preserves each durable workspace before replacement |
| Idempotent starts | `Verified` | Admission, store, and browser retry unit suites | Retry exercise against release-equivalent PostgreSQL |
| Cursor-safe SSE | `Verified` | Server and browser reconnect/cursor unit suites | Release-equivalent reconnect exercise with retained cursor evidence |
| Persisted recovery | `Verified` | Reconciliation, store, and hermetic browser suites prove a bounded finish-current recovery for one exact launched attempt, while revoked unlaunched work remains refused | Interrupted deployed provider-attempt convergence following an entitlement revocation and idempotent rerun |
| Outbound policy | `Implemented` | Daytona domain configuration and tests | Enforced denial and recovery evidence |
| Planning document registry | `Verified` | `docs/roadmap/README.md`, `scripts/planning-docs-policy.ts`, and focused policy coverage | Maintain links to delivery issues and exact landed evidence |
| Machine-readable readiness receipt | `Implemented` | `scripts/readiness-receipt.ts`, focused strict-schema and false-`go` policy coverage, and the [release readiness](release-readiness.md) operator procedure | Exact-deployment receipt validated against independent candidate and rollback manifests with complete durable journey evidence and authorized signed approvals |
| Vercel Git deployment disablement | `Verified` | `vercel.json`, deployment documentation policy, and focused unit coverage | Account-level project disconnection only if full Vercel retirement is separately approved |
| Production smoke and rollback | `Pending` | [release readiness](release-readiness.md), [cutover attestation](../operations/daytona-cutover-attestation.md), the Production-config receipt, the resource-repair receipt, and the [latest-main candidate receipt](../operations/p0-latest-main-candidate-receipt-2026-09-02.json) prove exact-build health, closed-beta refusal, exact snapshot configuration, bounded provider/Stripe operator access, credential separation, alias state, definitive resize rejection recovery, aggregate inventory, and a non-promoted latest-main build with signed-out and operator refusal smoke | Authenticated subscriber promotion and rollback, deployed containment receipt, persistent sandbox lifecycle, resolved provider-blocked inventory disposition, observation window, and named approvals |

The [Daytona cutover audit](daytona-cutover-audit-2026-08-29.md) records the
documentation and repository assessment. Any relevant code, configuration,
schema, or dependency change invalidates the affected row until its procedure
is rerun.
