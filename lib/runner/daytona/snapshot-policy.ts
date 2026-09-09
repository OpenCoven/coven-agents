import type { DaytonaSnapshotConfiguration } from "./config";

export type DaytonaSnapshotProfile = Readonly<{
  cpu?: number;
  disk?: number;
  mem?: number;
  memory?: number;
  name: string;
  state?: string;
}>;

/** Missing metadata is not evidence of an explicitly provisioned profile. */
export function daytonaSnapshotProfileProblems(
  snapshot: DaytonaSnapshotProfile,
  configuration: Pick<
    DaytonaSnapshotConfiguration,
    "resources" | "snapshotName"
  >
): readonly string[] {
  const problems: string[] = [];
  if (snapshot.name !== configuration.snapshotName) {
    problems.push("name");
  }
  if (snapshot.state !== "active") {
    problems.push("state");
  }
  const reported = {
    cpu: snapshot.cpu,
    disk: snapshot.disk,
    memory: snapshot.mem ?? snapshot.memory,
  };
  for (const field of ["cpu", "disk", "memory"] as const) {
    const value = reported[field];
    if (
      !Number.isSafeInteger(value) ||
      value !== configuration.resources[field]
    ) {
      problems.push(field);
    }
  }
  if (
    snapshot.mem !== undefined &&
    snapshot.memory !== undefined &&
    snapshot.mem !== snapshot.memory &&
    !problems.includes("memory")
  ) {
    problems.push("memory");
  }
  return problems;
}
