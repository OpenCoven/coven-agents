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
   later entitlement loss; it grants no new authorization. The Daytona adapter
   currently runs in the same server process as admission and receives only an
   opaque, lease-bearing `RunnerDispatchAuthority` minted from the exact
   database claim. It is re-fenced in SQL before preparation and launch and is
   never serialized to a browser, sandbox, queue, or provider. A separately
   deployed adapter would cross a trust boundary and therefore must replace
   this in-process capability with a strict, algorithm-pinned, short-lived,
   replay-fenced signed contract that binds the same tenant, agent, harness,
   operation, run, attempt, and authority-version scope.
4. **Credentials and dispatch stay server-only behind three neutral
   contracts.** `RunnerExecutor` owns dispatch preparation and starts;
   `RunnerReconciliationProvider` owns fenced per-attempt inspection and stop;
   and `RunnerPersistentResourceLifecycle` owns per-agent prewarm,
   decommission, stale/ambiguous recovery, reset, and bounded resource
   inventory. Tenant harness credentials are acquired through server-only
   custody, materialized for one attempt under the policy below, and never
   returned to browser code. Daytona SDK configuration, identifiers, and
   handles remain in the adapter.
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
    always requests bounded auto-stop and auto-archive values. CPU, memory,
    and disk come from the immutable pinned snapshot instead, because Daytona
    refuses a sandbox create that names them. Snapshot provisioning passes all
    three explicitly and verifies the resulting active profile; read-only
    `scripts/daytona-snapshot.ts --verify` verifies an existing immutable
    generation without creating or changing it. Missing, non-integer,
    non-finite, conflicting, undersized, or oversized resource metadata fails
    closed. Configured dispatch verifies the pinned profile before sandbox
    preparation. Dependency-free `lib/runner/daytona/resource-policy.ts`
    publishes the same policy defaults and caps used by the server parser;
    these constants are not attestation of a deployed snapshot. Public
    disclosures must distinguish policy defaults from verified deployment
    resources. Public previews are false;
    volumes, linked/forked sandboxes, and
    warm pools are not configured. TTL is explicitly disabled and automatic
    deletion remains disabled so valid persistent work cannot disappear
    outside fenced database recovery and decommission.

## Credential materialization policy

This ADR ratifies **staged attempt-file transport** as the selected equivalent
credential transport for the persistent Daytona lifecycle:

- One tenant-scoped persistent Daytona sandbox belongs to each product agent;
  runs do not create ephemeral per-run sandboxes. Its TTL is `0` and automatic
  deletion is `-1`; database- and generation-fenced lifecycle transitions are
  the only application deletion authority.
- Daytona Secrets are not used. They are neither a credential source of truth
  nor a fallback transport. The application credential row remains encrypted
  PostgreSQL custody until one server-owned acquisition returns a plaintext
  snapshot.
- After the pre-launch entitlement recheck, capacity reservation, and
  one-use lease, the final credential acquisition transaction locks and reads
  exactly one `(tenant, harness)` row. It decrypts one immutable plaintext
  snapshot into an opaque, one-use handle. It does not return a credential to
  a browser or durable provider configuration.
- The adapter makes one `executeCommand` staging call with exactly one
  environment entry: the selected harness-auth variable and that plaintext.
  Its fixed command applies `umask 077`, writes only the deterministic
  `(run, attempt)` credential path, changes it to mode `0600`, and verifies
  the mode. The staging environment is not the persistent sandbox
  configuration and is not the launched harness environment.
- The deterministic attempt session reads that file into its harness-auth
  variable, deletes the file before running the harness, unsets all other
  harness, provider-model, and control-plane credential variables, then
  `exec`s the harness. The harness command carries no control-plane secret or
  provider credential value. The sandbox has no durable harness credential.

The earlier heuristic that any environment injection requires an ephemeral
per-run sandbox is superseded because it conflates a persistent sandbox's
configuration or harness environment with this single, fixed, attempt-scoped
staging call. A blanket claim that credential plaintext remains entirely on
the server is also inaccurate: this policy intentionally transfers one tenant
harness plaintext from the server to its already-authorized sandbox. The real
boundaries are narrower and enforceable: no browser receives it, no
control-plane secret enters the sandbox, no Daytona Secret stores it, no
provider configuration retains it, and the launched attempt consumes and
deletes its only file.

### Replacement, deletion, and entitlement races

Credential replacement or deletion is ordered at acquisition, not by mutating
an acquired handle:

1. The final acquisition transaction locks the exact tenant-and-harness row
   while it reads one snapshot. A concurrent replacement or deletion waits
   for that transaction; an earlier completed replacement is the snapshot
   read, while an earlier completed deletion yields no credential.
2. Once returned, the handle cannot swap tenant, harness, or credential
   revision, cannot be serialized, and can invoke one launch boundary only.
   A later replacement or deletion affects later acquisitions only; it does
   not retroactively rewrite that authorized snapshot.
3. Initial dispatch validates current entitlement before context effects, and
   the runner revalidates it immediately before fresh credential acquisition
   and again before provider start. Revocation therefore prevents fresh
   acquisition or launch. It does not retroactively rewrite an exact, durably
   authorized and started `finish_current` attempt; that bounded recovery path
   neither acquires another credential nor starts a replacement.

### Attempt cleanup and recovery

The run and attempt UUIDs derive the only session and credential-file path an
attempt may address. Before staging, the adapter removes and confirms absence
of a stale session with that exact deterministic name; it never treats another
attempt's session or path as cleanup authority. A pre-launch failure removes
and verifies both exact resources before durable preparation can be released.
Terminal and cancellation cleanup likewise attempts the exact session and
path independently: a session deletion or lookup failure must not skip
credential removal or attempt capability cleanup. A Daytona `404` or `410`
confirms session absence, but still requires credential-path cleanup. File
verification rejects both existing paths and dangling symlinks.

Cleanup ambiguity, including a failed path check, cannot become a successful
start, stop, cancellation, or terminal result. A rejected staging request may
still write later, and a rejected asynchronous start may already have launched
the harness. Both retain the exact attempt fence and redaction envelope even
when immediate session/file cleanup succeeds. Attempt GitHub capabilities are
still revoked and their exact files removed. Only a known-settled pre-launch
failure with confirmed cleanup may release preparation.

Persistent reuse fails closed rather than depending on unverified Daytona
process-session containment. After any launched or possibly launched attempt,
the adapter returns `cleanup_required`, not `stopped` or
`provider_not_found`, even when the exact session and file are absent. This
retains the durable attempt/lease and blocks another dispatch; reconciliation
and cancellation do not translate this outcome into automatic workspace
deletion. Transient provider failures remain retryable without releasing the
fence. A stale session found before staging also blocks credential transfer.

Freshly created sandboxes carry `credentialBoundaryVersion: attempt-reset-v1`.
Configured dispatch refuses legacy sandboxes without this marker, since their
prior completed attempts may have already released their database fences under
the older policy. The marker is a compatibility gate, not deletion or adoption
authority; database tenant, attempt, version, and generation fences remain
authoritative.

An explicitly approved, fenced reset is required before reuse. No automatic
reset or new destructive operator endpoint is introduced by this policy.
Configuration drift, stale generation labels, and ambiguous provisioning also
refuse reuse without entering a destructive reset. Background recovery may
finish a reset after confirmed provider absence, but a legacy `resetting` row
alone cannot authorize deleting an existing workspace: earlier workers entered
that state automatically. An explicit reset or decommission request remains
the destruction boundary.
Reset and decommission remain independently fenced by the agent's durable
version and sandbox generation, so an old attempt cannot destroy a replacement
sandbox. Operators must preserve/export needed workspace data, approve any
destructive reset, and converge the old attempt cleanup before reprovisioning.
An explicit reset retry renews the agent-version fence only after revalidating
the exact attempt, run lease, tenant, and generation; it does not advance the
reset generation again. Deletion stays pinned to a recorded provider ID without
falling back to a reused name. An unrecorded ID requires the named observation
to match the authorized predecessor generation and ownership labels.
Ordinary session deletion is never sufficient evidence of descendant
termination for the complete process tree. This deliberately sacrifices
repeated-run availability until a workspace-preserving reset workflow or
separately approved destruction is available; provider-live containment and
reset acceptance remain release gates.

Provider diagnostics do not expose raw provider errors. Snapshot build output
is stream-redacted and capped at 65,536 characters per invocation; CLI failures
are fixed bounded messages. Attempt output retains its existing redaction and
bounded evidence contract.

## Provider adapter and rollback criteria

A provider adapter may be replaced only through a superseding ADR and a
versioned migration that proves:

- tenant and subscriber authority remain server-derived;
- an out-of-process adapter verifies a bounded signed dispatch contract before
  provider I/O rather than accepting a transferable in-process capability;
- tenant harness plaintext crosses only through an equivalent explicit,
  attempt-scoped transport with no browser, provider-configuration, or
  control-plane-secret exposure;
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
