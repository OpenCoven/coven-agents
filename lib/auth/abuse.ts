import { ipAddress } from "@vercel/functions";
import {
  abuseAdmissionResponse,
  enforceAbusePolicy,
} from "@/lib/abuse/enforce";
import type { AbuseStore } from "@/lib/abuse/store";
import type { AbuseRoute } from "@/lib/abuse/types";

type AuthAbuseRoute = Extract<AbuseRoute, "auth_callback" | "auth_start">;

type AuthAbuseOptions = {
  basePath?: string;
  store?: AbuseStore;
};

const AUTH_SIGNIN_PATH = /^\/api\/auth\/signin(?:\/[^/]+)?\/?$/;
const AUTH_CALLBACK_PATH = /^\/api\/auth\/callback\/[^/]+\/?$/;

export function authAbuseRoute(
  method: string,
  pathname: string,
  basePath = ""
): AuthAbuseRoute | null {
  const normalizedPathname = stripBasePath(pathname, basePath);
  if (method === "POST" && AUTH_SIGNIN_PATH.test(normalizedPathname)) {
    return "auth_start";
  }
  if (
    (method === "GET" || method === "POST") &&
    AUTH_CALLBACK_PATH.test(normalizedPathname)
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
    const route = authAbuseRoute(
      request.method,
      new URL(request.url).pathname,
      options.basePath ?? process.env.NEXT_PUBLIC_BASE_PATH
    );
    if (route) {
      const admission = await enforceAbusePolicy({
        // Fail closed, deliberately: OAuth starts and callbacks carry replay
        // protection, and a limiter outage must not disable it. Sign-in
        // pages and support actions never reach this call at all.
        failClosed: true,
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

function stripBasePath(pathname: string, basePath: string | undefined): string {
  if (!basePath || basePath === "/") {
    return pathname;
  }
  const normalizedBasePath = basePath.endsWith("/")
    ? basePath.slice(0, -1)
    : basePath;
  return pathname.startsWith(`${normalizedBasePath}/`)
    ? pathname.slice(normalizedBasePath.length)
    : pathname;
}
