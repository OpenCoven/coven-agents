# Beads and Project Board Design

## Goal

Create a durable, private planning system for the full `coven-agents`
repository. A private Beads database is the execution authority, while the
existing private OpenCoven Project **Coven Agents** (#10) provides a readable
organization-wide view.

The initial inventory will contain 10 epics and 50 actionable child beads. It
will cover the full repository rather than only the current security gaps.

## Constraints

- The repository is public, so Beads data must never be committed here.
- Project #10 is private and currently empty. It should be reused rather than
  replaced.
- Synchronization is one-way from Beads to GitHub Project draft items.
- The private Beads graph remains authoritative.
- The sync implementation may be public, but private roadmap content and
  credentials may not be.
- Sync automation must not run on pull requests or arbitrary branches.

## Roadmap Model

Initialize a Beads project with the prefix `coven-agents`, backed by a private
DoltHub database. Seed unfinished and intentionally recurring work only;
completed implementation history remains represented by Git.

The initial roadmap uses these epics:

1. Product and control-plane experience
2. Shared contracts and harness support
3. Cloud runner
4. Local runner
5. Persistence and data lifecycle
6. Security and privacy
7. Observability and operations
8. Testing and reliability
9. Deployment, releases, and documentation
10. Developer experience and repository governance

Each epic contains five independently actionable child beads. Every bead must
have:

- a concise title and objective;
- explicit acceptance criteria;
- type (`epic`, `feature`, `task`, or `bug`);
- priority (`P0`, `P1`, or `P2`);
- size (`XS`, `S`, `M`, `L`, or `XL`);
- runner or surface (`Cloud`, `Local`, `Control plane`, or `Shared`);
- workstream;
- status;
- dependencies expressed as stable Bead IDs.

Dependencies must describe real execution ordering rather than loose thematic
relationships. The seed graph must be acyclic and should leave several
unblocked, high-value beads ready for execution.

## Project Schema

Reuse organization Project #10, **Coven Agents**. Preserve its existing fields:

- Status: `Todo`, `In Progress`, `In review`, `Done`
- Runner: `Cloud`, `Local`, `Control plane`, `Shared`
- Size: `XS`, `S`, `M`, `L`, `XL`
- Priority: `P0`, `P1`, `P2`

Add:

- **Bead ID**: text
- **Bead Type**: single select matching the supported Beads types
- **Workstream**: single select matching the ten roadmap epics
- **Blocked**: single select with `Yes` and `No`

GitHub reserves `Type`, so `Bead Type` is the compatible managed schema name.

Each seeded bead maps to one private Project draft item. Beads closed after
creation remain mapped and move to `Done`. Epic draft items provide the
top-level grouping. Child bodies list their parent and dependency Bead IDs.
Project fields carry the queryable metadata.

The Project is a generated view. Managed titles, bodies, and mapped fields may
be overwritten by synchronization. Unmanaged Project metadata is preserved.

## Synchronization

Add a typed `scripts/beads-project-sync.ts` entry point with two modes:

- `preview`: validate and print an ID/count-only reconciliation plan;
- `apply`: perform the validated upserts.

The script reads the private Dolt-backed Beads graph and converts each item
through an explicit public-safe projection. Despite the Project being private,
the projection provides defense in depth and keeps logs, fixtures, and future
visibility changes safe.

The projection permits:

- Bead ID;
- title;
- sanitized objective and acceptance criteria;
- type, status, priority, size, runner, and workstream;
- parent and dependency IDs.

It rejects:

- recognized secrets or credential-like values;
- environment-variable assignments containing values;
- private keys and authentication headers;
- local absolute paths;
- raw command output or logs;
- text beyond configured size limits;
- unknown enum values or malformed IDs.

Every managed draft body contains an invisible versioned marker:

```html
<!-- coven-agents-bead-sync:v1 id=coven-agents-... -->
```

The marker is the reconciliation key. Duplicate markers are fatal. Missing
managed items are created; changed managed fields are updated; unchanged items
are skipped. Closed beads move to `Done`. Items are never deleted or archived
unless a separate explicit destructive flag is supplied.

## Automation and Credentials

Add a scheduled and manually dispatchable GitHub Actions workflow that runs
only from protected `main`. It must not use `pull_request`,
`pull_request_target`, or arbitrary ref input.

The workflow:

1. checks out the pinned `main` revision;
2. installs pinned Node and pnpm versions;
3. installs dependencies with the frozen lockfile;
4. authenticates to the private DoltHub database;
5. runs sync validation and preview;
6. applies the reconciliation to Project #10.

Actions must be pinned to immutable commits. Credentials must be stored as
repository or organization secrets and scoped to the minimum required access:

- read access to the private DoltHub database;
- write access to OpenCoven Project #10.

The workflow must mask sensitive values and log only aggregate counts, Bead IDs,
and failure categories. A local preview/apply path remains available for
recovery and maintenance.

## Failure Behavior

Beads is authoritative, but synchronization is fail-closed:

- unsafe projected content aborts the run;
- duplicate or malformed markers abort the run;
- missing dependencies abort the run;
- cycles in the dependency graph abort the run;
- unknown Project fields or option values abort the run;
- authentication, rate-limit, and API failures return non-zero;
- unmatched Project items are never modified;
- partial failures never trigger deletion, archival, or success-shaped output.

The apply phase should validate the complete desired state before its first
write. API writes must be idempotent and safe to retry.

## Verification

Unit tests cover:

- projection and sanitization;
- enum and field mapping;
- dependency validation and cycle detection;
- marker parsing and duplicate detection;
- reconciliation planning;
- idempotent updates;
- closed-to-Done behavior;
- refusal of destructive operations by default.

Fixture-based tests use representative Beads exports and mocked GitHub GraphQL
responses. No private roadmap content or live credentials may enter fixtures.

Live verification consists of:

1. a successful local preview;
2. an initial apply to Project #10;
3. a second apply reporting zero changes;
4. an inventory check matching managed Project items to the selected Beads
   population;
5. confirmation that no private Beads files are tracked by Git.

## Rollout

1. Create the private DoltHub database and configure authenticated access.
2. Initialize Beads locally with prefix `coven-agents` and connect the remote.
3. Add the ten epics and 50 child beads with dependencies.
4. Add the four Project fields.
5. Implement and test the sync tool.
6. Run preview and review the complete reconciliation plan.
7. Apply the initial import to Project #10.
8. Enable the scheduled/manual workflow.
9. Document setup, credentials, recovery, and privacy rules.

No destructive Project operation is part of the initial rollout.

## Success Criteria

- The private DoltHub database contains a balanced, dependency-aware roadmap
  for all major repository surfaces.
- Project #10 contains exactly one managed private draft item per selected
  bead.
- A second sync is a no-op.
- Unsafe content is rejected before any Project write.
- Neither Beads content nor credentials are committed to the public repository
  or exposed in workflow logs.
