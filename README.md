# Coven Agents

**Coven Agents** is a local-cloud hybrid control plane for creating and
running autonomous coding agents. It is derived from
[BunsDev/chatbot](https://github.com/BunsDev/chatbot) and keeps that template's
Next.js, React, Tailwind, and shadcn/ui foundation.

The same browser UI can connect to:

- **Cloud runner:** Cloudflare Workers + Agents SDK + Sandbox SDK. Every agent
  receives persistent Durable Object state and a stable isolated container.
- **Local runner:** a loopback-only Node service that launches GitHub Copilot
  CLI, Codex CLI, or Claude Code in their explicit no-approval modes.

## Security model

“YOLO” means tool approvals are disabled. It does **not** mean cloud tasks escape
their container.

- Cloud agents execute in per-agent Cloudflare sandboxes.
- The Worker API and local runner require bearer tokens.
- The local runner binds to `127.0.0.1` and limits workspaces to
  `OPENCOVEN_LOCAL_ROOT`.
- Local CLI processes inherit the operating-system permissions of the runner.
  Run it only on a machine and workspace you trust.
- Browser tokens are stored in session storage, not persistent local storage.

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
| `OPENCOVEN_RUN_STORE` | `.opencoven/runs.json` | Private persistent run snapshots and events |
| `OPENCOVEN_RUN_TIMEOUT_MS` | `900000` | Per-run timeout |
| `OPENCOVEN_ALLOWED_ORIGIN` | `http://localhost:3000` | Browser origin |

## Run the cloud backend

Create `worker/.dev.vars`:

```dotenv
AGENT_CONTROL_TOKEN=replace-with-a-long-random-token
OPENAI_API_KEY=replace-with-an-openai-key
```

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
pnpm wrangler secret put OPENAI_API_KEY
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
  -H "authorization: Bearer $AGENT_CONTROL_TOKEN" \
  https://<your-worker>.workers.dev/api/diagnostics/sandbox
# {"exitCode":0,"ok":true,"output":"coven-agents"}
```

Agent create, list, and delete work without an OpenAI key. Running an agent
requires `OPENAI_API_KEY`; without it a run completes with status `failed` and
a missing-credentials message rather than erroring the request.

## Agent Runner v1 routes and lifecycle

Both the local and cloud Agent Runner v1 endpoints expose the same lifecycle
routes. The local base URL is `http://127.0.0.1:7331`; the cloud base URL is
the deployed Worker URL. Every route except `GET /api/health` requires the
runner bearer token.

| Method | Route | Result |
| --- | --- | --- |
| `GET` | `/api/health` | Version, capabilities, and runner mode |
| `GET`, `POST` | `/api/agents` | List or create profiles |
| `GET`, `PUT`, `DELETE` | `/api/agents/:id` | Read, update, or remove a profile |
| `POST` | `/api/agents/:id/runs` | Asynchronously accept a mission (`202`) |
| `GET` | `/api/runs/:id` | Read the latest run snapshot |
| `GET` | `/api/runs/:id/events` | Replay and follow lifecycle events as SSE |
| `POST` | `/api/runs/:id/stop` | Request cancellation |

Starting a mission is asynchronous. Send a UUID `operationId` with the task;
repeating the same normalized request returns the original retained run, while
reusing the operation ID for a different request returns `409`.

```bash
curl -s -X POST \
  -H "authorization: Bearer <token>" \
  -H "content-type: application/json" \
  -d '{"operationId":"0f6f31ae-7b6c-49c9-bc82-0f2cbf56cc4d","task":"Run the focused tests."}' \
  http://127.0.0.1:7331/api/agents/<agent-id>/runs
# HTTP 202: {"apiVersion":"1.0","run":{"status":"queued",...}}
```

Poll `GET /api/runs/<run-id>`, replay lifecycle events with
`GET /api/runs/<run-id>/events` and `Last-Event-ID`, or cancel with
`POST /api/runs/<run-id>/stop`. SSE cursors replay each retained event once in
monotonic ID order. A cloud event stream remains open for a live run until it
reaches a terminal state, the client aborts, or its bounded idle policy expires.
Terminal snapshots and bounded evidence remain available after a local-runner
restart.

### Cloud scratch-only limitation

Cloud profiles may use only the `/workspace` scratch sandbox (or omit
`workspace`, which resolves to `/workspace`). The cloud runner rejects host
paths and Git URLs; it does not mount an operator filesystem or clone a
client-supplied repository. Use the local runner when a mission must operate
on a local checkout.

## Verify

```bash
pnpm test:unit
pnpm typecheck
pnpm --filter @opencoven/agent-contracts typecheck
pnpm --filter @opencoven/local-runner typecheck
pnpm --filter @opencoven/cloud-runner typecheck
pnpm build
```

Cloud sandbox startup and deployment additionally require a running Docker
daemon and authenticated Wrangler session.
