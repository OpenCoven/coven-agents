# Subscriptions: One Price, One Cap

**Status:** design, approved 2026-08-24
**Scope:** spec 3 of 3. Spec 1 is merged; spec 2 is specced and planned.

## Why this exists

Spec 1 built everything a paywall needs except the payment. `subscribedUntil`
is a nullable timestamp on `User`, `isSubscribedAt` and `userTypeFor` are
tested and fail closed, and `entitlementsByPlan` separates `demo` from
`subscriber`. Nothing writes that column except a human running
`pnpm subscription grant`.

That bootstrap exists because billing did not, and without a subscriber nobody
can store a harness credential, which means nobody can run an agent at all.
This spec replaces the human with Stripe. It writes the same column, so the
bootstrap is a stopgap in *who calls it*, not in *what it writes* — and it
stays afterwards, because granting a comp account by hand is a legitimate
thing to want.

## The shape, and why not the alternatives

**One flat monthly price with a published, enforced run cap.**

Not metered billing. It needs durable run counting, usage reported to Stripe,
and answers to questions with no good answers — does a failed run bill, does a
cancelled one, what happens when the sandbox dies halfway. It also makes the
pricing page hard to read, which is its own cost for a product nobody has
heard of yet.

Not per-seat. Tenants are individual users; there is no organisation model, and
inventing one to price against would pull a whole other spec forward.

**But not "unlimited" either.** The cost driver here is sandbox compute.
Tenants bring their own agent credentials, so a heavy user costs real money at
no additional revenue. "Unlimited" is a promise that would eventually have to
be broken, and breaking it later is worse than bounding it now.

So: one price, `MONTHLY_RUN_CAP` runs a month, stated before purchase and
enforced server-side.

**Counting is the part that leaves room.** A cap needs a durable run counter
regardless of how billing works. Once runs are counted, adding metered overage
later is a change to what happens *at* the cap rather than a rewrite. That is
the forward compatibility: build the counter now, defer the billing model it
would enable.

## What is deliberately not built

**No free trial.** Demo mode is the trial and it costs nothing to run. A trial
would grant a subscriber session — and therefore database writes and credential
storage — to someone who has paid nothing, which weakens the
paid-equals-subscriber invariant the whole of spec 1 rests on.

**A short grace period on payment failure, and only that.** Stripe retries a
failed card over roughly two weeks. Without grace, an expired card locks a
paying customer out mid-run. `GRACE_PERIOD_DAYS` is a bounded, deliberate
window of unpaid access, chosen because that failure is worse for them than the
window is for us.

## Values set at launch

Three constants, all in one place:

```
STRIPE_PRICE_ID     the Stripe price the checkout session uses
MONTHLY_RUN_CAP     runs included per billing period
GRACE_PERIOD_DAYS   days of access after a failed payment (3)
```

The price and the cap are commercial decisions and are not proposed here. They
belong in configuration, not scattered through code, because the cap is quoted
to the user in three places and they must not be able to disagree.

## Architecture

```
Subscribe
  /pricing  ──▶ POST /api/checkout ──▶ Stripe Checkout (hosted)
                                          │
                                          ▼
                              Stripe ──webhook──▶ /api/stripe/webhook
                                                    verify signature
                                                    dedupe by event id
                                                    subscribedUntil = period_end

Run
  worker ──▶ /api/internal/credential { tenant, harnessId, runId }
               │
               ├─ not a subscriber        → 403
               ├─ over MONTHLY_RUN_CAP    → 429
               └─ otherwise: count the run, lend the credential
```

**The cap is enforced where the credential is lent.** The worker already
fetches a credential per run from an endpoint the app owns, and the app owns the
database. That call is the only place where tenancy, subscription state and a
database handle already meet, so enforcing there adds no new coupling and no new
round trip. It also inherits the existing behaviour: a run that cannot get a
credential is refused, and that path is already tested.

The worker never counts anything and never learns the cap. It asks for a
credential and is told yes or no, which keeps the worker's view of a tenant
exactly as narrow as spec 1 made it.

## Counting a run once

`/api/internal/credential` gains `runId` and records a row per
`(tenant, runId)` with a unique constraint. A retried credential fetch for the
same run finds the existing row and does not count again.

The worker already has the id to send: `driveHarness` receives the planned
`CloudRunRecord`, so the value is `planned.run.id`. Today the request body is
`{ harnessId, tenant }` — this adds a third field and changes nothing else
about the call.

This matters because the worker may legitimately fetch more than once — a
retried start, a resumed stream — and a counter that increments per fetch would
bill a user for the runner's internal behaviour. The unique constraint makes
double counting impossible rather than unlikely.

The period a run counts against is derived from `subscribedUntil` minus one
billing interval, not from the calendar month. A subscription that starts on
the 20th resets on the 20th, which is what the customer's card statement will
say.

## Transparency

Three places must agree, and they read the same constant:

- **Before purchase.** The pricing page states the cap in the same breath as
  the price. A cap discovered at the limit is a broken promise regardless of
  whether it was technically disclosed.
- **While it accrues.** Usage is visible in the app — "17 of 200 runs this
  period" — because a cap you cannot see is indistinguishable from a bug.
- **At the limit.** Refusal says what happened, what the cap is, and when it
  resets. Not a generic error, and not a silent hang.

`GET /api/usage` returns `{ used, cap, resetsAt }` for the signed-in tenant.
The number shown in the UI and the number enforced at credential lending come
from the same query, so they cannot drift.

## Sanity checks

These are the ones whose absence is invisible until it matters:

- **Verify the webhook signature.** An unverified endpoint that writes
  `subscribedUntil` is a free subscription for anyone who can POST to it.
- **Dedupe by Stripe event id.** Stripe retries. A replayed
  `invoice.paid` must not extend a subscription twice, so processed event ids
  are recorded and re-processing is a no-op.
- **Never trust a client-supplied plan.** The plan claim is minted from
  `subscribedUntil` server-side, as spec 1 established.
- **Enforce the cap server-side.** The UI shows usage; the credential endpoint
  decides. A client that lies about its usage gets nothing.
- **Refuse to start if the cap query fails.** An error reading usage is not
  permission to exceed the cap.

## Failure modes

| Situation | Behaviour |
| --- | --- |
| Webhook arrives twice | Deduped by event id; the second is a no-op. |
| Webhook signature invalid | 400, nothing written, logged. |
| Payment fails | `subscribedUntil` extended by `GRACE_PERIOD_DAYS` once; Stripe dunning continues. A second failure does not extend again. |
| Subscription cancelled | Nothing is revoked. Access ends when `subscribedUntil` passes, which is the period already paid for. |
| Cap reached mid-period | New runs refused with a reason and a reset date. Runs already in flight finish. |
| Usage query fails | The run is refused. An unreadable counter is not an allowance. |
| Stripe unreachable at checkout | Checkout fails visibly; no subscription state changes. |
| A user subscribes twice | The unique constraint on the Stripe customer id refuses the second. |

## Testing

The properties worth pinning are the ones that lose money or trust silently:

- **A replayed webhook does not extend a subscription.** Assert by processing
  the same event twice and comparing `subscribedUntil`.
- **An unsigned webhook writes nothing.** The failure mode is a free
  subscription, so this is asserted against the handler, not the framework.
- **The cap is enforced at lending, not only displayed.** Assert that a tenant
  over cap is refused a credential even when the UI would have shown them
  under it.
- **A retried credential fetch for the same run counts once.** Assert the
  counter after two fetches with the same `runId`.
- **A failed usage query refuses the run.** The dangerous default is to allow.
- **Grace is applied once.** Two consecutive failures must not compound into a
  fortnight of free access.
- **The cap shown and the cap enforced are the same number.** They are read
  from one constant; assert that rather than assuming it.

Every one gets a mutation test. Delete the guard, watch the suite fail, restore
— and confirm the mutation actually applied before believing the result, which
has produced false passes twice in this project.

## Rollout

1. Add the Stripe dependency, `STRIPE_PRICE_ID`, and the constants. Inert.
2. Add the run counter and `GET /api/usage`. Nothing enforces yet; usage is
   observable before it is binding, so a wrong counter is visible before it
   refuses anyone.
3. Enforce the cap at credential lending.
4. Add checkout and the webhook.
5. Publish the pricing page.

Steps 1–2 change no behaviour. Step 3 is the first that can refuse a run, and
it is deliberately before step 4 so the cap is exercised by the bootstrap
accounts before a paying customer meets it.

## Deferred

- **Metered overage.** The counter this spec builds is what would make it
  small. Deliberately not now: it needs a defensible answer for failed and
  cancelled runs, and a pricing page that is still readable.
- **Teams and seats.** Needs an organisation model. Tenants are individual
  users today.
- **Proration and plan changes.** One price means there is nothing to change
  between.
- **Invoicing and tax.** Stripe Checkout handles what it handles; anything
  beyond that is a real project.
