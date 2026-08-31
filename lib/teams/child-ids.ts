import { createHash } from "node:crypto";

export type TeamChildRunnerIds = Readonly<{
  operationId: string;
  runId: string;
}>;

function deterministicUuid(scope: string): string {
  const bytes = createHash("sha256")
    .update(scope, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export function teamChildRunnerIds(teamStepId: string): TeamChildRunnerIds {
  return {
    operationId: deterministicUuid(`team-step:${teamStepId}:operation`),
    runId: deterministicUuid(`team-step:${teamStepId}:runner-run`),
  };
}
