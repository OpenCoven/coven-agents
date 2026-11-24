# Implementation Sequence

## Current delivery checkpoint

The baseline gate repair shipped in #302. The later dependency regression was repaired in [#319](https://github.com/OpenCoven/coven-agents/pull/319). Scoped owner credentials and inspection shipped in #311, and guarded binding and redacted run evidence shipped in #312. Issues #296, #297, and #298 are complete at the repository contract boundary. Keep the verified merge SHAs in the Castles consumer pins. The contributor setup and Git hook update carries the reviewed changes from #310 and the guide from #305. The account-keyed billing ledger landed in #317 with migrations 0048 and 0049 after runner migration 0047. Issues #225 and #226 are complete at the repository boundary. Production migration remains separately gated. Keep dependency updates in their own qualification lane.

- #299 is complete in [#320](https://github.com/OpenCoven/coven-agents/pull/320) at `6d7f257d2793f1091877678e0e2e7c5daecadb30`. Exact-head normal browser qualification passed 35 cases with 16 existing conditional skips after an owned generated-cache reset. Landed acceptance replay passed 276 focused cases and 36 disposable PostgreSQL cases, zero skips. Trusted target installed-version observation remains under #300; no deployment or consumer pin adoption is implied.
- #300 is open. The maintainer selected snapshot verification only. The lifecycle owner still needs to expose and qualify the versioned read-only result, including the observed harness version, and verify the exact pin and mismatch refusal. A snapshot build policy is not a measured installed version. [Bootstrap decision](https://github.com/OpenCoven/coven-agents/issues/300#issuecomment-6791981973) · [Castles acceptance](https://github.com/OpenCoven/coven-castles/issues/3)

The web subscriber release still requires candidate-specific evidence. Track tenant and credential isolation in [#47](https://github.com/OpenCoven/coven-agents/issues/47), admission and revocation in [#49](https://github.com/OpenCoven/coven-agents/issues/49), live provider containment in [#262](https://github.com/OpenCoven/coven-agents/issues/262), and paid sales in [#263](https://github.com/OpenCoven/coven-agents/issues/263). The [subscriber rollout checklist](https://github.com/OpenCoven/coven-agents/issues/51) ties these results to one release candidate.

This sequence describes public outcome ordering. Check the delivery issues for task status and acceptance criteria.

## Next actions and owners — 2026-11-23

The starting delivery inventory was 11 open issues and 12 open PRs. #320 is now merged and #299 closed after landed acceptance; 10 issues remain open at this checkpoint. The reconciliation draft and concurrent contributions affect PR counts independently. GitHub remains authoritative for current counts, assignments and acceptance. This board records the existing handoff roles; it does not assert operator availability or mutate assignments. Complete independent work when one row is blocked. No issue closes by age, merge alone or a reduced acceptance checklist.

| Order | Issue | Coordination owner | Missing proof and next action | Unblock condition |
| --- | --- | --- | --- | --- |
| Complete | [#299](https://github.com/OpenCoven/coven-agents/issues/299) | BunsDev, delivery maintainer | Landed `6d7f257d2793f1091877678e0e2e7c5daecadb30`; 276 focused and 36 PostgreSQL acceptance cases pass on main with zero skips | Closed with [landed evidence](https://github.com/OpenCoven/coven-agents/issues/299#issuecomment-7118619008); follow installed-version and consumer adoption through their owners |
| 2 | [#326](https://github.com/OpenCoven/coven-agents/issues/326) | PR #327 implementer | Confirm original-branch handoff or apply qualified integration `5e15007`; retain both migrations/suites, exact backfill and reviewed qualification repairs; exclude #325 | Qualified migration order and both attempt-reference/concurrent-denial acceptance rows on landed main |
| 3 | [#328](https://github.com/OpenCoven/coven-agents/issues/328) | BunsDev, CLI delivery maintainer | Complete draft transition and authorized landing of fully qualified `7d6557d`, then verify acceptance on main | Source acceptance for unrestricted-only CLI execution; target installation/provisioning remains separate |
| 4 | [#322](https://github.com/OpenCoven/coven-agents/issues/322) | Castles #2 steward | Complete producer ready/ownership disposition for qualified `552ae41`, then accept the reviewed producer/consumer pair after verifying both repositories’ landed revisions; coordinate any consumer rebase without changing accepted pins prematurely | Maintainer/steward acceptance and retained strict-default, nullable-metadata compatibility evidence |
| 5 | [#323](https://github.com/OpenCoven/coven-agents/issues/323) | BunsDev, platform decision owner | Decide each field independently: explicit unknown accepted, or an authorized read-only provider observation required | Recorded decision; when observation is required, preserved values, omission/mismatch handling and consumer agreement |
| 6 | [#300](https://github.com/OpenCoven/coven-agents/issues/300) | BunsDev, lifecycle-owner coordinator | Assign the trusted read-only installed-version observation and agree manifest comparison/digest with Castles #3 | Observed exact-bound version, zero writes/lifecycle calls, repeated-read and mismatch/unavailable/foreign refusal evidence |
| 7 | [#51](https://github.com/OpenCoven/coven-agents/issues/51) | BunsDev, release coordinator | Obtain the sanitized production callback rejection stage and endpoint/database/role match status, then verify legitimate OAuth completion/reload and select the candidate/audience/window | Named operator and approved candidate-specific release receipt; no inferred sign-in success from health or initiation |
| 8 | [#262](https://github.com/OpenCoven/coven-agents/issues/262) | Daytona lifecycle operator | Qualify the selected profile's containment, exact credential cleanup, ambiguity/reset behavior and safe subsequent execution | Sanitized real-provider matrix in an explicitly approved window; diagnostics and fixture passes alone are insufficient |
| 9 | [#47](https://github.com/OpenCoven/coven-agents/issues/47) | BunsDev, tenant-isolation coordinator | Run the legitimate two-tenant account/credential/run/event/SSE/deletion refusals on the selected deployment and consume #262's cleanup/egress proof | Same-candidate tenant and credential isolation receipt with supported inbound/outbound posture |
| 10 | [#49](https://github.com/OpenCoven/coven-agents/issues/49) | BunsDev, admission coordinator | Verify real current-version access, revocation, duplicate accounting and exact settlement; #325 remains a separate unmerged pilot proposal | Approved audience and legitimate-account window, access/allowance evidence and conditional billing disposition |
| 11 | [#263](https://github.com/OpenCoven/coven-agents/issues/263) | Billing/release operator | Refresh Price/mode/Portal/jurisdiction and existing-obligation evidence, then execute test-mode Checkout through signed webhook, settlement and Portal | Complete dated billing receipt before paid sales; a complimentary pilot keeps sales off and requires separate approval |

Other open PRs keep their separate lanes. #325 does not select a pilot audience through this delivery stack. #279's opt-in auth activation, #291's model availability/UI qualification and #329/#331–#333 dependency/security changes require their own exact-head review; an SDK major update invalidates earlier SDK-specific claims until requalified. #334's two inspection sections were handed off for this reconciliation; its later API-example contribution remains separately owned pending coordination. Do not close or merge unrelated PRs simply because this stack lands.

## Authority reminder

Coven Agents owns product accounts, subscriptions, encrypted tenant harness credentials, Daytona execution, PostgreSQL run state, and bounded evidence. Other OpenCoven authorities remain external and are consumed through versioned references and adapters.

## Promotion model

An outcome advances only when:

1. dependencies are complete;
2. repository gates pass on the candidate;
3. the verification matrix cites retained evidence;
4. production-only claims have operator approval;
5. rollback and recovery criteria are explicit.

## Phase 0

### Planning authority

- Verify issue owners, blockers, and acceptance before advancing delivery.
- Link landed changes and their evidence from the delivery issue.
- Keep private task details out of public artifacts.

### Repository integrity

- Keep one worktree per task and no `AT RISK` worktree.
- Sign every commit and push branches before they become unattended.
- Keep dependency, route, environment, and package inventories executable.

### Evidence baseline

- Run the five repository gates.
- Record exact commit, command, exit status, date, and environment.
- Keep local evidence distinct from production approval.

## Wave 1

### Product authority and evaluation

- Maintain ADR-001 and ADR-002 as the execution and ownership boundaries.
- Keep the guest replay deterministic, sanitized, and resource-free.
- Keep internal contracts private and versioned.

### Security posture

- Keep subscriber authority server-derived and fail closed.
- Keep credential acquisition, Daytona configuration, and dispatch server-only.
- Extend evidence redaction and secret scanning when new formats are added.

### Operator and contributor workflow

- Keep incident, key rotation, cutover, and release runbooks current.
- Preserve local gate evidence because remote checks are intentionally absent.
- Require an explicit approval record for production promotion or destructive provider operations.

## Wave 2

### Execution safety

- Complete and verify least-privilege outbound policy.
- Prove tenant isolation across agent, run, event, credential, and sandbox access.
- Exercise capacity degradation without exposing credentials or provider internals.

### Contracts and capabilities

- Add harness support only with deterministic event translation and conformance evidence.
- Migrate the generic backend discriminator through a versioned dual-read, single-write process when the contract changes.

### Runner lifecycle

- Retain create, reuse, run, stream, stop, delete, and cleanup evidence.
- Prove operation idempotency and SSE cursor continuity under retries.
- Prove provider ambiguity converges through bounded reconciliation.

### Explainability

- Make queue, admission, cancellation, cleanup, and recovery states visible without exposing tenant or credential data.

### Durability

- Exercise restart and partial-write recovery against release-equivalent PostgreSQL.
- Prove exact attempt fencing and duplicate suppression.

## Later outcome envelopes

### Certify

Retain production-equivalent security, lifecycle, rollback, and recovery evidence with owner approval.

### Platform

Tune fairness, capacity, observability, and provider cost controls from measured behavior.

### Product data

Complete tenant-scoped retention, export, deletion, and audit-safe archive behavior.

### Operations

Rehearse incident response, credential rotation, provider resource inventory, and rollback on a documented cadence.
