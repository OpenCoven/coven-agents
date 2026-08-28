import "server-only";

import { createHash } from "node:crypto";

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

const RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function requireRunId(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error("Daytona run names require a UUID run id.");
  }
  return runId.toLowerCase();
}

/**
 * A run owns one short-lived Daytona process session. Unlike agent sandbox
 * names, this is intentionally directly traceable to the database run UUID.
 */
export function daytonaRunSessionName(runId: string): string {
  return `coven-run-${requireRunId(runId)}`;
}

/** The only credential-file path a run process is permitted to address. */
export function daytonaRunCredentialPath(runId: string): string {
  return `/tmp/${daytonaRunSessionName(runId)}.credential`;
}
