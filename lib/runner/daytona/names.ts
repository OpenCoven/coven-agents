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
