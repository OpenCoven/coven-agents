# Pack draw ledger cutover

## Correction note

As of 2026-11-23, the repository implementation described by this historical proposal has landed through [#317](https://github.com/OpenCoven/coven-agents/pull/317) and [#318](https://github.com/OpenCoven/coven-agents/pull/318); #225 and #226 are closed at the repository boundary. The candidate language below is retained as history and grants no deployment authority. Current cutover approval and rollback requirements are governed by [release readiness](../roadmap/release-readiness.md#database-migration), with dated source verification in the [verification matrix](../roadmap/verification-matrix.md#billing-ledger-checkpoint). Production customer reconciliation and migration remain separately gated.


Refs #225 and #226; delivery continues in PR #276. The owner approved explicit account-keyed draws and coordination of the shared schema/migration paths. This document describes a candidate, not production acceptance.

`RunPackDraw` records each authenticated reservation's pack allocation by account ID and run ID. A reserved run holds the recorded amount; a consumed run charges it. Release, expiry and confirmed prelaunch compensation stop counting that allocation. Terminal settlement lowers only that run's draw by the unused portion, in the same transaction as the measured charge. Other runs are never repriced after a cap edit, refund, or abuse-secret rotation. Monthly account usage also follows the ledger owner when optional reservation audit metadata is absent.

The existing usage response preserves its period allowance: `tenantPackMinutes` subtracts allocations from other periods, while `tenantMonthlyRemaining` additionally includes current-period bucket usage and pack holds. Admission uses the lifetime unallocated pack balance, so the response does not permit the same pack to be spent twice.

## Migration order and owner gates

Billing follows the runner migrations in this candidate. The account and cap audit columns are added by 0048. The explicit account-keyed draw ledger follows in 0049. Both snapshots were generated against the runner chain through 0047. Verify that this prerequisite is present on the actual landing base before applying this chain.

Migration 0049 deliberately refuses when any recorded pack purchase coexists with consumed/reserved reservations or legacy usage. Historical caps and pre-rotation account associations were not recorded, so deriving an opening balance from today's cap, the current HMAC, or a zero default would corrupt paid balances. The refusal changes no balance and does not certify that an existing obligation has been reconciled.

Before deployment, the authorized owner must inventory existing purchases, pending payments, historical usage and customer obligations, and obtain reviewed reconciliation evidence for every affected account. There is no automatic backfill, direct entitlement repair command, or migration bypass in this candidate. If the guard refuses, retain the existing service and resolve the accounting migration under a separate reviewed owner-controlled plan. Do not delete purchases or historical usage to make the guard pass.

Use an authorized maintenance window: stop all old admission and settlement writers, drain active reservations and uncertain cleanup, apply the reviewed migration chain with `pnpm db:migrate --strict`, and start only ledger-aware code. A mixed deployment with writers that do not record draws is unsupported. Verify the ledger-aware writer and exact candidate before accepting the rollout. Local synthetic tests prove neither existing customer reconciliation nor production behavior.

## Rollback

Before ledger-aware traffic, a failed migration is transactional and leaves the prior schema and balances intact. After any draw has been written, preserve the ledger and stop admission if rollback is needed; do not restart an old writer, drop the ledger, recompute balances, or remove migrations. Returning to the old accounting code requires a separately reviewed reconciliation/rollback plan. This work grants no deployment, migration, merge or release authority.
