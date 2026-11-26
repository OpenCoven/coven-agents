import "server-only";

import { createHash } from "node:crypto";
import { isCanonicalUuid } from "@opencoven/agent-contracts";

const DAYTONA_SANDBOX_NAME_PREFIX = "coven-agent-";
const DAYTONA_SANDBOX_NAME_DIGEST_LENGTH = 40;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A non-reversible, fixed-length tenant identifier suitable for labels. */
export function daytonaTenantDigest(tenant: string): string {
  return sha256(tenant);
}

/**
 * Daytona sandbox names permit lowercase letters, numbers, and hyphens. The
 * input separator prevents ambiguous tenant/agent pairs from sharing a name.
 */
export function daytonaSandboxName(tenant: string, agentId: string): string {
  return `${DAYTONA_SANDBOX_NAME_PREFIX}${sha256(`${tenant}\0${agentId}`).slice(0, DAYTONA_SANDBOX_NAME_DIGEST_LENGTH)}`;
}

export function daytonaSandboxLabels(
  tenant: string,
  agentId: string
): Readonly<Record<string, string>> {
  return {
    agentId,
    app: "coven-agents",
    tenantDigest: daytonaTenantDigest(tenant),
  };
}

/** Reserved deterministic name for the per-agent session used by Task 7. */
export function daytonaSessionName(tenant: string, agentId: string): string {
  return `${daytonaSandboxName(tenant, agentId)}-session`;
}

const DAYTONA_RUN_ATTEMPT_DIGEST_LENGTH = 40;

function requireRunId(runId: string): string {
  if (!isCanonicalUuid(runId)) {
    throw new Error("Daytona run names require a UUID run id.");
  }
  return runId;
}

function requireAttemptId(attemptId: string): string {
  if (!isCanonicalUuid(attemptId)) {
    throw new Error("Daytona run names require a UUID attempt id.");
  }
  return attemptId;
}

function requireProbeFence(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Daytona probe names require a non-negative ${name}.`);
  }
  return value;
}

/**
 * An attempt owns one short-lived Daytona process session. The digest keeps
 * provider IDs below Daytona's 63-character limit while binding the name to
 * both validated durable UUIDs.
 */
export function daytonaRunSessionName(
  runId: string,
  attemptId: string
): string {
  return `coven-run-${sha256(`${requireRunId(runId)}\0${requireAttemptId(attemptId)}`).slice(0, DAYTONA_RUN_ATTEMPT_DIGEST_LENGTH)}`;
}

/** One exact process session owned by a persisted sandbox warm attempt. */
export function daytonaProbeSessionName(
  agentId: string,
  sandboxGeneration: number,
  warmAttemptVersion: number,
  warmUpdatedAt: Date
): string {
  if (!isCanonicalUuid(agentId)) {
    throw new Error("Daytona probe names require a UUID agent id.");
  }
  const generation = requireProbeFence(sandboxGeneration, "generation");
  const version = requireProbeFence(warmAttemptVersion, "warm attempt version");
  const warmEpoch = warmUpdatedAt.getTime();
  if (!Number.isSafeInteger(warmEpoch) || warmEpoch < 0) {
    throw new Error("Daytona probe names require a valid warm timestamp.");
  }
  return `coven-probe-${sha256(
    `${agentId}\0${generation}\0${version}\0${warmEpoch}`
  ).slice(0, DAYTONA_RUN_ATTEMPT_DIGEST_LENGTH)}`;
}

/** The only credential-file path an attempt is permitted to address. */
export function daytonaRunCredentialPath(
  runId: string,
  attemptId: string
): string {
  return `/tmp/${daytonaRunSessionName(runId, attemptId)}.credential`;
}

/** Fresh per-attempt CLI configuration (the path suffix is retained for compatibility) outside caller-controlled workspaces. */
export function daytonaRunConfigDirectory(
  runId: string,
  attemptId: string
): string {
  return `/run/coven-agents/${daytonaRunSessionName(runId, attemptId)}/copilot`;
}

/** Guaranteed-empty restricted working directory outside every workspace. */
export function daytonaRunWorkingDirectory(
  runId: string,
  attemptId: string
): string {
  return `/run/coven-agents/${daytonaRunSessionName(runId, attemptId)}/work`;
}
