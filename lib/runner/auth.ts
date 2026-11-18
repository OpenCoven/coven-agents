import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import type {
  SessionLike,
  SubscriberAccessDecision,
} from "@/lib/auth/subscriber-access";
import type { SubscriberSession } from "@/lib/session";
import type { OwnerCredentialRequest } from "./owner-credential";
import type { RunnerPrincipal } from "./types";

export type RunnerSecretEnvironment = Readonly<{
  CRON_SECRET?: string;
  OPERATOR_DIAGNOSTIC_TOKEN?: string;
  RUNNER_MANUAL_RECONCILE_SECRET?: string;
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

export type RunnerBearerOwnerAuthentication =
  | Readonly<{
      kind: "authenticated";
      session: SessionLike;
      credentialId: string;
    }>
  | Readonly<{ kind: "unauthorized" | "unavailable" }>;

export type RunnerBearerOwnerAuthorization =
  | RunnerSubscriberAuthorization
  | Readonly<{ kind: "unavailable" }>;

export type RunnerAuth = Readonly<{
  /**
   * Authorizes a non-browser owner from a bearer identity token. Absent on a
   * deployment that has not configured one; callers must treat that as
   * unavailable and never fall back to a cookie or an operator secret.
   */
  authorizeBearerOwner?: (
    request: Request,
    grant?: OwnerCredentialRequest
  ) => Promise<RunnerBearerOwnerAuthorization>;
  authorizeDiagnostic: (request: Request) => RunnerSecretAuthorization;
  authorizeReconcile: (request: Request) => RunnerSecretAuthorization;
  authorizeSubscriber: () => Promise<RunnerSubscriberAuthorization>;
}>;

export type RunnerAuthDependencies = Readonly<{
  authenticate: () => Promise<SessionLike>;
  authenticateBearerOwner?: (
    request: Request,
    grant?: OwnerCredentialRequest
  ) => Promise<RunnerBearerOwnerAuthentication>;
  authorizeSubscriberAccess: (
    session: SessionLike
  ) => Promise<SubscriberAccessDecision>;
  environment?: RunnerSecretEnvironment;
}>;

export const MAX_PRIVILEGED_RUNNER_SECRET_LENGTH = 1024;

function configuredSecret(value: string | undefined): string | null {
  const secret = value?.trim();
  return secret && secret.length <= MAX_PRIVILEGED_RUNNER_SECRET_LENGTH
    ? secret
    : null;
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
 * An operator diagnostic credential must not be interchangeable with another
 * active privileged channel. Empty configuration is unavailable instead of
 * silently falling back to another authority.
 */
export function diagnosticSecretFromEnvironment(
  environment: RunnerSecretEnvironment = process.env
): string | null {
  const secret = configuredSecret(environment.OPERATOR_DIAGNOSTIC_TOKEN);
  if (!secret) {
    return null;
  }
  return isAliased(secret, [
    environment.CRON_SECRET,
    environment.RUNNER_MANUAL_RECONCILE_SECRET,
  ])
    ? null
    : secret;
}

/**
 * Cron has one credential. It is intentionally distinct from diagnostics and
 * manual recovery so neither can become an implicit fallback.
 */
export function cronReconcileSecretFromEnvironment(
  environment: RunnerSecretEnvironment = process.env
): string | null {
  const secret = configuredSecret(environment.CRON_SECRET);
  if (!secret) {
    return null;
  }
  return isAliased(secret, [
    environment.OPERATOR_DIAGNOSTIC_TOKEN,
    environment.RUNNER_MANUAL_RECONCILE_SECRET,
  ])
    ? null
    : secret;
}

/**
 * Manual reconciliation is a recovery channel, not a substitute for Vercel's
 * native cron credential or the diagnostic operator credential.
 */
export function manualReconcileSecretFromEnvironment(
  environment: RunnerSecretEnvironment = process.env
): string | null {
  const secret = configuredSecret(environment.RUNNER_MANUAL_RECONCILE_SECRET);
  if (!secret) {
    return null;
  }
  return isAliased(secret, [
    environment.CRON_SECRET,
    environment.OPERATOR_DIAGNOSTIC_TOKEN,
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

  /**
   * The same application-owned decision for both credentials: a subscriber
   * session type, a current account version, and a live entitlement. On the
   * bearer path the version is read from the same row it is compared with,
   * so that check always passes and cannot revoke a bearer token; only the
   * token's short expiry does (owner audience undecided, #297).
   */
  const authorizeSession = async (
    session: SessionLike
  ): Promise<RunnerSubscriberAuthorization> => {
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
  };

  return {
    authorizeBearerOwner: async (request, grant) => {
      if (!dependencies.authenticateBearerOwner) {
        return { kind: "unavailable" };
      }
      let owner: RunnerBearerOwnerAuthentication;
      try {
        owner = await dependencies.authenticateBearerOwner(request, grant);
      } catch {
        return { kind: "unavailable" };
      }
      if (owner.kind !== "authenticated") {
        return owner;
      }
      if (!owner.credentialId) {
        return { kind: "unauthorized" };
      }
      const decision = await authorizeSession(owner.session);
      if (decision.kind !== "allowed") {
        return decision;
      }
      return {
        ...decision,
        principal: {
          ...decision.principal,
          ownerCredentialId: owner.credentialId,
        },
      };
    },
    authorizeDiagnostic: (request) =>
      authorizeSecret(request, diagnosticSecretFromEnvironment(environment)),
    authorizeReconcile: (request) => {
      const expected =
        request.method === "GET"
          ? cronReconcileSecretFromEnvironment(environment)
          : request.method === "POST"
            ? manualReconcileSecretFromEnvironment(environment)
            : null;
      return authorizeSecret(request, expected);
    },
    authorizeSubscriber: async () => {
      let session: SessionLike;
      try {
        session = await dependencies.authenticate();
      } catch {
        return { kind: "unauthorized" };
      }
      return authorizeSession(session);
    },
  };
}
