import { pathToFileURL } from "node:url";
import { Daytona } from "@daytona/sdk";
import {
  type DaytonaSnapshotService,
  daytonaClientConfiguration,
  daytonaSnapshotConfiguration,
  provisionDaytonaSnapshot,
  verifyDaytonaSnapshot,
} from "../lib/runner/daytona/image";

export async function runDaytonaSnapshot(
  environment: NodeJS.ProcessEnv = process.env,
  output: Pick<Console, "error" | "log"> = console,
  args: readonly string[] = process.argv.slice(2),
  snapshotService?: DaytonaSnapshotService
): Promise<number> {
  try {
    if (args.length > 1 || (args.length === 1 && args[0] !== "--verify")) {
      throw new Error("Usage: daytona-snapshot.ts [--verify]");
    }
    const configuration = daytonaSnapshotConfiguration(environment);
    const service =
      snapshotService ??
      new Daytona(daytonaClientConfiguration(configuration)).snapshot;
    const snapshot =
      args[0] === "--verify"
        ? await verifyDaytonaSnapshot(configuration, service)
        : await provisionDaytonaSnapshot(configuration, {
            log: output.log,
            snapshot: service,
          });

    output.log(`Daytona snapshot "${snapshot.name}" is active.`);
    return 0;
  } catch {
    output.error(
      "Daytona snapshot provisioning or verification failed. Check configuration, resource policy, and provider availability."
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
