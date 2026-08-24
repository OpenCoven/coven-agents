#!/usr/bin/env tsx
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type DemoTranscript,
  demoTranscriptSchema,
  type RunResult,
  sanitizeEvidenceText,
} from "@opencoven/agent-contracts";
import { type ArrivedEvent, toOffsets } from "@/lib/demo/offsets";
import { assertRecordable, DEMO_REPOSITORY } from "@/lib/demo/recordable";
import { demoRecordingSecrets } from "@/lib/demo/recording-secrets";
import { assertNoSecrets, redactTranscript } from "@/lib/demo/redact";

export const USAGE =
  "Usage: pnpm demo:record --name <slug> --task <text> [--allow-failure]\n";

type Capture = (options: { repository: string; task: string }) => Promise<{
  arrivals: ArrivedEvent[];
  result: RunResult;
  secrets?: string[];
}>;

export type RecorderDependencies = {
  cwd: () => string;
  loadCapture: () => Promise<Capture>;
  now: () => Date;
  stderr: (message: string) => void;
  stdout: (message: string) => void;
  writeFile: (path: string, contents: string) => void;
};

const defaultDependencies: RecorderDependencies = {
  cwd: () => process.cwd(),
  loadCapture: async () => (await import("./demo-capture")).captureRun,
  now: () => new Date(),
  stderr: (message) => process.stderr.write(message),
  stdout: (message) => process.stdout.write(message),
  writeFile: writeFileSync,
};

function argument(
  arguments_: readonly string[],
  flag: string
): string | undefined {
  const index = arguments_.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = arguments_[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function safeErrorMessage(error: unknown, secrets: readonly string[]): string {
  if (error instanceof Error && error.name === "ZodError") {
    return "Demo recording data failed schema validation.";
  }
  const message =
    error instanceof Error ? error.message : "Demo recording failed.";
  return sanitizeEvidenceText(message, secrets);
}

function buildTranscript(
  name: string,
  task: string,
  recordedAt: string,
  arrivals: readonly ArrivedEvent[],
  result: RunResult
): DemoTranscript {
  return demoTranscriptSchema.parse({
    events: toOffsets(arrivals),
    name,
    recordedAt,
    result,
    task,
  });
}

export async function runDemoRecorder(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: RecorderDependencies = defaultDependencies
): Promise<number> {
  const name = argument(arguments_, "--name");
  const task = argument(arguments_, "--task");
  if (!(name && task)) {
    dependencies.stderr(USAGE);
    return 2;
  }

  const allowFailure = arguments_.includes("--allow-failure");
  const repository = environment.DEMO_REPOSITORY ?? DEMO_REPOSITORY;
  const credential = environment.DEMO_RECORDING_CREDENTIAL ?? "";
  let secrets = demoRecordingSecrets(environment);

  try {
    assertRecordable({
      allowFailure,
      backend: "cloud",
      credential,
      repository,
      status: "completed",
    });

    const capture = await dependencies.loadCapture();
    const captured = await capture({ repository, task });
    secrets = [...new Set([...secrets, ...(captured.secrets ?? [])])];

    assertRecordable({
      allowFailure,
      backend: "cloud",
      credential,
      repository,
      status: captured.result.status,
    });

    const transcript = buildTranscript(
      name,
      task,
      dependencies.now().toISOString(),
      captured.arrivals,
      captured.result
    );
    const redacted = redactTranscript(transcript, secrets);
    assertNoSecrets(redacted, secrets);
    const publishable = demoTranscriptSchema.parse(redacted);

    const target = join(
      dependencies.cwd(),
      "lib/demo/fixtures",
      `${name}.json`
    );
    dependencies.writeFile(target, `${JSON.stringify(publishable, null, 2)}\n`);
    dependencies.stdout(`Wrote ${target}\n`);
    return 0;
  } catch (error) {
    dependencies.stderr(`${safeErrorMessage(error, secrets)}\n`);
    return 1;
  }
}

const [, entrypoint] = process.argv;
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runDemoRecorder(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
