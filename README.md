# Coven Agents

**Coven Agents** is the OpenCoven product control plane for authenticated,
tenant-scoped coding missions. The Next.js application owns product accounts,
subscriptions, credential custody, run admission, execution records, and
bounded evidence. Daytona is the sole production execution provider.

Read the accepted [Product authority boundary](docs/architecture/adr-001-product-authority-boundary.md)
and [Daytona execution boundary](docs/architecture/adr-002-daytona-execution-boundary.md)
before changing identity, credentials, execution, or persistence.

## Execution and security

Browser execution requests use relative same-origin `/api` routes and the
httpOnly Auth.js application session. The server revalidates subscriber
authority, derives the tenant, acquires the tenant's harness credential, and
dispatches to Daytona. Provider credentials and tenant harness credentials are
never returned to browser code.

Each agent owns one tenant-scoped persistent Daytona sandbox. Runs reuse that sandbox.
Each attempt receives a short-lived process session and a mode-`0600` credential file.
Attempt cleanup removes the file and process session.
Deleting a run record does not delete the sandbox or its workspace.
Deleting the agent performs the sandbox lifecycle operation.

PostgreSQL owns agent, run, event, dispatch, attempt, cancellation, and
reconciliation state. Starts are operation-idempotent, event streaming resumes
from the last acknowledged cursor, and recovery is bounded by durable leases
and exact attempt fences.

Review the living [Execution threat model](docs/security/execution-threat-model.md),
[Guest access and safety boundary](docs/security/guest-access.md),
[credential key rotation runbook](docs/security/key-rotation.md), and
[Security incident response](docs/security/incident-response.md).

## Credential custody

Each tenant supplies its own harness credential. Credentials are encrypted with
per-row AES-GCM data keys wrapped by the versioned
`CREDENTIAL_KEK_V1`/`CREDENTIAL_KEK_V2` ring and bound to tenant and harness
context. Server-only run acquisition reserves capacity and usage before reading
plaintext, and compensates the exact reservation and lease if launch fails.

The Daytona sandbox stores no durable harness credential. Provider keys are
blanked from the harness command environment, and normalized evidence is
bounded and redacted before persistence or display.

## Guest and subscriber access

Signed-out visitors may view a committed, sanitized replay only when `IS_DEMO`
is explicitly set to `1`; an unset value or any other value keeps the normal
application routes. Replay captures may be published only from the exact
`OpenCoven/demo-workspace` repository. Verified account sign-in creates or adopts an
account but does not grant execution. Subscriber authority is recomputed from
server-owned state, and protected routes revalidate the current account version
before database, credential, or Daytona work.

Review the living
[Subscription and billing policy](docs/product/subscription-billing-policy.md)
before changing entitlement, checkout, webhook, grace, or run-cap behavior.
New subscription sales are default-off through
`SUBSCRIPTION_CHECKOUT_ENABLED`; use the
[release-readiness Stripe checklist](docs/roadmap/release-readiness.md#stripe-webhook-delivery)
before enabling it. Hosted Customer Portal is implemented and remains
available to a current authenticated billing owner when sales are paused or
paid access has expired. It requires a configured Stripe portal; complimentary
accounts receive an explicit non-billed response. Automatic Stripe Tax
collection is not implemented.

The cloud pilot uses one fixed monthly Stripe Price, checked before Checkout
mutations, with 300 included execution minutes and a 15-minute maximum run.
There is no automatic overage, and model inference/provider entitlement is
customer-supplied. `lib/billing/pilot-plan.ts` reuses the enforced allowance
constants for the public policy returned by `/api/subscription`. Its `active`
field is product billing state, not canonical familiar execution authority.
Exact Price amount/currency are shown by hosted Checkout from that same
configured Price, not copied into application pricing text. Optional prepaid
minute packs remain separately configured and do not enable automatic overage.

The [cloud pilot integration boundary](docs/product/cloud-pilot-integration.md)
records canonical ownership, source gaps, billing-recovery and storefront
policy, and the independent native/provider release gates.

## Install

Requirements:

- Node.js 22 or newer
- pnpm 10

```bash
pnpm install
cp .env.example .env.local
```

Generate a credential-encryption key in a private terminal:

```bash
node --input-type=module -e '
import { randomBytes } from "node:crypto";
console.log("CREDENTIAL_KEK_CURRENT_VERSION=v1");
console.log("CREDENTIAL_KEK=" + randomBytes(32).toString("base64url"));
'
```

Do not copy key output into logs, issues, or tracked files.

## Run

```bash
pnpm dev
```

Open <http://localhost:3036/agents>.

Production Daytona configuration requires the API key, pinned snapshot,
least-privilege domain allowlist, PostgreSQL, Redis admission state, and
separate cron, manual reconciliation, and diagnostic credentials documented in
`.env.example`.

Create or refresh the pinned harness snapshot with:

```bash
pnpm daytona:snapshot
```

GitHub Copilot CLI is the runnable harness today. Other detected harnesses are
reported but refused until their event translation is implemented.

## WorkOS login and waitlist

Use WorkOS AuthKit to collect signup requests before allowing registration.
The integration uses the existing Auth.js application session and local account
records. WorkOS approval permits registration; execution still requires the
app's current subscription or explicit complimentary access.

1. In your intended WorkOS environment, enable AuthKit and its
   [hosted waitlist](https://workos.com/docs/authkit/waitlist) under
   **Authentication → Features**. Entries are stored and reviewed in WorkOS.
2. Register `https://agents.opencoven.ai/api/auth/callback/workos` as the
   redirect URI. Add each preview or local callback URI separately when testing.
3. Configure `WORKOS_CLIENT_ID` and `WORKOS_API_KEY` as server-only Vercel
   variables, then set `WORKOS_AUTH_ENABLED=1` and deploy the verified candidate.
   Missing enabled configuration fails validation. Never put the API key in a
   public variable, issue, command argument, or tracked file.
4. Check **Join the waitlist**, then verify the pending entry in WorkOS. Approve
   a dedicated test account and verify sign-in returns to the requested page.
   Verify an unapproved signup cannot register and cannot reach execution.
5. Before switching existing customers, verify their WorkOS-verified email
   matches the existing local account. Existing accounts retain their local ID,
   stored access, and session-revocation version. WorkOS sign-in does not enroll
   new accounts in the GitHub-age-based beta campaign.

With WorkOS enabled, direct GitHub account login is removed from the provider
list so it cannot bypass the hosted waitlist. GitHub repository connections and
Copilot credentials remain separate. With the flag unset or `0`, existing
GitHub login remains active. Changing the flag requires a new deployment.

The callback uses Auth.js state and PKCE checks and accepts only a verified
WorkOS email. Provider access and refresh tokens are not stored in the app
session. Local tests do not prove WorkOS environment settings, waitlist capture,
email delivery, or production login; retain those live receipts before claiming
this flow is enabled.

## Administration

The hidden `/admin` directory is available only to normalized email addresses
in `ADMIN_EMAILS`. Unauthorized page and API requests return a non-cacheable
`404`.

Invalidate an account's active sessions with:

```bash
pnpm account revoke-sessions <email>
```

## Roadmap and verification

[`ROADMAP.md`](ROADMAP.md) is the public strategic view. Current evidence,
sequencing, release gates, and capability status live in
[`docs/roadmap`](docs/roadmap/). The
[planning document registry](docs/roadmap/README.md) classifies living plans,
proposals, historical evidence, decision logs, and superseded specifications.
The published [Wave 1 delivery report](docs/roadmap/wave-1-delivery.md) records
public delivery artifacts without replacing the private planning authority.

Run the repository gates:

```bash
pnpm hygiene
pnpm check
pnpm typecheck
pnpm test:unit
pnpm build
```

GitHub Actions are intentionally disabled. These local gates are the merge
boundary. A successful local run is repository evidence, not proof that a
production deployment or provider operation occurred.

### Hermetic browser certification

Migration changes require `pnpm db:verify` before a PR or merge. This
browser-free gate applies the full migration chain to PostgreSQL 16 and runs
the real GitHub lifecycle, minute-pack, and Stripe reconciliation assertions
with skipping disabled. It shares the
disposable database lifecycle with the browser command below. Docker is the
default; an explicitly disposable PostgreSQL server can instead be used:

```bash
E2E_POSTGRES_URL=postgresql://localhost/postgres E2E_POSTGRES_DISPOSABLE=1 pnpm db:verify
```

The supplied role needs `CREATEDB`. Each run creates a uniquely named child
database and drops only that child on success or failure; it never migrates
or drops the supplied database. Never use a production server. Local
`pnpm db:migrate` warns when `POSTGRES_URL` is missing; release migration gates
must use `pnpm db:migrate --strict` to fail instead.

`pnpm db:check` also runs with no database: it validates migration metadata
and asks Drizzle to generate against an isolated temporary copy. Any new
migration is schema drift and fails the gate; temporary output is removed
on success or failure. This gate is included in `pnpm check`.

Run the explicit local PostgreSQL browser certification with:

```bash
pnpm test:e2e:hermetic
```

It starts and removes one uniquely named `postgres:16-alpine` container unless
`E2E_POSTGRES_URL` and the exact opt-in `E2E_POSTGRES_DISPOSABLE=1` are both
provided (using an owned child database as described above). The command seeds fixed non-personal identities, uses signed Auth.js
cookies, and selects a server-only deterministic executor only when both
hermetic E2E flags are set outside production. It exercises application APIs,
durable storage, accounting, reconciliation, SSE, and cancellation without
Daytona or external network calls. It is not Daytona or production evidence.
