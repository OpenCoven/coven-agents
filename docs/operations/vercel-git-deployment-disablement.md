# Vercel Git deployment disablement

**Status:** enforced  
**Recorded:** 2026-08-30  
**Owner:** OpenCoven maintainers

## Decision

Automatic Vercel deployments from Git are disabled for every branch. The root
`vercel.json` may contain only the deny-only `git.deploymentEnabled: false`
control without a deployment runbook. The previous reconciliation cron and
`vercel-template.json` provisioning surface are removed.

This record documents the disabled state. It is **not** the deployment runbook
at `docs/runbooks/vercel-deployment.md` and does not authorize restoring Vercel
deployment behavior.

## Reason

The connected Vercel Git integration automatically deployed repository pushes
even after the old deployment files were deleted. A repository-level deny
control is therefore retained so the integration cannot interpret absence of
configuration as permission to deploy.

## Reintroduction gate

Any deployment-enabling `vercel.json` or restored `vercel-template.json` must be
paired with `docs/runbooks/vercel-deployment.md`. That runbook must document:

- ownership;
- external side effects;
- environment variables and secrets;
- scheduled jobs;
- verification; and
- rollback.

`scripts/deployment-documentation-policy.ts` enforces this boundary in CI.

## External control plane

This repository change disables Git-triggered deployments. It does not delete
historical Vercel deployments or disconnect the independently configured
Vercel project. Those account-level actions must be performed in Vercel's
project settings when full retirement is intended.
