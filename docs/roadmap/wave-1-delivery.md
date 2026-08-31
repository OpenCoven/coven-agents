# Wave 1 Delivery Report

- Status: Historical report — bounded 2026-08-25 tranche complete
- Delivery date: 2026-08-25
- Scope: product authority, safe guest replay, commit leak prevention, and
  execution threat modeling

The checked-in public roadmap snapshot reports public wave status, but its
authority-freshness note applies while private reconciliation remains pending.
This dated report proves the bounded tranche below; it does not close later
work that the authoritative private plan assigns to the same wave.

## Outcome

Wave 1 established a bounded product and security foundation:

- visitors can replay sanitized committed evidence without starting an agent,
  creating a sandbox, using a credential, consuming a paid run, or mutating
  Git;
- GitHub sign-in can create an account without granting subscriber execution;
- staged secret-shaped content is refused before commit;
- execution, identity, credential, evidence, and incident boundaries are
  documented;
- Coven Agents remains a product execution control plane rather than an owner
  of familiar identity, protected memory, or durable orchestration.

## Delivered outcomes

| Public roadmap identifier | Result | Merged evidence |
| --- | --- | --- |
| `coven-agents-product.3` | Deterministic, schema-validated, sanitized guest replay | PRs #62, #85, #86, #89 |
| `coven-agents-security.1` | Privacy-safe staged and tracked secret scanning | [PR #92](https://github.com/OpenCoven/coven-agents/pull/92) |
| `coven-agents-security.5` | Living execution threat model | [PR #93](https://github.com/OpenCoven/coven-agents/pull/93) |
| `coven-agents-product.1` | Accepted product authority boundary and dependency guardrail | [PR #94](https://github.com/OpenCoven/coven-agents/pull/94) |

### Guest boundary

The replay performs no live execution. It validates bounded fixture data,
redacts recognized credential shapes, and loads authentication only after an
explicit account action.

### Commit boundary

The pre-commit scanner reads staged Git blobs, reports only path, line, and
category, and fails closed on oversized input, Git read failure, or an
unapproved credential shape.

### Execution boundary

The current execution boundary is documented in
[ADR-002](../architecture/adr-002-daytona-execution-boundary.md): relative
same-origin browser APIs, server-derived tenant and subscriber authority,
server-only credential acquisition, Daytona dispatch, and PostgreSQL recovery
ownership.

### Product boundary

[ADR-001](../architecture/adr-001-product-authority-boundary.md) assigns product
state to Coven Agents and keeps familiar identity, protected mutation, project
session authority, durable orchestration, and accepted runtime definitions
with their canonical owners.

## Verification evidence

Wave 1 delivery used:

```bash
pnpm hygiene
pnpm secret:scan:all
pnpm check
pnpm typecheck
pnpm test:unit
pnpm build
```

PR #92, PR #93, and PR #94 are public delivery artifacts. GitHub Actions remain
intentionally disabled; retained local results are the repository evidence.

## Residual risks

| Public roadmap identifier | Residual outcome |
| --- | --- |
| `coven-agents-security.2` | Complete subscriber transition and provider-event hardening |
| `coven-agents-security.3` | Complete evidence redaction across every boundary |
| `coven-agents-security.4` | Consolidated recurring dependency and source scanning |
| `coven-agents-cloud.4` | Enforced least-privilege outbound policy |
| `coven-agents-local.2` | Public roadmap history retained; current execution direction is governed by ADR-002 |

Wave 1 did not certify production lifecycle, rollback, recovery, or provider
resource disposition.

## Wave 2 priority

Prioritize subscriber authority, complete redaction, outbound policy,
release-equivalent Daytona lifecycle evidence, restart recovery, and
tenant-scoped retention. Private dependency ordering remains authoritative and
is not duplicated here.
