# Execution Threat Model

- Status: living document
- Owner: Security & privacy workstream
- Applies to: control plane, shared contracts, cloud runner, local runner, demo
  publication, and operator credentials

## Scope and security goals

Coven Agents intentionally launches coding harnesses with approval prompts
disabled. The security boundary is therefore not "the model cannot execute a
dangerous command." The boundary is which identity may request execution, which
workspace and tenant receive it, which credentials enter it, what evidence may
leave it, and how much work may be consumed.

This model covers:

- the Next.js control plane and its database;
- the shared contracts and evidence normalization package;
- the Cloudflare Worker, Durable Objects, and sandbox containers;
- the loopback local runner and the host processes it launches;
- operator, deployment, tenant, and harness credentials;
- committed demo evidence and source-control boundaries.

Security goals:

1. A caller cannot act as another tenant or access another tenant's agent,
   sandbox, credential, run, or database state.
2. Demo and unsubscribed identities cannot obtain subscriber execution or
   persistence authority.
3. Harness credentials remain under tenant ownership, are encrypted at rest,
   and are exposed only to the intended run.
4. Cloud execution stays inside its tenant sandbox; local execution is clearly
   disclosed as trusted-host execution until optional local isolation exists.
5. Secret-like output and local machine details are removed before supported
   persistence, publication, or user-visible evidence boundaries.
6. Input, output, execution time, and repeated work are bounded or have an
   explicit roadmap control.
7. Missing identity, keys, configuration, or authority fails closed.

Out of scope:

- the internal security of GitHub, Cloudflare, Stripe, or a model provider;
- preventing an authorized harness from changing files inside its granted
  workspace;
- treating natural-language prompts as trusted instructions;
- operating-system isolation for the current local runner.

## Actors and assumptions

Relevant actors:

- an unauthenticated internet client probing public routes;
- an authenticated demo user with no execution entitlement;
- a subscriber acting within their own tenant;
- a malicious tenant attempting cross-tenant access or resource exhaustion;
- a compromised browser, extension, local process, or website;
- an untrusted repository, task prompt, dependency, harness, or harness output;
- an operator deploying the control plane, Worker, keys, and service tokens;
- GitHub, Cloudflare, Stripe, and harness providers outside this repository.

Assumptions:

- production browser traffic uses HTTPS and deployment secrets are supplied
  through platform secret stores, not committed configuration;
- Cloudflare enforces its documented Worker, Durable Object, and sandbox
  isolation properties;
- the control-plane runtime and database are not shared with untrusted tenant
  processes;
- the local operator controls the host account and understands that a locally
  launched harness receives that account's authority;
- GitHub authentication proves control of the GitHub identity, while Coven's
  server-owned state remains authoritative for product entitlement;
- provider credentials may be revoked outside Coven and should be treated as
  exposed after a relevant process, host, or storage compromise.

## System and data flow

1. A browser authenticates to the control plane with GitHub. The control plane
   derives product identity and entitlement; GitHub profile data is not cloud
   runner authority.
2. An eligible subscriber asks the control plane for the coarse cloud
   connection gate and a short-lived Ed25519-signed runner claim.
3. The browser sends both to the Worker. `X-Runner-Token` permits reaching the
   deployment; the signed claim supplies `sub`, `tenant`, and `plan`.
4. The Worker resolves the requested agent under the verified tenant and starts
   or resumes that agent's Durable Object.
5. For a run, the Worker forwards the same signed identity plus its service
   token to the control plane's internal credential endpoint.
6. The control plane binds the request to the verified claim, enforces the
   subscriber plan and run cap, decrypts one tenant/harness credential, and
   returns it for that run.
7. The Worker injects the credential into one harness process in one sandbox.
   Normalized, redacted evidence returns through the shared contract.
8. The local runner is a separate trusted-host path. It accepts a loopback
   bearer token, resolves an initial working directory under the configured
   root, and launches the locally authenticated harness with host permissions.

## Assets

| Asset | Why it matters | Primary custodian |
| --- | --- | --- |
| Runner signing key | Can mint cloud tenant claims | Control plane only |
| Runner verify key | Verifies claims but cannot mint them | Control plane and Worker |
| Cloud control token | Gates access to the Worker deployment | Control plane, browser session, Worker |
| Worker service token | Gates the internal credential endpoint | Control plane and Worker |
| Credential KEK | Decrypts tenant credential data keys | Control plane only |
| Tenant harness credential | Acts as the tenant at a coding provider | Encrypted database row; in-memory run scope |
| Local runner token | Controls a trusted-host execution service | Local operator and browser session |
| Tenant identity and entitlement | Determines persistence and execution authority | Control plane |
| Agent definitions and run evidence | May contain private repository or task context | Tenant-scoped storage and UI |
| Local workspace and host account | Local harness inherits access to both | Local operator |
| Demo fixtures | Publicly rendered execution evidence | Repository |
| Roadmap and source history | Can disclose private details or committed credentials | Private repository and private Beads store |

## Trust boundaries

### B1. Browser to control plane

The browser is untrusted input. GitHub authentication establishes a user, but
subscriber authority is recomputed from server-owned subscription state.
`lib/session.ts`, `lib/db/access.ts`, and `lib/agents/connection-access.ts`
separate demo, subscriber, database, and runner-connection authority.

### B2. Browser to cloud runner

The cloud control token is a deployment gate, not identity. Identity comes from
the signed claim minted in `lib/agents/runner-token.ts` and verified in
`worker/src/routes.ts`. CORS narrows browser origins but is not treated as
authentication.

### B3. Control plane to internal credential endpoint

The service token permits the caller to reach the endpoint. It does not choose
a tenant. `app/api/internal/credential/route.ts` verifies the forwarded runner
claim, and `app/api/internal/credential/binding.ts` derives the tenant and
requires the subscriber plan. A body/claim mismatch is refused.

### B4. Control plane database and credential custody

Browser-facing database access requires a `SubscriberSession` through
`lib/db/access.ts`. Tenant credentials are scoped by tenant and harness and
sealed before storage in `lib/credentials/store.ts`; the KEK has no default.
The internal credential route is the documented service-to-service exception
and replaces the session gate with service and signed-identity checks.

### B5. Worker to Durable Objects and sandboxes

Every cloud operation is filtered by the verified tenant.
`worker/src/tenant.ts` derives unambiguous sandbox keys and rejects unsafe
tenant identifiers. `worker/src/routes.ts` and the directory interface require
tenant-scoped listing and ownership checks.

### B6. Sandbox to external networks

Container isolation exists, but a declared outbound network policy does not.
Cloud egress is therefore a residual risk tracked by `coven-agents-cloud.4`.

### B7. Browser to local runner

`local-runner/src/index.ts` binds only to `127.0.0.1`, requires a bearer token,
uses a single configured browser origin, compares the token in constant time,
and bounds request bodies. Any process running as the same local user may still
attempt loopback access and is inside the host trust boundary.

### B8. Local runner to host

`local-runner/src/runtime.ts` keeps the initial working directory under
`OPENCOVEN_LOCAL_ROOT`, but the spawned CLI inherits the runner's environment
and operating-system permissions. It can access paths outside that root after
start if the host account can. This is trusted-host mode, not a sandbox.
Optional isolated execution is tracked by `coven-agents-local.2`.

### B9. Evidence to storage, UI, demo, and Git

`packages/agent-contracts/src/evidence.ts` removes recognized credentials,
sensitive assignments, headers, and explicit run-local secrets. The demo
recorder redacts before schema validation, and `lib/demo/fixtures.test.ts`
checks both raw and canonical JSON. `scripts/secret-scan.ts` scans staged and
tracked Git content without printing matched values.

## Threat register

| ID | Threat and impact | Current controls and verification | Residual risk or follow-up |
| --- | --- | --- | --- |
| T1 | A forged cloud identity reads or mutates another tenant's agents or runs. | Ed25519 claims are minted only in `lib/agents/runner-token.ts`; verification and tenant-scoped routes are in `worker/src/routes.ts`. Cross-tenant read, run, stream, stop, and delete refusals are covered by `worker/src/routes.test.ts`. | Signing-key compromise remains critical. Rotation and deployment procedure must keep the private key control-plane-only. |
| T2 | The shared cloud control token becomes a master tenant credential. | The token only gates deployment access. Tenant identity comes from the signed claim; the internal credential endpoint independently verifies that claim. | Browser compromise can use the current user's authority until session and runner claims expire. |
| T3 | A demo, lapsed, forged, or unknown entitlement gains subscriber persistence or execution. | `lib/session.ts` fails closed to demo; `lib/db/access.ts` requires `SubscriberSession`; `lib/agents/connection-access.ts` refuses the runner gate; the internal credential binding requires `plan === "subscriber"`. | The complete provider-ingestion state machine and adversarial transition coverage remain tracked by `coven-agents-security.2`. |
| T4 | A tenant or harness receives another tenant's credential. | `lib/credentials/store.ts` scopes by tenant plus harness. The internal endpoint binds tenant to a verified claim, refuses mismatch, and lends one credential for one run. Isolation and binding tests cover cross-tenant and cross-harness cases. | Plaintext exists in control-plane and Worker memory during a run. Process compromise during that window can expose it. |
| T5 | Credential storage is copied or read at rest. | Per-credential AES-GCM data keys are wrapped by `CREDENTIAL_KEK`; the KEK is required and not stored in rows. The Worker stores no harness credential between runs. | Database plus KEK compromise defeats encryption. Rotation and rewrapping need an operator procedure. |
| T6 | Crafted tenant identifiers collide and share a cloud sandbox. | `worker/src/tenant.ts` rejects ambiguous identifiers and centralizes sandbox-key derivation. `worker/src/tenant.test.ts` covers collisions, missing owners, and create/delete consistency. | New owner kinds must preserve the exhaustive mapping and tests. |
| T7 | A cloud harness escapes its intended filesystem or exfiltrates over the network. | Each agent runs in a Cloudflare sandbox keyed by tenant and agent. No operator harness credential is available as fallback. | Outbound policy is not yet declared or enforced. Complete `coven-agents-cloud.4`; expand readiness checks in `coven-agents-cloud.5`. |
| T8 | A local mission accesses host files, processes, environment values, or credentials beyond its requested repository. | Loopback binding, token authentication, origin restriction, and initial workspace resolution reduce accidental exposure. README and this model disclose inherited host authority. | This is expected in trusted-host mode. Add optional isolation and required-isolation refusal through `coven-agents-local.2`. |
| T9 | A malicious website drives the local runner. | The runner permits one configured origin, requires an authorization token, and stores connection data in browser session storage rather than persistent local storage. | A malicious local process or browser compromise is within the host boundary. Operators must rotate the local token after suspected exposure. |
| T10 | A run exhausts memory, disk, processes, containers, or paid capacity. | Local requests, output, and runtime are capped in `local-runner/src/index.ts`. Cloud runs are idempotent per operation, one active run per agent is enforced, and the credential boundary enforces the monthly cap before lending a credential. | Platform-wide queueing and fairness remain in `coven-agents-cloud.3`; local process ownership remains in `coven-agents-local.1`. |
| T11 | Harness output leaks credentials or private paths into UI, storage, logs, or demos. | Shared redaction lives in `packages/agent-contracts/src/evidence.ts`; cloud normalization and demo publication tests exercise direct and encoded values; errors use static or sanitized messages. | Redaction is pattern-based and the current local runner returns raw buffered output. Complete shared end-to-end coverage in `coven-agents-security.3`. |
| T12 | A crafted request, event, or stored record bypasses validation or causes unsafe replay. | Shared Zod contracts bound lengths, enums, event ordering, and strict object shapes. Routes distinguish invalid requests from internal failures. Demo fixtures are schema-validated before load. | Cross-backend conformance remains in `coven-agents-testing.1`; unknown historical schema migration remains a future data concern. |
| T13 | Prompt injection persuades an authorized harness to perform destructive work. | Authorization, workspace selection, tenant isolation, and execution limits still apply; cloud damage is contained to the sandbox and tenant-accessible services. | Prompt injection is not preventable by prompt text. Local runs must use disposable or trusted workspaces, and operators remain responsible for granted credentials. |
| T14 | Run or agent data persists longer than expected or survives a crash ambiguously. | Current stores are bounded by their implementations, and cloud lifecycle state records terminal transitions. | Formal in-flight journals, durable history, retention, and recovery are tracked by `coven-agents-data.1`, `coven-agents-data.2`, `coven-agents-data.3`, and `coven-agents-local.5`. |
| T15 | A committed secret or private transcript enters source history. | `.husky/pre-commit` runs `scripts/secret-scan.ts`; CI has a tracked-file scan; findings omit values. Demo recording is cloud-only, repository-restricted, redacted, schema-validated, and checked in raw and canonical forms. | Hooks can be bypassed locally. Recurring scanning and triage remain in `coven-agents-security.4`; protected-path approval remains in `coven-agents-dx.4`. |
| T16 | A dependency, workflow action, or source change compromises the execution path. | The lockfile is frozen in CI, GitHub Actions are commit-pinned, Dependabot is configured, and local lint/type/test/build gates are required before merge. | Consolidated dependency, workflow, and source scanning is tracked by `coven-agents-security.4`. |

## Incident and recovery expectations

Containment takes priority over preserving availability. A missing or uncertain
identity, key, entitlement, tenant binding, or credential boundary must refuse
new work rather than fall back to shared authority.

| Incident | Immediate response | Recovery evidence |
| --- | --- | --- |
| Committed credential or private evidence | Revoke or rotate the credential first; disable affected access; remove public artifacts; use `pnpm secret:scan:all` to bound repository exposure. Deleting a line is not revocation. | Record affected paths and categories without copying values. Complete recurring detection and triage through `coven-agents-security.4`. |
| Runner signing-key compromise | Stop cloud issuance, replace the signing and verify key pair together, redeploy the control plane and Worker, and reject all claims signed by the old key. | Run `lib/agents/runner-token.test.ts` and cloud route tests, then verify a fresh claim succeeds and an old claim fails. |
| Control or service-token compromise | Rotate the affected token on both sides of its boundary. The control token grants deployment reach but not tenant identity; the service token grants endpoint reach but not tenant selection. | Re-run `lib/agents/connection-access.test.ts` and `app/api/internal/credential/*.test.ts`; verify empty and previous tokens fail. |
| Tenant harness-credential compromise | Revoke at the harness provider, stop affected runs, destroy or recycle affected sandboxes, and replace the encrypted tenant/harness row through `lib/credentials/store.ts`. | Verify the old credential no longer works and cross-tenant tests still pass without recording the credential value. |
| Suspected cross-tenant cloud access | Suspend affected execution, preserve sanitized ownership and operation identifiers, stop the run, and destroy the implicated sandbox. Do not expose another tenant's record while notifying users. | Reproduce with `worker/src/routes.test.ts` and `worker/src/tenant.test.ts`; repair ownership before restoring service. |
| Local-runner or host compromise | Stop the loopback service, rotate its token, revoke provider credentials available to the host, and investigate the host as compromised. Workspace-root checks are not a containment boundary. | Restore only on a trusted host. Optional isolation remains `coven-agents-local.2`; crash reconciliation remains `coven-agents-local.5`. |
| Resource-exhaustion or orphaned execution | Refuse new work, stop bounded runs, and prefer explicit busy or recovery states over silently starting duplicates. | Cloud fairness is completed through `coven-agents-cloud.3`; process ownership and recovery through `coven-agents-local.1` and `coven-agents-local.5`. |
| Evidence-redaction failure | Stop publication or persistence of the affected evidence, revoke any exposed credential, sanitize already published artifacts, and add the missed shape as a regression. | Run shared evidence, demo fixture, and recorder tests. End-to-end redaction remains `coven-agents-security.3`. |

## Verification and review

Reviewers of security-sensitive changes should map the change to this table and
run the narrow tests for the affected boundary plus the repository gates.

| Boundary | Required evidence |
| --- | --- |
| Sessions and entitlement | `lib/session.test.ts`, `lib/subscription.test.ts`, `lib/session-claims.test.ts`, `lib/agents/connection-access.test.ts` |
| Database and credential custody | `lib/db/access.test.ts`, `lib/credentials/envelope.test.ts`, `lib/credentials/authorize.test.ts`, `app/api/internal/credential/*.test.ts` |
| Cloud identity and tenancy | `lib/agents/runner-token.test.ts`, `worker/src/routes.test.ts`, `worker/src/tenant.test.ts`, `worker/src/tenant-credentials.test.ts` |
| Cloud execution and evidence | `worker/src/harness-runner.test.ts`, `worker/src/run-state.test.ts`, `worker/src/agents.test.ts` |
| Local execution | `local-runner/src/runtime.test.ts`, `local-runner/src/store.test.ts`, local-runner package tests |
| Shared contracts and redaction | `packages/agent-contracts/src/*.test.ts`, especially evidence-safety and demo-transcript tests |
| Demo publication | `scripts/demo-record.test.ts`, `scripts/demo-capture.test.ts`, `lib/demo/fixtures.test.ts` |
| Source-control boundary | `scripts/secret-scan.test.ts`, `pnpm secret:scan`, `pnpm secret:scan:all` |

Repository gates:

```bash
pnpm hygiene
pnpm secret:scan:all
pnpm check
pnpm typecheck
pnpm test:unit
pnpm build
```

Review this document when any of the following changes:

- identity claims, subscription authority, or session types;
- credential storage, service authentication, or key rotation;
- tenant, owner, sandbox, workspace, or process-lifecycle logic;
- network policy, CORS, public routes, or deployment topology;
- evidence schemas, persistence, retention, export, or demo publication;
- local execution isolation or cloud container capabilities;
- a new harness, provider credential shape, or secret source;
- a security incident invalidates an assumption recorded here.

Open follow-ups are not mitigations. They identify accepted residual risk and
must remain visible in the private Beads roadmap until implemented.
