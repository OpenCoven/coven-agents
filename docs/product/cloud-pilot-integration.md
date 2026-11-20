# Familiar delegation: cloud pilot integration boundary

Status: bounded implementation with partial production evidence, not production
certification.
Decision context: [Research Parity Upgrade Plan](https://chatgpt.com/share/6aa0de01-9e18-83e9-b26e-662bdfa11cb2).

## Product boundary

The initial workflow is an existing familiar performing a bounded repository
diagnosis or test task, returning a report or patch without publishing, merging,
deploying, or changing protected identity. Persistent delegation and recovery
are the goal; another disconnected chat demo is not acceptance.

Reuse the existing products. Chat remains a focused client. Coven Agents sells
bounded execution capacity, not familiar identity, authority, or continuity.
Do not implement the original generic Bot API, identity database, scheduler,
memory database, or approval service alongside their canonical owners.

| Concern | Owner |
| --- | --- |
| Familiar root and exact identity revision | Familiar Contract |
| Historical context and continuity projection | SPAR |
| Protected-action decisions and approvals | Threads |
| Durable intent and orchestration | Psyche |
| Authoritative runtime/session transitions and execution binding | Coven |
| Account admission, billing, credential custody, Daytona lifecycle | Coven Agents |
| Public transport and bounded client contracts | SDK and Cave |
| Delegation, observation, cancellation, and recovery interaction | Chat |

## Source capability and remaining gates

This is a source-level gap register, not a claim of deployed parity.

| Capability | Source state | Remaining acceptance |
| --- | --- | --- |
| Native Chat familiar/conversation reads | Implemented in Chat | Preserve frozen three-platform native conformance |
| Canonical Runtime Authority dispatch binding | Coven dispatch seam exists; production selection remains separate work | Trusted producer adapters, authenticated consumer admission, immutable terminal receipt |
| Bounded authority consumer projection | Separate draft producer work in [OpenCoven/coven#953](https://github.com/OpenCoven/coven/pull/953) | Add exact base-run, attempt, occurrence, and validity-deadline correlation; projection remains evidence, never a transferable execution capability |
| Daytona dispatch, durable attempts, cancellation/reconciliation | Existing Coven Agents implementation plus a successful production create/execute/delete diagnostic | Exact authority integration and a retained production containment receipt |
| Daytona resource and reuse policy | Production verified `coven-agents-copilot-2` at 2 vCPU, 4 GiB memory, 10 GiB disk, and target `us`; ambiguous cleanup keeps its attempt fence and preserves the workspace | No repeated-run availability until a production containment exercise proves the reset decision and an approved fenced reset or workspace-preserving workflow exists |
| Stripe single-plan validation | Exact configured Price checked before new billing mutations; production Checkout is off because the active live Price is `$30/month`, not the intended `$25/month` | An authorized Stripe operator must create and select the intended `$25/month` live recurring Price |
| Monthly allowance and reservations | Existing transactionally enforced 300-minute allowance, 15-minute run bound | Real-provider settlement across failure/recovery cases |
| Billing recovery after paid access expires | Authenticated, current-version owner may use hosted Portal when Stripe has an active Portal configuration | Create the live Portal configuration and retain the payment recovery journey |
| Public billing policy | `/api/subscription` returns `plan`; `/api/usage` owns bounded allowance observation | Consume only through a reviewed native account/transport contract |
| Native delegate/observe/cancel/recover | Not enabled by this change | Producer and SDK contracts plus packaged native end-to-end evidence |

The current shared source baselines were Chat `550039a`, Coven `cedfa807`,
SDK `2d1cb15f`, and Coven Agents `7f23261`. These identify the inspected
starting points, not a deployment or release receipt.

### Canonical producer prerequisite

Coven's `automations/runner.rs::AutomationDispatchAuthority::resolve` is the
existing admission seam. The run/occurrence stores provide exact attempt,
lease-generation, revision, and adoption identities. They do not authenticate
the familiar's principal or manufacture its declared authority.

`automations/contract/authority.rs` validates the versioned authority profile,
runtime descriptor correlation, approval evidence, and terminal evidence.
Production dispatch still selects `BaseV1`; changing that selection and writing
the producer adapter are **unfinished implementation**, not proof of an external
blocker. The adapter additionally needs an approved trust source for canonical
principal/familiar evidence, verification keys, and runtime-descriptor provenance.
Ward approval, mobile-memory request authentication, and live session descriptors
exist for their own scopes; silently treating those scopes as an automation
execution capability would invent a cross-boundary authorization contract.

The native-to-cloud authenticated account binding and mission operations also
remain unimplemented. Existing Chat `cave_cancel_operation` only cancels an
in-flight transport operation; it must never be advertised as mission
cancellation. The separate consumer-evidence projection cannot fill either
authority gap. No protected native/SDK conformance pin was changed.

[OpenCoven/coven#953](https://github.com/OpenCoven/coven/pull/953) is still a
draft and does not carry the exact base-run, attempt, and occurrence identifiers
or the authorization validity deadline required by this boundary. Coven Agents
must not invent those fields locally or infer them from billing, browser, or
session state.

## Commercial policy

One configured, active, fixed-price monthly subscription buys the disclosed
execution allowance. No automatic metered overage, extra seats, application
trial, or silent inference subsidy is introduced. Customer-supplied harness
credentials and a separate provider entitlement are required.

`lib/billing/pilot-plan.ts` derives disclosure from `lib/billing/limits.ts`;
hosted Checkout displays the exact configured Stripe Price's amount/currency.
The application rejects unsupported annual, multi-month, metered, tiered,
adjustable, trial, transformed-quantity, zero, and fractional-minor-unit prices.
It does not copy a potentially stale currency amount into frontend text.

The same public plan projects sandbox policy defaults (2 vCPU, 4 GiB memory,
10 GiB disk) and caps (4 vCPU, 8 GiB memory, 10 GiB disk) from the server's
dependency-free resource policy. Production deployment
`coven-agents-6gib1jkqo-0xbuns.vercel.app` returned the exact protected
diagnostic receipt for `coven-agents-copilot-2`: 2 vCPU, 4 GiB memory, 10 GiB
disk, and target `us`. The
[Daytona cutover attestation](../operations/daytona-cutover-attestation.md)
records the sanitized evidence boundary.

**Repeated runs are deliberately not ready.** Session/file absence cannot prove
that detached descendants terminated. After a launched or possibly launched
attempt, cleanup retains the exact durable fence and refuses another credential
transfer. Legacy sandbox markers and configuration drift also require an
approved reset rather than automatic workspace deletion. Existing destructive
reset/decommission authority is not broadened. Draft
[PR #268](https://github.com/OpenCoven/coven-agents/pull/268) adds a source-level
synthetic detached-descendant and credential-cleanup exercise, but no production
result is claimed until that exact revision is merged, deployed, and retained.
The resulting availability limitation must be resolved before a paid pilot is
promoted.

Optional existing prepaid minute packs remain explicit purchases controlled
by configuration. They do not turn into automatic overage. The new-sales gate
remains default-off; webhooks, existing entitlement enforcement, and billing
management remain independent of that gate.

Production Checkout is currently off. The live Stripe account has an active
`$30/month` recurring Price, no active Customer Portal configuration, and an
enabled webhook for `invoice.paid`, `invoice.payment_failed`, and
`customer.subscription.deleted`. The current restricted key can read Prices
but cannot create the intended `$25/month` Price or Portal configuration.

### Billing loss is not identity loss

| Event | Fresh paid execution | Existing launched attempt | Billing management |
| --- | --- | --- | --- |
| Failed initial invoice | Not granted | No authority created by payment failure | Current authenticated billed owner only |
| Paid-period expiry or failed renewal | Existing expiry/renewal-grace rules | Exact bounded `finish_current` policy | Remains accessible after fresh authentication |
| Cancellation at period end | Only until the authoritative paid-through time | Existing bound remains | Available to current authenticated owner |
| Refund, dispute, administrative revoke | Existing webhook/override authority rules; no new grant | Existing explicit stop/reconciliation policy, no replacement authority | Requires current account and session version |
| Device/session/principal revocation | Denied for revoked credentials | Security/operator cancellation remains separate | Revoked credentials denied; fresh authorized identity required |
| Complimentary account without Stripe Customer | Existing finite grant only | Existing execution policy | Explicit `customer_required`; no fictitious subscription |

This billing-only recovery exception does not change the product's existing
read, transcript, export, credential, or user-stop authorization rules.
The running-attempt exception does not acquire new credentials or start a
replacement. A billing subscription cannot authorize a familiar or change its
declared identity.

### Purchase surface policy

| Surface | Pilot purchase path |
| --- | --- |
| Web | Hosted Stripe Checkout, only after the default-off sales gate is deliberately enabled |
| Direct-distribution desktop | No new purchase CTA until native account mapping, transport, and release acceptance are complete |
| Mac App Store, iOS, and other mobile storefronts | No universal external-purchase assumption; leave CTA disabled until a storefront-specific policy and approved purchase source exist |
| Existing web billing account | Hosted Portal through a verified current account after Stripe has an active Portal configuration; independent of new-sales enablement |

Tax collection remains unimplemented. Before selling in applicable
jurisdictions, the operator must resolve registration and tax treatment.
Setting an automatic-tax parameter without valid registrations would not
establish compliant collection.

## End-to-end acceptance remains independent

The release journey must use exact pinned packaged Chat, SDK, Cave, Coven,
Coven Agents, and Daytona inputs:

1. Select a real familiar and display its exact root/revision, project,
   runtime, side-effect scope, paid capacity requirement, and execution bound.
2. Obtain canonical acceptance before capacity, credential, sandbox, or
   provider effects. Pin principal, mission, authority validity, and immutable
   attempt/idempotency identity.
3. Launch one bounded Daytona attempt; close Chat and recover the same
   authoritative attempt after reopening it.
4. Observe/cancel through narrow native operations, and retain terminal result,
   artifact, cleanup, and usage evidence.
5. Repeat for stale identity, unavailable authority, duplicate submit,
   entitlement expiry, cancellation races, ambiguous provider starts,
   detached children, cleanup/reset failure, and obsolete client contexts.

Hermetic tests and rendered account UI establish source behavior only.
Retain real Daytona resource/process/credential-cleanup evidence, Stripe
test-mode and live configuration/webhook/Portal evidence, and packaged native
receipts before claiming this journey or enabling new sales.

Reusable skills and scheduled routines follow a successful interactive
workflow. Broad multi-agent execution, marketplaces, additional providers,
complex credit pricing, and automatic publication remain out of scope.
