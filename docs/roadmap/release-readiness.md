# Release Readiness

This runbook is a production approval gate. Repository tests do not prove a
deployment, migration, provider action, or resource deletion occurred.

## Current release disposition

**Infrastructure cutover is complete; full product release approval is
pending.** The Daytona control-plane and retired-provider evidence is retained
in the [cutover attestation](../operations/daytona-cutover-attestation.md).
Promotion remains pending until every remaining product item has a dated
sanitized artifact and named operator.

## Automatic no-go rules

Do not promote when:

- any repository gate fails;
- a worktree is `AT RISK`;
- private Beads-to-Project reconciliation has not completed with a final no-op
  preview;
- release audience configuration is ambiguous;
- an enabled beta campaign carries an unapproved account cap, minute grant,
  or account-age floor;
- database migration compatibility is unproved;
- subscriber or tenant authority can be supplied by request input;
- checkout or credential controls remain enabled after current subscription
  authority is invalidated or expires;
- a revoked or lapsed queued dispatch can reach capacity, credential, sandbox,
  or provider work, or a running attempt lacks its bounded finish-current
  recovery and explicit cancellation path;
- a team child can exceed its immutable workspace/tool authority or a
  GitHub-capable step can run without the approved capability broker;
- Daytona credentials, snapshot, target, or domain policy are missing;
- the pinned snapshot lacks exact active CPU/memory/disk verification, or
  repeated execution requires an unresolved containment/reset decision;
- an active run lacks durable PostgreSQL ownership;
- lifecycle, SSE, rollback, or reconciliation evidence is absent;
- a high-severity security finding remains unresolved.

The [cloud pilot integration boundary](../product/cloud-pilot-integration.md)
also requires canonical familiar authority, native account/mission transport,
and packaged end-to-end evidence before promoting native paid delegation.
Billing-only recovery must remain available to a current authenticated owner
after paid access expires; it is not an execution or credential exception.

## Environment prerequisites

- Auth.js and GitHub OAuth configuration
- PostgreSQL and applied migrations
- Redis admission state
- Daytona API key, snapshot, target, lifecycle settings, and domain allowlist
- credential KEK ring and AAD write policy
- Stripe restricted key, webhook signing secret, recurring Price, and
  default-off Checkout launch flag
- distinct cron, manual reconciliation, and diagnostic credentials
- explicit `RELEASE_AUDIENCE`, matching beta configuration, and a complete
  beta campaign switch and bounds whenever the campaign is on

Validate without printing secrets:

```bash
pnpm validate:release
```

## Database migration

1. Review generated SQL and forward/backward application compatibility.
2. Back up according to the database provider's approved procedure.
3. Apply migrations once.
4. Confirm schema checks and a read-only runner-store query.
5. Record migration ID, timestamp, operator, and sanitized result.
6. Prefer forward fixes after irreversible writes.

## Planning and delivery reconciliation

Only an authorized maintainer may update private planning data. Run the
repository's documented preview/apply sequence and retain only sanitized
aggregate results. A delivery artifact never overrides the private authority.
Do not promote until private Beads-to-Project reconciliation has completed with
a final no-op preview and `ROADMAP.md` passes its freshness check.

## Required local gates

```bash
pnpm hygiene
pnpm check
pnpm typecheck
pnpm test:unit
pnpm build
```

Record the candidate SHA and exact exit status for every command.

## Staging evidence collection

The bounded staging collector records deployment-scoped operator evidence; it
is **staging evidence collection only** and does not make a final readiness decision.
It performs the fixed same-origin health and signed-out refusal
checks, the bounded diagnostic, scheduled and repeated manual reconciliation,
read-only inventory before and after reconciliation, and cross-channel
credential-isolation refusals. Manual reconciliation can have bounded effects,
so an operator must explicitly confirm them.

With the exact staging origin preapproved in the process environment and the
three distinct operator credentials preconfigured there (never command-line
arguments), run:

```bash
pnpm staging:certify -- \
  --origin https://staging.example.invalid \
  --deployment-id dpl_exampleDeploymentIdentifier \
  --source-sha "$(git rev-parse HEAD)" \
  --source-tree-sha "$(git rev-parse HEAD^{tree})" \
  --app-build staging-build-identifier \
  --output path/to/staging-certification.json \
  --confirm-effects
```

Use either `--app-build` or `--deployment-metadata`, never both. The collector
accepts only an exact HTTPS origin and writes a new mode-`0600` JSON receipt
atomically; it refuses to overwrite an existing receipt. Responses are
size-bounded, JSON-only, redacted by omission, and never retain authorization
headers, credentials, or raw provider output. Retain the receipt only in the
approved evidence system, not in the repository.

The receipt deliberately leaves subscriber lifecycle, persistent sandbox
lifecycle, resource disposition, Stripe checkout/webhook failure-retry,
observation window, approvals, and final release approval uncertified.

## Required smoke paths

- health and authenticated account access;
- guest refusal for protected resources;
- subscriber agent create, read, update, and delete;
- subscriber skill and team create, read, update, and delete;
- checkout-disabled and checkout-enabled account and console subscription
  states, including delayed authority refresh and paid-through expiry;
- owner-bound Copilot device authorization, lost-response replay, and
  authorization loss before credential commit;
- Daytona sandbox create and reuse;
- idempotent run start;
- workspace-only team run, bounded handoff, approval, cancellation, terminal
  projection, and reconciliation;
- SSE reconnect from `Last-Event-ID`;
- stop and terminal convergence;
- credential acquisition compensation on injected launch failure;
- revocation before queued dispatch, plus revocation after durable launch:
  verify the former has no credential/provider effect and the latter converges
  only the exact running attempt within its time bound;
- scheduled and manual reconciliation;
- diagnostics with its distinct operator credential.

## Machine-readable readiness receipt

Create one sanitized JSON receipt for the exact deployment candidate and
validate it before requesting approval:

```bash
pnpm readiness:check path/to/readiness-receipt.json \
  --expected-sha "$(git rev-parse HEAD)" \
  --expected-candidate-digest "$DEPLOYMENT_CANDIDATE_DIGEST" \
  --expected-environment "$DEPLOYMENT_ENVIRONMENT" \
  --expected-rollback-sha "$CERTIFIED_ROLLBACK_SHA" \
  --expected-rollback-candidate-digest "$CERTIFIED_ROLLBACK_DIGEST" \
  --expected-rollback-certification-digest "$ROLLBACK_CERTIFICATION_DIGEST" \
  --expected-rollback-schema-digest "$ROLLBACK_SCHEMA_DIGEST" \
  --expected-rollback-deployment-reference "$ROLLBACK_DEPLOYMENT_URL" \
  --reviewer-keys path/to/authorized-reviewer-keys.json
```

The strict version-1 contract is defined in
`scripts/readiness-receipt.ts`. It records:

- a canonical candidate-manifest digest over the exact source SHA, app build,
  migration, executor contract, adapter, Daytona SDK/API, snapshot, target,
  region, and configuration digest;
- synthetic tenant, account, and run correlation digests rather than raw
  identifiers;
- candidate-bound test results for every entry in test manifest version 1,
  covering the required hermetic application, deployed staging, and production
  smoke journeys;
- explicit failure or recovery dispositions, evidence digests, and retention
  classes, plus one canonical evidence-set digest;
- a canonical release-decision digest covering the candidate, deployment
  environment, evidence set, blockers, receipt and manifest versions, receipt
  timestamp, requested decision, and complete rollback certification;
- candidate-bound evidence-redaction and retired-provider results;
- a distinct previously certified rollback candidate with retained deployment
  and schema-compatibility evidence;
- open blockers and signed approvals from the three required reviewer roles.

Every object is strict, recognized text fields are scanned for secret-shaped
content, HTTPS references reject embedded credentials and secret-bearing query
or fragment values, and receipt files are capped at 1 MiB. A `go` decision is
invalid unless every required manifest entry has durable passing evidence,
every passing or failing result retains at least one evidence digest, every
result passes or is explicitly not applicable, redaction and retirement
evidence pass, no blocker remains, and the release operator, security reviewer,
and product owner approve. Required entries cannot be replaced by one generic
result per layer, and ephemeral evidence cannot satisfy them.

Each approval carries a stable reviewer identity, role, timestamp, candidate
digest, evidence-set digest, complete release-decision digest, HTTPS approval
reference, signing-key identifier, and Ed25519 signature. Neither the
environment, blocker list, requested decision, receipt issuance time, nor
rollback certification can be changed without new approvals. Approvals must
occur after the latest evidence they attest. The trusted reviewer-key file is
supplied independently at validation time and binds each key to an authorized
identity and role; it is not embedded in the receipt. Final decisions reject
duplicate reviewer identities, key identifiers, and public-key fingerprints,
preventing one private key from satisfying multiple approval roles.

The validator also requires an independently supplied deployment environment,
candidate digest, rollback source and candidate digests, rollback
certification and schema-compatibility digests, and rollback deployment
reference. It rejects a rollback target equal to the candidate, rejects
evidence dated more than five minutes in the future, and rejects final receipts
when any required evidence or approval is older than seven days. Generate
expected values from the deployment and previously certified rollback
manifests rather than copying values out of the receipt under review.

A reviewer-key file contains a strict top-level `keys` array. Each entry names
`keyId`, `reviewerId`, authorized `roles`, and an Ed25519 `publicKeyPem`.
Public keys are not secrets, but the approved key registry remains controlled
release configuration. Private signing keys must never enter the repository,
receipt, command line, logs, or evidence bundle.

A not-applicable result does not satisfy a required manifest entry. A `no_go`
receipt requires an explicit blocker or failed evidence, at least one signed
rejecting reviewer, the same independent candidate and rollback bindings, and
fresh evidence. Pending receipts may retain deferred evidence and blockers
without implying release approval or requiring signed final attestations.

Store the receipt only in the approved evidence system. Do not commit
production identifiers, credentials, provider output, private repository
content, prompts, payment data, or environment dumps.

## Same-origin runner session boundary

- Browser requests use relative `/api` paths.
- Login, checkout, account, credential, and runner navigation resolves through
  the configured canonical application base path.
- The Auth.js session is the only browser execution credential.
- Subscriber state and tenant identity are derived and revalidated server-side
  for standalone and coordinated-team routes.
- Browser code receives no provider credential or tenant harness plaintext.
- Mutation origin and media type checks run before body work.

## Deployment posture

Git-triggered Vercel deployments remain intentionally disabled by the deny-only
root `vercel.json`. Restoring Git deployment behavior requires the separately
reviewed deployment runbook described in
[`vercel-git-deployment-disablement.md`](../operations/vercel-git-deployment-disablement.md).
Repository build evidence does not prove a deployment occurred.

## Coordinated team execution

- Team and skill resources remain tenant-fenced and exclude tenant identifiers,
  token hashes, and provider internals from public responses.
- Every child uses immutable authority, agent, skill, workspace, and tool
  snapshots plus deterministic reserved run and operation IDs.
- Handoffs remain within aggregate and per-handoff UTF-8 byte budgets and
  reject or redact operational metadata.
- Workspace-only Copilot steps receive no shell, network, or GitHub tools.
- GitHub-capable steps fail closed until approval is enforced through a bounded
  production capability broker.
- Cancellation, crash recovery, terminal projection, and retained-child
  cleanup must be exercised against release-equivalent PostgreSQL.

## Beta campaign audience

The open beta campaign grants bounded run minutes to any account that signs in
with GitHub. It is an entitlement source distinct from a subscription: a
participant is a real account with a real tenant whose minutes come from a
grant rather than from Stripe, so `subscribedUntil` is never written and
reconciliation never sees a subscription date with no subscription behind it.

Six variables govern it. `BETA_CAMPAIGN_ENABLED` must be exactly `on`; any
other value, and any missing or malformed number, disables the whole campaign
rather than substituting a default.

| Variable | Bound |
| --- | --- |
| `BETA_CAMPAIGN_ENABLED` | whether the campaign admits anyone at all |
| `BETA_CAMPAIGN_MINUTES` | total run time one account may ever spend |
| `BETA_CAMPAIGN_RUN_MINUTES` | reservation and duration bound for one campaign run; must not exceed `BETA_CAMPAIGN_MINUTES` |
| `BETA_CAMPAIGN_MAX_ACCOUNTS` | how many accounts may ever enroll |
| `BETA_CAMPAIGN_MIN_ACCOUNT_AGE_DAYS` | minimum GitHub account age at enrollment |
| `BETA_CAMPAIGN_GRANT_DAYS` | how long an issued grant stays spendable |

Worst-case exposure is `BETA_CAMPAIGN_MAX_ACCOUNTS` multiplied by
`BETA_CAMPAIGN_MINUTES` of run time, plus the idle sandbox tail each run leaves
behind. Reason about that product, not the per-account grant alone, when
approving the cap.

The same switch opens the beta gate, deliberately. Splitting the audience
decision across two flags lets them disagree, and this pair would disagree
expensively: a campaign granting minutes behind a closed allowlist hands people
free run time and then bounces them at the door.

Before enabling:

1. Confirm the campaign migration is applied and the `User` grant columns and
   `RunnerRun."entitlementMinutes"` exist.
2. Run `pnpm validate:release`. It refuses a campaign that is switched on with
   a missing, non-positive, or self-contradicting number.
3. Confirm the cap and the account-age floor carry the approved values. The age
   floor is the only check standing between an open campaign and account
   farming, and it fails closed on an unreadable creation date.
4. Deploy with `BETA_CAMPAIGN_ENABLED=off` and prove a signed-out request is
   still refused and that no account holds a grant.
5. Set `BETA_CAMPAIGN_ENABLED=on` and redeploy. Environment values are baked in
   at deploy time, so changing the variable alone does not take effect.
6. Prove one enrollment end to end: an account under the age floor is refused,
   an account over it is granted, its run is bounded by
   `BETA_CAMPAIGN_RUN_MINUTES`, and its usage reads against the campaign
   allowance rather than the subscriber monthly cap.
7. Prove the cap. Enrollment stops at `BETA_CAMPAIGN_MAX_ACCOUNTS`, but sign-in
   still succeeds past that point and the account simply holds no grant.
   Confirm that state is acceptable to present before opening.

To close the campaign, return `BETA_CAMPAIGN_ENABLED` to `off` and redeploy.
Disabling stops new enrollment; it does not confiscate minutes already granted,
which keep expiring on their own schedule. It does close the gate, so an
enrolled account absent from `BETA_ALLOWLIST` keeps spendable minutes it can no
longer reach. Drain or accept that population before closing.

## Stripe webhook delivery

Before enabling new subscription Checkout:

1. Keep `SUBSCRIPTION_CHECKOUT_ENABLED=off` during deployment and migration.
2. Confirm `STRIPE_PRICE_ID` identifies the intended live recurring Price,
   interval, currency, amount, and Product.
3. Use a test-mode restricted key to complete the documented Customer,
   subscription, Checkout Session, invoice-line, and recovery paths. Then
   create a separate live-mode restricted key with the same reviewed
   permissions and verify that it can read the configured live Product and
   Price. Do not attempt to use a live key against test-mode resources.
4. Configure the webhook endpoint at the canonical application origin for:
   `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`, `invoice.paid`, and
   `invoice.payment_failed`.
5. Verify the endpoint signing secret and exact raw-body signature handling.
6. Run the checkout-disabled browser suite and prove both account surfaces hide
   new-sales controls while the webhook still accepts a signed existing-customer
   event.
7. In Stripe test mode, prove successful first payment, delayed webhook
   activation, failed initial payment, duplicate delivery, transient database
   retry, renewal failure grace, expiry, and cancel-then-resubscribe.
8. Inspect every pending `StripeReconciliation` row and resolve or explicitly
   accept it before launch.
9. Confirm Customer Portal, self-service cancellation, plan changes, and Stripe
   Tax are not represented as available features.
10. Enable `SUBSCRIPTION_CHECKOUT_ENABLED=on`, rerun runtime validation, and
    prove both account surfaces can open one current Checkout Session without
    exposing Stripe secrets or hardcoding the provider amount.

For ongoing webhook delivery:

- verify signature validation;
- prove event deduplication and ordering;
- prove subscription activation and expiry update server-owned authority;
- confirm a failed owner mutation rolls back the atomic event claim, so the
  same Stripe delivery remains retryable;
- retain a sanitized event ID and status only.

To stop new sales, return `SUBSCRIPTION_CHECKOUT_ENABLED` to `off` and verify
`POST /api/checkout` refuses before provider work. Keep the webhook configured
and healthy for existing subscribers. Rollback must never delete Customer,
Subscription, `StripeEvent`, or unresolved `StripeReconciliation` records.

### Stripe Tax no-go

Do not enable `automatic_tax` until the business/head-office address, Product
tax code, Price tax behavior, customer-location collection, and every required
tax registration have been reviewed. A successful Checkout without an active
registration can collect no tax. The detailed readiness sequence is in the
[subscription and billing policy](../product/subscription-billing-policy.md#stripe-tax-readiness).

## Credential and identity isolation

- Cross-tenant reads return nondisclosing refusals.
- Shared subscription authority is scoped to user, auth version, paid-through
  boundary, and unique server resolution.
- Current `401` or `403` credential refusals invalidate shared authority;
  stale auth-version or resolution refusals cannot invalidate replacements.
- Device polling is bound to the initiating subscriber, claims idempotency
  before provider exchange, and rechecks authority inside the credential
  commit transaction.
- Credential rows remain tenant-and-harness scoped.
- Run acquisition binds the credential to one durable attempt.
- Failed launches compensate the exact usage reservation and lease.
- Evidence, logs, and errors contain no credential value.

## Observability and diagnostics

Retain sanitized request IDs, operation IDs, run IDs, status transitions,
aggregate reconciliation counts, provider resource IDs, and timestamps. Never
retain cookies, authorization headers, credentials, task content, or private
repository output.

## Rollback

1. Pause new starts.
2. Preserve PostgreSQL execution ownership.
3. Reconcile already-launched attempts without minting fresh authority; cancel
   an exact attempt explicitly when a security or operational response
   requires it.
4. Redeploy the previously verified schema-compatible release.
5. Verify same-origin authorization and Daytona ownership remain intact.
6. Resume traffic only after lifecycle and security smoke paths pass.

Do not assign another provider to an existing agent or attempt during rollback.

## Data recovery

Recovery must be idempotent, lease-bounded, cursor-bounded, and exact-attempt
fenced. If provider state is ambiguous, retain cleanup ownership and report an
explicit recovery state instead of success.

## Go/no-go record

| Role | Operator | Date/time | Candidate | Decision | Evidence |
| --- | --- | --- | --- | --- | --- |
| Release operator |  |  |  | Pending |  |
| Security reviewer |  |  |  | Pending |  |
| Product owner |  |  |  | Pending |  |
