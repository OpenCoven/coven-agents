# Verification Matrix

This matrix records public, repository-backed capability evidence. Its current
assessment is based on the
[`2026-08-25` repository snapshot](current-state.md). Unknown cells use an em
dash (`—`); they are never filled with a speculative value.

## State vocabulary

These are the only valid states:

| State | Meaning |
| --- | --- |
| `Not implemented` | No complete path exists for the named capability. Partial helpers do not qualify. |
| `Implemented` | A path exists, but the capability has not completed its required verification procedure with retained evidence. |
| `Verified` | A deterministic local or staging procedure passed for the cited commit and environment, with dated evidence. |
| `Certified` | Dated end-to-end evidence passed in a release-equivalent environment, the artifact is retained, and the owner accepted it. |
| `Blocked` | The required procedure cannot currently complete because the blocking gap names an unmet external or prerequisite condition. |

Never mark a row `Certified` without dated end-to-end evidence. A code,
configuration, dependency, environment, or contract change that can affect a
row invalidates its prior verification until the procedure is rerun.

## Current matrix

| Capability | Path | State | Environment | Commit | Procedure | Artifact/link | Verified at | Owner role | Blocking gap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Demo load/playback | [`components/demo/demo-root.tsx`](../../components/demo/demo-root.tsx), [`components/demo/replay-player.tsx`](../../components/demo/replay-player.tsx) | `Verified` | Local repository unit suite | `d72a3f5` | `pnpm test:unit` | [`lib/demo/fixtures.test.ts`](../../lib/demo/fixtures.test.ts), [fresh validation](current-state.md#fresh-validation-evidence) | `2026-08-25` | Product | No dated production-browser playback artifact; not `Certified`. |
| Subscriber sign-in/eligibility | [`app/(auth)/auth.ts`](../../app/%28auth%29/auth.ts), [`lib/auth/subscriber-authorization.server.ts`](../../lib/auth/subscriber-authorization.server.ts) | `Verified` | Local repository unit suite | `d72a3f5` | `pnpm test:unit` | [`lib/auth/subscriber-authorization.test.ts`](../../lib/auth/subscriber-authorization.test.ts), [`lib/subscription.test.ts`](../../lib/subscription.test.ts) | `2026-08-25` | Identity and billing | No dated GitHub OAuth plus Stripe eligibility end-to-end artifact in a release-equivalent environment. |
| Tenant credential store/redaction | [`lib/credentials/store.ts`](../../lib/credentials/store.ts), [`packages/agent-contracts/src/evidence.ts`](../../packages/agent-contracts/src/evidence.ts) | `Verified` | Local repository unit suite | `d72a3f5` | `pnpm test:unit` | [`lib/credentials/envelope.test.ts`](../../lib/credentials/envelope.test.ts), [`worker/src/tenant-credentials.test.ts`](../../worker/src/tenant-credentials.test.ts), [threat T4–T9](../security/execution-threat-model.md#threat-register) | `2026-08-25` | Security | Cross-service, release-equivalent isolation and complete direct/encoded redaction coverage are not retained; not `Certified`. |
| Cloud create/run/delete | [`worker/src/routes.ts`](../../worker/src/routes.ts), [`worker/src/agents.ts`](../../worker/src/agents.ts) | `Verified` | Local cloud-runner unit suite | `d72a3f5` | `pnpm --filter @opencoven/cloud-runner test` | [`worker/src/async-runs.test.ts`](../../worker/src/async-runs.test.ts), [`worker/src/routes.test.ts`](../../worker/src/routes.test.ts) | `2026-08-25` | Cloud runner | No dated live Cloudflare Sandbox create/run/delete artifact with a tenant credential; not `Certified`. |
| Local create/run/cancel/delete | [`packages/agent-contracts/src/index.ts`](../../packages/agent-contracts/src/index.ts) | `Not implemented` | — | `91f21c8` | `git ls-files local-runner` and the contract rejection test establish absence; there is no lifecycle procedure to run. | [current runner reality](current-state.md#implemented-surfaces) | — | Local execution | The local-runner package was removed and the contract accepts only `cloud`; a newly authorized design and implementation are required. |
| Shared contract conformance | [`packages/agent-contracts/src/index.ts`](../../packages/agent-contracts/src/index.ts), [`packages/agent-contracts/contract-descriptor.ts`](../../packages/agent-contracts/contract-descriptor.ts) | `Implemented` | Current cloud and contract unit suites only | `d72a3f5` | Run one versioned conformance suite against every supported runner; no such cross-runner procedure exists. | [`packages/agent-contracts/src/index.test.ts`](../../packages/agent-contracts/src/index.test.ts), [known gap](current-state.md#evidence-backed-known-gaps) | — | Contracts | Formal conformance, compatibility, and version-transition evidence across runner implementations is missing. |
| Persisted run recovery | [`worker/src/run-state.ts`](../../worker/src/run-state.ts), [`worker/src/agents.ts`](../../worker/src/agents.ts) | `Implemented` | Unit-level cloud run-state logic | `d72a3f5` | Restart an in-flight run against persisted Durable Object state and prove idempotent recovery, duplicate suppression, and cleanup. | [`worker/src/run-state.test.ts`](../../worker/src/run-state.test.ts), [risk register](current-state.md#risk-register) | — | Reliability | Unit recovery logic exists, but restart and partial-write recovery against real persistence are not proved end to end. |
| Browser failure/accessibility | [`tests/e2e`](../../tests/e2e), [`playwright.config.ts`](../../playwright.config.ts) | `Not implemented` | Local development server only | `d72a3f5` | Run failure injection and accessibility assertions against the current agent console in a production build. | [`playwright.config.ts`](../../playwright.config.ts), [production-path E2E gap](current-state.md#risk-register) | — | Product quality | Existing browser tests do not provide current agent-console failure, keyboard, screen-reader, or production-build evidence. |
| Deployment preflight | [`scripts/validate-runtime-config.ts`](../../scripts/validate-runtime-config.ts) | `Not implemented` | Local build validation only | `8bdcf08` | Validate app and worker secrets, origins, bindings, database migration, deploy authentication, smoke dependencies, and rollback readiness before mutation. | [`scripts/validate-runtime-config.test.ts`](../../scripts/validate-runtime-config.test.ts), [release prerequisites](release-readiness.md#environment-prerequisites) | — | Release engineering | The current preflight checks abuse-budget configuration only, and the build can skip migrations when `POSTGRES_URL` is absent. |
| Production smoke/rollback | [`README.md`](../../README.md), [`docs/security/incident-response.md`](../security/incident-response.md) | `Blocked` | Production-equivalent app and Worker | — | Execute the smoke, webhook, isolation, observability, rollback, and recovery sections in [`release-readiness.md`](release-readiness.md). | [deployment diagnostic](../../README.md#run-the-runner), [current blockers](release-readiness.md#current-release-disposition) | — | Release operator | Beads access is denied, `AT RISK` worktrees exist, required verification remains red, and no dated production rollback rehearsal is retained. |
