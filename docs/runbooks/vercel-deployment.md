# Vercel deployment

- Status: enforced
- Recorded: 2026-09-04
- Owner: OpenCoven maintainers

This runbook exists because `vercel.json` now carries scheduled jobs. The
deny-only `git.deploymentEnabled: false` control is retained unchanged;
`docs/operations/vercel-git-deployment-disablement.md` still records why
Git-triggered deployments stay off, and this document is the pairing that
record's reintroduction gate requires. `scripts/deployment-documentation-policy.ts`
fails the unit gate if the two ever separate.

## Ownership

The Vercel project is `coven-agents` under the `0xbuns` team. Deployments are
produced only by a maintainer running the CLI from a clean checkout of `main`:

```bash
pnpm hygiene && pnpm check && pnpm typecheck && pnpm test:unit && pnpm build
vercel deploy --prod --yes --scope 0xbuns
```

Git pushes never deploy. A configuration change that needs no new build is
applied with `vercel redeploy <deployment-id> --scope 0xbuns`, which rebuilds
the same source against the current environment.

## External side effects

A production deployment does all of the following, so it is never a read-only
action:

- runs `tsx lib/db/migrate.ts` against the production database during build,
  applying any migration that has not yet been applied;
- replaces the `agents.opencoven.ai` alias on success;
- registers the scheduled jobs below, which begin firing against production
  data as soon as the deployment becomes current;
- causes the runner to reconcile live sandboxes, which can stop, adopt, or
  terminalize in-flight work belonging to real tenants.

Migrations are the irreversible part. Rehearse every migration on a Neon
branch of `main` before deploying, and never deploy a migration whose rollback
is untested. Only production deployments run crons; preview deployments do
not, so a preview never touches tenant work on a schedule.

## Environment and secrets

Production values live in Vercel and are the source of truth; `.env.example`
lists every key with its meaning. Operator secrets are stored `--sensitive`
and cannot be read back, only replaced:

```bash
printf '%s' "$value" | vercel env add NAME production --sensitive --scope 0xbuns
```

The scheduled jobs below depend on `CRON_SECRET`. Vercel attaches it as an
`Authorization: Bearer` header on every cron invocation, and both endpoints
compare it in constant time before doing any work. Rotating `CRON_SECRET`
therefore requires a redeploy, because the running deployment holds the old
value until it is rebuilt. `RUNNER_MANUAL_RECONCILE_SECRET` and
`OPERATOR_DIAGNOSTIC_TOKEN` must remain distinct from it; the runtime refuses
to start when they are aliased.

## Scheduled jobs

| Path | Schedule | What it does |
| --- | --- | --- |
| `GET /api/internal/runner-reconcile` | every minute | Recovers expired runner dispatches, projects terminal attempts, and advances coordinated team runs to their next member. |
| `GET /api/internal/stripe-reconcile` | hourly at :17 | Bounded positive-repair sweep over local rows that already hold a Stripe reference. Never lists Customers globally and never invents a mapping. |

Both are idempotent, hold a database lease so overlapping invocations cannot
double-apply, accept an empty body only, and return aggregate counts with no
tenant identifiers. Vercel does not retry a failed cron and may skip or
overlap invocations; correctness comes from the lease and from the next run,
not from delivery guarantees.

The runner job is the reason a team run advances when nobody is watching.
Without it, a run whose member has finished waits for a person to open the
console. The off-hour minute on the Stripe sweep avoids stacking both jobs on
the same tick.

## Verification

After every production deployment:

1. `vercel inspect <url> --scope 0xbuns` reports `status ● Ready` and
   `target production`.
2. The build log contains `Migrations completed`.
3. `GET https://agents.opencoven.ai/api/health` returns 200.
4. Both cron paths return 401 to an unauthenticated request, confirming the
   bearer check is live rather than open.
5. In the Vercel dashboard, the Cron Jobs tab lists both entries against the
   current production deployment and shows a recent successful invocation.
6. Start a coordinated team run, close the console, and confirm from the run
   history that it advanced without the page open.

## Rollback

Deployments are immutable, so rollback is promotion of a known-good build:

```bash
vercel ls coven-agents --scope 0xbuns
vercel promote <previous-deployment-url> --scope 0xbuns
```

Promotion moves the alias and the crons back to that build within a minute.
It does **not** revert a migration: a deployment whose migration is not
backward compatible cannot be rolled back this way, which is why migrations
must be additive and rehearsed first. To stop the scheduled jobs without
rolling anything back, promote a deployment built from a `vercel.json` with no
`crons` array, or disable them in the project's Cron Jobs settings.
