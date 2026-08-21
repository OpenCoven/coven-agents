# Agent Runner Contract Drift Prevention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Agent Runner descriptor and fixture drift by using one typed descriptor source and schema-validating all generated fixture content.

**Architecture:** `packages/agent-contracts/contract-descriptor.ts` will own the typed descriptor values, while the package's exported Zod schemas remain the validation boundary. A typed fixture/export module will build owners and representative examples from source values, parse every section through the package schemas, and produce deterministic JSON/SHA artifacts. The existing `.mjs` command will only launch that TypeScript exporter through the repository's installed `tsx` runtime.

**Tech Stack:** TypeScript, Zod, Node test runner, `tsx`, Node crypto/fs APIs, pnpm, Biome/Ultracite.

---

### Task 1: Lock drift prevention with failing tests

**Files:**
- Create: `packages/agent-contracts/src/export-fixture.test.ts`
- Modify: `packages/agent-contracts/src/index.test.ts`

- [ ] Add tests for invalid owners and representative examples, exact descriptor alignment, deterministic serialization, and removal of duplicate descriptor files.
- [ ] Run `pnpm --filter @opencoven/agent-contracts test` and capture the expected red failure before implementation.

### Task 2: Establish the typed descriptor and validated fixture builder

**Files:**
- Create: `packages/agent-contracts/contract-descriptor.ts`
- Create: `packages/agent-contracts/src/export-fixture.ts`
- Modify: `packages/agent-contracts/src/index.ts`
- Delete: `packages/agent-contracts/contract-descriptor.mjs`
- Delete: `packages/agent-contracts/contract-descriptor.d.mts`

- [ ] Move descriptor values into the typed TypeScript source and make the package export the same values.
- [ ] Add exported schemas for descriptor sections needed by fixture validation.
- [ ] Define typed fixture source values and parse owners, health, error, and success examples with the actual exported Zod schemas before returning the fixture.
- [ ] Implement deterministic JSON and SHA generation/checking.
- [ ] Run targeted contract tests and package typecheck for green results.

### Task 3: Convert the command entrypoint to a loader

**Files:**
- Modify: `scripts/export-agent-runner-contract.mjs`
- Regenerate: `packages/agent-contracts/fixtures/agent-runner-v1.json`
- Regenerate: `packages/agent-contracts/fixtures/agent-runner-v1.sha256`

- [ ] Replace duplicate fixture values with a minimal `tsx` loader.
- [ ] Run export and `--check`; verify stale JSON and SHA are detected.

### Task 4: Run repository verification and commit

**Files:**
- Modify any files required only by targeted formatting/lint fixes.

- [ ] Run contract tests/typechecks, local/cloud tests/typechecks, root typecheck/test:unit, contract check, and targeted formatting/lint.
- [ ] Review the diff for preserved routes and absence of HTTP lifecycle implementation.
- [ ] Commit with a conventional message and the required Copilot trailer.
