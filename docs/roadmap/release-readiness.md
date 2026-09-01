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
- database migration compatibility is unproved;
- subscriber or tenant authority can be supplied by request input;
- checkout or credential controls remain enabled after current subscription
  authority is invalidated or expires;
- a team child can exceed its immutable workspace/tool authority or a
  GitHub-capable step can run without the approved capability broker;
- Daytona credentials, snapshot, target, or domain policy are missing;
- an active run lacks durable PostgreSQL ownership;
- lifecycle, SSE, rollback, or reconciliation evidence is absent;
- a high-severity security finding remains unresolved.

## Environment prerequisites

- Auth.js and GitHub OAuth configuration
- PostgreSQL and applied migrations
- Redis admission state
- Daytona API key, snapshot, target, lifecycle settings, and domain allowlist
- credential KEK ring and AAD write policy
- Stripe restricted key, webhook signing secret, recurring Price, and
  default-off Checkout launch flag
- distinct cron, manual reconciliation, and diagnostic credentials
- explicit `RELEASE_AUDIENCE` and matching beta configuration

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
- scheduled and manual reconciliation;
- diagnostics with its distinct operator credential.

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

## Stripe webhook delivery

Before enabling new subscription Checkout:

1. Keep `SUBSCRIPTION_CHECKOUT_ENABLED=off` during deployment and migration.
2. Confirm `STRIPE_PRICE_ID` identifies the intended live recurring Price,
   interval, currency, amount, and Product.
3. Confirm the production restricted key has only the permissions documented
   in the subscription billing policy and can complete the test-mode Customer,
   subscription, Checkout Session, invoice-line, and recovery paths.
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
- confirm retry behavior after a transient database failure;
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
3. Reconcile in-flight attempts.
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
