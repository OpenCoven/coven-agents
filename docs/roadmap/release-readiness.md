# Release Readiness

This is the go/no-go checklist for the current cloud-only product. It covers the
Next.js app, Cloudflare Worker, database, planning reconciliation, smoke
evidence, rollback, and recovery. It does not treat disabled GitHub Actions as
executed evidence.

## Current release disposition

**No-go as of 2026-08-25.**

Current blockers are factual and fail closed:

- the authenticated private Beads/DoltHub pull returned `PermissionDenied`, so
  authoritative P0, dependency, and acceptance state cannot be reconciled;
- `pnpm hygiene` at `2026-08-25T23:38:25-05:00` reported five worktrees, four
  secondary worktrees against a soft cap of three, and two `AT RISK` branches:
  `feat/console-polish` and `feat/console-redesign`. Worktree state is live, so
  release operators must rerun the command rather than treat these names as a
  durable inventory;
- all 60 managed Project items are draft items, so GitHub issue state cannot
  independently confirm delivery reconciliation;
- required rows in [`verification-matrix.md`](verification-matrix.md) remain
  below `Verified`, and production smoke/rollback is `Blocked`; and
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
- the secondary-worktree count exceeds the repository soft cap; or
- Beads and Project are drifted or cannot be shown to agree.

A required row is **red** when its state is `Not implemented`, `Implemented`,
or `Blocked`, or when its dated evidence no longer applies to the candidate
commit or environment.

## Environment prerequisites

Check presence and agreement without printing values.

| Area | Required before release | Current repository reality |
| --- | --- | --- |
| Toolchain | Node.js 22 or newer, pnpm 10, frozen dependency install, Git, Docker for Sandbox image work, and authenticated deployment CLIs. | Declared in [`README.md`](../../README.md) and package metadata. |
| App identity and data | `AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, `POSTGRES_URL`, and canonical `APP_ORIGIN`. | GitHub is the only sign-in provider; production data requires PostgreSQL. |
| Abuse controls | `REDIS_URL` and `ABUSE_KEY_SECRET` must both be present in production. | [`scripts/validate-runtime-config.ts`](../../scripts/validate-runtime-config.ts) rejects an incomplete pair, but it is not a complete deployment preflight. |
| App-to-runner connection | `NEXT_PUBLIC_CLOUD_RUNNER_URL` or server-side `CLOUD_RUNNER_URL`, plus matching `AGENT_CONTROL_TOKEN`. | The browser receives the connection from the app; the public URL requires a fresh app build when changed. |
| Runner identity | App `RUNNER_SIGNING_KEY`; app and Worker `RUNNER_VERIFY_KEY`; matching key pair. | Claims fail closed when either side is absent or mismatched. |
| Credential lending | App and Worker `RUNNER_SERVICE_TOKEN`; app `CREDENTIAL_KEK`; Worker `APP_ORIGIN`. | The Worker has no operator or fallback harness credential. |
| Billing | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, and canonical `APP_ORIGIN`. | Checkout and webhook return `503` when unconfigured. |
| Other shipped app paths | `AI_GATEWAY_API_KEY` and `BLOB_READ_WRITE_TOKEN` when chat/model and upload paths remain enabled. | These are app feature dependencies, not runner credentials. |
| Worker | `AGENT_CONTROL_TOKEN`, `RUNNER_VERIFY_KEY`, `RUNNER_SERVICE_TOKEN`, `APP_ORIGIN`, correct `ALLOWED_ORIGIN`, Durable Object bindings/migration, container image, and Wrangler authentication. | [`worker/wrangler.jsonc`](../../worker/wrangler.jsonc) enables observability and declares the current Worker topology. |
| Demo recorder | Recorder variables from [`.env.example`](../../.env.example) only when producing a new owner-approved replay. | Guest playback itself is committed, stateless evidence and needs no recorder secret. |
| Local execution | — | The local runner was removed in `91f21c8`; the shared contract accepts only `cloud`. Local smoke is not a current release gate. |

Do not add a local CLI or stale compatibility path merely to make a checklist
look complete. If local execution is separately reintroduced, add its
prerequisites and verification before it becomes release-supported.

## Database migration

The production build runs runtime validation, then
[`lib/db/migrate.ts`](../../lib/db/migrate.ts), then the Next build. Migration
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

1. Pull, review, update, commit, and push the private Beads database.
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

Run all five against the exact release candidate:

```bash
pnpm hygiene
pnpm check
pnpm typecheck
pnpm test:unit
pnpm build
```

Retain command, commit, environment, timestamp, exit status, and sanitized
output. The last full snapshot passed check, typecheck, unit tests, and build,
but hygiene failed; it is not release evidence for a later commit. A tracked
secret scan is recommended in addition to, not instead of, the five gates.

## Required smoke paths

| Path | Required smoke | Evidence required | Current state |
| --- | --- | --- | --- |
| Demo | Load the signed-out root, verify no database/runner mutation, exercise play, pause, seek, speed, and completion, and inspect sanitized replay output. | Dated browser trace or recording tied to the candidate and deployment. | Unit-verified; no release-equivalent browser artifact. |
| Subscriber | Exercise GitHub sign-in, guest refusal, active eligibility, expired/revoked refusal, connection retrieval, and usage display. | Dated trace plus sanitized account-state evidence for allowed and denied cases. | Unit-verified; no production-like OAuth and Stripe transition artifact. |
| Cloud | Run the authenticated deployment diagnostic, create an agent, start and observe a credentialed run, stream/poll to terminal state, cancel a bounded run, delete the agent, and verify tenant/sandbox cleanup. | Dated Worker/app logs, response summary, run identifiers, and cleanup result without credentials or private output. | Local worker tests pass; no live release-equivalent lifecycle artifact. |
| Local, if supported | Create, run, cancel, and delete through the supported local boundary, including host isolation and cleanup checks. | Dated artifact from the declared supported local environment. | Not applicable: no local runner is tracked and `backend` is cloud-only. |

Smoke failure is a no-go. Do not retry until a failure disappears without
recording the first failure and its disposition.

## Stripe webhook delivery

Before go:

- confirm the deployed endpoint and `STRIPE_WEBHOOK_SECRET` match the intended
  Stripe environment;
- deliver a signed paid-invoice event and verify eligibility advances to the
  event's period end;
- redeliver the same event and verify idempotent success without a second state
  change;
- exercise failed-renewal and expiry behavior without granting a first failed
  payment; and
- retain Stripe delivery time, event category, HTTP result, and sanitized
  account-state change without copying the payload or identifiers into public
  evidence.

Unit coverage exists in [`lib/billing/webhook.test.ts`](../../lib/billing/webhook.test.ts).
No current production delivery artifact is retained.

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
- **Stripe:** rely on signed, deduplicated redelivery; retain provider delivery
  evidence and replay missed events only through authorized operations.
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
| P0 and dependencies | Authorized Beads query shows no unresolved release-blocking P0 or dependency. | Any unresolved P0, or authority unavailable. | **No-go:** Beads/DoltHub returns `PermissionDenied`; authoritative status is unavailable. |
| Verification | Every required matrix row is `Verified` or `Certified` for the candidate. | Any required row red or `Blocked`. | **No-go:** conformance, recovery, browser quality, preflight, and production smoke are not `Verified`. |
| Roadmap freshness | `pnpm roadmap:status check` passes after authoritative reconciliation. | Stale aggregate. | **No-go:** the Project snapshot matched the checked-in aggregate, but Beads freshness cannot be established. |
| Worktree safety | `pnpm hygiene` exits zero with no `AT RISK` worktree and the secondary count within the soft cap. | Any `AT RISK` worktree or a secondary count above the soft cap. | **No-go:** the timestamped hygiene evidence above reports both conditions. |
| Beads/Project/issues | A second apply and final preview are a complete no-op, and accepted delivery artifacts agree. | Drift, create/update/orphan work, partial or failed sync, or issue contradiction. | **No-go:** sync cannot run authoritatively and managed Project items are drafts. |
| Five local gates | All five pass on the exact candidate with retained output. | Any failure or evidence from another commit. | **No-go:** the latest full snapshot failed hygiene. |
| Database | Staging migration, production backup, migration success, schema verification, and recovery record exist. | Missing backup, skipped/failed migration, or unproved recovery. | **No-go:** no candidate-specific production migration and restore artifact is retained. |
| Smoke and Stripe | Demo, subscriber, cloud, and webhook evidence pass; local runs only if supported. | Any failed required smoke or missing webhook delivery. | **No-go:** only local/unit evidence is retained. |
| Isolation | Tenant, credential, identity, and redaction evidence pass in a release-equivalent environment. | Any cross-tenant or secret-boundary failure. | **No-go:** production-like isolation evidence is not retained. |
| Observability, rollback, recovery | Diagnostics pass and a dated rollback/recovery rehearsal is retained with named operators. | Blind operation, missing owner, or unproved recovery for affected data. | **No-go:** health/readiness and persisted-run recovery remain incomplete. |
| Actions policy | All evidence is local and retained while Actions remain intentionally disabled. If CI is separately restored, refresh the roadmap and replace this evidence policy before counting remote checks. | Treating an unrun workflow as evidence or re-enabling Actions without separate approval. | **Accepted constraint:** not a go signal; every other gate still applies. |
