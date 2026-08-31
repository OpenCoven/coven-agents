import { ipAddress } from "@vercel/functions";
import {
  abuseAdmissionResponse,
  enforceAbusePolicy,
} from "@/lib/abuse/enforce";
import type { AbuseStore } from "@/lib/abuse/store";
import type { AbuseRoute } from "@/lib/abuse/types";
import {
  type VerifiedJwtIdentity,
  verifiedJwtIdentity,
} from "@/lib/auth/verified-jwt";

type AuthAbuseRoute = Extract<
  AbuseRoute,
  "auth_callback" | "auth_session_update" | "auth_start"
>;

type AuthAbuseOptions = {
  basePath?: string;
  enforceAbuse?: typeof enforceAbusePolicy;
  readIdentity?: (request: Request) => Promise<VerifiedJwtIdentity | null>;
  store?: AbuseStore;
};

const AUTH_SIGNIN_PATH = /^\/api\/auth\/signin(?:\/[^/]+)?\/?$/;
const AUTH_CALLBACK_PATH = /^\/api\/auth\/callback\/[^/]+\/?$/;
const AUTH_SESSION_PATH = /^\/api\/auth\/session\/?$/;

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
  if (method === "POST" && AUTH_SESSION_PATH.test(normalizedPathname)) {
    return "auth_session_update";
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
      let identity: VerifiedJwtIdentity | null = null;
      if (route === "auth_session_update") {
        try {
          identity = await (options.readIdentity ?? verifiedJwtIdentity)(
            request
          );
        } catch {
          return abuseAdmissionResponse({
            kind: "unavailable",
            responseStatus: 503,
          });
        }
        if (!identity) {
          return handler(request, ...args);
        }
      }

      const admission = await (options.enforceAbuse ?? enforceAbusePolicy)({
        /**
         * Degrades on store failure like every other route, and this is the
         * second reversal of this exact decision in one night, so the record
         * matters: fail-closed here 503ed production sign-in the moment the
         * limiter's store hiccuped — reproduced with a bare curl. OAuth
         * replay safety lives in the state, PKCE, and CSRF machinery, which
         * none of this touches; the limiter is defense-in-depth on these
         * routes, and a defense-in-depth layer that takes sign-in down with
         * its own backing store has its priorities inverted. Degradation
         * keeps per-instance limits enforced throughout.
         */
        ip: ipAddress(request) ?? null,
        route,
        ...(options.store ? { store: options.store } : {}),
        ...(identity ? { userId: identity.userId } : {}),
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
