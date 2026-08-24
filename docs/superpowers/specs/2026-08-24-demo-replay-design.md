# Demo Mode: Recorded Replay

**Status:** design, approved 2026-08-24
**Scope:** spec 2 of 3. Spec 1 (tenant identity and credential isolation) is
merged; spec 3 (subscriptions) is unwritten.

## Why this exists

Spec 1 made a demo visitor safe: a signed `coven-demo` cookie, no database
row, and a run that is refused because a demo tenant has no stored credential
and `requireHarness` fails closed.

Safe, and empty. A demo visitor currently sees an application that will not do
anything, because doing anything requires a harness credential they correctly
do not have. `IS_DEMO=1` today only hides model listings in the chat API and
moves the app to a `/demo` base path. Nothing shows what the product does.

This spec fills that gap without weakening a single guarantee spec 1
established.

### A correction to spec 1, found while writing this

Spec 1 said a demo run would be "refused at the worker on the `plan` claim,
before any credential lookup happens". That is not what shipped:
`worker/src/routes.ts` reads `claims.tenant` and never reads `claims.plan`. A
demo run is still refused — a demo tenant has no stored credential and
`requireHarness` fails closed — but only after an internal credential fetch has
already happened.

Nothing leaks and the outcome is unchanged, so this is not urgent. It matters
because the guarantee as written does not exist, and anything designed on top
of it would be built on something untrue. It is listed under Deferred as its
own change rather than folded into this one.

## Scope

**In:** recording a real agent run, redacting it, committing it as a fixture,
and replaying it to a demo visitor with its original timing.

**Out — and this is a correction to spec 1.** Spec 1 deferred two unrelated
things to "spec 2": fixture replay, and resolving which harness CLIs accept an
injected credential without a `login` step. The second has nothing to do with
demo mode; it is about `packages/harness` and the sandbox. It belongs in its
own spec and is not addressed here.

Also out: any change to what a demo session may do. Spec 1 settled that, and
this spec inherits it unchanged.

## The decision the rest of this rests on

A recorded fixture is committed to a public repository. If a secret survives
redaction it is published, permanently, and rotating it does not un-publish
it.

Redacting unknown secrets is not solvable in general. `sanitizeEvidenceText`
recognises the patterns it knows — bearer tokens, provider key prefixes,
`KEY=value` pairs, and any secret handed to it explicitly. It cannot recognise
a customer's internal hostname, an unusual token format, or a comment
containing something sensitive. Any design that depends on catching everything
is a design that will eventually miss something.

**So the recording is made against a purpose-built public repository.**

`OpenCoven/demo-workspace` is a small, public, synthetic project that exists
only to be the subject of demo recordings. Its contents are already published,
so a redaction miss leaks nothing that was not already public. This turns an
undecidable detection problem into a non-problem.

Redaction still runs, as defence in depth against the one secret that is
genuinely present and genuinely dangerous: the harness credential used to
perform the recording.

The recorder refuses to run against any other repository. Not a warning, not a
default — a refusal, because "record against the demo repo" is a rule, and a
rule that can be skipped under time pressure is the one that will be.

## Architecture

```
Recording (owner, occasionally, deliberately)
  pnpm demo:record --task "..." --name add-test
    ├─ runs a real agent against OpenCoven/demo-workspace
    ├─ refuses if the target repo is anything else
    ├─ captures every RunEvent, the evidence and the summary
    ├─ redacts with sanitizeEvidenceText + the run's own credential
    ├─ rewrites absolute timestamps to relative offsets
    └─ writes fixtures/demo/<name>.json

Replay (every demo visitor)
  /demo
    ├─ loads fixtures/demo/<name>.json as a static import
    ├─ replays events on their recorded cadence
    └─ renders through the same components a real run uses
```

The replay path makes **no network request to the worker and no database
call**. It is a pure client-side player over a static asset. This is not an
optimisation: it means a demo visitor cannot reach the credential path even if
some future change to the worker's authorization were wrong, because nothing
is asked of the worker at all.

## The transcript format

A new `demoTranscriptSchema` in `packages/agent-contracts`:

```
name          slug, matches the filename
task          the mission text shown to the visitor
recordedAt    ISO date, for staleness checks
harness       which CLI produced it
events        [{ offsetMs, event: RunEvent }]
result        RunResult — evidence, file changes, summary
```

**Offsets, not timestamps.** Every `RunEvent` already carries `at`. Committing
absolute timestamps would date the demo visibly and pointlessly, and the
player needs deltas anyway. The recorder converts once; the fixture carries
`offsetMs` from the first event.

The nested `event` keeps the real `runEventSchema`, so a transcript that no
longer matches the live event shape fails to parse. That is the drift alarm:
if the product changes what a run emits, the fixture stops validating and CI
fails, rather than the demo quietly showing something the product no longer
does.

## Replay timing

Real runs take minutes and contain long gaps while a harness thinks. Replaying
faithfully would mean a visitor staring at a spinner.

The player applies two transforms, both in the player rather than baked into
the fixture, so the recording stays a faithful record:

- **Gap capping.** Any interval longer than `MAX_GAP_MS` (1500) is clamped.
  Long pauses convey nothing.
- **Speed multiplier.** A single `DEMO_SPEED` constant, default 1. Everything
  scales together, so relative rhythm is preserved.

Preserving relative rhythm matters. A run where one tool call takes far longer
than the others should still look that way; that texture is what makes it read
as real work rather than an animation.

## What the recorder must refuse

Each of these is a refusal, not a warning:

- a target repository other than `OpenCoven/demo-workspace`
- a run that failed, unless `--allow-failure` is passed explicitly, because a
  broken demo is worse than none
- writing a fixture whose events do not validate against `runEventSchema`
- writing a fixture that still contains the credential used to record it,
  checked by searching the serialized output for it after redaction

The last is the belt-and-braces check on the one secret we know is present. It
is cheap, and it is the exact failure mode that would matter most.

## Failure modes

| Situation | Behaviour |
| --- | --- |
| Fixture missing or unparseable | The demo route renders an explanatory empty state. It never falls through to a live run. |
| Event shape has drifted | The fixture fails schema validation, CI fails, and the demo is not silently wrong. |
| Visitor reloads mid-replay | Replay restarts. There is no server state to resume, by design. |
| Recording captured a failed run | The recorder refuses unless the failure is the point and `--allow-failure` says so. |
| Someone records against a private repo | Refused before the run starts. |

## Testing

The properties worth pinning are the ones whose failure is silent:

- **A committed fixture never contains the recording credential.** Assert
  against the actual committed files, not a synthetic sample. This is the test
  that matters most; everything else is recoverable.
- **Every committed fixture validates** against `demoTranscriptSchema`, which
  transitively validates every event. Run over the real `fixtures/demo`
  directory so a new fixture is covered without anyone remembering to add it.
- **The player reaches no network.** Assert with a `fetch` stub that throws:
  if replay touches the network the test fails loudly rather than the property
  eroding quietly.
- **Gap capping and speed are applied**, and relative ordering survives both.
- **The recorder refuses** each of the four cases above.

Each gets a mutation test. Deleting the guard must fail the suite; a mutation
that silently does not apply is worse than no test, so every mutation
verifies it landed before its result is believed.

## Rollout

1. Create `OpenCoven/demo-workspace`, public, with a small synthetic project.
2. Add `demoTranscriptSchema` and the fixture directory. No behaviour change.
3. Build the recorder. Record one transcript.
4. Build the player behind `IS_DEMO`, so the default deployment is untouched.
5. Point `/demo` at the player.

Steps 1–3 are inert: nothing reads a fixture until step 4.

## Deferred

- **Refusing a demo run on the `plan` claim.** The worker currently ignores
  `claims.plan` entirely, so a demo run reaches the credential fetch before
  being refused for having none. Checking the plan first would make spec 1's
  stated guarantee real, remove a pointless internal call, and shrink the
  surface a demo session touches. Small, and unrelated to replay.
- **Per-harness credential injection.** Spec 1 sent it here; it belongs in its
  own spec, alongside `packages/harness` and the sandbox.
- **Multiple transcripts and a picker.** Ship one. A second is cheap once the
  format exists, and the shape of a picker is a UX question better answered
  with a real demo in front of us.
- **Re-recording cadence.** The schema catches structural drift. Whether a
  transcript still reads as representative is a judgement, not a check.
