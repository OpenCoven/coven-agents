# Coven Agents

**Coven Agents** is a local-cloud hybrid product control plane for creating
bounded execution profiles and running coding missions. It is derived from
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

The same browser UI can connect to:

- **Cloud runner:** Cloudflare Workers + Agents SDK + Sandbox SDK. Every agent
  receives persistent Durable Object state and a stable isolated container.
- **Local runner:** a loopback-only Node service that launches GitHub Copilot
  CLI, Codex CLI, or Claude Code in their explicit no-approval modes.

## Security model

"YOLO" means tool approvals are disabled. It does **not** mean cloud tasks escape
their container.

Review the living [Execution threat model](docs/security/execution-threat-model.md)
before changing identity, credentials, tenancy, runner boundaries, or evidence
handling.

**Execution**

- Cloud agents execute in per-agent Cloudflare sandboxes.
- The local runner binds to `127.0.0.1` and limits workspaces to
  `OPENCOVEN_LOCAL_ROOT`.
- Local CLI processes inherit the operating-system permissions of the runner.
  Run it only on a machine and workspace you trust.

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

**The database is subscriber-only.** `databaseFor` accepts a
`SubscriberSession` and nothing else, so a demo code path that tries to reach
the database fails to compile rather than being caught in review.

**Sessions.** A signed-out visitor gets a stateless demo session — an httpOnly
cookie, no database row. Subscription state is recomputed from
`subscribedUntil` on every token callback, so access ends when payment does
rather than when the token happens to expire.

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
- At least one supported CLI for local runs (`copilot`, `codex`, or `claude`)

```bash
pnpm install
cp .env.example .env.local
```

## Run the control plane

```bash
pnpm dev
```

Open <http://localhost:3000/agents>.

## Run the local backend

Generate a token and start the loopback service:

```bash
export OPENCOVEN_LOCAL_TOKEN="$(openssl rand -hex 32)"
export OPENCOVEN_LOCAL_ROOT="$HOME/Documents/GitHub"
pnpm dev:local-runner
```

The local runner listens on `http://127.0.0.1:7331`. Enter the same token in the
control plane's **Connect** panel.

Optional variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENCOVEN_LOCAL_PORT` | `7331` | Loopback port |
| `OPENCOVEN_LOCAL_ROOT` | current directory | Maximum workspace boundary |
| `OPENCOVEN_AGENT_STORE` | `.opencoven/agents.json` | Private agent registry |
| `OPENCOVEN_RUN_TIMEOUT_MS` | `900000` | Per-run timeout |
| `OPENCOVEN_ALLOWED_ORIGIN` | `http://localhost:3000` | Browser origin |

## Run the cloud backend

Create `worker/.dev.vars`:

```dotenv
AGENT_CONTROL_TOKEN=replace-with-a-long-random-token
RUNNER_VERIFY_KEY=replace-with-the-base64url-ed25519-public-key
RUNNER_SERVICE_TOKEN=replace-with-a-long-random-token
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
pnpm dev:cloud
```

For deployment, set the secrets without committing them:

```bash
cd worker
pnpm wrangler secret put AGENT_CONTROL_TOKEN
pnpm wrangler secret put RUNNER_VERIFY_KEY
pnpm wrangler secret put RUNNER_SERVICE_TOKEN
pnpm wrangler secret put APP_ORIGIN
pnpm deploy
```

Update `ALLOWED_ORIGIN` in `worker/wrangler.jsonc` to the deployed web origin and
set `NEXT_PUBLIC_CLOUD_RUNNER_URL` on the web deployment.

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

```bash
curl -s -X POST \
  -H "x-runner-token: $AGENT_CONTROL_TOKEN" \
  https://<your-worker>.workers.dev/api/diagnostics/sandbox
# {"exitCode":0,"ok":true,"output":"coven-agents"}
```

## Harness execution

Both backends run the same way: Coven Agents spawns an already-authenticated
coding CLI — the *harness* — and translates its event stream into one normalized
vocabulary. The control plane is never a model client, so it needs no provider
credential.

- `packages/harness` is the single definition of the CLI subset, the JSONL event
  normalizer, and the run summarizer. The local runner and the sandbox both call
  it, so the two backends cannot drift.
- The cloud backend runs the harness inside the per-agent Cloudflare sandbox
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

## Verify

```bash
pnpm test:unit
pnpm typecheck
pnpm --filter @opencoven/agent-contracts typecheck
pnpm --filter @opencoven/harness typecheck
pnpm --filter @opencoven/local-runner typecheck
pnpm --filter @opencoven/cloud-runner typecheck
pnpm build
```

Cloud sandbox startup and deployment additionally require a running Docker
daemon and authenticated Wrangler session.
