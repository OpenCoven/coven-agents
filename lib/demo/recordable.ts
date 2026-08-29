export const DEMO_REPOSITORY = "OpenCoven/demo-workspace";

export interface RecordableOptions {
  allowFailure: boolean;
  backend: "cloud";
  credential: string;
  repository: string;
  status: "completed" | "failed";
}

export function assertRecordable(options: RecordableOptions): void {
  if (options.repository !== DEMO_REPOSITORY) {
    throw new Error(
      "Refusing recording: only the OpenCoven/demo-workspace repository may be published."
    );
  }

  if (!options.credential.trim()) {
    throw new Error(
      "Refusing recording: a nonblank publishing credential is required."
    );
  }

  if (options.status === "failed" && !options.allowFailure) {
    throw new Error(
      "Refusing recording: failed runs require the allow-failure option."
    );
  }
}
