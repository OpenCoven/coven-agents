# Current repository state

- Snapshot date: 2026-11-23
- Repository baseline: `0696af127207fb82cce734cd8c4ffa437d6f3502`
- Deployment and live-provider state: not requalified by this repository snapshot
- Evidence class: verified repository and local contract evidence, retained infrastructure cutover and Production-config operator evidence, a public exact-build guest replay, a non-promoted exact latest-main production candidate, and an exact production Daytona snapshot receipt

The historical infrastructure receipts summarized below include merged P0 repository certification through PR #183, the replay-timeline correction in PR #184, the public exact-build guest replay recorded by PR #185, unreachable UI removal in PR #186, retained exact-preview and hermetic receipts in PR #187, the subscriber launch runbook in PR #188, the fenced Daytona resource-repair path in PR #198, and definitive provider rejection handling in PR #200, the sanitized blocker receipt in PR #201, and the coordinated team console in PR #199. PR #266 added actionable bounded snapshot verification failures, and PR #267 added the exact protected snapshot receipt and shared diagnostic deadline. It distinguishes those completed boundaries and the successful Production-config operator checks from pending persistent Daytona lifecycle, subscriber certification, observation-window, and full product release approval.

## Current delivery and acceptance

Main includes scoped owner credentials and inspection from #311, guarded binding from #312, contributor signing and hook safeguards, the account-keyed pack ledger from #317/#318, gate repair from #319 and Beads retirement from #321. Issues #296, #297, #298, #225 and #226 are closed at their repository-contract boundaries. Their historical receipts do not certify a later deployment or a live subscriber journey.

The owner-read, public attempt-reference, Codex/Claude CLI and detailed-inspection changes remain separate unmerged candidates. The current review and exact-head evidence are recorded in [#320](https://github.com/OpenCoven/coven-agents/pull/320), [#327](https://github.com/OpenCoven/coven-agents/pull/327), [#330](https://github.com/OpenCoven/coven-agents/pull/330) and [#324](https://github.com/OpenCoven/coven-agents/pull/324). The CLI review found and corrected a real auth.json persistence defect; the correction stages only supported fields and validates individual private values against the unchanged codec. A prior candidate's passing full suite is not evidence for a later head.

Fresh owner-read qualification at `cda3c2b434db3f7bac3f5f8930e89e05d53c81ae` passed hygiene, lint, typecheck, build, 3,108 unit cases with 13 conditional skips and 36 disposable PostgreSQL cases with no skips. Earlier normal browser runs failed initial document/assets on unchanged main and this candidate. A later exact-head run at lower host load reached the input but failed while clicking a disabled/detaching Send button; its 60-second test and 120-second suite limits were unchanged. The cause remains unresolved. Investigative cache/font experiments do not certify this head.

The separate validation-only composition `7553744641348f37145fb70fd674b2f26a24228e` passed all five local gates, 3,140 unit cases with 18 conditional skips, 41 disposable PostgreSQL cases with zero skips and the unchanged normal hermetic browser gate with 35 passes and 16 conditional skips. It combines the four source candidates and test-only isolation fixes; it is not a substitute delivery branch or a landed revision. The successful browser run used no font mock, thread-pool override, assertion change or deadline change. Required source-head qualification, ownership and consumer acceptance still govern each PR.

The shared root checkout contains other workers' retained worktrees. Isolated task-clone hygiene does not certify global workspace cleanup; no unrelated branch, worktree or evidence was deleted. Actions and Git-triggered deployments remain disabled. Production OAuth completion, tenant A/B isolation, provider containment/reuse and paid billing remain unverified for a single current release candidate. Preserve the issue-specific owner handoffs rather than replacing them with local test results.

## Sandbox inspection as of November 23, 2026

The merged v1 inspection response supports the default caller. It folds missing TTL and attachment metadata into booleans or a volume count. Producer PR #324 and Castles PR #21 propose an opt-in detail block that preserves unknown values. Both PRs are open, and #21 is stacked on Castles #18. The accepted Castles #2 revision remains `3e6d01539aecf2358c81f4561d856fcd89ef4413`. See the [verification matrix](verification-matrix.md#sandbox-inspection-candidates) for the tested pair, platform limitation and outstanding decisions. [Issue #322](https://github.com/OpenCoven/coven-agents/issues/322) · [Issue #323](https://github.com/OpenCoven/coven-agents/issues/323)

## Implemented surfaces

| Surface | Current repository reality | Evidence |
| --- | --- | --- |
| Product application | Next.js 16 serves authenticated account, agent, team, skill, run, analytics, settings, and administration surfaces. | `app/`, `components/` |
| Console workspace | Every stored agent profile resolves to a bounded execution profile; the workspace presents responsive creation, resizable rails, rendered runner Markdown, and structured research-report evidence. | `lib/console/agent-profile.ts`, `components/console/`, `app/console.css` |
| Browser execution access | Browser code calls relative same-origin `/api` routes with the Auth.js session. | `lib/agents/browser-transport.ts`, `lib/agents/client.ts` |
| Authority | Protected routes revalidate subscriber state and derive tenant ownership on the server. Shared browser authority is scoped to the exact user, auth version, finite paid-through boundary, and unique server resolution; current authorization refusals invalidate that authority across consumers. | `lib/auth/subscriber-authorization.server.ts`, `lib/subscription-authority.ts`, `lib/subscription-authority-refresh.ts`, `lib/runner/runtime.ts` |
| Subscription authority | Checkout is explicitly gated, authentication-first, abuse-bounded, operation-idempotent, lease-fenced, and recoverable across uncertain provider outcomes. Signature-verified webhooks update paid intervals transactionally and persist bounded manual-reconciliation records when authority cannot be applied safely. | `lib/billing/checkout-lease.ts`, `lib/billing/checkout-response.ts`, `lib/billing/webhook.ts`, `lib/db/stripe-event.ts` |
| Subscription surfaces | Account and console settings render the authoritative run allowance, preserve checkout confirmation ownership across reloads and identity transitions, refresh delayed server authority within bounded incidents, and fail closed at the paid-through boundary. | `components/billing/subscription-card.tsx`, `hooks/use-subscription-authority-refresh.ts`, `components/account/account-settings.tsx`, `components/console/settings.tsx` |
| Credential authorization | Copilot device authorization is bound to its initiating subscriber and canonical application path. Polling claims owner-scoped idempotency before provider exchange, then atomically verifies current authority, stores the encrypted credential, and completes only bounded replay evidence. | `lib/credentials/device-flow-binding.ts`, `lib/credentials/device-poll.ts`, `lib/credentials/device-poll-commit.ts`, `lib/application-path.ts` |
| Coordinated teams | Authenticated tenants can manage bounded skill and team definitions and start durable team runs. Immutable authority, agent, skill, and child-run snapshots fence execution; handoffs are UTF-8 byte-bounded and sanitized; workspace-only Copilot steps are orchestrated durably while GitHub-capable steps fail closed until brokered. | `packages/agent-contracts/src/index.ts`, `lib/teams/`, `app/api/teams/`, `app/api/team-runs/` |
| Hosted execution boundary | Daytona is the sole production execution provider. Each agent owns a persistent tenant-scoped sandbox with explicit bounded CPU, memory, disk, auto-stop, and auto-archive policy; TTL and auto-delete are disabled so fenced recovery and decommission remain deletion authority. Attempts use short-lived process sessions. The protected production diagnostic verified snapshot `coven-agents-copilot-2` at 2 vCPU, 4 GiB memory, 10 GiB disk, and target `us`. Dispatch, per-attempt reconciliation, and persistent-resource lifecycle pass through server-only provider-neutral contracts; hermetic certification uses the same resource lifecycle contract without a hosted provider resource. | `lib/runner/executor.ts`, `lib/runner/attempt-reconcile.ts`, `lib/runner/resource-lifecycle.ts`, `lib/runner/daytona/` |
| Durable ownership | PostgreSQL stores agent, run, event, admission, dispatch, attempt, cancellation, and reconciliation state. | `lib/runner/store.ts`, `lib/db/schema.ts` |
| Credential custody | Tenant harness credentials are encrypted, AAD-bound, acquired as immutable one-use snapshots, staged through one fixed per-call environment value into a mode-`0600` attempt path, removed before harness execution, and compensated or retained for fenced recovery on failed launch. Daytona Secrets and operator credentials are not used for tenant runs. | `lib/credentials/`, `lib/runner/daytona/process.ts`, `lib/runner/runtime.ts` |
| Run reliability | Starts are operation-idempotent, SSE resumes from numeric cursors, and reconciliation uses database-time leases and exact fences. | `lib/runner/admission.ts`, `lib/runner/sse.ts`, `lib/runner/attempt-reconcile.ts`, `lib/runner/daytona/resource-recovery.ts` |
| Guest replay | A committed bounded, provenance-marked replay renders without API, external-network, database-write, credential, billing, or provider effects. Anonymous route manipulation and tampered session material cannot promote fixture identifiers into product authority. | `lib/demo/`, `components/demo/`, `tests/e2e/demo.test.ts`, `tests/e2e/demo-adversarial.test.ts` |
| Security operations | Separate credentials protect diagnostics, scheduled reconciliation, and manual reconciliation. A read-only internal resource inventory uses reconciliation authorization, scans only the app label and bounded durable mappings, returns versioned aggregate categories with exclusive ambiguity reasons and fixed configuration-drift field/direction counts, and never deletes or adopts provider-only observations. Manual resource repair uses exact stored provider IDs, durable lifecycle fences, stopped-only and below-only eligibility, bounded concurrency, post-mutation verification, and aggregate-only responses. | `lib/runner/auth.ts`, `lib/runner/http.ts`, `lib/runner/daytona/resource-inventory.ts`, `lib/runner/daytona/resource-repair.ts`, `docs/security/incident-response.md` |
| Deployment posture | Git-triggered Vercel deployments are denied by repository configuration; reintroduction requires a separately reviewed runbook. | `vercel.json`, `docs/operations/vercel-git-deployment-disablement.md`, `scripts/deployment-documentation-policy.ts` |
| Planning documents | A canonical registry classifies current, proposed, historical, and superseded planning artifacts, with a local coverage and supersession check. | `docs/roadmap/README.md`, `scripts/planning-docs-policy.ts` |

## Public delivery evidence

- [PR #128](https://github.com/OpenCoven/coven-agents/pull/128) merged as `bd46bece9ea9b33700f3316919c6f035aad7d7d1`.
- [PR #133](https://github.com/OpenCoven/coven-agents/pull/133) merged as `acc7ca3fa2dd51f496e1900573f239eb8a158ce6`.
- [PR #134](https://github.com/OpenCoven/coven-agents/pull/134) merged as `1bec409b399651d8a115e4518a0f444e9753a728`.
- [PR #147](https://github.com/OpenCoven/coven-agents/pull/147) records the completed Daytona infrastructure cutover and retired-provider cleanup.
- [PR #162](https://github.com/OpenCoven/coven-agents/pull/162) added the deny-only Vercel Git deployment control.
- [PR #171](https://github.com/OpenCoven/coven-agents/pull/171) added tenant-fenced skill, team, approval, and persistence foundations.
- [PR #173](https://github.com/OpenCoven/coven-agents/pull/173) and [PR #176](https://github.com/OpenCoven/coven-agents/pull/176) added lease-fenced checkout recovery and transactional paid-period authority.
- [PR #174](https://github.com/OpenCoven/coven-agents/pull/174) added bounded handoffs and durable workspace-only team-run orchestration.
- [PR #178](https://github.com/OpenCoven/coven-agents/pull/178) added resilient subscriber checkout surfaces, canonical application paths, and owner-bound credential authorization.
- [PR #179](https://github.com/OpenCoven/coven-agents/pull/179) and [PR #180](https://github.com/OpenCoven/coven-agents/pull/180) added and integrated shared subscription-authority invalidation, strict expiry, and authority-scoped credential lifecycle controls.
- [PR #183](https://github.com/OpenCoven/coven-agents/pull/183) merged the P0 provider-neutral execution, billing, entitlement, credential, replay, and hermetic certification gates as `52fe9f8`.
- [PR #184](https://github.com/OpenCoven/coven-agents/pull/184) stabilized replay event timelines.
- [PR #185](https://github.com/OpenCoven/coven-agents/pull/185) recorded the credential-free public exact-build guest replay.
- [PR #186](https://github.com/OpenCoven/coven-agents/pull/186) removed unreachable UI and orphaned dependency residue.
- [PR #187](https://github.com/OpenCoven/coven-agents/pull/187) retained the exact-preview and 11-case hermetic PostgreSQL receipts.
- [PR #188](https://github.com/OpenCoven/coven-agents/pull/188) added the subscriber launch runbook.
- [PR #198](https://github.com/OpenCoven/coven-agents/pull/198) added exact, durably fenced, stopped-only Daytona resource repair.
- [PR #200](https://github.com/OpenCoven/coven-agents/pull/200) made definitive provider resize rejections release their exact fences while preserving fail-closed handling for ambiguous outcomes.
- [PR #201](https://github.com/OpenCoven/coven-agents/pull/201) retained the sanitized Daytona resize-blocker receipt.
- [PR #266](https://github.com/OpenCoven/coven-agents/pull/266) made snapshot verification failures bounded, redacted, and actionable.
- [PR #267](https://github.com/OpenCoven/coven-agents/pull/267) added the exact protected snapshot receipt and deployed production verification.
- [PR #199](https://github.com/OpenCoven/coven-agents/pull/199) added the coordinated team console and its bounded service and browser contracts.

The application baseline also includes the merged console, billing, deployment-policy, branding, runner-reliability, coordinated-team, dependency, subscriber-surface, credential-lifecycle, and session-path corrections through `93b4784b8622cf371e63347f034df3cdd8aac70d`. The [cutover attestation](../operations/daytona-cutover-attestation.md) records infrastructure production evidence, exact application-preview results, and the [Production-config operator receipt](../operations/p0-production-config-receipt-2026-09-01.json) and the [resource-repair receipt](../operations/p0-daytona-resource-repair-receipt-2026-09-02.json) while preserving the remaining product certification and approval gates. The [latest-main candidate receipt](../operations/p0-latest-main-candidate-receipt-2026-09-02.json) records an exact production-target build with automatic domain promotion disabled, successful health, signed-out product refusal, operator credential refusal, and no claim of subscriber or provider lifecycle certification.

## Known gaps

- No retained full subscriber create, standalone and coordinated run, stream, stop, delete, and cross-tenant production-equivalent artifact exists.
- The retained September Production-config receipts record successful diagnostics, Stripe reconciliation, runner reconciliation, closed-beta refusal, operator credential separation and the exact production snapshot diagnostic. The resource-repair receipt observed four uniquely mapped stopped resources with below-policy CPU, memory and disk drift, definitive HTTP 404 resize refusals, released repair fences and no deletion, recreation or adoption. Current inventory is unverified; #262 requires a refreshed operator observation and either provider-supported non-destructive repair or an explicitly approved workspace-preserving migration.
- The protected containment diagnostic source from [PR #268](https://github.com/OpenCoven/coven-agents/pull/268) landed in commit `a16de59c4047a25eebb293b608752b0a0393e8d6` and is included in the repository baseline. Source coverage for a deliberate detached descendant and synthetic attempt credential cleanup does not satisfy the pending deployed containment receipt or the approved reset and workspace-preserving reuse exercise under #262.
- The historical paid-configuration receipt recorded disabled Checkout, a `$30/month` Price, missing Portal configuration and insufficient restricted-key authority for the intended `$25/month` replacement. These are dated observations, not a current configuration claim. The billing operator must refresh mode, Price, Portal and jurisdiction/tax evidence under #263 before enabling sales.
- Canonical authority consumption remains blocked on a producer envelope with exact base-run, attempt, occurrence, and validity-deadline correlation.
- Complete outbound policy evidence remains open.
- Deployed evidence redaction, provider restart recovery, retention, export, and deletion require release-equivalent certification; local cross-surface redaction and hermetic recovery are verified.
- Checkout, authority refresh, expiry, and owner-bound device authorization have deterministic local and browser coverage but still require retained release-equivalent provider evidence.
- Only GitHub Copilot CLI has implemented event translation.
- GitHub-capable team steps remain intentionally blocked until approved operations use a bounded production capability broker.
- GitHub Actions remain intentionally disabled, so local gates are the only repository verification boundary.
- Git-triggered Vercel deployments remain intentionally disabled.
- GitHub issues track open delivery work. This audit records repository evidence and does not certify issue acceptance.

## Verification commands

```bash
pnpm hygiene
pnpm check
pnpm typecheck
pnpm test:unit
pnpm build
```

See the [verification matrix](verification-matrix.md) for evidence states and the [release readiness runbook](release-readiness.md) for approval-gated work.
