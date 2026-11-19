import "server-only";

import { ipAddress } from "@vercel/functions";
import { after } from "next/server";
import { enforceAbusePolicy } from "@/lib/abuse/enforce";
import type { IdempotencyStore } from "@/lib/abuse/idempotency";
import { configuredApplicationOrigin } from "@/lib/auth/application-origin";
import type { SessionLike } from "@/lib/auth/subscriber-access";
import { createRunnerAuth } from "./auth";
import { createRunnerHttpHandlers, type RunnerHttpHandlers } from "./http";
import { authenticateBearerOwner } from "./owner-authentication";
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
      authenticateBearerOwner,
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
