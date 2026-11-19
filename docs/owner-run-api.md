# Run an agent from a machine client

Use the same application origin that owns the agent. In an authenticated subscriber browser session, POST JSON to `/api/agents/{agentId}/owner-credentials` with a `scopes` array containing the operations the client needs. Supported values are `run:start`, `run:read`, `run:events`, `run:stop` and `sandbox:inspect`. The response contains the credential ID, expiry and a one-time secret. Keep the secret out of shell history, logs and URLs. GET on the same route lists metadata. DELETE on the same route accepts a JSON object with the credential ID in the `id` field. Issuance and revocation require the browser origin and subscriber cookie.

For a local client, the following Python example prompts for the secret without echoing it, starts one run and reads its current state. Supply the HTTPS application origin and the exact agent UUID. Issue both start and read scopes for this example.

```python
from getpass import getpass
import json
from urllib.request import build_opener, HTTPRedirectHandler, Request
from uuid import UUID, uuid4

origin = input("Application HTTPS origin: ").strip().rstrip("/")
agent = UUID(input("Owned agent UUID: ").strip())
if not origin.startswith("https://"):
    raise ValueError("HTTPS is required")
secret = getpass("Owner credential: ")

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

opener = build_opener(NoRedirect())

def call(path, body=None):
    headers = {"Authorization": "Bearer " + secret}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    with opener.open(Request(origin + path, data=data, headers=headers), timeout=30) as response:
        return json.load(response)

started = call(f"/api/agents/{agent}/runs", {"operationId": str(uuid4()), "task": "Report the workspace status."})
run_id = UUID(started["run"]["id"])
print(call(f"/api/runs/{run_id}")["run"]["status"])
```

GET `/api/runs/{runId}/events` with the events scope to stream SSE. Reconnect with the last observed numeric event ID in `Last-Event-ID`. POST to `/api/runs/{runId}/stop` with the stop scope to request cancellation. GET `/api/runs/{runId}` with the read scope for terminal state. Inspection uses POST `/api/agents/{agentId}/sandbox/inspection` with its own scope and the expected sandbox ID and generation. Use the same operation ID when retrying the same start. Returning a pre-existing snapshot on replay requires the originating credential and read scope.

## Migrations and rollback

The runner-first migration order is 0044 for run binding, 0045 for its consistency check and 0046 for scoped credentials. If this chain lands first, the billing branch needs a new migration generated against 0046. Check migration history before applying either branch to an existing environment. Use disposable PostgreSQL 16 to run `pnpm db:verify` and `pnpm test:e2e:hermetic` locally.

For a future rollback, revoke issued grants and drain or terminalize machine-authorized queued runs while their dispatch checks still exist. Preserve authority records and run history. The local qualification uses disposable data.
