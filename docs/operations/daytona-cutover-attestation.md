# Daytona Cutover Attestation and Runbook

- Status: repository verification pending until the final branch gates;
  production approval-gated evidence pending
- Prepared: 2026-08-29
- Scope: same-origin browser access, Daytona lifecycle, durable recovery, and
  provider-resource disposition

This record separates facts proved by tracked source and local commands from
actions that require an authorized production operator. It contains no
credentials, private planning content, or provider output.

## Public delivery artifacts

| Artifact | Merge commit | Merged |
| --- | --- | --- |
| [PR #128](https://github.com/OpenCoven/coven-agents/pull/128) | `bd46bece9ea9b33700f3316919c6f035aad7d7d1` | 2026-08-29 |
| [PR #133](https://github.com/OpenCoven/coven-agents/pull/133) | `acc7ca3fa2dd51f496e1900573f239eb8a158ce6` | 2026-08-29 |

The current documentation branch is based at the PR #133 merge commit. These
artifacts prove repository delivery only.

## Pending taxonomy follow-up

The repository keeps the runner, workstream, and seed identifiers already used
by the authoritative private planning source and its generated Project view.
Taxonomy modernization requires a private-source-first, coordinated migration
across Beads, Project #10, and repository validation. That work is outside this
repository-only cleanup and remains pending; this record neither accesses nor
reproduces private records.

## Pending repository verification

Record each command, commit, timestamp, and exit status without pasting secret
values or private output.

```bash
pnpm hygiene
pnpm check
pnpm typecheck
pnpm test:unit
pnpm build
```

Targeted documentation and boundary checks:

```bash
pnpm exec tsx --test scripts/product-boundary.test.ts \
  scripts/security-docs.test.ts scripts/guest-access-docs.test.ts \
  scripts/wave-one-report.test.ts
```

Repository evidence checklist:

- [ ] Browser execution uses only relative same-origin `/api` routes.
- [ ] Auth.js session revalidation and server-derived tenant scope are covered.
- [ ] Credential acquisition and Daytona dispatch remain server-only.
- [ ] PostgreSQL owns durable run, event, attempt, and recovery records.
- [ ] Start idempotency, SSE cursor replay, cancellation, and reconciliation
      tests pass.
- [ ] Documentation and tracked-filename residue scan is clean.
- [ ] Exact local gate results are attached to the change record.

## Zero-residue scan method

Use worktree mode while editing. It reads filesystem content for every tracked
file plus every non-ignored untracked file, so newly created docs and scripts
are checked before staging:

```bash
pnpm validate:platform-residue
# equivalent explicit form
pnpm validate:platform-residue --worktree
```

Use index mode for precommit and commit verification. It reads blob content
from exactly the would-be committed index, so later working-tree edits cannot
hide staged residue:

```bash
pnpm validate:platform-residue:index
# equivalent explicit form
pnpm validate:platform-residue --index
```

Both modes use Git's NUL-delimited inventory, scan filenames and text
case-insensitively, skip binary content without skipping filename checks, and
handle deletions, renames, unusual paths, symlinks, and directory segments
according to the selected snapshot.

There are exactly two narrow exceptions. The scanner source self-excludes
because its rule inventory intentionally contains every enforced marker. The
generated optional-peer metadata in the lockfile may contain only the upstream
drizzle keys accepted by the validator; a resolved package, snapshot, importer
dependency, or any other marker still fails. Do not weaken the inventory merely
to obtain zero results.

## Production approval-gated evidence

All items in this section are **pending** until an authorized operator records
the date, environment, artifact location, and approval.

### Daytona lifecycle

- [ ] Create an agent through the production same-origin API.
- [ ] Confirm one tenant-scoped persistent sandbox is assigned.
- [ ] Start the same operation twice and prove one durable run.
- [ ] Resume SSE from a retained event cursor without gaps or duplicates.
- [ ] Stop a running attempt and confirm bounded terminal convergence.
- [ ] Delete the agent and confirm provider cleanup plus database finalization.
- [ ] Capture only sanitized IDs, timestamps, status transitions, and aggregate
      counts.

### Same-origin and security boundary

- [ ] A signed-out request is refused.
- [ ] A signed-in non-subscriber request is refused before provider work.
- [ ] A subscriber request derives tenant ownership from the server session.
- [ ] Cross-tenant agent, run, event, and credential reads are nondisclosing.
- [ ] Browser inspection shows no provider or tenant credential material.
- [ ] Operator diagnostic and reconciliation credentials authorize only their
      intended bounded routes.

### Recovery

- [ ] Interrupt an in-flight attempt in a production-like environment.
- [ ] Run scheduled or manual reconciliation once.
- [ ] Prove lease ownership, exact attempt fencing, bounded event ingestion, and
      terminal convergence.
- [ ] Rerun reconciliation and prove idempotent aggregate results.

## Resource inventory and revocation

- [ ] Inventory active Daytona API keys, snapshots, sandboxes, sessions, domain
      allowlists, targets, and account roles.
- [ ] Map every retained provider resource to an active tenant-scoped record or
      approved diagnostic purpose.
- [ ] Inventory resources from the superseded execution arrangement without
      copying names, credentials, or private output into this document.
- [ ] Confirm application traffic no longer depends on superseded resources.
- [ ] Revoke superseded credentials.
- [ ] Remove superseded compute, routes, schedules, and storage only after the
      Daytona observation window passes.
- [ ] Retain sanitized deletion receipts or provider audit references.

Production deployment, credential revocation, and resource deletion are
**pending**. Repository changes do not prove these actions occurred.

## Rollback

1. Stop promotion and preserve current PostgreSQL ownership records.
2. Disable new run starts if provider or reconciliation state is ambiguous.
3. Redeploy a previously verified application release only when retained
   evidence shows it remains schema-compatible and preserves Daytona ownership.
4. Reconcile in-flight attempts to terminal or cleanup-required states.
5. Do not assign a second provider to an existing agent or attempt.
6. Record the trigger, affected window, sanitized counts, and forward-fix owner.

## Observation window

Recommended minimum: 24 hours after production promotion and the last lifecycle
or recovery exercise. Extend the window for provider instability, unexplained
cleanup retries, event gaps, cross-tenant anomalies, or admission saturation.

Observe:

- start deduplication and conflict counts;
- SSE reconnects, idle closes, and cursor continuity;
- dispatch and reconciliation lease expiry;
- cancellation and cleanup-required outcomes;
- sandbox create, reuse, archive, stop, and delete behavior;
- credential acquisition compensation;
- tenant-scoped authorization failures;
- admission latency and provider capacity.

## Approval record

| Role | Operator | Date/time | Environment | Decision | Evidence reference |
| --- | --- | --- | --- | --- | --- |
| Release operator |  |  |  | Pending |  |
| Security reviewer |  |  |  | Pending |  |
| Product owner |  |  |  | Pending |  |

Approval is valid only when every required production item has a retained,
sanitized evidence reference and no unresolved high-severity anomaly remains.
