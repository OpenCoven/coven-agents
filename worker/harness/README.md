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
node harness/keys.mjs        # writes private.pem + verify-key.txt (gitignored)
```

Create `worker/.dev.vars` (gitignored):

```
AGENT_CONTROL_TOKEN=local-harness-control-token
EDGE_ABUSE_KEY_SECRET=local-harness-edge-secret
RUNNER_VERIFY_KEY_ID=key-local
RUNNER_VERIFY_KEY=<contents of harness/verify-key.txt>
RUNNER_SERVICE_TOKEN=local-harness-service-token
APP_ORIGIN=http://127.0.0.1:9797
ALLOWED_ORIGIN=*
```

## Each session

```bash
node harness/stub-credential.mjs &   # answers the credential fetch on :9797
npx wrangler dev --port 8788 &       # the worker, with real containers (Docker must be up)
node harness/run.mjs                 # create agent → run → poll to terminal
```

Exit 0 is a completed run, 2 is a terminal failure (printed with its error),
3 is the driver's own ten-minute patience running out.

## What it proves and what it cannot

Proves: routes, identity verification, run lifecycle, container boot, the
version probe, process-polling transport, event persistence, evidence
capture, and every timeout and error path — on real workerd against a real
container.

With the stub credential the mission ends in copilot's own authentication
refusal, which still exercises every mechanical layer. Exporting a real
`COPILOT_GITHUB_TOKEN` before starting the stub upgrades it to full
missions.

Cannot prove: Cloudflare's production placement behaviour — cold-host image
pulls and the not-ready 500s live only there. For those, read the deployed
worker's own structured logs; the boot-time evidence in
`src/harness-runner.ts`'s probe comments came from them.
