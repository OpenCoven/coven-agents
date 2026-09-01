# Subscription and Billing Policy

- Status: living repository policy
- Last reviewed: 2026-08-31
- Scope: subscriber entitlement, Stripe checkout and webhook handling, billing
  period usage, and recovery expectations

This document records the subscription decisions implemented by the current
repository. It is not a production certification. Provider configuration,
deployment state, webhook delivery, and live recovery exercises require
separate operator evidence.

## Product policy

The application offers one configured Stripe subscription price at a time.
`app/api/checkout/route.ts` creates a hosted subscription Checkout Session with
one `STRIPE_PRICE_ID` line item. The repository does not encode or verify the
price amount or recurring interval, so reviewers must confirm those values in
Stripe before promotion.

There is no application-granted free trial. A failed initial invoice grants no
authority. Guest replay is the non-paying evaluation path. Metered overage,
seats, plan changes, add-ons, tax policy beyond Stripe Checkout, and proration
are not implemented here.

The included monthly allowance is `MONTHLY_RUN_CAP = 750`, defined in
`lib/billing/limits.ts`. That constant is the current source read by admission,
usage responses, and analytics. Any subscription offer must disclose the cap
before purchase; the account usage surfaces must continue to report the same
value rather than maintain a separate copy.

## Entitlement authority and timing

The durable application authority is the `User.subscribedUntil` timestamp,
with `User.billingPeriodStart` anchoring usage to the paid Stripe period.
`lib/subscription.ts` grants subscriber classification only while
`subscribedUntil` is strictly later than the current time. Missing, invalid,
or expired state is guest state.

Stripe is evidence for paid periods, but it does not directly authorize an
application request. Only the signature-verified webhook route may translate a
supported Stripe event into database entitlement state.

### Administrative overrides

`pnpm subscription grant|revoke|status` is an authorized operator override for
bootstrap or complimentary access, not Stripe evidence or production
certification. `status` is read-only. Each `grant` or `revoke` requires a
bounded `--reference-stdin`; mutations read one bounded printable UTF-8 value
from standard input, then hash it with SHA-256 before any database lookup or
mutation. The value is capped at 128 encoded bytes and may include printable
Unicode; control, format, surrogate, and Unicode line- or paragraph-separator
characters are rejected. The raw value is never accepted through command
arguments or printed.

`grant` defaults to 365 days and is finite: the exported
`MAX_SUBSCRIPTION_OVERRIDE_DAYS = 3650` upper bound prevents an indefinite
entitlement. `revoke` immediately clears the paid period. Both commands run
one transaction that locks the exact tenant-owner `User` row, fences a stale
authority version, increments `authVersion` exactly once, updates
`subscribedUntil` and `billingPeriodStart`, sets the finite paired active
override marker (`grant` or `revoke` plus its transaction time), and inserts one immutable
`SubscriptionOverrideAudit` record. The audit stores only its ID, owner
reference, `grant` or `revoke` action, prior and new paid-through timestamps,
prior and new authority versions, creation time, and the reference digest.
It has no email, raw reference, arbitrary operator text, Stripe identifiers,
payload, secret, or payment data. Audit, entitlement, authority, and commit
failures roll the whole transaction back. A successful override invalidates
existing authority rather than relying on a sign-out/in instruction.

This override is intentionally separate from normal Stripe webhook authority,
checkout, run admission, and mid-run transition policy. It remains stronger
than delayed automatic Stripe evidence. A paid invoice event must be strictly
newer than the marker's authenticated event (or normalized invoice) creation
time and must independently satisfy the exact interval rule before it can
supersede an override and atomically clear the marker. Checkout-reference,
failed, stale, no-op, ambiguous, and rejected events never clear it. The
reconciliation snapshot and write fence include both marker fields, so an
administrative change cannot be overwritten between provider observation and
commit. The marker contains neither the operator reference nor a digest; the
immutable audit table is the only override evidence record.

Auth.js carries `subscribedUntil` in its server-managed session token and
recomputes the derived type on every callback, so expiry is exact without
trusting a client-supplied plan. Protected routes then call
`authorizeSubscriberAccess`, which checks both the session classification and
the current database `authVersion` and subscription timestamp. Dispatch
revalidates those authorities again in `lib/runner/runtime.ts` before capacity,
credential, or Daytona work.

A successful payment does not make a browser redirect authoritative. The
verified webhook must first update the database. A token minted before payment
still carries its earlier date because ordinary callbacks do not poll the user
row; a later authenticated session carries the updated type. Cancellation does
not revoke an already paid
period; authority ends when `subscribedUntil` passes. An explicit
administrative revoke clears the period immediately.

Copilot device authorization returns an encrypted-replay start response with an
opaque HMAC binding over the initiating user and one-time provider code. Polls
must return that binding and claim the same authenticated owner's hashed
idempotency key before the server verifies ownership and exchanges the code.
Every provider result is checked against the original session's current
`authVersion` and subscription authority before it can be published. After
GitHub returns a token, the server encrypts it in memory, then one database
transaction locks and verifies both the current User authority and the exact
live claim (record ID, owner, operation, key, request hash, owner token, and
expiry). Only after both rows are locked does it take the commit timestamp used
to recheck claim expiry and subscription authority, upsert that owner's
credential, and mark the same record completed with only
`{ "status": "authorized" }`. Authority loss returns `403` without a credential
write. A failed credential write or completion rolls the whole transaction
back; a lost HTTP response replays the completed result without another
provider exchange. Retryable PostgreSQL serialization, deadlock, and conflict
failures are retried three times inside the same request while the exchanged
token remains in memory. An unrecoverable transaction failure returns `503` and
attempts the same fenced claim release; a total database outage may leave it
leased until expiry. The provider exchange and PostgreSQL cannot form one
global transaction, so a provider success followed by that outage can still
require a fresh device authorization, but no credential can now persist without
its completed replay record.

## Checkout responsibilities

`app/api/checkout/route.ts` owns checkout initiation:

1. Require an authenticated application user, then require the default-off
   checkout launch gate before abuse admission or provider work.
2. Pass abuse admission, then claim the caller's durable application
   idempotency key. Checkout renews this response claim while provider work is
   active; renewal, completion, and release are fenced by a random owner token.
   Successful Checkout responses are not cached. A completed record left by an
   older deployment is atomically reclaimed instead of replaying its URL.
3. Require `STRIPE_SECRET_KEY` and `STRIPE_PRICE_ID`; otherwise return
   `billing_unavailable` without changing subscription state.
4. Acquire a short-lived durable per-user checkout lease. The holder renews it
   while Stripe work is active, and every renewal and release is fenced by a
   random ownership token. A concurrent request with a distinct browser key
   receives `request_in_progress`; no database transaction remains open during
   Stripe calls. The outer response claim is renewed independently, so the
   original browser request remains fenced after work exceeds either original
   lease duration without persisting the returned Checkout URL.
5. Reuse the user's Stripe Customer or create one with `metadata.userId`, then
   checkpoint the returned Customer ID in the durable attempt before atomically
   attaching it without replacing a Customer already owned by the account. A
   failed attachment is retried with the checkpointed Customer rather than
   creating another one. Deterministic provider rejections retire the attempt;
   uncertain provider outcomes retain its identity for reconciliation.
6. Page through every Stripe subscription until a blocking status is found or
   all pages are exhausted. If atomic Customer attachment returns a different
   winner from the Customer already inspected, repeat both subscription and
   Checkout Session reconciliation against that actual Customer.
7. Page through open, complete, and expired hosted Checkout Sessions and
   retrieve recovery candidates before acting. Reuse only an open Session with
   a valid HTTPS URL matching the same Customer, user, subscription mode,
   application checkout-flow version, configured Price, and durable attempt.
   A complete current attempt returns `request_in_progress` while webhook
   entitlement catches up. An expired current attempt retires before a later
   request may create a replacement. An open subscription Session whose
   Customer, user references, or ownership metadata cannot be proven returns
   `checkout_session_conflict`; it is neither expired nor ignored.
8. Expire mismatched app-owned open Sessions before creating a replacement,
   then retrieve each one to prove it is expired. Each lease owner uses a
   separately derived expiration idempotency key, so an uncertain cached
   expiration error can be retried only after reconciliation proves the Session
   is still open. A failure returns `checkout_session_conflict` without
   creating another payable Session.
9. After detecting a blocking subscription, retrieve and expire every safely
   app-owned open subscription Session before returning
   `already_subscribed`. A Session that completes during cleanup has its
   subscription reconciled; uncertain ownership or expiration returns
   `checkout_session_conflict`. The attempt retires after all such Sessions are
   confirmed expired.
10. Permit cancel-then-resubscribe with the same Customer. Historical or
   cancelled subscriptions are expected and do not violate the invariant.
11. Create the hosted subscription Checkout Session with distinct Customer and
    Session idempotency keys derived from the durable checkout-attempt identity,
    and stamp that attempt identity in both Customer and Session metadata. The
    durable Session-created checkpoint binds the exact Customer and Session
    IDs. If a lease expires, its successor keeps the attempt and provider keys.
    A stale holder that later finishes cannot report success or delete the
    successor's lease.

The decision helper is `lib/billing/checkout.ts`; the route and
`lib/billing/checkout.test.ts` are the current enforcement sources. A user row
stores one Customer ID, and the unique `stripeCustomerId` index prevents that
ID from belonging to two users; it is not the one-active-subscription control.
The **At most one active subscription** policy also treats non-terminal
payment states as blocking so a second payable Checkout cannot bypass an
incomplete first attempt.
The checkout lease reuses the existing `IdempotencyRecord` row: its stable row
ID identifies the provider attempt, `requestHash` carries the fencing token
and latest bounded reconciliation checkpoint while owned and that state alone
while idle, and `expiresAt` is renewed before expiry. Customer-created,
retryable, uncertain, and Session-created outcomes keep the row so a successor
reconciles the same attempt without replaying a cached provider error or
creating a second Customer after a failed database attachment. A definite
local pre-request failure, blocking subscription, or provider-proven terminal
attempt retires it. Generic route-idempotency cleanup excludes these recovery
rows. Stripe remains the durable source for Checkout Session and subscription
state.

## Webhook responsibilities

`app/api/stripe/webhook/route.ts` owns entitlement mutation from Stripe:

1. Require both Stripe secrets and the `stripe-signature` header.
2. Verify the signature against the exact raw request body before reading any
   event as authority.
3. Claim the Stripe event ID in `StripeEvent` inside the same transaction that
   locks and updates the owner. Any claim, lock, decision, update, or commit
   failure rolls the claim back so Stripe receives a retryable `503`.
4. Resolve invoice ownership by the unique persisted
   `User.stripeCustomerId` first. That path does not retrieve the Stripe
   Customer and ignores stale provider metadata. Only an unmapped Customer may
   use checkout-stamped metadata, and then the exact attempt ID, operation,
   local owner, and bounded durable checkout state must prove that Customer.
5. Require the same local attempt evidence for Checkout reference events. The
   provider markers alone are insufficient: the durable state must prove the
   exact Customer and Checkout Session IDs.
6. Allow-list entitlement changes through `lib/billing/webhook.ts`.
   `invoice.paid` accepts the subscription ID, billing-period start, and
   period end as one exact interval and carries the signature-authenticated
   Stripe event creation time. A same-subscription renewal may advance it. A
   different subscription may replace it only when no paid interval is backed,
   or when its start is at or after the stored end and its end advances.
   Overlapping replacement intervals never merge or reset usage; they enter
   manual reconciliation. An active administrative override rejects evidence
   created at or before its marker and is cleared only by a strictly newer
   successful paid application. Unknown events change nothing.
7. Persist manual dispositions by inserting `StripeEvent` and
   `StripeReconciliation` together. A redelivery conflicts on the event ID and
   returns `deduped`; a reconciliation insert or commit failure rolls both rows
   back and returns `503`. Sanitized logging occurs only after commit and may
   fail without losing the durable evidence.

For a backed interval on the same Subscription, compare the incoming tuple to
the stored tuple without merging endpoints:

| Incoming start | Incoming end | Outcome |
| --- | --- | --- |
| Earlier | Earlier or equal | Claimed stale no-op |
| Earlier | Later | Atomic `invoice_conflicting_paid_interval` reconciliation |
| Equal | Earlier or equal | Claimed stale no-op, including exact duplicates |
| Equal | Later | Apply the exact incoming tuple |
| Later | Earlier or equal | Claimed contained/stale no-op |
| Later | Later | Apply the exact incoming tuple |

Only the apply outcomes reset the billing-period start and usage window.

Failed-payment grace is `GRACE_PERIOD_DAYS = 3` from
`lib/billing/limits.ts`. `lib/billing/grace.ts` grants it only for
`billing_reason: "subscription_cycle"`, only when a paid period already
exists, and only once. A failed `subscription_create`, a missing prior paid
period, an unknown billing reason, or a second failure inside grace grants
nothing. Stripe dunning may continue, but this application does not extend
again. `customer.subscription.deleted` also changes nothing because the
already-paid period expires through its stored timestamp.

## Automatic bounded Stripe reconciliation

`GET /api/internal/stripe-reconcile` is an authenticated scheduled-machine
surface, not a browser or operator override endpoint. It accepts only the
existing `CRON_SECRET` bearer credential, applies its IP-only abuse admission
before credential validation or billing construction, accepts an empty body,
and returns aggregate counts only. It has no subscriber session, manual runner
credential, provider selection, or browser-controlled inputs. Missing billing
configuration fails closed. This route is repository behavior, not evidence
that a scheduler, Stripe credential, or live reconciliation has been deployed.

The service is deliberately a **positive-repair sweep**, not Stripe event
replay. It scans only local `User` rows which already hold a Stripe Customer or
Subscription reference, selecting only the local ID, `authVersion`,
`billingPeriodStart`, `subscribedUntil`, both existing mappings, and the
active override marker. It never lists Customers globally. A stored valid
Subscription is retrieved first; only an absent, not-found, or appropriate
terminal Subscription causes a strictly bounded Subscription list under that
exact stored Customer. The list selects exactly one `active` configured-Price
candidate: terminal and known ineligible statuses do not make that candidate
ambiguous, while malformed observations, unknown future statuses, duplicate
configured-Price items, and multiple active candidates still defer. A verified
Customer may therefore gain its verified missing Subscription ID, but
reconciliation does not invent a Customer mapping.

An automatic mutation requires all of the following at once:

1. the exact stored Customer and one exact Subscription agree in the provider
   observations;
2. that Subscription is `active`, contains the configured Price, and names one
   latest invoice;
3. the latest invoice is paid, has the same Customer and Subscription, and has
   a supported `subscription_create`, `subscription_cycle`, or
   `subscription_update` billing reason plus a finite normalized invoice
   creation time; and
4. exactly one non-proration subscription-item line for the configured Price
   supplies a valid start/end interval for that Subscription.

The exact paid interval is then evaluated by the same pure ordering rule as
`invoice.paid`: duplicates, stale intervals, and contained intervals are
no-ops; a later valid interval advances the exact tuple; an overlapping or
crossing replacement is deferred. Normal reconciliation does **not** increment
`authVersion`, matching webhook semantics.

Subscription status is a search filter, never payment evidence. `trialing`,
`past_due`, `unpaid`, `canceled`, `incomplete`, `incomplete_expired`, `paused`,
and future/unknown statuses are deferred rather than granting entitlement.
The service does not grant trials, infer grace from `past_due`, shorten or
clear a period, revoke from canceled/unpaid status, or resolve a conflict.
Malformed/deleted references, Customer or Subscription disagreement, multiple
candidates, unavailable or unbounded provider pages, missing/ambiguous lines,
unpaid latest invoices, unsupported reasons, and provider failures are all
deferred with finite in-memory reason codes. No provider payload, amount,
metadata, payment detail, arbitrary error, Customer, Subscription, invoice,
or reason code is persisted for automatic work.

`StripeReconciliationRun` is a singleton coordination row containing only a
local cursor plus lease owner, fence, expiry, and update time. It acquires,
takes over, renews, and releases by exact owner-and-fence checks against
database time; no database transaction stays open across Stripe calls. Each
completed user commits its cursor advance and any positive mutation in one
transaction under both that lease fence and a null-safe exact snapshot of
`authVersion`, paid interval, Customer ID, Subscription ID, and override
marker. A webhook or administrative change therefore produces a conflict
instead of an overwrite; an expired or taken-over worker cannot commit. A
crash before that transaction leaves the row eligible for a later sweep. Cursor
scans are ordered and wrap at the end, so deferred rows retry in later sweeps
without permanently starving later local rows. Batch size, total users/batches,
provider concurrency, provider pages/results, invoice-line pages/results, and
lease TTL are finite validated bounds; a per-user provider failure does not
stop later users. Stripe `401` and `403` configuration or permission failures
are instead systemic: the run aborts and the route returns a sanitized
`503 billing_provider_unauthorized`, never an ordinary deferred aggregate.

## Reconciliation evidence and runbook

`StripeReconciliation` is the dedicated operational queue for events that
cannot be applied safely. Its `eventId` is the primary key and a restrictive
foreign key to `StripeEvent.id`. `eventType`, `reason`, and `status` are
finite checked values; statuses are `pending`, `acknowledged`, and `resolved`.
No user ID, Customer ID, Subscription ID, raw payload, metadata, secret, or
arbitrary operator text is stored. Logs contain only the event ID, bounded
event type, bounded reason, and status.

Generic idempotency cleanup does not read or delete either Stripe table.
Reconciliation retention is therefore an operator-controlled billing record
policy, not an expiry side effect. This scope adds no UI or public API. An
authorized operator reviews `pending` rows, retrieves the corresponding event
from Stripe through approved administrative access, compares it with the
current `User` entitlement state, marks the row `acknowledged` while
investigating, performs any explicit repair through the authorized billing
procedure, and marks it `resolved` only after verification. Deletion, if a
future retention policy requires it, must be an explicit audited operation
that handles the restrictive event foreign key; generic cleanup must never
silently remove unresolved evidence.

## Usage cap and run accounting

The cap is enforced server-side before plaintext credential access.
`lib/credentials/runner-credential.ts` calls the durable reservation logic in
`lib/billing/run-reservations.ts`; a reservation or usage lookup failure denies
the run rather than treating an unreadable counter as allowance. Tenant
monthly refusal preserves bounded cap and used values without issuing or
decrypting a credential.

The billing period begins at the webhook-supplied `billingPeriodStart` when it
is valid. `lib/billing/period.ts` otherwise derives a clamped one-month start
from `subscribedUntil`; it is not a calendar-month reset.

Run IDs are durable deduplication keys. A retry or recovery path for the same
run does not consume a second allowance. Reserved capacity is discarded when
credential preparation fails before launch, and a consumed reservation is
compensated only after cleanup proves no command launched. In-flight work that
did launch retains its consumed usage record.

`GET /api/usage` reads the current account period and returns cap, used,
remaining, and reset information from the same reservation accounting used by
admission. If account period state is absent, remaining allowance is zero. If
the accounting read fails, the endpoint returns `capacity_unavailable`.

## Failure and recovery

| Failure | Current behavior | Recovery and verification |
| --- | --- | --- |
| Stripe unavailable during checkout | Checkout fails; no entitlement is written. | Retry with an application idempotency key after Stripe and local dependencies recover. Confirm no active subscription exists before opening a new session. |
| Checkout lease expires during Stripe work | A successor reclaims the same durable attempt and provider keys; the stale holder returns `request_in_progress` rather than success. | Retry after the current owner settles. Inspect the open Session and Customer using the deterministic provider keys if manual reconciliation is required. |
| Checkout creation has an uncertain provider outcome | The attempt and provider key are preserved. A retry scans every Session state; it reuses a discovered open Session, waits on a complete Session, retires an expired Session, and otherwise returns `request_in_progress` without replaying the create call. | Reconcile the stamped attempt in Stripe. Do not rotate the attempt unless provider state proves it terminal. |
| Stripe returns HTTP 409 for an idempotent create | The create outcome is uncertain, so the durable attempt and provider key remain active for Session reconciliation. | Wait for the in-flight Stripe request to settle, then retry; do not mint a replacement provider identity while the original Session may exist. |
| Customer creation succeeds but database attachment fails | The returned Customer ID remains checkpointed in the fenced checkout attempt. | Retry after database recovery; the successor attaches and reconciles that Customer without creating another one. |
| A current Checkout Session is complete but entitlement is not visible | Checkout returns `request_in_progress`; no replacement Session is created. | Allow the verified webhook to update entitlement, then re-establish the application session as required. |
| A current Checkout Session expired | The durable attempt is retired and the request returns `request_in_progress`; its URL is never replayed. | Retry with the same browser key after the non-success response is released; the new durable attempt may create one replacement. |
| Obsolete open Checkout Session cannot be expired | Checkout returns `checkout_session_conflict`; no replacement Session is created. | Restore Stripe access, retry cleanup with the same application key, and confirm only the current Price/version remains payable. |
| An open subscription Checkout Session lacks current ownership markers | Checkout returns `checkout_session_conflict` and does not expire or replace the Session. | An operator must verify the Customer, user, mode, and creation history in Stripe, then expire or otherwise resolve the unowned Session before retrying. |
| Missing billing configuration | Checkout or webhook returns `billing_unavailable`. | Restore the deployment secrets and verify configuration without logging values. |
| Stripe Invoice, Invoice Line Item, Subscription, or Customer read is unauthorized | Stripe reconciliation aborts with sanitized `503 billing_provider_unauthorized`; it does not report ordinary per-user deferrals. | Restore least-privilege key access for Customer read/write, Subscription read, Invoice read, Invoice Line Item read, and Checkout Session write; retry after validating access without logging key or Stripe error details. |
| Missing or invalid webhook signature | `400`; no event is trusted. | Correct the endpoint secret or delivery configuration, then request a provider redelivery. |
| Duplicate Stripe event | The event ID conflicts and the delivery returns `deduped`. | Confirm the original event produced the intended database period; do not bypass deduplication. |
| Persisted Customer mapping is absent but valid checkout metadata could still converge | The delivery remains unclaimed and returns `503` until local attempt provenance proves the same owner and Customer. | Let checkout attachment or recovery settle, then accept Stripe's redelivery. Never attach ownership from metadata alone. |
| Customer metadata is foreign or lacks bounded application markers | The event is ignored without an entitlement write or event claim. | Treat it as unrelated unless authorized provider and local records establish a separate repair case. |
| Manual reconciliation is required | `StripeEvent` and a `pending` `StripeReconciliation` row commit atomically; no entitlement is mutated. | Follow the reconciliation runbook, moving the bounded status through `acknowledged` to `resolved` only after verified repair. |
| Failure during event claim, reconciliation insert, owner update, or transaction commit | All transaction writes roll back and the webhook returns `503`. | Restore PostgreSQL and allow the same Stripe event ID to retry. |
| Sanitized reconciliation logging fails after commit | The webhook remains successful because durable evidence already exists. | Inspect the `pending` reconciliation queue; do not replay or delete the committed event to compensate for logging. |
| Renewal payment fails | One three-day renewal-only grace extension may be written. | Verify the event reason, prior paid period, stored period end, and that grace did not compound. |
| Initial payment fails | No entitlement is granted. | Complete payment successfully; never use renewal grace as a trial. |
| Usage or reservation storage fails | New run admission fails closed before credential access. | Restore PostgreSQL/admission dependencies and retry the same run ID so deduplication and compensation remain effective. |
| Subscription expires or is revoked during later work | New protected operations fail authority checks. | Re-establish the session after a legitimate renewal; investigate stale authority rather than extending timestamps speculatively. |

Administrative repair must use verified Stripe records and the current database
state. Never accept a browser-supplied plan, period, Customer ID, or webhook
payload as recovery authority.

## Verification

Minimum repository checks for changes to this policy or its sources:

```bash
pnpm exec tsx --conditions=react-server --test \
  lib/billing/checkout-lease.test.ts lib/billing/checkout-response.test.ts \
  lib/billing/checkout.test.ts lib/billing/grace.test.ts \
  lib/billing/limits.test.ts lib/billing/period.test.ts \
  lib/billing/run-reservations.test.ts lib/billing/webhook.test.ts \
  lib/db/stripe-event.test.ts \
  lib/subscription.test.ts lib/session-claims.test.ts \
  lib/auth/subscriber-authorization.test.ts
pnpm exec tsx --test scripts/product-boundary.test.ts
pnpm db:check
pnpm check
pnpm typecheck
```

Before production approval, additionally verify the configured Stripe price
and interval, webhook destination and signing secret, a successful first
payment, initial-payment failure, one-time renewal grace, cancellation through
paid period end, duplicate delivery, unresolved-owner recovery, cap refusal,
same-run retry accounting, session re-establishment after payment, and expiry
at the stored timestamp. Retain sanitized evidence; repository tests alone do
not certify production billing.
