import "server-only";

import {
  type CredentialEnvelopeV2,
  decryptCredential,
  type EnvelopeAadContext,
  encryptCredential,
} from "@/lib/credentials/envelope";
import {
  type CredentialKekRing,
  credentialKekRingFromEnvironment,
} from "@/lib/credentials/key-ring";

const RUNNER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TENANT_PATTERN = /^[A-Za-z0-9_]{1,64}$/u;

export type RunnerAttemptRedactionEnvelope = CredentialEnvelopeV2;

export type RunnerAttemptRedactionScope = Readonly<{
  attemptId: string;
  runId: string;
  tenant: string;
}>;

function assertScope(scope: RunnerAttemptRedactionScope): void {
  if (
    !RUNNER_ID_PATTERN.test(scope.attemptId) ||
    !RUNNER_ID_PATTERN.test(scope.runId) ||
    !TENANT_PATTERN.test(scope.tenant)
  ) {
    throw new Error("Runner attempt redaction scope is invalid.");
  }
}

export function runnerAttemptRedactionAad(
  scope: RunnerAttemptRedactionScope
): EnvelopeAadContext {
  assertScope(scope);
  return {
    attemptId: scope.attemptId,
    kind: "runner_attempt_redaction",
    runId: scope.runId,
    tenant: scope.tenant,
  };
}

/**
 * Encrypts only the exact credential staged for one Daytona attempt. Its AAD
 * prevents a copied envelope from decrypting for a different run, tenant, or
 * retry attempt.
 */
export async function sealRunnerAttemptRedaction(
  input: RunnerAttemptRedactionScope & Readonly<{ credential: string }>,
  ring: CredentialKekRing
): Promise<RunnerAttemptRedactionEnvelope> {
  const { credential, ...scope } = input;
  return await encryptCredential(
    credential,
    ring.current,
    ring.currentVersion,
    runnerAttemptRedactionAad(scope)
  );
}

/** Decrypts an attempt-scoped redaction secret for in-memory log filtering. */
export async function openRunnerAttemptRedaction(
  scope: RunnerAttemptRedactionScope,
  envelope: RunnerAttemptRedactionEnvelope,
  ring: CredentialKekRing
): Promise<string> {
  return await decryptCredential(
    envelope,
    ring.keyFor(envelope.kekVersion),
    runnerAttemptRedactionAad(scope)
  );
}

export async function sealRunnerAttemptRedactionFromEnvironment(
  input: RunnerAttemptRedactionScope & Readonly<{ credential: string }>
): Promise<RunnerAttemptRedactionEnvelope> {
  return await sealRunnerAttemptRedaction(
    input,
    await credentialKekRingFromEnvironment()
  );
}

export async function openRunnerAttemptRedactionFromEnvironment(
  scope: RunnerAttemptRedactionScope,
  envelope: RunnerAttemptRedactionEnvelope
): Promise<string> {
  return await openRunnerAttemptRedaction(
    scope,
    envelope,
    await credentialKekRingFromEnvironment()
  );
}
