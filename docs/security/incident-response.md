# Security Incident Response

- Status: living document
- Owner: Security & privacy workstream
- Companion to: [Execution threat model](execution-threat-model.md)
- Applies to: control-plane, Daytona, database, billing, authentication, and
  operator credentials

Rotate first, investigate second. Deleting a value or rewriting Git history
does not revoke it. Announce a conservative blast radius early, then narrow it
with evidence.

## Severity

| Level | Meaning | Examples | First action |
| --- | --- | --- | --- |
| **S1** | Another tenant's data may be reachable | Credential KEK ring, `POSTGRES_URL`, tenant harness credential | Rotate or revoke immediately; notify affected tenants |
| **S2** | Infrastructure or product authority is controllable | `AUTH_SECRET`, `DAYTONA_API_KEY`, reconciliation or diagnostic credentials | Rotate immediately |
| **S3** | Cost or availability without a data boundary crossing | Endpoint discovery, refused request flood | Contain and measure |

Treat uncertainty as the higher severity until evidence proves otherwise.

## Credential inventory

| Secret | Stored in | Grants | Rotation cost |
| --- | --- | --- | --- |
| `CREDENTIAL_KEK_CURRENT_VERSION`, `CREDENTIAL_KEK_V1`, `CREDENTIAL_KEK_V2`, legacy `CREDENTIAL_KEK` | Vercel | Decrypting wrapped tenant credential data keys | Rewrap and verify before retirement |
| `POSTGRES_URL` and `PG*` | Vercel/Neon | Full database read/write | Brief downtime |
| `AUTH_SECRET` | Vercel | Forging application sessions | Everyone signs in again |
| `DAYTONA_API_KEY` | Vercel | Creating and controlling runner sandboxes | Runner unavailable during rotation |
| `OPERATOR_DIAGNOSTIC_TOKEN` | Vercel | Running the bounded diagnostic route | Diagnostics unavailable during rotation |
| `CRON_SECRET` | Vercel | Triggering scheduled reconciliation | Scheduled recovery pauses |
| `RUNNER_MANUAL_RECONCILE_SECRET` | Vercel/operator store | Triggering manual reconciliation | Manual recovery pauses |
| `AUTH_GITHUB_SECRET` | Vercel/GitHub | Impersonating the OAuth application | Sign-in pauses |
| `STRIPE_SECRET_KEY` | Vercel/Stripe | Charging and refunding | Billing operations pause |
| `STRIPE_WEBHOOK_SECRET` | Vercel/Stripe | Authenticating subscription events | Events retry until updated |
| Tenant harness credential | Encrypted database row | Acting as that tenant at GitHub | Tenant must revoke it |

The repository has no Cloudflare runtime, runner service token, browser runner
token, or runner signing/verification-key configuration. A separately deployed
legacy service, if one still exists during rollout, must be inventoried and
decommissioned operationally; this document does not claim that has happened.

Platform facts that affect every rotation:

- **Vercel Sensitive variables are write-only.** Pull and API operations return
  `[SENSITIVE]`; you cannot compare the stored value.
- **`vercel redeploy` reuses the existing build.** Server-side variables are
  picked up, but build-time public values require a new build.
- **`NEXT_PUBLIC_*` must never be Sensitive.** Public values are shipped to
  browsers, and secret visibility only makes the operator copy unreadable.
- `vercel env add` must pass `--sensitive` for secrets or `--no-sensitive` for
  public values. **`--sensitive` is required, not decorative.**
- **A redeploy is what makes the new value live.** Updating stored
  configuration alone does not change the serving deployment.
- A copied network trace is a credential disclosure because it includes
  request headers and cookies.

## First fifteen minutes

1. Name the exact credential and store. If uncertain, include every credential
   visible in the same file, terminal, trace, or screen.
2. Disable the affected route or provider authority when that reduces harm.
3. Rotate or revoke using the runbook below.
4. Redeploy or rebuild as required.
5. Prove the old value is rejected without printing either value.
6. Preserve sanitized timestamps, request IDs, run IDs, and provider IDs.
7. Investigate the escape path only after authority is contained.

## Runbooks

### Credential KEK ring

Removing the only configured KEK **destroys access to every stored credential**.
Do not delete a key while any credential or unexpired encrypted idempotency row
still names it.

1. Configure the existing key explicitly as `CREDENTIAL_KEK_V1`.
2. Add `CREDENTIAL_KEK_V2`, switch
   `CREDENTIAL_KEK_CURRENT_VERSION=v2`, retain v1, and deploy.
3. Bind legacy AAD and rewrap in bounded batches:

   ```bash
   pnpm credentials:rewrap bind-aad --batch 100
   pnpm credentials:rewrap --from v1 --to v2 --batch 100
   ```

4. Run the read-only retirement gate:

   ```bash
   pnpm credentials:rewrap verify --version v1
   ```

5. Retire v1 only after the gate exits `0` with zero v1/AAD-v0 rows and every
   current wrapped key verifies. Exit `2` means resumable work remains; exit
   `1` means configuration or corruption failure.
6. If the KEK was disclosed, notify tenants and have them revoke their GitHub
   credentials even after rewrap.

See [Credential key rotation](key-rotation.md) for the full staged procedure.

### `AUTH_SECRET`

```bash
npx vercel env rm AUTH_SECRET production --yes
openssl rand -base64 32 | tr -d '\n' | \
  npx vercel env add AUTH_SECRET production --sensitive
```

Redeploy. Every existing session should fail and require sign-in.

### `DAYTONA_API_KEY`

Create a replacement in Daytona, update the Vercel secret, redeploy, then
revoke the old key. Verify a bounded diagnostic and one non-production
lifecycle only after the new deployment is serving. Do not infer live
production certification from repository tests.

### `OPERATOR_DIAGNOSTIC_TOKEN`

Replace the Vercel secret with a new random value, redeploy, and verify the old
bearer receives `401` while the new bearer reaches only the bounded diagnostic.
Keep it distinct from both reconciliation credentials.

### `CRON_SECRET`

Replace the Vercel cron credential and redeploy. Verify the old bearer is
rejected and a scheduled `GET /api/internal/runner-reconcile` produces only
validated aggregate counts. Cron authority must not work on the manual `POST`.

### `RUNNER_MANUAL_RECONCILE_SECRET`

Replace the operator and Vercel copies together, redeploy, and verify the old
bearer is rejected on `POST /api/internal/runner-reconcile`. Manual authority
must not work on the cron `GET`.

### `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET`

Create the new GitHub OAuth client secret, update Vercel, redeploy, verify
sign-in, then revoke the old value.

### `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`

Use Stripe's overlap window: create the replacement, deploy it, verify a test
event returns `{"received":true}`, then revoke the old value.

### `POSTGRES_URL` and Neon variables

Rotate the database role in Neon and let the Vercel integration resynchronize
the complete variable family. Redeploy, then verify `/ping`, account reads,
and a non-production runner store operation.

### Tenant harness credential

1. Delete the stored row from the tenant account.
2. Tell the tenant to revoke the OAuth token or PAT in GitHub.
3. Explain the credential's granted scope and affected time window.
4. Never substitute an operator or another tenant credential.

## Scenario: a secret reached git

1. Rotate it before touching history.
2. Scan every reachable blob:

   ```bash
   pnpm secret:scan:history
   ```

3. Decide whether history rewriting is worth its coordination cost. Rotation,
   not rewriting, revokes authority.
4. Add a scanner regression for the missed shape before restoring access.

Expected scanner findings may include reviewed synthetic fixtures. Triage the
actual location and category without copying the matched value.

## Scenario: a credential appeared in run evidence

Treat it as disclosed. Revoke it, remove affected stored evidence, add the shape
to both shared evidence redaction and the repository secret scanner, and add a
regression using a synthetic marker-approved fixture.

## Scenario: the runner API is being hammered

The same-origin runner routes are not secrets. Confirm refusals, inspect abuse
budget health, and lower deployment limits or disable the affected route if
cost or availability is threatened. Rotating operator credentials does not
reduce unauthenticated volume.

## Scenario: the operator's machine is compromised

Assume every locally accessible credential, authenticated CLI session, and
commit-signing key leaked. Rotate from a different trusted machine. Revoke
`gh`, Vercel, Daytona, Stripe, database, and signing authorities in severity
order.

## What we deliberately do not do

- We do not rely on `.gitignore` as a secret control.
- We do not print secret values in scanner, migration, or recovery output.
- We do not treat a passing pattern scan as proof of safety.
- We do not claim an external legacy deployment is gone merely because its
  source was removed from this repository.

## Keeping this document true

Run `pnpm secret:scan:all` and the full repository gates before merging a
security-boundary change. Periodically rehearse non-destructive rotations in a
non-production environment and verify both old-value rejection and new-value
success.
