import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  demoTranscriptSchema,
  sanitizeEvidenceText,
} from "@opencoven/agent-contracts";

const fixturesDirectory = path.join(import.meta.dirname, "fixtures");
// secret-scan: allow-next-line -- synthetic escaped-credential fixture
const PROVIDER_CREDENTIAL = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
const PROVENANCE = {
  fixture: "encoded-credential",
  kind: "synthetic-demo",
} as const;
const validTranscript = {
  events: [
    {
      event: {
        id: 1,
        operationId: "53af1a29-4e98-43d6-ac5b-3b9dcba5e730",
        runId: "3a3f2c72-9b1b-47f7-8c83-28d5f94bf4ce",
        type: "accepted",
      },
      offsetMs: 0,
      provenance: PROVENANCE,
    },
  ],
  name: "encoded-credential",
  provenance: PROVENANCE,
  recordedAt: "2026-08-24T19:03:49.798Z",
  result: {
    agentId: "53af1a29-4e98-43d6-ac5b-3b9dcba5e730",
    commandResults: [],
    completedAt: "2026-08-24T19:03:50.798Z",
    fileOperations: [],
    id: "3a3f2c72-9b1b-47f7-8c83-28d5f94bf4ce",
    output: "Demo complete.",
    startedAt: "2026-08-24T19:03:49.798Z",
    status: "completed",
  },
  task: PROVIDER_CREDENTIAL,
};

async function readFixtures() {
  const filenames = (await readdir(fixturesDirectory))
    .filter((filename) => filename.endsWith(".json"))
    .sort();

  return Promise.all(
    filenames.map(async (filename) => {
      const raw = await readFile(
        path.join(fixturesDirectory, filename),
        "utf8"
      );
      return { filename, raw };
    })
  );
}

function assertFixtureSanitized(filename: string, raw: string) {
  assert.equal(
    sanitizeEvidenceText(raw),
    raw,
    `${filename} must not contain sensitive evidence`
  );
  const transcript = demoTranscriptSchema.parse(JSON.parse(raw));
  const canonical = JSON.stringify(transcript);
  assert.equal(
    sanitizeEvidenceText(canonical),
    canonical,
    `${filename} canonical parsed content must not contain sensitive evidence`
  );
}

test("the demo publishes at least one replay fixture", async () => {
  assert.ok(
    (await readFixtures()).length > 0,
    "the demo must not ship with an empty fixture directory"
  );
});

test("every demo fixture is a valid transcript", async () => {
  for (const { filename, raw } of await readFixtures()) {
    assert.doesNotThrow(
      () => demoTranscriptSchema.parse(JSON.parse(raw)),
      `${filename} must match demoTranscriptSchema`
    );
  }
});

test("every demo fixture name matches its filename", async () => {
  for (const { filename, raw } of await readFixtures()) {
    const transcript = demoTranscriptSchema.parse(JSON.parse(raw));
    assert.equal(transcript.name, path.basename(filename, ".json"));
  }
});

test("every demo fixture is already sanitized", async () => {
  for (const { filename, raw } of await readFixtures()) {
    assertFixtureSanitized(filename, raw);
  }
});

test("canonical fixture content detects Unicode-escaped provider credentials", () => {
  const encodedRaw = JSON.stringify(validTranscript).replace(
    "sk-proj-",
    String.raw`\u0073k-proj-`
  );

  assert.doesNotThrow(() => demoTranscriptSchema.parse(JSON.parse(encodedRaw)));
  assert.equal(
    sanitizeEvidenceText(encodedRaw),
    encodedRaw,
    "raw-only sanitization must miss the encoded credential"
  );
  assert.throws(
    () => assertFixtureSanitized("encoded-credential.json", encodedRaw),
    /canonical parsed content/u
  );
});
