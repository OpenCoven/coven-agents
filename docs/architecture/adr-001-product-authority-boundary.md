# ADR-001: Bound Coven Agents to product execution

- Status: Accepted
- Date: 2026-08-25
- Decision owner: OpenCoven
- Roadmap item: `coven-agents-product.1`

## Context

OpenCoven has separate authorities for familiar identity, protected mutation,
project sessions, durable intent, and accepted runtime definitions. Coven
Agents must deliver a paid execution product without becoming a second source
of truth for those concerns.

## Decision

Coven Agents is a bounded-execution product control plane. It owns product
accounts, subscriptions, tenant derivation, encrypted tenant harness
credentials, execution profiles, admission, Daytona dispatch, PostgreSQL run
state, and product-private evidence.

The browser uses same-origin Auth.js session APIs. Server code revalidates
subscriber authority, derives tenant ownership, acquires credentials, and
dispatches to Daytona. Daytona is the product's execution provider.

`packages/agent-contracts` and `packages/harness` remain private product
adapters. They are not portable ecosystem authority.

## Authority ownership

| Concern | Canonical owner | Coven Agents role |
| --- | --- | --- |
| Product account, subscription, usage, and session | Coven Agents | Own and enforce product access. |
| Familiar identity and belonging | [`OpenCoven/familiar-contract`](https://github.com/OpenCoven/familiar-contract) | Carry opaque versioned references only. |
| Protected familiar mutation | [`OpenCoven/coven-threads`](https://github.com/OpenCoven/coven-threads) | Respect upstream decisions and return bounded evidence. |
| Project and harness-session authority | [`OpenCoven/coven`](https://github.com/OpenCoven/coven) | Consume versioned authority through an explicit future adapter. |
| Durable intent and orchestration | [`OpenCoven/psyche`](https://github.com/OpenCoven/psyche) | Execute one accepted mission; do not own the intent graph. |
| Accepted runtime definitions | [`OpenCoven/coven-runtimes`](https://github.com/OpenCoven/coven-runtimes) | Pin and adapt an accepted runtime version. |
| Product execution and evidence | Coven Agents | Own Daytona lifecycle, tenant credential custody, and bounded records. |
| Internal execution contracts | `packages/agent-contracts`, `packages/harness` | Keep private and repository-local. |

## Integration rules

1. Store opaque upstream identifiers, versions, revisions, and digests rather
   than writable copies of canonical records.
2. Use the canonical owner's versioned API or adapter.
3. Fail closed on unknown authority, owner kind, schema version, or runtime.
4. Keep internal contracts private and on `workspace:*`.
5. Return execution evidence, not orchestration verdicts.
6. Keep product tenant identity distinct from familiar identity.
7. Keep browser authority in the Auth.js application session; derive tenant and
   subscriber authority on the server.
8. Treat caches as disposable views that never grant authority.

## Consequences

Positive:

- every sensitive concern has one named owner;
- Coven Agents can evolve independently as a product;
- tenant isolation, billing, credential custody, and execution evidence have a
  clear enforcement boundary;
- future ecosystem integrations have an explicit adapter shape.

Costs:

- integrations may require an additional versioned request;
- upstream unavailability produces an explicit unavailable result;
- product evidence may require translation before another component accepts it.

## Enforcement and review

Current guardrails include:

- `lib/session.ts` for product tenant and subscriber authority;
- `lib/runner/http.ts` for same-origin route authorization;
- `lib/runner/runtime.ts` for dispatch-time authority revalidation;
- `lib/credentials/store.ts` for tenant-and-harness credential scope;
- `scripts/product-boundary.test.ts` for dependency and inventory checks.

Review this ADR before adding an OpenCoven dependency, persisting canonical
familiar or orchestration state, publishing an internal package, or changing
the product authority boundary. An intentional ownership change requires a
superseding ADR and updated executable guardrails.
