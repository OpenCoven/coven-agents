# Daytona Cutover Attestation and Runbook

- Status: Daytona production control plane verified and superseded execution
  resources retired; full subscriber lifecycle exercise remains approval-gated
- Prepared: 2026-08-29
- Updated: 2026-08-30
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
| [PR #135](https://github.com/OpenCoven/coven-agents/pull/135) | `3345b9d1590764dc3d52082293b8ca2a3f406267` | 2026-08-29 |
| [PR #136](https://github.com/OpenCoven/coven-agents/pull/136) | `eebf732b6b5ea9f4e16aa963c497c214dcc47717` | 2026-08-29 |
| [PR #137](https://github.com/OpenCoven/coven-agents/pull/137) | `3279410505e03bfeabfc2a19de0c20e5403d8510` | 2026-08-30 |
| [PR #138](https://github.com/OpenCoven/coven-agents/pull/138) | `74b70190ecb506308c4f43825ba45dae5d692371` | 2026-08-30 |
| [PR #139](https://github.com/OpenCoven/coven-agents/pull/139) | `b86b2610c62f3e19ba5388d18d05660a7b9cce28` | 2026-08-30 |
| [PR #140](https://github.com/OpenCoven/coven-agents/pull/140) | `b3eaba2e7c9043283c217d426c636721e7765fef` | 2026-08-30 |
| [PR #141](https://github.com/OpenCoven/coven-agents/pull/141) | `0d02097b05ced26642169d8cf71fda67afb580af` | 2026-08-30 |
| [PR #142](https://github.com/OpenCoven/coven-agents/pull/142) | `c40c717de9a65339fb426e84a48b3e1fed63fb30` | 2026-08-30 |
| [PR #144](https://github.com/OpenCoven/coven-agents/pull/144) | `6b6cc950350aeed526c0affc376e2a187ccbd676` | 2026-08-30 |
| [PR #145](https://github.com/OpenCoven/coven-agents/pull/145) | `e8b9a83d37eb3bb099b0ffac34957b3a460b5c47` | 2026-08-30 |
| [PR #146](https://github.com/OpenCoven/coven-agents/pull/146) | `09fe0702e2403733b560cf14c7110c8392c17982` | 2026-08-30 |

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

## Production cutover and retirement evidence

Read-only inventory was collected on 2026-08-29. Authorized production
validation and retirement were completed on 2026-08-30:

- GitHub recorded a successful production deployment for merge commit
  `09fe070`.
- The deployment provider reported the production deployment Ready on the
  canonical application aliases.
- `GET /api/health` returned HTTP 200 with the expected v1 descriptor.
- The bounded Daytona diagnostic returned HTTP 200, executed the fixed
  no-credential probe, and deleted its ephemeral sandbox.
- Two consecutive manual reconciliation requests and one scheduled
  reconciliation request returned HTTP 200 with `execution: executed`, zero
  failures, and zero retained work.
- Cross-channel operator credentials returned HTTP 401.
- Six obsolete production deployment variables for the retired runner,
  cross-service signing, and legacy credential lending were removed. A rebuild
  from the verified production artifact remained healthy.
- The retired Worker service and all retained versions and bindings were
  deleted.
- Its container application, inactive instances, and two retained image tags
  were deleted.
- Worker deletion removed all four associated durable state namespaces.
- Final provider inventory reported zero Worker services, scripts, durable
  state namespaces, container applications, container images, custom domains,
  and key-value namespaces for the retired execution arrangement.

The Daytona account credential remains encrypted and non-exportable through
the deployment provider. Account-wide key, role, and resource names were
therefore not copied into this record. Application-owned evidence proves the
configured snapshot can create, execute, and delete a bounded sandbox, while
empty idempotent reconciliation proves there is no pending application-owned
recovery work.

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

## Production evidence and remaining release exercises

Provider cutover and retirement are complete. End-user lifecycle and
cross-tenant exercises remain release-readiness work and are not prerequisites
for removal of the superseded provider.

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
- [x] Operator diagnostic and reconciliation credentials authorize only their
      intended bounded routes.

### Recovery

- [ ] Interrupt an in-flight attempt in a production-like environment.
- [x] Run scheduled and manual reconciliation.
- [ ] Prove lease ownership, exact attempt fencing, bounded event ingestion, and
      terminal convergence.
- [x] Rerun reconciliation and prove idempotent aggregate results.

## Resource inventory and revocation

- [ ] Inventory account-wide Daytona API keys, roles, and administrative
      resources through the Daytona control plane; encrypted deployment
      credentials cannot be exported for local inspection.
- [x] Verify application-owned Daytona lifecycle and recovery through the
      bounded diagnostic and empty idempotent reconciliation.
- [x] Inventory resources from the superseded execution arrangement without
      copying names, credentials, or private output into this document.
- [x] Confirm application traffic no longer depends on superseded resources.
- [x] Revoke superseded deployment variables and Worker secret bindings.
- [x] Remove superseded compute, routes, schedules, and storage after healthy
      Daytona diagnostics and reconciliation.
- [x] Retain sanitized aggregate deletion receipts in this record.

Production deployment, credential revocation, and superseded resource deletion
are complete.

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
