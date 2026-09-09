import { pathToFileURL } from "node:url";
import { Daytona } from "@daytona/sdk";
import {
  type DaytonaSnapshotService,
  daytonaClientConfiguration,
  daytonaSnapshotConfiguration,
  provisionDaytonaSnapshot,
  sanitizeDaytonaBuildLog,
  verifyDaytonaSnapshot,
} from "../lib/runner/daytona/image";

const MAX_ERROR_DETAIL_CHARACTERS = 180;

export function safeDaytonaSnapshotErrorDetail(
  error: unknown,
  apiKey: string | undefined,
  fallback: string
): string {
  if (!(error instanceof Error)) {
    return fallback;
  }
  const sanitized = (
    apiKey ? sanitizeDaytonaBuildLog(error.message, apiKey) : error.message
  )
    .replace(/\s+/gu, " ")
    .trim();
  return sanitized ? sanitized.slice(0, MAX_ERROR_DETAIL_CHARACTERS) : fallback;
}

export async function runDaytonaSnapshot(
  environment: NodeJS.ProcessEnv = process.env,
  output: Pick<Console, "error" | "log"> = console,
  args: readonly string[] = process.argv.slice(2),
  snapshotService?: DaytonaSnapshotService
): Promise<number> {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--verify")) {
    output.error("Usage: daytona-snapshot.ts [--verify]");
    return 1;
  }

  let configuration: ReturnType<typeof daytonaSnapshotConfiguration>;
  try {
    configuration = daytonaSnapshotConfiguration(environment);
  } catch (error) {
    output.error(
      `Daytona snapshot configuration is invalid: ${safeDaytonaSnapshotErrorDetail(
        error,
        environment.DAYTONA_API_KEY,
        "Review the required Daytona environment variables."
      )}`
    );
    return 1;
  }

  let service: DaytonaSnapshotService;
  try {
    service =
      snapshotService ??
      new Daytona(daytonaClientConfiguration(configuration)).snapshot;
  } catch {
    output.error("Daytona client initialization failed.");
    return 1;
  }

  const operation = args[0] === "--verify" ? "verification" : "provisioning";
  try {
    const snapshot =
      args[0] === "--verify"
        ? await verifyDaytonaSnapshot(configuration, service)
        : await provisionDaytonaSnapshot(configuration, {
            log: output.log,
            snapshot: service,
          });

    output.log(`Daytona snapshot "${snapshot.name}" is active.`);
    return 0;
  } catch (error) {
    output.error(
      `Daytona snapshot ${operation} failed: ${safeDaytonaSnapshotErrorDetail(
        error,
        configuration.apiKey,
        "Check resource policy and provider availability."
      )}`
    );
    return 1;
  }
}

const [, entrypoint] = process.argv;
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runDaytonaSnapshot().then((code) => {
    process.exitCode = code;
  });
}
