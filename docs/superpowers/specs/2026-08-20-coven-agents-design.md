# Coven Agents Design

## Goal

Recreate the BunsDev chatbot template as an OpenCoven control plane that creates
autonomous agents and runs them through interchangeable cloud and local
backends.

## Architecture

The existing Next.js template remains the web foundation. A new `/agents`
surface owns runner connection settings, agent creation, mission submission,
and result display. It talks only to the shared versioned JSON contract in
`@opencoven/agent-contracts`.

The cloud backend is a Cloudflare Worker. An `AgentDirectory` Durable Object
indexes agents, while each `YoloAgent` Durable Object owns one definition and a
bounded run history. The agent receives a stable Cloudflare Sandbox container.
OpenAI Agents SDK shell and patch tools run with `needsApproval: false`, but all
effects remain inside that container.

The local backend is a loopback-only Node service with the same REST contract.
It persists definitions to a private JSON file and starts an installed Copilot,
Codex, or Claude CLI with that harness's explicit no-approval flags. Workspace
paths must resolve under `OPENCOVEN_LOCAL_ROOT`.

## Data flow

1. The operator selects cloud or local and enters that runner's endpoint/token.
2. The browser validates and sends an agent definition to `POST /api/agents`.
3. The runner persists the definition and returns its generated UUID.
4. A mission sent to `POST /api/agents/:id/runs` executes with no interactive
   approval prompts.
5. The runner returns a bounded result containing final output, command
   evidence, file-operation evidence, timestamps, and completion status.

## Security and failure behavior

Every non-health API request requires a bearer token. CORS reflects only the
configured web origin. JSON request bodies and captured local output are
bounded. Cloud sandboxes are stable per agent and destroyed when an agent is
deleted. Local execution is intentionally powerful, but the server binds only
to loopback and rejects workspaces outside its configured root.

Malformed requests return structured errors. Failed agent missions are retained
as failed run results rather than disguised as successful responses. Missing
CLI binaries, timeouts, and output-limit termination leave the agent in an
error state with diagnostic output.

## Testing

Contract tests cover backend/runtime invariants and task validation. Browser
client tests cover endpoint normalization, bearer authentication, and error
propagation. Cloud HTTP tests cover CORS and request bounds. Local runtime tests
cover no-approval flags and workspace traversal rejection. Typechecks cover each
workspace independently, followed by the Next.js production build.
