# Subscriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `pnpm subscription grant` with Stripe, and enforce a published run cap where the credential is lent.

**Architecture:** Stripe Checkout creates or reuses one Customer per user; a signature-verified, idempotent webhook writes `subscribedUntil`. Runs are counted per `(tenant, runId)` at `/api/internal/credential`, which already has a verified subscriber claim, and the cap is enforced there.

**Tech Stack:** Stripe Node SDK, Zod, Drizzle, Next.js 16, `tsx --test` with `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-24-subscriptions-design.md`

---

## Shapes this plan depends on

Verified against the source before writing, because the two previous plans each
asserted field names that did not exist:

```ts
// lib/db/schema.ts — User columns today
createdAt, email, emailVerified, id, image, isAnonymous, name, password,
subscribedUntil, updatedAt

// already imported in schema.ts
boolean, json, text, timestamp, uniqueIndex, uuid, varchar

// lib/subscription.ts
isSubscribedAt(user: { subscribedUntil?: Date | null }, now: Date): boolean
userTypeFor(user: { subscribedUntil?: Date | null }, now: Date): "demo" | "subscriber"

// lib/credentials/store.ts
readCredentialForTenant(tenant, harnessId, db): Promise<string | null>

// app/api/internal/credential/binding.ts   (shipped in #58)
resolveBoundTenant(claims, body, { strict }): string | null   // null unless plan === "subscriber"
```

**What #58 already shipped**, so this plan builds on it rather than proposing
it: the tenant comes from a verified identity claim rather than the request
body, and a non-subscriber claim is already refused both at the credential
endpoint and before a run starts. The cap is the only new gate.

## Constants set at launch

```
STRIPE_PRICE_ID       env, the $25/month recurring price
STRIPE_SECRET_KEY     env
STRIPE_WEBHOOK_SECRET env
MONTHLY_RUN_CAP  750   lib/billing/limits.ts
GRACE_PERIOD_DAYS     lib/billing/limits.ts (3)
```

**Decided:** `$25/month`, `MONTHLY_RUN_CAP = 750` runs per billing period —
about 25 a day. At the worst-case sandbox profile 750 fully-utilised runs are
roughly $1.70 of raw container cost, so the margin survives payment fees while
the cap is high enough that a daily user never thinks about it.

`STRIPE_PRICE_ID` is whatever price object the $25 recurring product gets in
Stripe; it is env, not code.

Task 2 still puts the cap in one file, because the pricing page, the usage
endpoint and the enforcement point must not be able to disagree.

**No launch add-ons.** One portable plan, one cap, bring your own Copilot /
Claude / Codex credential. The first add-on, if usage justifies one, should be
a prepaid 250-run pack at $10 that expires with the billing period — it keeps
the margin and, unlike metered overage, cannot produce a surprise bill.
Priority execution, extra concurrency, retention, teams and metered billing all
wait for evidence of demand.

## File structure

| File | Responsibility |
| --- | --- |
| `lib/billing/limits.ts` (create) | `MONTHLY_RUN_CAP`, `GRACE_PERIOD_DAYS`. One place, three readers. |
| `lib/billing/period.ts` (create) | `periodStart` — which billing period a run counts against. |
| `lib/billing/grace.ts` (create) | `graceExtension` — decides whether a failed invoice extends anything. |
| `lib/db/schema.ts` (modify) | `stripeCustomerId`, `stripeSubscriptionId` on `User`; `RunUsage` and `StripeEvent` tables. |
| `lib/billing/usage.ts` (create) | `countRun`, `usageFor`. The counter and its reader. |
| `app/api/usage/route.ts` (create) | `GET` → `{ used, cap, resetsAt }`. |
| `app/api/internal/credential/route.ts` (modify) | Count the run; refuse over cap with a structured 429. |
| `worker/src/tenant-credentials.ts` (modify) | Parse the 429 body into `CapReachedError`. |
| `worker/src/agents.ts` (modify) | Record a cap refusal as a distinct terminal reason. |
| `app/api/checkout/route.ts` (create) | Create or reuse a Customer; refuse if already active. |
| `app/api/stripe/webhook/route.ts` (create) | Verify, dedupe, write `subscribedUntil`. |

---

### Task 1: Billing period arithmetic

**Files:**
- Create: `lib/billing/period.ts`
- Create: `lib/billing/period.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/billing/period.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { periodStart } from "./period";

const UNTIL = new Date("2026-09-20T12:00:00.000Z");

test("the period runs back one month from the renewal date", () => {
  // Not the calendar month. A subscription starting on the 20th resets on the
  // 20th, which is what the customer's card statement will say.
  assert.equal(
    periodStart(UNTIL).toISOString(),
    "2026-08-20T12:00:00.000Z"
  );
});

test("a renewal on the 31st steps back to a month that has one", () => {
  // 31 March back one month is not 31 February. Date arithmetic that lands on
  // an impossible day silently rolls forward, which would shorten the period
  // and undercount usage.
  const start = periodStart(new Date("2026-03-31T00:00:00.000Z"));

  assert.ok(start < new Date("2026-03-31T00:00:00.000Z"));
  assert.equal(start.getUTCMonth(), 1, "February");
  assert.ok(start.getUTCDate() <= 29);
});

test("no subscription has no period", () => {
  assert.equal(periodStart(null), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `corepack pnpm exec tsx --conditions=react-server --test lib/billing/period.test.ts`
Expected: FAIL with `Cannot find module './period'`

- [ ] **Step 3: Write the implementation**

Create `lib/billing/period.ts`:

```ts
/**
 * The start of the billing period a run counts against.
 *
 * Derived from the renewal date rather than the calendar month, because a
 * subscription that starts on the 20th resets on the 20th and that is what the
 * customer's statement says.
 *
 * Stepping back a month is clamped to the last valid day, because JavaScript
 * rolls an impossible date forward — 31 March minus one month becomes 3 March
 * — which would shorten the period and undercount usage in the customer's
 * favour but wrongly.
 */
export function periodStart(subscribedUntil: Date | null): Date | null {
  if (!subscribedUntil) {
    return null;
  }

  const start = new Date(subscribedUntil.getTime());
  const day = start.getUTCDate();
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth() - 1);

  const lastDayOfMonth = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)
  ).getUTCDate();
  start.setUTCDate(Math.min(day, lastDayOfMonth));

  return start;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `corepack pnpm exec tsx --conditions=react-server --test lib/billing/period.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Mutation-test the clamp**

Remove the `setUTCDate(1)` line so the month is stepped back without clamping.

Run. Expected: FAIL on "a renewal on the 31st steps back to a month that has one".

Restore and confirm green.

- [ ] **Step 6: Commit**

```bash
git add lib/billing/period.ts lib/billing/period.test.ts
git commit -S -m "feat(billing): derive the billing period from the renewal date"
```

---

### Task 2: The cap constant

**Files:**
- Create: `lib/billing/limits.ts`
- Create: `lib/billing/limits.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/billing/limits.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { GRACE_PERIOD_DAYS, MONTHLY_RUN_CAP } from "./limits";

test("the cap is a positive whole number of runs", () => {
  // Quoted to the user in three places. A fractional or zero cap would be
  // shown verbatim on a pricing page.
  assert.ok(Number.isInteger(MONTHLY_RUN_CAP));
  assert.ok(MONTHLY_RUN_CAP > 0);
});

test("grace is bounded", () => {
  // A deliberate window of unpaid access. Unbounded grace is a free tier
  // nobody decided to offer.
  assert.ok(Number.isInteger(GRACE_PERIOD_DAYS));
  assert.ok(GRACE_PERIOD_DAYS > 0 && GRACE_PERIOD_DAYS <= 7);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `corepack pnpm exec tsx --conditions=react-server --test lib/billing/limits.test.ts`
Expected: FAIL with `Cannot find module './limits'`

- [ ] **Step 3: Write the implementation**

Create `lib/billing/limits.ts`:

```ts
/**
 * Runs included in a billing period.
 *
 * One constant, read by the pricing page, the usage endpoint and the
 * enforcement point. A cap quoted in three places that can disagree is worse
 * than no cap, because two of them will be a lie.
 *
 * The value is a commercial decision. Change it here.
 */
export const MONTHLY_RUN_CAP = 750;

/**
 * Days of access granted after a failed *renewal*, once.
 *
 * Stripe retries a failed card over roughly two weeks; without this an expired
 * card locks a paying customer out mid-run. Never applied to a first payment —
 * see `graceExtension`.
 */
export const GRACE_PERIOD_DAYS = 3;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `corepack pnpm exec tsx --conditions=react-server --test lib/billing/limits.test.ts`
Expected: PASS, 2 tests

- [ ] **Step 5: Commit**

```bash
git add lib/billing/limits.ts lib/billing/limits.test.ts
git commit -S -m "feat(billing): put the run cap and grace window in one place"
```

---

### Task 3: Grace only on a renewal

**Files:**
- Create: `lib/billing/grace.ts`
- Create: `lib/billing/grace.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/billing/grace.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { GRACE_PERIOD_DAYS } from "./limits";
import { graceExtension } from "./grace";

const PAID_UNTIL = new Date("2026-09-20T12:00:00.000Z");

test("a failed renewal extends once", () => {
  const extended = graceExtension({
    billingReason: "subscription_cycle",
    graceAlreadyApplied: false,
    subscribedUntil: PAID_UNTIL,
  });

  assert.ok(extended);
  assert.equal(
    extended.getTime() - PAID_UNTIL.getTime(),
    GRACE_PERIOD_DAYS * 86_400_000
  );
});

test("a failed FIRST payment grants nothing", () => {
  // The one that would hand out free subscriptions. Extending after a failed
  // subscription_create gives a subscriber session — database writes and
  // credential storage — to someone who has never paid, contradicting the
  // no-trial invariant the spec states directly.
  assert.equal(
    graceExtension({
      billingReason: "subscription_create",
      graceAlreadyApplied: false,
      subscribedUntil: null,
    }),
    null
  );
});

test("a renewal failure with no paid period behind it grants nothing", () => {
  // Defence in depth: `subscription_cycle` with a null date should not happen,
  // and if it does it must not become an extension from nowhere.
  assert.equal(
    graceExtension({
      billingReason: "subscription_cycle",
      graceAlreadyApplied: false,
      subscribedUntil: null,
    }),
    null
  );
});

test("grace does not compound", () => {
  // Two consecutive failures must not become a fortnight of free access.
  assert.equal(
    graceExtension({
      billingReason: "subscription_cycle",
      graceAlreadyApplied: true,
      subscribedUntil: PAID_UNTIL,
    }),
    null
  );
});

test("an unknown billing reason grants nothing", () => {
  for (const billingReason of ["manual", "subscription_update", ""]) {
    assert.equal(
      graceExtension({
        billingReason,
        graceAlreadyApplied: false,
        subscribedUntil: PAID_UNTIL,
      }),
      null,
      `${JSON.stringify(billingReason)} must not extend`
    );
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `corepack pnpm exec tsx --conditions=react-server --test lib/billing/grace.test.ts`
Expected: FAIL with `Cannot find module './grace'`

- [ ] **Step 3: Write the implementation**

Create `lib/billing/grace.ts`:

```ts
import { GRACE_PERIOD_DAYS } from "./limits";

const DAY_MS = 86_400_000;

export type GraceInput = {
  billingReason: string;
  graceAlreadyApplied: boolean;
  subscribedUntil: Date | null;
};

/**
 * The new `subscribedUntil` after a failed invoice, or null for no change.
 *
 * Allow-listed on `subscription_cycle` rather than excluding
 * `subscription_create`, because a new billing reason added by Stripe should
 * default to granting nothing. An exclusion list would silently admit it.
 *
 * A renewal is by definition an extension of a period already paid for, so a
 * null `subscribedUntil` is refused even when the reason looks right: there is
 * nothing to extend, and extending from `now` would be a free subscription.
 */
export function graceExtension(input: GraceInput): Date | null {
  if (input.billingReason !== "subscription_cycle") {
    return null;
  }
  if (input.graceAlreadyApplied) {
    return null;
  }
  if (!input.subscribedUntil) {
    return null;
  }

  return new Date(input.subscribedUntil.getTime() + GRACE_PERIOD_DAYS * DAY_MS);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `corepack pnpm exec tsx --conditions=react-server --test lib/billing/grace.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Mutation-test each guard**

| Mutation | Must fail |
| --- | --- |
| Accept any billing reason (`if (false)` on the first check) | "a failed FIRST payment grants nothing" and "an unknown billing reason grants nothing" |
| Ignore `graceAlreadyApplied` | "grace does not compound" |
| Extend from `new Date()` when `subscribedUntil` is null | "a renewal failure with no paid period behind it grants nothing" |

Restore after each. The first is the one that hands out free subscriptions; if
it does not fail, stop and report.

- [ ] **Step 6: Commit**

```bash
git add lib/billing/grace.ts lib/billing/grace.test.ts
git commit -S -m "feat(billing): grant grace only on a failed renewal"
```

---

### Task 4: Schema for usage, Stripe identity and event dedupe

**Files:**
- Modify: `lib/db/schema.ts`
- Create: migration via `pnpm db:generate`

- [ ] **Step 1: Add the columns and tables**

In `lib/db/schema.ts`, add to the `user` table, keeping keys alphabetical:

```ts
  stripeCustomerId: varchar("stripeCustomerId", { length: 64 }),
  stripeSubscriptionId: varchar("stripeSubscriptionId", { length: 64 }),
```

Then append two tables:

```ts
/**
 * One row per counted run.
 *
 * The unique index is the counter's correctness, not an optimisation. The
 * worker may fetch a credential more than once for one run — a retried start,
 * a resumed stream — and counting per fetch would bill a customer for the
 * runner's internal behaviour.
 */
export const runUsage = pgTable(
  "RunUsage",
  {
    countedAt: timestamp("countedAt").notNull().defaultNow(),
    id: uuid("id").primaryKey().notNull().defaultRandom(),
    runId: varchar("runId", { length: 64 }).notNull(),
    tenant: varchar("tenant", { length: 64 }).notNull(),
  },
  (table) => [
    uniqueIndex("RunUsage_tenant_run_idx").on(table.tenant, table.runId),
  ]
);

export type RunUsage = InferSelectModel<typeof runUsage>;

/**
 * Stripe event ids already processed.
 *
 * Stripe retries delivery, so a replayed `invoice.paid` would otherwise extend
 * a subscription twice. The primary key is the event id: inserting is the
 * idempotency check, not a lookup that races with a second delivery.
 */
export const stripeEvent = pgTable("StripeEvent", {
  id: varchar("id", { length: 64 }).primaryKey().notNull(),
  processedAt: timestamp("processedAt").notNull().defaultNow(),
});

export type StripeEvent = InferSelectModel<typeof stripeEvent>;
```

Add a unique index on `stripeCustomerId` by appending to the `user` table
definition's second argument. If `user` currently has no second argument,
convert it:

```ts
export const user = pgTable(
  "User",
  {
    /* existing columns, plus the two above */
  },
  (table) => [
    uniqueIndex("User_stripeCustomerId_idx").on(table.stripeCustomerId),
  ]
);
```

One Stripe customer belongs to one user. This does **not** forbid a second
subscription — that is Task 8's job, and conflating them would reject a
legitimate cancel-then-resubscribe, which reuses the same Customer.

- [ ] **Step 2: Generate the migration**

Run: `corepack pnpm db:generate`
Expected: a new file under `lib/db/migrations/`.

**Inspect it before applying.** `meta/0000_snapshot.json` is absent from this
repository, so a generate can emit the entire schema rather than a diff — that
happened when `TenantCredential` was added, and applying it failed on
`relation "Chat" already exists`. If the generated SQL contains `CREATE TABLE`
for anything other than `RunUsage` and `StripeEvent`, trim it to the new
objects only.

- [ ] **Step 3: Apply and verify**

```bash
corepack pnpm db:migrate
docker exec coven-pg psql -U postgres -d coven -c '\d "RunUsage"'
docker exec coven-pg psql -U postgres -d coven -tAc "select indexname from pg_indexes where tablename='RunUsage';"
```

Expected: the table exists and `RunUsage_tenant_run_idx` is listed.

- [ ] **Step 4: Prove the unique index enforces**

```bash
docker exec coven-pg psql -U postgres -d coven -c "insert into \"RunUsage\" (tenant,\"runId\") values ('acme','run-1');"
docker exec coven-pg psql -U postgres -d coven -c "insert into \"RunUsage\" (tenant,\"runId\") values ('acme','run-1');"
docker exec coven-pg psql -U postgres -d coven -c "insert into \"RunUsage\" (tenant,\"runId\") values ('acme','run-2');"
docker exec coven-pg psql -U postgres -d coven -c 'delete from "RunUsage";'
```

Expected: first succeeds, second fails with `duplicate key value violates unique constraint`, third succeeds.

- [ ] **Step 5: Commit**

```bash
git add lib/db/schema.ts lib/db/migrations
git commit -S -m "feat(db): add run usage, Stripe identity and event dedupe"
```

---

### Task 5: Counting and reading usage

**Files:**
- Create: `lib/billing/usage.ts`
- Create: `lib/billing/usage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/billing/usage.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { runUsage } from "@/lib/db/schema";
import { usageWhere } from "./usage";

const SINCE = new Date("2026-08-20T12:00:00.000Z");

function sqlFor(tenant: string, since: Date) {
  return new QueryBuilder()
    .select()
    .from(runUsage)
    .where(usageWhere(tenant, since))
    .toSQL();
}

test("usage is scoped to one tenant and one period", () => {
  // Dropping either condition is invisible to an outcome-based test: the query
  // still returns a count, just the wrong one. Counting across tenants would
  // charge a customer for someone else's runs; counting across periods would
  // never reset.
  const { params, sql } = sqlFor("acme", SINCE);

  assert.ok(sql.includes('"tenant"'), "must filter on tenant");
  assert.ok(sql.includes('"countedAt"'), "must filter on the period");
  assert.deepEqual(params, ["acme", SINCE]);
});

test("both conditions are required, not either", () => {
  const { sql } = sqlFor("acme", SINCE);

  assert.ok(sql.includes(" and "), "conditions must be conjunctive");
  assert.ok(!sql.includes(" or "), "an OR would count another tenant's runs");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `corepack pnpm exec tsx --conditions=react-server --test lib/billing/usage.test.ts`
Expected: FAIL with `Cannot find module './usage'`

- [ ] **Step 3: Write the implementation**

Create `lib/billing/usage.ts`:

```ts
import { and, count, eq, gte } from "drizzle-orm";
import type { databaseFor } from "@/lib/db/access";
import { runUsage } from "@/lib/db/schema";

/**
 * Scopes a usage count to one tenant and one billing period.
 *
 * Extracted so the scoping can be asserted without a database. Dropping either
 * condition still returns a number — the wrong one — which no outcome-based
 * test would notice.
 */
export function usageWhere(tenant: string, since: Date) {
  return and(eq(runUsage.tenant, tenant), gte(runUsage.countedAt, since));
}

/**
 * Records a run, returning whether it was newly counted.
 *
 * The unique index does the deduplication. `onConflictDoNothing` means a
 * repeated fetch for the same run is a no-op rather than a second charge, and
 * the row count tells the caller which happened without a second query.
 */
export async function countRun(
  db: ReturnType<typeof databaseFor>,
  tenant: string,
  runId: string
): Promise<boolean> {
  const inserted = await db
    .insert(runUsage)
    .values({ runId, tenant })
    .onConflictDoNothing()
    .returning({ id: runUsage.id });

  return inserted.length > 0;
}

export async function usageFor(
  db: ReturnType<typeof databaseFor>,
  tenant: string,
  since: Date
): Promise<number> {
  const [row] = await db
    .select({ used: count() })
    .from(runUsage)
    .where(usageWhere(tenant, since));

  return row?.used ?? 0;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `corepack pnpm exec tsx --conditions=react-server --test lib/billing/usage.test.ts`
Expected: PASS, 2 tests

- [ ] **Step 5: Mutation-test the scoping**

Drop the `gte(runUsage.countedAt, since)` term. Run. Expected: FAIL on both tests.

Change `and` to `or` (import it). Run. Expected: FAIL on "both conditions are required, not either".

Restore after each.

- [ ] **Step 6: Commit**

```bash
git add lib/billing/usage.ts lib/billing/usage.test.ts
git commit -S -m "feat(billing): count runs once per tenant and period"
```

---

### Task 6: Enforce the cap where the credential is lent

**Files:**
- Modify: `app/api/internal/credential/route.ts`
- Create: `app/api/internal/credential/cap.ts`
- Create: `app/api/internal/credential/cap.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/api/internal/credential/cap.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { MONTHLY_RUN_CAP } from "@/lib/billing/limits";
import { capVerdict } from "./cap";

const RESETS = new Date("2026-09-20T12:00:00.000Z");

test("under the cap is allowed", () => {
  const verdict = capVerdict({ resetsAt: RESETS, used: MONTHLY_RUN_CAP - 1 });

  assert.equal(verdict.kind, "allowed");
});

test("at the cap is refused", () => {
  // The boundary has to fall one way. At the cap means the included runs are
  // spent, which is what "750 runs included" says.
  const verdict = capVerdict({ resetsAt: RESETS, used: MONTHLY_RUN_CAP });

  assert.equal(verdict.kind, "refused");
});

test("a refusal carries what the caller needs to explain it", () => {
  const verdict = capVerdict({ resetsAt: RESETS, used: MONTHLY_RUN_CAP });

  assert.equal(verdict.kind, "refused");
  if (verdict.kind === "refused") {
    assert.equal(verdict.cap, MONTHLY_RUN_CAP);
    assert.equal(verdict.used, MONTHLY_RUN_CAP);
    assert.equal(verdict.resetsAt, RESETS.toISOString());
  }
});

test("an unknown period refuses rather than allowing", () => {
  // An error reading usage is not permission to exceed the cap. The dangerous
  // default here is to allow.
  const verdict = capVerdict({ resetsAt: null, used: 0 });

  assert.equal(verdict.kind, "refused");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `corepack pnpm exec tsx --conditions=react-server --test "app/api/internal/credential/cap.test.ts"`
Expected: FAIL with `Cannot find module './cap'`

- [ ] **Step 3: Write the implementation**

Create `app/api/internal/credential/cap.ts`:

```ts
import { MONTHLY_RUN_CAP } from "@/lib/billing/limits";

export type CapVerdict =
  | { cap: number; kind: "refused"; resetsAt: string | null; used: number }
  | { kind: "allowed" };

/**
 * Decides whether another run fits inside the period's cap.
 *
 * A pure function rather than logic inside the handler, because this decides
 * whether a paying customer can work and route-handler logic is unreachable by
 * a unit test.
 *
 * Fails closed on an unknown period: an error reading usage is not permission
 * to exceed the cap, and allowing on error is how a cap quietly stops existing.
 */
export function capVerdict(input: {
  resetsAt: Date | null;
  used: number;
}): CapVerdict {
  if (!input.resetsAt) {
    return { cap: MONTHLY_RUN_CAP, kind: "refused", resetsAt: null, used: input.used };
  }
  if (input.used >= MONTHLY_RUN_CAP) {
    return {
      cap: MONTHLY_RUN_CAP,
      kind: "refused",
      resetsAt: input.resetsAt.toISOString(),
      used: input.used,
    };
  }
  return { kind: "allowed" };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `corepack pnpm exec tsx --conditions=react-server --test "app/api/internal/credential/cap.test.ts"`
Expected: PASS, 4 tests

- [ ] **Step 5: Wire it into the route**

In `app/api/internal/credential/route.ts`, after `tenant` is resolved and before
`readCredentialForTenant`, add:

```ts
  const { runId } = body ?? {};
  if (typeof runId !== "string" || !runId) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const [owner] = await db
    .select()
    .from(user)
    .where(eq(user.id, claims.sub))
    .limit(1);
  const resetsAt = owner?.subscribedUntil ?? null;
  const since = periodStart(resetsAt);

  const verdict = capVerdict({
    resetsAt,
    used: since ? await usageFor(db, tenant, since) : 0,
  });

  if (verdict.kind === "refused") {
    return Response.json(
      {
        cap: verdict.cap,
        error: "cap_reached",
        resetsAt: verdict.resetsAt,
        used: verdict.used,
      },
      { status: 429 }
    );
  }

  // Counted before the credential is handed over, so a run that starts is a
  // run that was paid for. Counting afterwards would let a crash between the
  // two produce free runs.
  await countRun(db, tenant, runId);
```

Add the imports:

```ts
import { eq } from "drizzle-orm";
import { periodStart } from "@/lib/billing/period";
import { countRun, usageFor } from "@/lib/billing/usage";
import { user } from "@/lib/db/schema";
import { capVerdict } from "./cap";
```

- [ ] **Step 6: Verify**

```bash
corepack pnpm check
corepack pnpm typecheck
corepack pnpm test:unit
```

Expected: all pass.

- [ ] **Step 7: Mutation-test the enforcement**

Change `input.used >= MONTHLY_RUN_CAP` to `>`. Run the cap tests. Expected: FAIL on "at the cap is refused". Restore.

Make the unknown-period branch return `{ kind: "allowed" }`. Run. Expected: FAIL on "an unknown period refuses rather than allowing". Restore.

- [ ] **Step 8: Commit**

```bash
git add app/api/internal/credential/cap.ts app/api/internal/credential/cap.test.ts app/api/internal/credential/route.ts
git commit -S -m "feat(billing): enforce the run cap where the credential is lent"
```

---

### Task 7: Carry the cap refusal back to the user

**Files:**
- Modify: `worker/src/tenant-credentials.ts`
- Modify: `worker/src/tenant-credentials.test.ts`

Without this the cap message does not reach anyone: `fetchTenantCredential`
discards the body for every non-404 status and throws with only the number, and
`driveHarness` records that as a generic failure. A 429 would surface as a
failed run with no cap, no reset date and no reason.

- [ ] **Step 1: Write the failing test**

Add to `worker/src/tenant-credentials.test.ts`:

```ts
test("a cap refusal arrives as a cap, not as a generic failure", async () => {
  // The body is discarded for every non-404 status, so without parsing it here
  // the user sees "run failed" and nothing about a cap or a reset date.
  await assert.rejects(
    () =>
      fetchTenantCredential(
        { harnessId: "copilot", runId: "run-1", tenant: "acme" },
        {
          endpoint: "https://app.test",
          fetchImpl: () =>
            Promise.resolve(
              new Response(
                JSON.stringify({
                  cap: 200,
                  error: "cap_reached",
                  resetsAt: "2026-09-20T12:00:00.000Z",
                  used: 200,
                }),
                { status: 429 }
              )
            ),
          identityToken: "identity",
          serviceToken: "svc",
        }
      ),
    (error: unknown) =>
      error instanceof CapReachedError &&
      error.cap === 200 &&
      error.used === 200 &&
      error.resetsAt === "2026-09-20T12:00:00.000Z"
  );
});

test("a 500 is still an outage, not a cap", async () => {
  // An outage dressed up as a cap would tell a customer they had run out when
  // they had not.
  await assert.rejects(
    () =>
      fetchTenantCredential(
        { harnessId: "copilot", runId: "run-1", tenant: "acme" },
        {
          endpoint: "https://app.test",
          fetchImpl: () =>
            Promise.resolve(new Response("{}", { status: 500 })),
          identityToken: "identity",
          serviceToken: "svc",
        }
      ),
    (error: unknown) => !(error instanceof CapReachedError)
  );
});
```

Update the import at the top of that file to include `CapReachedError`, and add
`runId: "run-1"` to the existing request objects in this file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `corepack pnpm --filter @opencoven/cloud-runner exec tsx --test src/tenant-credentials.test.ts`
Expected: FAIL — `CapReachedError` is not exported.

- [ ] **Step 3: Write the implementation**

In `worker/src/tenant-credentials.ts`, add the error and the 429 branch:

```ts
/**
 * The tenant is out of included runs.
 *
 * A distinct type because the caller must tell this from an outage: one is the
 * customer's to resolve and carries a reset date, the other is ours and must
 * not be reported as "you have run out".
 */
export class CapReachedError extends Error {
  readonly cap: number;
  readonly resetsAt: string | null;
  readonly used: number;

  constructor(cap: number, used: number, resetsAt: string | null) {
    super(
      `Run cap reached: ${used} of ${cap} used${resetsAt ? `, resets ${resetsAt}` : ""}.`
    );
    this.cap = cap;
    this.name = "CapReachedError";
    this.resetsAt = resetsAt;
    this.used = used;
  }
}
```

And in `fetchTenantCredential`, before the general non-ok throw:

```ts
  if (response.status === 429) {
    const body = (await response.json().catch(() => null)) as {
      cap?: unknown;
      resetsAt?: unknown;
      used?: unknown;
    } | null;

    throw new CapReachedError(
      typeof body?.cap === "number" ? body.cap : 0,
      typeof body?.used === "number" ? body.used : 0,
      typeof body?.resetsAt === "string" ? body.resetsAt : null
    );
  }
```

Add `runId: string` to `CredentialRequest`, and include it in the JSON body
beside `harnessId` and `tenant`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `corepack pnpm --filter @opencoven/cloud-runner test`
Expected: PASS.

- [ ] **Step 5: Pass the run id from the agent**

In `worker/src/agents.ts`, `resolveTenantCredential` already receives the
definition and the identity token. Add the run id as a third parameter and pass
`planned.run.id` from `driveHarness`:

```ts
  private async resolveTenantCredential(
    definition: AgentDefinition,
    identityToken: string,
    runId: string
  ): Promise<string | null> {
```

and in the transport request object, add `runId`.

At the call site in `driveHarness`:

```ts
      credential = await this.resolveTenantCredential(
        definition,
        identityToken,
        planned.run.id
      );
```

- [ ] **Step 6: Verify**

```bash
corepack pnpm typecheck
corepack pnpm test:unit
```

Expected: all pass. The compiler will list any call site that still omits
`runId`.

- [ ] **Step 7: Mutation-test the distinction**

Remove the `429` branch so a cap falls through to the general throw. Run.
Expected: FAIL on "a cap refusal arrives as a cap, not as a generic failure".

Change the branch to `response.status >= 429`. Run. Expected: FAIL on "a 500 is
still an outage, not a cap".

Restore after each.

- [ ] **Step 8: Commit**

```bash
git add worker/src/tenant-credentials.ts worker/src/tenant-credentials.test.ts worker/src/agents.ts
git commit -S -m "feat(worker): surface a cap refusal as a cap"
```

---

### Task 8: Checkout

**Files:**
- Create: `app/api/checkout/route.ts`
- Create: `lib/billing/checkout.ts`
- Create: `lib/billing/checkout.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Add the dependency**

```bash
corepack pnpm add stripe
```

- [ ] **Step 2: Write the failing test**

Create `lib/billing/checkout.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { checkoutDecision } from "./checkout";

test("a user with no active subscription may check out", () => {
  const decision = checkoutDecision({
    hasActiveSubscription: false,
    userId: "user-1",
  });

  assert.equal(decision.kind, "allowed");
});

test("a user who is already subscribed is refused", () => {
  // Not enforced by a unique constraint on the customer id: that would reject
  // a legitimate cancel-then-resubscribe, which reuses the same Customer.
  const decision = checkoutDecision({
    hasActiveSubscription: true,
    userId: "user-1",
  });

  assert.equal(decision.kind, "already_subscribed");
});

test("a returning customer with only cancelled subscriptions may check out", () => {
  // Historical subscriptions are expected. Only a live one blocks.
  const decision = checkoutDecision({
    hasActiveSubscription: false,
    userId: "user-1",
  });

  assert.equal(decision.kind, "allowed");
});

test("an anonymous caller is refused", () => {
  assert.equal(
    checkoutDecision({ hasActiveSubscription: false, userId: null }).kind,
    "unauthorized"
  );
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `corepack pnpm exec tsx --conditions=react-server --test lib/billing/checkout.test.ts`
Expected: FAIL with `Cannot find module './checkout'`

- [ ] **Step 4: Write the decision**

Create `lib/billing/checkout.ts`:

```ts
export type CheckoutDecision =
  | { kind: "allowed"; userId: string }
  | { kind: "already_subscribed" }
  | { kind: "unauthorized" };

/**
 * Whether this user may open a checkout session.
 *
 * "At most one active subscription" is enforced by asking Stripe, not by a
 * database constraint on the customer id. A cancel-then-resubscribe reuses the
 * same Customer, so a constraint there would reject the returning customer —
 * the case most worth not breaking — while a fresh Customer per checkout would
 * make the constraint useless anyway.
 */
export function checkoutDecision(input: {
  hasActiveSubscription: boolean;
  userId: string | null;
}): CheckoutDecision {
  if (!input.userId) {
    return { kind: "unauthorized" };
  }
  if (input.hasActiveSubscription) {
    return { kind: "already_subscribed" };
  }
  return { kind: "allowed", userId: input.userId };
}
```

- [ ] **Step 5: Write the route**

Create `app/api/checkout/route.ts`:

```ts
import Stripe from "stripe";
import { auth } from "@/app/(auth)/auth";
import { checkoutDecision } from "@/lib/billing/checkout";
import { db } from "@/lib/db/queries";
import { user } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

/**
 * Opens a Stripe Checkout session.
 *
 * One Customer per user, reused across subscriptions, with `metadata.userId`
 * stamped on it. That metadata is what lets the very first webhook find the
 * user before `stripeCustomerId` has been written — since that event is what
 * writes it.
 */
export async function POST() {
  const session = await auth();
  const userId = session?.user?.id ?? null;

  const secret = process.env.STRIPE_SECRET_KEY;
  const price = process.env.STRIPE_PRICE_ID;
  if (!(secret && price)) {
    return Response.json({ error: "billing_unavailable" }, { status: 503 });
  }

  const stripe = new Stripe(secret);

  const [row] = userId
    ? await db.select().from(user).where(eq(user.id, userId)).limit(1)
    : [];

  const active = row?.stripeCustomerId
    ? (
        await stripe.subscriptions.list({
          customer: row.stripeCustomerId,
          limit: 1,
          status: "active",
        })
      ).data.length > 0
    : false;

  const decision = checkoutDecision({
    hasActiveSubscription: active,
    userId,
  });

  if (decision.kind === "unauthorized") {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (decision.kind === "already_subscribed") {
    return Response.json({ error: "already_subscribed" }, { status: 409 });
  }

  const customer =
    row?.stripeCustomerId ??
    (await stripe.customers.create({ metadata: { userId: decision.userId } })).id;

  if (!row?.stripeCustomerId) {
    await db
      .update(user)
      .set({ stripeCustomerId: customer })
      .where(eq(user.id, decision.userId));
  }

  const checkout = await stripe.checkout.sessions.create({
    customer,
    line_items: [{ price, quantity: 1 }],
    mode: "subscription",
    success_url: `${process.env.APP_ORIGIN ?? ""}/agents`,
    cancel_url: `${process.env.APP_ORIGIN ?? ""}/pricing`,
  });

  return Response.json({ url: checkout.url });
}
```

- [ ] **Step 6: Verify**

```bash
corepack pnpm exec tsx --conditions=react-server --test lib/billing/checkout.test.ts
corepack pnpm check
corepack pnpm typecheck
```

Expected: 4 tests pass, lint and types clean.

- [ ] **Step 7: Mutation-test the active check**

Make `checkoutDecision` ignore `hasActiveSubscription`. Run. Expected: FAIL on
"a user who is already subscribed is refused". Restore.

- [ ] **Step 8: Commit**

```bash
git add lib/billing/checkout.ts lib/billing/checkout.test.ts app/api/checkout/route.ts package.json pnpm-lock.yaml
git commit -S -m "feat(billing): open a checkout session for one customer per user"
```

---

### Task 9: The webhook

**Files:**
- Create: `app/api/stripe/webhook/route.ts`
- Create: `lib/billing/webhook.ts`
- Create: `lib/billing/webhook.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/billing/webhook.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { GRACE_PERIOD_DAYS } from "./limits";
import { subscriptionUpdate } from "./webhook";

const PAID_UNTIL = new Date("2026-09-20T12:00:00.000Z");

test("a paid invoice sets the period end", () => {
  const update = subscriptionUpdate({
    billingReason: "subscription_cycle",
    current: null,
    periodEnd: PAID_UNTIL,
    type: "invoice.paid",
  });

  assert.equal(update?.subscribedUntil.toISOString(), PAID_UNTIL.toISOString());
});

test("a failed renewal extends by the grace window", () => {
  const update = subscriptionUpdate({
    billingReason: "subscription_cycle",
    current: PAID_UNTIL,
    periodEnd: null,
    type: "invoice.payment_failed",
  });

  assert.equal(
    update?.subscribedUntil.getTime(),
    PAID_UNTIL.getTime() + GRACE_PERIOD_DAYS * 86_400_000
  );
});

test("a failed FIRST payment changes nothing", () => {
  // Would otherwise grant a subscriber session to someone who has never paid.
  assert.equal(
    subscriptionUpdate({
      billingReason: "subscription_create",
      current: null,
      periodEnd: null,
      type: "invoice.payment_failed",
    }),
    null
  );
});

test("a cancellation revokes nothing", () => {
  // The period is already paid for. Access ends when the date passes.
  assert.equal(
    subscriptionUpdate({
      billingReason: "subscription_cycle",
      current: PAID_UNTIL,
      periodEnd: null,
      type: "customer.subscription.deleted",
    }),
    null
  );
});

test("an unrecognised event changes nothing", () => {
  assert.equal(
    subscriptionUpdate({
      billingReason: "subscription_cycle",
      current: PAID_UNTIL,
      periodEnd: PAID_UNTIL,
      type: "invoice.upcoming",
    }),
    null
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `corepack pnpm exec tsx --conditions=react-server --test lib/billing/webhook.test.ts`
Expected: FAIL with `Cannot find module './webhook'`

- [ ] **Step 3: Write the decision**

Create `lib/billing/webhook.ts`:

```ts
import { graceExtension } from "./grace";

export type SubscriptionUpdate = { subscribedUntil: Date } | null;

/**
 * What a Stripe event changes about `subscribedUntil`, if anything.
 *
 * Pure, so the decision that grants paid access is testable without a webhook
 * delivery. Allow-listed on event type: an event Stripe adds later defaults to
 * changing nothing rather than falling into a branch it was never considered
 * for.
 *
 * A cancellation deliberately revokes nothing. The period is already paid for,
 * and access ends when the date passes.
 */
export function subscriptionUpdate(input: {
  billingReason: string;
  current: Date | null;
  periodEnd: Date | null;
  type: string;
}): SubscriptionUpdate {
  if (input.type === "invoice.paid" && input.periodEnd) {
    return { subscribedUntil: input.periodEnd };
  }

  if (input.type === "invoice.payment_failed") {
    const extended = graceExtension({
      billingReason: input.billingReason,
      // Grace is applied once. A second failure inside the window finds a date
      // already beyond the paid period and does not extend again.
      graceAlreadyApplied: Boolean(
        input.current && input.periodEnd && input.current > input.periodEnd
      ),
      subscribedUntil: input.current,
    });

    return extended ? { subscribedUntil: extended } : null;
  }

  return null;
}
```

- [ ] **Step 4: Write the route**

Create `app/api/stripe/webhook/route.ts`:

```ts
import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { subscriptionUpdate } from "@/lib/billing/webhook";
import { db } from "@/lib/db/queries";
import { stripeEvent, user } from "@/lib/db/schema";

/**
 * Stripe's webhook endpoint.
 *
 * Two things matter more than the rest. The signature is verified, because an
 * unverified endpoint that writes `subscribedUntil` is a free subscription for
 * anyone who can POST to it. And the event id is inserted as a primary key
 * before anything is written, so a redelivery — which Stripe does routinely —
 * conflicts instead of extending a subscription twice.
 */
export async function POST(request: Request) {
  const secret = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!(secret && webhookSecret)) {
    return Response.json({ error: "billing_unavailable" }, { status: 503 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return Response.json({ error: "unsigned" }, { status: 400 });
  }

  const raw = await request.text();
  const stripe = new Stripe(secret);

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, signature, webhookSecret);
  } catch {
    return Response.json({ error: "bad_signature" }, { status: 400 });
  }

  // The insert is the idempotency check. A lookup-then-write would race a
  // concurrent redelivery.
  const claimed = await db
    .insert(stripeEvent)
    .values({ id: event.id })
    .onConflictDoNothing()
    .returning({ id: stripeEvent.id });

  if (claimed.length === 0) {
    return Response.json({ deduped: true });
  }

  const object = event.data.object as {
    billing_reason?: string | null;
    customer?: string | null;
    lines?: { data?: { period?: { end?: number } }[] };
  };

  const customerId =
    typeof object.customer === "string" ? object.customer : null;
  if (!customerId) {
    return Response.json({ ignored: true });
  }

  const [owner] = await db
    .select()
    .from(user)
    .where(eq(user.stripeCustomerId, customerId))
    .limit(1);

  // The first event of a new subscription is what writes `stripeCustomerId`,
  // so it cannot be found by it. Checkout stamps `metadata.userId` on the
  // Customer for exactly this moment.
  const resolved =
    owner ??
    (await (async () => {
      const customer = await stripe.customers.retrieve(customerId);
      const userId =
        "metadata" in customer ? customer.metadata?.userId : undefined;
      if (!userId) {
        return null;
      }
      const [byMetadata] = await db
        .select()
        .from(user)
        .where(eq(user.id, userId))
        .limit(1);
      return byMetadata ?? null;
    })());

  if (!resolved) {
    return Response.json({ ignored: true });
  }

  const periodEndSeconds = object.lines?.data?.[0]?.period?.end;
  const update = subscriptionUpdate({
    billingReason: object.billing_reason ?? "",
    current: resolved.subscribedUntil ?? null,
    periodEnd: periodEndSeconds ? new Date(periodEndSeconds * 1000) : null,
    type: event.type,
  });

  if (update) {
    await db
      .update(user)
      .set({
        stripeCustomerId: customerId,
        subscribedUntil: update.subscribedUntil,
      })
      .where(eq(user.id, resolved.id));
  }

  return Response.json({ received: true });
}
```

- [ ] **Step 5: Verify**

```bash
corepack pnpm exec tsx --conditions=react-server --test lib/billing/webhook.test.ts
corepack pnpm check
corepack pnpm typecheck
corepack pnpm test:unit
corepack pnpm build
```

Expected: all pass.

- [ ] **Step 6: Mutation-test the guards**

| Mutation | Must fail |
| --- | --- |
| `subscriptionUpdate` treats any failed invoice as a renewal | "a failed FIRST payment changes nothing" |
| `subscriptionUpdate` returns an update for `customer.subscription.deleted` | "a cancellation revokes nothing" |
| `subscriptionUpdate` falls through for unknown types instead of returning null | "an unrecognised event changes nothing" |

Restore after each. The first grants free subscriptions; if it does not fail,
stop and report.

- [ ] **Step 7: Verify dedupe against the real database**

```bash
docker exec coven-pg psql -U postgres -d coven -c "insert into \"StripeEvent\" (id) values ('evt_test');"
docker exec coven-pg psql -U postgres -d coven -c "insert into \"StripeEvent\" (id) values ('evt_test');"
docker exec coven-pg psql -U postgres -d coven -c "delete from \"StripeEvent\" where id='evt_test';"
```

Expected: the second insert fails with a duplicate key error. That failure is
what makes redelivery a no-op.

- [ ] **Step 8: Commit**

```bash
git add lib/billing/webhook.ts lib/billing/webhook.test.ts app/api/stripe/webhook/route.ts
git commit -S -m "feat(billing): write subscribedUntil from a verified, deduped webhook"
```

---

### Task 10: Usage is visible

**Files:**
- Create: `app/api/usage/route.ts`

- [ ] **Step 1: Write the route**

Create `app/api/usage/route.ts`:

```ts
import { eq } from "drizzle-orm";
import { auth } from "@/app/(auth)/auth";
import { MONTHLY_RUN_CAP } from "@/lib/billing/limits";
import { periodStart } from "@/lib/billing/period";
import { usageFor } from "@/lib/billing/usage";
import { db } from "@/lib/db/queries";
import { user } from "@/lib/db/schema";
import { tenantForUser } from "@/lib/session";

/**
 * What the user has spent this period.
 *
 * Reads the same counter and the same constant the enforcement point uses, so
 * the number shown and the number enforced cannot drift. A cap you cannot see
 * is indistinguishable from a bug, and two caps that disagree are worse.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const [owner] = await db
    .select()
    .from(user)
    .where(eq(user.id, session.user.id))
    .limit(1);

  const resetsAt = owner?.subscribedUntil ?? null;
  const since = periodStart(resetsAt);

  return Response.json({
    cap: MONTHLY_RUN_CAP,
    resetsAt: resetsAt?.toISOString() ?? null,
    used: since ? await usageFor(db, tenantForUser(session.user.id), since) : 0,
  });
}
```

- [ ] **Step 2: Verify**

```bash
corepack pnpm check
corepack pnpm typecheck
corepack pnpm build
```

Expected: all pass.

- [ ] **Step 3: Verify against a running app**

```bash
PORT=3106 corepack pnpm dev > /tmp/usage.log 2>&1 &
until curl -s -o /dev/null http://localhost:3106/ping; do sleep 1; done
curl -s -o /dev/null -w 'anonymous: %{http_code}\n' http://localhost:3106/api/usage
kill %1
```

Expected: `401`. Usage is not public.

- [ ] **Step 4: Commit**

```bash
git add app/api/usage/route.ts
git commit -S -m "feat(billing): expose usage against the cap"
```

---

### Task 11: Full verification

- [ ] **Step 1: Run the whole gate**

```bash
corepack pnpm check
corepack pnpm typecheck
corepack pnpm test:unit
corepack pnpm build
```

Expected: all pass, test count risen by roughly 25.

- [ ] **Step 2: Confirm the new tests run in CI**

Break one assertion in `lib/billing/grace.test.ts`, run `corepack pnpm test:unit`, confirm it fails, restore.

The `lib/**/*.test.ts` glob should pick these up, but a test CI never runs has
been the single most repeated defect in this codebase — five occurrences.
Verify rather than trusting the glob.

- [ ] **Step 3: Confirm the cap is quoted consistently**

```bash
grep -rn "MONTHLY_RUN_CAP" app lib --include='*.ts' --include='*.tsx' | grep -v test
```

Expected: every hit imports the constant. No literal number anywhere — the
pricing page, the usage endpoint and the enforcement point must read one value.

- [ ] **Step 4: Push and open the PR**

```bash
corepack pnpm hygiene
git push -u origin <branch>
```

---

## Self-review against the spec

| Spec requirement | Task |
| --- | --- |
| One price, one enforced cap | 2, 6 |
| Counting is what leaves room | 5 |
| Count once per `(tenant, runId)` | 4, 5 |
| Period from the renewal date, not the calendar month | 1 |
| Cap enforced where the credential is lent | 6 |
| Worker never counts or learns the cap | 6, 7 |
| Refusal carries cap, used and reset date | 6, 7 |
| Usage visible while it accrues | 10 |
| One constant, three readers | 2, 11 |
| Verify the webhook signature | 9 |
| Dedupe by event id | 4, 9 |
| Grace only on a renewal, applied once | 3, 9 |
| No trial | 3 (nothing grants access without a paid invoice) |
| One Customer per user, at most one active subscription | 4, 8 |
| Stripe customer mapped back to a user | 8, 9 |
| Cap query failure refuses the run | 6 |

**Not covered, deliberately:** the pricing page itself. It is a marketing
surface, it must read `MONTHLY_RUN_CAP` (Task 11 step 3 checks that nothing
hardcodes the number), and its copy is not an engineering decision.

**Ordering:** Tasks 1–3 are independent and pure. Task 4 precedes 5, 6 and 9.
Task 6 needs 1, 2, 4 and 5. Task 7 needs 6. Tasks 8 and 9 need 4. Task 10 needs
1, 2 and 5.
