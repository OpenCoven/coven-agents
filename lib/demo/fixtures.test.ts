import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  demoTranscriptSchema,
  sanitizeEvidenceText,
} from "@opencoven/agent-contracts";

const fixturesDirectory = path.join(import.meta.dirname, "fixtures");

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
    assert.equal(
      sanitizeEvidenceText(raw),
      raw,
      `${filename} must not contain sensitive evidence`
    );
  }
});
