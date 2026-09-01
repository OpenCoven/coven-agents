# Security Incident Response

- Status: living document
- Scope: application, Daytona, PostgreSQL, billing, authentication, evidence,
  and operator credentials

Rotate first, investigate second. Deleting a value or rewriting Git history
does not revoke it.

## Severity

| Level | Meaning | First action |
| --- | --- | --- |
| S1 | Cross-tenant data or credential exposure may exist | Revoke or rotate immediately; notify affected tenants |
| S2 | Product, provider, session, or operational authority is controllable | Rotate immediately |
| S3 | Cost or availability is threatened without known data access | Contain, rate-limit, and measure |

## Credential inventory

| Secret | Grants |
| --- | --- |
| `CREDENTIAL_KEK_CURRENT_VERSION`, `CREDENTIAL_KEK_V1`, `CREDENTIAL_KEK_V2`, `CREDENTIAL_KEK` | Tenant credential data-key decryption |
| `POSTGRES_URL` | Durable product and execution state |
| `AUTH_SECRET` | Application session signing |
| `DAYTONA_API_KEY` | Daytona resource lifecycle |
| `OPERATOR_DIAGNOSTIC_TOKEN` | Bounded diagnostic route |
| `CRON_SECRET` | Scheduled reconciliation |
| `RUNNER_MANUAL_RECONCILE_SECRET` | Manual reconciliation |
| `AUTH_GITHUB_SECRET` | GitHub OAuth application |
| `GITHUB_APP_PRIVATE_KEY` | Installation-scoped GitHub App authority |
| `GITHUB_STATE_SIGNING_SECRET` | GitHub installation callback state |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Billing operations and event authentication |
| Tenant harness credential | Tenant coding-provider authority |

Platform facts:

- **Sensitive variables are write-only.** Stored values cannot be compared
  after upload.
- **`vercel redeploy` reuses the existing build.**
- **`NEXT_PUBLIC_*` must never be Sensitive.** Add public values with
  `--no-sensitive`.
- Server secrets require `--sensitive`; **`--sensitive` is required, not decorative**.
- **A redeploy is what makes the new value live.**
- A copied network trace is a credential disclosure because it includes
  headers and cookies.

## First fifteen minutes

1. Identify the credential, environment, and conservative blast radius.
2. Disable the affected capability when that reduces harm.
3. Rotate or revoke the credential.
4. Redeploy or rebuild as required.
5. Prove the old value is rejected without printing either value.
6. Preserve sanitized timestamps, request IDs, run IDs, and provider IDs.
7. Investigate the escape path after authority is contained.

## Runbooks

### Credential KEK ring

Removing the only configured KEK **destroys access to every stored credential**.
Keep every key named by a credential or unexpired encrypted idempotency row.

```bash
pnpm credentials:rewrap bind-aad --batch 100
pnpm credentials:rewrap --from v1 --to v2 --batch 100
pnpm credentials:rewrap verify --version v1
```

Retire v1 only after the verification command exits `0` with zero v1 and
AAD-v0 rows.

### `AUTH_SECRET`

Replace the deployment secret and redeploy. Every existing session should fail
and require sign-in.

### `DAYTONA_API_KEY`

Create a replacement, update the deployment secret, redeploy, verify a bounded
non-production diagnostic and lifecycle, then revoke the old key.

### `OPERATOR_DIAGNOSTIC_TOKEN`

Replace and redeploy. Prove the old bearer receives `401` and the new bearer
reaches only the bounded diagnostic.

### `CRON_SECRET`

Replace and redeploy. Prove it authorizes only scheduled reconciliation.

### `RUNNER_MANUAL_RECONCILE_SECRET`

Replace operator and deployment copies together. Prove it authorizes only
manual reconciliation.

### `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET`

Create the replacement OAuth secret, update the deployment, verify sign-in,
then revoke the old value.

### `GITHUB_APP_PRIVATE_KEY`

Set `GITHUB_TEAMS_ENABLED=off`, generate a new private key in the dedicated
GitHub App, update the deployment secret, rebuild and redeploy, verify a
bounded installation read, then delete the old key in GitHub before re-enabling
the feature. Never substitute the OAuth or Copilot runtime credential.

### `GITHUB_STATE_SIGNING_SECRET`

Set `GITHUB_TEAMS_ENABLED=off`, replace the secret with a newly generated
independent value, rebuild and redeploy, then re-enable the feature. Rotation
intentionally invalidates every installation flow that has not completed;
users must start those flows again.

### `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`

Use provider overlap: add the replacement, deploy, verify a sanitized test
event, then revoke the old value.

### `POSTGRES_URL` and Neon variables

Rotate the database role, synchronize the complete variable family, redeploy,
then verify health, account reads, and a bounded store operation.

### Tenant harness credential

Delete the stored row, instruct the tenant to revoke the credential at its
issuer, explain the affected scope and window, and never substitute another
tenant or operator credential.

## Scenario: a secret reached git

1. Rotate before changing history.
2. Run `pnpm secret:scan:history`.
3. Decide whether history rewriting is worth the coordination cost.
4. Add a regression for the missed credential shape.

## Scenario: a credential appeared in run evidence

Revoke it, remove affected stored evidence, extend shared redaction and
repository scanning, and add a synthetic reviewed regression.

## Scenario: execution traffic is being hammered

Confirm refusal behavior, inspect admission and abuse budgets, and lower
deployment limits or disable the affected route if cost or availability is at
risk. Rotating operator credentials does not reduce anonymous traffic.

## Scenario: the operator's machine is compromised

Rotate every locally accessible CLI session, deployment credential, provider
credential, database credential, and signing key from another trusted machine.

## What we deliberately do not do

- rely on `.gitignore` as a secret control;
- print credential values in scan, migration, or recovery output;
- treat a passing pattern scan as proof of safety;
- claim provider or production actions from repository evidence.

## Keeping this document true

Run `pnpm secret:scan:all` and the repository gates before merging a
security-boundary change. Rehearse nondestructive rotations in a non-production
environment and verify both old-value rejection and new-value success.
