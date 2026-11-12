# AGENTS.md — coven-agents

**Read [`CLAUDE.md`](CLAUDE.md).** It is the working guide for every AI agent in this repository, whatever tool runs it: branch naming, worktrees, the hygiene tooling and the checks to run before a PR.

Checks, in order:

```bash
pnpm hygiene
pnpm check
pnpm typecheck
pnpm test:unit
pnpm build
```

## Where things are

- `app/`, `components/`, `lib/`, `packages/`: the application and its packages
- `docs/architecture/`, `docs/security/`, `docs/operations/`, `docs/runbooks/`: how the system is built and run
- `docs/design/`, `docs/proposals/`: design notes and proposals awaiting a decision
- `docs/roadmap/` and `ROADMAP.md`: delivery order
- `docs/superpowers/`: specs and plans written during agent sessions (see its README)

## Issues

- Open issues end with an `Agent prompts` block (marker `<!-- opencoven-agent-prompts:YYYY-MM-DD -->`) holding a long-running goal prompt, a follow-up prompt, a lane and a mode. Read the whole issue, its newest comments and its linked PRs before acting.
- When your work changes an issue's state, update the block's mode and date and leave a checkpoint comment: exact head SHA, commands, results, what is unmet, and the next action or the owner it waits on.
- Dependencies are native blocked-by and sub-issue links. Work for OpenCoven/coven-castles is tracked here under issues titled `(Castles #N)`.
- Production database, Auth.js, Stripe and Daytona secrets are non-exportable by design. Never add a bypass, a synthetic verified user or a direct entitlement write to obtain evidence.
- No merge, release, settings or credential action: stop at a reviewable PR or a precise owner action.
