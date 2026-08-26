# ADR-001: Bound Coven Agents to product execution

- Status: Accepted
- Date: 2026-08-25
- Decision owner: OpenCoven
- Roadmap item: `coven-agents-product.1`

## Context

Coven Agents began as a standalone local-cloud control plane. The wider
OpenCoven ecosystem now has explicit owners for familiar identity, protected
authority, local harness sessions, durable orchestration, and accepted runtime
definitions. If this repository independently expands into those concerns, two
systems can claim authority over the same familiar, memory, approval, session,
or runtime.

The product still needs real private state. It must authenticate customers,
enforce subscriptions, custody a customer's cloud harness credential, create
bounded execution profiles, dispatch work to local or cloud runners, and return
evidence. Those are product responsibilities, not a second familiar runtime.

This decision distinguishes:

- a Coven Agents tenant from an OpenCoven familiar;
- product access authority from familiar mutation authority;
- one bounded mission from durable orchestration;
- product-private run evidence from portable protocol state;
- an internal runner adapter from a canonical runtime registry.

## Decision

Coven Agents is a bounded-execution product control plane. It owns the account,
entitlement, credential, usage, runner-access, and run-evidence state needed to
deliver Coven Agents. It may create product-local execution profiles and run
one mission through a selected runner.

Coven Agents is not the canonical owner of familiar identity, protected
memory, familiar mutation authority, durable cross-surface orchestration, local
session history, or the ecosystem runtime registry. It consumes those owners
through versioned references and adapters when integrations are added.

The browser and Next.js app remain the product control plane. The cloud Worker
remains the product's tenant-isolated execution plane. The local runner remains
a narrow product adapter for launching one host-trusted mission; it must not
grow into a competing durable local runtime.

`packages/agent-contracts` and `packages/harness` remain private workspace
packages:

- `packages/agent-contracts` is the Coven Agents runner wire contract, not a
  portable OpenCoven protocol;
- `packages/harness` is the product's event translation and summarization
  adapter, not the accepted runtime registry.

## Authority ownership

| Concern | Canonical owner | Coven Agents role | Boundary |
| --- | --- | --- | --- |
| Human account and subscription | Coven Agents control plane | Own GitHub account linkage, product user ID, tenant derivation, subscription state, run cap, and product session | Product entitlement never implies familiar identity or familiar mutation authority. |
| Familiar identity and belonging | [`OpenCoven/familiar-contract`](https://github.com/OpenCoven/familiar-contract) | Carry an opaque, versioned familiar reference when an upstream client supplies one | Do not author or become source of truth for `SOUL.md`, `IDENTITY.md`, `MEMORY.md`, human belonging, or Familiar Contract conformance. |
| Protected familiar mutation authority | [`OpenCoven/coven-threads`](https://github.com/OpenCoven/coven-threads), enforced through the trusted Coven daemon | Respect upstream approval outcomes and return execution evidence | Do not evaluate Ward gates, mutate protected surfaces directly, or infer permission from a Coven Agents subscription. |
| Local project and harness-session authority | [`OpenCoven/coven`](https://github.com/OpenCoven/coven) | The current loopback runner provides a narrow compatibility path for one bounded mission | Do not evolve the loopback runner into a second durable session daemon, local memory store, or general client authority boundary. Future deep local integration should adapt to Coven's versioned API. |
| Familiar orchestration and durable intent state | [`OpenCoven/psyche`](https://github.com/OpenCoven/psyche) | Execute one accepted mission and return a bounded result | Do not own canonical intent graphs, delegation, budgets, approvals, recovery, delivery, verdicts, or cross-surface retention. A product run is an attempt, not an orchestration decision. |
| Accepted runtime definitions | [`OpenCoven/coven-runtimes`](https://github.com/OpenCoven/coven-runtimes) | Implement product-specific launch and event adapters for accepted runtimes | Do not create a competing public registry. New ecosystem runtime acceptance starts upstream; this product pins and adapts a version. |
| Product execution profile | Coven Agents | Own name, instructions, model selection, backend selection, workspace reference, and product run status | A profile is not a familiar. Labels such as name or role do not create identity continuity or protected memory. |
| Cloud harness credential | Coven Agents for its cloud product path | Encrypt a tenant/harness credential, lend it to one authorized run, and count usage | It is not an operator credential, global OpenCoven vault, familiar identity key, or reusable authority outside this product. Local provider login remains provider/harness-owned. |
| Product run evidence | Coven Agents | Normalize, redact, display, and retain bounded evidence for a Coven Agents run | The private `packages/agent-contracts` schema is not portable protocol authority. Promotion into ecosystem records must use the canonical owner's versioned adapter. |
| Product UI | Coven Agents; upstream clients such as Coven Cave may embed or call it | Present product account, execution, and evidence state | A UI may request or display authority but never becomes the enforcement boundary. |

## State boundary

Coven Agents may persist:

- product user, tenant, subscription, and usage records;
- encrypted tenant/harness credentials for cloud execution;
- product-local agent profiles and runner connection preferences;
- operation IDs, bounded run status, and product-private run evidence;
- audit-safe identifiers needed to diagnose its own execution path.

Coven Agents must not become authoritative storage for:

- a familiar's soul, identity, protected memory, or human binding;
- Ward weaves, threads, gates, approval ceremonies, or mutation verdicts;
- Psyche intent graphs, delegations, budgets, delivery, or recovery records;
- Coven's canonical local sessions, PTY history, or daemon event ledger;
- the canonical accepted runtime registry;
- general OpenCoven credentials unrelated to a Coven Agents cloud run.

The existing `AgentOwner` members are references, not identity records:

- `tenant` is a Coven Agents product account boundary;
- `cave-familiar` carries upstream IDs and source revision without making this
  repository authoritative for the familiar;
- `standalone` is a compatibility form for records without upstream ownership.

No code may derive a familiar ID from a Coven Agents tenant, derive product
entitlement from a familiar ID, or silently translate one authority domain into
the other.

## Integration rules

1. **Reference, do not copy authority.** Store opaque upstream IDs, schema
   versions, revisions, and digests. Do not mirror a canonical record and then
   accept local writes to the mirror.
2. **Use the owner's API.** Sensitive reads and writes cross a versioned adapter
   to the canonical owner. Coven Agents must not import another product's
   database, state directory, or internal storage crate.
3. **Fail closed on unknowns.** Unknown owner kinds, protocol versions,
   authority outcomes, and runtime definitions are refused or quarantined; they
   do not fall back to standalone execution.
4. **Keep product contracts private.** `@opencoven/agent-contracts` and
   `@opencoven/harness` use `workspace:*` and `"private": true`. Publishing or
   adding another `@opencoven/*` dependency requires an explicit ADR review.
5. **Adopt canonical runtime definitions.** Runtime acceptance occurs in
   `OpenCoven/coven-runtimes`. This repository may temporarily support a
   narrower tested subset, but it must not label a locally invented manifest as
   ecosystem-canonical.
6. **Return evidence, not higher-level verdicts.** A runner reports what
   happened in its bounded attempt. Psyche or another canonical orchestrator
   decides whether that evidence satisfies an intent, budget, approval, or
   recovery policy.
7. **Keep local and cloud trust boundaries explicit.** Cloud execution is a
   Coven Agents product service. Local execution is host-trusted compatibility
   until it delegates to, or is isolated consistently with, the canonical local
   runtime.
8. **Make caches disposable.** A derived upstream view must record its source
   revision and be safe to discard and rebuild. A cache never grants authority
   when the owner is unavailable.

## Data flow

An upstream-independent product run:

1. Coven Agents authenticates the product account and computes subscription
   authority from server-owned state.
2. The caller chooses a product-local execution profile and submits one
   mission.
3. The control plane mints short-lived runner identity for the product tenant.
4. The selected runner executes the bounded mission.
5. Coven Agents returns normalized, redacted product evidence and accounts for
   usage.

An eventual OpenCoven-integrated run adds explicit adapters:

1. An upstream owner sends versioned intent and familiar references.
2. Coven Agents validates the envelope without redefining its meaning.
3. Coven Agents performs only the authorized bounded execution attempt.
4. It returns product evidence correlated to the upstream references.
5. The upstream owner validates, stores, approves, retries, or rejects the
   result under its own rules.

If the upstream authority cannot be validated, Coven Agents refuses the
integrated operation. It may not downgrade it to an ordinary tenant or
standalone run.

## Rejected alternatives

### Make Coven Agents the hosted OpenCoven brain

This would centralize familiar identity, memory, orchestration, credentials,
and execution in the subscription product. It conflicts with the existing
local-first and portable authority owners, widens breach impact, and creates
competing sources of truth.

### Make Coven Agents a stateless UI only

The product cannot safely deliver cloud execution without owning account
entitlement, tenant isolation, credential custody, usage accounting, and
bounded evidence. Removing all private state would push those concerns into
clients or shared tokens and weaken the security boundary.

### Copy upstream records and reconcile later

Bidirectional reconciliation cannot reliably resolve concurrent authority
decisions. A copied familiar, approval, or orchestration graph becomes a fork
the moment both systems can write it. Opaque references and owner APIs preserve
one authority.

## Consequences

Positive:

- every sensitive concern has one named owner;
- Coven Agents can ship independently without claiming ecosystem authority;
- tenant isolation and subscriptions remain product concerns;
- future integrations have a clear adapter and versioning shape;
- the cloud product can evolve without forcing hosted ownership of familiar
  identity or memory.

Costs:

- some integrations require network or local IPC calls to another owner;
- upstream outages must produce explicit unavailable states rather than local
  fallback;
- the current local runner remains intentionally narrower than Coven;
- product run evidence may need translation before another OpenCoven component
  accepts it as portable evidence;
- runtime support can lag the canonical registry while adapters are validated.

## Enforcement and review

Current code-level boundaries:

- `lib/session.ts` defines product tenant and subscriber authority;
- `packages/agent-contracts/src/index.ts` distinguishes tenant,
  `cave-familiar`, and standalone owner references;
- `worker/src/tenant.ts` maps each owner kind exhaustively and fails closed on
  unknown kinds;
- `worker/src/routes.ts` assigns API-created agent ownership from the verified
  caller rather than request input;
- `lib/credentials/store.ts` scopes product cloud credentials to tenant and
  harness;
- `packages/agent-contracts/package.json` and
  `packages/harness/package.json` keep internal contracts private.

`scripts/product-boundary.test.ts` is the executable dependency guardrail. It
requires this ADR and README link, permits only the two existing private
workspace `@opencoven/*` dependencies, and fails if either internal adapter is
made publishable.

Review this ADR before:

- adding an `@opencoven/*` package or direct dependency on another OpenCoven
  repository;
- persisting familiar, memory, approval, orchestration, or runtime-registry
  records;
- adding writes to Coven, Psyche, Coven Threads, or Familiar Contract surfaces;
- making the local runner durable beyond product-local compatibility;
- publishing either private workspace package;
- describing Coven Agents as the canonical OpenCoven control plane, familiar
  runtime, memory system, or orchestration authority.

Any intentional ownership change requires a superseding ADR, updated tests, and
coordinated changes in the repository that currently owns the concern.
