# Daytona Cutover Attestation and Runbook

- Status: repository verification complete; production approval-gated evidence
  pending
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
| [PR #134](https://github.com/OpenCoven/coven-agents/pull/134) | `1bec409b399651d8a115e4518a0f444e9753a728` | 2026-08-29 |

The fully gated PR #134 head and its squash-merge commit both have tree
`a8bb0a82efb6ffb7f754d03519f0d381e72fb88e`. These artifacts and results prove
repository delivery only.

## Pending taxonomy follow-up

The repository keeps the runner, workstream, and seed identifiers already used
by the authoritative private planning source and its generated Project view.
Taxonomy modernization requires a private-source-first, coordinated migration
across Beads, Project #10, and repository validation. That work is outside this
repository-only cleanup and remains pending; this record neither accesses nor
reproduces private records.

## Verified repository evidence

The final PR head `67f7f8ce6fca0799a6c8688eb85103c6e92ca647`
was verified locally on 2026-08-29. Its tree is identical to merge commit
`1bec409b399651d8a115e4518a0f444e9753a728`.

```bash
pnpm hygiene
pnpm validate:platform-residue
pnpm validate:platform-residue:index
pnpm check
pnpm typecheck
pnpm test:unit
pnpm build
```

Results:

- hygiene passed with no `AT RISK` worktree;
- worktree and index residue validation passed with only the documented
  generated lockfile metadata exception;
- formatting and static analysis checked 458 files with no fixes;
- application and workspace typechecks passed;
- unit suites passed 404 + 903 + 37 + 33 = 1,377 tests with zero failures;
- the production-safe build compiled and generated 35 of 35 pages while
  database variables were intentionally absent;
- the authenticated browser contracts passed 28 of 28 cases on the same
  application and end-to-end test trees before the evidence correction;
- `pnpm db:check` passed after migration 0019 was generated.

Repository evidence checklist:

- [x] Browser execution uses only relative same-origin `/api` routes.
- [x] Auth.js session revalidation and server-derived tenant scope are covered.
- [x] Credential acquisition and Daytona dispatch remain server-only.
- [x] PostgreSQL owns durable run, event, attempt, and recovery records.
- [x] Start idempotency, SSE cursor replay, cancellation, and reconciliation
      tests pass.
- [x] Documentation and tracked-filename residue scan is clean under the
      documented exceptions.
- [x] Exact local gate results are recorded above.

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
