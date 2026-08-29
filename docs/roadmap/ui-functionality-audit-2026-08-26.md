# UI and Functionality Audit — 2026-08-26

This audit records the repository-local evidence for the default agent console,
the curated guest demo, and the local Sandbox diagnostic. The original UI
candidate landed as `d63d40a`; evidence was refreshed on 2026-08-27 against
`a8c1976`. It is not a production certification or release approval.

## Scope

- default `/` routing and client hydration;
- signed-out agent-console navigation and account gating;
- signed-out and subscriber account/chat boundaries;
- owner-only Warden discovery and mobile table access;
- phone-width layout at `390 × 844` and keyboard command-palette behavior;
- the public security route;
- login and registration entry paths;
- production builds in default and `IS_DEMO=1` modes; and
- deterministic guest replay in a local production server; and
- an authenticated, Docker-backed local Sandbox diagnostic.

Real GitHub OAuth subscriber, Stripe, deployed Cloudflare Sandbox, deployment,
rollback, and recovery paths were not available in this local environment.

## Findings and remediation

| Finding | Root cause | Remediation | Evidence |
| --- | --- | --- | --- |
| Default and registration routes could stall development hydration while Turbopack consumed a CPU core. | Redirect-only server pages conflicted with cached-navigation validation under `cacheComponents`. | Moved the default and registration redirects into `next.config.ts`, with demo-aware destinations. | Route contract tests, default build, and Playwright root/register coverage. |
| Signed-out console startup issued protected credential and runner-connection requests, producing avoidable `401` errors. | The pre-cutover connection provisioner ran before session state was known. | The later same-origin cutover removed browser connection provisioning entirely; signed-out startup now issues neither legacy runner request. | Browser assertion records no protected request and no console error during root hydration. |
| Signed-out create-agent and settings actions exposed flows that could only fail. | UI actions and account controls did not apply the authentication boundary before writes. | Create actions route to `/login`; settings render a GitHub sign-in gate and skip protected fetches. | Browser coverage exercises sidebar, command palette, and settings. |
| The fixed-width rail clipped the console at phone widths. | Desktop navigation width and header density were retained below `720px`. | Added compact navigation behavior, responsive panel layouts, and an overlay rail. | `390 × 844` browser coverage asserts no horizontal overflow and verifies the expanded rail remains operable. |
| Production builds warned about a missing metadata base and described a retired local backend. | Root metadata had neither a deployment-aware base nor the current cloud-only wording. | Added `APP_ORIGIN`-aware `metadataBase` and cloud-only copy. | Focused metadata tests and warning-free default/demo builds. |
| Local production demo runs requested a Vercel-only analytics endpoint. | Analytics was mounted outside the Vercel deployment environment. | Mount analytics only when `VERCEL=1`. | Focused layout test and a local demo production run with zero browser console errors. |
| Browser tests targeted the retired chatbot root rather than the shipped route boundaries. | The suite predated the agent-console product boundary while `/chat/[id]` remained enabled. | Replaced stale page-object cases with current authentication, console, account, Warden, security, and legacy-chat coverage. | Seventeen Playwright cases pass against both development and local production servers. |
| Direct signed-out entry to `/account` and `/chat/[id]` mounted protected controls and issued protected requests. | Their layouts rendered before enforcing the session/subscriber boundary. | Added fail-closed entry gates so protected children do not mount; the legacy chat leaf also opts out of instant navigation because its layout owns the UI. | Browser cases assert the gates and absence of protected account/chat requests; subscriber fixtures exercise account and chat controls. |
| Warden controls and account columns were clipped on a `390 × 844` viewport. | The header could not wrap and the fixed-width table was inside an overflow-hidden container. | Added mobile header wrapping, responsive search/range controls, and an explicit horizontal table scroller. | Authenticated mobile coverage reaches search, tabs, range controls, and the final account column without page overflow. |
| Signed-out `/admin` returned a streamed 200 status with a not-found UI in production. | The page-level `notFound()` ran after streaming began. | Proxy now returns a pre-render 404 with `no-store`; page and API authorization remain as defense in depth. | Unit and development/production browser coverage assert 404 for both the page and data route. |
| The post-audit rich steps panel had no browser-level interaction proof. | Existing console cases covered signed-out and responsive entry states, not retained-run hydration or SSE-backed step rendering. | Added a subscriber-shaped E2E contract that hydrates a retained run through mocked service boundaries, replays command evidence, and operates the global rich/collapsed toggle. | The development and production suites verify rich body lines are visible by default, disappear on collapse, and expose the expand control. |
| Local Sandbox startup logged `version_mismatch` between SDK `0.12.7` and container `0.7.0`. | `worker/Dockerfile` pinned an older runtime image independently of `worker/package.json`. | Aligned the base image to `cloudflare/sandbox:0.12.7` and added a contract test tying the image tag to the declared SDK version. | The test failed against `0.7.0`, passes against `0.12.7`, and a rebuilt authenticated diagnostic returns `200` with no version mismatch. |

## Fresh evidence

Captured from `main` and `origin/main` at
`a8c197639c599c67132e73b376859dc4d6d48124`, plus the staged documentation
refresh, at `2026-08-27T02:06:28-05:00`.

| Procedure | Result |
| --- | --- |
| `pnpm check` | Passed; 404 files checked with no fixes or warnings. |
| `pnpm typecheck` | Passed for the app and all three workspace packages. |
| `pnpm test:unit` | Passed: 288 + 438 + 38 + 32 + 151 = **947** tests, with zero failures, skips, or todos. |
| `PORT=3128 pnpm exec playwright test --reporter=dot` | Passed: **17/17** current authentication, console, retained-run timeline, account, Warden, chat, and security cases against the development server. |
| `ADMIN_EMAILS=e2e-admin@example.invalid pnpm build` | Passed; Next.js generated **32/32** static pages with no metadata warning. Database migration was skipped because `POSTGRES_URL` was absent. The placeholder allowlist was an audit fixture only. |
| `E2E_PRODUCTION=1 PORT=3129 pnpm exec playwright test --reporter=dot` | Passed: the same **17/17** cases against the local production server. |
| `IS_DEMO=1 pnpm build` | Passed; Next.js generated **32/32** static pages with no metadata warning. Database migration was skipped because `POSTGRES_URL` was absent. |
| Local demo production browser | `/` resolved to `/demo`; replay reached **10/10** sanitized events, exposed the replay control, and emitted zero browser console errors. |
| Local Worker/Sandbox diagnostic | Wrangler local mode returned the expected health capabilities, then an ephemeral signed subscriber claim and local-only deployment gate reached `POST /api/diagnostics/sandbox`: **200**, `exitCode: 0`, `ok: true`, output `coven-agents`. The rebuilt `0.12.7` image emitted no `version_mismatch`. |
| `pnpm roadmap:status check` | Passed: `roadmap status: unchanged`. |
| `pnpm hygiene` | **Failed:** five worktrees, four secondary, and two unrelated `AT RISK` worktrees: `feat/admission-queue-rebased` has one unpushed commit and is not merged; `fix/process-runner` is not on origin and is not merged. `docs/repository-roadmap` is reapable. |

The `AT RISK` worktrees were not modified by this audit.

## Unverified boundaries

- No real GitHub subscriber session or Stripe eligibility transition was
  exercised.
- Docker-backed Worker health and the dedicated one-shot Sandbox diagnostic
  were exercised locally. Full agent create/run/stream/cancel/delete and
  cleanup with a tenant credential were not exercised against a deployed
  Cloudflare environment.
- No production deployment, migration, webhook, tenant-isolation, rollback, or
  recovery rehearsal was performed.
- Chrome DevTools MCP was unavailable, so no retained Core Web Vitals trace or
  numeric LCP, CLS, and INP claim exists. Browser behavior and responsive
  overflow were checked, but this is not performance certification.
- The browser suite uses local development and local production servers. The
  demo replay was also checked against a local production build. None is a
  release-equivalent deployment.

## Disposition

The audited local UI regression set is green. Overall release disposition
remains **no-go** until repository hygiene and the release-equivalent identity,
billing, cloud lifecycle, isolation, observability, rollback, recovery, and
performance evidence are complete.
