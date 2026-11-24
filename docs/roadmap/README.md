# Planning Document Registry

- Status: current operating index
- Last reviewed: 2026-11-23

This registry is the entry point for Coven Agents planning documents. GitHub issues track repository work and acceptance. Tracked Markdown contains public outcomes, operating policy, proposals, and evidence. Keep private material out of both.

## Lifecycle vocabulary

| Lifecycle | Meaning |
| --- | --- |
| `Current` | Living strategy, policy, state, procedure, or evidence used for present decisions. |
| `Proposed` | Non-authoritative direction that requires maintainer approval before delivery work begins. |
| `Historical` | Dated evidence or a decision log retained for context but not used as current instructions. |
| `Superseded` | An index or artifact whose operative guidance has moved to named current documents. |

## Registry

<!-- coven-agents-planning-registry:v1:start -->
| Path | Role | Lifecycle | Authority | Last reviewed | Current guidance |
| --- | --- | --- | --- | --- | --- |
| [`ROADMAP.md`](../../ROADMAP.md) | Strategy | Current | Delivery summary | 2026-11-23 | — |
| [`POLISH.md`](../../POLISH.md) | Decision log | Historical | Repository evidence | 2026-08-31 | [Current state](current-state.md), [implementation sequence](implementation-sequence.md) |
| [`docs/roadmap/README.md`](README.md) | Registry | Current | Operating policy | 2026-11-23 | — |
| [`docs/roadmap/current-state.md`](current-state.md) | State | Current | Repository evidence | 2026-11-23 | — |
| [`docs/roadmap/daytona-cutover-audit-2026-08-29.md`](daytona-cutover-audit-2026-08-29.md) | Evidence | Historical | Repository evidence | 2026-08-31 | [Current state](current-state.md), [verification matrix](verification-matrix.md), [cutover attestation](../operations/daytona-cutover-attestation.md) |
| [`docs/roadmap/delivery-governance.md`](delivery-governance.md) | Governance | Current | Operating policy | 2026-08-31 | — |
| [`docs/roadmap/implementation-sequence.md`](implementation-sequence.md) | Sequence | Current | Delivery summary | 2026-11-23 | — |
| [`docs/roadmap/release-readiness.md`](release-readiness.md) | Readiness | Current | Operating policy | 2026-11-23 | — |
| [`docs/roadmap/ui-functionality-audit-2026-08-26.md`](ui-functionality-audit-2026-08-26.md) | Evidence | Historical | Repository evidence | 2026-08-31 | [Current state](current-state.md), [verification matrix](verification-matrix.md), [release readiness](release-readiness.md) |
| [`docs/roadmap/verification-matrix.md`](verification-matrix.md) | Verification | Current | Repository evidence | 2026-11-23 | — |
| [`docs/roadmap/wave-1-delivery.md`](wave-1-delivery.md) | Evidence | Historical | Repository evidence | 2026-08-31 | [Public roadmap](../../ROADMAP.md), [implementation sequence](implementation-sequence.md) |
| [`docs/proposals/prewarm.md`](../proposals/prewarm.md) | Proposal | Proposed | Non-authoritative proposal | 2026-08-31 | — |
| [`docs/proposals/run-diagnostics.md`](../proposals/run-diagnostics.md) | Proposal | Proposed | Non-authoritative proposal | 2026-08-31 | — |
| [`docs/superpowers/README.md`](../superpowers/README.md) | Tombstone | Superseded | Repository evidence | 2026-08-31 | [Delivery governance](delivery-governance.md) |
| [`docs/operations/daytona-cutover-attestation.md`](../operations/daytona-cutover-attestation.md) | Evidence | Current | Repository evidence | 2026-08-31 | — |
| [`docs/operations/vercel-git-deployment-disablement.md`](../operations/vercel-git-deployment-disablement.md) | Governance | Current | Operating policy | 2026-08-31 | — |
| [`docs/operations/pack-draw-ledger.md`](../operations/pack-draw-ledger.md) | Proposal | Historical | Repository evidence | 2026-11-23 | [Release readiness](release-readiness.md#database-migration), [verification matrix](verification-matrix.md#billing-ledger-checkpoint) |
<!-- coven-agents-planning-registry:v1:end -->

## Maintenance rules

1. Keep delivery issues current and link accepted work to its merged pull request and verification evidence.
2. Update public outcomes and gates when issue state or verified evidence changes. Keep private task details out of tracked summaries.
3. Add every tracked roadmap or proposal document to this registry in the same change that creates it.
4. Mark proposals as non-authoritative until the maintainer approves delivery.
5. Preserve dated evidence. When it becomes inaccurate, add a correction note or point its registry row to current guidance.
6. Keep deleted mixed-content specifications mapped in [the historical specification index](../superpowers/README.md).
7. Run `pnpm planning:check` before committing. It validates registry coverage, lifecycle and role values, review dates, and current-guidance paths locally.
