# Coven Agents

**Coven Agents** is a cloud execution product control plane for creating bounded
execution profiles and running coding missions. It is derived from
[BunsDev/chatbot](https://github.com/BunsDev/chatbot) and keeps that template's
Next.js, React, Tailwind, and shadcn/ui foundation.

It owns product accounts, subscriptions, runner access, cloud credential
custody, and evidence for its own runs. It does not own canonical OpenCoven
familiar identity, protected memory, authority, durable orchestration, or the
runtime registry. Review the accepted
[Product authority boundary](docs/architecture/adr-001-product-authority-boundary.md)
before expanding product state or adding an OpenCoven dependency.

Wave 1 results and the dependency-ordered next priorities are recorded in the
[Wave 1 delivery report](docs/roadmap/wave-1-delivery.md).

Agents run through authenticated same-origin APIs backed by the server-side
Daytona runner. Browser requests carry only the Auth.js application session;
tenant identity and subscriber authority are derived and revalidated on the
server.

## Security model

"YOLO" means tool approvals are disabled. It does **not** mean cloud tasks escape
their container.

Review the living [Execution threat model](docs/security/execution-threat-model.md)
before changing identity, credentials, tenancy, runner boundaries, or evidence
handling.

Credential encryption-key rotation is documented in the
[credential key rotation runbook](docs/security/key-rotation.md).

Review the [Guest access and safety
boundary](docs/security/guest-access.md) before changing public replay,
account creation, subscription gates, or any route that can consume or persist
resources.

When something has already gone wrong, follow
[Security incident response](docs/security/incident-response.md). It has a
rotation runbook for every credential in the system, and the order matters:
rotate first, investigate second.

**Execution**

- Each agent owns one tenant-scoped persistent Daytona sandbox through the
  server-side runner service. Runs reuse that sandbox; each execution attempt
  gets its own short-lived process session and mode-`0600` credential file,
  both cleaned after the attempt. The agent workspace persists with its sandbox
  until the agent is deleted or the sandbox lifecycle explicitly resets it.

**Browser authority stays in the application session.** The browser calls the
same-origin `/api` surface with its Auth.js cookie. Agent and run routes
revalidate subscriber status, derive the tenant from server-owned identity,
and never return a runner connection, deployment token, signed runner identity,
or private signing material.

**Credentials belong to tenants.** The operator's credentials are never lent
out. Each tenant supplies their own harness credential; it is stored under
envelope encryption (a per-credential AES-GCM data key wrapped by
the versioned `CREDENTIAL_KEK_V1`/`CREDENTIAL_KEK_V2` ring), fetched for the
duration of one run, and redacted from run evidence. The Daytona sandbox holds
no stored harness credential of its own. See
the [credential KEK rotation runbook](docs/security/key-rotation.md).

**Product data is subscriber-gated.** New browser-facing product data access
uses `databaseFor`, which accepts a `SubscriberSession` and nothing else.
Legacy chat routes apply the same fail-closed subscriber decision before their
query helpers run. Narrow identity, usage-status, and checkout paths are
documented guest exceptions; they do not grant access to chats, documents,
credentials, agents, or runs.

**Guest sessions.** A signed-out visitor gets a stateless guest session — an
httpOnly cookie, no database row. A GitHub sign-in creates or adopts one account
row but still grants no model, credential, runner, sandbox, run, upload, or
persistent chat access. Subscription state is recomputed from `subscribedUntil`
on every token callback, and every signed-in session is revalidated against the
current database `authVersion` before resource access. Guests are rejected
without that lookup; expiry or revocation cannot wait for the browser token to
expire. The internal compatibility label remains `demo`.

**Browser storage.** The console stores no runner endpoint, deployment
credential, or runner bearer token. Its runner client uses relative same-origin
URLs and relies on the httpOnly application session cookie.

**Commit scanning.** The pre-commit hook scans staged Git content for recognized
credential shapes before formatting runs. Findings identify only the file,
line, and credential category; matching values are never printed. Use
`pnpm secret:scan:all` to scan every tracked file. Synthetic security fixtures
must use a reviewed `secret-scan: allow-next-line -- <reason>` marker.

## Install

Requirements:

- Node.js 22 or newer
- pnpm 10

```bash
pnpm install
cp .env.example .env.local
```

Generate the local app's credential-encryption key in a private terminal and
copy the assignments into `.env.local`.

```bash
node --input-type=module -e '
import { randomBytes } from "node:crypto";
console.log("CREDENTIAL_KEK_CURRENT_VERSION=v1");
console.log("CREDENTIAL_KEK=" + randomBytes(32).toString("base64url"));
'
```

Do not copy the output into logs, issues, or tracked files. The credential KEK
stays app-only. Browser runner requests now use the authenticated same-origin
application API; the app exposes no runner-connection endpoint, browser token
minter, or private runner signing key.

## Run the control plane

```bash
pnpm dev
```

Open <http://localhost:3000/agents>.

### Owner directory

The hidden `/admin` Warden directory is available only to exact, normalized
email addresses in the comma-separated `ADMIN_EMAILS` allowlist. Unauthorized
page and API requests return a non-cacheable `404`. Configure the same allowlist
for production build and runtime because the proxy participates in the build;
do not expose the route as general account administration.

To invalidate all existing sessions for an account, run
`pnpm account revoke-sessions <email>`. It atomically advances the account
version and prints only the account ID and new version; an unknown address is a
nonzero failure.

## Configure the Daytona runner

Production requires the Daytona API key, snapshot, least-privilege domain
allowlist, Redis admission state, cron and manual reconciliation credentials,
and the separate operator diagnostic credential listed in `.env.example`.
Create the pinned harness snapshot with:

```bash
pnpm daytona:snapshot
```

Each tenant supplies their own credential through the console. Production must
configure the versioned credential KEK ring; local and CI builds may leave it
unset. Follow the [credential key rotation
runbook](docs/security/key-rotation.md) for AAD binding, resumable rewrap, and
retirement gates.

## Harness execution

The current cloud backend spawns an already-authenticated coding CLI — the
*harness* — and translates its event stream into one normalized vocabulary. The
previous local and Cloudflare runners were removed, and the shared contract
retains `cloud` as the compatibility value for the current Daytona backend. The
control plane is never a model client, so it needs no provider credential.

- `packages/harness` is the single definition of the CLI subset, the JSONL event
  normalizer, and the run summarizer. The sandbox calls it, so normalization
  cannot drift from the contract.
- The current runner executes the harness inside the agent's persistent,
  tenant-scoped Daytona sandbox. Each run attempt uses a separate process
  session and temporary credential file; deleting a run record does not delete
  the sandbox or its workspace.
- `GET /api/harnesses` probes the sandbox and reports which harnesses are
  installed, their versions, and whether their event translation is implemented.
- GitHub Copilot CLI is the supported subset today. Codex CLI and Claude Code
  are detected and reported but refused for runs, because inventing a rendering
  for an untranslated event stream would put invented detail on screen.
- Provider keys are blanked in the sandbox command environment, so a run cannot
  quietly consume one even if it leaks into the container.

Agent create, list, and delete work without any credential. Running an agent
requires the harness credential; without it a run completes with status `failed`
and a message naming the harness variable to set, rather than erroring the
request.

## Roadmap and delivery

[`ROADMAP.md`](ROADMAP.md) is the public strategic view. Current-state,
governance, verification, sequencing, and release evidence live in
[`docs/roadmap`](docs/roadmap/).

Private Beads/DoltHub data is the task authority. OpenCoven Project #10 is its
generated private view; the roadmap contains aggregates and outcomes, while
issues and pull requests remain delivery artifacts.

Check that the generated roadmap snapshot is current:

```bash
pnpm roadmap:status check
```

## Verify

```bash
pnpm test:unit
pnpm typecheck
pnpm --filter @opencoven/agent-contracts typecheck
pnpm --filter @opencoven/harness typecheck
pnpm build
```


`pnpm build` invokes `pnpm validate:runtime`, which enforces the audience in a
production environment (`VERCEL_ENV=production`, or `NODE_ENV=production`
outside a Vercel preview/development build). `pnpm start` first runs the
explicit `pnpm validate:release` preflight. Production validation requires one
exact audience declaration:

- `RELEASE_AUDIENCE=closed-beta`, `BETA_MODE=on`, and a reviewed, nonempty
  `BETA_ALLOWLIST` containing valid email addresses; or
- `RELEASE_AUDIENCE=public` and `BETA_MODE=off`, after separate public-release
  approval.

Ordinary local, test, and Vercel preview `validate:runtime` runs do not require
`RELEASE_AUDIENCE`; that convenience is not production approval. Run
`pnpm validate:release` with the intended production configuration before
promotion even when the local build gate passes.
