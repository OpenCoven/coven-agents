# Tenant Identity and Credential Isolation

**Status:** design, approved 2026-08-24
**Scope:** spec 1 of 3. Demo mode and subscriptions are separate specs that
build on this one.

## Why this exists

Coven Agents is becoming a paid product where customers get an isolated tenant
inside one deployment. Two rules govern it:

1. A tenant always supplies their own harness credentials. The owner's
   credentials are never used to serve anyone else.
2. The owner's database is available to subscribers only.

Neither rule holds today. This is not a missing feature — it is a live
violation, and that is what makes this spec first in the sequence.

`worker/src/routes.ts` resolves every caller to a single tenant:

```ts
const callerTenant = UNOWNED_TENANT;
```

Authorization is one shared bearer token, `AGENT_CONTROL_TOKEN`, which the
code's own comment describes as proving "authorization, not identity".
`worker/src/harness-runner.ts` then resolves the harness credential from
Worker secrets — `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` — which
are deployment-level and therefore the owner's.

So exposing the cloud runner to customers today would have every customer
executing as the owner's GitHub identity, under one shared tenant. The tenancy
work already merged isolates *sandboxes* per tenant; `tenantId` appears nowhere
in the credential path.

The existing code anticipated this. The tenant is already threaded through
ownership, listing and every per-entity lookup, so introducing real identity is
a change to one expression rather than a hunt.

## Goals

- Per-tenant identity in the worker, derived from a verifiable claim.
- Per-tenant harness credentials, with no path back to owner credentials.
- No database access for anyone who is not a subscriber.
- Each guarantee enforced by a mechanism, not by a convention.

## Non-goals

- Stripe, plans, and the paywall (spec 3). This spec produces the `plan` claim
  and consumes it; it does not decide how the value is set.
- Fixture replay and demo UX (spec 2). This spec defines the demo *session* and
  what it is forbidden to do.
- Self-hosted customer deployments. Customers get an isolated tenant inside the
  owner's deployment; there is no separate distribution.

## Architecture

### Trust boundary

The Next app is the only component that can mint identity. The worker only
verifies.

```
Browser ──NextAuth session──▶ Next app   (holds the private key)
                              mints { sub, tenant, plan, exp: 15m }
Browser ──Bearer JWT────────▶ Worker     (holds the public key only)
                              verify signature offline
                              callerTenant = claims.tenant
```

**Signing is Ed25519, not HMAC.** With a shared HMAC secret the worker holds
everything needed to mint a token for any tenant, so a worker compromise
becomes full impersonation. With asymmetric signing the worker holds only a
verify key: it can check a claim and cannot manufacture one. The
implementation cost is identical.

Tokens are short-lived (15 minutes). Expiry is the revocation mechanism; there
is no revocation list to maintain or consult.

### Claims

```
sub     stable user id
tenant  tenant id — the value that replaces UNOWNED_TENANT
plan    "demo" | "subscriber"
exp     issued + 15 minutes
```

`tenant` is opaque to the worker. The worker never derives a tenant from
anything else in the request — not a header, not a body field, not the runner
token.

### What happens to `AGENT_CONTROL_TOKEN`

It is retained as a coarse deployment-level gate — a request without it is
rejected before any verification work happens — but it stops being an identity
source. "Who is calling" is answered by the verified claim alone, and no code
path may derive a tenant from the presence or value of this token.

Keeping it costs nothing and means a leaked JWT alone is not sufficient to
reach the worker. Its scope is deliberately narrow: it can gate access, and it
can no longer confer identity.

## Credential store

The browser talks to the worker directly, so the worker must obtain the tenant
credential itself. The design keeps the app as sole custodian and lends the
worker one credential per run.

```
Set-up (once per tenant):
  tenant ──token──▶ Next app
    DEK      = random key
    ciphertext = AES-GCM(token, DEK)
    wrapped  = AES-KW(DEK, KEK)          KEK lives with the app only
    store { tenant, ciphertext, iv, wrapped }

Run time:
  Worker ──service token, tenant, runId──▶ Next app  /internal/credential
                                            unwrap DEK, decrypt for that
                                            tenant only
         ◀──one plaintext credential───────
  inject into that tenant's sandbox env, in memory
```

The rejected alternative is the worker reading the store directly and holding
the KEK. It is fewer moving parts, but a worker compromise then yields every
tenant's credential at rest. Under the fetch design the worker sees credentials
only for runs it is actively executing and holds no unwrapping key.

Envelope encryption (per-tenant DEK wrapped by a KEK) rather than encrypting
under a single key: rotating the KEK becomes a rewrap of small values instead
of re-encrypting every credential, and revoking one tenant is deleting one row.

### Credential resolution inverts

`requireHarness(runtime, env)` reads deployment secrets today. It becomes a
lookup keyed by the verified `claims.tenant`. When that lookup is empty it
throws `harness_unauthenticated`. It must never consult `env`.

### The owner's secrets are deleted, not ignored

`COPILOT_GITHUB_TOKEN`, `GH_TOKEN` and `GITHUB_TOKEN` are removed from the
Worker deployment.

This is the load-bearing decision of the spec. A forbidden fallback survives
refactors; an absent one cannot. If the variables do not exist, a regression
cannot silently reach them — the failure is a refused run rather than a
customer executing as the owner.

### Credentials must not leak into run output

Three rules, each enforced in code:

- The credential is never returned to the browser. `/internal/credential` is
  service-token only and has no session-authenticated path.
- It is never written to the sandbox filesystem; it is passed as an env var to
  `exec`.
- It is redacted from run evidence. `sanitizeEvidenceText` in
  `packages/agent-contracts` already exists for this purpose and has its own
  `evidence-safety.test.ts`; the tenant credential joins its redaction set.

The third is the realistic failure. The first two are obvious enough that
nobody implements them wrongly, whereas a CLI printing its own auth header in a
debug line is entirely ordinary, and that output is streamed into stored run
evidence.

## Demo sessions

A demo visitor gets a signed cookie carrying `{ tenant: "demo:<random>", plan:
"demo" }` and no database row.

The NextAuth guest provider is removed rather than flagged. It currently
creates a `User` row for every anonymous visitor; a single redirect loop during
local testing on 2026-08-24 produced 81 rows. A provider that can write will
write.

### The database ban is a type error

"Audit every write path" is a rule that holds until it does not. Instead, the
session type makes the violation unrepresentable:

```ts
type Session = DemoSession | SubscriberSession;

// The only way to obtain a database handle.
function database(session: SubscriberSession): Db;
```

A `DemoSession` does not satisfy the parameter, so a demo code path that tries
to persist fails to compile. Every persistence path is reached through that one
function.

This follows the pattern already used in `worker/src/tenant.ts`, where
`tenantOf` switches exhaustively over the owner union and
`assertUnreachableOwner` makes an unhandled case a compile error.

Because the guarantee is a type, it is checked by `pnpm typecheck` — which, as
of #41, runs across the workspaces in CI. Before that change it would have been
checked nowhere.

### Entitlements

`entitlementsByUserType` moves from `guest | regular` to `demo | subscriber`.

## Failure modes

| Situation | Behaviour |
| --- | --- |
| Subscription lapses mid-session | The app stops minting `plan: "subscriber"`; access ends within one 15-minute token lifetime. |
| Subscriber has stored no credential | Refused with `harness_unauthenticated`. `harnessAuthHint` already produces the guidance text. |
| Demo session attempts a real run | Refused at the worker on the `plan` claim, before any credential lookup. Demo never reaches the credential path. |
| Worker is compromised | It holds no KEK, no credentials at rest, and no minting key. It can impersonate nobody and decrypt nothing. |
| App cannot be reached at run time | The run fails closed. A missing credential is never substituted. |

## Testing

The guarantees are security properties, so a passing test proves nothing until
the fix is deleted and the test is watched to fail. Each of these must be
mutation-tested:

- **Isolation holds without deployment secrets.** Set `COPILOT_GITHUB_TOKEN`,
  `GH_TOKEN` and `GITHUB_TOKEN` in the test environment and assert a tenant
  with no stored credential is still refused. If this test ever passes because
  the run succeeded, isolation is gone. This is the single most important test
  in the spec.
- **A tenant cannot reach another tenant's credential**, including when the
  tenant id is attacker-supplied. `tenant.test.ts` already covers forged tenant
  ids for sandbox keys; this extends the same adversarial style to credentials.
- **A demo claim never reaches the credential path**, asserted by the absence of
  the lookup, not merely by the run failing.
- **The credential never appears in run evidence**, asserted against output that
  deliberately echoes it.
- **A demo session cannot obtain a database handle** — a compile-time
  assertion, so the check lives in `pnpm typecheck` rather than the test run.

## Rollout

Ordered so that no window exists in which customers can reach owner
credentials:

1. Add minting and verification; the worker accepts a verified claim but still
   falls back to the shared token. No behaviour change for existing callers.
2. Add the credential store and `/internal/credential`.
3. Switch `requireHarness` to the tenant lookup, fail-closed.
4. Delete the three secrets from the Worker deployment.
5. Remove the shared-token identity path.

Steps 3 and 4 are the point of no return and should land together. Until step
4, the guarantee is a rule; after it, it is a fact about the deployment.

## Deferred

- Which harnesses can accept a per-tenant credential without a `login` step
  varies by CLI (`copilot`, `codex`, `claude`). Spec 2 resolves this per
  harness; this spec assumes an injectable token and refuses where that
  assumption fails.
- KEK storage and rotation cadence. The design requires the app to hold it and
  the worker not to; where the app holds it is an implementation decision.
