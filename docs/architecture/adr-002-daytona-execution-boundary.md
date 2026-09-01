# ADR-002: Daytona execution boundary

- Status: Accepted
- Date: 2026-08-29
- Decision owner: OpenCoven
- Scope: browser execution access, server dispatch, provider lifecycle, and
  durable run ownership

## Context

Execution previously accumulated multiple authority shapes and transport
assumptions. That made browser identity, credential custody, provider dispatch,
and recovery harder to reason about. The product now has a single execution
path whose authority begins at the application session and whose durable state
remains in PostgreSQL.

## Decision

1. **Daytona is the sole execution provider.** Every supported production
   agent lifecycle and run attempt is dispatched through its server-side
   adapter. The hermetic adapter is certification-only and is unavailable in
   production.
2. **Browser APIs are relative and same-origin.** Browser code calls `/api`
   routes and authenticates only with the httpOnly Auth.js application session.
3. **Authority is server-derived.** Route handlers revalidate the current
   subscriber account and derive the tenant; request bodies cannot select
   either value. Every unlaunched dispatch rechecks the current account before
   effects. The provider-neutral runner policy permits only a durable,
   `running` attempt to `finish_current` within its 15-minute bound after a
   later entitlement loss; it grants no new authorization.
4. **Credentials and dispatch stay server-only behind three neutral
   contracts.** `RunnerExecutor` owns dispatch preparation and starts;
   `RunnerReconciliationProvider` owns fenced per-attempt inspection and stop;
   and `RunnerPersistentResourceLifecycle` owns per-agent prewarm,
   decommission, stale/ambiguous recovery, reset, and bounded resource
   inventory. Tenant harness credentials are acquired through server-only
   custody, staged for one attempt, and never returned to browser code.
   Daytona SDK configuration, identifiers, and handles remain in the adapter.
5. **PostgreSQL owns execution truth.** Agent, run, event, operation,
   admission, dispatch, attempt, cancellation, sandbox, and reconciliation
   records are durable database state. Provider observations update those
   records only through exact fences. A label, deterministic name, or
   provider-list result is an observation rather than deletion or adoption
   authority.
6. **There is one execution path.** Unavailable Daytona configuration or
   provider service produces an explicit unavailable result; the application
   does not switch to another executor.
7. **Starts are idempotent.** An operation identifier and request hash suppress
   duplicate starts and reject conflicting reuse.
8. **SSE is cursor-safe.** Events are persisted with ordered numeric IDs.
   Clients resume with `Last-Event-ID`; the server emits only later events,
   closes on terminal state, and uses a bounded idle timeout.
9. **Recovery is bounded.** Reconciliation uses database-time leases,
   generation and attempt fencing, bounded event pages, exact cleanup claims,
   and explicit cleanup-required outcomes. It may converge or clean one exact
   `finish_current` attempt without consulting billing again, but may not
   create a replacement attempt after entitlement loss. Inventory is separately
   read-only, list-bounded, and returns only versioned aggregate ownership and
   lifecycle categories.
10. **Persistent resources use explicit server policy.** Sandbox creation
    always requests bounded CPU, memory, disk, auto-stop, and auto-archive
    values. Public previews are false; volumes, linked/forked sandboxes, and
    warm pools are not configured. TTL is explicitly disabled and automatic
    deletion remains disabled so valid persistent work cannot disappear
    outside fenced database recovery and decommission.

## Provider adapter and rollback criteria

A provider adapter may be replaced only through a superseding ADR and a
versioned migration that proves:

- tenant and subscriber authority remain server-derived;
- credential plaintext never crosses the server boundary;
- persistent per-agent workspace ownership and deletion semantics are
  equivalent;
- idempotent starts, cursor-safe event replay, bounded evidence, cancellation,
  and reconciliation preserve their database fences;
- resource inventory, least-privilege networking, diagnostics, and cleanup are
  observable;
- rollback can return application traffic to the previously verified release
  without assigning two providers ownership of the same agent or attempt.

Application rollback means redeploying a previously verified application
version whose schema remains forward-readable. It must not reinterpret durable
provider ownership or bypass cleanup. If a schema or provider operation is not
reversible, promotion requires a forward-fix plan and an explicit operator
approval record.

## Backend discriminator migration

The v1 public contract retains `backend: "cloud"` and health `mode: "cloud"` as
stable deployment-class discriminators. The value means remotely deployed; it
does not name, discover, or select an execution provider. `runtime` selects the
harness from the supported `codex`, `claude`, and `copilot` values.

Changing the provider does not justify changing this v1 wire value. A future
contract version should either remove the discriminator or replace it with an
explicit provider field, with dual-read, single-write migration, inventory
counts, and a retirement gate for old clients and rows.

## Consequences

Positive:

- browser authentication and execution authorization share one session model;
- provider and tenant credentials stay outside browser code;
- PostgreSQL provides one recoverable source of execution truth;
- lifecycle failures are explicit and testable;
- duplicate requests and reconnecting streams are safe.
- resource cost and lifecycle values do not silently inherit provider defaults;
- unmatched provider observations are visible without becoming destructive.

Costs:

- Daytona unavailability directly affects execution availability;
- production readiness requires retained lifecycle and cleanup evidence;
- provider changes require a deliberate contract and data migration.

## Enforcement

- Browser routes and headers: `lib/agents/browser-transport.ts`
- Session and tenant enforcement: `lib/runner/http.ts`
- Provider-neutral runtime composition: `lib/runner/runtime.ts`
- Provider lifecycle contract: `lib/runner/resource-lifecycle.ts`
- Daytona lifecycle: `lib/runner/daytona/`
- Durable ownership: `lib/runner/store.ts`
- Idempotent admission: `lib/runner/admission.ts`
- Cursor-safe events: `lib/runner/sse.ts`
- Attempt recovery and cleanup: `lib/runner/attempt-reconcile.ts`
- Persistent resource recovery: `lib/runner/daytona/resource-recovery.ts`
- Read-only resource inventory: `lib/runner/daytona/resource-inventory.ts`
- Executable guardrails: `scripts/product-boundary.test.ts`,
  `lib/runner/service.test.ts`, `lib/runner/store.test.ts`,
  `lib/runner/sse.test.ts`, `lib/runner/reconcile.test.ts`, and
  `lib/runner/resource-lifecycle.test.ts`

Review this ADR for any browser transport, credential acquisition, provider,
run-state, SSE, reconciliation, or backend-schema change.
