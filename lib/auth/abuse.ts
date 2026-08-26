import { ipAddress } from "@vercel/functions";
import {
  abuseAdmissionResponse,
  enforceAbusePolicy,
} from "@/lib/abuse/enforce";
import type { AbuseStore } from "@/lib/abuse/store";
import type { AbuseRoute } from "@/lib/abuse/types";

type AuthAbuseRoute = Extract<AbuseRoute, "auth_callback" | "auth_start">;

type AuthAbuseOptions = {
  store?: AbuseStore;
};

const AUTH_SIGNIN_PATH = /^\/api\/auth\/signin(?:\/[^/]+)?\/?$/;
const AUTH_CALLBACK_PATH = /^\/api\/auth\/callback\/[^/]+\/?$/;

export function authAbuseRoute(
  method: string,
  pathname: string
): AuthAbuseRoute | null {
  if (method === "POST" && AUTH_SIGNIN_PATH.test(pathname)) {
    return "auth_start";
  }
  if (
    (method === "GET" || method === "POST") &&
    AUTH_CALLBACK_PATH.test(pathname)
  ) {
    return "auth_callback";
  }
  return null;
}

export function withAuthAbusePolicy<
  RequestType extends Request,
  Arguments extends unknown[],
>(
  handler: (
    request: RequestType,
    ...args: Arguments
  ) => Promise<Response> | Response,
  options: AuthAbuseOptions = {}
): (request: RequestType, ...args: Arguments) => Promise<Response> {
  return async (request, ...args) => {
    const route = authAbuseRoute(request.method, new URL(request.url).pathname);
    if (route) {
      const admission = await enforceAbusePolicy({
        ip: ipAddress(request) ?? null,
        route,
        store: options.store,
      });
      if (admission.kind !== "allowed") {
        return abuseAdmissionResponse(admission);
      }
    }

    return handler(request, ...args);
  };
}
