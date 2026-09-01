import "server-only";

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  DEMO_TRANSCRIPT_LIMITS,
  type DemoTranscript,
  demoTranscriptSchema,
} from "@opencoven/agent-contracts";

const FIXTURES_DIRECTORY = path.join(process.cwd(), "lib/demo/fixtures");

export function loadTranscript(raw: string): DemoTranscript | null {
  if (Buffer.byteLength(raw, "utf8") > DEMO_TRANSCRIPT_LIMITS.maxRawBytes) {
    return null;
  }
  try {
    const parsed = demoTranscriptSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

type LoadDemoTranscriptOptions = {
  fixtures?: Iterable<{ filename: string; raw: string }>;
  selectedName?: string;
};

function selectedFilename(selectedName: string) {
  const filename = selectedName.endsWith(".json")
    ? selectedName
    : `${selectedName}.json`;

  if (
    path.basename(filename) !== filename ||
    !/^[a-z0-9-]+\.json$/u.test(filename)
  ) {
    return null;
  }

  return filename;
}

export function loadDemoTranscript(
  options: LoadDemoTranscriptOptions = {}
): DemoTranscript | null {
  const fixtures = options.fixtures
    ? [...options.fixtures]
    : readCommittedFixtures();
  let filenames = fixtures
    .map(({ filename }) => filename)
    .filter((filename) => filename.endsWith(".json"))
    .sort();

  if (options.selectedName) {
    const selected = selectedFilename(options.selectedName);
    filenames = selected && filenames.includes(selected) ? [selected] : [];
  }

  for (const filename of filenames) {
    const fixture = fixtures.find(
      (candidate) => candidate.filename === filename
    );
    const transcript = fixture ? loadTranscript(fixture.raw) : null;
    if (transcript) {
      return transcript;
    }
  }

  return null;
}

function readCommittedFixtures() {
  let filenames: string[];
  try {
    filenames = readdirSync(FIXTURES_DIRECTORY);
  } catch {
    return [];
  }

  return filenames.flatMap((filename) => {
    try {
      return [
        {
          filename,
          raw: readFileSync(path.join(FIXTURES_DIRECTORY, filename), "utf8"),
        },
      ];
    } catch {
      return [];
    }
  });
}
