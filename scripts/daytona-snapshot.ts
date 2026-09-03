import { pathToFileURL } from "node:url";
import { Daytona } from "@daytona/sdk";
import {
  daytonaClientConfiguration,
  daytonaSnapshotConfiguration,
  provisionDaytonaSnapshot,
} from "../lib/runner/daytona/image";

export async function runDaytonaSnapshot(
  environment: NodeJS.ProcessEnv = process.env,
  output: Pick<Console, "error" | "log"> = console
): Promise<number> {
  try {
    const configuration = daytonaSnapshotConfiguration(environment);
    const daytona = new Daytona(daytonaClientConfiguration(configuration));
    const snapshot = await provisionDaytonaSnapshot(configuration, {
      environment,
      log: output.log,
      snapshot: daytona.snapshot,
    });

    output.log(`Daytona snapshot "${snapshot.name}" is active.`);
    return 0;
  } catch (error) {
    output.error(
      error instanceof Error
        ? error.message
        : "Daytona snapshot provisioning failed."
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
