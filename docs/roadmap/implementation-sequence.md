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
- The tracked runner contract is cloud-only. The IDs
  `coven-agents-local`, `coven-agents-local.1`,
  `coven-agents-local.2`, `coven-agents-local.3`,
  `coven-agents-local.4`, and `coven-agents-local.5` are quarantined from
  promotion unless canonical planning authority explicitly retires or
  re-scopes them. They do not authorize reintroducing a local runner.

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
  `pnpm hygiene`, `pnpm check`, `pnpm typecheck`, `pnpm test:unit`,
  `pnpm build`, and `pnpm roadmap:status check` all exit 0 from that state.
- **Rollback/recovery expectation:** Do not promote. Preserve sanitized failure
  evidence, repair the narrow cause, and rerun the complete baseline.

**Current state:** lint, types, 805 unit tests, build, and roadmap status passed;
hygiene did not.

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
- **Allowed Bead IDs:** `coven-agents-dx.2`,
  `coven-agents-dx.5`
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

### Contracts and capabilities

- **Entry conditions:** Wave 1 boundaries are stable; supported runner behavior
  is represented by versioned schemas and fixtures; compatibility policy is
  reviewable.
- **Public outcome:** Clients and the cloud runner negotiate explicit,
  versioned capabilities and reject unsupported behavior without inventing or
  silently dropping evidence.
- **Allowed Bead IDs:** `coven-agents-contracts.1`,
  `coven-agents-contracts.4`
- **Owner role:** Copilot
- **Predecessor lanes:** Product authority and evaluation, Security posture,
  Evidence baseline.
- **Review checkpoint:** Compare descriptors, schemas, fixtures, route
  behavior, normalized events, and backwards-read behavior across app and
  worker.
- **Exit evidence:** Contract fixtures and conformance tests prove version,
  limit, capability, route, status, and event agreement; unsupported
  capabilities fail explicitly.
- **Rollback/recovery expectation:** Keep the last supported contract readable,
  disable the new capability, and avoid destructive migration until both sides
  pass conformance.

### Execution safety

- **Entry conditions:** Identity and product authority are stable; contract
  boundaries are explicit; the threat model names the affected trust
  boundaries.
- **Public outcome:** Subscription transitions fail closed, evidence is
  sanitized at every supported boundary, and cloud outbound behavior is
  declared and enforced.
- **Allowed Bead IDs:** `coven-agents-security.2`,
  `coven-agents-security.3`, `coven-agents-cloud.4`
- **Owner role:** Joint
- **Predecessor lanes:** Security posture, Contracts and capabilities.
- **Review checkpoint:** Exercise adversarial entitlement transitions,
  cross-tenant requests, direct and encoded secret shapes, outbound-policy
  denials, and incident recovery.
- **Exit evidence:** Focused tests and production configuration demonstrate
  fail-closed entitlement, end-to-end redaction, enforced egress, sanitized
  logs, and updated threat-model residuals.
- **Rollback/recovery expectation:** Stop run admission or publication at the
  affected boundary, rotate any exposed credential, restore the prior policy,
  and resume only after negative tests pass.

### Runner lifecycle

- **Entry conditions:** The cloud-only backend remains explicit; contracts and
  execution-safety prerequisites pass; no quarantined local ID is admitted.
- **Public outcome:** Cloud runs have observable acceptance, idempotent start,
  bounded concurrency, cancellation, terminal reconciliation, cleanup, and
  operator recovery without duplicate execution.
- **Allowed Bead IDs:** `coven-agents-cloud.1`
- **Owner role:** Joint
- **Predecessor lanes:** Contracts and capabilities, Execution safety.
- **Review checkpoint:** Test duplicate operations, active-run exclusion,
  stream reconnect, stop, timeout, sandbox destroy, orphan detection, and
  tenant isolation.
- **Exit evidence:** Lifecycle tests and an operator smoke path demonstrate
  deterministic transitions and cleanup for accepted, running, stopped,
  failed, and completed runs.
- **Rollback/recovery expectation:** Refuse new starts, reconcile stored run
  state, stop or destroy orphaned sandboxes, and restore admission only after
  the lifecycle suite passes.

### Durability

- **Entry conditions:** Runner lifecycle transitions are deterministic;
  identity and contract versions survive restart; journal and shared-record
  boundaries are explicit.
- **Public outcome:** Crash-safe journals and shared persistent agent and run
  records survive expected restarts without lost or duplicate transitions.
- **Allowed Bead IDs:** `coven-agents-data.1`,
  `coven-agents-data.2`
- **Owner role:** Joint
- **Predecessor lanes:** Runner lifecycle, Contracts and capabilities,
  Execution safety.
- **Review checkpoint:** Inject restart and partial-write failures; verify
  idempotent journal replay, tenant isolation, and shared-record consistency.
- **Exit evidence:** Recovery tests cover queued and running work, state replay,
  duplicate suppression, partial writes, and shared persistent records.
- **Rollback/recovery expectation:** Stop new writes, restore the last
  known-good state, replay only idempotent journal records, and retain an
  auditable recovery result.

### Explainability

- **Entry conditions:** Contracts define the event vocabulary; execution safety
  defines disclosure limits; lifecycle and durability expose stable state.
- **Public outcome:** Users and operators can explain what ran, under which
  bounded profile, with which state transition and resource result, without
  exposing credentials or another tenant's data.
- **Allowed Bead IDs:** `coven-agents-observability.1`
- **Owner role:** Copilot
- **Predecessor lanes:** Contracts and capabilities, Execution safety, Runner
  lifecycle, Durability.
- **Review checkpoint:** Trace one run across request, identity, Durable Object,
  sandbox, event stream, usage count, and terminal state; verify sanitization
  and tenant scoping at each boundary.
- **Exit evidence:** Structured, correlated, sanitized evidence explains
  success, refusal, failure, cancellation, and recovery without raw secret or
  private-path disclosure.
- **Rollback/recovery expectation:** Stop persistence or publication of unsafe
  evidence, sanitize affected records, rotate exposed credentials, and retain
  only the minimum safe incident metadata.

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
