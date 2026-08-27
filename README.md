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

Agents run on the cloud runner: Cloudflare Workers + Agents SDK + Sandbox SDK.
Every agent receives persistent Durable Object state and a stable isolated
container.

## Security model

"YOLO" means tool approvals are disabled. It does **not** mean cloud tasks escape
their container.

Review the living [Execution threat model](docs/security/execution-threat-model.md)
before changing identity, credentials, tenancy, runner boundaries, or evidence
handling.

Review the [Guest access and safety
boundary](docs/security/guest-access.md) before changing public replay,
account creation, subscription gates, or any route that can consume or persist
resources.

When something has already gone wrong, follow
[Security incident response](docs/security/incident-response.md). It has a
rotation runbook for every credential in the system, and the order matters:
rotate first, investigate second.

**Execution**

- Every agent executes in its own per-agent Cloudflare sandbox container.

**Two tokens, two jobs.** Reaching the worker at all and being someone are
deliberately separate. `X-Runner-Token` is a coarse deployment gate and no
tenant is ever derived from it. Identity travels on `Authorization` as an
Ed25519-signed claim the worker can verify but not mint, so it can trust the
`tenant` inside without being able to forge one. Signatures are raw Ed25519
rather than JWT: there is no `alg` field, so there is no `alg:none` or
HS256-for-RS256 confusion to get wrong.

**Credentials belong to tenants.** The operator's credentials are never lent
out. Each tenant supplies their own harness credential; it is stored under
envelope encryption (a per-credential AES-GCM data key wrapped by
`CREDENTIAL_KEK`), fetched for the duration of one run, and redacted from run
evidence. The worker holds no key material of its own.

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
on every token callback, and subscriber-claiming sessions are revalidated
against the current database value before resource access. Guests are rejected
without that lookup; expiry or revocation cannot wait for the browser token to
expire. The internal compatibility label remains `demo`.

**Browser storage.** Runner connection details live in session storage, not
persistent local storage, and the console is served its connection by the app
rather than asking a human to paste a token.

**Commit scanning.** The pre-commit hook scans staged Git content for recognized
credential shapes before formatting runs. Findings identify only the file,
line, and credential category; matching values are never printed. Use
`pnpm secret:scan:all` to scan every tracked file. Synthetic security fixtures
must use a reviewed `secret-scan: allow-next-line -- <reason>` marker.

## Install

Requirements:

- Node.js 22 or newer
- pnpm 10
- Docker for local Cloudflare Sandbox development and deployment

```bash
pnpm install
cp .env.example .env.local
```

Generate the local app's runner identity, connection, and
credential-encryption values in a private terminal, then copy the five
assignments into `.env.local`. The three random calls deliberately produce
separate values; `CREDENTIAL_KEK` is exactly 32 random bytes encoded as
base64url.

```bash
node --input-type=module -e '
import { randomBytes, webcrypto } from "node:crypto";
const pair = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const pkcs8 = await webcrypto.subtle.exportKey("pkcs8", pair.privateKey);
const spki = await webcrypto.subtle.exportKey("spki", pair.publicKey);
console.log("AGENT_CONTROL_TOKEN=" + randomBytes(32).toString("base64url"));
console.log("RUNNER_SIGNING_KEY=" + Buffer.from(pkcs8).toString("base64url"));
console.log("RUNNER_VERIFY_KEY=" + Buffer.from(spki).toString("base64url"));
console.log("RUNNER_SERVICE_TOKEN=" + randomBytes(32).toString("base64url"));
console.log("CREDENTIAL_KEK=" + randomBytes(32).toString("base64url"));
'
```

Do not copy the output into logs, issues, or tracked files.
`RUNNER_SIGNING_KEY` and `CREDENTIAL_KEK` stay app-only. Copy the same
`AGENT_CONTROL_TOKEN`, `RUNNER_VERIFY_KEY`, and `RUNNER_SERVICE_TOKEN` values
to the Worker; the public key lets it verify app-minted claims without being
able to mint one. `AGENT_CONTROL_TOKEN` and `RUNNER_SERVICE_TOKEN` are separate
credentials: the first gates app-to-Worker requests, while the second
authenticates the Worker's call back to the app's credential endpoint. Never
reuse one as the other.

## Run the control plane

```bash
pnpm dev
```

Open <http://localhost:3000/agents>.

## Run the runner

Create `worker/.dev.vars`:

```dotenv
AGENT_CONTROL_TOKEN=copy-the-exact-app-env-local-value
EDGE_ABUSE_KEY_SECRET=replace-with-a-long-random-secret
RUNNER_VERIFY_KEY=copy-the-exact-app-env-local-spki-value
RUNNER_SERVICE_TOKEN=copy-the-exact-app-env-local-value
APP_ORIGIN=http://localhost:3000
```

**The worker holds no harness credential.** It used to read
`COPILOT_GITHUB_TOKEN` from its own environment, which meant every tenant ran
on the operator's GitHub access. That is gone: `requireHarness` never consults
`env`, and the only source of a harness credential is the tenant's own,
encrypted per-tenant and fetched over an internal call for the duration of a
single run. Setting `COPILOT_GITHUB_TOKEN` on the worker now does nothing.

Each tenant supplies their own credential through the console, which is stored
under envelope encryption — a per-credential AES-GCM data key wrapped by
`CREDENTIAL_KEK`. Accepted values for a Copilot harness are a fine-grained PAT
with the "Copilot Requests" permission, or an OAuth token from the Copilot CLI
or `gh` app. Classic `ghp_` tokens are not supported.

`RUNNER_SERVICE_TOKEN` and `APP_ORIGIN` are how the worker asks the app for
that credential. Both must be set, and the service token must match the app's.
Missing either throws rather than running uncredentialed, because a silent
fallback is how a run would quietly use the wrong identity.

Then:

```bash
docker info
pnpm --filter @opencoven/cloud-runner types
pnpm --filter @opencoven/cloud-runner exec wrangler dev \
  --var ALLOWED_ORIGIN:http://localhost:3000
```

The committed Wrangler configuration contains the production
`ALLOWED_ORIGIN`. The command-line variable is a noncommitted local override;
do not edit the production origin merely to run localhost.

For deployment, set the secrets without committing them:

```bash
cd worker
pnpm wrangler secret put AGENT_CONTROL_TOKEN
pnpm wrangler secret put EDGE_ABUSE_KEY_SECRET
pnpm wrangler secret put RUNNER_VERIFY_KEY
pnpm wrangler secret put RUNNER_SERVICE_TOKEN
pnpm wrangler secret put APP_ORIGIN
pnpm deploy
```

`EDGE_ABUSE_KEY_SECRET` must be a long random value unique to the Worker
deployment. It HMAC-pseudonymizes source IP and tenant rate-limit keys; if it
is absent, the Worker fails closed with `503` before serving non-preflight
requests.

Confirm the committed `ALLOWED_ORIGIN` in `worker/wrangler.jsonc` matches the
deployed web origin and set `NEXT_PUBLIC_CLOUD_RUNNER_URL` on the web deployment.

`AGENT_CONTROL_TOKEN` is read from the `env` binding, not from `process.env`.
A Worker only exposes `vars` on `process.env`, and only under `nodejs_compat`;
secrets never appear there. Reading a secret from `process.env` yields
`undefined`, and because the token check treats an unset token as "deny", the
symptom is a Worker that returns `401` to every request including a correct
one. `worker/src/worker-secrets.d.ts` declares the secret on `Env` so this
stays type-checked.

After deployment, `POST /api/diagnostics/sandbox` performs an authenticated,
one-shot command in a dedicated Cloudflare container. The fixed diagnostic
sandbox is reused and automatically sleeps after 30 seconds of inactivity,
which bounds container allocation without keeping it alive. Use it as the
deployment smoke test:

The diagnostic requires both the deployment gate and a fresh subscriber
identity claim. Sign in to the app as an active subscriber and obtain that
claim from the authenticated app's `POST /api/runner-token` route. That route
is not a public minting endpoint and refuses non-subscribers. Place the returned
token in `RUNNER_IDENTITY_TOKEN` using the authorized operator's authenticated
workflow.

```bash
curl -s -X POST \
  -H "x-runner-token: $AGENT_CONTROL_TOKEN" \
  -H "Authorization: Bearer $RUNNER_IDENTITY_TOKEN" \
  https://<your-worker>.workers.dev/api/diagnostics/sandbox
# {"exitCode":0,"ok":true,"output":"coven-agents"}
```

## Harness execution

The current cloud backend spawns an already-authenticated coding CLI — the
*harness* — and translates its event stream into one normalized vocabulary. The
previous local runner was removed, and the shared contract now accepts only
`cloud`. The control plane is never a model client, so it needs no provider
credential.

- `packages/harness` is the single definition of the CLI subset, the JSONL event
  normalizer, and the run summarizer. The sandbox calls it, so normalization
  cannot drift from the contract.
- The runner runs the harness inside the per-agent Cloudflare sandbox
  container. `worker/Dockerfile` installs `@github/copilot`, and
  `worker/wrangler.jsonc` builds the container from that Dockerfile.
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
pnpm --filter @opencoven/cloud-runner typecheck
pnpm build
```

Cloud sandbox startup and deployment additionally require a running Docker
daemon and authenticated Wrangler session.

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
