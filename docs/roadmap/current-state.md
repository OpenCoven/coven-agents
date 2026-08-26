# Current Repository State

This is an evidence snapshot, not a completion claim. Repository behavior is
described from tracked source and fresh local commands. Planning status remains
subject to the private Beads authority, which was unavailable during this
snapshot.

## Snapshot metadata

| Field | Value |
| --- | --- |
| Snapshot captured | `2026-08-25T21:31:45-05:00` |
| Roadmap branch HEAD | `docs/repository-roadmap` at `d72a3f59c62f469b353eaccbbe6012d617c65518` |
| Merged `origin/main` SHA | `a85e16d6a61cf23845e28f5d373fe48ce4e8cb37` |
| Project refresh timestamp | `2026-08-26T01:35:14.947Z` |
| Working-tree state before documentation edits | Clean; the roadmap merge commit was signed and pushed |

The merged main SHA includes the previously reported `da764545206ca6f944fca2e99ad7f9efa65853e6`
base and the subsequent main change that was available before this snapshot.

## Implemented surfaces

| Surface | Current repository reality | Evidence |
| --- | --- | --- |
| Next control plane and console | Next.js 16 serves the agent console at `/agents`. The console creates, edits, lists, runs, streams, stops, and deletes cloud execution profiles, with run receipts, runtime inspection, analytics, and settings surfaces. | [`app/agents/page.tsx`](../../app/agents/page.tsx), [`components/console/run-console.tsx`](../../components/console/run-console.tsx), [`lib/agents/client.ts`](../../lib/agents/client.ts) |
| GitHub authentication, account, and setup | GitHub is the only sign-in provider. A verified GitHub email is mapped to a local product account; account settings expose Copilot setup, profile, usage, and data controls. Credential setup supports direct validation and GitHub device flow. | `app/(auth)/auth.ts`, [`app/account/page.tsx`](../../app/account/page.tsx), [`components/account/harness-credentials.tsx`](../../components/account/harness-credentials.tsx), [`app/api/credentials/device/route.ts`](../../app/api/credentials/device/route.ts) |
| Guest demo | The root guest experience is a deterministic replay of committed, schema-validated, sanitized evidence. It does not start a runner or require authentication or database access. | [`components/demo/demo-root.tsx`](../../components/demo/demo-root.tsx), [`components/demo/replay-player.tsx`](../../components/demo/replay-player.tsx), [`lib/demo/fixtures.test.ts`](../../lib/demo/fixtures.test.ts), [guest boundary](../security/guest-access.md) |
| Shared contracts and harness | Two private workspace packages define Agent Runner v1 schemas, signed tenant claims, bounded evidence, normalized harness events, invocation construction, and run summaries. GitHub Copilot CLI is runnable; Codex CLI and Claude Code are detected but refused because their event translation is not implemented. | [`packages/agent-contracts/src/index.ts`](../../packages/agent-contracts/src/index.ts), [`packages/agent-contracts/contract-descriptor.ts`](../../packages/agent-contracts/contract-descriptor.ts), [`packages/harness/src/registry.ts`](../../packages/harness/src/registry.ts), [`packages/harness/src/invocation.ts`](../../packages/harness/src/invocation.ts) |
| Current runner reality | The tracked workspace and product code no longer contain a local runner: the contract accepts only `backend: "cloud"`, the workspace includes `packages/*` and `worker`, and `git ls-files local-runner` returned zero tracked files. The README still calls the product a local-cloud hybrid and says that both backends run the harness; that is documentation drift, not evidence of an active local-runner package or a cloud-only README. | [`packages/agent-contracts/src/index.ts`](../../packages/agent-contracts/src/index.ts), [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml), [`README.md`](../../README.md), [`worker/package.json`](../../worker/package.json) |
| Cloud runner | A Cloudflare Worker uses Durable Objects and per-agent Sandbox containers. It supports tenant-scoped agent storage, asynchronous idempotent run start, event streaming, polling reconciliation, stop, bounded retention, and sandbox cleanup. | [`worker/wrangler.jsonc`](../../worker/wrangler.jsonc), [`worker/src/routes.ts`](../../worker/src/routes.ts), [`worker/src/agents.ts`](../../worker/src/agents.ts), [`worker/src/run-state.ts`](../../worker/src/run-state.ts) |
| Tenant credentials | Subscriber-owned harness credentials are scoped by tenant and harness, encrypted under a per-credential AES-GCM data key wrapped by a required KEK, and lent to the worker for one run after service and signed-identity checks. The worker has no stored harness credential fallback. | [`lib/credentials/envelope.ts`](../../lib/credentials/envelope.ts), [`lib/credentials/store.ts`](../../lib/credentials/store.ts), [`app/api/internal/credential/route.ts`](../../app/api/internal/credential/route.ts), [`worker/src/tenant-credentials.ts`](../../worker/src/tenant-credentials.ts) |
| Subscriptions and usage | Stripe Checkout creates or reuses one customer per product account. Signed, deduplicated webhook events update server-owned `subscribedUntil`; session authority is recomputed from that value. Run usage is tenant- and period-scoped, deduplicated by run ID, shown through `/api/usage`, and enforced before a credential is lent. | [`app/api/checkout/route.ts`](../../app/api/checkout/route.ts), [`app/api/stripe/webhook/route.ts`](../../app/api/stripe/webhook/route.ts), [`lib/subscription.ts`](../../lib/subscription.ts), [`lib/billing/usage.ts`](../../lib/billing/usage.ts), [`app/api/usage/route.ts`](../../app/api/usage/route.ts) |
| Security and abuse controls | Product-data and runner access fail closed on subscriber authority. Deployment reach and tenant identity are separate controls. Reviewed route policies bound bodies and request rates; production enforcement fails closed when its Redis control is unavailable. Staged Git content is secret-scanned before formatting, and the threat model plus incident runbook cover response. | [`lib/auth/subscriber-authorization.server.ts`](../../lib/auth/subscriber-authorization.server.ts), [`lib/abuse/policy.ts`](../../lib/abuse/policy.ts), [`lib/abuse/enforce.ts`](../../lib/abuse/enforce.ts), [`scripts/secret-scan.ts`](../../scripts/secret-scan.ts), [threat model](../security/execution-threat-model.md), [incident response](../security/incident-response.md) |
| Planning automation | The repository can read only approved Project fields, validate a 60-item managed inventory, render a canonical aggregate block, and fail when `ROADMAP.md` is stale. Beads seed/sync and Project reconciliation code exists, but no fresh canonical reconciliation was possible in this snapshot. | [`scripts/roadmap-project-status.ts`](../../scripts/roadmap-project-status.ts), [`scripts/roadmap-status.ts`](../../scripts/roadmap-status.ts), [`scripts/beads-project-sync.ts`](../../scripts/beads-project-sync.ts), [`ROADMAP.md`](../../ROADMAP.md), [sync boundary](../beads-project-sync.md) |

The accepted [product authority boundary](../architecture/adr-001-product-authority-boundary.md)
and the living [execution threat model](../security/execution-threat-model.md)
are present on merged main. Their implementation evidence is real; their
canonical Beads completion cannot be re-asserted while Beads is inaccessible.

## Fresh validation evidence

These commands were run after merging and pushing the latest available
`origin/main`, and before editing this document.

| Gate | Result | Exact observed evidence |
| --- | --- | --- |
| `pnpm hygiene` | **Failed, exit 1** | Three worktrees total, two secondary. `feat/auth-request-hardening` was `AT RISK` with two uncommitted files not merged into main. The roadmap worktree was active and pushed. |
| `pnpm check` | **Passed, exit 0** | Ultracite checked 374 files in 15 seconds; no fixes were applied. |
| `pnpm typecheck` | **Passed, exit 0** | Root `tsc --noEmit` completed, followed by successful typechecks for `@opencoven/agent-contracts`, `@opencoven/harness`, and `@opencoven/cloud-runner`. |
| `pnpm test:unit` | **Passed, exit 0** | Five test groups passed: 269, 354, 38, 32, and 112 tests; 805 total, zero failures, cancellations, skips, or todos. |
| `pnpm build` | **Passed, exit 0** | Runtime validation passed; migrations were skipped because `POSTGRES_URL` was absent; Next.js 16.3.1 compiled, typechecked, and generated all 29 static pages. One non-blocking `metadataBase` warning remained. |
| `pnpm roadmap:status check` | **Passed, exit 0** | `roadmap status: unchanged` |

GitHub Actions are intentionally disabled. The local gates are therefore the
only executed merge evidence. Four build-quality gates and the roadmap check
were green; the complete gate set was not green because hygiene detected
worktree-only changes outside this task.

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
| Work exists only in another worktree | High | BunsDev | Repository integrity | **Current: open.** Hygiene identified two uncommitted files in `feat/auth-request-hardening`. This roadmap task must not alter or discard them. | `pnpm hygiene` exits 0 with no `AT RISK` worktrees after the owning work is safely committed and pushed or deliberately removed by its owner. |
| Remote checks are disabled | High | Joint | Evidence baseline | **Current: accepted with partial mitigation.** GitHub Actions remain intentionally off; signed commits plus all local gates are required. The current snapshot still has the hygiene failure above. | A signed, retained local gate record with every required gate green, or an explicit repository decision that re-enables trusted required checks. |
| Typechecking depends on generated Next types | Medium | Copilot | Evidence baseline | **Current: partially mitigated.** `.next` is ignored while `tsconfig.json` includes generated `.next` type paths. Typecheck and build passed in this populated worktree, but clean-checkout order independence was not proved. | A clean checkout passes the documented gate order, or the scripts explicitly generate required Next types before typecheck. |
| Production-path E2E is missing | High | Joint | Certify | **Current: open.** Playwright is opt-in, uses a local development server, and is not part of the five executed gates; remote workflows are disabled. | A production-like, credential-safe suite covers authentication, subscription, tenant credential lending, cloud run lifecycle, and recovery with deterministic service boundaries. |
| Cloud egress and shared-capacity fairness are incomplete | High | Joint | Wave 2 execution safety | **Current: partially mitigated.** Per-agent containers, one active run per agent, idempotent starts, and a monthly cap exist. A declared outbound policy and platform-wide queue fairness do not. | Enforced egress policy, capacity admission and fairness tests, operator visibility, and recovery evidence under exhaustion. |
| Evidence redaction and run durability are incomplete end to end | High | Joint | Wave 2 durability and explainability | **Current: partially mitigated.** Shared pattern-based redaction, bounded records, and lifecycle state exist. Full boundary coverage, retention, export, deletion, and crash recovery remain incomplete. | Cross-boundary leak tests plus documented, tested retention, deletion, replay, and restart behavior. |

## Evidence-backed known gaps

- The tracked workspace and product code expose only the cloud execution
  backend, but the README still describes a local-cloud hybrid and says both
  backends run the harness. That documentation drift, plus compatibility
  comments and older security prose, must not be mistaken for an active local
  runner; local-roadmap records require canonical retirement or re-scoping
  before promotion.
- Only GitHub Copilot CLI has implemented event translation. Codex CLI and
  Claude Code remain non-runnable in
  [`packages/harness/src/registry.ts`](../../packages/harness/src/registry.ts).
- The threat model explicitly leaves cloud outbound-network policy,
  platform-wide fairness, complete evidence redaction, and formal retention and
  recovery open.
- The E2E workflow documents that the suite is not CI-ready for live
  service-bound paths, and Actions are disabled.
- The production build emitted a `metadataBase` warning. It did not fail the
  build, but social metadata still falls back to a localhost base during this
  configuration.
