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

Runner key configuration and rollback are documented in the
[runner key rotation runbook](docs/security/key-rotation.md).

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
the versioned `CREDENTIAL_KEK_V1`/`CREDENTIAL_KEK_V2` ring), fetched for the
duration of one run, and redacted from run evidence. The worker holds no key
material of its own. See the [credential KEK rotation runbook](docs/security/key-rotation.md).

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

Generate the local app's versioned runner identity, deployment gate, internal
service credential, and credential-encryption key in a private terminal. Copy
the assignments into `.env.local`; each random call deliberately creates a
different credential.

```bash
node --input-type=module -e '
import { randomBytes, webcrypto } from "node:crypto";
const pair = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const pkcs8 = await webcrypto.subtle.exportKey("pkcs8", pair.privateKey);
const spki = await webcrypto.subtle.exportKey("spki", pair.publicKey);
console.log("AGENT_CONTROL_TOKEN=" + randomBytes(32).toString("base64url"));
console.log("RUNNER_SERVICE_TOKEN=" + randomBytes(32).toString("base64url"));
console.log("RUNNER_SIGNING_KEY_ID=key-local");
console.log("RUNNER_SIGNING_KEY=" + Buffer.from(pkcs8).toString("base64url"));
console.log("RUNNER_SIGNING_PUBLIC_KEY=" + Buffer.from(spki).toString("base64url"));
console.log("CREDENTIAL_KEK_CURRENT_VERSION=v1");
console.log("CREDENTIAL_KEK=" + randomBytes(32).toString("base64url"));
'
```

Do not copy the output into logs, issues, or tracked files. The signing key and
credential KEK stay app-only. Copy the same
`AGENT_CONTROL_TOKEN` and `RUNNER_SERVICE_TOKEN` values to the Worker.
`AGENT_CONTROL_TOKEN` and `RUNNER_SERVICE_TOKEN` are separate credentials:
the first gates app-to-Worker requests, while the second authenticates
Worker-to-app internal calls. Copy `RUNNER_SIGNING_KEY_ID` to
Worker `RUNNER_VERIFY_KEY_ID` and copy the SPKI
`RUNNER_SIGNING_PUBLIC_KEY` value to Worker `RUNNER_VERIFY_KEY`. Generate a
separate `OPERATOR_DIAGNOSTIC_TOKEN`; it must never reuse either app-to-Worker
credential. The legacy app `RUNNER_VERIFY_KEY`/`RUNNER_SIGNING_KEY` pair is
supported only while migrating to the explicit key ID and public-key fields.

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

## Run the runner

Create `worker/.dev.vars`:

```dotenv
AGENT_CONTROL_TOKEN=copy-the-exact-app-env-local-value
OPERATOR_DIAGNOSTIC_TOKEN=replace-with-a-different-long-random-token
EDGE_ABUSE_KEY_SECRET=replace-with-a-long-random-secret
RUNNER_VERIFY_KEY_ID=copy-the-app-runner-signing-key-id
RUNNER_VERIFY_KEY=copy-the-app-runner-signing-public-key
RUNNER_AUTH_VERSION=0
# Optional during rotation; retire only after token expiry plus skew.
RUNNER_VERIFY_PREVIOUS_KEY_ID=key-2026-07
RUNNER_VERIFY_PREVIOUS_KEY=replace-with-the-old-base64url-ed25519-public-key
RUNNER_VERIFY_PREVIOUS_LAST_SIGNED_AT=2026-08-27T00:00:00.000Z
RUNNER_VERIFY_PREVIOUS_RETIRE_AT=2026-08-27T00:15:00.000Z
RUNNER_SERVICE_TOKEN=copy-the-exact-app-env-local-value
APP_ORIGIN=http://localhost:3000
```

The app uses the matching versioned signing configuration:
`RUNNER_SIGNING_KEY_ID`, `RUNNER_SIGNING_KEY`, and
`RUNNER_SIGNING_PUBLIC_KEY`. New tokens are minted only with the current key;
the Worker accepts the current key and an unexpired previous public key.
Deploy rotation in this order: add the new Worker current key while retaining
the old key as previous, switch the app signing key, wait 15 minutes plus
clock skew, then remove the old key. Roll back by switching the app signer
back while retaining both verification keys until the original expiry window
has elapsed. Never log or commit key material; use Vercel and Wrangler
secrets. The legacy `RUNNER_VERIFY_KEY`/`RUNNER_SIGNING_KEY` pair remains
supported only as an explicit migration compatibility path.

**The worker holds no harness credential.** It used to read
`COPILOT_GITHUB_TOKEN` from its own environment, which meant every tenant ran
on the operator's GitHub access. That is gone: `requireHarness` never consults
`env`, and the only source of a harness credential is the tenant's own,
encrypted per-tenant and fetched over an internal call for the duration of a
single run. Setting `COPILOT_GITHUB_TOKEN` on the worker now does nothing.

Each tenant supplies their own credential through the console, which is stored
under envelope encryption — a per-credential AES-GCM data key wrapped by
the versioned KEK ring. Production must configure
`CREDENTIAL_KEK_CURRENT_VERSION=v2`,
`CREDENTIAL_KEK_V1`, and `CREDENTIAL_KEK_V2`; local and CI builds may leave
all `CREDENTIAL_KEK*` variables unset. New rows use AAD version `1`, binding
the ciphertext to the tenant and harness; legacy rows are explicitly marked
AAD version `0` and never fall back to another format. During the staged
migration, drain old readers and writers, then run
`pnpm credentials:rewrap bind-aad --batch 100` until it exits `0`. The command
decrypts and re-encrypts one row in memory and CAS-protects the update. The old
`CREDENTIAL_KEK` name may alias only `v1` and is not a current-key fallback.
Keep both versioned keys until `pnpm credentials:rewrap verify --version v1`
passes with zero `v1` and `aadVersion=0` rows.
Rewrap is resumable: exit `0` means complete, exit `2` means resume after
skips or remaining rows, and exit `1` means configuration or data failure.
Accepted values for a Copilot harness are a fine-grained PAT with the
"Copilot Requests" permission, or an OAuth token from the Copilot CLI or `gh`
app. Classic `ghp_` tokens are not supported.

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
do not edit the production origin merely to run localhost. For the standalone
Docker-backed harness and its stub app, follow
[`worker/harness/README.md`](worker/harness/README.md), which uses its own local
`APP_ORIGIN`.

For deployment, set the secrets without committing them:

```bash
cd worker
pnpm wrangler secret put AGENT_CONTROL_TOKEN
pnpm wrangler secret put OPERATOR_DIAGNOSTIC_TOKEN
pnpm wrangler secret put EDGE_ABUSE_KEY_SECRET
pnpm wrangler secret put RUNNER_VERIFY_KEY
pnpm wrangler secret put RUNNER_VERIFY_KEY_ID
pnpm wrangler secret put RUNNER_VERIFY_PREVIOUS_KEY_ID
pnpm wrangler secret put RUNNER_VERIFY_PREVIOUS_KEY
pnpm wrangler secret put RUNNER_VERIFY_PREVIOUS_LAST_SIGNED_AT
pnpm wrangler secret put RUNNER_VERIFY_PREVIOUS_RETIRE_AT
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

`AGENT_CONTROL_TOKEN` and `OPERATOR_DIAGNOSTIC_TOKEN` are read from the `env`
binding, not from `process.env`. A Worker only exposes `vars` on `process.env`,
and only under `nodejs_compat`; secrets never appear there. Reading a secret
from `process.env` yields `undefined`. `worker/src/worker-secrets.d.ts`
declares both secrets on `Env` so this stays type-checked.

After deployment, `POST /api/diagnostics/sandbox` performs an authenticated,
one-shot command in a dedicated Cloudflare container. It accepts only the
separate `OPERATOR_DIAGNOSTIC_TOKEN` as a timing-safe bearer credential; the
browser-visible `AGENT_CONTROL_TOKEN` and subscriber identities are denied.
The fixed diagnostic sandbox is reused and automatically sleeps after 30
seconds of inactivity, which bounds container allocation without keeping it
alive. Use it as the deployment smoke test:

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $OPERATOR_DIAGNOSTIC_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{}' \
  https://<your-worker>.workers.dev/api/diagnostics/sandbox
# {"exitCode":0,"ok":true,"output":"coven-agents"}
```

## Harness execution

The current cloud backend spawns an already-authenticated coding CLI — the
*harness* — and translates its event stream into one normalized vocabulary. The
previous local runner was removed, and the shared contract now accepts only
`cloud`. The control plane is never a model client, so it needs no provider
credential.

For the Docker-backed local Worker loop, use the exact environment-loading
commands in [`worker/harness/README.md`](worker/harness/README.md). The
`harness:mint`, `harness:stub`, and `harness:run` scripts load
`worker/.dev.vars`; they do not contain a fallback control or service token.

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
