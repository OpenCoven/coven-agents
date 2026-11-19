# Pack draw ledger implementation plan

This is the historical proposal for the original billing branch. Its migration ordering and gate status reflect that checkpoint. Use the current [cutover runbook](../../operations/pack-draw-ledger.md) for runner 0047 followed by billing 0048 and 0049.

**Goal:** Preserve purchased minutes across cap changes and abuse-key rotation in #225/#226, continuing PR #276.

**Approved design:** The owner selected explicit account-keyed draws and authorized coordination of the shared schema and migration metadata. Admission records a per-reservation pack hold; consumption makes it a debit, settlement refunds only that reservation's unused pack allocation, and release or compensation frees the hold. Accounting never reprices historical usage using a later cap or abuse key. Existing account/cap metadata remains for audit.

**Alternatives:** Cap snapshots require a smaller additive migration but retain policy-dependent accounting. The selected ledger requires a new table and lifecycle integration. Historical cap/account facts missing from old rows cannot be inferred safely; migration refuses existing paid obligations with unresolved usage and requires an owner-controlled reconciliation before deployment.

**Constraints:** No production/provider access, credentials, synthetic verified identity, direct entitlement writes for evidence, test weakening, merge, release, or publication. Use the existing branch in an isolated worktree. Preserve other worktrees. Run the narrow test first and all requested local gates. Migration 0044 is already proposed by #276 and #304; retain #276's existing additive migration and append ledger migration 0045. #304 must regenerate its unmerged migration after the chosen integration order; do not mutate its branch.

## Task 1: Reproduce the remaining accounting defects

- [x] Run the existing reservation unit tests as the baseline.
- [x] Add a regression that spends four pack minutes, raises the cap and admits another run in the same period, then changes the next period's cap and asserts that only six of ten purchased minutes remain.
- [x] Add a same-period key-rotation regression proving spent balance and admission cannot reset.
- [x] Strengthen the legacy metadata regression to require a recorded draw to survive missing reservation metadata and rotation, rather than asserting the known defect.
- [x] Run the narrow tests and record the expected assertion failures before implementation.

## Task 2: Implement explicit holds and debits

Files: `lib/db/schema.ts`, `lib/db/migrations/0045_*`, `lib/billing/run-reservations.ts`, `lib/credentials/runner-credential.ts`, and their tests.

- [x] Add `RunPackDraw`, keyed by reservation and stable account ID, storing reserved and current pack minutes with nonnegative/within-reservation checks.
- [x] Replace historical overflow queries with sums of recorded active allocations, and count the current period's account usage independently of its abuse hash.
- [x] Reserve bucket minutes first and record the remaining pack allocation in the same serializable transaction; do not double-charge the current period.
- [x] Update the draw in the settlement transaction; preserve idempotence, compensation, expiry, and discard behavior.
- [x] Add tests for concurrent admission, expiry, compensation, duplicate consumption, and settlement refunds without rewriting another run's draw.
- [x] Add a migration preflight refusing unresolved paid history, with no inferred balance or HMAC fallback.

## Task 3: Verify and prepare reviewable delivery

- [x] Exercise the real SQL adapter and full migration chain in a disposable PostgreSQL database, using the canonical pack credit path and unverified local fixture accounts.
- [x] Run the narrow tests, `pnpm hygiene`, `pnpm check`, `pnpm typecheck`, `pnpm test:unit`, `pnpm build`, and `pnpm db:verify`; retain exact results and first failures.
- [x] Inspect the final diff and run a fresh review if available under the session's delegation rules.
- [ ] Create signed commits only after the signing doctor; retain a sanitized checkpoint with exact head, omissions, migration ordering, deployment reconciliation gate, and rollback.
- [x] Stop at a reviewable candidate and the precise owner publication action, unless publication is separately authorized.

## Verified checkpoint

The reservation baseline passed 37 tests. Three original repro assertions failed before implementation; the review-found missing-audit-metadata admission case also failed before its fix. The final focused run passed 90 tests; real PostgreSQL 16.15 verification passed 27 with zero skips. The migration drift and planning-policy gates passed. Full check, typecheck, unit, build and hygiene remain blocked by the exact conditions recorded in the local sanitized handoff; no new commit or publication occurred. PR #302 now owns the gate repairs at `93c4ecb8f58cb052d6c2449e6d79952124662512`, with its author retaining claim pending review.
