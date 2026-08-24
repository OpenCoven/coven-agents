# Demo Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a demo visitor watch a real recorded agent run replay at its original cadence, without the app reaching a credential, a database, the worker, or an auth endpoint.

**Architecture:** A recorder drives a real run through the cloud worker, records each stream event with the time it arrived, redacts every string, and writes a JSON fixture. A client-side player replays it. The demo route is gated on `IS_DEMO` and mounts no session provider.

**Tech Stack:** Zod, Next.js 16, React 19, `tsx --test` with `node:test`, biome/ultracite.

**Spec:** `docs/superpowers/specs/2026-08-24-demo-replay-design.md`

---

## Revision note

The first draft of this plan was reviewed and had thirteen defects, three of
them design-level. It was rewritten rather than patched, because several
corrections are the reason the current design looks the way it does.

**There are two different `runEventSchema`s.** `@opencoven/harness` exports one
discriminated on `kind`; `@opencoven/agent-contracts` exports another
discriminated on `type`. The first draft nested the harness one, which the
client never sees — the worker streams the contracts shape. Using the contracts
event also removes the need for a `harness` dependency, and with it the
circular import the first draft introduced.

**Contracts events carry `at` as optional.** Offsets cannot be derived from
event timestamps at all. The recorder observes arrival time instead, which is
monotonic by construction — removing the ordering bug the first draft had,
where clamping against the origin rather than the previous offset let
`5s, 10s, 3s` produce `[0, 5000, 0]`. Its test used two events, so it passed.

**The local runner spawns the CLI with `env: process.env`**
(`local-runner/src/index.ts:129`). Recording through it lets unrelated host
credentials reach stdout even though the repository is public, defeating the
spec's central safety argument. The recorder uses the cloud worker only.

**`app/layout.tsx` mounts `SessionProvider`**, which fetches a session on every
route. The first draft claimed the replay path makes no network request; that
was false as designed. The provider moves into the route groups that use it.

**Redaction was field-by-field** and missed tool summaries, error messages,
file paths and the task text — after which the credential check refused the
whole recording rather than redacting it, failing valid runs. It is now a
generic walk over every string.

## Shapes this plan depends on

Verified against the source, because the first draft asserted five field names
that do not exist:

```ts
// @opencoven/agent-contracts
runEventSchema = discriminatedUnion("type", [...])   // at?: datetime, id
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

`status` is `"completed"`, not `"succeeded"`. Every field inside a command
result and a file operation is optional.

## File structure

| File | Responsibility |
| --- | --- |
| `packages/agent-contracts/src/index.ts` (modify) | `demoTranscriptSchema`, defined beside the schemas it composes. Not a new module: importing the barrel from a module the barrel re-exports is a cycle. |
| `lib/demo/offsets.ts` (create) | `toOffsets` — arrival times to monotonic offsets. |
| `lib/demo/recordable.ts` (create) | `assertRecordable` — the refusals. |
| `lib/demo/redact.ts` (create) | `redactTranscript`, `assertNoSecrets` — a generic walk over every string. |
| `lib/demo/player.ts` (create) | `planPlayback` — offsets to delays, gap capping and speed. |
| `lib/demo/load.ts` (create) | `loadTranscript` — parse or null, never throw. |
| `lib/demo/fixtures/` (create) | Committed transcripts. |
| `lib/demo/fixtures.test.ts` (create) | Validates every committed fixture over the real directory. |
| `scripts/demo-record.ts` (create) | The recorder CLI. Orchestration only. |
| `app/demo/page.tsx` (create) | The demo route, gated on `IS_DEMO`. |
| `app/layout.tsx` (modify) | Remove `SessionProvider`. |
| `app/(chat)/layout.tsx`, `app/(auth)/layout.tsx` (modify) | Mount it where sessions are used. |

---

### Task 1: The transcript format

**Files:**
- Modify: `packages/agent-contracts/src/index.ts`
- Create: `packages/agent-contracts/src/demo-transcript.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/agent-contracts/src/demo-transcript.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { demoTranscriptSchema } from "./index";

const AGENT_ID = "3f1a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90";
const RUN_ID = "11111111-2222-4333-8444-555555555555";
const EVENT_ID = "22222222-3333-4444-8555-666666666666";

function transcript(overrides: Record<string, unknown> = {}) {
  return {
    events: [
      {
        event: {
          id: EVENT_ID,
          operationId: RUN_ID,
          runId: RUN_ID,
          type: "accepted",
        },
        offsetMs: 0,
      },
    ],
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
    ...overrides,
  };
}

test("a well-formed transcript parses", () => {
  assert.ok(demoTranscriptSchema.safeParse(transcript()).success);
});

test("a missing required field is rejected", () => {
  for (const missing of ["name", "task", "events", "result", "recordedAt"]) {
    const broken: Record<string, unknown> = transcript();
    delete broken[missing];

    assert.equal(
      demoTranscriptSchema.safeParse(broken).success,
      false,
      `missing ${missing} must be rejected`
    );
  }
});

test("recordedAt must be a real timestamp", () => {
  // Documented as supporting staleness checks. A bare string() would accept
  // "yesterday" and make that impossible.
  for (const recordedAt of ["", "yesterday", "2026-13-45"]) {
    assert.equal(
      demoTranscriptSchema.safeParse(transcript({ recordedAt })).success,
      false,
      `${JSON.stringify(recordedAt)} must be rejected`
    );
  }
});

test("an event that is not a real RunEvent is rejected", () => {
  // The drift alarm. If the product changes what a run emits, committed
  // transcripts stop validating and CI fails, rather than the demo quietly
  // showing behaviour that no longer exists.
  const broken = transcript({
    events: [{ event: { type: "invented-kind" }, offsetMs: 0 }],
  });

  assert.equal(demoTranscriptSchema.safeParse(broken).success, false);
});

test("a name must be a slug, because it must match its filename", () => {
  for (const name of ["Add Test", "add_test", "../escape", ""]) {
    assert.equal(
      demoTranscriptSchema.safeParse(transcript({ name })).success,
      false,
      `${JSON.stringify(name)} must be rejected`
    );
  }
});

test("a negative offset is rejected", () => {
  const broken = transcript({
    events: [
      {
        event: {
          id: EVENT_ID,
          operationId: RUN_ID,
          runId: RUN_ID,
          type: "accepted",
        },
        offsetMs: -1,
      },
    ],
  });

  assert.equal(demoTranscriptSchema.safeParse(broken).success, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `corepack pnpm --filter @opencoven/agent-contracts exec tsx --test src/demo-transcript.test.ts`
Expected: FAIL — `demoTranscriptSchema` is not exported.

- [ ] **Step 3: Add the schema**

In `packages/agent-contracts/src/index.ts`, after `runResultSchema`:

```ts
/**
 * A recorded run, committed as a fixture and replayed to demo visitors.
 *
 * Defined here rather than in its own module on purpose: it composes
 * `runEventSchema` and `runResultSchema`, and a separate module importing this
 * barrel — which would then re-export that module — is a circular import that
 * evaluates the transcript schema before the schemas it is built from.
 *
 * The nested `event` keeps the real `runEventSchema`. If the product changes
 * what a run emits, every committed transcript stops validating and CI fails,
 * rather than the demo continuing to show something that no longer happens.
 */
export const demoTranscriptSchema = z
  .object({
    events: z
      .array(
        z
          .object({ event: runEventSchema, offsetMs: z.number().int().min(0) })
          .strict()
      )
      .min(1),
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/, "a name is a slug and must match its filename"),
    recordedAt: datetimeSchema,
    result: runResultSchema,
    task: z.string().min(1),
  })
  .strict();

export type DemoTranscript = z.infer<typeof demoTranscriptSchema>;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `corepack pnpm --filter @opencoven/agent-contracts exec tsx --test src/demo-transcript.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Mutation-test the drift alarm**

Change `event: runEventSchema` to `event: z.unknown()`.

Run. Expected: FAIL on "an event that is not a real RunEvent is rejected".

Restore. Re-run. Expected: PASS.

If it does not fail, the drift alarm does not exist and the rest of this plan
rests on nothing. Stop and report.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-contracts/src/index.ts packages/agent-contracts/src/demo-transcript.test.ts
git commit -S -m "feat(contracts): add the demo transcript format"
```

---

### Task 2: Monotonic offsets from arrival time

**Files:**
- Create: `lib/demo/offsets.ts`
- Create: `lib/demo/offsets.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/demo/offsets.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { toOffsets } from "./offsets";

const EVENT = { id: "e", type: "status" } as const;

test("offsets are measured from the first arrival", () => {
  const offsets = toOffsets([
    { event: EVENT, receivedAt: 1000 },
    { event: EVENT, receivedAt: 3500 },
    { event: EVENT, receivedAt: 4000 },
  ]);

  assert.deepEqual(
    offsets.map((entry) => entry.offsetMs),
    [0, 2500, 3000]
  );
});

test("an empty list produces no offsets", () => {
  assert.deepEqual(toOffsets([]), []);
});

test("offsets never decrease, even across three out-of-order arrivals", () => {
  // The first version clamped each value against the origin rather than the
  // previous offset, so 5s, 10s, 3s produced [0, 5000, 0] and the player would
  // fire the third event instantly and out of sequence. Two events could not
  // expose that; three can.
  const offsets = toOffsets([
    { event: EVENT, receivedAt: 5000 },
    { event: EVENT, receivedAt: 10_000 },
    { event: EVENT, receivedAt: 3000 },
  ]).map((entry) => entry.offsetMs);

  assert.deepEqual(offsets, [0, 5000, 5000]);

  for (let index = 1; index < offsets.length; index += 1) {
    assert.ok(
      (offsets[index] ?? 0) >= (offsets[index - 1] ?? 0),
      "offsets must be monotonic"
    );
  }
});

test("offsets are integers", () => {
  const offsets = toOffsets([
    { event: EVENT, receivedAt: 0 },
    { event: EVENT, receivedAt: 10.7 },
  ]);

  assert.equal(Number.isInteger(offsets[1]?.offsetMs), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `corepack pnpm exec tsx --conditions=react-server --test lib/demo/offsets.test.ts`
Expected: FAIL with `Cannot find module './offsets'`

- [ ] **Step 3: Write the implementation**

Create `lib/demo/offsets.ts`:

```ts
import type { RunEvent } from "@opencoven/agent-contracts";

export type ArrivedEvent = { event: RunEvent; receivedAt: number };

/**
 * Converts arrival times into offsets from the first event.
 *
 * Arrival time rather than the event's own `at`, because that field is
 * optional on a contracts event and a recorder cannot depend on it. Observed
 * arrival is also what a replay should reproduce: the cadence a client saw.
 *
 * Clamped against the *previous* offset, not the origin. Clamping against the
 * origin leaves the sequence non-monotonic — 5s, 10s, 3s yields [0, 5000, 0] —
 * and the player would fire that third event immediately and out of order.
 */
export function toOffsets(
  arrivals: ArrivedEvent[]
): { event: RunEvent; offsetMs: number }[] {
  const [first] = arrivals;
  if (!first) {
    return [];
  }

  let previous = 0;
  return arrivals.map((arrival) => {
    const offsetMs = Math.max(
      previous,
      Math.round(arrival.receivedAt - first.receivedAt)
    );
    previous = offsetMs;
    return { event: arrival.event, offsetMs };
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `corepack pnpm exec tsx --conditions=react-server --test lib/demo/offsets.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Mutation-test monotonicity**

Drop the `previous` term, leaving `Math.round(arrival.receivedAt - first.receivedAt)`.

Run. Expected: FAIL on "offsets never decrease, even across three out-of-order arrivals".

Restore and confirm green. This mutation is the exact bug the first draft
shipped, so if it does not fail, the test is not doing its job.

- [ ] **Step 6: Commit**

```bash
git add lib/demo/offsets.ts lib/demo/offsets.test.ts
git commit -S -m "feat(demo): derive monotonic offsets from arrival time"
```

---

### Task 3: The recorder's refusals

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
  backend: "cloud" as const,
  credential: "ghp_recording_credential",
  repository: DEMO_REPOSITORY,
  status: "completed" as const,
};

test("recording the demo repository through the cloud worker is allowed", () => {
  assert.doesNotThrow(() => assertRecordable(ok));
});

test("any other repository is refused", () => {
  // A refusal, not a warning. A committed transcript is published
  // permanently, and a rule that can be skipped under time pressure is the one
  // that gets skipped.
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

test("the local runner is refused", () => {
  // local-runner spawns the CLI with `env: process.env`, so unrelated host
  // credentials can reach stdout even when the repository is public. That
  // defeats the reason recording against a public repository is safe at all.
  assert.throws(() => assertRecordable({ ...ok, backend: "local" }), /cloud/i);
});

test("a run with no credential is refused", () => {
  // Redaction can only remove a secret it was given. Recording without knowing
  // which credential was used leaves nothing to check for afterwards.
  for (const credential of ["", "   "]) {
    assert.throws(() => assertRecordable({ ...ok, credential }), /credential/i);
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

test("opting into one refusal does not opt out of the others", () => {
  assert.throws(
    () =>
      assertRecordable({
        ...ok,
        allowFailure: true,
        backend: "local",
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
  backend: "cloud" | "local";
  credential: string;
  repository: string;
  status: "completed" | "failed";
};

/**
 * Throws unless this run may be committed as a demo transcript.
 *
 * Extracted from the recorder because the recorder drives a real run and
 * cannot be unit tested, while these decisions are the part that matters.
 * Checks are ordered most-consequential first, and none short-circuits
 * another.
 */
export function assertRecordable(options: RecordableOptions): void {
  if (options.repository !== DEMO_REPOSITORY) {
    throw new Error(
      `Demo recordings may only be made against ${DEMO_REPOSITORY}. Refusing to record ${options.repository || "an unnamed repository"}: a committed transcript is published permanently.`
    );
  }

  if (options.backend !== "cloud") {
    throw new Error(
      "Demo recordings must run through the cloud worker. The local runner spawns the harness with the host environment, so unrelated credentials can reach captured output even when the repository is public."
    );
  }

  if (!options.credential.trim()) {
    throw new Error(
      "Refusing to record without a known credential. Redaction can only remove a secret it was given, so an unknown one cannot be checked for afterwards."
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
Expected: PASS, 6 tests

- [ ] **Step 5: Mutation-test each refusal**

Replace each condition with `if (false)` in turn:

| Mutation | Must fail |
| --- | --- |
| repository check | "any other repository is refused" and "opting into one refusal does not opt out of the others" |
| backend check | "the local runner is refused" |
| credential check | "a run with no credential is refused" |
| failure check | "a failed run is refused unless explicitly allowed" |

Restore after each. Report any that does not fail.

- [ ] **Step 6: Commit**

```bash
git add lib/demo/recordable.ts lib/demo/recordable.test.ts
git commit -S -m "feat(demo): refuse recordings that must not be published"
```

---

### Task 4: Redaction across every string

**Files:**
- Create: `lib/demo/redact.ts`
- Create: `lib/demo/redact.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/demo/redact.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { assertNoSecrets, redactTranscript } from "./redact";

const AGENT_ID = "3f1a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90";
const RUN_ID = "11111111-2222-4333-8444-555555555555";
const CREDENTIAL = "ghp_recording_credential_value";

function transcript(text: string) {
  return {
    events: [
      { event: { command: text, id: "e1", type: "command" as const }, offsetMs: 0 },
    ],
    name: "add-test",
    recordedAt: "2026-08-24T12:00:00.000Z",
    result: {
      agentId: AGENT_ID,
      commandResults: [
        { command: text, exitCode: 0, stderr: text, stdout: text },
      ],
      completedAt: "2026-08-24T12:01:00.000Z",
      fileOperations: [{ operation: "modify", path: text }],
      id: RUN_ID,
      output: text,
      startedAt: "2026-08-24T12:00:00.000Z",
      status: "completed" as const,
    },
    task: text,
  };
}

test("the credential is removed from every string, wherever it sits", () => {
  // The first version redacted only event variants with a `text` field, so
  // command text, file paths, tool summaries and the task itself kept it — and
  // the credential check then refused the whole recording rather than
  // redacting it, failing valid runs.
  const redacted = redactTranscript(
    transcript(`debug: token ${CREDENTIAL} in use`),
    [CREDENTIAL]
  );

  const serialized = JSON.stringify(redacted);
  assert.ok(!serialized.includes(CREDENTIAL));
  assert.ok(serialized.includes("debug: token"), "context must survive");
});

test("file paths are redacted too", () => {
  const redacted = redactTranscript(transcript(`/tmp/${CREDENTIAL}/x.ts`), [
    CREDENTIAL,
  ]);

  assert.ok(
    !JSON.stringify(redacted.result.fileOperations).includes(CREDENTIAL)
  );
});

test("non-string values are left untouched", () => {
  const redacted = redactTranscript(transcript("clean"), [CREDENTIAL]);

  assert.equal(redacted.result.commandResults[0]?.exitCode, 0);
  assert.equal(redacted.events[0]?.offsetMs, 0);
  assert.equal(redacted.result.status, "completed");
});

test("assertNoSecrets throws when a known secret survives", () => {
  assert.throws(
    () => assertNoSecrets(transcript(`leak ${CREDENTIAL}`), [CREDENTIAL]),
    /secret/i
  );
});

test("assertNoSecrets throws when the sanitiser still finds something", () => {
  // Reuses sanitizeEvidenceText as the detector rather than a second regex. A
  // hand-rolled list drifts from the real one — one missing github_pat_, xox,
  // AKIA or glpat- would report "no tokens" while one sits in the file.
  assert.throws(
    () => assertNoSecrets(transcript("Authorization: Bearer abcdef123456"), []),
    /sanitiser/i
  );
});

test("assertNoSecrets passes a clean transcript", () => {
  assert.doesNotThrow(() => assertNoSecrets(transcript("nothing here"), []));
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
 * Walks a value and sanitises every string it contains.
 *
 * Generic rather than field-by-field, because a field-by-field version misses
 * whatever is added later — the first version missed tool summaries, error
 * messages, file paths and the task text, and the credential check then
 * refused those recordings instead of cleaning them.
 */
function redactDeep<T>(value: T, secrets: string[]): T {
  if (typeof value === "string") {
    return sanitizeEvidenceText(value, secrets) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactDeep(entry, secrets)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactDeep(entry, secrets),
      ])
    ) as T;
  }
  return value;
}

export function redactTranscript(
  transcript: DemoTranscript,
  secrets: string[]
): DemoTranscript {
  return redactDeep(transcript, secrets.filter(Boolean));
}

/**
 * Throws if anything sensitive survives.
 *
 * Two checks. The first is exact: a known secret must not appear anywhere in
 * the serialized document. The second reuses `sanitizeEvidenceText` as the
 * detector — if sanitising the serialized transcript changes it, something the
 * sanitiser recognises is still present. Reusing it rather than writing a
 * second pattern list means this check cannot drift from the real one.
 */
export function assertNoSecrets(
  transcript: DemoTranscript,
  secrets: string[]
): void {
  const serialized = JSON.stringify(transcript);

  for (const secret of secrets.filter(Boolean)) {
    if (serialized.includes(secret)) {
      throw new Error(
        "A known secret survived redaction. Refusing to write a transcript that would publish it."
      );
    }
  }

  if (sanitizeEvidenceText(serialized) !== serialized) {
    throw new Error(
      "The sanitiser still finds something in this transcript. Refusing to write it."
    );
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `corepack pnpm exec tsx --conditions=react-server --test lib/demo/redact.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Mutation-test both guards**

Make `redactDeep` return strings unchanged. Run. Expected: FAIL on the first two tests. Restore.

Make `assertNoSecrets` return immediately. Run. Expected: FAIL on both `assertNoSecrets throws` tests. Restore.

Remove only the sanitiser check, keeping the exact-match loop. Run. Expected: FAIL on "assertNoSecrets throws when the sanitiser still finds something". Restore.

- [ ] **Step 6: Commit**

```bash
git add lib/demo/redact.ts lib/demo/redact.test.ts
git commit -S -m "feat(demo): redact every string and refuse to publish a secret"
```

---

### Task 5: Playback timing

**Files:**
- Create: `lib/demo/player.ts`
- Create: `lib/demo/player.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/demo/player.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { DEMO_SPEED, MAX_GAP_MS, planPlayback } from "./player";

const EVENT = { id: "e", type: "status" } as const;

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
  // A real run waits minutes while a harness thinks. Replaying that faithfully
  // means a visitor staring at a spinner.
  const plan = planPlayback(entries(0, 120_000));

  assert.equal(plan[1]?.delayMs, MAX_GAP_MS);
});

test("relative rhythm survives capping", () => {
  // A tool call that took noticeably longer than its neighbours should still
  // look that way. That texture is what makes a replay read as real work.
  const plan = planPlayback(entries(0, 100, 900));

  assert.ok((plan[2]?.delayMs ?? 0) > (plan[1]?.delayMs ?? 0));
});

test("speed scales every delay together", () => {
  const plan = planPlayback(entries(0, 400), { speed: 2 });

  assert.equal(plan[1]?.delayMs, 200);
});

test("a speed of zero or less is refused rather than freezing the demo", () => {
  for (const speed of [0, -1, Number.NaN]) {
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

/** Longer pauses convey nothing to someone watching a replay. */
export const MAX_GAP_MS = 1500;

/** Unmodified playback. One constant, so relative rhythm is preserved. */
export const DEMO_SPEED = 1;

export type PlaybackStep = {
  delayMs: number;
  event: DemoTranscript["events"][number]["event"];
};

/**
 * Turns recorded offsets into the delays a player waits between events.
 *
 * Both transforms live here rather than in the fixture, so the committed
 * recording stays a faithful record and only its presentation is adjusted.
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

- [ ] **Step 6: Commit**

```bash
git add lib/demo/player.ts lib/demo/player.test.ts
git commit -S -m "feat(demo): plan replay timing with gap capping and speed"
```

---

### Task 6: Fixture directory and validation

**Files:**
- Create: `lib/demo/fixtures/.gitkeep`
- Create: `lib/demo/fixtures.test.ts`

This must precede Task 7: the recorder writes into this directory, and without
it `writeFileSync` fails.

- [ ] **Step 1: Create the directory**

```bash
mkdir -p lib/demo/fixtures && touch lib/demo/fixtures/.gitkeep
```

- [ ] **Step 2: Write the test**

Create `lib/demo/fixtures.test.ts`:

```ts
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  demoTranscriptSchema,
  sanitizeEvidenceText,
} from "@opencoven/agent-contracts";

const FIXTURE_DIR = join(process.cwd(), "lib/demo/fixtures");

function fixtures(): { name: string; raw: string }[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({
      name,
      raw: readFileSync(join(FIXTURE_DIR, name), "utf8"),
    }));
}

test("every committed transcript validates against the schema", () => {
  // Runs over the real directory rather than a sample, so a transcript added
  // later is covered without anyone remembering. Also the drift alarm: if the
  // product changes what a run emits, committed fixtures stop validating here.
  for (const { name, raw } of fixtures()) {
    const parsed = demoTranscriptSchema.safeParse(JSON.parse(raw));

    assert.ok(
      parsed.success,
      `${name} is not a valid transcript: ${parsed.success ? "" : parsed.error.message}`
    );
  }
});

test("a transcript's name matches its filename", () => {
  for (const { name, raw } of fixtures()) {
    assert.equal(
      `${demoTranscriptSchema.parse(JSON.parse(raw)).name}.json`,
      name
    );
  }
});

test("the sanitiser finds nothing in any committed transcript", () => {
  // Reuses the real sanitiser rather than a second pattern list, which would
  // drift: one missing github_pat_, xox, AKIA or glpat- would report "no
  // tokens" while one sits in the file.
  for (const { name, raw } of fixtures()) {
    assert.equal(
      sanitizeEvidenceText(raw),
      raw,
      `${name} contains something the sanitiser recognises`
    );
  }
});
```

- [ ] **Step 3: Run the tests**

Run: `corepack pnpm exec tsx --conditions=react-server --test lib/demo/fixtures.test.ts`
Expected: PASS, 3 tests. They pass vacuously with no fixtures; Step 4 makes that meaningful.

- [ ] **Step 4: Prove each guard is real**

```bash
printf '{"name":"bad"}' > lib/demo/fixtures/bad.json
corepack pnpm exec tsx --conditions=react-server --test lib/demo/fixtures.test.ts
```

Expected: FAIL on schema validation.

```bash
printf '{"x":"Authorization: Bearer abcdef123456"}' > lib/demo/fixtures/bad.json
corepack pnpm exec tsx --conditions=react-server --test lib/demo/fixtures.test.ts
```

Expected: FAIL on the sanitiser test as well as schema validation.

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

### Task 7: The recorder CLI

**Files:**
- Create: `scripts/demo-record.ts`
- Modify: `package.json`

Depends on Tasks 1, 2, 3, 4 and 6.

- [ ] **Step 1: Write the recorder**

Create `scripts/demo-record.ts`:

```ts
#!/usr/bin/env tsx
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { demoTranscriptSchema } from "@opencoven/agent-contracts";
import { toOffsets } from "@/lib/demo/offsets";
import { assertRecordable, DEMO_REPOSITORY } from "@/lib/demo/recordable";
import { assertNoSecrets, redactTranscript } from "@/lib/demo/redact";

/**
 * Records a real agent run as a demo transcript.
 *
 * Orchestration only. Every decision — what may be recorded, what must be
 * redacted, whether a secret survived — lives in a tested module, because this
 * file drives a real run and cannot be unit tested.
 *
 *   pnpm demo:record --name add-test --task "add a test for the parser"
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
  const credential = process.env.DEMO_RECORDING_CREDENTIAL ?? "";

  if (!(name && task)) {
    process.stderr.write(
      "Usage: pnpm demo:record --name <slug> --task <text> [--allow-failure]\n"
    );
    return 2;
  }

  // Refused before anything runs, so a forbidden recording never happens at
  // all rather than being discarded afterwards. `status` is optimistic here
  // and re-checked against the real outcome below.
  assertRecordable({
    allowFailure,
    backend: "cloud",
    credential,
    repository,
    status: "completed",
  });

  const { captureRun } = await import("./demo-capture");
  const captured = await captureRun({ credential, repository, task });

  assertRecordable({
    allowFailure,
    backend: "cloud",
    credential,
    repository,
    status: captured.result.status,
  });

  const transcript = demoTranscriptSchema.parse({
    events: toOffsets(captured.arrivals),
    name,
    recordedAt: new Date().toISOString(),
    result: captured.result,
    task,
  });

  const redacted = redactTranscript(transcript, [credential]);
  assertNoSecrets(redacted, [credential]);

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

- [ ] **Step 3: Verify each refusal fires before any run**

```bash
DEMO_REPOSITORY=someone/private DEMO_RECORDING_CREDENTIAL=x corepack pnpm demo:record --name x --task y
```

Expected: non-zero exit, a message naming `OpenCoven/demo-workspace`, no run attempted.

```bash
corepack pnpm demo:record --name x --task y
```

Expected: refused for a missing credential.

```bash
corepack pnpm demo:record
```

Expected: the usage line, exit code 2.

- [ ] **Step 4: Commit**

```bash
git add scripts/demo-record.ts package.json
git commit -S -m "feat(demo): record a real run as a transcript"
```

**`./demo-capture` is deliberately unspecified.** It drives one run through the
cloud worker and returns `{ arrivals: ArrivedEvent[]; result: RunResult }`,
stamping `receivedAt` as each stream event arrives. Left to implementation
because it depends on how the worker's event stream is consumed from a script,
and because nothing this feature's safety rests on lives in it —
`assertRecordable`, `redactTranscript` and `assertNoSecrets` all run on its
output. Note `RunnerClient` alone is insufficient: it exposes only a final
`RunResult`, with no per-event stream.

---

### Task 8: Move SessionProvider out of the root layout

**Files:**
- Modify: `app/layout.tsx`
- Modify: `app/(chat)/layout.tsx`
- Modify: `app/(auth)/layout.tsx`

`SessionProvider` sits in the root layout, which wraps every route and
initiates a client session fetch. A demo page under it makes an auth network
request even though the page itself calls nothing — contradicting the property
this feature is built on.

- [ ] **Step 1: Remove it from the root layout**

In `app/layout.tsx`, delete the `SessionProvider` import and unwrap its
children, leaving:

```tsx
          <TooltipProvider>{children}</TooltipProvider>
```

- [ ] **Step 2: Add it to each route group that uses a session**

In both `app/(chat)/layout.tsx` and `app/(auth)/layout.tsx`:

```tsx
import { SessionProvider } from "next-auth/react";

// …wrapping whatever the layout already returns:
<SessionProvider
  basePath={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/auth`}
>
  {/* existing content */}
</SessionProvider>
```

- [ ] **Step 3: Verify sessions still work**

```bash
corepack pnpm build
PORT=3103 corepack pnpm dev > /tmp/demo-auth.log 2>&1 &
until curl -s -o /dev/null http://localhost:3103/ping; do sleep 1; done
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3103/login
```

Expected: build passes, `/login` returns 200. Kill the dev server.

- [ ] **Step 4: Commit**

```bash
git add app/layout.tsx "app/(chat)/layout.tsx" "app/(auth)/layout.tsx"
git commit -S -m "refactor(app): mount SessionProvider only where a session is used"
```

---

### Task 9: The demo route

**Files:**
- Create: `lib/demo/load.ts`
- Create: `lib/demo/load.test.ts`
- Create: `app/demo/page.tsx`

- [ ] **Step 1: Write the failing test**

Create `lib/demo/load.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { loadTranscript } from "./load";

const AGENT_ID = "3f1a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90";
const RUN_ID = "11111111-2222-4333-8444-555555555555";

const VALID = JSON.stringify({
  events: [
    {
      event: { id: "e1", operationId: RUN_ID, runId: RUN_ID, type: "accepted" },
      offsetMs: 0,
    },
  ],
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
});

test("unparseable input yields null rather than throwing", () => {
  // The route renders an empty state when there is nothing to play. It must
  // never throw into an error boundary a reader could mistake for the demo
  // being broken rather than absent.
  assert.equal(loadTranscript("{ not json"), null);
});

test("input failing schema validation yields null", () => {
  assert.equal(loadTranscript(JSON.stringify({ name: "x" })), null);
});

test("a valid transcript is returned parsed", () => {
  assert.equal(loadTranscript(VALID)?.name, "add-test");
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
 * A demo visitor has no credential by construction, so falling through to a
 * live run would produce a confusing failure instead of a clear absence.
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

- [ ] **Step 5: Write the route, gated on IS_DEMO**

Create `app/demo/page.tsx`:

```tsx
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { notFound } from "next/navigation";
import { loadTranscript } from "@/lib/demo/load";

/**
 * The demo route.
 *
 * Gated on `IS_DEMO`: without it this is a public route on the default
 * deployment, which the rollout promises it is not.
 *
 * Makes no worker request and no database call, and — since SessionProvider
 * moved into the route groups that need it — no auth request either.
 */
export default function DemoPage() {
  if (process.env.IS_DEMO !== "1") {
    notFound();
  }

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

- [ ] **Step 6: Verify both build modes**

```bash
corepack pnpm build
PORT=3104 corepack pnpm dev > /tmp/demo-off.log 2>&1 &
until curl -s -o /dev/null http://localhost:3104/ping; do sleep 1; done
curl -s -o /dev/null -w 'IS_DEMO unset: %{http_code}\n' http://localhost:3104/demo
kill %1
```

Expected: `404`. The demo is not public on the default deployment.

```bash
IS_DEMO=1 PORT=3105 corepack pnpm dev > /tmp/demo-on.log 2>&1 &
until curl -s -o /dev/null http://localhost:3105/ping; do sleep 1; done
curl -s http://localhost:3105/demo/demo | grep -c "Demo unavailable"
kill %1
```

Expected: `1`. Note the doubled path — `next.config.ts` sets `basePath` to
`/demo` when `IS_DEMO=1`, so `app/demo` is served at `/demo/demo`.

**Decide before shipping** whether the demo deployment keeps that base path. If
it does, move this page so it lands on the base-path root; if it does not, drop
the `basePath` branch in `next.config.ts`. Record the choice here rather than
leaving both. Do not ship `/demo/demo`.

- [ ] **Step 7: Commit**

```bash
git add lib/demo/load.ts lib/demo/load.test.ts app/demo/page.tsx
git commit -S -m "feat(demo): serve a recorded transcript behind IS_DEMO"
```

---

### Task 10: Full verification

- [ ] **Step 1: Run the whole gate**

```bash
corepack pnpm check
corepack pnpm typecheck
corepack pnpm test:unit
corepack pnpm build
```

Expected: all pass, test count risen by roughly 28.

- [ ] **Step 2: Confirm the new tests run in CI**

Break one assertion in `lib/demo/offsets.test.ts`, run `corepack pnpm test:unit`, confirm it fails, restore.

The `lib/**/*.test.ts` glob should pick these up, but a test CI never runs is
the single most repeated defect in this codebase — five occurrences so far.
Verify rather than trusting the glob.

- [ ] **Step 3: Push and open the PR**

```bash
corepack pnpm hygiene
git push -u origin <branch>
```

---

## Self-review against the spec

| Spec requirement | Task |
| --- | --- |
| Transcript format with offsets, not timestamps | 1, 2 |
| Nested real event schema as a drift alarm | 1, 6 |
| Recording refused outside the demo repository | 3, 7 |
| Failed run refused unless explicitly allowed | 3 |
| Redaction with the recording credential | 4 |
| Refuse to write a transcript containing a secret | 4 |
| Gap capping and speed, applied in the player | 5 |
| Relative rhythm preserved | 5 |
| Every committed fixture validated over the real directory | 6 |
| The recorder CLI | 7 |
| Replay makes no worker, database or auth request | 8, 9 |
| Empty state, never falling through to a live run | 9 |
| Behind `IS_DEMO`, default deployment untouched | 9 |

**Not covered, deliberately:** the React player component that consumes
`planPlayback`, and `demo-capture`. Both are better decided against a real
recorded transcript, and every safety property is established without them.

**Ordering:** Task 1 first — everything imports the schema. Tasks 2–6 are
independent. Task 7 needs 1, 2, 3, 4 and 6. Task 9 needs 1 and 8.
