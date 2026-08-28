# Current Repository State

This is an evidence snapshot, not a completion claim. Repository behavior is
described from tracked source and fresh local commands. Planning status remains
subject to the private Beads authority, which was unavailable during this
snapshot.

> **Correction — 2026-08-27, candidate HEAD:** This branch now includes
> deployed `origin/main` through `57023f1` via signed merge `c4ee4bd`. The
> merged repository contains versioned current/previous runner keys, session
> `authVersion` revocation, run-scoped identity and authority checks, versioned
> credential KEK/AAD rewrap, one-run credential leases, and bounded fair run
> admission. Production currently returns `400 invalid_request` when the
> existing browser identity minter sends a zero-byte `POST /api/runner-token`;
> the candidate fixes that compatibility boundary with fourteen passing
> route/client cases, but the fix is not deployed. On the final candidate,
> lint, typecheck, 1,329 unit tests, the 33-page build, release configuration
> validation, tracked secret scan, 62 roadmap tests, and two byte-identical
> live roadmap applies passed. The production-browser gate passed 15 of 17
> cases; the Warden and legacy-chat subscriber cases cannot satisfy the new
> database-backed `authVersion` revalidation with their cookie-only fixture.
> Hygiene is externally blocked again because the unrelated
> `fix/process-runner` worktree gained one uncommitted file after the earlier
> green run. The historical audit below is retained for detailed baseline
> evidence.

## Historical snapshot metadata

| Field | Value |
| --- | --- |
| Snapshot captured | `2026-08-27T02:06:28-05:00` |
| Audit candidate | `main` at `a8c197639c599c67132e73b376859dc4d6d48124`, plus the staged documentation refresh |
| Merged `origin/main` SHA | `a8c197639c599c67132e73b376859dc4d6d48124` |
| Project refresh timestamp | `2026-08-26T01:35:14.947Z` |
| Working-tree state before documentation edits | Clean at `a8c1976`; unrelated worktrees were not modified |

The original UI audit landed as `d63d40a`. Subsequent Worker and console changes
through `d32609a` were included in this refresh; `a8c1976` is the merged,
verified SDK/container alignment commit.

## Implemented surfaces

| Surface | Current repository reality | Evidence |
| --- | --- | --- |
| Next control plane and console | Next.js 16 serves the agent console at `/agents`. The console creates, edits, lists, runs, streams, stops, and deletes cloud execution profiles, with run receipts, runtime inspection, analytics, and settings surfaces. | [`app/agents/page.tsx`](../../app/agents/page.tsx), [`components/console/run-console.tsx`](../../components/console/run-console.tsx), [`lib/agents/client.ts`](../../lib/agents/client.ts) |
| GitHub authentication, account, and setup | GitHub is the only sign-in provider. A verified GitHub email is mapped to a local product account; account settings expose Copilot setup, profile, usage, and data controls. Credential setup supports direct validation and GitHub device flow. Direct signed-out entry is gated before protected controls mount. | `app/(auth)/auth.ts`, [`app/account/page.tsx`](../../app/account/page.tsx), [`components/account/harness-credentials.tsx`](../../components/account/harness-credentials.tsx), [`app/api/credentials/device/route.ts`](../../app/api/credentials/device/route.ts) |
| Owner Warden directory | `/admin` exposes aggregate account/run telemetry only to exact normalized emails in `ADMIN_EMAILS`. Unauthorized page and API requests return a non-cacheable 404, and the page keeps its own authorization check as defense in depth. | [`app/admin/page.tsx`](../../app/admin/page.tsx), [`app/api/admin/route.ts`](../../app/api/admin/route.ts), [`components/admin/warden.tsx`](../../components/admin/warden.tsx), [`lib/admin/access.ts`](../../lib/admin/access.ts), [`proxy.ts`](../../proxy.ts) |
| Guest demo | `IS_DEMO=1` publishes a deterministic replay of committed, schema-validated, sanitized evidence at `/demo`; the default root routes to `/agents`. Playback does not start a runner or require authentication or database access. | [`components/demo/demo-root.tsx`](../../components/demo/demo-root.tsx), [`components/demo/replay-player.tsx`](../../components/demo/replay-player.tsx), [`lib/demo/fixtures.test.ts`](../../lib/demo/fixtures.test.ts), [guest boundary](../security/guest-access.md) |
| Shared contracts and harness | Two private workspace packages define Agent Runner v1 schemas, signed tenant claims, bounded evidence, normalized harness events, invocation construction, and run summaries. GitHub Copilot CLI is runnable; Codex CLI and Claude Code are detected but refused because their event translation is not implemented. | [`packages/agent-contracts/src/index.ts`](../../packages/agent-contracts/src/index.ts), [`packages/agent-contracts/contract-descriptor.ts`](../../packages/agent-contracts/contract-descriptor.ts), [`packages/harness/src/registry.ts`](../../packages/harness/src/registry.ts), [`packages/harness/src/invocation.ts`](../../packages/harness/src/invocation.ts) |
| Current runner reality | The tracked workspace and product code contain no local runner: the contract accepts only `backend: "cloud"`, the workspace includes `packages/*` and `worker`, and the README describes the cloud-only product. | [`packages/agent-contracts/src/index.ts`](../../packages/agent-contracts/src/index.ts), [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml), [`README.md`](../../README.md), [`worker/package.json`](../../worker/package.json) |
| Cloud runner | A Cloudflare Worker uses Durable Objects and per-agent Sandbox containers. It supports tenant-scoped agent storage, bounded global admission and fair queueing, asynchronous idempotent run start, event streaming, polling reconciliation, stop, bounded retention, and sandbox cleanup. | [`worker/wrangler.jsonc`](../../worker/wrangler.jsonc), [`worker/src/admission.ts`](../../worker/src/admission.ts), [`worker/src/routes.ts`](../../worker/src/routes.ts), [`worker/src/agents.ts`](../../worker/src/agents.ts), [`worker/src/run-state.ts`](../../worker/src/run-state.ts) |
| Tenant credentials | Subscriber-owned harness credentials are scoped by tenant and harness, encrypted under a per-credential AES-GCM data key wrapped by a versioned KEK ring, AAD-bound and resumably rewrapped, and lent through one-run leases only after service, run-scope, reservation, and current-authority checks. The Worker has no stored harness credential fallback. | [`lib/credentials/key-ring.ts`](../../lib/credentials/key-ring.ts), [`lib/credentials/leases.ts`](../../lib/credentials/leases.ts), [`lib/credentials/store.ts`](../../lib/credentials/store.ts), [`app/api/internal/credential/route.ts`](../../app/api/internal/credential/route.ts), [`worker/src/tenant-credentials.ts`](../../worker/src/tenant-credentials.ts) |
| Subscriptions and usage | Stripe Checkout creates or reuses one customer per product account. Signed, deduplicated webhook events update server-owned `subscribedUntil`; session authority is recomputed from that value. Run usage is tenant- and period-scoped, deduplicated by run ID, shown through `/api/usage`, and enforced before a credential is lent. | [`app/api/checkout/route.ts`](../../app/api/checkout/route.ts), [`app/api/stripe/webhook/route.ts`](../../app/api/stripe/webhook/route.ts), [`lib/subscription.ts`](../../lib/subscription.ts), [`lib/billing/usage.ts`](../../lib/billing/usage.ts), [`app/api/usage/route.ts`](../../app/api/usage/route.ts) |
| Security and abuse controls | Product-data and runner access fail closed on subscriber authority. Session `authVersion`, versioned runner keys, run-scoped claims, and internal authority revalidation provide revocation boundaries. Deployment reach and tenant identity are separate controls. Reviewed route policies bound bodies and request rates; production enforcement fails closed when its Redis control is unavailable, while Worker admission adds bounded global and tenant-aware fair queueing. | [`lib/auth/session-revocation.ts`](../../lib/auth/session-revocation.ts), [`lib/agents/key-ring.ts`](../../lib/agents/key-ring.ts), [`lib/auth/runner-authority.ts`](../../lib/auth/runner-authority.ts), [`lib/abuse/enforce.ts`](../../lib/abuse/enforce.ts), [`worker/src/admission.ts`](../../worker/src/admission.ts), [threat model](../security/execution-threat-model.md) |
| Planning automation | The repository can read only approved Project fields, validate a 60-item managed inventory, render a canonical aggregate block, and fail when `ROADMAP.md` is stale. Beads seed/sync and Project reconciliation code exists, but no fresh canonical reconciliation was possible in this snapshot. | [`scripts/roadmap-project-status.ts`](../../scripts/roadmap-project-status.ts), [`scripts/roadmap-status.ts`](../../scripts/roadmap-status.ts), [`scripts/beads-project-sync.ts`](../../scripts/beads-project-sync.ts), [`ROADMAP.md`](../../ROADMAP.md), [sync boundary](../beads-project-sync.md) |

The accepted [product authority boundary](../architecture/adr-001-product-authority-boundary.md)
and the living [execution threat model](../security/execution-threat-model.md)
are present on merged main. Their implementation evidence is real; their
canonical Beads completion cannot be re-asserted while Beads is inaccessible.

## Historical validation evidence

These commands were run against the audit candidate after fast-forwarding to
the latest available `origin/main`. Detailed UI evidence and limitations are in
the [dated functionality audit](ui-functionality-audit-2026-08-26.md).

| Gate | Result | Exact observed evidence |
| --- | --- | --- |
| `pnpm hygiene` | **Failed, exit 1** | Five worktrees total, four secondary. `feat/admission-queue-rebased` is `AT RISK` with one unpushed commit and is not merged; `fix/process-runner` is `AT RISK` because it is not on origin and is not merged. `docs/repository-roadmap` is reapable. |
| `pnpm check` | **Passed, exit 0** | Ultracite checked 404 files; no fixes or warnings were reported. |
| `pnpm typecheck` | **Passed, exit 0** | Root `tsc --noEmit` completed, followed by successful typechecks for `@opencoven/agent-contracts`, `@opencoven/harness`, and `@opencoven/cloud-runner`. |
| `pnpm test:unit` | **Passed, exit 0** | Five test groups passed: 288, 438, 38, 32, and 151 tests; 947 total, zero failures, cancellations, skips, or todos. |
| `pnpm build` | **Passed, exit 0** | Runtime validation passed; migrations were skipped because `POSTGRES_URL` was absent; Next.js 16.3.1 compiled, typechecked, and generated all 32 static pages without the prior metadata warning. |
| Browser suite | **Passed, exit 0** | Seventeen authentication, console, retained-run timeline, account, Warden, chat, and security Playwright cases passed against both development and local production servers, including signed-out request gating, keyboard navigation, rich-step collapse/expand behavior, and a `390 × 844` viewport. |
| Demo production build and replay | **Passed, exit 0** | `IS_DEMO=1 pnpm build` generated 32/32 static pages. A local production browser reached 10/10 sanitized replay events with no console errors. |
| Local Worker/Sandbox diagnostic | **Passed, exit 0** | Wrangler local mode returned the cloud health contract; an ephemeral signed subscriber identity reached the Docker-backed diagnostic and returned `200`, `exitCode: 0`, `ok: true`, and `coven-agents`. The SDK-matched image emitted no `version_mismatch`. |
| `pnpm roadmap:status check` | **Passed, exit 0** | `roadmap status: unchanged` |

GitHub Actions are intentionally disabled. The local gates are therefore the
only executed merge evidence. The build-quality, browser, demo, and roadmap
checks were green; the complete gate set was not green because hygiene detected
worktree-only state outside this task.

## Planning evidence

`ROADMAP.md` and a fresh approved-field Project query agreed on this aggregate:

| Project status | Count |
| --- | ---: |
| Todo | 47 |
| In Progress | 6 |
| In review | 1 |
| Done | 6 |
| **Managed total** | **60** |
| **Blocked** | **35** |

| Wave | Total | Done | In Progress | In review | Todo | Blocked |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 - Delivered | 2 | 2 | 0 | 0 | 0 | 0 |
| 1 - Now | 9 | 4 | 4 | 1 | 0 | 0 |
| 2 - Next | 15 | 0 | 1 | 0 | 14 | 6 |
| 3 - Certify | 13 | 0 | 1 | 0 | 12 | 11 |
| 4 - Platform | 7 | 0 | 0 | 0 | 7 | 5 |
| 5 - Product data | 6 | 0 | 0 | 0 | 6 | 6 |
| 6 - Operations | 8 | 0 | 0 | 0 | 8 | 7 |

The authenticated planning attempt reached the private authority, but
**Dolt/DoltHub returned `PermissionDenied`** despite configured credentials.
Beads is the planning authority, so this snapshot cannot establish that the 60
Project items are reconciled to their canonical records, cannot verify
dependency changes, and cannot claim a current idempotent sync. A field-only
Project query also found that all 60 managed items are `DraftIssue` items
rather than linked GitHub issues; issue state cannot provide an independent
closure check.

## Risk register

| Risk | Severity | Owner role | Blocking gate | Mitigation | Closure evidence |
| --- | --- | --- | --- | --- | --- |
| Beads access and sync drift | High | BunsDev | Phase 0 planning authority | **Current: open blocker. Dolt/DoltHub returned `PermissionDenied`.** Keep Project and `ROADMAP.md` read-only as projections; do not apply or describe a sync as idempotent until an authenticated Dolt pull succeeds. | Authenticated Dolt pull; private review, update, commit, and push; authorized Project reconciliation; two sync applies; a final preview with 60 unchanged and zero create, update, or orphan; and reconciled shipped GitHub issues, all without private output. |
| Issue and Project drift | Medium | Joint | Phase 0 planning authority | **Current: open.** All 60 managed Project items are drafts, so no GitHub issue state backs their status. Treat Project fields as a projection only. | Canonical linkage policy is recorded and a field-only check demonstrates that each managed status has an authoritative state source. |
| Work exists only in another worktree | High | BunsDev | Repository integrity | **Current: open.** The latest exact-candidate hygiene run reported four worktrees total, three secondary, and `fix/process-runner` as `AT RISK` with one uncommitted file. The pushed roadmap worktree is reapable and the secondary count is exactly at the soft cap. This task did not alter the unrelated worktree. | The owning work is committed and pushed, merged, or deliberately removed by its owner; then `pnpm hygiene` exits zero and the roadmap worktree is reaped after this branch is preserved. |
| Remote checks are disabled | High | Joint | Evidence baseline | **Current: accepted with partial mitigation.** GitHub Actions remain intentionally off; signed commits plus all local gates are required. The five repository-required gates are green on the candidate, but the additional release browser gate remains red as recorded above. | A signed, retained local release-gate record with every required gate green, or an explicit repository decision that re-enables trusted required checks. |
| Typechecking depends on generated Next types | Medium | Copilot | Evidence baseline | **Current: partially mitigated.** `.next` is ignored while `tsconfig.json` includes generated `.next` type paths. Typecheck and build passed in this populated worktree, but clean-checkout order independence was not proved. | A clean checkout passes the documented gate order, or the scripts explicitly generate required Next types before typecheck. |
| Production-path E2E is missing | High | Joint | Certify | **Current: open.** Fifteen of seventeen final-candidate production-browser cases pass. Warden and legacy chat fail because cookie-only subscriber fixtures no longer satisfy database-backed session-version revalidation. Existing fixtures also do not exercise real GitHub OAuth, Stripe, tenant credential lending, a full deployed cloud run lifecycle, or recovery; remote workflows are disabled. | Add a database-backed subscriber fixture that proves `authVersion` and subscription authority without a production bypass, then cover authentication, subscription, tenant credential lending, cloud run lifecycle, and recovery with deterministic service boundaries. |
| Cloud egress and network policy are incomplete | High | Joint | Wave 2 execution safety | **Current: partially mitigated.** Per-agent containers isolate execution, but cloud outbound behavior is not yet declared and enforced. | An enforced outbound policy, deployed denial tests, operator-visible failures, and recovery evidence after a policy violation. |
| Cloud fairness and concurrency controls need release evidence | High | Joint | Wave 4 platform | **Current: partially mitigated.** Global capacity admission, bounded tenant-aware fair queueing, dispatch fencing, expiration, cancellation, and cleanup are implemented with deterministic unit coverage. Operator-visible deployed behavior and recovery under real platform exhaustion are not certified. | Dated staging or production-like capacity, fairness, cancellation, expiry, and recovery evidence with operator-visible queue state and no leaked capacity. |
| Output redaction is incomplete end to end | High | Joint | Wave 2 execution safety | **Current: partially mitigated.** Shared pattern-based redaction exists and selected cloud and guest boundaries use it, but complete boundary coverage is not proved. | Cross-boundary leak tests cover direct and encoded values and prove sanitized display, persistence, logs, and errors. |
| Crash-safe journaling and shared persistent records are incomplete | High | Joint | Wave 2 durability | **Current: partially mitigated.** Bounded records and lifecycle state exist, but restart and partial-write recovery are not proved end to end. | Restart and partial-write tests prove idempotent journal replay, duplicate suppression, tenant isolation, and shared-record consistency. |
| Retention and deletion policy are incomplete | High | Joint | Wave 5 product data | **Current: partially mitigated.** Existing stores are bounded by implementation behavior, but explicit tenant-scoped retention, export, deletion, and archive behavior is not complete. | Documented policy and tests prove retention limits, export scope, deletion boundaries, privacy-safe archive movement, and evidence for destructive paths. |

## Evidence-backed known gaps

- The tracked workspace and product code expose only the cloud execution
  backend. Local-roadmap records still require canonical retirement or
  re-scoping before promotion.
- Only GitHub Copilot CLI has implemented event translation. Codex CLI and
  Claude Code remain non-runnable in
  [`packages/harness/src/registry.ts`](../../packages/harness/src/registry.ts).
- The threat model explicitly leaves cloud outbound-network policy,
  platform-wide fairness, complete evidence redaction, crash-safe recovery, and
  formal retention and deletion open.
- Current console/authentication browser coverage is local and does not make
  the suite CI-ready for live service-bound paths; Actions are disabled.
- No Chrome DevTools performance trace was available for the audit, so Core Web
  Vitals remain unverified.
