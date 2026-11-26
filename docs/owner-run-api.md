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

GET `/api/runs/{runId}/events` with the events scope to stream SSE. Reconnect with the last observed numeric event ID in `Last-Event-ID`. POST to `/api/runs/{runId}/stop` with the stop scope to request cancellation. A stop-only credential receives an empty 202 while cancellation is in progress or an empty 204 after it completes. A credential with both stop and read scope receives the run snapshot. GET `/api/runs/{runId}` with the read scope for terminal state. Inspection uses POST `/api/agents/{agentId}/sandbox/inspection` with its own scope and the expected sandbox ID and generation. Use the same operation ID when retrying the same start. Returning a pre-existing snapshot on replay requires the originating credential and read scope.

To distinguish missing provider metadata from a reported empty attachment or TTL, send `"includeProviderMetadata": true` in the inspection request body. On an observed result, read `observed.providerMetadata`. Its `autoDestroyAtConfigured`, `linkedSandbox` and `warmPool` fields are null when the corresponding Daytona field is omitted, false when explicitly null, and true when a value is configured. Its `volumes` field is null for an unreported list and otherwise contains the reported count, including zero. Malformed metadata still produces provider unavailability. The nested `platform.os` and `platform.architecture` fields are null because Daytona SDK 0.231.1 exposes neither value on the exact-ID Sandbox response. A consumer that infers a platform from its qualified snapshot pin must track that inference separately. Clients that omit the option receive the original v1 response shape.

## Migrations and rollback

The runner-first migration order is 0044 for run binding, 0045 for its consistency check and 0046 for scoped credentials. If this chain lands first, the billing branch needs a new migration generated against 0046. Check migration history before applying either branch to an existing environment. Use disposable PostgreSQL 16 to run `pnpm db:verify` and `pnpm test:e2e:hermetic` locally.

For a future rollback, revoke issued grants and drain or terminalize machine-authorized queued runs while their dispatch checks still exist. Preserve authority records and run history. The local qualification uses disposable data.

## Bind a pre-existing sandbox

From the authenticated owner's browser, POST to `/api/agents/{agentId}/sandbox/binding` with the configured origin, JSON content type and a body containing `expectedSandboxId` and `expectedGeneration`. This writes the agent's binding after an exact provider lookup. The sandbox must already be started, private, labelled for this tenant, agent and generation, and stamped with the current configuration and credential-boundary versions. Its observed snapshot, resources, intervals, egress policy and attachments must also match. Existing run and cleanup fences take precedence. An inspector credential grants read-only inspection and cannot establish a binding.

After a successful bind, even a start that omits the optional sandbox expectation is pinned to the recorded ID and generation. Refusal carries a reason such as `generation_mismatch`, `ownership_mismatch` or `configuration_drift`. Dispatch cannot provision a substitute. Automatic prewarm and routine resource-floor repair leave pinned sandboxes untouched. Once a bound run has started, its snapshot exposes `executedSandbox.generation` and an agent-scoped SHA-256 `bindingDigest`. The digest covers the JSON array containing the literal `bound-sandbox-v1`, tenant, agent ID and exact sandbox ID. Queued and pre-launch refusals omit execution evidence.

Migration 0047 adds the persistent agent pin after the owner-credential migration. If the runner stack lands first, regenerate billing’s pending migration against 0047. Before rolling back the application, suspend new admissions for pinned agents and drain their queued runs while pin enforcement is available. Preserve the recorded IDs, generations and run evidence.

## Attempt identity and admission

Read `run.id` and optional `run.attemptRef` from the authorized run snapshot. The server omits the reference until it prepares an attempt. Store the pair as opaque identifiers. Replaying the same operation and payload, reconnecting, or reading after cleanup returns the current or final reference. A new preparation allocates a fresh reference. The [prepared run fixture](fixtures/owner-run-attempt.json) shows a queued run after preparation and before launch.

When an agent already has a queued or running run or outstanding attempt cleanup, a distinct bound start returns HTTP 409 with `error.code` equal to `sandbox_binding_refused`, `error.details` equal to `fence_outstanding` and `error.retryable` equal to `false`. The refused operation creates no run. After terminal cleanup, a new bound operation can start.
