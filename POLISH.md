# Console polish — decisions log

- Status: historical decision log
- Last reviewed: 2026-08-31
- Current guidance: [planning registry](docs/roadmap/README.md),
  [current state](docs/roadmap/current-state.md), and
  [implementation sequence](docs/roadmap/implementation-sequence.md)

Working notes for the polishing pass. Each entry is one decision and its
one-sentence defense, per the pass's own constraint.

## The reconciliation that resolved itself

The pass brief describes two surfaces: the `RUNS` console and an `AGENTS`
workspace of floating rounded cards. Surface B is the retired
`agent-console.tsx`, deleted when the run console shipped (`c26815d`); its
screenshots come from the old `copilot/agent-runner-v1-contract` branch, not
from anything deployed. Nothing mounts it. Every "reconcile A with B" item is
therefore resolved by deletion, in the direction the brief prefers: the
surviving surface is the one with RUNS density and mono discipline.

Items from the brief that were already true of the surviving console before
this pass: focus rings (`:focus-visible`, console.css), tabular figures on
ticking values, `aria-label` + `title` on every status dot, the operating
contract as a disclosure with char count, a real ⌘K palette, lowercase mono
machine identifiers sourced from the harness spec.

## Status semantics (brief §8, "the worst offender")

One mapping, enforced in one place (`statusTone` / `agentTone`):

| state       | tone    | motion |
|-------------|---------|--------|
| idle        | dim     | none   |
| queued      | dim     | none   |
| running     | amber   | 1.4s breathing pulse |
| completed   | green   | none   |
| failed      | red     | none   |
| cancelled   | dim     | none   |

The change: idle agents wore the violet accent, which made a never-run agent
read as a third unnamed state. The accent is identity — the brand, the
selected row — never state. The pulse is opacity-only, so
`prefers-reduced-motion` collapses it with everything else.

## Notes become progressive disclosure

The create flow carried three always-open note boxes — read-only enforcement,
sequenced-mode proposal, zero-approval — standing between the person and the
action. All three are now one-line `FinePrint` disclosures, collapsed until
sought. Zero-approval keeps its warning tone and is restated by the composer
at the moment of running, which is where it carries weight. The rail's
empty-runs paragraph shrank to one line. Removed outright: the sidebar
aphorism about profiles not being personalities — decoration, not
information.

## Historical deferred observations

These bullets record what the polishing pass did not change. Use GitHub issues to track any follow-up accepted for delivery.

- Mobile architecture (tab bar, sheets, drawer navigation): a design project
  of its own; the console is desktop-first today and pretending otherwise in
  one pass would produce a squeezed layout, which the brief itself forbids.
- Runtime drawer → reflowing flex sibling at ≥1440px: real, not yet done.
- `Pause and ask` NOT BUILT treatment: the row already says it is not built;
  restyling it is cosmetic and can ride a later tranche.
- Transcript virtualization beyond ~100 steps: no run has produced 100 steps.
