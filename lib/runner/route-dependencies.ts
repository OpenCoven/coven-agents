import "server-only";

import { ipAddress } from "@vercel/functions";
import { after } from "next/server";
import { enforceAbusePolicy } from "@/lib/abuse/enforce";
import type { IdempotencyStore } from "@/lib/abuse/idempotency";
import { configuredApplicationOrigin } from "@/lib/auth/application-origin";
import type { SessionLike } from "@/lib/auth/subscriber-access";
import { createRunnerAuth } from "./auth";
import { createRunnerHttpHandlers, type RunnerHttpHandlers } from "./http";
import { createSandboxInspectionHandler } from "./sandbox-inspection-http";

function productionRuntime() {
  return import("./runtime");
}

function productionDiagnostics() {
  return import("./diagnostics");
}

async function databaseIdempotencyStore(): Promise<IdempotencyStore> {
  const queries = await import("@/lib/db/queries");
  return queries.databaseIdempotencyStore;
}

const lazyDatabaseIdempotencyStore: IdempotencyStore = {
  async claim(input) {
    return (await databaseIdempotencyStore()).claim(input);
  },
  async cleanupExpired(input) {
    return (await databaseIdempotencyStore()).cleanupExpired(input);
  },
  async complete(input) {
    return (await databaseIdempotencyStore()).complete(input);
  },
  async release(input) {
    return (await databaseIdempotencyStore()).release(input);
  },
};

async function authenticate() {
  const authentication = await import("@/app/(auth)/auth");
  return authentication.auth();
}

async function authorizeSubscriberAccess(session: SessionLike) {
  const authorization = await import(
    "@/lib/auth/subscriber-authorization.server"
  );
  return authorization.authorizeSubscriberAccess(session);
}

/**
 * WorkOS proves the caller's identity; the local account and its entitlement
 * still decide access (the account version cannot revoke a bearer token; see
 * authenticateWorkOSOwner). The modules are imported per request, not at
 * startup. The database module loads together with the WorkOS ones, but no
 * query runs until a token has been verified and its user fetched.
 */
async function authenticateBearerOwner(request: Request) {
  const [owner, token, queries] = await Promise.all([
    import("@/lib/auth/workos-owner"),
    import("@/lib/auth/workos-access-token"),
    import("@/lib/db/queries"),
  ]);
  return owner.authenticateWorkOSOwner(request, {
    configuration: () => token.readWorkOSTokenConfiguration(process.env),
    fetchUser: token.fetchVerifiedWorkOSUser,
    findAccountsByEmail: queries.getUser,
    verifier: workosVerifier(token),
  });
}

type WorkOSTokenModule = typeof import("@/lib/auth/workos-access-token");
let cachedVerifier:
  | Readonly<{
      clientId: string;
      verify: ReturnType<WorkOSTokenModule["createWorkOSAccessTokenVerifier"]>;
    }>
  | undefined;

/** One verifier per client ID so its remote key set is cached across requests. */
function workosVerifier(token: WorkOSTokenModule) {
  return (
    configuration: Parameters<
      WorkOSTokenModule["createWorkOSAccessTokenVerifier"]
    >[0]
  ) => {
    if (cachedVerifier?.clientId !== configuration.clientId) {
      cachedVerifier = {
        clientId: configuration.clientId,
        verify: token.createWorkOSAccessTokenVerifier(configuration),
      };
    }
    return cachedVerifier.verify;
  };
}

/**
 * Bearer-only owner route. It shares abuse control and the subscriber service
 * with the browser routes but never consults the session cookie.
 */
export function productionSandboxInspectionHandler(): (
  request: Request,
  agentId: string
) => Promise<Response> {
  return createSandboxInspectionHandler({
    auth: createRunnerAuth({
      authenticate,
      authenticateBearerOwner,
      authorizeSubscriberAccess,
    }),
    createService: async (subscriber) => {
      const runtime = await productionRuntime();
      return runtime.createProductionRunnerService(subscriber.session);
    },
    enforceAbuse: enforceAbusePolicy,
    ipAddress: (request) => ipAddress(request) ?? null,
  });
}

/**
 * Core runtime and diagnostics remain behind separate per-request imports.
 * Importing a route therefore resolves neither database nor Daytona
 * configuration until an authorized handler invokes the relevant dependency.
 */
export function productionRunnerHttpHandlers(): RunnerHttpHandlers {
  return createRunnerHttpHandlers({
    after,
    appOrigin: () => configuredApplicationOrigin(process.env),
    auth: createRunnerAuth({
      authenticate,
      authorizeSubscriberAccess,
    }),
    createOperatorService: async () => {
      const runtime = await productionRuntime();
      return runtime.createProductionRunnerOperatorService();
    },
    createService: async (subscriber) => {
      const runtime = await productionRuntime();
      return runtime.createProductionRunnerService(subscriber.session);
    },
    diagnoseSandbox: async (name) => {
      const diagnostics = await productionDiagnostics();
      return diagnostics.diagnoseDaytonaSandbox(name, {
        reportFailure: (failure) => {
          console.error("Daytona diagnostic failed.", failure);
        },
      });
    },
    enforceAbuse: enforceAbusePolicy,
    idempotencyStore: lazyDatabaseIdempotencyStore,
    ipAddress: (request) => ipAddress(request) ?? null,
  });
}
