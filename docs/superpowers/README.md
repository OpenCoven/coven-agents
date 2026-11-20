# Historical Specification Tombstones

This specialized deleted-document index is classified in the
[planning document registry](../roadmap/README.md). It does not index tracked
living plans, proposals, audits, or decision logs.

On 2026-08-29, the repository adopted the reviewed supersession exception in
[delivery governance](../roadmap/delivery-governance.md#supersession-policy-evolution--2026-08-29).
The mixed-content plans and specifications below were removed because obsolete
implementation detail could be mistaken for current guidance. This sanitized
index maps every removed document to the living documents that preserve its
still-applicable decisions without copying private detail or executable
historical topology.

## Per-document mappings

| Removed path | Subject | Superseding current documents | Preserved lessons |
| --- | --- | --- | --- |
| `docs/superpowers/plans/2026-08-22-git-lifecycle-automation.md` | Repository lifecycle implementation | [Delivery governance](../roadmap/delivery-governance.md), [release readiness](../roadmap/release-readiness.md) | Use isolated task branches, protect unique local work, require signed changes, and bind promotion to the repository's current local verification gates. |
| `docs/superpowers/plans/2026-08-23-beads-project-board.md` | Private planning projection implementation | [Delivery governance](../roadmap/delivery-governance.md) | The retired projection design remains recoverable from Git history. Follow current guidance for issue authority and evidence. |
| `docs/superpowers/plans/2026-08-24-demo-replay.md` | Safe replay implementation | [Repository overview](../../README.md), [current repository state](../roadmap/current-state.md), [guest access boundary](../security/guest-access.md) | Guest evaluation uses a committed, schema-validated, sanitized replay with deterministic timing and no database, credential, billing, or execution dependency; deployment requires `IS_DEMO=1`, and capture publication is restricted to `OpenCoven/demo-workspace`. |
| `docs/superpowers/plans/2026-08-24-subscriptions.md` | Subscriber access implementation | [Repository overview](../../README.md), [subscription and billing policy](../product/subscription-billing-policy.md), [guest access boundary](../security/guest-access.md), [release readiness](../roadmap/release-readiness.md) | Preserve the 750-run billing-period cap, three-day renewal-only grace, one active subscription per user, server-owned entitlement timing, signature-verified and idempotent webhook processing, durable usage accounting, and fail-closed recovery. |
| `docs/superpowers/plans/2026-08-24-tenant-identity-and-credential-isolation.md` | Tenant and credential isolation implementation | [ADR-001](../architecture/adr-001-product-authority-boundary.md), [execution threat model](../security/execution-threat-model.md), [key rotation](../security/key-rotation.md), [incident response](../security/incident-response.md) | Derive tenant identity on the server, scope encrypted credentials to tenant and harness, use only the ratified short-lived attempt-stage transfer, redact evidence, and fail closed. |
| `docs/superpowers/plans/2026-08-25-abuse-resilience-and-blast-radius-hardening.md` | Abuse and containment implementation | [Execution threat model](../security/execution-threat-model.md), [incident response](../security/incident-response.md), [implementation sequence](../roadmap/implementation-sequence.md), [release readiness](../roadmap/release-readiness.md) | Bound expensive work before dispatch, enforce tenant and deployment limits, use revocable versioned authority, minimize outbound access, and rehearse containment and recovery. |
| `docs/superpowers/plans/2026-08-25-repository-roadmap.md` | Roadmap and delivery implementation | [Public roadmap](../../ROADMAP.md), [implementation sequence](../roadmap/implementation-sequence.md), [delivery governance](../roadmap/delivery-governance.md), [verification matrix](../roadmap/verification-matrix.md), [release readiness](../roadmap/release-readiness.md) | Keep authority, public status, implementation ordering, evidence, and release decisions separate; promote only from current, reviewed, reproducible evidence. |
| `docs/superpowers/specs/2026-08-20-coven-agents-design.md` | Product architecture | [ADR-001](../architecture/adr-001-product-authority-boundary.md), [ADR-002](../architecture/adr-002-daytona-execution-boundary.md), [current repository state](../roadmap/current-state.md) | The application owns product authority and durable evidence while execution remains isolated behind a server-controlled boundary with explicit failure behavior. |
| `docs/superpowers/specs/2026-08-22-git-lifecycle-automation-design.md` | Repository lifecycle design | [Delivery governance](../roadmap/delivery-governance.md), [release readiness](../roadmap/release-readiness.md) | Repository hygiene must prevent lost local work, distinguish retained history from current state, require signed changes, and make verification evidence explicit. |
| `docs/superpowers/specs/2026-08-23-beads-project-board-design.md` | Private planning projection design | [Delivery governance](../roadmap/delivery-governance.md) | The retired projection design remains recoverable from Git history. Keep private task details out of public artifacts. |
| `docs/superpowers/specs/2026-08-24-demo-replay-design.md` | Safe replay design | [Repository overview](../../README.md), [current repository state](../roadmap/current-state.md), [guest access boundary](../security/guest-access.md) | Replay data is untrusted input: validate its schema, sanitize every visible string, preserve deterministic ordering, require `IS_DEMO=1` for deployment, restrict capture publication to `OpenCoven/demo-workspace`, and refuse unsafe or resource-consuming guest behavior. |
| `docs/superpowers/specs/2026-08-24-subscriptions-design.md` | Subscriber access design | [Repository overview](../../README.md), [subscription and billing policy](../product/subscription-billing-policy.md), [guest access boundary](../security/guest-access.md), [release readiness](../roadmap/release-readiness.md) | Identity alone grants no paid authority; preserve the 750-run billing-period cap, three-day renewal-only grace, one active subscription per user, signature-verified and idempotent provider events, transparent usage, and fail-closed transition recovery. |
| `docs/superpowers/specs/2026-08-24-tenant-identity-and-credential-isolation-design.md` | Tenant and credential isolation design | [ADR-001](../architecture/adr-001-product-authority-boundary.md), [execution threat model](../security/execution-threat-model.md), [key rotation](../security/key-rotation.md), [incident response](../security/incident-response.md) | Trust server-derived tenant claims, bind encrypted rows to their scope, prevent guest data access, exclude credentials from browser and evidence surfaces, and preserve rotation paths. |
| `docs/superpowers/specs/2026-08-25-repository-roadmap-design.md` | Roadmap and delivery design | [Public roadmap](../../ROADMAP.md), [implementation sequence](../roadmap/implementation-sequence.md), [delivery governance](../roadmap/delivery-governance.md), [verification matrix](../roadmap/verification-matrix.md), [release readiness](../roadmap/release-readiness.md) | Public aggregates report approved outcomes rather than private tasks; delivery order follows dependencies, and promotion requires fresh evidence, rollback readiness, and reconciled status. |

## Recovering an original

Git history preserves every original document for authorized historical review:

```bash
git log --all -- <removed-path>
git show <commit>:<removed-path>
```

Recovered text is historical evidence, not current instructions. Do not restore
or execute obsolete implementation details without a separately reviewed
decision.
