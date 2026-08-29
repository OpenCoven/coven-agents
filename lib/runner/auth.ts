import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import type {
  SessionLike,
  SubscriberAccessDecision,
} from "@/lib/auth/subscriber-access";
import type { SubscriberSession } from "@/lib/session";
import type { RunnerPrincipal } from "./types";

export type RunnerSecretEnvironment = Readonly<{
  AGENT_CONTROL_TOKEN?: string;
  CRON_SECRET?: string;
  OPERATOR_DIAGNOSTIC_TOKEN?: string;
  RUNNER_SERVICE_TOKEN?: string;
  [name: string]: string | undefined;
}>;

export type RunnerAuthenticatedSubscriber = Readonly<{
  authVersion: number;
  kind: "allowed";
  principal: RunnerPrincipal;
  session: SubscriberSession;
  userId: string;
}>;

export type RunnerSubscriberAuthorization =
  | RunnerAuthenticatedSubscriber
  | Exclude<SubscriberAccessDecision, { kind: "allowed" }>;

export type RunnerSecretAuthorization =
  | Readonly<{ kind: "allowed" }>
  | Readonly<{ kind: "unauthorized" | "unavailable" }>;

export type RunnerAuth = Readonly<{
  authorizeDiagnostic: (request: Request) => RunnerSecretAuthorization;
  authorizeReconcile: (request: Request) => RunnerSecretAuthorization;
  authorizeSubscriber: () => Promise<RunnerSubscriberAuthorization>;
}>;

export type RunnerAuthDependencies = Readonly<{
  authenticate: () => Promise<SessionLike>;
  authorizeSubscriberAccess: (
    session: SessionLike
  ) => Promise<SubscriberAccessDecision>;
  environment?: RunnerSecretEnvironment;
}>;

function configuredSecret(value: string | undefined): string | null {
  const secret = value?.trim();
  return secret ? secret : null;
}

/**
 * Hash first so every comparison reaches `timingSafeEqual` with same-sized
 * buffers and never exposes a secret's length through a fast mismatch.
 */
export function timingSafeSecretEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function isAliased(
  expected: string,
  candidates: readonly (string | undefined)[]
): boolean {
  return candidates.some((candidate) => {
    const configured = configuredSecret(candidate);
    return configured !== null && timingSafeSecretEqual(expected, configured);
  });
}

/**
 * An operator diagnostic credential must not be interchangeable with a
 * browser-visible or runner-internal credential. Empty configuration is also
 * unavailable instead of silently falling back to another authority.
 */
export function diagnosticSecretFromEnvironment(
  environment: RunnerSecretEnvironment = process.env
): string | null {
  const secret = configuredSecret(environment.OPERATOR_DIAGNOSTIC_TOKEN);
  if (!secret) {
    return null;
  }
  return isAliased(secret, [
    environment.AGENT_CONTROL_TOKEN,
    environment.CRON_SECRET,
    environment.RUNNER_SERVICE_TOKEN,
  ])
    ? null
    : secret;
}

/**
 * Cron has one credential. It is intentionally distinct from diagnostics and
 * all retired service/browser tokens so none can become an implicit fallback.
 */
export function reconcileSecretFromEnvironment(
  environment: RunnerSecretEnvironment = process.env
): string | null {
  const secret = configuredSecret(environment.CRON_SECRET);
  if (!secret) {
    return null;
  }
  return isAliased(secret, [
    environment.AGENT_CONTROL_TOKEN,
    environment.OPERATOR_DIAGNOSTIC_TOKEN,
    environment.RUNNER_SERVICE_TOKEN,
  ])
    ? null
    : secret;
}

function bearerCredential(request: Request): string | null {
  const match = /^Bearer ([^\s]+)$/u.exec(
    request.headers.get("authorization") ?? ""
  );
  return match?.[1] ?? null;
}

function authorizeSecret(
  request: Request,
  expected: string | null
): RunnerSecretAuthorization {
  if (!expected) {
    return { kind: "unavailable" };
  }

  // These are retired bearer channels. Rejecting their presence prevents a
  // request from appearing to be operator-authenticated while it carries an
  // unrelated browser or service authority.
  if (
    request.headers.has("x-runner-token") ||
    request.headers.has("x-service-token")
  ) {
    return { kind: "unauthorized" };
  }

  const credential = bearerCredential(request);
  if (!credential || !timingSafeSecretEqual(credential, expected)) {
    return { kind: "unauthorized" };
  }
  return { kind: "allowed" };
}

export function createRunnerAuth(
  dependencies: RunnerAuthDependencies
): RunnerAuth {
  const environment = dependencies.environment ?? process.env;

  return {
    authorizeDiagnostic: (request) =>
      authorizeSecret(request, diagnosticSecretFromEnvironment(environment)),
    authorizeReconcile: (request) =>
      authorizeSecret(request, reconcileSecretFromEnvironment(environment)),
    authorizeSubscriber: async () => {
      let session: SessionLike;
      try {
        session = await dependencies.authenticate();
      } catch {
        return { kind: "unauthorized" };
      }
      if (!session?.user?.id) {
        return { kind: "unauthorized" };
      }

      let access: SubscriberAccessDecision;
      try {
        access = await dependencies.authorizeSubscriberAccess(session);
      } catch {
        // A failed authority revalidation is never authorization to use a
        // tenant. Model it as the existing fail-closed subscription denial.
        return { kind: "subscription_required" };
      }
      if (access.kind !== "allowed") {
        return access;
      }

      return {
        authVersion: access.authVersion,
        kind: "allowed",
        principal: {
          kind: "subscriber",
          tenant: access.session.tenant,
          userId: access.userId,
        },
        session: access.session,
        userId: access.userId,
      };
    },
  };
}
