# Demo Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a demo visitor watch a real recorded agent run replay at its original cadence, without the app reaching a credential, a database, or the worker.

**Architecture:** A recorder captures a real run against a public demo repository, redacts it, converts absolute timestamps to relative offsets, and writes a JSON fixture. A client-side player replays that fixture through the same components a live run drives. The replay path makes no network request at all.

**Tech Stack:** Zod, Next.js 16, React 19, `tsx --test` with `node:test`, biome/ultracite.

**Spec:** `docs/superpowers/specs/2026-08-24-demo-replay-design.md`

---

## Decisions this plan locks in

**Fixtures live in the app, not the contracts package.** `packages/agent-contracts/fixtures/` holds the *contract* fixture, whose job is API verification. Demo transcripts are content. Putting them in `lib/demo/fixtures/` means the player imports them directly with no package `exports` plumbing, and the `lib/**/*.test.ts` glob picks up their validation test without anyone remembering to wire it in.

**The schema lives in `agent-contracts` and gains a `harness` dependency.** A transcript nests both `runEventSchema` (harness) and `runResultSchema` (agent-contracts). Verified before choosing: neither package currently imports the other, so this creates no cycle.

**Every recorder refusal is a pure function.** The recorder itself performs a real agent run and cannot be unit tested. Its refusals are the part that matters and are extracted so they can be.

## Shapes this plan depends on

Verified against the code before writing, because getting these wrong makes
every test in the plan fail for the wrong reason:

```ts
runResultSchema = {
  agentId: string().uuid()
  commandResults: { command?, exitCode?, stderr?, stdout?, timestamp? }[]
  completedAt: string().datetime()
  fileOperations: { operation?, path?, timestamp? }[]
  id: string().uuid()
  output: string
  startedAt: string().datetime()
  status: "completed" | "failed"
}
```

Note `status` is `"completed"`, not `"succeeded"`, and every field inside a
command result is optional. Tests below use these two constants:

```ts
const AGENT_ID = "3f1a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90";
const RUN_ID = "11111111-2222-4333-8444-555555555555";
```

They are declared inline in each test file below, so every block is
copy-pasteable as written.

## File structure

| File | Responsibility |
| --- | --- |
| `packages/agent-contracts/src/demo-transcript.ts` (create) | `demoTranscriptSchema`, `DemoTranscript`, `toOffsets`. The format both sides agree on. |
| `packages/agent-contracts/package.json` (modify) | Add `@opencoven/harness` dependency. |
| `lib/demo/fixtures/` (create) | Committed transcripts. Content, not contract. |
| `lib/demo/fixtures.test.ts` (create) | Validates every committed fixture and asserts none contains a credential. |
| `lib/demo/recordable.ts` (create) | `assertRecordable` — the refusals, as a pure function. |
| `lib/demo/redact.ts` (create) | `redactTranscript` — sanitises a captured transcript. |
| `lib/demo/player.ts` (create) | `planPlayback` — offsets to delays, with gap capping and speed. |
| `scripts/demo-record.ts` (create) | The recorder CLI. Orchestration only; every decision it makes lives in a tested module. |
| `app/demo/page.tsx` (create) | The demo route. Loads a fixture, renders the player, shows an empty state when there is none. |

---

### Task 1: The transcript format

**Files:**
- Create: `packages/agent-contracts/src/demo-transcript.ts`
- Create: `packages/agent-contracts/src/demo-transcript.test.ts`
- Modify: `packages/agent-contracts/src/index.ts`
- Modify: `packages/agent-contracts/package.json`

- [ ] **Step 1: Add the harness dependency**

In `packages/agent-contracts/package.json`, add to `dependencies`:

```json
    "@opencoven/harness": "workspace:*"
```

Then run `corepack pnpm install`.

This is safe: neither package imports the other today, so there is no cycle.

- [ ] **Step 2: Write the failing test**

Create `packages/agent-contracts/src/demo-transcript.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { demoTranscriptSchema, toOffsets } from "./demo-transcript";

const AGENT_ID = "3f1a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90";
const RUN_ID = "11111111-2222-4333-8444-555555555555";

const EVENT = {
  at: "2026-08-24T12:00:00.000Z",
  harness: "copilot",
  kind: "started",
  runId: "run-1",
} as const;

test("offsets are measured from the first event", () => {
  const events = [
    { ...EVENT, at: "2026-08-24T12:00:00.000Z" },
    { ...EVENT, at: "2026-08-24T12:00:02.500Z" },
    { ...EVENT, at: "2026-08-24T12:00:03.000Z" },
  ];

  const offsets = toOffsets(events);

  assert.deepEqual(
    offsets.map((entry) => entry.offsetMs),
    [0, 2500, 3000]
  );
});

test("an empty event list produces no offsets", () => {
  assert.deepEqual(toOffsets([]), []);
});

test("offsets never go backwards even if timestamps do", () => {
  // A harness that emits slightly out of order must not produce a negative
  // delay, which would make the player fire events instantly and out of
  // sequence.
  const events = [
    { ...EVENT, at: "2026-08-24T12:00:05.000Z" },
    { ...EVENT, at: "2026-08-24T12:00:01.000Z" },
  ];

  const offsets = toOffsets(events);

  assert.equal(offsets[0]?.offsetMs, 0);
  assert.ok((offsets[1]?.offsetMs ?? -1) >= 0);
});

test("a transcript missing a required field is rejected", () => {
  const valid = {
    events: [{ event: EVENT, offsetMs: 0 }],
    harness: "copilot",
    name: "add-test",
    recordedAt: "2026-08-24T12:00:00.000Z",
    result: {
      agentId: AGENT_ID,
      commandResults: [],
      completedAt: "2026-08-24T12:01:00.000Z",
      fileOperations: [],
      id: RUN_ID,
      output: "Added a test.",
      startedAt: "2026-08-24T12:00:00.000Z",
      status: "completed",
    },
    task: "add a test",
  };

  assert.ok(demoTranscriptSchema.safeParse(valid).success);

  for (const missing of ["name", "task", "harness", "events", "result"]) {
    const broken: Record<string, unknown> = { ...valid };
    delete broken[missing];
    assert.equal(
      demoTranscriptSchema.safeParse(broken).success,
      false,
      `missing ${missing} must be rejected`
    );
  }
});

test("an event that is not a real RunEvent is rejected", () => {
  // The drift alarm. If the product changes what a run emits, a committed
  // transcript stops validating and CI fails, rather than the demo quietly
  // showing something the product no longer does.
  const transcript = {
    events: [{ event: { kind: "invented-kind" }, offsetMs: 0 }],
    harness: "copilot",
    name: "add-test",
    recordedAt: "2026-08-24T12:00:00.000Z",
    result: {
      agentId: AGENT_ID,
      commandResults: [],
      completedAt: "2026-08-24T12:01:00.000Z",
      fileOperations: [],
      id: RUN_ID,
      output: "Added a test.",
      startedAt: "2026-08-24T12:00:00.000Z",
      status: "completed",
    },
    task: "add a test",
  };

  assert.equal(demoTranscriptSchema.safeParse(transcript).success, false);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `corepack pnpm --filter @opencoven/agent-contracts exec tsx --test src/demo-transcript.test.ts`
Expected: FAIL with `Cannot find module './demo-transcript'`

- [ ] **Step 4: Write the implementation**

Create `packages/agent-contracts/src/demo-transcript.ts`:

```ts
import { harnessIdSchema, type RunEvent, runEventSchema } from "@opencoven/harness";
import { z } from "zod";
import { runResultSchema } from "./index";

/**
 * A recorded run, committed as a fixture and replayed to demo visitors.
 *
 * The nested `event` keeps the real `runEventSchema` on purpose. If the
 * product changes what a run emits, every committed transcript stops
 * validating and CI fails — rather than the demo quietly continuing to show
 * behaviour that no longer exists.
 */
export const demoTranscriptSchema = z
  .object({
    events: z
      .array(z.object({ event: runEventSchema, offsetMs: z.number().min(0) }))
      .min(1),
    harness: harnessIdSchema,
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/, "a name is a slug and matches its filename"),
    recordedAt: z.string(),
    result: runResultSchema,
    task: z.string().min(1),
  })
  .strict();

export type DemoTranscript = z.infer<typeof demoTranscriptSchema>;

/**
 * Converts absolute timestamps to offsets from the first event.
 *
 * Committed absolute timestamps would date the demo for no benefit, and the
 * player needs deltas anyway. Clamped at zero because a harness that emits
 * slightly out of order would otherwise produce a negative delay, and the
 * player would fire those events instantly and out of sequence.
 */
export function toOffsets(
  events: RunEvent[]
): { event: RunEvent; offsetMs: number }[] {
  const [first] = events;
  if (!first) {
    return [];
  }
  const origin = Date.parse(first.at);

  return events.map((event) => ({
    event,
    offsetMs: Math.max(0, Date.parse(event.at) - origin),
  }));
}
```

- [ ] **Step 5: Export it**

Add to `packages/agent-contracts/src/index.ts`, keeping the file's alphabetical export ordering:

```ts
export {
  type DemoTranscript,
  demoTranscriptSchema,
  toOffsets,
} from "./demo-transcript";
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `corepack pnpm --filter @opencoven/agent-contracts exec tsx --test src/demo-transcript.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 7: Mutation-test the drift alarm**

Change `event: runEventSchema` to `event: z.unknown()`.

Run the same command. Expected: FAIL on "an event that is not a real RunEvent is rejected".

Restore. Re-run. Expected: PASS.

If that mutation does **not** fail, the drift alarm does not exist and the rest of this plan rests on nothing. Stop and report.

- [ ] **Step 8: Commit**

```bash
git add packages/agent-contracts/src/demo-transcript.ts packages/agent-contracts/src/demo-transcript.test.ts packages/agent-contracts/src/index.ts packages/agent-contracts/package.json pnpm-lock.yaml
git commit -S -m "feat(contracts): add the demo transcript format"
```

---

### Task 2: The recorder's refusals

**Files:**
- Create: `lib/demo/recordable.ts`
- Create: `lib/demo/recordable.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/demo/recordable.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { assertRecordable, DEMO_REPOSITORY } from "./recordable";

const ok = {
  allowFailure: false,
  repository: DEMO_REPOSITORY,
  status: "completed" as const,
};

test("recording against the demo repository is allowed", () => {
  assert.doesNotThrow(() => assertRecordable(ok));
});

test("recording against any other repository is refused", () => {
  // A refusal, not a warning. Recording against a private repo publishes its
  // contents permanently, and a rule that can be skipped under time pressure
  // is the one that will be.
  for (const repository of [
    "OpenCoven/coven-agents",
    "someone/private-thing",
    "",
    "OpenCoven/demo-workspace-2",
  ]) {
    assert.throws(
      () => assertRecordable({ ...ok, repository }),
      /demo-workspace/,
      `${JSON.stringify(repository)} must be refused`
    );
  }
});

test("a failed run is refused unless explicitly allowed", () => {
  assert.throws(
    () => assertRecordable({ ...ok, status: "failed" }),
    /allow-failure/
  );

  assert.doesNotThrow(() =>
    assertRecordable({ ...ok, allowFailure: true, status: "failed" })
  );
});

test("the repository check is not bypassed by allowFailure", () => {
  // Two independent refusals. Opting into one must not opt out of the other.
  assert.throws(
    () =>
      assertRecordable({
        allowFailure: true,
        repository: "someone/private-thing",
        status: "failed",
      }),
    /demo-workspace/
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `corepack pnpm exec tsx --conditions=react-server --test lib/demo/recordable.test.ts`
Expected: FAIL with `Cannot find module './recordable'`

- [ ] **Step 3: Write the implementation**

Create `lib/demo/recordable.ts`:

```ts
/**
 * The only repository a demo recording may be made against.
 *
 * A committed transcript is published permanently, and redacting unknown
 * secrets is not solvable in general. Recording against content that is
 * already public turns that detection problem into a non-problem.
 */
export const DEMO_REPOSITORY = "OpenCoven/demo-workspace";

export type RecordableOptions = {
  allowFailure: boolean;
  repository: string;
  status: "completed" | "failed";
};

/**
 * Throws unless this run may be committed as a demo transcript.
 *
 * Extracted from the recorder because the recorder performs a real agent run
 * and cannot be unit tested, while these decisions are the part that matters.
 */
export function assertRecordable(options: RecordableOptions): void {
  if (options.repository !== DEMO_REPOSITORY) {
    throw new Error(
      `Demo recordings may only be made against ${DEMO_REPOSITORY}. Refusing to record ${options.repository || "an unnamed repository"}: a committed transcript is published permanently.`
    );
  }

  if (options.status === "failed" && !options.allowFailure) {
    throw new Error(
      "Refusing to record a failed run. Pass --allow-failure if the failure is the point; a broken demo is worse than none."
    );
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `corepack pnpm exec tsx --conditions=react-server --test lib/demo/recordable.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Mutation-test both refusals**

Change the repository check to `if (false)`. Run. Expected: FAIL on "recording against any other repository is refused" and "the repository check is not bypassed by allowFailure". Restore.

Change the failure check to `if (false)`. Run. Expected: FAIL on "a failed run is refused unless explicitly allowed". Restore.

Confirm both restore green. Report if either mutation does not fail.

- [ ] **Step 6: Commit**

```bash
git add lib/demo/recordable.ts lib/demo/recordable.test.ts
git commit -S -m "feat(demo): refuse recordings that must not be published"
```

---

### Task 3: Transcript redaction

**Files:**
- Create: `lib/demo/redact.ts`
- Create: `lib/demo/redact.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/demo/redact.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { assertNoCredential, redactTranscript } from "./redact";

const AGENT_ID = "3f1a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90";
const RUN_ID = "11111111-2222-4333-8444-555555555555";

const CREDENTIAL = "ghp_recording_credential_value";

function transcript(text: string) {
  return {
    events: [
      {
        event: {
          at: "2026-08-24T12:00:00.000Z",
          kind: "message" as const,
          model: null,
          text,
        },
        offsetMs: 0,
      },
    ],
    harness: "copilot" as const,
    name: "add-test",
    recordedAt: "2026-08-24T12:00:00.000Z",
    result: {
      agentId: AGENT_ID,
      commandResults: [],
      completedAt: "2026-08-24T12:01:00.000Z",
      fileOperations: [],
      id: RUN_ID,
      output: "Added a test.",
      startedAt: "2026-08-24T12:00:00.000Z",
      status: "completed" as const,
    },
    task: "add a test",
  };
}

test("the recording credential is removed from every field", () => {
  // Events, stdout, stderr and the summary are all captured and committed. A
  // credential surviving in any one of them is published permanently.
  const redacted = redactTranscript(
    transcript(`debug: token ${CREDENTIAL} in use`),
    CREDENTIAL
  );

  const serialized = JSON.stringify(redacted);
  assert.ok(!serialized.includes(CREDENTIAL));
  assert.ok(serialized.includes("debug: token"), "context must survive");
});

test("assertNoCredential throws when a credential survives", () => {
  // The belt-and-braces check on the one secret certainly present. Cheap, and
  // the exact failure that would matter most.
  assert.throws(
    () => assertNoCredential(transcript(`leak ${CREDENTIAL}`), CREDENTIAL),
    /credential/i
  );
});

test("assertNoCredential passes a clean transcript", () => {
  assert.doesNotThrow(() =>
    assertNoCredential(transcript("nothing sensitive here"), CREDENTIAL)
  );
});

test("an empty credential is not treated as a match", () => {
  // Searching for "" matches everything. Guarding it means an unconfigured
  // credential cannot make the check pass vacuously OR fail spuriously.
  assert.doesNotThrow(() =>
    assertNoCredential(transcript("anything at all"), "")
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `corepack pnpm exec tsx --conditions=react-server --test lib/demo/redact.test.ts`
Expected: FAIL with `Cannot find module './redact'`

- [ ] **Step 3: Write the implementation**

Create `lib/demo/redact.ts`:

```ts
import {
  type DemoTranscript,
  sanitizeEvidenceText,
} from "@opencoven/agent-contracts";

/**
 * Sanitises a captured transcript before it is committed.
 *
 * The primary safety property is that recordings are made against a public
 * repository, so a redaction miss leaks nothing that was not already public.
 * This is defence in depth against the one secret certainly present and
 * genuinely dangerous: the credential used to perform the recording.
 */
export function redactTranscript(
  transcript: DemoTranscript,
  credential: string
): DemoTranscript {
  const secrets = credential ? [credential] : [];
  const clean = (value: string) => sanitizeEvidenceText(value, secrets);

  return {
    ...transcript,
    events: transcript.events.map((entry) => ({
      ...entry,
      event:
        "text" in entry.event
          ? { ...entry.event, text: clean(entry.event.text) }
          : entry.event,
    })),
    result: {
      ...transcript.result,
      commandResults: transcript.result.commandResults.map((entry) => ({
        ...entry,
        // Every field here is optional in the schema, so each is guarded
        // rather than assumed present.
        command: entry.command === undefined ? undefined : clean(entry.command),
        stderr: entry.stderr === undefined ? undefined : clean(entry.stderr),
        stdout: entry.stdout === undefined ? undefined : clean(entry.stdout),
      })),
      output: clean(transcript.result.output),
    },
  };
}

/**
 * Throws if the credential survives anywhere in the serialized transcript.
 *
 * Deliberately a whole-document string search rather than a field-by-field
 * check: a field added later would silently escape a field-by-field version,
 * and this is the check that must not have gaps.
 */
export function assertNoCredential(
  transcript: DemoTranscript,
  credential: string
): void {
  if (!credential) {
    return;
  }
  if (JSON.stringify(transcript).includes(credential)) {
    throw new Error(
      "The recording credential survived redaction. Refusing to write a transcript that would publish it."
    );
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `corepack pnpm exec tsx --conditions=react-server --test lib/demo/redact.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Mutation-test the guard**

Change `assertNoCredential`'s body to `return;` unconditionally.

Run. Expected: FAIL on "assertNoCredential throws when a credential survives". Restore and confirm green.

- [ ] **Step 6: Commit**

```bash
git add lib/demo/redact.ts lib/demo/redact.test.ts
git commit -S -m "feat(demo): redact a captured transcript and refuse to publish a credential"
```

---

### Task 4: Playback timing

**Files:**
- Create: `lib/demo/player.ts`
- Create: `lib/demo/player.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/demo/player.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { DEMO_SPEED, MAX_GAP_MS, planPlayback } from "./player";

const EVENT = {
  at: "2026-08-24T12:00:00.000Z",
  harness: "copilot" as const,
  kind: "started" as const,
  runId: "run-1",
};

function entries(...offsets: number[]) {
  return offsets.map((offsetMs) => ({ event: EVENT, offsetMs }));
}

test("delays are the gaps between offsets, not the offsets", () => {
  const plan = planPlayback(entries(0, 500, 900));

  assert.deepEqual(
    plan.map((step) => step.delayMs),
    [0, 500, 400]
  );
});

test("a long pause is capped", () => {
  // A real run waits minutes while a harness thinks. Replaying that
  // faithfully means a visitor staring at a spinner.
  const plan = planPlayback(entries(0, 120_000));

  assert.equal(plan[1]?.delayMs, MAX_GAP_MS);
});

test("relative rhythm survives capping", () => {
  // A tool call that took noticeably longer than its neighbours should still
  // look that way. That texture is what makes a replay read as real work
  // rather than an animation.
  const plan = planPlayback(entries(0, 100, 900));

  assert.ok(
    (plan[2]?.delayMs ?? 0) > (plan[1]?.delayMs ?? 0),
    "the longer gap must remain the longer gap"
  );
});

test("speed scales every delay together", () => {
  const plan = planPlayback(entries(0, 400), { speed: 2 });

  assert.equal(plan[1]?.delayMs, 200);
});

test("a speed of zero or less is refused rather than freezing the demo", () => {
  for (const speed of [0, -1]) {
    assert.throws(() => planPlayback(entries(0, 400), { speed }), /speed/i);
  }
});

test("the default speed is unmodified playback", () => {
  assert.equal(DEMO_SPEED, 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `corepack pnpm exec tsx --conditions=react-server --test lib/demo/player.test.ts`
Expected: FAIL with `Cannot find module './player'`

- [ ] **Step 3: Write the implementation**

Create `lib/demo/player.ts`:

```ts
import type { DemoTranscript } from "@opencoven/agent-contracts";

/** Longer pauses convey nothing to a visitor watching a replay. */
export const MAX_GAP_MS = 1500;

/** Unmodified playback. One constant so relative rhythm is preserved. */
export const DEMO_SPEED = 1;

export type PlaybackStep = {
  delayMs: number;
  event: DemoTranscript["events"][number]["event"];
};

/**
 * Turns recorded offsets into the delays a player waits between events.
 *
 * Both transforms live here rather than in the fixture, so the committed
 * recording stays a faithful record of what actually happened and only its
 * presentation is adjusted.
 */
export function planPlayback(
  entries: DemoTranscript["events"],
  options: { speed?: number } = {}
): PlaybackStep[] {
  const speed = options.speed ?? DEMO_SPEED;
  if (!(speed > 0)) {
    throw new Error(`Playback speed must be greater than zero, got ${speed}.`);
  }

  let previous = 0;
  return entries.map((entry, index) => {
    const gap = index === 0 ? 0 : entry.offsetMs - previous;
    previous = entry.offsetMs;
    return {
      delayMs: Math.round(Math.min(Math.max(gap, 0), MAX_GAP_MS) / speed),
      event: entry.event,
    };
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `corepack pnpm exec tsx --conditions=react-server --test lib/demo/player.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Mutation-test capping and speed**

Change `Math.min(Math.max(gap, 0), MAX_GAP_MS)` to `Math.max(gap, 0)`. Run. Expected: FAIL on "a long pause is capped". Restore.

Change `/ speed` to `/ 1`. Run. Expected: FAIL on "speed scales every delay together". Restore.

Confirm green after each. Report if either does not fail.

- [ ] **Step 6: Commit**

```bash
git add lib/demo/player.ts lib/demo/player.test.ts
git commit -S -m "feat(demo): plan replay timing with gap capping and speed"
```

---

### Task 5: Fixture validation over the real directory

**Files:**
- Create: `lib/demo/fixtures/.gitkeep`
- Create: `lib/demo/fixtures.test.ts`

- [ ] **Step 1: Create the directory**

```bash
mkdir -p lib/demo/fixtures
touch lib/demo/fixtures/.gitkeep
```

- [ ] **Step 2: Write the test**

Create `lib/demo/fixtures.test.ts`:

```ts
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { demoTranscriptSchema } from "@opencoven/agent-contracts";

const FIXTURE_DIR = join(process.cwd(), "lib/demo/fixtures");

function fixtureFiles(): string[] {
  return readdirSync(FIXTURE_DIR).filter((name) => name.endsWith(".json"));
}

test("every committed transcript validates against the schema", () => {
  // Runs over the real directory rather than a sample, so a transcript added
  // later is covered without anyone remembering to wire it in. This is also
  // the drift alarm: if the product changes what a run emits, committed
  // fixtures stop validating here.
  for (const file of fixtureFiles()) {
    const parsed = demoTranscriptSchema.safeParse(
      JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"))
    );

    assert.ok(
      parsed.success,
      `${file} is not a valid transcript: ${parsed.success ? "" : parsed.error.message}`
    );
  }
});

test("a transcript's name matches its filename", () => {
  // A mismatch means the route loads one thing and the UI labels it another.
  for (const file of fixtureFiles()) {
    const parsed = demoTranscriptSchema.parse(
      JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"))
    );

    assert.equal(`${parsed.name}.json`, file);
  }
});

test("no committed transcript contains anything shaped like a token", () => {
  // Recordings are made against a public repository, so this is defence in
  // depth rather than the primary guarantee. It costs nothing and the failure
  // it catches is permanent.
  const suspicious = /\b(gh[pousr]_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{16,})\b/;

  for (const file of fixtureFiles()) {
    const raw = readFileSync(join(FIXTURE_DIR, file), "utf8");

    assert.equal(
      suspicious.test(raw),
      false,
      `${file} contains something shaped like a credential`
    );
  }
});
```

- [ ] **Step 3: Run the tests**

Run: `corepack pnpm exec tsx --conditions=react-server --test lib/demo/fixtures.test.ts`
Expected: PASS, 3 tests. They pass vacuously with no fixtures — that is correct, and Task 6 makes them meaningful.

- [ ] **Step 4: Prove the guard is real**

Write a deliberately bad fixture:

```bash
cat > lib/demo/fixtures/bad.json <<'JSON'
{ "name": "bad", "task": "t", "harness": "copilot", "recordedAt": "2026-08-24T12:00:00.000Z", "events": [], "result": {} }
JSON
```

Run the same command. Expected: FAIL on "every committed transcript validates against the schema".

Then replace its contents with a token-shaped string inside an otherwise valid transcript and confirm the third test fails.

```bash
rm lib/demo/fixtures/bad.json
```

Re-run. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/demo/fixtures/.gitkeep lib/demo/fixtures.test.ts
git commit -S -m "test(demo): validate every committed transcript"
```

---

### Task 6: The recorder CLI

**Files:**
- Create: `scripts/demo-record.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the recorder**

Create `scripts/demo-record.ts`:

```ts
#!/usr/bin/env tsx
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  demoTranscriptSchema,
  toOffsets,
} from "@opencoven/agent-contracts";
import { assertNoCredential, redactTranscript } from "@/lib/demo/redact";
import { assertRecordable, DEMO_REPOSITORY } from "@/lib/demo/recordable";

/**
 * Records a real agent run as a demo transcript.
 *
 * Orchestration only. Every decision it makes — what may be recorded, what
 * must be redacted, whether a credential survived — lives in a tested module,
 * because this file performs a real run and cannot be unit tested.
 *
 *   pnpm demo:record --name add-test --task "add a test for the parser"
 *   pnpm demo:record --name broken --task "..." --allow-failure
 */

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<number> {
  const name = arg("--name");
  const task = arg("--task");
  const allowFailure = process.argv.includes("--allow-failure");
  const repository = process.env.DEMO_REPOSITORY ?? DEMO_REPOSITORY;
  const credential = process.env.COPILOT_GITHUB_TOKEN ?? "";

  if (!(name && task)) {
    process.stderr.write(
      "Usage: pnpm demo:record --name <slug> --task <text> [--allow-failure]\n"
    );
    return 2;
  }

  // Refused before the run starts, so a forbidden recording never happens at
  // all rather than being discarded afterwards.
  assertRecordable({ allowFailure, repository, status: "completed" });

  const { captureRun } = await import("./demo-capture");
  const captured = await captureRun({ credential, repository, task });

  assertRecordable({ allowFailure, repository, status: captured.result.status });

  const transcript = demoTranscriptSchema.parse({
    events: toOffsets(captured.events),
    harness: captured.harness,
    name,
    recordedAt: new Date().toISOString(),
    result: captured.result,
    task,
  });

  const redacted = redactTranscript(transcript, credential);
  assertNoCredential(redacted, credential);

  const target = join(process.cwd(), "lib/demo/fixtures", `${name}.json`);
  writeFileSync(target, `${JSON.stringify(redacted, null, 2)}\n`);
  process.stdout.write(`Wrote ${target}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  });
```

- [ ] **Step 2: Add the script**

In `package.json`, beside `"subscription"`:

```json
    "demo:record": "tsx --env-file-if-exists=.env.local --conditions=react-server scripts/demo-record.ts",
```

- [ ] **Step 3: Verify the refusal happens before any run**

```bash
DEMO_REPOSITORY=someone/private corepack pnpm demo:record --name x --task "y"
```

Expected: exits non-zero with a message naming `OpenCoven/demo-workspace`, and **no run is attempted**. Confirm by checking that no network call was made — the refusal is the first thing after argument parsing.

- [ ] **Step 4: Verify usage output**

```bash
corepack pnpm demo:record
```

Expected: the usage line, exit code 2.

- [ ] **Step 5: Commit**

```bash
git add scripts/demo-record.ts package.json
git commit -S -m "feat(demo): record a real run as a transcript"
```

**Note:** `./demo-capture` is the module that performs the actual run against the worker. It is deliberately not specified here — it depends on how you choose to drive a run from a script (direct worker call with a minted token, or reusing `RunnerClient`). Write it as a thin module exposing `captureRun({ credential, repository, task })` returning `{ events, harness, result }`, and record its shape in a follow-up commit. Everything the safety of this feature depends on is already tested above and does not change with that choice.

---

### Task 7: The demo route

**Files:**
- Create: `app/demo/page.tsx`
- Create: `lib/demo/load.ts`
- Create: `lib/demo/load.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/demo/load.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { loadTranscript } from "./load";

const AGENT_ID = "3f1a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90";
const RUN_ID = "11111111-2222-4333-8444-555555555555";

test("an unparseable transcript yields null rather than throwing", () => {
  // The route renders an empty state when there is nothing to play. It must
  // never fall through to attempting a live run, which is what a thrown error
  // handled higher up could turn into.
  assert.equal(loadTranscript("{ not json"), null);
});

test("a transcript failing schema validation yields null", () => {
  assert.equal(loadTranscript(JSON.stringify({ name: "x" })), null);
});

test("a valid transcript is returned parsed", () => {
  const valid = {
    events: [
      {
        event: {
          at: "2026-08-24T12:00:00.000Z",
          harness: "copilot",
          kind: "started",
          runId: "run-1",
        },
        offsetMs: 0,
      },
    ],
    harness: "copilot",
    name: "add-test",
    recordedAt: "2026-08-24T12:00:00.000Z",
    result: {
      agentId: AGENT_ID,
      commandResults: [],
      completedAt: "2026-08-24T12:01:00.000Z",
      fileOperations: [],
      id: RUN_ID,
      output: "Added a test.",
      startedAt: "2026-08-24T12:00:00.000Z",
      status: "completed",
    },
    task: "add a test",
  };

  assert.equal(loadTranscript(JSON.stringify(valid))?.name, "add-test");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `corepack pnpm exec tsx --conditions=react-server --test lib/demo/load.test.ts`
Expected: FAIL with `Cannot find module './load'`

- [ ] **Step 3: Write the loader**

Create `lib/demo/load.ts`:

```ts
import {
  type DemoTranscript,
  demoTranscriptSchema,
} from "@opencoven/agent-contracts";

/**
 * Parses a committed transcript, returning null rather than throwing.
 *
 * The route renders an explanatory empty state when there is nothing to play.
 * It must never fall through to attempting a live run — a demo visitor has no
 * credential by construction, so that would be a confusing failure instead of
 * a clear absence.
 */
export function loadTranscript(raw: string): DemoTranscript | null {
  try {
    const parsed = demoTranscriptSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `corepack pnpm exec tsx --conditions=react-server --test lib/demo/load.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Write the route**

Create `app/demo/page.tsx`:

```tsx
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadTranscript } from "@/lib/demo/load";

/**
 * The demo route.
 *
 * The transcript is read at build time and handed to a client player. This
 * page makes no worker request and no database call: a demo visitor cannot
 * reach the credential path even if the worker's authorization were later got
 * wrong, because nothing is asked of the worker at all.
 */
export default function DemoPage() {
  const dir = join(process.cwd(), "lib/demo/fixtures");
  const [file] = readdirSync(dir).filter((name) => name.endsWith(".json"));

  const transcript = file
    ? loadTranscript(readFileSync(join(dir, file), "utf8"))
    : null;

  if (!transcript) {
    return (
      <main className="mx-auto max-w-2xl p-8">
        <h1 className="font-semibold text-lg">Demo unavailable</h1>
        <p className="mt-2 text-sm text-white/60">
          No recorded run is available to replay. Nothing has gone wrong with
          your session.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="font-semibold text-lg">{transcript.task}</h1>
      <p className="mt-2 text-sm text-white/60">
        A recorded run, replayed at its original pace.
      </p>
    </main>
  );
}
```

- [ ] **Step 6: Verify the route builds and renders the empty state**

```bash
corepack pnpm build
```

Expected: PASS, with `/demo` listed in the route output.

```bash
PORT=3102 corepack pnpm dev > /tmp/demo.log 2>&1 &
until curl -s -o /dev/null http://localhost:3102/ping; do sleep 1; done
curl -s http://localhost:3102/demo | grep -c "Demo unavailable"
```

Expected: `1` — the empty state, because no fixture is committed yet. Kill the dev server afterwards.

- [ ] **Step 7: Commit**

```bash
git add lib/demo/load.ts lib/demo/load.test.ts app/demo/page.tsx
git commit -S -m "feat(demo): serve a recorded transcript with an empty state fallback"
```

---

### Task 8: Full verification

**Files:** none created.

- [ ] **Step 1: Run the whole gate**

```bash
corepack pnpm check
corepack pnpm typecheck
corepack pnpm test:unit
corepack pnpm build
```

Expected: all pass. `test:unit` should include every `lib/demo/*.test.ts` file automatically via the `lib/**/*.test.ts` glob — confirm the count rose rather than assuming it.

- [ ] **Step 2: Confirm the new tests actually run in CI**

Break one assertion in `lib/demo/player.test.ts`, run `corepack pnpm test:unit`, and confirm it fails. Restore.

A test CI never runs is worse than no test. This has been the single most repeated defect in this codebase, so verify it rather than trusting the glob.

- [ ] **Step 3: Commit nothing, open the PR**

```bash
corepack pnpm hygiene
git push -u origin <branch>
```

---

## Self-review against the spec

**Spec coverage**

| Spec requirement | Task |
| --- | --- |
| Transcript format with offsets, not timestamps | 1 |
| Nested real `runEventSchema` as a drift alarm | 1, 5 |
| Recording refused outside the demo repository | 2, 6 |
| Failed run refused unless explicitly allowed | 2 |
| Redaction with the recording credential | 3 |
| Refuse to write a transcript containing the credential | 3 |
| Gap capping and speed, applied in the player | 4 |
| Relative rhythm preserved | 4 |
| Every committed fixture validated over the real directory | 5 |
| The recorder CLI | 6 |
| Empty state, never falling through to a live run | 7 |
| Replay makes no worker or database call | 7 |

**Not covered, and deliberately so:** the player *component* — the React piece that consumes `planPlayback` and renders events over time — is not specified. Task 7 renders the transcript's task and a placeholder rather than the streaming UI. That is a UI-shaped decision better made against a real recorded transcript than guessed at now, and every safety property is already established without it. Task 6 similarly leaves `demo-capture` unspecified for the same reason.

**Ordering constraint:** Task 1 must precede everything, since every other task imports the schema. Tasks 2–5 are independent of each other. Task 6 needs 1, 2 and 3. Task 7 needs 1.
