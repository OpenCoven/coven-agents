# Execution Threat Model

- Status: living document
- Owner: Security & privacy workstream
- Companion to: [Security incident response](incident-response.md)
- Applies to: Next.js control plane, Daytona runner, shared contracts, guest
  publication, and operator credentials

## Scope and security goals

Coven Agents launches coding harnesses with approval prompts disabled. The
security boundary is therefore which identity may request execution, which
tenant and sandbox receive it, which credentials enter it, what evidence may
leave it, and how much work may be consumed.

This model covers:

- the same-origin Next.js control plane and PostgreSQL state;
- the server-side Daytona runner and its persistent per-agent sandboxes;
- credential custody, reservations, one-use leases, and cleanup;
- normalized run evidence and committed guest-preview fixtures;
- operator diagnostics and automated/manual reconciliation.

Security goals:

1. A caller cannot act as another tenant or access another tenant's agent,
   sandbox, credential, run, or database state.
2. Guest and unsubscribed identities cannot obtain subscriber execution or
   persistence authority.
3. Harness credentials remain encrypted at rest, never reach a browser, and
   exist in provider storage only as a transient mode-`0600` launch file.
4. Provider work is fenced by durable run, attempt, sandbox-generation, and
   lease authority.
5. Secret-like output and provider details are removed before persistence or
   user-visible evidence.
6. Request bodies, output, execution time, queue depth, and repeated work are
   bounded and fail closed.
7. Missing identity, configuration, account authority, or recovery ownership
   never becomes permission.

Out of scope:

- the internal security of GitHub, Daytona, Stripe, or a model provider;
- preventing an authorized harness from changing files in its granted
  workspace;
- treating natural-language prompts as trusted instructions;
- live production certification or confirmation that a separately deployed
  legacy runtime has been decommissioned.

## Actors and assumptions

Relevant actors include unauthenticated clients, signed-in guests, subscribers,
malicious tenants, compromised browsers, untrusted repositories and prompts,
operators, and external providers.

Assumptions:

- browser traffic uses HTTPS and an httpOnly Auth.js application session;
- server secrets come from the deployment secret store, not tracked files;
- PostgreSQL is the durable runner source of truth and Redis stores only abuse
  and admission budget state;
- Daytona isolates tenant processes from the control plane;
- provider credentials may be revoked externally and are treated as exposed
  after a relevant process, host, or storage compromise.

## System and data flow

1. GitHub authentication maps a browser to a Coven Agents account.
2. A same-origin Route Handler revalidates current subscription and
   `authVersion`, derives the tenant server-side, and enforces origin, media
   type, abuse, body, and ownership checks in that order.
3. Admission stores the trusted authority version and returns a durable,
   fenced scheduling decision.
4. `lib/runner/production.ts` rechecks current account authority before
   provider or credential work.
5. `lib/credentials/runner-credential.ts` reserves capacity, issues a one-use
   lease, prepares and reads the tenant credential, and returns an opaque
   acquisition handle.
6. Daytona stages the credential in an attempt-scoped mode-`0600` file, removes
   it before harness execution, and runs an attempt-scoped process session in
   the agent's persistent sandbox.
7. Reconciliation reads provider state, appends only new bounded events,
   redacts evidence, terminalizes with exact fences, and retries ambiguous
   cleanup.

The repository contains no Cloudflare Worker runtime, browser runner token,
runner signing key, verification-key configuration, or Worker-facing internal
credential/authority endpoint. Removing code does not prove that an external
deployment has been disabled; operators must verify that separately after the
current release is proven.

## Assets

| Asset | Why it matters | Primary custodian |
| --- | --- | --- |
| Application session | Authenticates browser requests | httpOnly cookie and control plane |
| Tenant identity and entitlement | Determines persistence and execution authority | Control plane |
| Credential KEK ring | Decrypts tenant credential data keys | Control plane only |
| Tenant harness credential | Acts as the tenant at a coding provider | Encrypted database row and one-use server acquisition |
| Runner reconciliation credentials | Permit automated or manual recovery | Vercel and operator secret stores |
| Operator diagnostic credential | Permits bounded provider diagnostics | Vercel secret store |
| Agent, run, and evidence records | May contain private task or repository context | Tenant-scoped PostgreSQL |
| Daytona sandbox and process IDs | Address provider resources | Fenced server-side records |
| Guest replay fixtures | Public execution evidence | Repository |

## Trust boundaries

### B1. Browser to same-origin control plane

The browser is untrusted. Agent and run routes use the Auth.js session only,
then re-read server-owned subscriber authority. Mutations enforce the canonical
application origin and JSON media type before authentication or body parsing.
Reads and SSE do not require `Origin`. No browser route returns plaintext
credentials, provider secrets, runner tokens, signing keys, or service tokens.

### B2. Control plane to credential custody

Browser credential routes expose configured harness IDs only. Writes are
subscriber-gated and encrypted before storage. Runner credential acquisition is
server-only and orders capacity reservation, immutable lease issuance,
credential preparation, and side-effect-free read before launch. Failures are
sanitized, and pre-launch failures atomically compensate the exact lease,
reservation, and usage row.

Credential encryption and tenant/harness scoping live in
`lib/credentials/store.ts`; launch acquisition lives in
`lib/credentials/runner-credential.ts`.

### B3. Control plane to Daytona

One persistent tenant-scoped sandbox belongs to each agent. Every run has
attempt-scoped process identifiers and durable database fences. A delayed or
stale callback cannot attach, finalize, clean, or release a replacement
attempt. Provider-first deletion and cleanup-required states prevent false
success when remote absence is not confirmed.

### B4. Reconciliation and diagnostics

Cron, manual reconciliation, and diagnostics use separate bounded secrets.
Abuse admission occurs before secret validation. Diagnostics compose through a
separate dependency seam, so diagnostic construction failures cannot affect
health, subscriber routes, or reconciliation. Reconciliation is leased using
database time and exposes only validated aggregate counts.

### B5. Evidence to storage, UI, guest preview, and Git

`packages/agent-contracts/src/evidence.ts` removes recognized credentials,
sensitive assignments, headers, and explicit attempt secrets. Stored evidence
is bounded and redacted again before terminal persistence. Guest fixtures are
strict-schema and scanned in raw and parsed form. `scripts/secret-scan.ts`
reports only path, line, and category.

## Abuse-control policy maxima

`lib/abuse/policy.ts` is the reviewed source of truth. Current runner classes
separate public read, subscriber read/write, paid run start, stop, diagnostic,
and reconcile traffic. Production policy-store outages fail closed. Admission
also enforces deployment, tenant-active, tenant-queue, and consecutive-tenant
limits; capacity configuration cannot raise code-defined maxima.

Changes to subjects, body ceilings, windows, failure modes, or maxima require a
reviewed code change and rollback criteria chosen before enforcement.

## Threat register

| ID | Threat and impact | Current controls and verification | Residual risk or follow-up |
| --- | --- | --- | --- |
| T1 | Forged or stale identity reaches another tenant. | Same-origin session authorization, live account revalidation, tenant-scoped store methods, nondisclosing 404s. | Session compromise remains usable until revocation. |
| T2 | A shared secret becomes tenant authority. | No browser runner/service token exists; operator secrets authorize only diagnostics or reconciliation and never select a tenant. | Protect deployment secret stores and operator machines. |
| T3 | Guest or lapsed authority gains execution. | Guest decisions fail closed; run admission stores `authVersion`; production dispatch revalidates before credential/provider work. | Provider-ingestion hardening remains tracked by `coven-agents-security.2`. |
| T4 | A tenant receives another tenant's credential. | Tenant+harness encryption scope, run-bound one-use leases, exact reservation and cleanup ownership. | Plaintext exists briefly in server and harness-process memory. |
| T5 | Credential storage is copied. | Per-row AES-GCM data keys wrapped by exact KEK versions; non-extractable imports; verified resumable rewrap. | Database plus KEK compromise defeats encryption. |
| T6 | Provider identifiers collide or stale cleanup deletes replacements. | Deterministic tenant-scoped names, sandbox generation, attempt ID, version, and lease fences. | New provider adapters must preserve the same ownership model. |
| T7 | A harness escapes or exfiltrates. | Daytona sandbox isolation and least-privilege domain allowlist. | Complete remaining egress work in `coven-agents-cloud.4`. |
| T8 | Runs exhaust paid or provider capacity. | Idempotent operation IDs, one active run per agent, Redis request budgets, durable queue limits, and pre-decryption run reservations. | Capacity tuning requires production evidence. |
| T9 | Output leaks credentials or private provider details. | Shared redaction, bounded evidence, sanitized errors/logs, guest fixture scans. | Pattern-based redaction remains incomplete by nature; extend `coven-agents-security.3`. |
| T10 | Crafted requests bypass ordering or validation. | Strict schemas and tests for origin/auth/abuse/body/service ordering, size limits, and stable v1 errors. | New routes must use the same handler composition. |
| T11 | Cancellation or recovery races report false success. | Durable cancellation intent, exact remote stop/reset, cleanup-required outcomes, database-clock leases, and idempotent reconciliation. | Provider outages can delay final cleanup. |
| T12 | Browser code exposes plaintext credentials. | Credential reads return harness IDs only; runner acquisition is server-only; product-boundary and demo tests reject token headers and deleted endpoints. | Compromised browser sessions can request authorized work until revoked. |

## Incident and recovery expectations

- Revoke account authority before provider or credential work when compromise
  is suspected.
- Rotate the affected active secret, redeploy, and prove the old value is dead.
- Preserve durable cleanup ownership until provider absence and database
  finalization are both confirmed.
- Never convert an outage, malformed provider response, stale fence, or missing
  configuration into a successful or terminal-clean result.
- Treat removal of the repository Worker runtime and decommissioning of any
  separately deployed Worker as distinct operational events.

## Verification and review

Primary executable evidence:

- authority: `lib/runner/production.test.ts`, `lib/runner/auth.test.ts`;
- route ordering and diagnostics: `lib/runner/http.test.ts`,
  `scripts/abuse-route-order.test.ts`;
- credential sequencing and cleanup:
  `lib/credentials/runner-credential.test.ts`;
- admission, fencing, terminal races, and recovery:
  `lib/runner/admission.test.ts`, `lib/runner/store.test.ts`,
  `lib/runner/reconcile.test.ts`;
- contract and evidence safety: `packages/agent-contracts/src/evidence.ts` and
  its tests;
- browser/product boundary: `scripts/product-boundary.test.ts`,
  `scripts/demo-route.test.ts`, `scripts/secret-scan.test.ts`.

Run `pnpm hygiene`, `pnpm check`, `pnpm typecheck`, `pnpm test:unit`, and
`pnpm build` before merge. These gates verify repository behavior; they do not
certify a live production lifecycle or external runtime decommissioning.
