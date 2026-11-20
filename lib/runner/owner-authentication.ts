import "server-only";
import { isAllowedIdentity, readBetaGate } from "@/lib/beta";
import { isCanonicalUuid } from "@/lib/session";
import type { RunnerBearerOwnerAuthentication } from "./auth";
import {
  type OwnerCredentialRequest,
  ownerBearerDigest,
} from "./owner-credential";

export async function authenticateBearerOwner(
  request: Request,
  grant?: OwnerCredentialRequest
): Promise<RunnerBearerOwnerAuthentication> {
  const digest = ownerBearerDigest(request.headers.get("authorization"));
  if (
    !digest ||
    !grant ||
    !isCanonicalUuid(
      "agentId" in grant.target ? grant.target.agentId : grant.target.runId
    )
  ) {
    return { kind: "unauthorized" };
  }
  const { findAuthorizedOwnerCredential } = await import(
    "@/lib/db/owner-credentials"
  );
  const record = await findAuthorizedOwnerCredential(
    digest,
    grant.scope,
    grant.target
  );
  if (
    !record ||
    !isAllowedIdentity(
      readBetaGate({
        BETA_ALLOWLIST: process.env.BETA_ALLOWLIST,
        BETA_CAMPAIGN_ENABLED: process.env.BETA_CAMPAIGN_ENABLED,
        BETA_MODE: process.env.BETA_MODE,
      }),
      record.email
    )
  ) {
    return { kind: "unauthorized" };
  }
  return {
    credentialId: record.id,
    kind: "authenticated",
    session: {
      user: {
        authVersion: record.authVersion,
        id: record.userId,
        type: "subscriber",
      },
    },
  };
}
