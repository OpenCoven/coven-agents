# Local run harness

The full worker stack against a real local container, driven end to end
without a browser, a deploy, or another person's session. One iteration is
~15 seconds; the production loop it replaces was ten minutes of someone
else's time.

It exists because one night this project validated seven consecutive worker
fixes by asking the operator to click Run in production and watch. Do not do
that again. Nothing ships to the worker until this loop has run the exact
code.

## One-time setup

```bash
cd worker
node harness/keys.mjs        # writes private.pem + verify-key.txt (gitignored)
```

Create `worker/.dev.vars` (gitignored):

```
AGENT_CONTROL_TOKEN=<random-control-token>
OPERATOR_DIAGNOSTIC_TOKEN=<different-random-operator-token>
EDGE_ABUSE_KEY_SECRET=local-harness-edge-secret
RUNNER_VERIFY_KEY_ID=key-local
RUNNER_VERIFY_KEY=<contents of harness/verify-key.txt>
RUNNER_AUTH_VERSION=0
RUNNER_SERVICE_TOKEN=<random-service-token>
RUNNER_URL=http://127.0.0.1:8788
APP_ORIGIN=http://127.0.0.1:9797
ALLOWED_ORIGIN=*
```

## Each session

```bash
cd worker
pnpm harness:stub &                  # answers authority and credential fetches on :9797
pnpm dev -- --port 8788 &            # the worker, with real containers (Docker must be up)
pnpm harness:run                     # create agent → run → poll to terminal
```

The `harness:*` package scripts explicitly load `worker/.dev.vars` with
Node's `--env-file-if-exists` support. All three scripts validate and reuse the
same `RUNNER_VERIFY_KEY_ID`, `RUNNER_AUTH_VERSION`, `RUNNER_SERVICE_TOKEN`, and
`AGENT_CONTROL_TOKEN`; the only default is the non-secret local `RUNNER_URL`.
Missing control or service tokens fail before a request is made.

Exit 0 is a completed run, 2 is a terminal failure (printed with its error),
3 is the driver's own ten-minute patience running out.

## What it proves and what it cannot

Proves: routes, identity verification, run lifecycle, container boot, the
version probe, process-polling transport, event persistence, evidence
capture, and every timeout and error path — on real workerd against a real
container.

The stub verifies the configured service token, the Ed25519 fixture signature,
the versioned `kid`, the current `authVersion`, and the fixture tenant before
answering either internal endpoint. With the default stub credential the
mission ends in copilot's own authentication refusal, which still exercises
every mechanical layer. Exporting a real `COPILOT_GITHUB_TOKEN` before
starting the stub upgrades it to full missions.

Cannot prove: Cloudflare's production placement behaviour — cold-host image
pulls and the not-ready 500s live only there. For those, read the deployed
worker's own structured logs; the boot-time evidence in
`src/harness-runner.ts`'s probe comments came from them.
