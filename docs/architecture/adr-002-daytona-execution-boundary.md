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

1. **Daytona is the sole execution provider.** Every supported agent lifecycle
   and run attempt is dispatched through the server-side Daytona adapter.
2. **Browser APIs are relative and same-origin.** Browser code calls `/api`
   routes and authenticates only with the httpOnly Auth.js application session.
3. **Authority is server-derived.** Route handlers revalidate the current
   subscriber account and derive the tenant; request bodies cannot select
   either value.
4. **Credentials and dispatch stay server-only.** Tenant harness credentials
   are acquired through server-only custody, staged for one attempt, and never
   returned to browser code. Daytona configuration is server-only.
5. **PostgreSQL owns execution truth.** Agent, run, event, operation,
   admission, dispatch, attempt, cancellation, sandbox, and reconciliation
   records are durable database state. Provider observations update those
   records only through exact fences.
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
   and explicit cleanup-required outcomes.

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

Costs:

- Daytona unavailability directly affects execution availability;
- production readiness requires retained lifecycle and cleanup evidence;
- provider changes require a deliberate contract and data migration.

## Enforcement

- Browser routes and headers: `lib/agents/browser-transport.ts`
- Session and tenant enforcement: `lib/runner/http.ts`
- Dispatch-time authority: `lib/runner/runtime.ts`
- Daytona lifecycle: `lib/runner/daytona/`
- Durable ownership: `lib/runner/store.ts`
- Idempotent admission: `lib/runner/admission.ts`
- Cursor-safe events: `lib/runner/sse.ts`
- Recovery and cleanup: `lib/runner/reconcile.ts`
- Executable guardrails: `scripts/product-boundary.test.ts`,
  `lib/runner/service.test.ts`, `lib/runner/store.test.ts`,
  `lib/runner/sse.test.ts`, and `lib/runner/reconcile.test.ts`

Review this ADR for any browser transport, credential acquisition, provider,
run-state, SSE, reconciliation, or backend-schema change.
