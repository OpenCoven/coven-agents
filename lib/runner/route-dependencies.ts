import "server-only";

import { ipAddress } from "@vercel/functions";
import { after } from "next/server";
import { auth } from "@/app/(auth)/auth";
import { enforceAbusePolicy } from "@/lib/abuse/enforce";
import { authorizeSubscriberAccess } from "@/lib/auth/subscriber-authorization.server";
import { createRunnerAuth } from "./auth";
import { createRunnerHttpHandlers, type RunnerHttpHandlers } from "./http";
import {
  createProductionRunnerOperatorService,
  createProductionRunnerService,
} from "./production";

/**
 * Constructed per request so importing a route remains side-effect free:
 * neither Daytona configuration nor a database operation is resolved until an
 * authenticated handler actually reaches its service method.
 */
export function productionRunnerHttpHandlers(): RunnerHttpHandlers {
  return createRunnerHttpHandlers({
    after,
    auth: createRunnerAuth({
      authenticate: auth,
      authorizeSubscriberAccess,
    }),
    createOperatorService: createProductionRunnerOperatorService,
    createService: (subscriber) =>
      createProductionRunnerService(subscriber.session),
    enforceAbuse: enforceAbusePolicy,
    ipAddress: (request) => ipAddress(request) ?? null,
  });
}
