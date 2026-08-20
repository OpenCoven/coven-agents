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

After deployment, `POST /api/diagnostics/sandbox` performs an authenticated,
one-shot command in a dedicated Cloudflare container. The fixed diagnostic
sandbox is reused and automatically sleeps after 30 seconds of inactivity,
which bounds container allocation without keeping it alive. Use it as the
deployment smoke test.

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
