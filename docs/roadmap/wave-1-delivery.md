# Wave 1 Delivery Report

- Status: Complete
- Delivery date: 2026-08-25
- Scope: product boundary, zero-resource demo, commit leak prevention, and
  execution threat model
- Source of truth: private Beads workspace
- Generated view: OpenCoven Project #10

## Outcome

Wave 1 established a safe boundary for showing, selling, and extending Coven
Agents before broader subscriber and runner work begins:

- visitors can replay a populated coding-agent demo without starting a worker,
  touching a database, borrowing a credential, consuming a paid run, or
  mutating Git;
- GitHub sign-in can create a product account without granting subscriber
  execution authority;
- staged secret-shaped content is refused before formatting or commit;
- local and cloud trust boundaries, residual risks, and incident expectations
  are documented;
- Coven Agents is explicitly bounded to product execution rather than becoming
  a competing familiar identity, memory, authority, orchestration, or runtime
  registry.

## Delivered outcomes

| Bead | Result | Merged evidence |
| --- | --- | --- |
| `coven-agents-product.3` | Zero-persistence replay with validated timing, sanitized evidence, no demo-side runner/database/billing/Git requests, and a safe GitHub account path | [PR #62](https://github.com/OpenCoven/coven-agents/pull/62), [PR #85](https://github.com/OpenCoven/coven-agents/pull/85), [PR #86](https://github.com/OpenCoven/coven-agents/pull/86), [PR #89](https://github.com/OpenCoven/coven-agents/pull/89) |
| `coven-agents-security.1` | Staged-index secret scanning before `lint-staged`, tracked-file scanning, privacy-safe findings, bounded reads, and reviewed synthetic-fixture markers | [PR #92](https://github.com/OpenCoven/coven-agents/pull/92) |
| `coven-agents-security.5` | Living threat model covering assets, actors, trust boundaries, abuse cases, mitigations, residual risks, and incident recovery | [PR #93](https://github.com/OpenCoven/coven-agents/pull/93) |
| `coven-agents-product.1` | Accepted product authority ADR plus a dependency guardrail that keeps internal runner contracts private and repo-local | [PR #94](https://github.com/OpenCoven/coven-agents/pull/94) |

Supporting foundations already present at Wave 1 exit:

- `coven-agents-cloud.2` keeps tenant identity, ownership, database access, and
  encrypted harness credentials isolated;
- `coven-agents-dx.2` closes signed-commit, worktree, and branch-lifecycle gaps;
- [PR #56](https://github.com/OpenCoven/coven-agents/pull/56) provides the
  private Beads to Project #10 projection, graph validation, privacy filtering,
  idempotent reconciliation, and batched GraphQL mutations.

### Demo boundary

The committed replay is curated synthetic evidence. It is intentionally not
presented as a live recording. The recorder remains cloud-only and refuses a
target other than the public synthetic demo workspace.

The demo route:

- validates a committed transcript against the shared schema;
- replays monotonic event offsets through production presentation components;
- checks raw and canonical JSON for credential-shaped evidence;
- does not fetch runner connection data, mint runner identity, reach the
  database, or submit a run;
- loads authentication only after the user explicitly selects the GitHub
  account action.

### Commit boundary

The pre-commit hook reads staged Git blobs, not working-tree files. A matching
value cannot be hidden by an unstaged edit, and findings report only sanitized
path, line, and category.

The scanner fails closed when:

- an individual file exceeds 1 MiB;
- total scanned content exceeds 20 MiB;
- Git cannot provide the staged or tracked blob;
- a recognized credential or private key is found without a reviewed synthetic
  fixture marker.

### Execution boundary

The living [execution threat
model](../security/execution-threat-model.md) records that:

- cloud identity comes from signed tenant claims, not the shared deployment
  gate;
- tenant credentials are encrypted by the control plane and borrowed for one
  run;
- the cloud runner is containerized but does not yet enforce a declared egress
  policy;
- the local runner is trusted-host execution and its workspace check is not
  operating-system isolation;
- redaction is pattern-based and is not yet consistently enforced across every
  local output boundary.

### Product boundary

The accepted [product authority
boundary](../architecture/adr-001-product-authority-boundary.md) assigns one
canonical owner for each concern:

- Coven Agents owns product accounts, subscriptions, usage, cloud credential
  custody, bounded execution profiles, and its run evidence;
- Familiar Contract owns familiar identity and belonging;
- Coven and Coven Threads own local and protected mutation authority;
- Psyche owns durable familiar orchestration state;
- Coven Runtimes owns accepted runtime definitions.

Internal `@opencoven/agent-contracts` and `@opencoven/harness` packages remain
private workspace adapters. Adding another OpenCoven dependency or publishing
either package now fails the product-boundary regression until the ADR is
deliberately revisited.

## Verification evidence

The final Wave 1 branches passed the repository's authoritative local gates:

```bash
pnpm hygiene
pnpm secret:scan:all
pnpm check
pnpm typecheck
pnpm test:unit
pnpm build
```

Additional focused evidence:

- demo schema, timing, redaction, fixture, recorder, route, and browser tests;
- default and demo-mode production builds;
- staged-index, filename-sanitization, size-limit, near-miss, and reviewed
  fixture scanner tests;
- structural tests that require the threat model, authority ADR, concrete code
  references, named residual-risk Beads, and README links;
- signed commits verified before push;
- Vercel preview deployment completed for PRs #93 and #94.

GitHub Actions remains intentionally disabled for pre-release cost control.
Local gates are therefore authoritative; the workflow definitions provide
future CI coverage but are not counted as current execution evidence.

## Roadmap and Project state

At Wave 1 close, the private roadmap contains:

| State | Count |
| --- | ---: |
| Total Beads | 60 |
| Closed | 6 |
| Open | 54 |
| Ready | 19 |
| Blocked | 35 |
| In progress | 0 |

The four Wave 1 delivery Beads are closed. The other two closed foundations are
`coven-agents-cloud.2` and `coven-agents-dx.2`.

Project #10 synchronization remained one-way and idempotent:

- the threat-model close updated six affected items in one GraphQL mutation
  request;
- the authority-boundary close updated six affected items in one GraphQL
  mutation request;
- the demo close updated five affected items in one GraphQL mutation request;
- every apply was followed by a zero-create, zero-update preview;
- no managed item was orphaned and no unmanaged item was modified.

## Residual risks

Wave 1 names these risks; it does not claim they are already mitigated:

| Risk | Current state | Roadmap owner |
| --- | --- | --- |
| Subscriber authority can drift if provider events, ordering, downgrade, and recovery are not modeled as one server-owned state machine | Product paths fail closed in several layers, but ingestion and adversarial transition coverage are incomplete | `coven-agents-security.2` |
| Unsafe harness output can cross a display or persistence boundary, especially through raw local-runner output | Shared redaction exists and demo/cloud paths use it selectively | `coven-agents-security.3` |
| Pre-commit hooks can be bypassed and dependency/source risk is not continuously triaged | Staged and tracked scans exist; recurring consolidated scanning does not | `coven-agents-security.4` |
| Cloud sandbox egress is not declared or enforced | Container isolation exists without a product-visible outbound policy | `coven-agents-cloud.4` |
| Local harnesses inherit the host account's filesystem, process, and environment authority | Loopback, token, origin, workspace-start, time, body, and output bounds reduce exposure but do not isolate the process | `coven-agents-local.2` |
| Bursty cloud tenants can exhaust shared capacity without explicit fairness | Per-agent active-run control exists; platform queueing does not | `coven-agents-cloud.3` |
| Run retention, export, and deletion policy is incomplete | Stores are implementation-specific and bounded only by current behavior | `coven-agents-data.3` |

## Wave 2 priority

The next wave should preserve dependency order rather than starting the largest
visible features first.

1. **Close the only ready P0 item:
   `coven-agents-security.2`.** It is a small, high-impact boundary for the paid
   product and unblocks continuous scanning policy in
   `coven-agents-security.4`.
2. **Run four independent foundation lanes in parallel:**
   `coven-agents-cloud.1`, `coven-agents-contracts.1`,
   `coven-agents-local.1`, and `coven-agents-observability.1`.
3. **Use the newly cleared dependencies:** cloud lifecycle unlocks queueing and
   egress policy; local process ownership unlocks isolation, cancellation,
   discovery, and crash recovery; structured logging unlocks complete
   redaction; contract versioning unlocks six downstream compatibility and
   lifecycle items.
4. **Then close the highest-risk follow-ups:** `coven-agents-security.3`,
   `coven-agents-security.4`, `coven-agents-cloud.4`, and
   `coven-agents-local.2`.

This ordering puts authorization, process ownership, versioned contracts, and
observable evidence ahead of broader product expansion.
