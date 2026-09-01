# Coven Agents

**Coven Agents** is the OpenCoven product control plane for authenticated,
tenant-scoped coding missions. The Next.js application owns product accounts,
subscriptions, credential custody, run admission, execution records, and
bounded evidence. Daytona is the sole execution provider.

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
`OpenCoven/demo-workspace` repository. GitHub sign-in creates or adopts an
account but does not grant execution. Subscriber authority is recomputed from
server-owned state, and protected routes revalidate the current account version
before database, credential, or Daytona work.

Review the living
[Subscription and billing policy](docs/product/subscription-billing-policy.md)
before changing entitlement, checkout, webhook, grace, or run-cap behavior.
New subscription sales are default-off through
`SUBSCRIPTION_CHECKOUT_ENABLED`; use the
[release-readiness Stripe checklist](docs/roadmap/release-readiness.md#stripe-webhook-delivery)
before enabling it. Customer Portal and automatic Stripe Tax collection are
not part of the current release.

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
