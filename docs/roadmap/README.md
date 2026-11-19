# Planning Document Registry

- Status: current operating index
- Last reviewed: 2026-08-31

This registry is the entry point for Coven Agents planning documents. Private
Beads/DoltHub remains the task-level authority, OpenCoven Project #10 remains
its generated private view, and tracked Markdown contains privacy-safe public
outcomes, operating policy, proposals, and evidence. Do not reconstruct private
task text from this index or treat a newer public artifact as authoritative.

## Lifecycle vocabulary

| Lifecycle | Meaning |
| --- | --- |
| `Current` | Living strategy, policy, state, procedure, or evidence used for present decisions. |
| `Proposed` | Non-authoritative direction that requires approval in Beads before delivery work begins. |
| `Historical` | Dated evidence or a decision log retained for context but not used as current instructions. |
| `Superseded` | An index or artifact whose operative guidance has moved to named current documents. |

## Reconciliation status

On 2026-08-31, `pnpm roadmap:status check` confirmed that Project #10's
field-only aggregate matched the checked-in `ROADMAP.md` block. The private
Beads repository could not be read by the active credential, so the
Beads-to-Project no-op reconciliation remains pending. No task status,
dependency, wave order, or promotion claim was inferred from public artifacts.

## Registry

<!-- coven-agents-planning-registry:v1:start -->
| Path | Role | Lifecycle | Authority | Last reviewed | Current guidance |
| --- | --- | --- | --- | --- | --- |
| [`ROADMAP.md`](../../ROADMAP.md) | Strategy | Current | Beads-derived aggregate | 2026-08-31 | — |
| [`POLISH.md`](../../POLISH.md) | Decision log | Historical | Repository evidence | 2026-08-31 | [Current state](current-state.md), [implementation sequence](implementation-sequence.md) |
| [`docs/roadmap/README.md`](README.md) | Registry | Current | Operating policy | 2026-08-31 | — |
| [`docs/roadmap/current-state.md`](current-state.md) | State | Current | Repository evidence | 2026-09-02 | — |
| [`docs/roadmap/daytona-cutover-audit-2026-08-29.md`](daytona-cutover-audit-2026-08-29.md) | Evidence | Historical | Repository evidence | 2026-08-31 | [Current state](current-state.md), [verification matrix](verification-matrix.md), [cutover attestation](../operations/daytona-cutover-attestation.md) |
| [`docs/roadmap/delivery-governance.md`](delivery-governance.md) | Governance | Current | Operating policy | 2026-08-31 | — |
| [`docs/roadmap/implementation-sequence.md`](implementation-sequence.md) | Sequence | Current | Beads-derived aggregate | 2026-08-31 | — |
| [`docs/roadmap/release-readiness.md`](release-readiness.md) | Readiness | Current | Operating policy | 2026-08-31 | — |
| [`docs/roadmap/ui-functionality-audit-2026-08-26.md`](ui-functionality-audit-2026-08-26.md) | Evidence | Historical | Repository evidence | 2026-08-31 | [Current state](current-state.md), [verification matrix](verification-matrix.md), [release readiness](release-readiness.md) |
| [`docs/roadmap/verification-matrix.md`](verification-matrix.md) | Verification | Current | Repository evidence | 2026-09-02 | — |
| [`docs/roadmap/wave-1-delivery.md`](wave-1-delivery.md) | Evidence | Historical | Repository evidence | 2026-08-31 | [Public roadmap](../../ROADMAP.md), [implementation sequence](implementation-sequence.md) |
| [`docs/proposals/prewarm.md`](../proposals/prewarm.md) | Proposal | Proposed | Non-authoritative proposal | 2026-08-31 | — |
| [`docs/proposals/run-diagnostics.md`](../proposals/run-diagnostics.md) | Proposal | Proposed | Non-authoritative proposal | 2026-08-31 | — |
| [`docs/superpowers/README.md`](../superpowers/README.md) | Tombstone | Superseded | Repository evidence | 2026-08-31 | [Delivery governance](delivery-governance.md) |
| [`docs/beads-project-sync.md`](../beads-project-sync.md) | Governance | Current | Operating policy | 2026-08-31 | — |
| [`docs/operations/daytona-cutover-attestation.md`](../operations/daytona-cutover-attestation.md) | Evidence | Current | Repository evidence | 2026-08-31 | — |
| [`docs/operations/vercel-git-deployment-disablement.md`](../operations/vercel-git-deployment-disablement.md) | Governance | Current | Operating policy | 2026-08-31 | — |
| [`docs/operations/pack-draw-ledger.md`](../operations/pack-draw-ledger.md) | Proposal | Proposed | Non-authoritative proposal | 2026-11-17 | — |
<!-- coven-agents-planning-registry:v1:end -->

## Maintenance rules

1. Reconcile private Beads first, commit and push its Dolt state, then run the
   documented two-apply Project sync to a final no-op preview.
2. Refresh the generated `ROADMAP.md` aggregate only after Beads and Project
   agree. Never hand-edit the generated status block.
3. Add every tracked roadmap or proposal document to this registry in the same
   change that creates it.
4. Mark proposals as non-authoritative until Beads approves their delivery.
5. Preserve dated evidence. When it becomes inaccurate, add a correction note
   or point its registry row to current guidance instead of silently rewriting
   history.
6. Keep deleted mixed-content specifications mapped in
   [`docs/superpowers/README.md`](../superpowers/README.md); do not restore them
   as current instructions.
7. Run `pnpm planning:check` before committing. The check validates registry
   coverage, lifecycle and role values, review dates, and current-guidance
   paths without reading private planning content.

If private authority is unavailable, leave authority-derived status unchanged
and record the access failure as a blocker. Repository evidence and tooling may
be improved independently, but they do not prove planning reconciliation or
authorize promotion.
