# Beads project sync operator guide

## Authority and safety boundary

- The private Beads + DoltHub database is the source of truth.
- OpenCoven Project #10 is generated from that source.
- Sync is one-way: CI reads DoltHub and writes GitHub Project items only.
- Managed Project fields, title, and body are overwritten on every sync.
- Unrelated Project metadata is preserved.
- Sync never archives or deletes items automatically.

## Workflow

The `beads project sync` workflow runs on:

- the daily schedule `17 8 * * *`; and
- `workflow_dispatch`.

It runs only on `refs/heads/main`, uses `permissions: contents: read`, and
expects these job-level environment values:

```bash
BEADS_WORKSPACE="${RUNNER_TEMP}/coven-agents-beads"
COVEN_PROJECT_OWNER=OpenCoven
COVEN_PROJECT_NUMBER=10
DOLT_REMOTE_URL=https://doltremoteapi.dolthub.com/OpenCoven/coven-agents-beads
```

CI does not seed/import Beads data and does not `dolt push`; it restores the
private database read-only and writes only to Project #10. DoltHub credentials
are scoped to the restore step, and `GH_TOKEN` is scoped only to the preview
and apply steps that call GitHub.

## Required secrets and minimum permissions

- `DOLT_REMOTE_USER`
- `DOLT_REMOTE_PASSWORD`
- `GH_TOKEN` locally for `preview` / `apply`, or `secrets.COVEN_PROJECT_TOKEN`
  in GitHub Actions for the same steps

Minimum access:

- DoltHub credentials: read access to `OpenCoven/coven-agents-beads`.
- GitHub token: enough access to read and write organization Project #10.
  Fine-grained PAT, classic PAT, or GitHub App tokens are all acceptable as
  long as they can mutate the Project. No repository write permission is
  required.

## Exact local prerequisites

Use these exact tool families:

- Beads `bd` `1.2.2`
- Dolt `2.x`
- GitHub CLI `gh` `2.98.0`
- Node.js `24.x`
- pnpm `10.x`

Verify them with:

```bash
bd version
dolt version
gh --version
node --version
pnpm --version
```

CI pins `gh` to `2.98.0` and verifies the release tarball SHA-256 before using
it.

Linux amd64 matches CI:

```bash
curl --fail --location --silent --show-error \
  https://github.com/gastownhall/beads/releases/download/v1.2.2/beads_1.2.2_linux_amd64.tar.gz \
  --output beads_1.2.2_linux_amd64.tar.gz
echo "8140098a51d3b81d5548d1c5e6db1a2d9930e5d141efe2a4bff7d079c4d321e8  beads_1.2.2_linux_amd64.tar.gz" | sha256sum --check
tar -xzf beads_1.2.2_linux_amd64.tar.gz
install ./bd "$HOME/.local/bin/bd"
```

## Initialize the private local workspace

Keep the database and seed outside this repository:

```bash
export BEADS_WORKSPACE="$HOME/.local/share/opencoven/coven-agents-beads"
export COVEN_PROJECT_OWNER=OpenCoven
export COVEN_PROJECT_NUMBER=10
export DOLT_REMOTE_URL=https://doltremoteapi.dolthub.com/OpenCoven/coven-agents-beads
export GH_TOKEN=...
export DOLT_REMOTE_USER=...
export DOLT_REMOTE_PASSWORD=...

mkdir -p "$BEADS_WORKSPACE"
if [ ! -d "$BEADS_WORKSPACE/.git" ]; then
  git -C "$BEADS_WORKSPACE" init --quiet
fi
if [ ! -d "$BEADS_WORKSPACE/.beads" ]; then
  bd -C "$BEADS_WORKSPACE" init \
    --non-interactive \
    --prefix coven-agents \
    --remote "$DOLT_REMOTE_URL" \
    --skip-agents \
    --skip-hooks
fi
bd -C "$BEADS_WORKSPACE" dolt remote list
bd -C "$BEADS_WORKSPACE" dolt status
bd -C "$BEADS_WORKSPACE" dolt pull
```

Local commit and backup commands:

```bash
bd -C "$BEADS_WORKSPACE" dolt status
bd -C "$BEADS_WORKSPACE" dolt commit --message "Describe the roadmap change"
bd -C "$BEADS_WORKSPACE" dolt push
```

## Project schema and status mapping

Managed Project fields:

| Project field | Source |
| --- | --- |
| `Bead ID` | `bead.id` |
| `Blocked` | `Yes` when the bead is blocked or has any active blocking dependency, else `No` |
| `Priority` | `P0` / `P1` / `P2` from Beads priority `0` / `1` / `2` |
| `Runner` | `bead.metadata.runner` |
| `Size` | `bead.metadata.size` |
| `Status` | `Done` for closed beads, `In review` when `metadata.projectStatus` is `In review`, `In Progress` for `in_progress`, otherwise `Todo` |
| `Type` | `bead.issue_type` |
| `Workstream` | `bead.metadata.workstream` |

Managed draft bodies start with:

```html
<!-- coven-agents-bead-sync:v1 id=coven-agents-... -->
```

That marker is the reconciliation key. Duplicate markers, malformed markers, or
missing schema fields/options are hard failures.

## Local seed and sync commands

Seed files are private and must stay outside the repository, for example:

```bash
$HOME/.local/share/opencoven/coven-agents-roadmap.beads-private.json
```

Preview/apply the private seed:

```bash
pnpm beads:seed preview \
  "$HOME/.local/share/opencoven/coven-agents-roadmap.beads-private.json"
pnpm beads:seed apply \
  "$HOME/.local/share/opencoven/coven-agents-roadmap.beads-private.json"
```

Preview/apply Project sync:

```bash
pnpm beads:sync preview
pnpm beads:sync apply
```

Seed import is stdin-only: the CLI builds canonical JSONL in memory and sends it
to `bd -C "$BEADS_WORKSPACE" import - --json`. Private titles, descriptions,
acceptance criteria, and metadata must not appear in argv or logs.

## GraphQL batching design

Sync performs:

- one paginated Project snapshot query;
- create mutations batched in groups of `20`;
- follow-up mutation operations batched in groups of `40`;
- at most `2` concurrent mutation requests; and
- a reserved rate-limit floor of `100` remaining points before each mutation group.

For an empty 60-item Project, this reduces traffic to roughly 15 GraphQL calls
instead of roughly 540 one-field-at-a-time calls.

## Privacy rejection rules

Sync and seed fail closed. They reject:

- private keys, tokens, cookies, and auth headers;
- environment-variable assignments with values;
- absolute local paths;
- stdout/stderr markers and log-like command output;
- malformed IDs or unknown enum values; and
- overlong title, description, or acceptance text.

CLI output is intentionally aggregate-only: IDs, counts, mutation totals, and
rate-limit stats. No private roadmap body text should appear in logs.

## Recovery

- **Duplicate or malformed markers:** fix the first line of the affected draft
  item body, then rerun `pnpm beads:sync preview` and `pnpm beads:sync apply`.
- **Missing fields or options:** repair Project #10 so all managed fields and
  expected options exist, then rerun sync.
- **Rate limit reserve or reset:** wait until the reported `resetAt`, then rerun
  `pnpm beads:sync apply`.
- **Partial GraphQL mutation failure:** rerun `pnpm beads:sync apply`. The sync
  is idempotent and does not attempt rollback, archive, or delete.
- **Seed partial rerun:** rerun `pnpm beads:seed apply <private-seed-path>`.
  Exact existing rows no-op; conflicting existing content remains a hard failure
  until repaired intentionally.
- **Orphans:** review the reported orphaned bead IDs. They are left untouched;
  sync is non-destructive.
- **Auth failures:** verify `DOLT_REMOTE_USER`, `DOLT_REMOTE_PASSWORD`, and the
  GitHub Project token before rerunning.

## Verification

Ignore rules:

```bash
git check-ignore .beads/example.db example.beads-private.json
```

Source inventory count:

```bash
bd -C "$BEADS_WORKSPACE" list --all --limit 0 --json | jq 'length'
```

Expected: `60`.

End-to-end verification:

```bash
pnpm beads:sync preview
pnpm beads:sync apply
pnpm beads:sync apply
pnpm beads:sync preview
```

Expected after the second apply:

- `create count: 0`
- `update count: 0`
- `orphaned count: 0`
- `unchanged count: 60`

Managed fields are overwritten on rerun. Unrelated metadata is preserved. No
automatic archive or delete occurs.
