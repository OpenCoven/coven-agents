# Security Incident Response

- Status: living document
- Owner: Security & privacy workstream
- Companion to: [Execution threat model](execution-threat-model.md)
- Applies to: every credential in the control plane, the cloud runner, and the
  operator's own machine

This document is for the moment something has already gone wrong. It assumes
you are stressed, possibly alone, and possibly wrong about what happened. Every
runbook is written so it can be followed literally.

## Three rules that decide everything else

**1. Rotate first. Investigate second.** Investigation takes hours and rotation
takes minutes. A rotated credential makes the investigation calm; an
un-rotated one makes it a race. The only exception is when rotating destroys
the evidence you need to know who else is affected — none of the runbooks below
have that property.

**2. Deleting a secret does not un-leak it.** Once a value has been pushed,
logged, screenshotted, or pasted, treat it as permanently public. Removing the
commit changes what is convenient to find, not what is known. `git push
--force` is never a substitute for rotation, and rewriting history *before*
rotating is the classic way to spend an hour and still be compromised.

**3. Announce the blast radius before you know it is small.** Say "a
deployment token may have leaked, rotating now" early. Correcting a
conservative statement later costs nothing; discovering that a quiet incident
was larger than assumed costs trust.

## Severity

| Level | Meaning | Examples | First action |
| --- | --- | --- | --- |
| **S1** | Another tenant's data is reachable | `CREDENTIAL_KEK`, `POSTGRES_URL`, a tenant's harness credential | Rotate immediately, then notify affected tenants |
| **S2** | Our infrastructure is controllable, tenant data is not directly exposed | `RUNNER_SIGNING_KEY`, `AGENT_CONTROL_TOKEN`, `RUNNER_SERVICE_TOKEN`, `AUTH_SECRET` | Rotate immediately |
| **S3** | Cost or availability, no data boundary crossed | endpoint URL known, unauthenticated request flood | Measure, then decide |

An **S1** is the only class that creates an obligation to someone other than
us. When in doubt about which class you are in, treat it as the higher one
until you can prove otherwise.

## Credential inventory

Everything that grants something, where it lives, and what it costs to rotate.

| Secret | Stored in | Grants | Rotation cost |
| --- | --- | --- | --- |
| `CREDENTIAL_KEK` | Vercel | Decryption of every stored tenant credential | **Every tenant must reconnect** |
| `POSTGRES_URL` and the `PG*` family | Vercel (Neon integration) | Full read/write on all tenant data | Brief downtime |
| `AUTH_SECRET` | Vercel | Forging any signed-in session | Everyone is signed out |
| `RUNNER_SIGNING_KEY` / `RUNNER_VERIFY_KEY` | Vercel / Vercel + worker | Minting an identity for any tenant | ≤15 min of failed runs |
| `AGENT_CONTROL_TOKEN` | Vercel + worker | Reaching the worker at all | Seconds of failed runs |
| `RUNNER_SERVICE_TOKEN` | Vercel + worker | Calling the internal credential endpoint | Seconds of failed runs |
| `AUTH_GITHUB_SECRET` | Vercel | Impersonating our OAuth app | Sign-in breaks until updated |
| `STRIPE_SECRET_KEY` | Vercel | Charging and refunding | None |
| `STRIPE_WEBHOOK_SECRET` | Vercel | Forging subscription events | Missed events until updated |
| Tenant harness credential | Encrypted DB row | Acting as that tenant on GitHub | Theirs to rotate, not ours |

Four properties worth internalising before an incident rather than during one:

- **Vercel Sensitive variables are write-only.** `vercel env pull` and the API
  both withhold the value, returning the literal string `[SENSITIVE]`, and the
  dashboard hides it too. Nobody can read it back — not the CLI, not you. You
  cannot check whether a secret matches; you can only set a new one. Plan
  rotations around that.
- **`vercel redeploy` reuses the existing build.** A `NEXT_PUBLIC_*` value is
  inlined at build time, so changing one requires a fresh push, not a
  redeploy. Server-side variables are picked up by a redeploy.
- **Never mark a `NEXT_PUBLIC_*` variable Sensitive.** It buys nothing and
  costs recovery. See below.
- **Visibility is never the default.** `vercel env add` needs `--sensitive` for
  a server-side secret and `--no-sensitive` for a public one, and gets it wrong
  in both directions if you omit it: a secret lands readable, and a public
  variable is refused outright. Pass the flag every time.

### `NEXT_PUBLIC_*` must never be Sensitive

The two properties above combine into a trap.

A `NEXT_PUBLIC_*` value is inlined into the client bundle, so it is served to
every browser that loads the page. Marking it Sensitive therefore protects
nothing: the value is public by construction, and the label only hides it from
the people who are entitled to see it.

What the label *does* do is make the value unrecoverable. It cannot be read
from the CLI, the API, or the dashboard, so the only way to change its
visibility is to delete and re-add it — and the delete destroys the one copy
anybody could still read.

This happened to `NEXT_PUBLIC_CLOUD_RUNNER_URL`, which was Sensitive on Preview
and Non-sensitive on Production. Aligning them meant deleting a value nobody
could read first. It was reconstructible only because `wrangler.jsonc` defines
exactly one worker and no other subdomain resolves, so there was exactly one
value it could have been. A variable without that property would simply have
been lost.

Vercel now rejects the combination outright:

> Environment variables with a public framework prefix (NEXT_PUBLIC) cannot use
> secret visibility on Production or Preview.

Anything still marked that way predates the rule. If you find one:

1. Work out the correct value from a source other than Vercel — the code
   default, the deployed resource, another environment — **before** deleting.
2. `vercel env rm <NAME> <environment> --yes`
3. `printf '%s' "<value>" | vercel env add <NAME> <environment> --no-sensitive`

The `--no-sensitive` flag is required; the add is rejected without it.

If a value turns out to be genuinely unrecoverable, that is the signal it
should never have carried the `NEXT_PUBLIC_` prefix. Rename it to a
server-side variable and read it through an API route instead of leaving a
secret in every visitor's browser.

## First fifteen minutes

1. **Name the secret.** Not "credentials leaked" — which variable, in which
   store. If you cannot name it, treat every secret that appeared in the same
   file or screen as leaked.
2. **Rotate it** using its runbook below.
3. **Prove the old value is dead.** Every runbook has a verification step that
   fails if rotation did not take. Do not skip it: a rotation that silently did
   not apply is worse than none, because it ends the sense of urgency.
4. **Only then** work out how it escaped.

## Runbooks

### `AGENT_CONTROL_TOKEN` — the worker's front door

**Grants.** Reaching the worker at all. It does *not* identify anyone: a
caller still needs an Ed25519 identity minted from a signed-in session, so this
token alone cannot read or start anything.

**Rotate.**

```bash
NEW="$(openssl rand -hex 32)"

# Worker first: the app fails closed while they disagree, which is the safe
# direction. The reverse order leaves the worker accepting the old value.
cd worker && printf '%s' "$NEW" | npx wrangler secret put AGENT_CONTROL_TOKEN

cd .. && npx vercel env rm AGENT_CONTROL_TOKEN production --yes

# `--sensitive` is required, not decorative. Without it the value lands
# readable, and a secret you can read back from the CLI is one that will be
# read back into a terminal, a log, or a screen share.
printf '%s' "$NEW" | npx vercel env add AGENT_CONTROL_TOKEN production --sensitive

# A redeploy is what makes the new value live: setting it changes the stored
# variable, not the running deployment. `vercel ls` is newest-first, so the
# first line is the deployment currently serving production.
LATEST="$(npx vercel ls --yes | head -1)"
npx vercel redeploy "$LATEST"
```

**What breaks.** Runs started between the two updates fail with a 401. Seconds,
and they are retryable.

**Verify.** The old value must be refused:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  https://coven-agents-runner.opencovenagents.workers.dev/api/agents \
  -H "X-Runner-Token: <old value>"
# 401 expected
```

### `RUNNER_SERVICE_TOKEN` — the internal credential endpoint

**Grants.** Calling `/api/internal/credential`, which lends a tenant's harness
credential to a run. Higher consequence than it looks: this is the path a
credential travels.

**Rotate.** Identical shape to the above, in both Vercel and the worker. Same
order, same reason.

**Verify.** `/api/internal/credential` returns 401 for the old value.

### `RUNNER_SIGNING_KEY` and `RUNNER_VERIFY_KEY` — the identity pair

**Grants.** The signing key mints an identity claiming to be *any* tenant.
This is the closest thing to a master key that does not touch the database.

**They are a pair and must change together.** The worker verifies with
`RUNNER_VERIFY_KEY`; the app signs with `RUNNER_SIGNING_KEY`. A mismatch means
every run fails.

```bash
# Generate an Ed25519 pair; export the PKCS8 private key and the SPKI public key
# base64url-encoded, matching what mintRunnerToken and importVerifyKey expect.
node --input-type=module -e '
const { subtle } = crypto;
const pair = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const pkcs8 = await subtle.exportKey("pkcs8", pair.privateKey);
const spki = await subtle.exportKey("spki", pair.publicKey);
console.log("SIGNING", Buffer.from(pkcs8).toString("base64url"));
console.log("VERIFY", Buffer.from(spki).toString("base64url"));
'
```

Set `RUNNER_VERIFY_KEY` on the worker and in Vercel, and `RUNNER_SIGNING_KEY`
in Vercel, then redeploy both.

**What breaks.** Identity tokens live 15 minutes (`TOKEN_LIFETIME_SECONDS`), so
in-flight runs fail until they are re-minted. There is no revocation list —
short expiry *is* the revocation mechanism, which is why the lifetime is short.

### `CREDENTIAL_KEK` — read this before rotating

**Grants.** Unwrapping the per-credential data keys, and therefore every stored
tenant credential. **S1.**

**Rotating it destroys access to every stored credential.** Each row holds a
DEK wrapped with AES-KW under this one KEK; change the KEK and no existing
`wrappedKey` can be unwrapped again. There is no re-wrap path implemented.

So there are two different situations:

- **The KEK leaked.** Rotate anyway. Every tenant must reconnect their harness,
  and you must tell them why. Their *GitHub* credentials should also be treated
  as exposed and revoked on GitHub's side — see the tenant runbook below.
- **The KEK did not leak** and you are rotating on principle. Don't, not until
  a re-wrap migration exists. Write the migration first.

**Verify.** After rotation, `/api/credentials` reports no configured harnesses
for any tenant. If it still reports one, the old KEK is still in use.

### `AUTH_SECRET` — sessions

**Grants.** Forging a signed-in session as anyone, which is a subscriber
session and therefore database access. **S2, bordering S1.**

```bash
npx vercel env rm AUTH_SECRET production --yes
openssl rand -base64 32 | tr -d '\n' | npx vercel env add AUTH_SECRET production --sensitive
```

**What breaks.** Every session is invalidated; everyone signs in again. That is
the desired outcome, not a side effect.

**Verify.** Your own session is signed out on next request. If it is not, the
redeploy did not take.

### `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET`

**Grants.** Impersonating our OAuth application to GitHub users.

Rotate in the GitHub OAuth app settings first (generate a new client secret),
then update Vercel, then redeploy. GitHub allows both secrets to be valid
briefly, so this one has no downtime if done in that order.

### `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`

Roll the key in the Stripe dashboard; Stripe supports overlapping validity, so
create the new one, deploy it, then revoke the old.

The webhook secret is separate and rotating it silently breaks event
verification, which looks like "subscriptions stopped updating" rather than an
error. After rotating, send a test event and confirm `{"received":true}`.

### `POSTGRES_URL` and the Neon variables

**Grants.** Everything. **S1.**

Rotate the role password in the Neon console. The Vercel integration manages
around 18 variables; let it re-sync rather than editing them individually, then
redeploy.

**Verify.** `/ping` still returns 200 and a signed-in `/account` loads. If the
app is up but `/account` errors, some of the family updated and some did not.

### A tenant's harness credential

**It is not ours to rotate.** The tenant authorised a GitHub OAuth token
through device flow, or pasted a PAT.

1. Delete the stored row so no run can use it: the tenant can do this from
   `/account`, or we can remove it directly.
2. Tell them to revoke it at
   `https://github.com/settings/applications` (OAuth) or
   `https://github.com/settings/tokens` (PAT). **Only they can do this.**
3. Tell them what the token could reach — the scopes are
   `read:user,read:org,repo,gist`, which includes their private repositories.

Never rotate one tenant's credential using another's, and never substitute the
owner's own GitHub access to "keep things working". Tenants bring their own
credentials; the owner's are never a fallback.

## Scenario: a secret reached git

Order matters here more than anywhere else.

1. **Rotate it.** Now, before touching history. The value is on GitHub's
   servers, in anyone's clone, and possibly in a fork or an event feed.
2. **Find every place it exists**, including history:

   ```bash
   pnpm secret:scan:history
   ```

   This walks every blob on every branch, not just the current tree. A value
   committed and later deleted is invisible to a working-tree scan and is
   exactly the case that matters.
3. **Decide about history.** Rewriting is optional and comes *after* rotation.
   It is worth doing for a value that is embarrassing or personally
   identifying, and not worth much for a rotated token. If you do rewrite,
   everyone with a clone must re-clone, and any open PR must be rebased.
4. **Ask how it got past the hooks.** `pre-commit` and `pre-push` both scan. If
   neither fired, the pattern is missing — add it to `scripts/secret-scan.ts`
   with a test, so the next one is caught.

Expect `secret:scan:history` to report findings that are **not** leaks: the
redaction tests deliberately contain credential-shaped fixtures. Triage by
looking at the value, not the count. As of writing, every finding in this
repository's history is a fixture, a documentation example, or the
`DUMMY_PASSWORD` constant from the removed password path.

## Scenario: a credential appeared in run evidence

Harness output is redacted by `packages/agent-contracts/src/evidence.ts` before
it is stored or shown, but redaction is pattern-based and therefore never
complete.

1. Treat the credential as leaked and follow the tenant runbook.
2. Add the shape to the redaction patterns *and* to `scripts/secret-scan.ts`.
3. Delete the stored evidence for that run.

A credential shape that redaction misses will also be missed by the secret
scanner, because both are pattern lists. Fixing one without the other leaves
the same hole in a different wall.

## Scenario: the worker endpoint is known and being hammered

The endpoint is not a secret — the browser needs it, so it ships in the client
bundle. Every request without both a valid runner token and a valid identity is
refused with 401, and the error does not distinguish which check failed.

The exposure is **cost**, not access: refused requests still bill as Workers
invocations.

1. Confirm the requests are actually being refused (they should 401).
2. If volume is a problem, add a Cloudflare rate-limiting rule on the worker
   route. Do not respond by rotating `AGENT_CONTROL_TOKEN` — that does not
   reduce request volume, it just breaks your own app.

## Scenario: the operator's machine is compromised

This is the worst case, because it holds `.env.local`, `.dev.vars`, an
authenticated `gh`, an authenticated `vercel`, an authenticated `wrangler`, and
the commit signing key.

Assume every secret in the inventory leaked, and work down the table in
severity order. Additionally:

- Revoke the SSH signing key on GitHub, so commits signed with it stop
  verifying.
- Revoke `gh`, `vercel`, and `wrangler` sessions.
- Rotate from a **different, trusted machine**. Rotating from the compromised
  one hands over the new values too.

## What we deliberately do not do

- **We do not rely on `.gitignore` to keep secrets out of git.** It is a
  default, not a control: `git add -f` ignores it, and it listed
  `.env.production.local` while not listing `.env.production`. The scanner
  refuses every dotenv file by path.
- **We do not print secret values in tooling.** The scanner reports a path, a
  line, and a category, and never the value — an error message is itself a
  place a secret can leak to.
- **We do not treat a passing scan as proof of safety.** Both the scanner and
  the evidence redactor are pattern lists, and a pattern list only knows the
  shapes someone thought of.

## Keeping this document true

The runbooks above are only useful if the commands still work. Two of them have
a cheap rehearsal:

- `pnpm secret:scan:history` — run it periodically. It takes about 30 seconds
  and answers "has anything ever been committed", which is the question every
  leak starts with.
- Rotating `AGENT_CONTROL_TOKEN` is the lowest-cost rotation in the table.
  Doing it deliberately once proves the runbook, the ordering, and the
  verification step, at the cost of a few seconds of failed runs.

`AGENT_CONTROL_TOKEN` has been rotated for real, against a live disclosure: the
token was pasted into a chat transcript inside a copied network trace. The
ordering held, the app stayed up, and the verification step returned the 401 it
promised. Two gaps surfaced only by running it -- the `--sensitive` flag and the
redeploy step -- and both are now written above.

That is the argument for rehearsing the rest. A runbook that has never been
executed is a guess, and the parts that are wrong are exactly the parts nobody
thought to write down.

**A copied network trace is a credential disclosure.** Browser devtools'
"copy as fetch" and HAR exports include every request header, which means the
runner token and session cookies travel with them. Treat pasting one -- into a
chat, an issue, a bug report -- as an S2 and rotate.
