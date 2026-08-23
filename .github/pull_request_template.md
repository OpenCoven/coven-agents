## What changed

<!-- One or two sentences. -->

## Why

<!-- Link the issue, or explain the motivation. -->

## Verification

- [ ] `pnpm check` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test:unit` passes
- [ ] `pnpm hygiene` reports no AT RISK worktrees
- [ ] No commit is unsigned (`git log --pretty='%G?'` shows no `N` or `B`;
      `E` is fine and means a bot commit signed with a key you do not hold)

## Notes

<!-- Anything a reviewer should know. Delete if empty. -->
