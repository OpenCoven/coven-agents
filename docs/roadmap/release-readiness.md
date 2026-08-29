# Release Readiness

This runbook is a production approval gate. Repository tests do not prove a
deployment, migration, provider action, or resource deletion occurred.

## Current release disposition

**No production approval is recorded in this document.** Promotion remains
pending until every required item has a dated sanitized artifact and named
operator.

## Automatic no-go rules

Do not promote when:

- any repository gate fails;
- a worktree is `AT RISK`;
- release audience configuration is ambiguous;
- database migration compatibility is unproved;
- subscriber or tenant authority can be supplied by request input;
- Daytona credentials, snapshot, target, or domain policy are missing;
- an active run lacks durable PostgreSQL ownership;
- lifecycle, SSE, rollback, or reconciliation evidence is absent;
- a high-severity security finding remains unresolved.

## Environment prerequisites

- Auth.js and GitHub OAuth configuration
- PostgreSQL and applied migrations
- Redis admission state
- Daytona API key, snapshot, target, lifecycle settings, and domain allowlist
- credential KEK ring and AAD write policy
- Stripe configuration when billing is enabled
- distinct cron, manual reconciliation, and diagnostic credentials
- explicit `RELEASE_AUDIENCE` and matching beta configuration

Validate without printing secrets:

```bash
pnpm validate:release
```

## Database migration

1. Review generated SQL and forward/backward application compatibility.
2. Back up according to the database provider's approved procedure.
3. Apply migrations once.
4. Confirm schema checks and a read-only runner-store query.
5. Record migration ID, timestamp, operator, and sanitized result.
6. Prefer forward fixes after irreversible writes.

## Planning and delivery reconciliation

Only an authorized maintainer may update private planning data. Run the
repository's documented preview/apply sequence and retain only sanitized
aggregate results. A delivery artifact never overrides the private authority.

## Required local gates

```bash
pnpm hygiene
pnpm check
pnpm typecheck
pnpm test:unit
pnpm build
```

Record the candidate SHA and exact exit status for every command.

## Required smoke paths

- health and authenticated account access;
- guest refusal for protected resources;
- subscriber agent create, read, update, and delete;
- Daytona sandbox create and reuse;
- idempotent run start;
- SSE reconnect from `Last-Event-ID`;
- stop and terminal convergence;
- credential acquisition compensation on injected launch failure;
- scheduled and manual reconciliation;
- diagnostics with its distinct operator credential.

## Same-origin runner session boundary

- Browser requests use relative `/api` paths.
- The Auth.js session is the only browser execution credential.
- Subscriber state and tenant identity are derived and revalidated server-side.
- Browser code receives no provider credential or tenant harness plaintext.
- Mutation origin and media type checks run before body work.

## Stripe webhook delivery

When billing is enabled:

- verify signature validation;
- prove event deduplication and ordering;
- prove subscription activation and expiry update server-owned authority;
- confirm retry behavior after a transient database failure;
- retain a sanitized event ID and status only.

## Credential and identity isolation

- Cross-tenant reads return nondisclosing refusals.
- Credential rows remain tenant-and-harness scoped.
- Run acquisition binds the credential to one durable attempt.
- Failed launches compensate the exact usage reservation and lease.
- Evidence, logs, and errors contain no credential value.

## Observability and diagnostics

Retain sanitized request IDs, operation IDs, run IDs, status transitions,
aggregate reconciliation counts, provider resource IDs, and timestamps. Never
retain cookies, authorization headers, credentials, task content, or private
repository output.

## Rollback

1. Pause new starts.
2. Preserve PostgreSQL execution ownership.
3. Reconcile in-flight attempts.
4. Redeploy the previously verified schema-compatible release.
5. Verify same-origin authorization and Daytona ownership remain intact.
6. Resume traffic only after lifecycle and security smoke paths pass.

Do not assign another provider to an existing agent or attempt during rollback.

## Data recovery

Recovery must be idempotent, lease-bounded, cursor-bounded, and exact-attempt
fenced. If provider state is ambiguous, retain cleanup ownership and report an
explicit recovery state instead of success.

## Go/no-go record

| Role | Operator | Date/time | Candidate | Decision | Evidence |
| --- | --- | --- | --- | --- | --- |
| Release operator |  |  |  | Pending |  |
| Security reviewer |  |  |  | Pending |  |
| Product owner |  |  |  | Pending |  |
