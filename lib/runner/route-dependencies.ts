import "server-only";

import { ipAddress } from "@vercel/functions";
import { after } from "next/server";
import { enforceAbusePolicy } from "@/lib/abuse/enforce";
import type { SessionLike } from "@/lib/auth/subscriber-access";
import { createRunnerAuth } from "./auth";
import { createRunnerHttpHandlers, type RunnerHttpHandlers } from "./http";

function productionRuntime() {
  return import("./runtime");
}

function productionDiagnostics() {
  return import("./diagnostics");
}

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
 * Core runtime and diagnostics remain behind separate per-request imports.
 * Importing a route therefore resolves neither database nor Daytona
 * configuration until an authorized handler invokes the relevant dependency.
 */
export function productionRunnerHttpHandlers(): RunnerHttpHandlers {
  return createRunnerHttpHandlers({
    after,
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
      return diagnostics.diagnoseDaytonaSandbox(name);
    },
    enforceAbuse: enforceAbusePolicy,
    ipAddress: (request) => ipAddress(request) ?? null,
  });
}
