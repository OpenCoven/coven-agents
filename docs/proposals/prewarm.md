# Proposal: prewarm the sandbox before the first prompt

Status: historical proposal, superseded by server-side Daytona prewarm.
Companion: `run-diagnostics.md`. Worker identity minting and sandbox details
below describe the pre-cutover design, not current application behavior.

## What the inspection found

The facts that constrain any prewarm design, with sources:

1. **There is no "the user's sandbox."** Sandbox identity is
   `SHA-256(tenant + "\0" + agentId)` (`worker/src/tenant.ts:84-111`) — one
   sandbox per *(tenant, agent)* pair. A user with no agents has nothing that
   can be warmed. Prewarming needs a target agent.
2. **Dependencies are already installed.** The harness CLIs are baked into the
   container image (`worker/Dockerfile`). The measured ~110s first-probe cost
   is container boot plus a Node CLI's first launch — not package
   installation. "Install and cache dependencies" is already done at image
   build; the winnable cost is *instance boot*.
3. **The sandbox is created lazily at run time** — the only `getSandbox` for
   run work is inside `driveHarness` (`worker/src/agents.ts:346-349`).
   Nothing before that point touches a container.
4. **Sign-in currently promises the opposite.** The login page states
   "signing in never starts an agent, sandbox, or run"
   (`app/(auth)/login/page.tsx:25-27`) and `scripts/demo-route.test.ts:86`
   asserts that exact string. Warming at sign-in changes a published product
   promise, not just code.
5. **Sign-in has exactly one server hook today**: the `jwt` callback's
   `account?.provider === "github"` branch (`app/(auth)/auth.ts:71-89`),
   which already does a DB write (`findOrCreateFederatedUser`). There is no
   adapter, no `events` block, no cron, no queue (`vercel.json` has no
   `crons`; the worker exports only `fetch`). `after()` from `next/server`
   is available and already used once (`app/(chat)/api/chat/route.ts:69`).
6. **Warm state would die of natural causes anyway**: shared sandboxes use
   `sleepAfter: "30s"`; per-agent sandboxes use the SDK default and the tail
   shows "Activity expired" container stops ~10 minutes after last use. A
   prewarmed instance only helps a user who runs within that window.
7. **Capacity and quotas**: the container pool caps at 10 lite instances
   (`worker/wrangler.jsonc:31-41`); the worker classifies diagnostics execs
   as "run" for rate limiting (`worker/src/abuse.ts:25-30`, 5/min/tenant);
   the app's provision routes are 10/min fail-closed
   (`lib/abuse/policy.ts:53-58`). A prewarm must not spend any of these
   budgets, and must never touch `/api/internal/credential` — that route
   *counts a run against the monthly cap* before returning
   (`app/api/internal/credential/route.ts:106-138`).

## Smallest safe implementation

Two stages. Stage 1 delivers most of the value with no schema change, no new
auth surface, and no change to the sign-in promise. Stage 2 adds the
sign-in trigger for returning users.

### Stage 1 — warm on agent creation and update (recommended first)

When `POST /api/agents` or `PUT /api/agents/:id` succeeds, the worker starts
a background warm of that agent's sandbox: `getSandbox(key)` + one bounded
`exec("<harness> --version")`. Creating a profile is the moment the user has
declared intent to run; it precedes the first prompt by exactly the time they
spend typing it — which is the boot window we need.

- **State**: `warm: { status: "not_started" | "provisioning" | "ready" |
  "failed", updatedAt: string }` stored in the `YoloAgent` DO next to the
  definition — the same place the sandbox's owner lives. **No Postgres
  change**: warm state is worker-plane state about a worker-plane object,
  and the DB has no runner tables today (verified: `lib/db/schema.ts` has
  none).
- **Exposure**: included in the agent envelope (`GET /api/agents/:id`), so
  the console can render "warming / ready" beside the profile with no new
  route.
- **Idempotency**: the warm runs as a DO fiber keyed `warm:<agentId>` using
  the same `idempotencyKey` mechanism runs use (`startFiber` in
  `worker/src/agents.ts`). A second trigger while one is in flight joins it;
  a trigger while `ready` and the container is live is a no-op. Duplicate
  sandboxes are impossible by construction — the sandbox key is
  deterministic and `getSandbox` returns the singleton DO.
- **Run-before-ready ("attach")**: needs no code. A run started mid-warm
  calls `getSandbox` with the same key and lands on the same container the
  warm is booting; the probe simply completes fast. The console's existing
  status events cover the loading state. (The 300s probe deadline shipped in
  `48a4801` already covers the fully cold worst case.)
- **Retry / timeout / cleanup**: one retry after a 30s backoff, both bounded
  by the probe deadline; terminal `failed` after that, cleared by the next
  trigger. Abandoned warm containers clean themselves via the existing
  activity expiry — set `sleepAfter: "10m"` explicitly on the run sandbox so
  the behaviour is chosen rather than inherited.
- **Rate limiting**: a new `warm` classification in `worker/src/abuse.ts`
  (limit ~5/hour/tenant), so warming spends neither the run budget nor the
  mutation budget. **Never** calls the credential route: no cap spend, no
  credential in scope, nothing to leak to the client.
- **Logs**: structured `sandbox.warm` events with the existing `traceId`
  scheme (`started`, `ready in Nms`, `failed: <name>`).

### Stage 2 — warm at sign-in for returning users

In the `jwt` callback's GitHub branch, after `findOrCreateFederatedUser`
succeeds **and the row is subscribed** (`isSubscribedAt`, which that code
path already has): `after(() => prewarmTenant(userId))`, where
`prewarmTenant` mints a server-side identity token (the app holds
`RUNNER_SIGNING_KEY`; `mintRunnerToken` is importable — this would be the
first server-side worker call, currently there are none) and calls a new
worker route `POST /api/tenant/prewarm`. The worker lists the tenant's
agents from the directory and triggers Stage 1's warm for **the single most
recently run agent** (`lastRunAt` is already on the definition). No agents →
204, nothing warmed.

- New registrants have no agents, so sign-in warms nothing for them — their
  first warm fires seconds later when they create their first profile
  (Stage 1). We do **not** auto-create an agent at sign-in.
- **The login-page promise must be edited in the same PR**, with its test
  (`scripts/demo-route.test.ts:86`): "signing in never starts an agent or a
  run" stays true; "never starts a sandbox" stops being true for subscribed
  returning users. Honest replacement: "Signing in starts no agent and no
  run. For subscribers we begin warming your sandbox so your first mission
  starts fast."
- **Failure is invisible by design**: `after()` runs post-response, the
  worker call has a short timeout, and any failure only means the first run
  is cold — never that sign-in breaks. (The abuse-limiter lesson from
  2026-08-25 applies: an optimization must not be able to take down the
  thing it optimizes.)

### API changes

| Surface | Change |
| --- | --- |
| Worker `POST/PUT /api/agents…` | fire-and-forget warm fiber after success |
| Worker agent envelope | adds `warm: { status, updatedAt }` |
| Worker `POST /api/tenant/prewarm` (Stage 2) | tenant-checked, idempotent, 202/204 |
| Worker `abuse.ts` | new `warm` classification with its own limit |
| App `auth.ts` jwt callback (Stage 2) | `after()` hook, subscribed users only |
| Contracts | `warmStateSchema`, envelope extension (additive) |

Schema changes to Postgres: **none.**

### Race conditions considered

- **Warm vs. run start**: same DO, same container; the run's exec queues
  behind or beside the warm exec in the sandbox session. Worst case the run
  probe waits for boot exactly as it does today.
- **Warm vs. decommission**: `decommission` destroys the sandbox; the warm
  fiber's exec then rejects and records `failed`. Decommission must also
  cancel the warm fiber by key (same pattern as `stop`).
- **Duplicate triggers** (double-click create, retried PUT): single-flight
  fiber key; the idempotency machinery already exists.
- **Container cap**: warm at most one sandbox per trigger, and treat a
  placement failure as `failed` silently — a full pool must degrade to
  today's cold start, never to a failed run.
- **Sign-in storm** (Stage 2): the per-tenant warm limit bounds it; a user
  signing in on five devices warms once.

### Tests

- Worker: warm state transitions (`not_started → provisioning → ready`,
  `→ failed` on exec error, retry-once), fiber idempotency under concurrent
  triggers, decommission-cancels-warm, warm never calls the credential
  fetcher (assert zero calls), tenant 404 on the Stage 2 route, warm
  excluded from run-classified rate limits.
- App (Stage 2): jwt callback fires `after` only for subscribed users;
  prewarm failure does not affect the sign-in response; login copy test
  updated deliberately.

### Open questions for the operator

1. Stage 1 alone, or both stages? (Stage 1 has no product-promise cost.)
2. Warm TTL: is `sleepAfter: "10m"` the right paid-idle window per warmed
   container, given the 10-instance cap?
3. Should demo tenants ever warm? (Proposed: no — they cannot run.)
