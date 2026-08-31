# Subscription and Billing Policy

- Status: living repository policy
- Last reviewed: 2026-08-29
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
supported Stripe event into database entitlement state. The administrative
`pnpm subscription grant|revoke|status` command remains an explicit operator
override for bootstrap or complimentary access and writes the same authority
columns.

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
row; it must be re-established, currently by signing out and back in, before it
can carry subscriber type. Cancellation does not revoke an already paid
period; authority ends when `subscribedUntil` passes. An explicit
administrative revoke clears the period immediately.

## Checkout responsibilities

`app/api/checkout/route.ts` owns checkout initiation:

1. Require an authenticated application user, then require the default-off
   checkout launch gate before abuse admission or provider work.
2. Pass abuse admission, then claim the caller's durable application
   idempotency key. Checkout renews this response claim while provider work is
   active; renewal, completion, and release are fenced by a random owner token.
3. Require `STRIPE_SECRET_KEY` and `STRIPE_PRICE_ID`; otherwise return
   `billing_unavailable` without changing subscription state.
4. Acquire a short-lived durable per-user checkout lease. The holder renews it
   while Stripe work is active, and every renewal and release is fenced by a
   random ownership token. A concurrent request with a distinct browser key
   receives `request_in_progress`; no database transaction remains open during
   Stripe calls. The outer response claim is renewed independently, so the
   original browser request can still persist and replay a successful response
   after work exceeds either original lease duration.
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
   request may create a replacement.
8. Expire mismatched app-owned open Sessions before creating a replacement,
   then retrieve each one to prove it is expired. Each lease owner uses a
   separately derived expiration idempotency key, so an uncertain cached
   expiration error can be retried only after reconciliation proves the Session
   is still open. A failure returns `checkout_session_conflict` without
   creating another payable Session.
9. Permit cancel-then-resubscribe with the same Customer. Historical or
   cancelled subscriptions are expected and do not violate the invariant.
10. Create the hosted subscription Checkout Session with distinct Customer and
    Session idempotency keys derived from the durable checkout-attempt identity,
    and stamp that attempt identity in Session metadata. If a lease expires,
    its successor keeps the attempt and provider keys. A stale holder that
    later finishes cannot report success or delete the successor's lease.

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
3. Claim the Stripe event ID in `StripeEvent` before mutation. The primary-key
   insert is the idempotency boundary; a redelivery is a no-op.
4. Resolve the user by the persisted Customer ID, falling back to the
   Customer's checkout-stamped `metadata.userId` for the first event.
5. Allow-list entitlement changes through `lib/billing/webhook.ts`.
   `invoice.paid` sets the authoritative period start and end when both can be
   established. Unknown events change nothing.

Failed-payment grace is `GRACE_PERIOD_DAYS = 3` from
`lib/billing/limits.ts`. `lib/billing/grace.ts` grants it only for
`billing_reason: "subscription_cycle"`, only when a paid period already
exists, and only once. A failed `subscription_create`, a missing prior paid
period, an unknown billing reason, or a second failure inside grace grants
nothing. Stripe dunning may continue, but this application does not extend
again. `customer.subscription.deleted` also changes nothing because the
already-paid period expires through its stored timestamp.

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
| Customer creation succeeds but database attachment fails | The returned Customer ID remains checkpointed in the fenced checkout attempt. | Retry after database recovery; the successor attaches and reconciles that Customer without creating another one. |
| A current Checkout Session is complete but entitlement is not visible | Checkout returns `request_in_progress`; no replacement Session is created. | Allow the verified webhook to update entitlement, then re-establish the application session as required. |
| A current Checkout Session expired | The durable attempt is retired and the request returns `request_in_progress`; its URL is never replayed. | Retry with the same browser key after the non-success response is released; the new durable attempt may create one replacement. |
| Obsolete open Checkout Session cannot be expired | Checkout returns `checkout_session_conflict`; no replacement Session is created. | Restore Stripe access, retry cleanup with the same application key, and confirm only the current Price/version remains payable. |
| Missing billing configuration | Checkout or webhook returns `billing_unavailable`. | Restore the deployment secrets and verify configuration without logging values. |
| Missing or invalid webhook signature | `400`; no event is trusted. | Correct the endpoint secret or delivery configuration, then request a provider redelivery. |
| Duplicate Stripe event | The event ID conflicts and the delivery returns `deduped`. | Confirm the original event produced the intended database period; do not bypass deduplication. |
| Event lacks a customer or resolvable owner | The already-claimed event is ignored. | Reconcile Stripe Customer metadata and the user mapping from authorized provider evidence, then repair entitlement explicitly; replaying the same event ID will remain deduped. |
| Failure after event claim but before entitlement update | The event remains claimed, so the same event ID will not retry the write. | Inspect the Stripe event and database audit evidence, repair the mapping or period through an authorized administrative procedure, and record the incident. This route is not transactional across claim and update. |
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
  lib/billing/checkout.test.ts lib/billing/grace.test.ts \
  lib/billing/limits.test.ts lib/billing/period.test.ts \
  lib/billing/run-reservations.test.ts lib/billing/webhook.test.ts \
  lib/subscription.test.ts lib/session-claims.test.ts \
  lib/auth/subscriber-authorization.test.ts
pnpm exec tsx --test scripts/product-boundary.test.ts
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
