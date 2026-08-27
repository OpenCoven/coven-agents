# Release Readiness

This is the go/no-go checklist for the current cloud-only product. It covers the
Next.js app, Cloudflare Worker, database, planning reconciliation, smoke
evidence, rollback, and recovery. It does not treat disabled GitHub Actions as
executed evidence.

## Current release disposition

**No-go as of 2026-08-27.**

Current blockers are factual and fail closed:

- the latest recorded authenticated private Beads/DoltHub pull returned
  `PermissionDenied`, so authoritative P0, dependency, and acceptance state
  cannot be reconciled; see [`current-state.md`](current-state.md);
- `pnpm hygiene` at `2026-08-27T02:06:28-05:00` reported four secondary worktrees
  against the soft cap of three and two unrelated `AT RISK` branches:
  `feat/admission-queue-rebased` had one unpushed commit and
  `fix/process-runner` was absent from origin and not merged according to
  hygiene. Worktree state is live, so release operators must rerun the command
  rather than treat those names as a durable inventory;
- the latest field-only Project query recorded in
  [`current-state.md`](current-state.md) found all 60 managed items were drafts,
  so GitHub issue state did not independently confirm delivery reconciliation;
- required rows in [`verification-matrix.md`](verification-matrix.md) remain
  below `Verified`, and production smoke/rollback is `Blocked`;
- the Stripe webhook claims an event before owner lookup and subscription
  mutation, so a post-claim failure or ignored owner is permanently deduplicated
  instead of recoverable by provider redelivery;
- no candidate-specific `RELEASE_AUDIENCE` and matching approved closed-beta or
  public-release configuration is retained; and
- no retained, dated production-like end-to-end artifact proves subscriber,
  credential, cloud lifecycle, Stripe delivery, rollback, and recovery
  together.

GitHub Actions are intentionally disabled until separately approved. That is
an accepted operating constraint, not an outage and not permission to skip the
local gates.

## Automatic no-go rules

Stop the release without exception when any of these is true:

- an unresolved P0 exists or P0 state cannot be read authoritatively;
- a required verification row is red or `Blocked`;
- `ROADMAP.md` is stale;
- any worktree is `AT RISK`;
- the secondary-worktree count exceeds the repository soft cap;
- Beads and Project are drifted or cannot be shown to agree;
- Stripe event claim and subscription-state mutation are not atomic and
  retry-safe; or
- `RELEASE_AUDIENCE` is absent or invalid, or its approved audience does not
  match the beta configuration.

A required row is **red** when its state is `Not implemented`, `Implemented`,
or `Blocked`, or when its dated evidence no longer applies to the candidate
commit or environment.

## Environment prerequisites

Check presence and agreement without printing values. App environment
variables, Worker secret/value bindings, and Cloudflare platform bindings are
different configuration surfaces and must not be treated as interchangeable.

| Area | Required before release | Current repository reality |
| --- | --- | --- |
| Toolchain | Node.js 22 or newer, pnpm 10, frozen dependency install, Git, Docker for Sandbox image work, and authenticated deployment CLIs. | Declared in [`README.md`](../../README.md) and package metadata. |
| App identity and data | `AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, `POSTGRES_URL`, and canonical `APP_ORIGIN`. | GitHub is the only sign-in provider; production data requires PostgreSQL. |
| Owner directory | `ADMIN_EMAILS` containing the exact normalized owner email allowlist when `/admin` is enabled. | Unauthorized page and API requests fail closed as non-cacheable `404` responses. Because the proxy participates in the production build, set this consistently for build and runtime. |
| Production app abuse and run admission | Require all three app environment variables: `REDIS_URL`, a nonempty `ABUSE_KEY_SECRET`, and a positive-integer `GLOBAL_DAILY_RUN_CAP`. `ABUSE_CONTROL=off` is an emergency bypass for app request-policy enforcement only; normal releases require it unset or not `off`. It does not bypass run reservations, global or tenant cap enforcement, or Worker rate limiters. | Protected app routes fail closed with `503` when Redis is unconfigured in production. Credential lending fails closed with `503` and `capacity_unavailable` when the global cap or abuse key is unavailable. See [`.env.example`](../../.env.example), [`lib/abuse/enforce.ts`](../../lib/abuse/enforce.ts), and [`app/api/internal/credential/route.ts`](../../app/api/internal/credential/route.ts). |
| App-to-runner connection | `NEXT_PUBLIC_CLOUD_RUNNER_URL` or server-side `CLOUD_RUNNER_URL`, plus matching `AGENT_CONTROL_TOKEN`. | The browser receives the connection from the app; the public URL requires a fresh app build when changed. |
| Runner identity | App `RUNNER_SIGNING_KEY`; app and Worker `RUNNER_VERIFY_KEY`; matching key pair. | Claims fail closed when either side is absent or mismatched. |
| Credential lending | App and Worker `RUNNER_SERVICE_TOKEN`; app `CREDENTIAL_KEK`; Worker `APP_ORIGIN`. | The Worker has no operator or fallback harness credential. |
| Billing | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, and canonical `APP_ORIGIN`. | Checkout and webhook return `503` when unconfigured. |
| Release audience | Set `RELEASE_AUDIENCE` exactly to `closed-beta` or `public`. Closed beta additionally requires `BETA_MODE=on` and a reviewed, nonempty `BETA_ALLOWLIST` containing only valid email addresses; public release requires separate approval and `BETA_MODE=off`. | [`scripts/validate-runtime-config.ts`](../../scripts/validate-runtime-config.ts) enforces this automatically for Vercel production and other `NODE_ENV=production` validation. Automatic runtime validation exempts Vercel preview/development builds, while `pnpm validate:release` always enforces. Unset/default-off cannot pass either production path. |
| Other shipped app paths | `AI_GATEWAY_API_KEY` and `BLOB_READ_WRITE_TOKEN` when chat/model and upload paths remain enabled. | These are app feature dependencies, not runner credentials. |
| Worker service bindings | Runtime bindings for `AGENT_CONTROL_TOKEN`, `RUNNER_VERIFY_KEY`, `RUNNER_SERVICE_TOKEN`, and `APP_ORIGIN`; plain Worker variable `ALLOWED_ORIGIN`; Durable Object/container bindings and migration; container image; and Wrangler authentication. | [`worker/.dev.vars.example`](../../worker/.dev.vars.example), [`worker/src/worker-secrets.d.ts`](../../worker/src/worker-secrets.d.ts), and [`worker/wrangler.jsonc`](../../worker/wrangler.jsonc) define the current topology. |
| Worker abuse controls | Secret binding `EDGE_ABUSE_KEY_SECRET` plus Cloudflare Rate Limiting bindings `EDGE_REQUEST_LIMITER`, `TENANT_MUTATION_LIMITER`, and `TENANT_RUN_LIMITER`. | The rate limiters are platform bindings declared under `ratelimits` in [`worker/wrangler.jsonc`](../../worker/wrangler.jsonc), not app environment variables or `.dev.vars` entries. |
| Demo recorder | Recorder variables from [`.env.example`](../../.env.example) only when producing a new owner-approved replay. | Guest playback itself is committed, stateless evidence and needs no recorder secret. |
| Local execution | — | The local runner was removed in `91f21c8`; the shared contract accepts only `cloud`. Local smoke is not a current release gate. |

Do not add a local CLI or stale compatibility path merely to make a checklist
look complete. If local execution is separately reintroduced, add its
prerequisites and verification before it becomes release-supported.

## Database migration

The build command runs
[`scripts/validate-runtime-config.ts`](../../scripts/validate-runtime-config.ts),
and the start command first runs its explicit `pnpm validate:release` mode. For
Vercel production, `NODE_ENV=production` outside an explicit Vercel
preview/development build, or explicit release validation, it rejects an
absent, invalid, case-mismatched, or beta-inconsistent `RELEASE_AUDIENCE`.
Ordinary local, test, and preview validation remains usable without declaring a
release. The production build then runs
[`lib/db/migrate.ts`](../../lib/db/migrate.ts) before the Next build. Migration
silently skips when `POSTGRES_URL` is absent, which is acceptable for a
database-free local build but is a production no-go.

Before release:

1. Review the candidate migration files and run `pnpm db:check`.
2. Create and identify a tested database restore point before applying schema
   changes.
3. Run the migration against staging with production-shaped data and verify
   both the previous compatible app and candidate app behavior.
4. Confirm production `POSTGRES_URL` is present, migration logs report success,
   and the expected schema is queryable before traffic promotion.
5. Record candidate commit, migration journal state, backup identifier,
   operator, start/end time, and sanitized result.
6. Prefer a forward fix or a compatible application rollback. Restore the
   database only through an explicit operator decision; there is no automatic
   destructive down-migration.

## Planning and delivery reconciliation

An authorized maintainer must complete the authority chain after the candidate
merge and before release:

1. Follow the local/manual
   [Beads Project sync operator guide](../beads-project-sync.md): pull, review,
   update, commit, and push the private Beads database.
2. Run `pnpm beads:sync preview`, `pnpm beads:sync apply`, a second apply, and a
   final preview.
3. Require zero creates, updates, and orphans, with all managed items unchanged
   on the final preview.
4. Reconcile the merged pull request and delivery issue to the accepted Beads
   state.
5. Run `pnpm roadmap:status apply` and `pnpm roadmap:status check`.
6. Commit and push any generated roadmap refresh.

These commands are for authorized maintainers with private Beads and Project
access. Sync validates source, schema, inventory, and privacy rules before
beginning writes and is idempotent and retryable, but batched GraphQL apply is
**not atomic**. A later mutation failure may leave earlier Project mutations
persisted. Stop the release, repair the cause, and rerun preview and apply until
the final no-op gate passes. Sync does not delete or archive Project items and
leaves orphans untouched.

## Required local gates

Run all six against the exact release candidate:

```bash
pnpm hygiene
pnpm check
pnpm typecheck
pnpm test:unit
ADMIN_EMAILS=e2e-admin@example.invalid pnpm build
: "${AUTH_SECRET:?set a local-only browser-test secret}" &&
  E2E_PRODUCTION=1 PORT=3105 pnpm test
```

Retain command, commit, environment, timestamp, exit status, and sanitized
output. The placeholder `ADMIN_EMAILS` value above is a local audit fixture,
not release configuration. `AUTH_SECRET` must be supplied from local
environment storage and must not be committed. The last full snapshot passed
check, typecheck, 947 unit tests, sixteen browser tests against development and
local production servers, both default and demo production builds, and the
local Docker-backed Sandbox diagnostic, but hygiene failed; it is not release
evidence for this post-admission-queue candidate. The first production-browser
attempt on the roadmap branch omitted `AUTH_SECRET` and failed three
subscriber-shaped tests at their explicit configuration guard; the corrected
command above passed all sixteen before the latest `main` merge. Rerun all six
gates against the final candidate. A tracked secret scan is recommended in
addition to, not instead of, the six gates.

Because an ordinary local build intentionally does not infer a release
audience, also retain a successful `pnpm validate:release` with the intended
production configuration. It must contain the approved
`RELEASE_AUDIENCE`/beta combination; a local `validate:runtime` pass that
skipped audience validation is not release evidence.

## Required smoke paths

| Path | Required smoke | Evidence required | Current state |
| --- | --- | --- | --- |
| Demo | Load the signed-out root, verify no database/runner mutation, exercise play, pause, seek, speed, and completion, and inspect sanitized replay output. | Dated browser trace or recording tied to the candidate and deployment. | A local production replay reached 10/10 sanitized events without console errors on 2026-08-27; no release-equivalent deployment artifact is retained. |
| Subscriber | Exercise a real GitHub OAuth callback and account creation/adoption, guest refusal, active eligibility, expired/revoked refusal, connection retrieval, and usage display. | Dated trace plus sanitized account-state evidence for allowed and denied cases. | Eligibility logic and mocked OAuth start are covered; actual OAuth/account creation is not verified. |
| Cloud | Run the authenticated deployment diagnostic, create an agent, start and observe a credentialed run, stream/poll to terminal state, cancel a bounded run, delete the agent, and verify tenant/sandbox cleanup. | Dated Worker/app logs, response summary, run identifiers, and cleanup result without credentials or private output. | The local Docker-backed diagnostic passes with the SDK-matched image. No deployed release-equivalent create/run/stream/cancel/delete lifecycle artifact exists. |
| Local, if supported | Create, run, cancel, and delete through the supported local boundary, including host isolation and cleanup checks. | Dated artifact from the declared supported local environment. | Not applicable: no local runner is tracked and `backend` is cloud-only. |

Smoke failure is a no-go. Do not retry until a failure disappears without
recording the first failure and its disposition.

## Stripe webhook delivery

**Current implementation blocker:** [`app/api/stripe/webhook/route.ts`](../../app/api/stripe/webhook/route.ts)
calls `claimStripeEvent` before customer/owner lookup and before
`applySubscriptionUpdate`. If lookup or mutation fails after the claim, or an
owner is ignored, the event ID remains claimed. A provider redelivery then
returns as deduplicated without applying the missing state change. Provider
redelivery is therefore not a current recovery mechanism.

Before go:

1. Change the implementation so event claim and subscription-state update are
   atomic and retry-safe, including post-claim lookup failure, ignored-owner,
   mutation failure, and concurrent duplicate cases.
2. Prove a failed processing attempt remains retryable and a completed event
   remains idempotent.
3. Confirm the deployed endpoint and `STRIPE_WEBHOOK_SECRET` match the intended
   Stripe environment.
4. Deliver a signed paid-invoice event and verify eligibility advances to the
   event's period end.
5. Only after the retry-safety fix is deployed and verified, redeliver the same
   event and verify idempotent success without a second state change.
6. Exercise failed-renewal and expiry behavior without granting a first failed
   payment.
7. Retain Stripe delivery time, event category, HTTP result, and sanitized
   account-state change without copying the payload or identifiers into public
   evidence.

[`lib/billing/webhook.test.ts`](../../lib/billing/webhook.test.ts) covers
subscription-state decisions, not atomic claim/update recovery. No safe
recovery implementation or current production delivery artifact is retained.

## Credential and identity isolation

Release evidence must prove:

- the deployment token grants reach but never tenant identity;
- the signing and verification keys agree, and old or mismatched claims fail;
- the service token cannot select a tenant without a valid bound claim;
- two controlled tenants cannot list, run, stream, stop, delete, or borrow each
  other's resources or credentials;
- `CREDENTIAL_KEK` is present, tenant credentials decrypt only for their tenant
  and harness, and the Worker stores no fallback credential;
- direct and encoded credential shapes are redacted from UI, persisted
  evidence, logs, diagnostics, and errors; and
- browser connection material is not placed in persistent local storage.

Use synthetic credentials and sanitized identifiers. Any cross-tenant access,
unredacted credential, or shared-authority fallback is an automatic no-go and
an incident-response trigger.

## Observability and diagnostics

Before traffic promotion:

1. Confirm Worker observability is enabled for the deployed version.
2. Run the authenticated `/api/diagnostics/sandbox` probe and retain its
   sanitized result.
3. Confirm app telemetry initializes and both app and Worker surface actionable
   failures without request bodies, credentials, private paths, or private
   planning text.
4. Correlate one subscriber request through connection, signed identity,
   credential lending, run lifecycle, and terminal result.
5. Confirm operators can distinguish auth, subscription, capacity, harness,
   sandbox, database, and internal-service failures.

Structured operational telemetry and standardized health/readiness signals are
not complete. A release that depends on those missing signals remains no-go
until the affected verification row is raised.

## Rollback

| Trigger | Immediate action | Decision role |
| --- | --- | --- |
| Cross-tenant access, credential exposure, forged identity, or subscriber misgrant | Stop new affected work, rotate or revoke first, then follow [incident response](../security/incident-response.md). | Maintainer acting as security incident lead |
| Migration failure, data corruption, or incompatible schema | Stop promotion and writes where necessary; choose a compatible app rollback, forward fix, or explicit restore from the tested backup. | Release operator with database owner |
| Sustained unexplained app/Worker failures or failed required smoke | Halt rollout and promote the last known-good app and Worker versions independently. | Release operator |
| Missing diagnostics or inability to establish blast radius | Halt rollout; lack of visibility is itself a rollback trigger. | Release operator |
| Planning drift, stale roadmap, red verification, or `AT RISK` worktree discovered after go | Freeze further promotion, demote readiness, reconcile, and rerun the complete gate. | Maintainer |

Record the trigger, operator, candidate, prior version, time, action, result,
and follow-up task. Rollback automation must not delete state, rewrite history,
or guess at database compatibility.

## Data recovery

- **PostgreSQL:** prove backup restore before release-affecting migrations;
  retain the restore point until the observation window closes.
- **Stripe:** no safe current recovery path exists for an event that fails or
  is ignored after its ID is claimed. Release is blocked until claim and state
  update are made atomic and retry-safe. Only after that code change is
  deployed and verified may authorized provider redelivery be treated as
  recovery; do not claim redelivery recovers the current implementation.
- **Cloud run state:** current code records bounded lifecycle state and marks
  interrupted runs, but crash, restart, and partial-write recovery are not
  verified against real persistence. Do not claim recovery certification.
- **Tenant credentials:** database plus KEK are required. Rotating a compromised
  KEK has no rewrap path; tenants must reconnect.
- **Deleted or retained evidence:** no automated purge or restore is authorized.
  Use explicit retention/deletion procedures with tenant and privacy review
  before destructive work.

## Go/no-go record

| Decision gate | Go evidence | Automatic no-go | Current status |
| --- | --- | --- | --- |
| P0 and dependencies | Authorized Beads query shows no unresolved release-blocking P0 or dependency. | Any unresolved P0, or authority unavailable. | **No-go:** the latest recorded pull returned `PermissionDenied`; authoritative current status is unavailable. |
| Release audience | An approved candidate record and successful production validation agree. Closed beta has `RELEASE_AUDIENCE=closed-beta`, `BETA_MODE=on`, and a reviewed, nonempty valid `BETA_ALLOWLIST`; public release has separate approval, `RELEASE_AUDIENCE=public`, and `BETA_MODE=off`. | Missing/invalid/case-mismatched audience, default/unset mode, invalid beta allowlist, mismatch, or public mode without separate approval. | **No-go:** no candidate-specific production audience configuration is retained; a local/default-off pass is not approval. |
| Verification | Every required matrix row is `Verified` or `Certified` for the candidate. | Any required row red or `Blocked`. | **No-go:** subscriber sign-in, conformance, recovery, browser quality, preflight, and production smoke are not `Verified`. |
| Roadmap freshness | `pnpm roadmap:status check` passes after authoritative reconciliation. | Stale aggregate. | **No-go:** the candidate Project check can pass, but Beads freshness cannot be established. |
| Worktree safety | `pnpm hygiene` exits zero with no `AT RISK` worktree and the secondary count within the soft cap. | Any `AT RISK` worktree or a secondary count above the soft cap. | **No-go:** the 2026-08-27 candidate run found two unrelated `AT RISK` worktrees and four secondary worktrees against the soft cap of three. |
| Beads/Project/issues | A second apply and final preview are a complete no-op, and accepted delivery artifacts agree. | Drift, create/update/orphan work, partial or failed sync, or issue contradiction. | **No-go:** authoritative sync cannot run; the latest recorded Project query found managed items were drafts. |
| Six local gates | All six pass on the exact candidate with retained output. | Any failure or evidence from another commit. | **No-go:** check, typecheck, unit, build, and all 16 configured production browser tests passed; hygiene failed for the worktree conditions above. |
| Database | Staging migration, production backup, migration success, schema verification, and recovery record exist. | Missing backup, skipped/failed migration, or unproved recovery. | **No-go:** no candidate-specific production migration and restore artifact is retained. |
| Smoke and Stripe | Demo, subscriber, cloud, and webhook evidence pass; Stripe claim/update recovery is atomic and retry-safe; local runs only if supported. | Any failed required smoke, missing webhook delivery, or claim-before-state behavior that permanently deduplicates failed processing. | **No-go:** only local/unit evidence is retained, and current Stripe claim/update ordering is not retry-safe. |
| Isolation | Tenant, credential, identity, and redaction evidence pass in a release-equivalent environment. | Any cross-tenant or secret-boundary failure. | **No-go:** production-like isolation evidence is not retained. |
| Observability, rollback, recovery | Diagnostics pass and a dated rollback/recovery rehearsal is retained with named operators. | Blind operation, missing owner, or unproved recovery for affected data. | **No-go:** health/readiness and persisted-run recovery remain incomplete. |
| Actions policy | All evidence is local and retained while Actions remain intentionally disabled. If CI is separately restored, refresh the roadmap and replace this evidence policy before counting remote checks. | Treating an unrun workflow as evidence or re-enabling Actions without separate approval. | **Accepted constraint:** not a go signal; every other gate still applies. |
