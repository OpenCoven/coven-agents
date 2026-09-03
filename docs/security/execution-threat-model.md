# Execution Threat Model

- Status: living document
- Owner: Security and privacy
- Applies to: Next.js control plane, Daytona execution, PostgreSQL run state,
  credential custody, evidence, and operations

## Scope and security goals

Coven Agents runs coding harnesses with approval prompts disabled. Security
therefore depends on who may request execution, which tenant and sandbox receive
it, which credentials enter it, what evidence may leave it, and how recovery
converges.

Goals:

1. A caller cannot select or access another tenant.
2. Guest and lapsed accounts cannot consume subscriber resources.
3. Harness credentials stay encrypted at rest, cross only through the
   ratified server-to-authorized-sandbox attempt staging transport, and remain
   attempt-scoped in Daytona.
4. Provider work is fenced by durable run, attempt, generation, and lease
   ownership.
5. Evidence is bounded and redacted before persistence or display.
6. Starts, streams, cancellation, and recovery remain safe under retries.
7. Missing identity, configuration, or ownership fails closed.
8. A persistent sandbox cannot be silently destroyed by provider TTL or
   auto-delete behavior, and unowned provider observations remain
   non-destructive.

## Actors and assumptions

Actors include anonymous clients, signed-in guests, subscribers, malicious
tenants, compromised browsers, untrusted repositories and prompts, operators,
and external providers.

Assumptions:

- browser traffic uses HTTPS and an httpOnly Auth.js session;
- secrets come from the deployment secret store;
- PostgreSQL is the durable execution source of truth;
- Redis holds admission and abuse state, not durable run ownership;
- Daytona isolates tenant execution from the application;
- a relevant host or provider compromise exposes credentials used there.

## Assets

| Asset | Custodian |
| --- | --- |
| Auth.js session | Browser cookie and control plane |
| Tenant identity and subscription | Control plane |
| Credential KEK ring | Server-only secret store |
| Tenant harness credential | Encrypted PostgreSQL row and one-use acquisition |
| Agent, run, event, and attempt records | Tenant-scoped PostgreSQL |
| Daytona resource identifiers | Fenced PostgreSQL records |
| Reconciliation credentials | Deployment and operator secret stores |
| Diagnostic credential | Deployment secret store |
| Guest replay fixture | Repository |

## Trust boundaries

### B1. Browser to same-origin control plane

The browser calls relative `/api` routes and authenticates only with the Auth.js
session. Agent and run handlers revalidate subscriber authority, derive tenant
scope, and enforce canonical-origin and media-type rules for mutations. No
browser response contains provider configuration or tenant harness plaintext.

### B2. Control plane to credential custody

Credential encryption and scope live in `lib/credentials/store.ts`.
`lib/credentials/runner-credential.ts` reserves capacity, binds one-use
authority, and returns an opaque one-use acquisition handle. Its final
acquisition transaction locks and reads exactly one tenant-and-harness row,
then returns one immutable plaintext snapshot. Replacement or deletion waits
for that read and affects later acquisitions; it cannot change tenant,
harness, or revision inside a returned handle. Pre-launch failure compensates
the exact usage, lease, and reservation.

### B3. Control plane to Daytona

`lib/runner/runtime.ts` revalidates account authority before capacity,
credential, sandbox, or provider work. Each agent owns one tenant-scoped
persistent sandbox. Every attempt has exact process and cleanup fences so
stale work cannot mutate a replacement attempt. The neutral
`RUNNER_MID_RUN_ENTITLEMENT_POLICY` distinguishes this pre-launch recheck from
a bounded `finish_current` continuation: only an exact, durable, running
attempt can reconcile after a later entitlement loss, and it still reaches the
15-minute run-duration bound.

After sandbox readiness and immediately before credential acquisition, the
runner rechecks the live account. It repeats that check after capacity
commit and before provider start, compensating the unstarted acquisition if
authority is gone. This closes the dispatch-time race for fresh acquisition
and launch; it does not alter one exact attempt already durably running under
`finish_current`.

The Daytona adapter is currently in-process. It does not accept a transferable
run token: admission mints an opaque `RunnerDispatchAuthority` from an exact
database dispatch claim, and preparation and launch recheck its run, attempt,
version, lease token, and durable state in SQL. Browser input cannot construct
or serialize that capability. Moving the adapter to another process would add
a new trust boundary and requires a strict signed, algorithm-pinned,
short-lived, replay-fenced contract that binds the same immutable dispatch
scope before any provider I/O.

The tenant harness credential is intentionally sent once from the server to
its authorized sandbox, but only through the fixed process staging command's
single per-call harness-auth environment value. That command uses `umask 077`,
writes the deterministic attempt path, and verifies mode `0600`. This staging
environment is neither persistent sandbox configuration nor the harness
environment. The attempt session reads it, immediately deletes the file,
unsets other harness/provider-model/control-plane credential variables, and
execs the harness. No Daytona Secret is used or treated as a source of truth.

`DAYTONA_API_KEY`, `RUNNER_MANUAL_RECONCILE_SECRET`, diagnostic bearers,
credential KEKs, Auth.js signing material, billing credentials, and database
credentials stay in server-side dependencies; they are neither staging inputs
nor harness environment values. This is enforced by the exact per-call staging
assertion in `lib/runner/daytona/process.test.ts` and the neutral/provider
dependency guards in `lib/runner/executor-boundary.test.ts`. A sandbox cannot
echo a control-plane value it was never given.

Before a new staging call, the adapter confirms absence of the same
attempt-derived session. Pre-launch, terminal, cancellation, and recovery
cleanup each address only the deterministic session and credential path.
Cleanup verifies path absence even when Daytona returns session `404` or
`410`. Any ambiguous deletion, lookup, or path check remains
cleanup/recovery/reset-required and cannot report a successful outcome.
Sandbox reset and decommission retain their independent durable version and
generation fences.

### B4. Reconciliation and diagnostics

Scheduled reconciliation, manual reconciliation, and diagnostics use distinct
credentials. Reconciliation uses database time, bounded leases, bounded event
pages, exact cleanup claims, and validated aggregate responses. It uses no
billing lookup to converge one already-authorized running attempt, and cannot
turn that recovery into a new credential acquisition or provider launch. A
provider or billing outage remains a deferral or refusal for unlaunched work,
not an eligibility upgrade.

### B6. Resource policy, inventory, and offboarding

Sandbox creation requests server-owned auto-stop and auto-archive values
rather than accepting provider defaults. CPU, memory, and disk are not named on
the create, because Daytona refuses a create that names them; a sandbox takes
them from the snapshot it was built from, and the pinned snapshot declares
none, so sandboxes currently run on provider defaults and no upper bound on
those three is enforced anywhere. Restoring one requires a snapshot built with
a policy the provider accepts. Public previews
are false; no volume, linked/forked sandbox, or warm-pool setting is used. TTL
is explicitly disabled and automatic deletion is disabled because each agent's
persistent workspace is deleted only by an existing database-fenced lifecycle
transition. The internal resource-inventory route uses reconciliation
credentials, lists only the application provider label, then hydrates only
list items that exactly match one durable provider mapping. It bounds both
provider and database scans and returns versioned aggregate counts only. It
does not adopt, reset, or delete a listed resource. Labels, names, and provider
IDs are observations; unmatched, duplicate, and policy-mismatched observations
require operator review.

### B5. Evidence to storage, UI, guest preview, and Git

`packages/agent-contracts/src/evidence.ts` redacts recognized secrets and
sensitive headers. `ExactEvidenceRedactions` is a neutral, immutable value
that examines at most 32 inputs and retains at most 16 nonblank, deduplicated
strings of at most 4096 UTF-16 code units; over-limit and empty candidates are
ignored. String and `null` credential call sites remain valid inputs.

Before `RunnerAttemptLogSnapshot` can cross the Daytona adapter,
`lib/runner/daytona/process.ts` adds the exact sandbox ID and name when the
SDK provides them, the deterministic session ID, command ID, and attempt ID
to this redaction value. `lib/runner/attempt-reconcile.ts` independently
rebuilds a bundle from persisted attempt/session/command IDs before it
projects events, summaries, errors, command evidence, or file paths into
neutral storage. The public product run ID is deliberately excluded: it is a
documented API identifier rather than provider-secret material.

Provider exceptions and messages do not enter persisted evidence or runner
envelopes. Diagnostics retain bounded category, status, and validated
machine-code fields only; inventory returns aggregate counts only; resource
observability copies only finite operation/outcome categories; and HTTP
failure logging uses only `runner_service` or `unknown`. Tenant-scoped store
reads make a foreign run and its event stream a nondisclosing 404. Daytona
reconciliation in `lib/runner/daytona/reconcile.ts` resolves one context by
the current run's deterministic tenant/agent sandbox name and has no
provider-inventory input, so another tenant's provider values cannot reach
that adapter. The adversarial fixtures use synthetic values only and cover an
attempt's credential, API-key-shaped text, reconcile bearer, signed claim,
sandbox ID/name, session, command, and attempt IDs; a tenant-B marker is
tested both as an exact redaction and as inaccessible tenant-A evidence.

Persistence applies size and count bounds. Guest fixtures are validated in raw
and parsed forms. Repository scanning reports only path, line, and category.

## Threat register

| ID | Threat | Controls | Residual work |
| --- | --- | --- | --- |
| T1 | Forged or stale identity reaches another tenant | Live account revalidation, server-derived tenant, scoped store methods | Session compromise remains useful until revocation |
| T2 | Guest, revoked, or lapsed authority reaches execution | Fail-closed session union, dispatch-time current-authority recheck, and bounded `finish_current` only after durable launch | Retain deployed revocation-before-launch and revocation-during-run evidence |
| T3 | Credential crosses tenant scope or persists in a sandbox | Tenant+harness AAD, final locked scoped snapshot, one-use acquisition, fixed one-value staging, immediate file deletion, exact compensation and sweeping | Plaintext exists briefly in server and authorized sandbox process memory; retain provider evidence that session deletion contains the complete process tree, or reset before persistent reuse |
| T4 | Database and KEK are both compromised | Per-row AES-GCM data keys and versioned wrapping | Combined compromise defeats encryption |
| T5 | Stale provider work mutates a replacement | Sandbox generation, attempt ID, version, and lease fences | New adapters must preserve equivalent fencing |
| T6 | Harness exfiltrates data | Daytona isolation and domain allowlist | Complete `coven-agents-cloud.4` |
| T7 | Retries create duplicate work | Operation IDs, request hashes, durable admission | Prove against release-equivalent persistence |
| T8 | SSE reconnect loses or duplicates events | Persisted numeric event IDs and `Last-Event-ID` | Retain production-equivalent reconnect evidence |
| T9 | Output leaks secrets or provider correlations | Shared shape and bounded exact redaction, adapter and neutral-projection defense in depth, sanitized errors, categorical diagnostics/logs | `coven-agents-security.3` remains open: retain a deployed Daytona attempt and browser/API inspection proving the provider and cross-tenant paths behave equivalently; this local slice does not close the broader security program |
| T10 | Cancellation or recovery reports false success | Durable intent, exact cleanup, leased reconciliation | Provider outages can delay convergence |
| T11 | Capacity exhaustion harms availability | Abuse budgets and deployment/tenant queue limits | Tune from measured provider behavior |
| T12 | Operator credential gains tenant authority | Operator credentials authorize only bounded operational routes | Protect operator machines and deployment secrets |
| T13 | A provider-only or drifted sandbox is adopted or deleted by label | Read-only app-label inventory, exact durable mapping comparison, exclusive privacy-safe ambiguity reasons, fixed configuration-drift field/direction counts, existing fenced recovery only | An operator must investigate and separately authorize any unmatched provider resource |

## Incident and recovery expectations

- Revoke affected account or credential authority first.
- Treat credential replacement or deletion as forward-looking: it blocks later
  acquisition, but does not mutate a plaintext snapshot already acquired by an
  exact authorized launch. Entitlement revocation prevents fresh acquisition;
  only the bounded exact-attempt `finish_current` recovery may continue.
- Rotate the active secret, redeploy, and prove the old value is rejected.
- Preserve PostgreSQL cleanup ownership until Daytona absence and database
  finalization are confirmed.
- Keep recovery idempotent, cursor-bounded, lease-bounded, and exact-attempt
  fenced.
- Never turn ambiguous provider state into a success result.
- When session or credential-file absence cannot be confirmed, retain the
  cleanup record and reset the fenced persistent sandbox before reuse. Do not
  stage a new credential into that ambiguous attempt.
- Use the bounded internal inventory before a resource-offboarding exercise;
  it is evidence only. Decommission app-owned resources through the durable
  application lifecycle, and never delete or adopt a resource from a label,
  name, or provider list result alone.
- Follow [Security incident response](incident-response.md).

## Verification and review

Primary executable evidence:

- `lib/runner/production.test.ts`
- `lib/runner/auth.test.ts`
- `lib/runner/http.test.ts`
- `lib/credentials/runner-credential.test.ts`
- `lib/credentials/store.test.ts`
- `lib/runner/admission.test.ts`
- `lib/runner/store.test.ts`
- `lib/runner/sse.test.ts`
- `lib/runner/reconcile.test.ts`
- `lib/runner/evidence.test.ts`
- `lib/runner/daytona/process.test.ts`
- `lib/runner/daytona/names.test.ts`
- `lib/runner/daytona/sandbox.test.ts`
- `lib/runner/daytona/resource-inventory.test.ts`
- `lib/runner/resource-observability.test.ts`
- `lib/runner/http.test.ts`
- `lib/runner/production.test.ts`
- `lib/runner/executor-boundary.test.ts`
- `packages/agent-contracts/src/evidence-safety.test.ts`
- `scripts/product-boundary.test.ts`
- `scripts/security-docs.test.ts`

Run the repository gates before merging a security-boundary change. These gates
verify repository behavior only. Production certification still requires a
separate operator attestation with a credential-free, retained deployed
Daytona attempt, internal inventory/diagnostic response capture, browser
runner envelope/SSE capture, and a cross-tenant refusal check. No deployed
proof is represented by these local assertions.
