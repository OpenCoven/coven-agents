# Implementation Sequence

This sequence is dependency- and evidence-driven. It contains no calendar
commitments.

## Authority reminder

- The private Beads workspace is the canonical planning authority for item
  state, dependency order, and promotion.
- Merged `origin/main` is the authority for implemented repository behavior.
- GitHub Project #10 and [`ROADMAP.md`](../../ROADMAP.md) are safe projections.
  They may expose approved IDs and aggregate fields, but they do not override
  Beads.
- The current authenticated planning attempt is blocked because
  **Dolt/DoltHub returned `PermissionDenied`**. Until an authenticated Dolt pull
  succeeds, repository evidence may be marked implemented or verified, but no
  lane may claim authoritative Beads completion or a reconciled, idempotent
  sync.
- The merged product path is cloud-only. The last verified public Wave 1
  delivery evidence nevertheless stages `coven-agents-local.1` as a Wave 2
  foundation and names `coven-agents-local.2` as a follow-up. Assigning those
  IDs below records provisional program ownership only; it does not authorize
  local-runner implementation while Beads is unavailable.
- The parent ID `coven-agents-local` and the IDs
  `coven-agents-local.3`, `coven-agents-local.4`, and
  `coven-agents-local.5` remain unallocated. Public evidence does not establish
  their item-level order, so this sequence does not infer one.

## Promotion model

1. **Observed:** a safe projection or repository signal identifies candidate
   work.
2. **Admitted:** Beads is readable, the ID is on the lane allowlist, predecessor
   lanes have exited, and the owner accepts the lane.
3. **Implemented:** the public outcome is present on merged main with scoped
   evidence.
4. **Verified:** the lane review checkpoint and required local gates pass with
   sanitized output.
5. **Reconciled:** Beads is updated through an authorized path, Project and
   `ROADMAP.md` are refreshed, and a second preview reports no change.
6. **Promoted:** the next lane may admit work only after the predecessor exit
   evidence is retained.

If reconciliation is unavailable, stop at **Verified**. Projection status alone
must not advance a lane.

## Phase 0

Phase 0 protects planning authority, repository integrity, and the evidence
used to make every later promotion decision.

### Planning authority

- **Entry conditions:** Current main and roadmap branch SHAs are known; only
  approved aggregate fields are queried; an authenticated Dolt pull from
  DoltHub succeeds without printing private records. The current entry blocker
  is explicit: **Dolt/DoltHub returned `PermissionDenied`**.
- **Public outcome:** One canonical planning source governs item state and
  dependencies, while Project and `ROADMAP.md` remain privacy-safe projections.
- **Allowed Bead IDs:** `coven-agents-dx.5`
- **Owner role:** BunsDev
- **Predecessor lanes:** None.
- **Review checkpoint:** BunsDev confirms the intended workspace and access;
  the authenticated Dolt workspace is pulled, reviewed, updated, committed,
  and pushed; Copilot runs `pnpm beads:sync preview`, verifies that no private
  record text enters output or Git, and reviews the shipped GitHub issues
  against merged outcomes.
- **Exit evidence:** The authenticated Dolt pull, private review, update,
  commit, and push succeed; shipped GitHub issues are reconciled; then
  `pnpm beads:sync preview`, `pnpm beads:sync apply`, and a second
  `pnpm beads:sync apply` succeed. A final `pnpm beads:sync preview` reports
  exactly 60 unchanged, 0 create, 0 update, and 0 orphan; refreshed
  `ROADMAP.md` passes `pnpm roadmap:status check`.
- **Rollback/recovery expectation:** Stop all projection writes, revoke or
  repair the failing credential path, and retain the last committed aggregate.
  Never manufacture canonical state from Project fields.

**Current state:** blocked because **Dolt/DoltHub returned
`PermissionDenied`**, so the authenticated pull and every dependent
reconciliation step above remain entry-blocked.

### Repository integrity

- **Entry conditions:** Work is in the dedicated roadmap worktree; the branch
  contains current `origin/main`; signing configuration passes; the branch has
  a remote tracking ref.
- **Public outcome:** No task work exists only on one machine, every authored
  commit is signed, and the change set remains limited to its declared files.
- **Allowed Bead IDs:** `coven-agents-dx.2`
- **Owner role:** Joint
- **Predecessor lanes:** Planning authority before promotion; immediate
  containment does not wait for it.
- **Review checkpoint:** Inspect `pnpm hygiene`, commit signature state,
  branch ancestry, remote parity, and the complete changed-file list.
- **Exit evidence:** `pnpm hygiene` exits 0 with no `AT RISK` worktrees; no
  authored commit is unsigned or badly signed; the branch is pushed; only
  approved files differ.
- **Rollback/recovery expectation:** Preserve at-risk work, use a signed revert
  for an incorrect shared change, and never rewrite `main` or delete another
  worktree's uncommitted files.

**Current state:** blocked by an unrelated worktree with two uncommitted files;
the roadmap worktree itself was clean and pushed at the evidence snapshot.

### Evidence baseline

- **Entry conditions:** Repository integrity is green; dependencies are
  present; commands can run without exposing credentials or private planning
  content; the current-state snapshot and verification matrix are populated
  with dated evidence for the exact branch state under review.
- **Public outcome:** Every promotion decision has reproducible local evidence
  for repository hygiene, lint, types, unit behavior, production build, and
  roadmap projection freshness.
- **Allowed Bead IDs:** —
- **Owner role:** Copilot
- **Predecessor lanes:** Repository integrity. Planning authority is also
  required before planning reconciliation.
- **Review checkpoint:** Review the dated current-state snapshot and every
  populated verification-matrix row, read every command's exit status and
  summary, and record warnings and skipped infrastructure instead of
  collapsing them into a pass.
- **Exit evidence:** The dated current-state snapshot and verification matrix
  identify the same branch state and contain the resulting evidence;
  `pnpm hygiene`, `pnpm check`, `pnpm typecheck`, `pnpm test:unit`, the current
  Playwright suite, `pnpm build`, and `pnpm roadmap:status check` all exit 0
  from that state.
- **Rollback/recovery expectation:** Do not promote. Preserve sanitized failure
  evidence, repair the narrow cause, and rerun the complete baseline.

**Current state (2026-08-27 audit candidate):** lint, types, 947 unit tests,
sixteen current browser tests against development and local production servers,
default and demo builds, the local Docker-backed Sandbox diagnostic, and roadmap
status passed; hygiene did not. See the [dated UI/functionality
audit](ui-functionality-audit-2026-08-26.md).

## Wave 1

Wave 1 establishes the public product boundary, the minimum security posture,
and a safe contributor workflow. Merged evidence can be recognized even while
canonical planning reconciliation is blocked.

### Product authority and evaluation

- **Entry conditions:** Phase 0 exits; the product authority boundary is
  accepted; evaluation can occur without granting execution or persistence.
- **Public outcome:** Coven Agents owns product accounts, subscription,
  bounded execution profiles, cloud credential custody, and its run evidence
  without claiming familiar identity, protected memory, or durable
  orchestration authority. Guests can evaluate a sanitized replay without
  consuming resources.
- **Allowed Bead IDs:** `coven-agents-product.1`,
  `coven-agents-product.3`
- **Owner role:** Joint
- **Predecessor lanes:** Planning authority, Repository integrity, Evidence
  baseline.
- **Review checkpoint:** Review the
  [authority ADR](../architecture/adr-001-product-authority-boundary.md), the
  guest request boundary, schema validation, sanitization, and tests that prove
  the replay does not reach runner, database, billing, or Git mutation paths.
- **Exit evidence:** ADR and guest replay are on merged main; boundary and demo
  tests pass; Beads and projections are reconciled through the promotion model.
- **Rollback/recovery expectation:** Disable the affected public surface or
  revert its merge while preserving fail-closed account and runner gates.

**Implemented evidence:** the ADR and guest replay are on merged main.
**Planning status:** not asserted while Beads is inaccessible.

### Security posture

- **Entry conditions:** Product authority is fixed; assets, identities,
  tenancy, credentials, evidence, and recovery boundaries are named.
- **Public outcome:** Commits reject recognized credential shapes, cloud
  identity is tenant-bound, tenant credentials remain encrypted and
  run-scoped, and a living threat model plus incident runbook governs residual
  risk.
- **Allowed Bead IDs:** `coven-agents-cloud.2`,
  `coven-agents-security.1`, `coven-agents-security.5`
- **Owner role:** Joint
- **Predecessor lanes:** Product authority and evaluation, Repository
  integrity, Evidence baseline.
- **Review checkpoint:** Map changes to the
  [threat model](../security/execution-threat-model.md), run focused tenancy,
  credential, secret-scan, and incident-document tests, then run the baseline.
- **Exit evidence:** Secret scanning, tenant isolation, encrypted credential
  custody, threat-model controls, and recovery instructions are on merged main;
  canonical planning is reconciled.
- **Rollback/recovery expectation:** Refuse new work at the affected boundary,
  rotate exposed credentials before investigation, destroy implicated
  sandboxes when needed, and restore only after focused regressions pass.

**Implemented evidence:** the scanner, threat model, incident response, tenant
binding, and encrypted credential path are on merged main.
**Planning status:** not asserted while Beads is inaccessible.

### Operator and contributor workflow

- **Entry conditions:** Repository integrity rules are documented; the branch
  and worktree lifecycle is observable; public roadmap documents contain no
  private planning text; planning sync and the setup, account, and console
  reliability paths are reviewable with privacy-safe evidence.
- **Public outcome:** Contributors use signed commits, dedicated worktrees,
  pushed branches, explicit local gates, safe roadmap projections, and scoped
  recovery commands, while operators have repeatable evidence that setup,
  account, and console workflows remain reliable.
- **Allowed Bead IDs:** — (no additional child allocation).
- **Supporting prerequisite (not owned by this lane):**
  `coven-agents-dx.2` is owned by Repository integrity and
  `coven-agents-dx.5` is owned by Planning authority; this lane consumes their
  Phase 0 exit evidence.
- **Owner role:** Joint
- **Predecessor lanes:** Planning authority, Repository integrity, Evidence
  baseline.
- **Review checkpoint:** Verify `CLAUDE.md`, hygiene output, changed-file scope,
  privacy scans, relative links, commit signature, remote branch parity, the
  idempotent planning-sync evidence, and dated setup, account, and console
  reliability evidence.
- **Exit evidence:** Workflow guidance is on merged main, the full local gate
  set is green, public roadmap documents are nonempty and link-clean, planning
  status is reconciled, and the verification matrix records passing,
  privacy-safe setup, account, and console reliability evidence for the same
  branch state.
- **Rollback/recovery expectation:** Revert incorrect guidance with a signed
  commit, preserve any unmerged worktree, and keep the last known-safe public
  projection.

**Implemented evidence:** signed-commit and worktree hygiene tooling, setup and
account surfaces, and the cloud console are on merged main. The current
snapshot records passing unit and build baselines, but planning sync and
dedicated setup, account, and console reliability evidence remain required
before this lane can exit; the roadmap documentation remains branch evidence
until merged and reconciled.

## Wave 2

Wave 2 may admit work only after Phase 0 and the relevant Wave 1 lanes exit.
Project status such as `In Progress` is not sufficient while Beads is
unavailable.

The order below comes from the last verified public
[`wave-1-delivery.md`](wave-1-delivery.md) evidence. It is provisional until
private Beads access is restored and the canonical graph is reviewed. The
numbered stages and predecessor-lane fields are documentation and program
review gates, not newly asserted Beads dependencies. Item-to-item order is
repeated only where that public report states it; this document does not create
or modify canonical dependencies.

1. **Authorization stage:** `coven-agents-security.2` is the first standalone
   ready P0 gate. It does not depend on contracts, runner lifecycle, or
   structured logging.
2. **Foundation stage:** after the authorization-stage program review, run
   `coven-agents-cloud.1`, `coven-agents-contracts.1`,
   `coven-agents-local.1`, and `coven-agents-observability.1` independently in
   parallel. That stage boundary is delivery sequencing, not a claimed Beads
   dependency from any foundation to `coven-agents-security.2`.
3. **Follow-up stage:** use only the publicly stated foundation order:
   `coven-agents-security.4` after `coven-agents-security.2`,
   `coven-agents-cloud.4` after `coven-agents-cloud.1`,
   `coven-agents-security.3` after `coven-agents-observability.1`, contract
   follow-ups after `coven-agents-contracts.1`, and local follow-ups after
   `coven-agents-local.1`. The public report does not name every contract or
   local follow-up, so unallocated IDs remain unallocated until Beads can be
   reviewed.

Durability remains a separate concern. The public report does not establish a
Beads dependency from `coven-agents-data.1` or `coven-agents-data.2` to any of
the four foundations, so none is asserted here. Each ID is owned by exactly one
**Allowed Bead IDs** list; cross-lane references describe provisional order,
not shared ownership.

### Execution safety

- **Entry conditions:** Phase 0 and the relevant Wave 1 program reviews have
  exited. The Authorization stage admits `coven-agents-security.2` first,
  without waiting for contracts, runner lifecycle, or structured logging.
  Redaction and network work wait for their publicly stated foundations.
- **Public outcome:** Subscriber transitions fail closed, recurring security
  scanning is reviewable, evidence and logs are redacted at every supported
  boundary, and cloud outbound behavior is declared and enforced.
- **Allowed Bead IDs:** `coven-agents-security.2`,
  `coven-agents-security.3`, `coven-agents-security.4`,
  `coven-agents-cloud.4`
- **Owner role:** Joint
- **Predecessor lanes (documentation/program review only):** Product authority
  and evaluation, Security posture, and Evidence baseline before Wave 2
  admission. No Wave 2 concern lane precedes the Authorization stage. The
  Redaction follow-up reviews Explainability evidence, and the Network
  follow-up reviews the cloud foundation evidence from Runner lifecycle.
- **Provisional item order from public evidence:**
  - **Authorization stage:** complete `coven-agents-security.2` first;
    `coven-agents-security.4` follows it.
  - **Redaction follow-up stage:** admit `coven-agents-security.3` only after
    `coven-agents-observability.1`.
  - **Network follow-up stage:** admit `coven-agents-cloud.4` only after
    `coven-agents-cloud.1`.
- **Review checkpoint:** Exercise adversarial entitlement transitions,
  cross-tenant requests, direct and encoded secret shapes across output,
  storage, logs, and errors, recurring scan triage, outbound-policy denials,
  and incident recovery. Review each staged substep independently.
- **Exit evidence:** Focused tests and production configuration demonstrate
  fail-closed subscriber authority, recurring scan coverage, end-to-end
  redaction, enforced egress, sanitized structured logs, and updated
  threat-model residuals.
- **Rollback/recovery expectation:** Stop run admission or publication at the
  affected boundary, rotate any exposed credential, restore the prior policy,
  and resume only after negative tests pass.

### Contracts and capabilities

- **Entry conditions:** The Authorization-stage program review is complete;
  current runner behavior and compatibility risks are inventoried from merged
  main. `coven-agents-contracts.1` does not wait for the cloud, local, or
  observability foundations.
- **Public outcome:** Clients and the cloud runner negotiate explicit,
  versioned capabilities and reject unsupported behavior without inventing or
  silently dropping evidence.
- **Allowed Bead IDs:** `coven-agents-contracts.1`,
  `coven-agents-contracts.4`
- **Owner role:** Copilot
- **Predecessor lanes (documentation/program review only):** Product authority
  and evaluation, Security posture, Evidence baseline, and the Execution
  safety Authorization-stage review. The last gate sequences the public
  program; it is not a claimed Beads dependency.
- **Provisional item order from public evidence:**
  `coven-agents-contracts.1` is the foundation. The allocated follow-up
  `coven-agents-contracts.4`, plus any additional contract follow-up confirmed
  after Beads access returns, follows that foundation.
- **Review checkpoint:** Compare descriptors, schemas, fixtures, route
  behavior, normalized events, and backwards-read behavior across app and
  worker.
- **Exit evidence:** Contract fixtures and conformance tests prove version,
  limit, capability, route, status, and event agreement; unsupported
  capabilities fail explicitly.
- **Rollback/recovery expectation:** Keep the last supported contract readable,
  disable the new capability, and avoid destructive migration until both sides
  pass conformance.

### Runner lifecycle

- **Entry conditions:** The Authorization-stage program review is complete;
  Security posture's tenant identity and credential boundaries remain
  accepted. `coven-agents-cloud.1` and `coven-agents-local.1` are independent
  foundations and do not wait for contracts or structured logging.
- **Public outcome:** Cloud sandboxes and any canonically admitted local
  processes have deterministic ownership, acceptance, idempotent start,
  streaming, cancellation, terminal reconciliation, cleanup, and operator
  recovery without duplicate execution.
- **Allowed Bead IDs:** `coven-agents-cloud.1`,
  `coven-agents-local.1`, `coven-agents-local.2`
- **Owner role:** Joint
- **Predecessor lanes (documentation/program review only):** Product authority
  and evaluation, Security posture, Evidence baseline, and the Execution
  safety Authorization-stage review. The foundation items do not depend on
  Contracts and capabilities or Explainability in this public sequence.
- **Provisional item order from public evidence:** The cloud and local
  foundations run in parallel. `coven-agents-local.2` and any additional local
  follow-up confirmed after Beads access returns follow
  `coven-agents-local.1`. `coven-agents-cloud.4` remains exclusively owned by
  Execution safety and follows `coven-agents-cloud.1`.
- **Review checkpoint:** Test cloud duplicate operations, active-run
  exclusion, stream reconnect, stop, timeout, sandbox destroy, orphan
  detection, and tenant isolation. For canonically admitted local work, test
  process ownership, workspace bounds, streaming, cancellation, isolation, and
  crash cleanup.
- **Exit evidence:** Lifecycle tests and operator smoke paths demonstrate
  deterministic transitions and cleanup for accepted, running, stopped,
  failed, and completed work. Restored Beads review confirms the local scope
  before local implementation is promoted.
- **Rollback/recovery expectation:** Refuse new starts, reconcile stored run
  state, stop or destroy orphaned sandboxes or processes, and restore admission
  only after the affected lifecycle suite passes.

### Explainability

- **Entry conditions:** The Authorization-stage program review is complete;
  stable operation points can emit bounded evidence.
  `coven-agents-observability.1` does not wait for contracts, cloud lifecycle,
  local lifecycle, or durability.
- **Public outcome:** Structured, correlated logs explain which bounded
  operation and lifecycle transition occurred using allowlisted fields rather
  than raw harness output. Complete cross-boundary output redaction remains an
  Execution safety follow-up.
- **Allowed Bead IDs:** `coven-agents-observability.1`
- **Owner role:** Copilot
- **Predecessor lanes (documentation/program review only):** Product authority
  and evaluation, Security posture, Evidence baseline, and the Execution
  safety Authorization-stage review. No other Wave 2 foundation lane precedes
  this foundation.
- **Provisional item order from public evidence:** Structured logging is the
  foundation; `coven-agents-security.3` remains exclusively owned by Execution
  safety and follows it.
- **Review checkpoint:** Trace one cloud run across request, identity, Durable
  Object, sandbox, event stream, usage count, and terminal state; verify
  correlation, tenant scoping, field allowlists, and omission of raw output.
- **Exit evidence:** A versioned structured-log schema and focused tests explain
  success, refusal, failure, cancellation, and recovery with bounded,
  correlated metadata.
- **Rollback/recovery expectation:** Disable new log fields or publication,
  retain only minimum safe incident metadata, and restore the last reviewed
  schema before resuming telemetry.

### Durability

- **Entry conditions:** Phase 0 and the relevant Wave 1 program reviews have
  exited; journal and shared-record candidates are inventoried. Admission and
  any item-level order wait for restored Beads evidence rather than being
  inferred from the four foundation lanes.
- **Public outcome:** Crash-safe journals and shared persistent agent and run
  records survive expected restarts without lost or duplicate transitions.
- **Allowed Bead IDs:** `coven-agents-data.1`,
  `coven-agents-data.2`
- **Owner role:** Joint
- **Predecessor lanes (documentation/program review only):** Product authority
  and evaluation, Security posture, and Evidence baseline. No Wave 2 concern
  lane is asserted as a Beads predecessor.
- **Provisional item order from public evidence:** None. The public Wave 1
  report does not place these data items behind contracts, runner lifecycle, or
  explainability.
- **Review checkpoint:** Inject restart and partial-write failures; verify
  idempotent journal replay, tenant isolation, bounded records, and
  shared-record consistency.
- **Exit evidence:** Recovery tests cover queued and running work, state replay,
  duplicate suppression, partial writes, and shared persistent records.
- **Rollback/recovery expectation:** Stop new writes, restore the last
  known-good state, replay only idempotent journal records, and retain an
  auditable recovery result.

## Later outcome envelopes

These stages are outcomes, not admitted implementation plans. Their work is
selected only after predecessor lanes exit and canonical planning authority is
available.

### Certify

The supported product path has repeatable conformance, security, failure,
recovery, and production-like E2E evidence. Unsupported paths are explicitly
refused rather than implied.

### Platform

Multi-tenant execution has enforceable capacity, fairness, dependency and
source controls, capability evolution, and operator-visible degradation.

### Product data

Product data has explicit ownership and privacy behavior.
`coven-agents-data.3` governs tenant-scoped retention, export, and deletion;
`coven-agents-data.4` governs privacy-safe archive movement and generated
interface documentation, with evidence for every destructive path.

### Operations

Release, deployment, observability, incident response, credential rotation,
backup, restore, and rollback are executable operator procedures with retained
evidence.
