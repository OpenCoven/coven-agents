# Stripe entitlement ingestion and reconciliation

Status: **production gate in progress**. This change closes the claim-before-processing loss mode tracked by #49. The issue remains open until provider reconciliation, the full entitlement transition policy, database-backed subscriber fixtures, and the certification journeys in #51 are complete.

## Authority boundary

Stripe is an authenticated billing input. It is not account identity, tenant identity, run authority, or Daytona authority. The OpenCoven product database remains the normalized entitlement source used by session revalidation and hosted-run admission.

The webhook verifies Stripe's signature over the exact raw request bytes before any durable write. It never trusts checkout return state, browser storage, or a client-supplied customer/subscription identifier.

## Atomic delivery rule

For `invoice.paid` and `invoice.payment_failed`, one PostgreSQL transaction:

1. inserts the stable Stripe event id as the global idempotency claim;
2. serializes entitlement decisions for the internal account;
3. verifies that an existing account-to-customer binding cannot be replaced;
4. computes the allow-listed normalized entitlement update;
5. refuses incomplete or non-advancing/out-of-order updates;
6. writes the entitlement and commits the event receipt together.

There is no durable `claimed` state outside that transaction. A crash, process restart, database error, or failed owner update rolls the event receipt back with the entitlement mutation. A concurrent duplicate waits for the first transaction's outcome: it deduplicates only after a successful commit and may proceed after rollback. This removes the previous state in which a receipt could survive while access never changed.

Unsupported or customer-less authenticated events are recorded as ignored receipts without touching entitlement. Missing account ownership writes no receipt and returns non-2xx so Stripe can retry after checkout propagation. A customer/account ownership conflict records a terminal event receipt, returns `rejected`, and grants no access.

## Ordering and grace policy implemented here

Entitlement events for one internal account are serialized with a transaction-scoped advisory lock. A candidate `subscribedUntil` must advance the current value; delayed paid or failed invoices cannot roll access backward or re-extend a newer period.

A failed invoice must include the provider's affected period end. Without that boundary, the event cannot create grace. Grace remains allow-listed to `subscription_cycle`, applies only to an already-paid account, and does not compound.

## Privacy and evidence

The database retains the provider event id and processing time through the existing `StripeEvent` receipt. It does not retain the raw webhook payload, payment details, exception text, or Daytona data. API responses expose only bounded states: `applied`, `ignored`, `rejected`, or `deduped`.

## Verification added by this change

- paid invoices require an explicit period and advance entitlement once;
- failed renewals require an affected provider period;
- first-payment failure cannot grant access;
- grace does not compound;
- delayed/non-advancing events are ignored at the transaction boundary;
- receipt insertion and entitlement mutation are one atomic transaction;
- transient failure rolls the receipt back so provider redelivery remains possible;
- unsupported events have no entitlement side effect.

Required gates:

```sh
pnpm db:check
pnpm check
pnpm typecheck
pnpm test:unit
pnpm build
```

## Remaining #49 / #51 gates

1. Implement a bounded reconciliation command/job that compares local normalized entitlement with Stripe by internal account mapping and emits an audited receipt.
2. Define and test refund, chargeback, trial, cancellation, past-due, provider-unavailable, support override, and mid-run transition policy.
3. Add database-backed browser fixtures satisfying current `authVersion` revalidation without bypasses.
4. Run duplicate, delayed, out-of-order, crash/restart, tenant-conflict, and provider-outage E2E against real Postgres and a Stripe test environment.
5. Prove that every ineligible, unknown, and revoked state refuses usage reservation, credential lease, run authorization, and Daytona dispatch before provider side effects.
