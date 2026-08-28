# Abuse Resilience and Blast-Radius Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make abusive traffic cheap to reject, bound every paid or stateful operation, contain compromised identities and keys, and give operators fast detection and kill switches.

**Architecture:** Apply defense in depth across five tracks: edge admission, application abuse budgets, cloud execution governance, identity/credential compartmentalization, and detection/response. Guest requests remain resource-free; authenticated high-cost requests pass cost-aware limits and atomic reservations; Worker execution adds independent per-source, per-tenant, and global controls. This plan coordinates multiple independently shippable PRs, but later tasks depend on the shared policy and telemetry contracts established first.

**Tech Stack:** Next.js 16, NextAuth 5, Redis, PostgreSQL/Drizzle, Cloudflare Workers, Durable Objects, Cloudflare Sandbox SDK, Cloudflare Rate Limiting bindings, Zod, Node test runner, Playwright, OpenTelemetry.

---

No system can guarantee that abuse is eliminated. This plan makes abuse
bounded, expensive to sustain, cheap to reject, quickly detectable, and
recoverable without exposing unrelated tenants.

## Program invariants

The implementation is complete only when these statements are continuously verified:

1. Anonymous and guest traffic cannot trigger model calls, uploads, credential work, runner claims, sandboxes, or persistent product-data reads.
2. Every public endpoint has a declared cost class, body limit, identity key, burst limit, sustained limit, and failure mode.
3. Every run consumes an atomic reservation before credential lending or sandbox startup.
4. Per-agent, per-tenant, and deployment-wide execution ceilings are enforced independently.
5. Revoking a session, signing key, service token, or credential lease takes effect without waiting for its natural expiry.
6. A compromised key has an explicit version, rotation path, bounded acceptance window, and auditable use.
7. Security telemetry never records secrets, raw tokens, request bodies, email addresses, or unredacted provider output.
8. Operators can disable chat, uploads, credential lending, runner issuance, and execution independently without a code deployment.
9. Disallowed sandbox egress is proven to fail in deployment; lack of enforceable egress control blocks unrestricted production execution.
10. Abuse tests run in CI and include sustained traffic, replay, race, cross-tenant, and failure-mode cases.

## File structure

### Application abuse controls

- Create `lib/abuse/types.ts`: shared cost classes, subjects, decisions, and event types.
- Create `lib/abuse/policy.ts`: route-to-policy registry with validated limits.
- Create `lib/abuse/store.ts`: Redis atomic token-bucket and byte-budget implementation.
- Create `lib/abuse/enforce.ts`: request identity derivation and fail-open/fail-closed behavior.
- Create `lib/abuse/body.ts`: bounded JSON and content-length guards.
- Create `lib/abuse/idempotency.ts`: request hash and stored-result replay contract.
- Create `lib/abuse/*.test.ts`: deterministic policy, limiter, body, and idempotency tests.
- Modify `lib/ratelimit.ts`: compatibility wrapper over the shared limiter, then remove duplicated logic.

### Cloud execution governance

- Create `worker/src/abuse.ts`: Cloudflare Rate Limiting binding checks and standardized 429 responses.
- Create `worker/src/admission.ts`: per-tenant and deployment admission model.
- Create `worker/src/admission.test.ts`: concurrency, queue, fairness, and recovery tests.
- Create `worker/src/security-events.ts`: privacy-safe Worker security event emitter.
- Modify `worker/src/agents.ts`, `worker/src/routes.ts`, `worker/src/run-state.ts`, and `worker/wrangler.jsonc`.

### Atomic budgets and credential leases

- Create `lib/billing/run-reservations.ts`: atomic tenant/global reservation API.
- Create `lib/billing/run-reservations.test.ts`.
- Modify `lib/db/schema.ts` and add a Drizzle migration for run reservations, auth versions, key versions, leases, and audit events.
- Create `lib/credentials/key-ring.ts`: versioned KEK lookup and rotation.
- Create `lib/credentials/leases.ts`: one-time, run-bound credential leases.
- Modify `lib/credentials/store.ts`, `app/api/internal/credential/route.ts`, and `worker/src/agents.ts`.

### Identity, telemetry, and operations

- Create `lib/auth/session-revocation.ts` and tests.
- Create `lib/agents/key-ring.ts` and tests.
- Create `lib/security/events.ts`, `lib/security/events.test.ts`, and `lib/security/kill-switches.ts`.
- Create `app/api/internal/security/health/route.ts`: authenticated deployment posture probe.
- Create `docs/security/abuse-control-policy.md`, `docs/security/key-rotation.md`, and `docs/security/abuse-drills.md`.
- Modify `.env.example`, `docs/security/execution-threat-model.md`, `docs/security/incident-response.md`, and CI workflows.

---

### Task 1: Define the abuse-control contract

**Files:**
- Create: `lib/abuse/types.ts`
- Create: `lib/abuse/policy.ts`
- Create: `lib/abuse/policy.test.ts`
- Modify: `docs/security/execution-threat-model.md`

- [ ] **Step 1: Write the failing policy tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { abusePolicyFor } from "./policy";

test("every resource-bearing route has a fail-closed policy", () => {
  for (const route of [
    "chat",
    "upload",
    "checkout",
    "credential_device_start",
    "credential_device_poll",
    "runner_connection",
    "runner_token",
    "run_start",
  ] as const) {
    const policy = abusePolicyFor(route);
    assert.equal(policy.failureMode, "closed");
    assert.ok(policy.burst.limit > 0);
    assert.ok(policy.sustained.limit > 0);
    assert.ok(policy.bodyBytes >= 0);
  }
});

test("unknown route classes fail during policy lookup", () => {
  assert.throws(() => abusePolicyFor("unknown" as never));
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm exec tsx --test lib/abuse/policy.test.ts`

Expected: FAIL because `lib/abuse/policy.ts` does not exist.

- [ ] **Step 3: Implement the closed policy registry**

```ts
// lib/abuse/types.ts
export type AbuseRoute =
  | "auth_start"
  | "auth_callback"
  | "chat"
  | "upload"
  | "checkout"
  | "credential_device_start"
  | "credential_device_poll"
  | "runner_connection"
  | "runner_token"
  | "run_start";

export type AbusePolicy = {
  bodyBytes: number;
  burst: { limit: number; windowSeconds: number };
  failureMode: "closed" | "open";
  sustained: { limit: number; windowSeconds: number };
  subjects: readonly ("ip" | "user" | "tenant")[];
};
```

```ts
// lib/abuse/policy.ts
import type { AbusePolicy, AbuseRoute } from "./types";

const POLICIES = {
  auth_start: policy(["ip"], 0, 5, 60, 20, 3600),
  auth_callback: policy(["ip"], 16_384, 10, 60, 40, 3600),
  chat: policy(["ip", "user"], 64_000, 4, 60, 60, 3600),
  upload: policy(["ip", "user"], 5_250_000, 2, 60, 20, 3600),
  checkout: policy(["ip", "user"], 8_192, 2, 300, 3, 3600),
  credential_device_start: policy(["ip", "user"], 0, 2, 300, 5, 3600),
  credential_device_poll: policy(["ip", "user"], 8_192, 12, 60, 60, 3600),
  runner_connection: policy(["ip", "user"], 0, 10, 60, 60, 3600),
  runner_token: policy(["ip", "user"], 0, 10, 60, 60, 3600),
  run_start: policy(["ip", "tenant"], 64_000, 5, 60, 25, 86_400),
} satisfies Record<AbuseRoute, AbusePolicy>;

function policy(
  subjects: AbusePolicy["subjects"],
  bodyBytes: number,
  burstLimit: number,
  burstWindow: number,
  sustainedLimit: number,
  sustainedWindow: number
): AbusePolicy {
  return {
    bodyBytes,
    burst: { limit: burstLimit, windowSeconds: burstWindow },
    failureMode: "closed",
    sustained: {
      limit: sustainedLimit,
      windowSeconds: sustainedWindow,
    },
    subjects,
  };
}

export function abusePolicyFor(route: AbuseRoute): AbusePolicy {
  const selected = POLICIES[route];
  if (!selected) {
    throw new Error(`No abuse policy for ${JSON.stringify(route)}.`);
  }
  return selected;
}
```

- [ ] **Step 4: Run the policy tests**

Run: `pnpm exec tsx --test lib/abuse/policy.test.ts`

Expected: PASS.

- [ ] **Step 5: Document that limits are initial enforcement values**

Add the policy table to `docs/security/execution-threat-model.md`. State that production changes require a reviewed code change, shadow telemetry, and rollback threshold; environment variables may lower emergency limits but may not raise them above code maxima.

- [x] **Step 6: Commit**

```bash
git add lib/abuse docs/security/execution-threat-model.md
git commit -S -m "feat(security): define abuse control policies" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Implement atomic Redis abuse budgets

**Files:**
- Create: `lib/abuse/store.ts`
- Create: `lib/abuse/store.test.ts`
- Modify: `lib/ratelimit.ts`
- Create: `lib/ratelimit.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write failing atomic-consumption tests**

Test exact-window behavior, independent subjects, TTL creation, Redis outage, and concurrent calls. Inject an `AbuseStore` fake so tests do not need Redis.

```ts
test("the first request over a budget is denied with retry metadata", async () => {
  const store = new MemoryAbuseStore();
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await store.consume("chat:ip:a", 3, 60, 1_000)).allowed, true);
  }
  assert.deepEqual(await store.consume("chat:ip:a", 3, 60, 1_000), {
    allowed: false,
    remaining: 0,
    retryAfterSeconds: 60,
  });
});
```

Define `MemoryAbuseStore` in the test as an `AbuseStore` implementation backed
by `Map<string, { count: number; expiresAt: number }>`; reset expired entries
before incrementing and compute `retryAfterSeconds` from `expiresAt`.

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm exec tsx --test lib/abuse/store.test.ts`

Expected: FAIL because the store does not exist.

- [ ] **Step 3: Implement a single-round-trip Redis script**

Expose this interface:

```ts
export type AbuseBudgetResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

export interface AbuseStore {
  consume(
    key: string,
    limit: number,
    windowSeconds: number,
    nowMs?: number
  ): Promise<AbuseBudgetResult>;
}
```

Use one Lua script that increments, sets expiry only for a new key, reads TTL, and returns `{count, ttl}` atomically. Prefix keys with `coven:abuse:v1:` and hash user, tenant, and IP subjects with an HMAC key from `ABUSE_KEY_SECRET`; never place raw identifiers in Redis keys.

- [ ] **Step 4: Replace the chat-only limiter**

Change `lib/ratelimit.ts` into a compatibility wrapper that delegates to `RedisAbuseStore`. Preserve the current production-only chat behavior until Task 3 wires the full policy registry.

- [ ] **Step 5: Add required configuration**

Add to `.env.example`:

```dotenv
# HMAC key used only to pseudonymize abuse-budget subjects.
ABUSE_KEY_SECRET=
# Existing Redis connection used for distributed abuse budgets.
REDIS_URL=
```

Production startup must reject an empty `ABUSE_KEY_SECRET`. Development may use a fixed documented test value.

- [ ] **Step 6: Run tests**

Run: `pnpm exec tsx --test lib/abuse/store.test.ts lib/ratelimit.test.ts`

Expected: PASS, including 100 parallel calls allowing exactly the configured limit.

- [x] **Step 7: Commit**

```bash
git add lib/abuse lib/ratelimit.ts lib/ratelimit.test.ts .env.example
git commit -S -m "feat(security): add atomic abuse budgets" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Enforce application admission before expensive work

**Files:**
- Create: `lib/abuse/enforce.ts`
- Create: `lib/abuse/enforce.test.ts`
- Modify: `app/(chat)/api/chat/route.ts`
- Modify: `app/(chat)/api/files/upload/route.ts`
- Modify: `app/api/checkout/route.ts`
- Modify: `app/api/credentials/device/route.ts`
- Modify: `app/api/runner-connection/route.ts`
- Modify: `app/api/runner-token/route.ts`

- [ ] **Step 1: Write failing enforcement tests**

Cover missing IP, guest refusal ordering, multiple subjects, standard 429 response, `Retry-After`, `Cache-Control: no-store`, and store outage. Cost-bearing routes must return 503 on limiter outage rather than proceed.

```ts
const denyingStore: AbuseStore = {
  consume: () =>
    Promise.resolve({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 300,
    }),
};

assert.deepEqual(await enforceAbusePolicy({
  route: "checkout",
  ip: "203.0.113.4",
  userId: "9c858901-8a57-4791-81fe-4c455b099bc9",
  store: denyingStore,
}), {
  kind: "denied",
  responseStatus: 429,
  retryAfterSeconds: 300,
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm exec tsx --test lib/abuse/enforce.test.ts`

Expected: FAIL because `enforceAbusePolicy` does not exist.

- [ ] **Step 3: Implement subject derivation and enforcement**

```ts
export type AbuseAdmission =
  | { kind: "allowed" }
  | { kind: "denied"; responseStatus: 429; retryAfterSeconds: number }
  | { kind: "unavailable"; responseStatus: 503 };

export async function enforceAbusePolicy(input: {
  ip: string | null;
  route: AbuseRoute;
  store?: AbuseStore;
  tenant?: string;
  userId?: string;
}): Promise<AbuseAdmission>;
```

Require every subject listed by the policy. Consume both burst and sustained budgets. Missing IP uses a single `"unknown"` bucket so missing proxy headers cannot bypass limits.

- [ ] **Step 4: Add a standard response helper**

Return:

```json
{
  "error": "rate_limited",
  "message": "Too many requests. Try again later."
}
```

Include `Retry-After` and `Cache-Control: no-store`. Do not reveal which subject or threshold tripped.

- [ ] **Step 5: Wire routes in cost order**

For every listed route:

1. authenticate and establish guest/subscriber authority;
2. derive IP with `ipAddress(request)` or the repository-standard forwarded header helper;
3. enforce the abuse policy;
4. only then parse a large body, call Stripe/GitHub/Redis/Postgres beyond authorization, upload a blob, sign a claim, or return a control token.

- [ ] **Step 6: Add structural ordering tests**

Extend `scripts/guest-access-docs.test.ts` or create `scripts/abuse-route-order.test.ts` to assert each route imports `enforceAbusePolicy` and places the call before `request.json`, `request.formData`, `put`, Stripe calls, device-flow calls, and token minting.

- [ ] **Step 7: Run tests**

Run: `pnpm exec tsx --test lib/abuse/*.test.ts scripts/abuse-route-order.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/abuse app scripts
git commit -S -m "feat(security): enforce cost-aware request admission" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Throttle OAuth account creation and automated sign-in

**Files:**
- Modify: `app/api/auth/[...nextauth]/route.ts`
- Create: `lib/auth/abuse.ts`
- Create: `lib/auth/abuse.test.ts`
- Modify: `app/(auth)/auth.ts`
- Modify: `tests/e2e/auth.test.ts`

- [ ] **Step 1: Write failing auth-route tests**

Cover:

- more than five OAuth initiations per IP per minute returns 429;
- callback traffic has a separate budget;
- `/api/auth/session` remains readable and cheap;
- a limiter outage refuses OAuth initiation but does not invalidate an existing session;
- verified-email account adoption remains unchanged.

- [ ] **Step 2: Run the tests and verify failure**

Run: `pnpm exec tsx --test lib/auth/abuse.test.ts`

Expected: FAIL because auth abuse classification is absent.

- [ ] **Step 3: Wrap the NextAuth handlers**

Classify only:

```ts
export function authAbuseRoute(pathname: string):
  | "auth_start"
  | "auth_callback"
  | null {
  if (pathname.includes("/signin") || pathname.includes("/signout")) {
    return "auth_start";
  }
  if (pathname.includes("/callback/")) {
    return "auth_callback";
  }
  return null;
}
```

The route wrapper must enforce the matching policy before invoking the exported NextAuth handler. Do not rate-limit `/session`, `/csrf`, or provider discovery with the strict signup budget.

- [ ] **Step 4: Add browser coverage**

Extend `tests/e2e/auth.test.ts` to confirm the login page remains usable and a 429 auth response produces a generic retry message rather than an OAuth redirect loop.

- [ ] **Step 5: Run tests**

Run: `pnpm exec tsx --test lib/auth/*.test.ts && pnpm test -- --grep "auth"`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/api/auth app/'(auth)' lib/auth tests/e2e/auth.test.ts
git commit -S -m "feat(auth): throttle OAuth account creation" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 5: Bound request bodies and make costly requests idempotent

**Files:**
- Create: `lib/abuse/body.ts`
- Create: `lib/abuse/body.test.ts`
- Create: `lib/abuse/idempotency.ts`
- Create: `lib/abuse/idempotency.test.ts`
- Add: `lib/db/migrations/0005_idempotency_records.sql`
- Modify: `app/api/checkout/route.ts`
- Modify: `app/api/credentials/device/route.ts`
- Modify: `app/(chat)/api/files/upload/route.ts`
- Modify: `app/(chat)/api/chat/route.ts`

- [ ] **Step 1: Write failing body-limit tests**

Verify `Content-Length` above the policy returns 413 before reading the stream, missing length is handled by bounded streaming, malformed JSON remains 400, and oversized multipart input never calls `formData()`.

- [ ] **Step 2: Implement bounded readers**

Expose:

```ts
export async function readBoundedJson<T>(
  request: Request,
  maximumBytes: number,
  schema: z.ZodType<T>
): Promise<
  | { kind: "ok"; value: T }
  | { kind: "invalid" }
  | { kind: "too_large" }
>;
```

Use `request.body.getReader()` and cancel once `maximumBytes + 1` bytes arrive. Convert `too_large` to 413 with `Connection: close` where supported.

- [ ] **Step 3: Write failing idempotency tests**

For checkout and device-flow start:

- same key + same normalized hash returns the stored response;
- same key + different hash returns 409;
- expired key can be reused;
- absent key returns 400 on costly create operations.

- [ ] **Step 4: Implement idempotency storage**

Create a Drizzle `IdempotencyRecord` table:

```ts
{
  keyHash: text().primaryKey(),
  ownerId: uuid().notNull(),
  operation: varchar({ length: 64 }).notNull(),
  requestHash: text().notNull(),
  responseJson: jsonb().notNull(),
  responseStatus: integer().notNull(),
  expiresAt: timestamp().notNull(),
}
```

Hash keys before storage. Scope lookup by owner and operation. Set checkout retention to 24 hours and device-flow start retention to 15 minutes.

- [ ] **Step 5: Wire routes**

Require `Idempotency-Key` for checkout and device-flow start. Preserve Stripe's own idempotency option using the same hashed key. Apply bounded JSON and multipart checks before parsing.

- [ ] **Step 6: Run tests**

Run: `pnpm exec tsx --test lib/abuse/body.test.ts lib/abuse/idempotency.test.ts lib/billing/checkout.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/abuse lib/db app/api/checkout app/api/credentials app/'(chat)'/api
git commit -S -m "feat(security): bound and deduplicate costly requests" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 6: Add independent Worker edge limits

**Files:**
- Modify: `worker/wrangler.jsonc`
- Modify: `worker/src/worker-secrets.d.ts`
- Create: `worker/src/abuse.ts`
- Create: `worker/src/abuse.test.ts`
- Modify: `worker/src/routes.ts`

- [ ] **Step 1: Write failing Worker limiter tests**

Use injected fake `RateLimit` bindings. Cover unauthenticated source-IP floods, authenticated tenant bursts, distinct tenant isolation, missing `CF-Connecting-IP`, and `Retry-After`.

- [ ] **Step 2: Add Cloudflare Rate Limiting bindings**

Add separate bindings so unauthenticated and authenticated traffic do not share a namespace:

```jsonc
"ratelimits": [
  {
    "name": "EDGE_REQUEST_LIMITER",
    "namespace_id": "1001",
    "simple": { "limit": 60, "period": 60 }
  },
  {
    "name": "TENANT_MUTATION_LIMITER",
    "namespace_id": "1002",
    "simple": { "limit": 30, "period": 60 }
  },
  {
    "name": "TENANT_RUN_LIMITER",
    "namespace_id": "1003",
    "simple": { "limit": 5, "period": 60 }
  }
]
```

Before deployment, confirm current syntax against the official Cloudflare Rate Limiting binding documentation: <https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/>.

- [ ] **Step 3: Implement staged Worker enforcement**

```ts
export async function enforceWorkerEdgeLimit(input: {
  env: Env;
  ip: string;
  routeClass: "read" | "mutation" | "run";
  tenant?: string;
}): Promise<Response | null>;
```

1. Consume the IP binding before token verification.
2. Verify the signed identity.
3. Consume the tenant mutation or run binding.
4. Return a generic 429 without revealing whether an IP or tenant limit fired.

- [ ] **Step 4: Preserve security ordering**

Do not move claim verification after body parsing. Do not include raw tenant IDs in telemetry or response bodies. Hash rate-limit keys using a Worker secret.

- [ ] **Step 5: Run Worker tests**

Run: `pnpm --filter @opencoven/cloud-runner test`

Expected: PASS with limiter refusal coverage in `worker/src/abuse.test.ts` and existing cross-tenant tests unchanged.

- [ ] **Step 6: Commit**

```bash
git add worker
git commit -S -m "feat(worker): add independent edge abuse limits" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 7: Reserve run budget atomically before credential lending

**Files:**
- Modify: `lib/db/schema.ts`
- Create: `lib/billing/run-reservations.ts`
- Create: `lib/billing/run-reservations.test.ts`
- Modify: `app/api/internal/credential/route.ts`
- Modify: `app/api/usage/route.ts`
- Add: `lib/db/migrations/0006_run_reservations.sql`
- Modify: `.env.example`

- [ ] **Step 1: Write failing race tests**

Launch more parallel reservations than the remaining daily and monthly capacity. Assert exactly the allowed count succeeds and each `runId` is charged once.

```ts
test("parallel reservations cannot exceed the tenant cap", async () => {
  const fakeDb = new MemoryReservationDatabase();
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      reserveRun(fakeDb, {
        runId: `run-${index}`,
        tenant: TENANT,
        now: NOW,
        tenantDailyCap: 5,
        tenantMonthlyCap: 750,
        globalDailyCap: 500,
      })
    )
  );
  assert.equal(results.filter((result) => result.kind === "reserved").length, 5);
});
```

Define `MemoryReservationDatabase` in the test with a promise-based mutex and
an in-memory reservation array. Its `transaction()` method must serialize the
callback so the test exercises the same count-and-insert boundary expected
from PostgreSQL serializable transactions.

- [ ] **Step 2: Add reservation schema**

Create `RunReservation` with:

- `runId` primary key;
- `tenantHash`;
- `periodDay` and `periodMonth`;
- `state`: `reserved | consumed | released`;
- `reservedAt`, `expiresAt`, `consumedAt`, `releasedAt`;
- `costUnits` integer.

Add indexes on `(tenantHash, periodDay, state)` and `(periodDay, state)`.

- [ ] **Step 3: Implement one transaction**

Within a serializable transaction:

1. return the existing reservation for duplicate `runId`;
2. release expired reservations;
3. count tenant daily, tenant monthly, and global daily reservations;
4. refuse with `tenant_daily_cap`, `tenant_monthly_cap`, or `global_daily_cap`;
5. insert the reservation.

Production must require `GLOBAL_DAILY_RUN_CAP`; absence returns a configuration error before credential decryption.

- [ ] **Step 4: Replace count-then-increment**

In `app/api/internal/credential/route.ts`, reserve before reading or decrypting a credential. Mark the reservation consumed only after the credential is successfully lent. Release it if no credential exists or decryption fails.

- [ ] **Step 5: Expose safe usage**

`app/api/usage/route.ts` should return tenant daily remaining, monthly remaining, and whether global admission is currently closed. Do not return global capacity numbers to clients.

- [ ] **Step 6: Run tests**

Run: `pnpm exec tsx --test lib/billing/run-reservations.test.ts app/api/internal/credential/route.test.ts`

Expected: PASS, including the parallel cap test.

- [ ] **Step 7: Commit**

```bash
git add lib/db lib/billing app/api/internal/credential app/api/usage
git commit -S -m "feat(billing): reserve run capacity atomically" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 8: Enforce tenant concurrency and bounded fair queueing

**Files:**
- Create: `worker/src/admission.ts`
- Create: `worker/src/admission.test.ts`
- Modify: `worker/src/agents.ts`
- Modify: `worker/src/run-state.ts`
- Modify: `worker/src/routes.ts`
- Modify: `worker/src/index.ts`
- Modify: `worker/wrangler.jsonc`

- [x] **Step 1: Write failing admission tests**

Cover:

- one active run per agent remains enforced;
- no more than two active runs per tenant;
- queue depth is at most ten per tenant;
- deployment active ceiling refuses new work;
- round-robin dispatch gives a waiting tenant a slot before a tenant receives a third consecutive slot;
- cancelled and timed-out entries release capacity;
- duplicate `operationId` returns the original queue/run record.

- [x] **Step 2: Define the admission state machine**

```ts
type AdmissionRecord = {
  agentId: string;
  enqueuedAt: string;
  operationId: string;
  requestHash: string;
  runId: string;
  state: "queued" | "active" | "terminal";
  tenantHash: string;
};

type AdmissionDecision =
  | { kind: "active"; runId: string }
  | { kind: "queued"; position: number; runId: string }
  | { kind: "duplicate"; runId: string; state: "queued" | "active" }
  | { kind: "refused"; reason: "tenant_queue_full" | "global_busy" };
```

- [x] **Step 3: Implement `RunAdmission` as a Durable Object**

Use one deployment admission object for the global active ceiling and tenant round-robin queue. Keep only pseudonymous tenant hashes in this object. Alarm every 30 seconds while queued work exists; expire queue entries after five minutes.

Initial code maxima:

- tenant active runs: 2;
- tenant queued runs: 10;
- deployment active runs: 25;
- consecutive dispatches for one tenant while others wait: 2.

Environment values may lower these maxima but may not raise them.

- [x] **Step 4: Integrate with run lifecycle**

`worker/src/routes.ts` requests admission after identity and rate limits but before sandbox creation. `worker/src/agents.ts` reports terminal state in `finally`. A failed completion callback is retried by the admission alarm and must be idempotent.

- [x] **Step 5: Add operator kill fallback**

If the queue implementation is unhealthy, `RUN_ADMISSION_MODE=reject` uses the existing immediate `already_running`/busy refusal rather than bypassing admission.

- [x] **Step 6: Run tests**

Run: `pnpm --filter @opencoven/cloud-runner test`

Expected: PASS with deterministic fairness and capacity-release coverage.

- [x] **Step 7: Commit**

```bash
git add worker
git commit -S -m "feat(worker): bound and fairly schedule cloud runs" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 9: Version and revoke sessions and runner keys

**Files:**
- Modify: `lib/db/schema.ts`
- Modify: `app/(auth)/auth.ts`
- Create: `lib/auth/session-revocation.ts`
- Create: `lib/auth/session-revocation.test.ts`
- Create: `lib/agents/key-ring.ts`
- Create: `lib/agents/key-ring.test.ts`
- Modify: `lib/agents/runner-token.ts`
- Modify: `packages/agent-contracts/src/identity.ts`
- Modify: `packages/agent-contracts/src/verify-token.ts`
- Modify: `worker/src/routes.ts`
- Modify: `app/api/internal/credential/route.ts`
- Modify: `scripts/account.ts`
- Modify: `README.md`
- Modify: `docs/security/incident-response.md`
- Add: `docs/security/key-rotation.md`
- Add: `lib/db/migrations/0008_identity_versions.sql`

- [x] **Step 1: Write failing session-revocation tests**

Add `authVersion` to the user row and JWT. Assert a server-side increment denies an existing token immediately, while an unchanged version remains valid.

- [x] **Step 2: Implement session version checks**

```ts
export type SessionAuthority = {
  authVersion: number;
  subscribedUntil: Date | null;
};

export function sessionAuthorityMatches(input: {
  database: SessionAuthority;
  tokenAuthVersion: number;
  now: Date;
}): boolean;
```

Extend the existing authoritative subscriber lookup to compare both subscription and `authVersion`. Add an operator command:

```bash
pnpm account revoke-sessions <email>
```

The command increments `authVersion` and prints only the account ID and new version.

- [x] **Step 3: Write failing runner key-ring tests**

Cover current-key minting, current and previous verification, unknown `kid`, retired key refusal, and the existing 15-minute expiry.

- [x] **Step 4: Add `kid` and dual verification**

```ts
export type RunnerKeyRing = {
  current: { id: string; privateKey: CryptoKey; publicKey: CryptoKey };
  previous?: { id: string; publicKey: CryptoKey; retireAt: Date };
};
```

Claims include `kid`. Mint only with `current`. Worker and internal credential verification accept `current` and an unexpired `previous`.

- [x] **Step 5: Add rotation configuration**

Document:

1. deploy new public verify key as current while old remains previous;
2. switch the app signing key;
3. wait 15 minutes plus clock skew;
4. remove the old key.

Never overwrite one unversioned signing key in place.

- [x] **Step 6: Run tests**

Run:

```bash
pnpm exec tsx --test lib/auth/session-revocation.test.ts lib/agents/key-ring.test.ts lib/agents/runner-token.test.ts
pnpm --filter @opencoven/agent-contracts test
pnpm --filter @opencoven/cloud-runner test
```

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add app lib packages worker scripts docs/security
git commit -S -m "feat(security): version sessions and runner keys" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 10: Version the KEK and rewrap credentials safely

**Files:**
- Modify: `lib/db/schema.ts`
- Modify: `lib/credentials/envelope.ts`
- Create: `lib/credentials/key-ring.ts`
- Create: `lib/credentials/key-ring.test.ts`
- Modify: `lib/credentials/store.ts`
- Create: `scripts/credentials-rewrap.ts`
- Create: `scripts/credentials-rewrap.test.ts`
- Add: `lib/db/migrations/0009_credential_kek_versions.sql`
- Modify: `docs/security/incident-response.md`
- Modify: `docs/security/key-rotation.md`

- [x] **Step 1: Write failing envelope-version tests**

Cover writing with the current KEK, reading with current or previous KEK, unknown version refusal, rewrapping without exposing plaintext to logs, interruption/resume, and rollback before old-key retirement.

- [x] **Step 2: Extend the stored envelope**

Add `kekVersion` as a non-null short string. New rows use:

```ts
type CredentialEnvelopeV2 = {
  ciphertext: string;
  iv: string;
  kekVersion: string;
  wrappedKey: string;
};
```

- [x] **Step 3: Implement the KEK registry**

Read:

```dotenv
CREDENTIAL_KEK_CURRENT_VERSION=v2
CREDENTIAL_KEK_V2=
CREDENTIAL_KEK_V1=
```

The registry must:

- refuse duplicate or malformed versions;
- encrypt only with the current version;
- decrypt only named configured versions;
- never fall back to trying every key.

During staged migration, an unversioned idempotency response envelope is
accepted only at the JSON serialization boundary and is labeled exactly `v1`;
credential rows are labeled by the migration and never use that fallback.

- [x] **Step 4: Implement resumable rewrap**

`pnpm credentials:rewrap --from v1 --to v2 --batch 100`:

1. selects rows by `kekVersion`;
2. unwraps only the data key;
3. wraps the same data key with the new KEK;
4. updates `wrappedKey` and `kekVersion` transactionally;
5. prints counts and row IDs, never ciphertext or credentials;
6. is safe to rerun.

- [x] **Step 5: Add the rotation gate**

The old KEK may be removed only when a query returns zero rows for its version and the rewrap verification test passes in production read-only mode.

- [x] **Step 6: Run tests**

Run: `pnpm exec tsx --test lib/credentials/*.test.ts scripts/credentials-rewrap.test.ts`

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add lib/db lib/credentials scripts package.json docs/security
git commit -S -m "feat(security): add resumable credential key rotation" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 11: Bind credential lending to one run and one use

**Files:**
- Modify: `lib/db/schema.ts`
- Create: `lib/credentials/leases.ts`
- Create: `lib/credentials/leases.test.ts`
- Modify: `packages/agent-contracts/src/identity.ts`
- Modify: `app/api/runner-token/route.ts`
- Modify: `lib/agents/identity.ts`
- Modify: `lib/agents/client.ts`
- Modify: `components/console/run-console.tsx`
- Modify: `app/api/internal/credential/binding.ts`
- Modify: `app/api/internal/credential/route.ts`
- Modify: `worker/src/agents.ts`
- Add: `lib/db/migrations/0012_credential_leases.sql`

- [x] **Step 1: Write failing lease tests**

Cover tenant mismatch, harness mismatch, run mismatch, duplicate consumption, expired lease, released reservation, and successful one-time consumption.

- [x] **Step 2: Define the request and lease contracts**

```ts
export type CredentialRequestEnvelope = {
  agentId: string;
  harnessId: string;
  operationId: string;
  requestId: string;
  runId: string;
  tenant: string;
};

export type CredentialLease = {
  consumedAt: Date | null;
  expiresAt: Date;
  harnessId: string;
  operationIdHash: string;
  requestIdHash: string;
  runId: string;
  tenantHash: string;
};
```

- [x] **Step 3: Enforce signed binding**

The internal route must verify:

1. service token;
2. signed runner claim and `kid`;
3. body tenant equals claim tenant;
4. the signed claim's agent, harness, and operation equal the Worker agent
   definition and run-start request, and the Worker uses that operation ID as
   the run ID;
5. body run ID exists in a reserved/active state;
6. an issuance call has already persisted the immutable tenant, harness, run,
   and request binding;
7. the later consumption call presents that exact binding and the reservation
   is still reserved;
8. the one-use lease claim commits before any credential decryption;
9. OAuth refresh or terminal deletion commits independently, so a later
   lending rollback cannot undo it or repeat a rotated refresh;
10. the final transaction reads without provider side effects and atomically
    consumes the reservation and records run usage.

Set lease expiry to two minutes. A consumed lease cannot be replayed even
inside that window. Retain expired rows for 24 hours and delete older rows
opportunistically during issuance; the consumed or expired reservation remains
the durable replay barrier after lease-row cleanup.

For rolling deployment, first set
`CREDENTIAL_LEGACY_LENDING_ENABLED=true` and
`RUN_SCOPED_IDENTITY_WRITES_ENABLED=false`, then deploy the app. The
compatibility app accepts the old one-call Worker and still mints claims the old
strict verifier can parse. Deploy the Worker; the new Worker accepts the
compatibility app's legacy `200` response. Next set
`RUN_SCOPED_IDENTITY_WRITES_ENABLED=true` and redeploy the app. Wait at least
the 15-minute runner-token lifetime plus the browser bundle drain, then set
`CREDENTIAL_LEGACY_LENDING_ENABLED=false` and redeploy. The normal final state
is scoped writes enabled and legacy lending disabled. Remove both compatibility
flags and paths in the next security cleanup after production confirms no
legacy traffic.

- [x] **Step 4: Emit credential audit events**

Record only tenant hash, harness ID, run ID, operation, outcome, and timestamp. Never record the credential, wrapped key, raw tenant, service token, or runner claim.

- [x] **Step 5: Run tests**

Run: `pnpm exec tsx --test lib/credentials/leases.test.ts app/api/internal/credential/*.test.ts`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add lib/db lib/credentials app/api/internal/credential worker/src/agents.ts
git commit -S -m "feat(security): bind credential loans to one run" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Merged in PR #117 as `9f6cfa1d49de611df7c83e3fef3ab421e0bf5b3b`.

- [x] **Step 7: Complete the staged production rollout**

Production closure completed on 2026-08-27:

1. migration `0012_credential_leases.sql` applied successfully;
2. Worker version `86caa7ea-2c92-4205-a7e8-4febe3c384a4` deployed;
3. signed run-scoped identity writes enabled;
4. the 15-minute runner-token and browser compatibility window drained;
5. legacy credential lending disabled;
6. the final Vercel deployment reached Ready and was aliased to
   `https://agents.opencoven.ai`;
7. the app root retained its expected login redirect, while unauthenticated
   app credential and Worker agent requests returned `401`.

The final rollout state is
`RUN_SCOPED_IDENTITY_WRITES_ENABLED=true` and
`CREDENTIAL_LEGACY_LENDING_ENABLED=false`.

### Task 12: Enforce sandbox egress and aggressive cleanup

**Files:**
- Modify: `worker/Dockerfile`
- Create: `worker/container/egress-entrypoint.sh`
- Create: `worker/src/egress-policy.ts`
- Create: `worker/src/egress-policy.test.ts`
- Modify: `worker/src/harness-runner.ts`
- Modify: `worker/src/run-state.ts`
- Modify: `worker/src/agents.ts`
- Modify: `worker/wrangler.jsonc`
- Modify: `worker/package.json`
- Create: `docs/security/sandbox-egress.md`

- [ ] **Step 1: Write the deployment-blocking egress tests**

Define one allowed test host and one disallowed host. The production readiness test must prove:

- DNS and HTTPS to the allowed host succeed;
- HTTPS to the disallowed host fails;
- direct-IP HTTPS fails;
- clearing proxy variables does not restore direct egress;
- the harness credential is absent after the process exits.

If the deployed Sandbox/Container platform cannot enforce these statements, unrestricted production execution remains disabled through `RUN_EXECUTION_ENABLED=false`.

- [ ] **Step 2: Define harness-specific allowlists**

```ts
export const EGRESS_ALLOWLIST = {
  copilot: ["api.github.com", "github.com"],
  claude: ["api.anthropic.com"],
} as const;
```

Reject unknown harnesses before sandbox startup. Keep repository access and arbitrary package installation disabled unless separately authorized by a future policy.

- [ ] **Step 3: Enforce network policy at the container boundary**

The entrypoint must:

1. default-deny outbound traffic;
2. allow loopback and established connections;
3. allow DNS only through the configured resolver;
4. allow HTTPS only through a controlled egress proxy or platform-enforced destination policy;
5. refuse startup if firewall installation fails.

Environment proxy variables alone are not enforcement because child code can unset them.

- [ ] **Step 4: Minimize credential lifetime**

Inject the credential only into the harness child process, not the long-lived sandbox environment. Delete temporary credential files in `finally`, overwrite in-memory buffers where practical, and destroy the sandbox after terminal completion for high-risk harnesses.

- [ ] **Step 5: Add stale-run scavenging**

Use Durable Object alarms to:

- mark runs older than the 15-minute timeout plus two minutes as failed;
- release admission and billing reservations;
- destroy the sandbox;
- emit one `orphan_recovered` security event;
- remain idempotent on repeated alarms.

- [ ] **Step 6: Run tests and a deployed canary**

Add `"test:egress": "tsx --test src/egress-policy.test.ts src/egress-canary.test.ts"`
to `worker/package.json`.

Run:

```bash
pnpm --filter @opencoven/cloud-runner test
pnpm --filter @opencoven/cloud-runner test:egress
```

Expected: unit tests pass and the deployed canary proves all five egress assertions. Do not enable unrestricted runs on a unit-test-only result.

- [ ] **Step 7: Commit**

```bash
git add worker docs/security/sandbox-egress.md
git commit -S -m "feat(worker): enforce sandbox egress and cleanup" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 13: Add privacy-safe security events, alerts, and kill switches

**Files:**
- Create: `lib/security/events.ts`
- Create: `lib/security/events.test.ts`
- Create: `lib/security/kill-switches.ts`
- Create: `lib/security/kill-switches.test.ts`
- Create: `worker/src/security-events.ts`
- Modify: `app/(chat)/api/chat/route.ts`
- Modify: `app/api/stripe/webhook/route.ts`
- Modify: `app/api/internal/credential/route.ts`
- Modify: `worker/src/routes.ts`
- Modify: `worker/src/run-state.ts`
- Create: `app/api/internal/security/health/route.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write failing redaction and schema tests**

```ts
const event = securityEvent({
  kind: "rate_limit",
  route: "chat",
  outcome: "denied",
  requestId: "req_123",
  subjectHash: "sha256:...",
});
assert.doesNotMatch(JSON.stringify(event), /email|token|credential|authorization/i);
```

Reject unknown fields with a strict Zod schema.

- [ ] **Step 2: Define the event contract**

```ts
type SecurityEvent = {
  action?: string;
  agentId?: string;
  kind:
    | "account_created"
    | "auth_failure"
    | "rate_limit"
    | "cross_tenant_refusal"
    | "credential_lease"
    | "budget_refusal"
    | "kill_switch"
    | "orphan_recovered";
  outcome: "allowed" | "denied" | "failed";
  requestId: string;
  route: string;
  runId?: string;
  subjectHash?: string;
  timestamp: string;
};
```

Emit through OpenTelemetry in the app and Workers observability in the Worker. Sampling is 100% for denied/failed security events and configurable for allowed events.

- [ ] **Step 3: Wire account-creation and abuse events**

When `findOrCreateFederatedUser` creates a row, emit a pseudonymous
`account_created` event keyed by user ID and request ID. Wire rate-limit,
invalid webhook signature, cross-tenant refusal, budget refusal, credential
lease, and orphan-recovery events at their decision points. Do not log GitHub
tokens, email, profile payloads, raw IP, request bodies, or provider output.

- [ ] **Step 4: Implement independent kill switches**

```ts
type KillSwitches = {
  chat: boolean;
  credentialLending: boolean;
  runnerConnection: boolean;
  runnerIssuance: boolean;
  runExecution: boolean;
  uploads: boolean;
  webhookMutation: boolean;
};
```

Read server-owned configuration on each request with a cache TTL no longer than 30 seconds. Missing or malformed production configuration disables high-cost operations.

- [ ] **Step 5: Add a protected posture endpoint**

`GET /api/internal/security/health` requires the internal service token and returns only:

- kill-switch states;
- limiter connectivity;
- reservation store connectivity;
- current runner key IDs;
- current KEK version;
- egress readiness boolean;
- queue depth bands: `empty | low | elevated | saturated`.

It must not return secrets, raw counts, tenant identifiers, or credential metadata.

- [ ] **Step 6: Define alert thresholds**

Document and configure:

- 401/403 rate above baseline for five minutes;
- any cross-tenant refusal spike;
- limiter unavailable for 60 seconds;
- global budget refusal;
- queue saturation for three minutes;
- sandbox destroy failure;
- invalid Stripe signatures above five per minute;
- credential lease replay attempt;
- use of a previous signing key after its retirement time.

- [ ] **Step 7: Run tests**

Run: `pnpm exec tsx --test lib/security/*.test.ts && pnpm --filter @opencoven/cloud-runner test`

Expected: PASS with secret-shaped fixture values absent from serialized events.

- [ ] **Step 8: Commit**

```bash
git add lib/security app worker .env.example
git commit -S -m "feat(security): add detection and kill switches" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 14: Add edge policy, drills, CI abuse tests, and staged rollout

**Files:**
- Create: `docs/security/abuse-control-policy.md`
- Create: `docs/security/abuse-drills.md`
- Modify: `docs/security/incident-response.md`
- Modify: `docs/security/guest-access.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/e2e.yml`
- Create: `scripts/abuse-smoke.ts`
- Create: `scripts/abuse-smoke.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing smoke-test contract**

The script accepts only a base URL and synthetic credentials from environment variables. It must never print response bodies or tokens. Test that it verifies:

- anonymous guest chat/upload/runner requests are refused;
- auth initiation rate-limits;
- oversized requests return 413;
- duplicate checkout keys replay safely;
- Worker IP and tenant limits return 429;
- a guest runner claim cannot start work;
- cross-tenant reads return 404;
- run caps and kill switches refuse before sandbox startup.

- [ ] **Step 2: Implement `pnpm abuse:smoke`**

Use fixed synthetic request IDs and redact URLs before output. Print one line per assertion:

```text
PASS auth-start-rate-limit
PASS guest-runner-refusal
PASS cross-tenant-not-found
```

Any unexpected status exits 1.

Add to `package.json`:

```json
"abuse:smoke": "tsx scripts/abuse-smoke.ts"
```

- [ ] **Step 3: Define deployment-edge rules**

Document provider-side rules for both deployment surfaces:

- Vercel app: burst limits on `/api/auth/*`, `/api/chat`, `/api/files/upload`, `/api/checkout`, and `/api/credentials/*`; managed bot protection on auth and write routes; never challenge Stripe webhooks.
- Cloudflare Worker: managed DDoS/WAF protections plus the Worker Rate Limiting bindings from Task 6; block methods not declared by the route contract.
- Internal credential endpoint: network-restrict to the Worker deployment when the hosting platform supports it, while retaining service-token and signed-claim checks.

Store exported rule identifiers and screenshots or API JSON in the deployment evidence record; do not store account IDs or secrets in Git.

- [ ] **Step 4: Add CI gates**

CI runs deterministic limiter, replay, reservation-race, key-rotation, lease, queue, and redaction tests. Deployment E2E runs `pnpm abuse:smoke` against a canary before production promotion.

- [ ] **Step 5: Write operator drills**

`docs/security/abuse-drills.md` must include:

1. chat/signup flood and 429 verification;
2. stolen browser session revocation;
3. runner signing-key rotation;
4. service/control token rotation;
5. KEK rewrap and old-key retirement;
6. credential lease replay;
7. queue saturation and kill-switch activation;
8. orphaned sandbox cleanup;
9. disallowed egress attempt;
10. rollback to guest-only mode.

Each drill includes trigger, containment command, expected telemetry, verification, and rollback.

- [ ] **Step 6: Roll out in four gates**

1. **Shadow:** calculate decisions and emit events without denying; no credential or egress changes.
2. **Low-risk enforcement:** auth, guest, body-size, idempotency, and Worker IP limits.
3. **Cost enforcement:** atomic reservations, tenant/global admission, credential leases, and kill switches.
4. **Compromise containment:** key rings, KEK rewrap, and egress enforcement.

Advance only after seven days without unexplained false positives, limiter availability at or above 99.99%, no reservation overrun, and successful drills for that gate. Any cross-tenant regression, cap overrun, or secret-bearing event blocks promotion immediately.

- [ ] **Step 7: Run repository gates**

Run:

```bash
pnpm hygiene
pnpm secret:scan:all
pnpm check
pnpm typecheck
pnpm test:unit
pnpm build
```

Expected: all pass, no worktree is `AT RISK`, and the abuse smoke suite passes against canary.

- [ ] **Step 8: Commit**

```bash
git add docs scripts .github package.json
git commit -S -m "docs(security): operationalize abuse hardening" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Pull-request sequence

Implement as small, independently reviewable PRs in this order:

1. Tasks 1-3: shared application abuse controls.
2. Tasks 4-5: authentication, body limits, and idempotency.
3. Task 6: independent Worker edge limits.
4. Task 7: atomic budget reservations.
5. Task 8: concurrency and fair queueing.
6. Task 9: session and runner-key revocation.
7. Task 10: KEK versioning and rewrap.
8. Task 11: one-time credential leases.
9. Task 12: sandbox egress and cleanup.
10. Task 13: security telemetry and kill switches.
11. Task 14: deployment policy, drills, and staged enforcement.

Tasks 7-8 must land before increasing any run cap. Tasks 9-11 must land before onboarding tenants whose credentials have material external privileges. Task 12 is a production gate for unrestricted harness execution, not optional defense-in-depth.

## Success metrics

- Guest cost-bearing operations allowed: `0`.
- Cross-tenant authorization successes: `0`.
- Run reservations above tenant/global cap under race: `0`.
- Duplicate billed runs for one `runId`: `0`.
- Credential lease replay successes: `0`.
- Security events containing scanner-recognized secrets: `0`.
- Time to disable one high-cost feature: under 60 seconds.
- Time to revoke a browser session: under 60 seconds.
- Time to stop new cloud execution: under 60 seconds.
- Orphaned active-run recovery: under 2 minutes after timeout.
- Abuse limiter availability: at least 99.99%.
- Queue saturation alert latency: under 3 minutes.
