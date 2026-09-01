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
3. Harness credentials stay encrypted at rest, server-only in transit, and
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
authority, reads the tenant credential, and returns an opaque acquisition
handle. Pre-launch failure compensates the exact usage, lease, and reservation.

### B3. Control plane to Daytona

`lib/runner/runtime.ts` revalidates account authority before credential or
provider work. Each agent owns one tenant-scoped persistent sandbox. Every
attempt has exact process and cleanup fences so stale work cannot mutate a
replacement attempt.

### B4. Reconciliation and diagnostics

Scheduled reconciliation, manual reconciliation, and diagnostics use distinct
credentials. Reconciliation uses database time, bounded leases, bounded event
pages, exact cleanup claims, and validated aggregate responses.

### B6. Resource policy, inventory, and offboarding

Sandbox creation requests server-owned CPU, memory, disk, auto-stop, and
auto-archive values rather than accepting provider defaults. Public previews
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
sensitive headers. Persistence applies size and count bounds. Guest fixtures
are validated in raw and parsed forms. Repository scanning reports only path,
line, and category.

## Threat register

| ID | Threat | Controls | Residual work |
| --- | --- | --- | --- |
| T1 | Forged or stale identity reaches another tenant | Live account revalidation, server-derived tenant, scoped store methods | Session compromise remains useful until revocation |
| T2 | Guest or lapsed authority reaches execution | Fail-closed session union and dispatch-time recheck | Complete provider-event transition hardening |
| T3 | Credential crosses tenant scope | Tenant+harness AAD, one-use acquisition, exact compensation | Plaintext exists briefly in server and process memory |
| T4 | Database and KEK are both compromised | Per-row AES-GCM data keys and versioned wrapping | Combined compromise defeats encryption |
| T5 | Stale provider work mutates a replacement | Sandbox generation, attempt ID, version, and lease fences | New adapters must preserve equivalent fencing |
| T6 | Harness exfiltrates data | Daytona isolation and domain allowlist | Complete `coven-agents-cloud.4` |
| T7 | Retries create duplicate work | Operation IDs, request hashes, durable admission | Prove against release-equivalent persistence |
| T8 | SSE reconnect loses or duplicates events | Persisted numeric event IDs and `Last-Event-ID` | Retain production-equivalent reconnect evidence |
| T9 | Output leaks secrets | Shared redaction, bounded evidence, sanitized errors | Extend `coven-agents-security.3` |
| T10 | Cancellation or recovery reports false success | Durable intent, exact cleanup, leased reconciliation | Provider outages can delay convergence |
| T11 | Capacity exhaustion harms availability | Abuse budgets and deployment/tenant queue limits | Tune from measured provider behavior |
| T12 | Operator credential gains tenant authority | Operator credentials authorize only bounded operational routes | Protect operator machines and deployment secrets |
| T13 | A provider-only or drifted sandbox is adopted or deleted by label | Read-only app-label inventory, exact durable mapping comparison, aggregate ambiguous/unowned categories, existing fenced recovery only | An operator must investigate and separately authorize any unmatched provider resource |

## Incident and recovery expectations

- Revoke affected account or credential authority first.
- Rotate the active secret, redeploy, and prove the old value is rejected.
- Preserve PostgreSQL cleanup ownership until Daytona absence and database
  finalization are confirmed.
- Keep recovery idempotent, cursor-bounded, lease-bounded, and exact-attempt
  fenced.
- Never turn ambiguous provider state into a success result.
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
- `lib/runner/admission.test.ts`
- `lib/runner/store.test.ts`
- `lib/runner/sse.test.ts`
- `lib/runner/reconcile.test.ts`
- `scripts/product-boundary.test.ts`
- `scripts/security-docs.test.ts`

Run the repository gates before merging a security-boundary change. These gates
verify repository behavior; production certification requires the separate
operator attestation.
