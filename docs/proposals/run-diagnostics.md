# Proposal: run diagnostics, sanitized export, and recovery

Status: proposed, not implemented. Companion: `prewarm.md`.

## The run state machine as it exists

Contract states (`packages/agent-contracts/fixtures/agent-runner-v1.json`):
`queued → running → completed | failed | cancelled`. Terminal is decided by
`isTerminal` (`lib/console/blocks.ts`). Above the run sits the connection
layer (`lib/agents/connection-status.ts`): `provisioned / rate_limited /
signed_out / subscription_required / unavailable / unconfigured`.

A run's lifecycle crosses these services, in order:

| Stage | Where | Bounded today by |
| --- | --- | --- |
| authentication | next-auth, `app/(auth)/auth.ts` | OAuth flow itself |
| provision | `GET /api/runner-connection` (`lib/agents/provision.ts`) | fetch failure only |
| identity mint | `POST /api/runner-token`, TTL 900s | throws on failure |
| run accept | worker `POST /api/agents/:id/runs` → 202 | rate limits, plan gate |
| credential + cap | worker → app `/api/internal/credential` | counted **before** return |
| sandbox boot + probe | `driveHarness` → `getSandbox` → probe | 300s probe deadline |
| execution | harness exec | 900s run deadline |
| streaming | SSE `/api/runs/:id/events`, reconnect loop | 1s backoff loop |
| persistence | DO `persistRun`, bounded history (20 terminal) | DO storage |
| cleanup | activity expiry, `decommission` | container idle timer |

## Where a user can get stuck today (verified)

1. **Sticky provision verdicts.** `provisionConnection` caches
   `signed_out`, `subscription_required`, and `unconfigured` for the life of
   the page (`lib/agents/provision.ts:31-66`). A user who subscribes
   mid-session stays "no subscription" until a manual reload. Only
   `rate_limited` (timer) and network errors self-clear.
2. **Failed runs are dead ends.** The thread shows the failure text; the
   only affordances are composing a new mission or deleting the profile.
   No retry preserving the prompt, no diagnostics export.
3. **Stall looks like progress.** Between `running` and the 900s deadline
   there is no heartbeat; a wedged exec is a breathing dot for 15 minutes.
   The stream can be silently idle — the worker also closes streams on idle
   timeout, and the console's reconnect loop hides the distinction.
4. **Unknown outcomes at refresh.** Since `1fbf857` a refresh rehydrates
   history and reattaches to a live run, but a run whose fiber died with the
   DO (rare: worker redeploy mid-run) stays `running` in storage forever —
   nothing reconciles it.
5. **Identity expiry mid-session**: tokens live 900s with a 60s refresh
   margin (`lib/agents/identity.ts`); the minter throws on re-mint failure
   and the error surfaces as a toast with no retry affordance.

Existing assets to build on (do not reinvent): every worker sandbox log
already carries a `traceId` (`tr_…`) and structured
`{event, outcome, durationMs}`; runs already have UUIDs and
`operationId`-based dedupe (double-click, refresh, and retry-safe **at the
accept boundary** — `planCloudRunStart` returns `existing` for a repeated
operation id); the stream cursor (`lastEventId`) makes reconnection
duplicate-free; `RunnerApiError` already separates `code` from message.

## Smallest safe implementation

### 1. Correlation and timeline (worker + contracts, additive)

- The run id **is** the correlation id. Add it to every log the worker emits
  for that run (today only sandbox logs carry `traceId`; route-level logs
  don't name the run). Client sends nothing new — the id already travels in
  every path.
- Add a `timeline` to the run record: an append-only array of
  `{stage, at, outcome: "ok" | "failed" | "timeout", durationMs?,
  errorCategory?, errorName?}` for the stages in the table above, written by
  `driveHarness` at the points it already passes through. Bounded (one entry
  per stage per attempt), inside the existing `CloudRunRecord` so it
  persists and replays with the run. Exposed in the run envelope.
- **Error taxonomy** as a closed enum, mapped where errors are already
  named: `user` (bad input, unauthenticated harness), `service_temporary`
  (store/socket failures), `timeout` (deadline races), `rate_limited`,
  `configuration` (missing env, unconfigured), `internal` (everything
  else). The worker's `fail()` already sanitizes `{name, message, stack}` —
  extend it to also stamp the category. Original error stays in worker logs
  only; the user-facing message stays short, as `harnessFailureMessage`
  does today.

### 2. Sanitized diagnostics export (console, pure function + tests)

A `buildDiagnosticsReport(run, connectionKind, versions)` pure function in
`lib/console/`, rendered behind a "Copy diagnostics" action on failed and
stalled runs.

- **Allowlist, not redaction-by-pattern**: the report is *constructed* from
  named safe fields — run id, agent id, harness id, model, statuses,
  timeline entries, event ids/types/timestamps (never event payload text,
  never the task, never file contents), error category + error name (never
  message bodies, which can embed URLs), app version (`NEXT_PUBLIC` build
  id), contract `apiVersion`, connection kind, retry history. Nothing else
  can enter, so tokens/cookies/env values are excluded by construction.
- A secondary pattern pass (the existing secret-scan patterns) runs over the
  final string as a tripwire: if it matches anything, the copy is refused
  with "diagnostics could not be verified as sanitized" — the report never
  claims safety it didn't verify.
- Header states: "Sanitized diagnostics — constructed from an allowlist of
  non-sensitive fields."

### 3. Recovery affordances (console)

For every non-`provisioned` connection state and every terminal-failed or
stalled run, exactly one primary next action:

| State | Action | Mechanics |
| --- | --- | --- |
| run `failed` | **Retry run** | same task, *new* operation id; prompt prefilled |
| stream dead, run live | **Reconnect** | existing loop, surfaced as a button + attempt count |
| stalled (no event > stage budget) | **Check status** → then Retry/Stop | reconcile via `getRun` before offering anything |
| `rate_limited` | countdown + auto-clear | exists; add visible countdown |
| `subscription_required` / `signed_out` / `unconfigured` | **Re-check** | clear the provision cache (`resetProvisionCache` stops being test-only) and re-fetch |
| unrecoverable | **Start fresh** + Copy diagnostics | explains what is discarded first |

- **Reconcile before retry**: a "stalled" verdict is only ever advisory;
  the button's first act is `getRun`, and the offer changes if the backend
  says the run finished. Unknown is never marked failed.
- **Idempotency**: retries reuse the operation-id machinery; "Retry run" is
  a new operation (a new run is the intent), double-clicks on the same
  button share one in-flight promise. No client-side charge or sandbox can
  duplicate — the worker's accept path already dedupes.
- **Automatic retries** stay where they already exist (stream reconnect,
  provision rate-limit timer) and gain bounds + jitter; everything else is
  user-initiated. Attempt counts render in the pill; cancel = the existing
  Stop.

### 4. Stall detection (console, per-stage budgets)

Client-side budgets, all advisory: provision > 10s, accept > 10s, first
event > 330s (probe deadline + margin), event gap > 120s while `running`,
persistence (final snapshot after `completed` event) > 10s. Exceeding a
budget flips the UI to "stalled — check status", it never flips the run
record. Server truth wins on reconcile.

The one server-side addition: a reconciler in the DO — when `getRun` finds a
non-terminal run whose fiber is no longer registered (worker restarted
mid-run), it closes the record as `failed / service_temporary` with a
timeline entry, instead of leaving `running` forever (stuck-state 4 above).

### Tests

- `buildDiagnosticsReport`: allowlist completeness (a run stuffed with
  secret-shaped strings in task/output/events yields none of them),
  tripwire refusal path, format snapshot.
- Retry: new operation id per retry; double-click shares one promise;
  refresh mid-retry does not duplicate (operation-id replay returns
  `existing`).
- Stall: budgets flip UI state, reconcile with a `completed` backend answer
  clears the stall without retry; unknown outcome never marked failed.
- Reconciler: non-terminal record + dead fiber → `failed` with category;
  live fiber untouched.
- Provision cache: `subscription_required` clears on explicit re-check.

### Sequencing

1. Error taxonomy + timeline (worker/contracts, additive) — everything else
   reads from it.
2. Diagnostics report + copy action (pure, testable, immediately useful for
   bug reports).
3. Recovery affordances + provision-cache re-check.
4. Stall budgets + DO reconciler.

### Remaining failure modes (out of scope, named honestly)

- A worker redeploy still kills in-flight fibers; the reconciler converts
  that to a clean failure, it does not resume execution.
- Container-side zombies keep running until sandbox destroy; the run is
  bounded, the container's CPU is not.
- Client clocks: stall budgets use client time; a suspended laptop may show
  a false stall until reconcile corrects it.
